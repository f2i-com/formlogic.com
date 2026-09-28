<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AokieReceptionistUpgradeService;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FlowService;
use FormLogic\Services\FormService;
use FormLogic\Services\FormVersionService;
use FormLogic\Services\PackService;
use FormLogic\Services\ResponseService;
use PDO;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The in-place upgrade, tested the way it is used: install an OLD release of the
 * Aokie Receptionist (the signed marketplace records of 1.0.1 and 1.1.0, kept as
 * fixtures), upgrade it with the bundled pack, and compare the app with a fresh
 * install of the bundled pack - forms, fields, screens and their trust, app logic,
 * settings, roles, reports, flows and bindings. Records and everything an owner
 * added or switched must survive, and a second run must change nothing.
 */
final class AokieReceptionistUpgradeTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static FormService $forms;
    private static AppService $apps;
    private static AppUserService $appUsers;
    private static PackService $packs;
    private static FlowService $flows;
    private static FormVersionService $versions;
    private static ResponseService $responses;
    private static AokieReceptionistUpgradeService $upgrade;

    /** @var string[] */
    private array $userIds = [];

    public static function setUpBeforeClass(): void
    {
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) {
            \Dotenv\Dotenv::createImmutable($root)->safeLoad();
        }
        $config = [
            'host' => $_ENV['DB_HOST'] ?? '127.0.0.1',
            'port' => $_ENV['DB_PORT'] ?? '3306',
            'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
            'username' => $_ENV['DB_USERNAME'] ?? 'root',
            'password' => $_ENV['DB_PASSWORD'] ?? '',
            'charset' => 'utf8mb4',
            'collation' => 'utf8mb4_unicode_ci',
        ];
        try {
            $mysql = new MySQLConnection($config);
            $mysql->getConnection()->query('SELECT 1');
            $mysql->initializeSchema();
            $mysql->runMigrations();
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
        self::$mysql = $mysql;
        self::$pdo = $mysql->getConnection();
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/formlogic-aokie-upgrade-' . bin2hex(random_bytes(4)));
        self::$forms = new FormService($mysql, $sqlite);
        self::$apps = new AppService($mysql, self::$forms);
        self::$appUsers = new AppUserService($mysql);
        self::$packs = new PackService($mysql, self::$forms, self::$apps, self::$appUsers);
        self::$flows = new FlowService($mysql);
        self::$versions = new FormVersionService($mysql, self::$forms);
        self::$responses = new ResponseService($mysql, $sqlite);
        self::$upgrade = new AokieReceptionistUpgradeService(
            $mysql,
            self::$forms,
            self::$versions,
            self::$flows,
            self::$packs,
            self::$apps,
            self::$appUsers
        );
    }

    protected function setUp(): void
    {
        if (self::$pdo === null) {
            $this->markTestSkipped('No test database');
        }
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        foreach ($this->userIds as $userId) {
            $appIds = self::$pdo->prepare('SELECT id FROM apps WHERE owner_id = ?');
            $appIds->execute([$userId]);
            foreach ($appIds->fetchAll(PDO::FETCH_COLUMN) as $appId) {
                self::$pdo->prepare('DELETE FROM app_flow_bindings WHERE app_id = ?')->execute([$appId]);
                self::$pdo->prepare('DELETE FROM flow_definitions WHERE app_id = ?')->execute([$appId]);
                self::$pdo->prepare('DELETE FROM app_forms WHERE app_id = ?')->execute([$appId]);
                self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$appId]);
                self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?)')
                    ->execute([$appId]);
                self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$appId]);
            }
            self::$pdo->prepare('DELETE FROM pack_installations WHERE user_id = ?')->execute([$userId]);
            self::$pdo->prepare('DELETE FROM apps WHERE owner_id = ?')->execute([$userId]);
            self::$pdo->prepare('DELETE FROM forms WHERE user_id = ?')->execute([$userId]);
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$userId]);
        }
        $this->userIds = [];
    }

    /** @return array<string,array{0:string}> */
    public static function oldReleases(): array
    {
        return ['1.0.1' => ['1.0.1'], '1.1.0' => ['1.1.0']];
    }

    #[DataProvider('oldReleases')]
    public function testAnOldReleaseUpgradesToWhatAFreshInstallHas(string $oldVersion): void
    {
        $record = $this->bundledRecord();
        $owner = $this->newUser();
        $appId = $this->install($this->oldRecord($oldVersion)['pack'], $owner);
        $formMap = $this->formMap($appId);

        // Operator data the upgrade must not touch.
        $settingsRow = self::$responses->createResponse($formMap['receptionist-settings'], [
            'answers' => ['business_name' => 'RETAIN-ME', 'active' => 'yes', 'greeting' => 'Hello from the owner'],
        ]);
        $messageRow = self::$responses->createResponse($formMap['sms-messages'], [
            'answers' => ['phone' => '+61400000000', 'direction' => 'outbound', 'body' => 'Kept', 'status' => 'queued', 'message_id' => 'sms-kept'],
        ]);
        $before = $this->comparable($appId, $owner);
        $this->assertNotEquals($this->comparable($this->install($record['pack'], $this->newUser()), end($this->userIds)), $before);

        $dryRun = self::$upgrade->run($appId, $record, false);
        $this->assertSame('dry-run', $dryRun['mode']);
        $this->assertSame($oldVersion, $dryRun['installedVersion']);
        $this->assertSame('1.2.0', $dryRun['packVersion']);
        $this->assertFalse($dryRun['applied']);
        $this->assertTrue($dryRun['changes']['installationVersion']);
        $this->assertContains('sms-ack-sweep', $dryRun['changes']['flows']['created']);
        $this->assertContains('delivery_note', $dryRun['changes']['forms']['sms-messages']['fieldsAdded']);
        $this->assertContains('status', $dryRun['changes']['forms']['sms-messages']['fieldsUpdated']);
        $this->assertSame([], $dryRun['skipped']);
        $this->assertSame($before, $this->comparable($appId, $owner), 'a dry run writes nothing');

        $applied = self::$upgrade->run($appId, $record, true);
        $this->assertTrue($applied['applied']);
        $this->assertSame([], $applied['skipped']);
        $this->assertNotEmpty($applied['snapshots']);

        // A fresh install of the bundled pack, by someone else.
        $freshOwner = $this->newUser();
        $freshAppId = $this->install($record['pack'], $freshOwner);
        $this->assertSame($this->comparable($freshAppId, $freshOwner), $this->comparable($appId, $owner));

        // Every screen carries the trust a fresh install gives it.
        foreach ($this->formMap($appId) as $packFormId => $formId) {
            $screen = self::$forms->getForm($formId)['customScreen'] ?? [];
            if ($screen !== []) {
                $this->assertSame('verified', $screen['_trust'], "{$packFormId} screen trust");
                $this->assertSame('vendor-signed', $screen['_provenance']['source'] ?? null, "{$packFormId} provenance");
            }
        }

        // Records are where they were.
        $this->assertSame('RETAIN-ME', self::$responses->getResponse($formMap['receptionist-settings'], $settingsRow['id'])['answers']['business_name']);
        $this->assertSame('Hello from the owner', self::$responses->getResponse($formMap['receptionist-settings'], $settingsRow['id'])['answers']['greeting']);
        $this->assertSame('queued', self::$responses->getResponse($formMap['sms-messages'], $messageRow['id'])['answers']['status']);

        // One installation, now at the bundled version.
        $installations = self::$pdo->prepare('SELECT pack_version FROM pack_installations WHERE user_id = ? AND pack_id = ?');
        $installations->execute([$owner, AokieReceptionistUpgradeService::PACK_ID]);
        $this->assertSame(['1.2.0'], $installations->fetchAll(PDO::FETCH_COLUMN));

        // The previous definition of each changed form is kept as a version.
        $snapshot = self::$versions->getVersion($formMap['sms-messages'], $applied['snapshots']['sms-messages']['version']);
        $this->assertNotContains('delivery_note', array_column($snapshot['data']['fields'], 'id'));

        // A second run finds nothing to do.
        $again = self::$upgrade->run($appId, $record, true);
        $this->assertFalse($again['applied']);
        $this->assertSame([], $again['changes']['forms']);
        $this->assertSame(['created' => [], 'updated' => []], $again['changes']['flows']);
        $this->assertSame(['created' => [], 'updated' => []], $again['changes']['bindings']);
        $this->assertSame([], $again['changes']['roles']);
        $this->assertFalse($again['changes']['appLogic']['changed']);
        $this->assertSame([], $again['snapshots']);
    }

    public function testKeepsWhatTheOwnerAddedOrSwitched(): void
    {
        $record = $this->bundledRecord();
        $owner = $this->newUser();
        $appId = $this->install($this->oldRecord('1.1.0')['pack'], $owner);
        $formMap = $this->formMap($appId);

        // An owner field in the middle of Customers, and an owner choice on Messages status.
        $customers = self::$forms->getForm($formMap['customers']);
        array_splice($customers['fields'], 2, 0, [[
            'id' => 'loyalty_tier', 'type' => 'short_text', 'label' => 'Loyalty tier', 'required' => false, 'properties' => [],
        ]]);
        self::$forms->updateForm($formMap['customers'], ['fields' => $customers['fields']]);
        $messages = self::$forms->getForm($formMap['sms-messages']);
        foreach ($messages['fields'] as &$field) {
            if ($field['id'] === 'status') {
                $field['properties']['options'][] = ['id' => 'on_hold', 'label' => 'On hold', 'value' => 'on_hold'];
            }
        }
        unset($field);
        self::$forms->updateForm($formMap['sms-messages'], ['fields' => $messages['fields']]);
        $onHold = self::$responses->createResponse($formMap['sms-messages'], [
            'answers' => ['phone' => '+61400000001', 'direction' => 'outbound', 'body' => 'Wait', 'status' => 'on_hold'],
        ]);

        // An owner script and grant in the app logic.
        $app = self::$apps->getApp($appId);
        $logic = $app['customLogic'];
        $logic['scripts'][] = ['id' => 'owner-script', 'hook' => 'onAppStart', 'runtime' => 'quickjs', 'source' => 'function run(ctx) { return {}; }'];
        $logic['permissions'][] = 'ui.navigate';
        self::$apps->updateApp($appId, ['customLogic' => $logic]);

        // Switched off by the operator: a flow and a binding.
        self::$pdo->prepare('UPDATE flow_definitions SET enabled = 0 WHERE app_id = ? AND slug = ?')->execute([$appId, 'callback-drain']);
        self::$pdo->prepare(
            'UPDATE app_flow_bindings b JOIN flow_definitions f ON f.id = b.flow_definition_id
                SET b.enabled = 0 WHERE b.app_id = ? AND f.slug = ? AND b.event_name = ?'
        )->execute([$appId, 'sms-approved-drain', 'aokie.sms.received']);

        // An extra grant on Viewer; Device Admin without the dongle reset (as before it existed).
        $roles = [];
        foreach (self::$appUsers->getRoles($appId) as $role) {
            $roles[$role['name']] = $role;
        }
        self::$pdo->prepare('INSERT INTO app_role_permissions (id, role_id, form_id, permission) VALUES (?, ?, NULL, ?)')
            ->execute([$this->uuid(), $roles['Viewer']['id'], 'connector.aokie.phone.status']);
        self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id = ? AND permission = ?')
            ->execute([$roles['Device Admin']['id'], 'connector.aokie.dongle.reset']);

        $applied = self::$upgrade->run($appId, $record, true);
        $this->assertTrue($applied['applied']);
        $this->assertSame(['connector.aokie.dongle.reset'], $applied['changes']['roles']['Device Admin']['permissionsAdded']);

        $ids = array_column(self::$forms->getForm($formMap['customers'])['fields'], 'id');
        $this->assertSame('loyalty_tier', $ids[2], 'the owner field keeps its place');
        $status = null;
        foreach (self::$forms->getForm($formMap['sms-messages'])['fields'] as $field) {
            if ($field['id'] === 'status') {
                $status = array_column($field['properties']['options'], 'value');
            }
        }
        $this->assertSame(['received', 'draft', 'queued', 'sent', 'failed', 'unconfirmed', 'on_hold'], $status);
        $this->assertSame('on_hold', self::$responses->getResponse($formMap['sms-messages'], $onHold['id'])['answers']['status']);

        $logic = self::$apps->getApp($appId)['customLogic'];
        $this->assertContains('owner-script', array_column($logic['scripts'], 'id'));
        $this->assertContains('ui.navigate', $logic['permissions']);
        $this->assertContains('connector.aokie.dongle.reset', $logic['permissions']);
        $this->assertStringContainsString('realtime_failed', json_encode(array_column($logic['scripts'], 'source')));

        $drain = $this->flowRow($appId, 'callback-drain');
        $this->assertSame(0, (int) $drain['enabled'], 'a switched-off flow stays off');
        $binding = $this->bindingRow($appId, 'sms-approved-drain', 'aokie.sms.received');
        $this->assertSame(0, (int) $binding['enabled'], 'a switched-off binding stays off');
        $this->assertStringContainsString('timestamp', (string) $this->flowRow($appId, 'sms-approved-drain')['flow_json']);

        $viewer = array_column(self::$appUsers->getRolePermissions($roles['Viewer']['id']), 'permission');
        $this->assertContains('connector.aokie.phone.status', $viewer);
        $deviceAdmin = array_column(self::$appUsers->getRolePermissions($roles['Device Admin']['id']), 'permission');
        $this->assertContains('connector.aokie.dongle.reset', $deviceAdmin);

        $this->assertFalse(self::$upgrade->run($appId, $record, true)['applied']);
    }

    public function testSkipsWhatItCannotSafelyTouchAndUpgradesTheRest(): void
    {
        $record = $this->bundledRecord();
        $owner = $this->newUser();
        $appId = $this->install($this->oldRecord('1.1.0')['pack'], $owner);
        $formMap = $this->formMap($appId);

        // The owner replaced the Receptionist Settings screen with their own.
        self::$forms->updateForm($formMap['receptionist-settings'], [
            'customScreen' => ['enabled' => true, 'kind' => 'code', 'html' => '<p>Owner</p>', 'css' => '', 'js' => ''],
        ]);
        // ... and wrote their own flow under the slug the acknowledgement sweep uses.
        self::$flows->createFlow($appId, $owner, [
            'name' => 'Owner sweep',
            'slug' => 'sms-ack-sweep',
            'flowJson' => ['nodes' => [['id' => 'owner', 'type' => 'logic_block', 'data' => ['expr' => '({})']]], 'edges' => []],
        ]);
        // ... and the Orders form is no longer part of the app.
        self::$pdo->prepare('DELETE FROM app_forms WHERE app_id = ? AND form_id = ?')->execute([$appId, $formMap['orders']]);

        $applied = self::$upgrade->run($appId, $record, true);
        $this->assertTrue($applied['applied']);
        $skipped = array_column($applied['skipped'], 'reason', 'item');
        $this->assertArrayHasKey('form:receptionist-settings screen', $skipped);
        $this->assertArrayHasKey('flow sms-ack-sweep', $skipped);
        $this->assertArrayHasKey('form:orders', $skipped);
        $this->assertArrayHasKey('binding after-call-actions on aokie.call.transcript.settled', $skipped);

        // Left exactly as the owner had them.
        $this->assertSame('<p>Owner</p>', self::$forms->getForm($formMap['receptionist-settings'])['customScreen']['html']);
        $this->assertSame('Owner sweep', $this->flowRow($appId, 'sms-ack-sweep')['name']);
        $count = self::$pdo->prepare(
            'SELECT COUNT(*) FROM app_flow_bindings b JOIN flow_definitions f ON f.id = b.flow_definition_id WHERE b.app_id = ? AND f.slug = ?'
        );
        $count->execute([$appId, 'sms-ack-sweep']);
        $this->assertSame(0, (int) $count->fetchColumn(), 'no pack binding is attached to an owner flow');

        // Everything else moved on: the settings form still gained its fields' updates,
        // Messages its status, the delivery flow its idempotent toast.
        $this->assertContains('delivery_note', array_column(self::$forms->getForm($formMap['sms-messages'])['fields'], 'id'));
        $this->assertStringContainsString('notify', (string) $this->bindingRow($appId, 'sms-delivery-status', 'aokie.sms.failed')['output_actions_json']);

        // Idempotent with the skips in place too.
        $again = self::$upgrade->run($appId, $record, true);
        $this->assertFalse($again['applied']);
        $this->assertSame(array_column($applied['skipped'], 'item'), array_column($again['skipped'], 'item'));
    }

    public function testRefusesOnlyWhatItCannotIdentify(): void
    {
        $record = $this->bundledRecord();
        $owner = $this->newUser();
        $appId = $this->install($this->oldRecord('1.1.0')['pack'], $owner);
        $formMap = $this->formMap($appId);

        $this->expectRefusal(fn () => self::$upgrade->run('not-a-uuid', $record, false), 'canonical app UUID');
        $wrong = $record;
        $wrong['id'] = 'something-else';
        $this->expectRefusal(fn () => self::$upgrade->run($appId, $wrong, false), 'not the Aokie Receptionist pack');
        $unsigned = $record;
        unset($unsigned['pack']['signing']);
        $this->expectRefusal(fn () => self::$upgrade->run($appId, $unsigned, false), 'signature');

        // A second form claiming the settings alias: which one is the pack's?
        $extra = self::$forms->createForm(['id' => $this->uuid(), 'userId' => $owner, 'title' => 'Ambiguous settings', 'fields' => []]);
        self::$apps->addFormToApp($appId, $extra['id']);
        self::$apps->updateAppForm($appId, $extra['id'], ['settings' => ['packFormId' => AokieReceptionistUpgradeService::SETTINGS_FORM_ID]]);
        $installation = $this->installationRow($owner);
        $formIds = json_decode($installation['form_ids'], true);
        $formIds[] = $extra['id'];
        self::$pdo->prepare('UPDATE pack_installations SET form_ids = ? WHERE id = ?')->execute([json_encode($formIds), $installation['id']]);
        $this->expectRefusal(fn () => self::$upgrade->run($appId, $record, false), 'ambiguous');
        self::$apps->removeFormFromApp($appId, $extra['id']);

        // An explicit legacy-screen assertion that does not hold is refused.
        self::$forms->updateForm($formMap['receptionist-settings'], [
            'customScreen' => ['enabled' => true, 'kind' => 'code', 'html' => '<p>Owner</p>', 'css' => '', 'js' => ''],
        ]);
        $ownerScreen = self::$forms->getForm($formMap['receptionist-settings'])['customScreen'];
        $this->expectRefusal(
            fn () => self::$upgrade->run($appId, $record, false, $this->screenDigest($ownerScreen)),
            'not a known legacy'
        );
        $this->expectRefusal(
            fn () => self::$upgrade->run($appId, $record, false, strtoupper('a41e8600774bf22277d42299a604da5e5e08ccfa6c1dec5ada732eacc4898af7')),
            'not the accepted known legacy'
        );
    }

    /**
     * An install retrofitted by hand carries the 1.0.x code screens at trust 'owner'
     * with an empty provenance: not provably the pack's, so they are skipped - until
     * the operator accepts the known legacy fingerprint, when each is replaced if it
     * is byte-for-byte that release's screen for its own component.
     */
    public function testAcceptedLegacyScreensOfAHandRetrofittedInstallAreReplaced(): void
    {
        $record = $this->bundledRecord();
        $owner = $this->newUser();
        $appId = $this->install($this->oldRecord('1.0.1')['pack'], $owner);
        $formMap = $this->formMap($appId);
        $codeScreens = ['calls', 'hardware-events', 'receptionist-settings'];
        foreach ($codeScreens as $packFormId) {
            self::$pdo->prepare("UPDATE forms SET custom_screen_trust = 'owner', custom_screen_provenance = '{}' WHERE id = ?")
                ->execute([$formMap[$packFormId]]);
        }

        $without = self::$upgrade->run($appId, $record, true);
        $skipped = array_column($without['skipped'], 'item');
        foreach ($codeScreens as $packFormId) {
            $this->assertContains("form:{$packFormId} screen", $skipped);
            $this->assertSame('owner', self::$forms->getForm($formMap[$packFormId])['customScreen']['_trust']);
        }
        $this->assertFalse($without['legacyScreenAccepted']);

        $known = 'a41e8600774bf22277d42299a604da5e5e08ccfa6c1dec5ada732eacc4898af7';
        $with = self::$upgrade->run($appId, $record, true, $known);
        $this->assertTrue($with['legacyScreenAccepted']);
        $this->assertSame([], $with['skipped']);
        foreach ($codeScreens as $packFormId) {
            $this->assertTrue($with['changes']['forms'][$packFormId]['screen'], $packFormId);
            $screen = self::$forms->getForm($formMap[$packFormId])['customScreen'];
            $this->assertSame('verified', $screen['_trust'], $packFormId);
            $this->assertSame("form:{$packFormId}", $screen['_provenance']['component'] ?? null);
        }

        // Re-running the same command line is harmless once they are the pack's.
        $again = self::$upgrade->run($appId, $record, true, $known);
        $this->assertFalse($again['applied']);
        $this->assertFalse($again['legacyScreenAccepted']);
    }

    public function testKnownLegacyScreenAcceptancePolicyIsPinnedAndExact(): void
    {
        $known = 'a41e8600774bf22277d42299a604da5e5e08ccfa6c1dec5ada732eacc4898af7';
        $method = new \ReflectionMethod(AokieReceptionistUpgradeService::class, 'acceptsKnownLegacyScreen');

        $this->assertTrue($method->invoke(self::$upgrade, $known, $known, 'owner', [], true));
        $this->assertFalse($method->invoke(self::$upgrade, $known, 'b' . substr($known, 1), 'owner', [], true));
        $this->assertFalse($method->invoke(self::$upgrade, $known, $known, 'verified', [], true));
        $this->assertFalse($method->invoke(self::$upgrade, $known, $known, 'owner', ['source' => 'owner'], true));
        $this->assertFalse($method->invoke(self::$upgrade, $known, $known, 'owner', [], false));
        $this->assertFalse($method->invoke(self::$upgrade, str_repeat('0', 64), str_repeat('0', 64), 'owner', [], true));
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    private function newUser(): string
    {
        $userId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$userId, $userId . '@test.local']);
        $this->userIds[] = $userId;
        return $userId;
    }

    private function install(array $pack, string $owner): string
    {
        $import = self::$packs->importPack($pack, $owner);
        return (string) $import['apps'][0]['id'];
    }

    /** @return array<string,mixed> */
    private function bundledRecord(): array
    {
        $file = dirname(__DIR__, 2) . '/resources/marketplace-packs/aokie-receptionist.json';
        $record = json_decode((string) file_get_contents($file), true);
        $this->assertIsArray($record);
        return $record;
    }

    /** @return array<string,mixed> the signed marketplace record of an earlier release */
    private function oldRecord(string $version): array
    {
        $file = dirname(__DIR__) . "/fixtures/aokie-receptionist/aokie-receptionist-{$version}.json.gz";
        $record = json_decode((string) gzdecode((string) file_get_contents($file)), true);
        $this->assertIsArray($record);
        $this->assertSame($version, $record['pack']['packMeta']['version']);
        return $record;
    }

    /**
     * Everything the pack owns in an installed app, as its export gives it, with the
     * install-specific ids taken out: forms keyed by alias, roles by name, flows by
     * slug, bindings by flow and event, report ids replaced by report names, and
     * every map key-sorted.
     *
     * @return array<string,mixed>
     */
    private function comparable(string $appId, string $owner): array
    {
        $export = json_decode((string) json_encode(self::$packs->exportApp($appId, $owner)), true);
        $forms = [];
        foreach ($export['forms'] as $form) {
            $forms[$form['packFormId']] = $form;
        }
        $app = $export['apps'][0];
        $app['reports'] ??= [];
        $names = [];
        foreach ($app['reports'] as $report) {
            $names[$report['reportId']] = $report['name'];
        }
        foreach ($app['reports'] as &$report) {
            $report['reportId'] = $report['name'];
            $report['blocks'] ??= [];
            foreach ($report['blocks'] as &$block) {
                if (isset($block['reportId'])) {
                    $block['reportId'] = $names[$block['reportId']] ?? '?';
                }
            }
            unset($block);
        }
        unset($report);
        $roles = [];
        foreach ($app['roles'] as $role) {
            $permissions = array_map(
                static fn (array $p): string => ($p['packFormId'] ?? '') . '|' . $p['permission'],
                $role['permissions']
            );
            sort($permissions);
            $role['permissions'] = $permissions;
            $roles[$role['name']] = $role;
        }
        $app['roles'] = $roles;
        $flows = [];
        foreach ($export['flows'] ?? [] as $flow) {
            $flows[$flow['slug']] = $flow;
        }
        $bindings = [];
        foreach ($export['flowBindings'] ?? [] as $binding) {
            $key = $binding['flow'] . '|' . $binding['event'];
            $this->assertArrayNotHasKey($key, $bindings, "one binding per flow and event ({$key})");
            $bindings[$key] = $binding;
        }
        return $this->canonical([
            'packMeta' => $export['packMeta'],
            'forms' => $forms,
            'app' => $app,
            'flows' => $flows,
            'bindings' => $bindings,
        ]);
    }

    private function canonical(mixed $value): mixed
    {
        if (!is_array($value)) {
            return $value;
        }
        if (!array_is_list($value)) {
            ksort($value, SORT_STRING);
        }
        foreach ($value as $key => $item) {
            $value[$key] = $this->canonical($item);
        }
        return $value;
    }

    private function expectRefusal(callable $run, string $message): void
    {
        try {
            $run();
            $this->fail("Expected a refusal mentioning '{$message}'");
        } catch (\RuntimeException | \InvalidArgumentException $e) {
            $this->assertStringContainsString(strtolower($message), strtolower($e->getMessage()));
        }
    }

    /** @return array<string,string> */
    private function formMap(string $appId): array
    {
        $stmt = self::$pdo->prepare('SELECT form_id, settings FROM app_forms WHERE app_id = ?');
        $stmt->execute([$appId]);
        $map = [];
        foreach ($stmt->fetchAll() as $row) {
            $settings = json_decode((string) $row['settings'], true);
            if (is_string($settings['packFormId'] ?? null)) {
                $map[$settings['packFormId']] = (string) $row['form_id'];
            }
        }
        return $map;
    }

    /** @return array<string,mixed> */
    private function flowRow(string $appId, string $slug): array
    {
        $stmt = self::$pdo->prepare('SELECT * FROM flow_definitions WHERE app_id = ? AND slug = ?');
        $stmt->execute([$appId, $slug]);
        return $stmt->fetch() ?: throw new \RuntimeException('Flow missing in test');
    }

    /** @return array<string,mixed> */
    private function bindingRow(string $appId, string $slug, string $event): array
    {
        $stmt = self::$pdo->prepare(
            'SELECT b.* FROM app_flow_bindings b
              JOIN flow_definitions f ON f.id = b.flow_definition_id
             WHERE b.app_id = ? AND f.slug = ? AND b.event_name = ?'
        );
        $stmt->execute([$appId, $slug, $event]);
        return $stmt->fetch() ?: throw new \RuntimeException('Binding missing in test');
    }

    /** @return array<string,mixed> */
    private function installationRow(string $owner): array
    {
        $stmt = self::$pdo->prepare('SELECT * FROM pack_installations WHERE user_id = ? AND pack_id = ?');
        $stmt->execute([$owner, AokieReceptionistUpgradeService::PACK_ID]);
        return $stmt->fetch() ?: throw new \RuntimeException('Installation missing in test');
    }

    /** @param array<string,mixed> $screen */
    private function screenDigest(array $screen): string
    {
        unset($screen['_trust'], $screen['_provenance']);
        return hash('sha256', json_encode(
            $this->canonical($screen),
            JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR
        ));
    }

    private function uuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}

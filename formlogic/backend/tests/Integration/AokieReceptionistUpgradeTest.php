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
use PHPUnit\Framework\TestCase;

final class AokieReceptionistUpgradeTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static FormService $forms;
    private static AppService $apps;
    private static PackService $packs;
    private static FlowService $flows;
    private static FormVersionService $versions;
    private static ResponseService $responses;
    private static AokieReceptionistUpgradeService $upgrade;

    private string $userId = '';

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
        self::$packs = new PackService($mysql, self::$forms, self::$apps, new AppUserService($mysql));
        self::$flows = new FlowService($mysql);
        self::$versions = new FormVersionService($mysql, self::$forms);
        self::$responses = new ResponseService($mysql, $sqlite);
        self::$upgrade = new AokieReceptionistUpgradeService(
            $mysql,
            self::$forms,
            self::$versions,
            self::$flows,
            self::$packs
        );
    }

    protected function setUp(): void
    {
        if (self::$pdo === null) {
            $this->markTestSkipped('No test database');
        }
        $this->userId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$this->userId, $this->userId . '@test.local']);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null || $this->userId === '') {
            return;
        }
        $appIds = self::$pdo->prepare('SELECT id FROM apps WHERE owner_id = ?');
        $appIds->execute([$this->userId]);
        foreach ($appIds->fetchAll(PDO::FETCH_COLUMN) as $appId) {
            self::$pdo->prepare('DELETE FROM app_flow_bindings WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM flow_definitions WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_forms WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?)')
                ->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$appId]);
        }
        self::$pdo->prepare('DELETE FROM pack_installations WHERE user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM apps WHERE owner_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM forms WHERE user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
    }

    public function testDryRunApplyAndSecondRunAreSafeAndIdempotent(): void
    {
        $record = $this->aokieRecord();
        $pack = $record['pack'];
        $import = self::$packs->importPack($pack, $this->userId);
        $appId = (string) $import['apps'][0]['id'];
        $formMap = $this->formMap($appId);
        $settingsId = $formMap[AokieReceptionistUpgradeService::SETTINGS_FORM_ID];
        $desiredSettings = $this->packForm($pack, AokieReceptionistUpgradeService::SETTINGS_FORM_ID);

        // Model an installation from before the deterministic Realtime
        // appointment slice: neither request_id field nor the additive
        // appointment flow/binding existed yet.
        foreach (['appointments', 'follow-up-tasks'] as $packFormId) {
            $form = self::$forms->getForm($formMap[$packFormId]);
            self::$forms->updateForm($formMap[$packFormId], [
                'fields' => array_values(array_filter(
                    $form['fields'],
                    static fn (array $field): bool => ($field['id'] ?? null) !== 'request_id'
                )),
            ]);
        }
        self::$pdo->prepare(
            'DELETE b FROM app_flow_bindings b
              JOIN flow_definitions f ON f.id = b.flow_definition_id
             WHERE b.app_id = ? AND f.slug = ?'
        )->execute([$appId, 'appointment-request-apply']);
        self::$pdo->prepare('DELETE FROM flow_definitions WHERE app_id = ? AND slug = ?')
            ->execute([$appId, 'appointment-request-apply']);

        $settings = self::$forms->getForm($settingsId);
        $legacyFields = array_values(array_filter(
            $settings['fields'],
            static fn (array $field): bool => !in_array(
                $field['id'] ?? null,
                ['background_ai_source', 'background_ai_model'],
                true
            )
        ));
        self::$forms->updateForm($settingsId, ['fields' => $legacyFields]);

        // Simulate a previous signed pack screen while retaining the original
        // pack provenance. Direct SQL avoids marking it owner-authored, which
        // the production migration correctly refuses to overwrite.
        $legacyScreen = $desiredSettings['customScreen'];
        $legacyScreen['html'] = (string) ($legacyScreen['html'] ?? '') . '<!-- legacy -->';
        self::$pdo->prepare('UPDATE forms SET custom_screen = ? WHERE id = ?')
            ->execute([json_encode($legacyScreen), $settingsId]);

        $response = self::$responses->createResponse($settingsId, [
            'answers' => ['business_name' => 'RETAIN-ME', 'active' => 'yes'],
        ]);

        $flowEnabled = [];
        $flowVersions = [];
        $legacyGraph = json_encode([
            'nodes' => [['id' => 'legacy', 'type' => 'logic_block', 'data' => ['expr' => 'return {};']]],
            'edges' => [],
        ]);
        $legacyFlowSlugs = array_values(array_filter(
            AokieReceptionistUpgradeService::FLOW_SLUGS,
            static fn (string $slug): bool => $slug !== 'appointment-request-apply'
        ));
        foreach ($legacyFlowSlugs as $index => $slug) {
            $enabled = $index % 2;
            self::$pdo->prepare(
                'UPDATE flow_definitions
                    SET name = ?, description = ?, flow_json = ?, enabled = ?
                  WHERE app_id = ? AND slug = ?'
            )->execute(['Legacy ' . $slug, 'legacy', $legacyGraph, $enabled, $appId, $slug]);
            $flow = $this->flowRow($appId, $slug);
            $flowEnabled[$slug] = (int) $flow['enabled'];
            $flowVersions[$slug] = (int) $flow['version'];
        }

        $bindingEnabled = [];
        foreach (['call-summary-follow-up', 'after-call-actions'] as $index => $slug) {
            $enabled = $index % 2;
            self::$pdo->prepare(
                'UPDATE app_flow_bindings b
                  JOIN flow_definitions f ON f.id = b.flow_definition_id
                    SET b.event_name = ?, b.enabled = ?
                  WHERE b.app_id = ? AND f.slug = ? AND b.connector_id = ?'
            )->execute(['aokie.call.ended', $enabled, $appId, $slug, 'aokie']);
            $bindingEnabled[$slug] = $enabled;
        }

        $installationsBefore = $this->installationCount();
        $versionsBefore = count(self::$versions->getVersions($settingsId));
        $recordVersionsBefore = [
            'appointments' => count(self::$versions->getVersions($formMap['appointments'])),
            'follow-up-tasks' => count(self::$versions->getVersions($formMap['follow-up-tasks'])),
        ];
        $dryRun = self::$upgrade->run($appId, $record, false);
        $this->assertSame('dry-run', $dryRun['mode']);
        $this->assertFalse($dryRun['legacyScreenAccepted']);
        $this->assertSame(['background_ai_source', 'background_ai_model'], $dryRun['changes']['settingsFields']);
        $this->assertSame([
            'appointments' => ['request_id'],
            'follow-up-tasks' => ['request_id'],
        ], $dryRun['changes']['recordFields']);
        $this->assertTrue($dryRun['changes']['customScreen']);
        $this->assertSame(AokieReceptionistUpgradeService::FLOW_SLUGS, $dryRun['changes']['flows']);
        $this->assertSame(
            ['call-summary-follow-up', 'after-call-actions', 'appointment-request-apply'],
            $dryRun['changes']['bindingEvents']
        );
        $this->assertCount($versionsBefore, self::$versions->getVersions($settingsId));
        $this->assertSame('Legacy configure-receptionist', $this->flowRow($appId, 'configure-receptionist')['name']);

        $applied = self::$upgrade->run($appId, $record, true);
        $this->assertTrue($applied['applied']);
        $this->assertFalse($applied['legacyScreenAccepted']);
        $this->assertSame(['version' => $versionsBefore + 1], $applied['snapshot']);
        $this->assertSame([
            'appointments' => ['version' => $recordVersionsBefore['appointments'] + 1],
            'follow-up-tasks' => ['version' => $recordVersionsBefore['follow-up-tasks'] + 1],
        ], $applied['fieldSnapshots']);
        $this->assertSame(AokieReceptionistUpgradeService::FLOW_SLUGS, $applied['changes']['flows']);
        $this->assertSame(
            ['call-summary-follow-up', 'after-call-actions', 'appointment-request-apply'],
            $applied['changes']['bindingEvents']
        );
        $this->assertSame($installationsBefore, $this->installationCount(), 'upgrade must not create a second installation');

        $upgradedSettings = self::$forms->getForm($settingsId);
        $upgradedFieldIds = array_column($upgradedSettings['fields'], 'id');
        $this->assertCount(count($legacyFields) + 2, $upgradedFieldIds);
        $this->assertContains('background_ai_source', $upgradedFieldIds);
        $this->assertContains('background_ai_model', $upgradedFieldIds);
        $this->assertSame('verified', $upgradedSettings['customScreen']['_trust']);
        $this->assertSame(
            $desiredSettings['customScreen'],
            $this->withoutScreenMetadata($upgradedSettings['customScreen'])
        );

        $retained = self::$responses->getResponse($settingsId, $response['id']);
        $this->assertSame('RETAIN-ME', $retained['answers']['business_name']);

        foreach (['appointments', 'follow-up-tasks'] as $packFormId) {
            $upgraded = self::$forms->getForm($formMap[$packFormId]);
            $this->assertContains('request_id', array_column($upgraded['fields'], 'id'));
            $snapshot = self::$versions->getVersion(
                $formMap[$packFormId],
                $recordVersionsBefore[$packFormId] + 1
            );
            $this->assertNotNull($snapshot);
            $this->assertNotContains('request_id', array_column($snapshot['data']['fields'], 'id'));
        }

        foreach (AokieReceptionistUpgradeService::FLOW_SLUGS as $slug) {
            $flow = $this->flowRow($appId, $slug);
            if ($slug === 'appointment-request-apply') {
                $this->assertSame(1, (int) $flow['enabled'], "{$slug} enabled state");
                $this->assertSame(1, (int) $flow['version'], "{$slug} initial version");
            } else {
                $this->assertSame($flowEnabled[$slug], (int) $flow['enabled'], "{$slug} enabled state");
                $this->assertSame($flowVersions[$slug] + 1, (int) $flow['version'], "{$slug} version bump");
            }
            $this->assertStringNotContainsString('@pack:', (string) $flow['flow_json']);
        }
        foreach (['call-summary-follow-up', 'after-call-actions'] as $slug) {
            $binding = $this->bindingRow($appId, $slug);
            $this->assertSame('aokie.call.transcript.settled', $binding['event_name']);
            $this->assertSame($bindingEnabled[$slug], (int) $binding['enabled'], "{$slug} binding enabled state");
        }
        $appointmentBinding = $this->bindingRow($appId, 'appointment-request-apply');
        $this->assertSame('aokie.appointment.requested', $appointmentBinding['event_name']);
        $this->assertSame('aokie', $appointmentBinding['connector_id']);
        $this->assertStringNotContainsString('@pack:', (string) $appointmentBinding['output_actions_json']);

        $snapshot = self::$versions->getVersion($settingsId, $versionsBefore + 1);
        $this->assertNotNull($snapshot);
        $this->assertNotContains('background_ai_source', array_column($snapshot['data']['fields'], 'id'));
        $this->assertStringContainsString('<!-- legacy -->', $snapshot['data']['customScreen']['html']);
        $this->assertSame('verified', $snapshot['data']['customScreenTrust']);

        $flowVersionsAfter = [];
        foreach (AokieReceptionistUpgradeService::FLOW_SLUGS as $slug) {
            $flowVersionsAfter[$slug] = (int) $this->flowRow($appId, $slug)['version'];
        }
        $second = self::$upgrade->run($appId, $record, true);
        $this->assertFalse($second['applied']);
        $this->assertFalse($second['legacyScreenAccepted']);
        $this->assertSame([], $second['changes']['settingsFields']);
        $this->assertSame([], $second['changes']['recordFields']);
        $this->assertFalse($second['changes']['customScreen']);
        $this->assertSame([], $second['changes']['flows']);
        $this->assertSame([], $second['changes']['bindingEvents']);
        $this->assertNull($second['snapshot']);
        $this->assertSame([], $second['fieldSnapshots']);
        $this->assertCount($versionsBefore + 1, self::$versions->getVersions($settingsId));
        foreach (AokieReceptionistUpgradeService::FLOW_SLUGS as $slug) {
            $this->assertSame($flowVersionsAfter[$slug], (int) $this->flowRow($appId, $slug)['version']);
        }

        // A duplicate stable alias is refused; the migration never guesses by
        // title or form order.
        $extra = self::$forms->createForm([
            'id' => $this->uuid(),
            'userId' => $this->userId,
            'title' => 'Ambiguous settings',
            'fields' => [],
        ]);
        self::$apps->addFormToApp($appId, $extra['id']);
        self::$apps->updateAppForm($appId, $extra['id'], [
            'settings' => ['packFormId' => AokieReceptionistUpgradeService::SETTINGS_FORM_ID],
        ]);
        $installation = $this->installationRow();
        $formIds = json_decode($installation['form_ids'], true);
        $formIds[] = $extra['id'];
        self::$pdo->prepare('UPDATE pack_installations SET form_ids = ? WHERE id = ?')
            ->execute([json_encode($formIds), $installation['id']]);
        try {
            self::$upgrade->run($appId, $record, false);
            $this->fail('Ambiguous app_forms.packFormId mapping was accepted');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('ambiguous', strtolower($e->getMessage()));
        }

        // Once the alias is unambiguous again, an owner-authored replacement
        // screen is also refused rather than silently overwritten.
        self::$apps->removeFormFromApp($appId, $extra['id']);
        $formIds = array_values(array_filter($formIds, static fn (string $id): bool => $id !== $extra['id']));
        self::$pdo->prepare('UPDATE pack_installations SET form_ids = ? WHERE id = ?')
            ->execute([json_encode($formIds), $installation['id']]);
        self::$forms->updateForm($settingsId, [
            'customScreen' => ['enabled' => true, 'kind' => 'code', 'html' => '<p>Owner</p>', 'css' => '', 'js' => ''],
        ]);
        try {
            self::$upgrade->run($appId, $record, false);
            $this->fail('Owner-authored custom screen was overwritten');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('owner-authored', $e->getMessage());
        }

        $ownerScreen = self::$forms->getForm($settingsId)['customScreen'];
        try {
            self::$upgrade->run($appId, $record, false, $this->screenDigest($ownerScreen));
            $this->fail('An arbitrary owner screen was accepted by supplying its own digest');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('not a known legacy', $e->getMessage());
        }

        $knownLegacyDigest = 'a41e8600774bf22277d42299a604da5e5e08ccfa6c1dec5ada732eacc4898af7';
        try {
            self::$upgrade->run($appId, $record, false, strtoupper($knownLegacyDigest));
            $this->fail('A current owner-authored screen was accepted as the known legacy screen');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('not the accepted known legacy', $e->getMessage());
        }
    }

    public function testKnownLegacyScreenAcceptancePolicyIsPinnedAndExact(): void
    {
        $known = 'a41e8600774bf22277d42299a604da5e5e08ccfa6c1dec5ada732eacc4898af7';
        $method = new \ReflectionMethod(AokieReceptionistUpgradeService::class, 'acceptsKnownLegacyScreen');

        $this->assertTrue($method->invoke(self::$upgrade, $known, $known, 'owner', [], true));
        $this->assertFalse($method->invoke(self::$upgrade, $known, 'b' . substr($known, 1), 'owner', [], true));
        $this->assertFalse($method->invoke(self::$upgrade, $known, $known, 'verified', [], true));
        $this->assertFalse($method->invoke(
            self::$upgrade,
            $known,
            $known,
            'owner',
            ['source' => 'owner'],
            true
        ));
        $this->assertFalse($method->invoke(self::$upgrade, $known, $known, 'owner', [], false));
        $this->assertFalse($method->invoke(
            self::$upgrade,
            str_repeat('0', 64),
            str_repeat('0', 64),
            'owner',
            [],
            true
        ));
    }

    public function testRefusesOwnerAuthoredAdditiveFlowCollision(): void
    {
        $record = $this->aokieRecord();
        $import = self::$packs->importPack($record['pack'], $this->userId);
        $appId = (string) $import['apps'][0]['id'];
        self::$pdo->prepare(
            'DELETE b FROM app_flow_bindings b
              JOIN flow_definitions f ON f.id = b.flow_definition_id
             WHERE b.app_id = ? AND f.slug = ?'
        )->execute([$appId, 'appointment-request-apply']);
        self::$pdo->prepare('DELETE FROM flow_definitions WHERE app_id = ? AND slug = ?')
            ->execute([$appId, 'appointment-request-apply']);
        self::$flows->createFlow($appId, $this->userId, [
            'name' => 'Owner appointment automation',
            'slug' => 'appointment-request-apply',
            'flowJson' => [
                'nodes' => [['id' => 'owner', 'type' => 'logic_block', 'data' => ['expr' => '({})']]],
                'edges' => [],
            ],
        ]);

        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('collides with an owner-authored flow');
        self::$upgrade->run($appId, $record, false);
    }

    public function testRefusesIncompatibleRequestIdField(): void
    {
        $record = $this->aokieRecord();
        $import = self::$packs->importPack($record['pack'], $this->userId);
        $appId = (string) $import['apps'][0]['id'];
        $formMap = $this->formMap($appId);
        $appointments = self::$forms->getForm($formMap['appointments']);
        foreach ($appointments['fields'] as &$field) {
            if (($field['id'] ?? null) === 'request_id') {
                $field['label'] = 'Owner correlation';
            }
        }
        unset($field);
        self::$forms->updateForm($formMap['appointments'], ['fields' => $appointments['fields']]);

        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('owner-authored or incompatible');
        self::$upgrade->run($appId, $record, false);
    }

    /** @return array<string,mixed> */
    private function aokieRecord(): array
    {
        $file = dirname(__DIR__, 2) . '/resources/marketplace-packs/aokie-receptionist.json';
        $record = json_decode((string) file_get_contents($file), true);
        $this->assertIsArray($record);
        return $record;
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
    private function packForm(array $pack, string $packFormId): array
    {
        foreach ($pack['forms'] as $form) {
            if (($form['packFormId'] ?? null) === $packFormId) {
                return $form;
            }
        }
        throw new \RuntimeException('Pack form missing in test fixture');
    }

    /** @return array<string,mixed> */
    private function flowRow(string $appId, string $slug): array
    {
        $stmt = self::$pdo->prepare('SELECT * FROM flow_definitions WHERE app_id = ? AND slug = ?');
        $stmt->execute([$appId, $slug]);
        return $stmt->fetch() ?: throw new \RuntimeException('Flow missing in test');
    }

    /** @return array<string,mixed> */
    private function bindingRow(string $appId, string $slug): array
    {
        $stmt = self::$pdo->prepare(
            'SELECT b.* FROM app_flow_bindings b
              JOIN flow_definitions f ON f.id = b.flow_definition_id
             WHERE b.app_id = ? AND f.slug = ? AND b.connector_id = ?'
        );
        $stmt->execute([$appId, $slug, 'aokie']);
        return $stmt->fetch() ?: throw new \RuntimeException('Binding missing in test');
    }

    /** @return array<string,mixed> */
    private function installationRow(): array
    {
        $stmt = self::$pdo->prepare('SELECT * FROM pack_installations WHERE user_id = ? AND pack_id = ?');
        $stmt->execute([$this->userId, AokieReceptionistUpgradeService::PACK_ID]);
        return $stmt->fetch() ?: throw new \RuntimeException('Installation missing in test');
    }

    private function installationCount(): int
    {
        $stmt = self::$pdo->prepare('SELECT COUNT(*) FROM pack_installations WHERE user_id = ? AND pack_id = ?');
        $stmt->execute([$this->userId, AokieReceptionistUpgradeService::PACK_ID]);
        return (int) $stmt->fetchColumn();
    }

    /** @return array<string,mixed> */
    private function withoutScreenMetadata(array $screen): array
    {
        unset($screen['_trust'], $screen['_provenance']);
        return $screen;
    }

    /** @param array<string,mixed> $screen */
    private function screenDigest(array $screen): string
    {
        return hash('sha256', json_encode(
            $this->canonicalValue($this->withoutScreenMetadata($screen)),
            JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR
        ));
    }

    private function canonicalValue(mixed $value): mixed
    {
        if (!is_array($value)) {
            return $value;
        }
        if (array_is_list($value)) {
            return array_map(fn (mixed $item): mixed => $this->canonicalValue($item), $value);
        }
        ksort($value, SORT_STRING);
        foreach ($value as $key => $item) {
            $value[$key] = $this->canonicalValue($item);
        }
        return $value;
    }

    private function uuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}

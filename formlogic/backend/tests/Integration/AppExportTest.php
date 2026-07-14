<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\AppReportService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FormService;
use FormLogic\Services\PackService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Self-contained app export → import round-trip against a real DB: an exported app carries its forms
 * (fields incl. linked_record, logicScript, customScreen), the app home screen / settings / navConfig,
 * and membership metadata — and re-imports as a fresh, owner-scoped copy with cross-form references
 * remapped. Also asserts the export leaks no real ids / owner ids. Skipped without a test DB.
 */
class AppExportTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static FormService $forms;
    private static AppService $apps;
    private static AppUserService $appUsers;
    private static PackService $packs;

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
            $conn = new MySQLConnection($config);
            $conn->getConnection()->query('SELECT 1');
            $conn->initializeSchema();
            $conn->runMigrations();
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
        self::$mysql = $conn;
        self::$pdo = $conn->getConnection();
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/formlogic-appexport-' . bin2hex(random_bytes(4)));
        self::$forms = new FormService($conn, $sqlite);
        self::$apps = new AppService($conn, self::$forms);
        self::$appUsers = new AppUserService($conn);
        self::$packs = new PackService($conn, self::$forms, self::$apps, self::$appUsers);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->userId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan, cloud_until) VALUES (?, ?, 'x', 'T', 'personal', DATE_ADD(NOW(), INTERVAL 30 DAY))")
            ->execute([$this->userId, $this->userId . '@test.local']);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null || $this->userId === '') {
            return;
        }
        // Apps + their join rows, then forms, then the user.
        $appIds = self::$pdo->prepare('SELECT id FROM apps WHERE owner_id = ?');
        $appIds->execute([$this->userId]);
        foreach ($appIds->fetchAll(PDO::FETCH_COLUMN) as $aid) {
            self::$pdo->prepare('DELETE FROM app_forms WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?)')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$aid]);
        }
        self::$pdo->prepare('DELETE FROM apps WHERE owner_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM pack_installations WHERE user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM forms WHERE user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
    }

    private function uuid(): string
    {
        return 'x-' . bin2hex(random_bytes(12));
    }

    /** Build an app with two linked forms + an app home screen, return [appId, formAId, formBId]. */
    private function buildSampleApp(): array
    {
        $formBId = $this->uuid();
        self::$forms->createForm([
            'id' => $formBId, 'userId' => $this->userId, 'title' => 'Customers', 'status' => 'published',
            'fields' => [['id' => 'name', 'type' => 'short_text', 'label' => 'Name', 'required' => true]],
        ]);

        $formAId = $this->uuid();
        self::$forms->createForm([
            'id' => $formAId, 'userId' => $this->userId, 'title' => 'Orders', 'status' => 'published',
            'logicScript' => 'function onSubmit(ctx){ return; }',
            'customScreen' => ['enabled' => true, 'html' => '<div>order</div>', 'css' => '', 'js' => ''],
            'fields' => [
                ['id' => 'item', 'type' => 'short_text', 'label' => 'Item', 'required' => true],
                ['id' => 'customer', 'type' => 'linked_record', 'label' => 'Customer', 'required' => false, 'properties' => ['targetFormId' => $formBId]],
            ],
        ]);

        $app = self::$apps->createApp([
            'name' => 'Shop',
            'description' => 'Test shop',
            'customScreen' => ['enabled' => true, 'html' => '<h1>Home</h1>', 'css' => 'h1{color:red}', 'js' => 'init();'],
            'settings' => ['hideNav' => true, 'landingPage' => $formAId], // landingPage references a form id
            'navConfig' => [['formId' => $formAId, 'label' => 'Orders', 'icon' => 'FileText']],
        ], $this->userId);
        $appId = $app['id'];
        self::$apps->addFormToApp($appId, $formAId, 'Orders');
        self::$apps->addFormToApp($appId, $formBId, 'Customers');
        self::$apps->updateAppForm($appId, $formBId, ['isVisible' => false]);

        // A custom role (form-scoped permission) + a customized Admin system role (app-level permission).
        $reviewer = self::$appUsers->createRole($appId, ['name' => 'Reviewer', 'description' => 'read-only']);
        self::$appUsers->setRolePermissions($reviewer['id'], [['formId' => $formAId, 'permission' => 'view_all_responses']], true);
        foreach (self::$appUsers->getRoles($appId) as $r) {
            if (($r['name'] ?? '') === 'Admin' && !empty($r['isSystem'])) {
                self::$appUsers->setRolePermissions($r['id'], [['formId' => null, 'permission' => 'view_analytics']], true);
            }
        }

        return [$appId, $formAId, $formBId];
    }

    public function testExportProducesSelfContainedPack(): void
    {
        [$appId, , $formBId] = $this->buildSampleApp();
        $pack = self::$packs->exportApp($appId, $this->userId);

        $this->assertSame(1, $pack['formatVersion']);
        $this->assertCount(2, $pack['forms']);
        $this->assertCount(1, $pack['apps']);

        // App home screen + settings carried.
        $packApp = $pack['apps'][0];
        $this->assertNotEmpty($packApp['customScreen']['html'] ?? '');
        $this->assertTrue(($packApp['settings']['hideNav'] ?? null) === true);
        $this->assertCount(2, $packApp['forms']);

        // The Orders form carries its script + screen, and its linked_record is now an @pack: ref.
        $orders = null;
        foreach ($pack['forms'] as $f) {
            if ($f['title'] === 'Orders') { $orders = $f; }
        }
        $this->assertNotNull($orders);
        $this->assertNotEmpty($orders['logicScript']);
        $this->assertNotEmpty($orders['customScreen']['html'] ?? '');
        $link = null;
        foreach ($orders['fields'] as $fld) {
            if (($fld['type'] ?? '') === 'linked_record') { $link = $fld; }
        }
        $this->assertNotNull($link);
        $this->assertStringStartsWith('@pack:', $link['properties']['targetFormId']);

        // No real ids / owner ids leak.
        $raw = json_encode($pack);
        $this->assertStringNotContainsString($appId, $raw, 'real app id must not leak');
        $this->assertStringNotContainsString($formBId, $raw, 'real form id must not leak');
        $this->assertStringNotContainsString('ownerId', $raw);
        $this->assertStringNotContainsString('owner_id', $raw);
    }

    public function testRoundTripImportRecreatesApp(): void
    {
        [$appId, , ] = $this->buildSampleApp();
        $pack = self::$packs->exportApp($appId, $this->userId);

        $result = self::$packs->importPack($pack, $this->userId);
        $this->assertCount(2, $result['forms']);
        $this->assertCount(1, $result['apps']);

        $newAppId = $result['apps'][0]['id'];
        $this->assertNotSame($appId, $newAppId, 'import must create a fresh app id');

        // New app got the home screen + hideNav setting.
        $newApp = self::$apps->getApp($newAppId);
        $this->assertNotEmpty($newApp['customScreen']['html'] ?? '');
        $this->assertTrue(($newApp['settings']['hideNav'] ?? null) === true);

        // Membership restored incl. the hidden visibility flag.
        $members = self::$apps->getAppForms($newAppId);
        $this->assertCount(2, $members);
        $customers = null;
        foreach ($members as $m) {
            if ($m['displayName'] === 'Customers') { $customers = $m; }
        }
        $this->assertNotNull($customers);
        $this->assertFalse($customers['isVisible'], 'isVisible must round-trip');

        // The Orders linked_record now points at the NEW Customers form UUID (a real id, not @pack:).
        $newOrdersId = null;
        $newCustomersId = null;
        foreach ($result['forms'] as $f) {
            if ($f['title'] === 'Orders') { $newOrdersId = $f['id']; }
            if ($f['title'] === 'Customers') { $newCustomersId = $f['id']; }
        }
        $orders = self::$forms->getForm($newOrdersId);
        $link = null;
        foreach ($orders['fields'] as $fld) {
            if (($fld['type'] ?? '') === 'linked_record') { $link = $fld; }
        }
        $this->assertNotNull($link);
        $this->assertSame($newCustomersId, $link['properties']['targetFormId'], 'linked_record must remap to the new form');
    }

    public function testNavLandingRolesAndJsonShapesRoundTrip(): void
    {
        [$appId, $formAId, ] = $this->buildSampleApp();
        $pack = self::$packs->exportApp($appId, $this->userId);

        // Object-shaped empty fields export as {} not [] — the Customers form has empty settings + theme.
        $json = json_encode($pack);
        $this->assertStringNotContainsString('"theme":[]', $json, 'empty theme must export as {} not []');
        $this->assertStringNotContainsString('"settings":[]', $json, 'empty settings must export as {} not []');

        // navConfig + landingPage reference the form as a portable @pack: key (no real id).
        $packApp = $pack['apps'][0];
        $this->assertStringStartsWith('@pack:', $packApp['navConfig'][0]['formId']);
        $this->assertStringStartsWith('@pack:', $packApp['settings']['landingPage']);
        $this->assertStringNotContainsString($formAId, $json, 'no real form id may leak');

        // Roles: the custom "Reviewer" + the customized system "Admin" both export (Admin flagged system).
        $roleNames = array_map(static fn ($r) => $r['name'], $packApp['roles']);
        $this->assertContains('Reviewer', $roleNames);
        $this->assertContains('Admin', $roleNames);
        $this->assertNotContains('Owner', $roleNames, 'Owner is never exported');

        // Import through JSON (as a real upload would) → assert remaps + role application.
        $imported = json_decode($json, true);
        $result = self::$packs->importPack($imported, $this->userId);
        $newAppId = $result['apps'][0]['id'];
        $newFormA = null;
        foreach ($result['forms'] as $f) {
            if ($f['title'] === 'Orders') { $newFormA = $f['id']; }
        }

        $newApp = self::$apps->getApp($newAppId);
        $this->assertSame($newFormA, $newApp['navConfig'][0]['formId'] ?? null, 'navConfig formId must remap to the new form');
        $this->assertSame($newFormA, $newApp['settings']['landingPage'] ?? null, 'landingPage must remap to the new form');

        $roles = self::$appUsers->getRoles($newAppId);
        $reviewer = null; $admin = null;
        foreach ($roles as $r) {
            if (($r['name'] ?? '') === 'Reviewer') { $reviewer = $r; }
            if (($r['name'] ?? '') === 'Admin') { $admin = $r; }
        }
        $this->assertNotNull($reviewer, 'custom Reviewer role recreated');
        $this->assertNotEmpty($reviewer['permissions'], 'Reviewer keeps its permission');
        $this->assertNotNull($admin);
        $this->assertContains('view_analytics', array_map(static fn ($p) => $p['permission'], $admin['permissions']), 'Admin override applied to the system role');
    }

    // ── Reports: round-trip + validator ──────────────────────────────────────

    public function testReportsRoundTripPreservesSortObjectAndHaving(): void
    {
        [$appId, $formAId, $formBId] = $this->buildSampleApp();
        $reports = [
            // Table sorted by a JOINED field (must remap through @pack: on export, back to a real ref on import).
            ['id' => 'r1', 'name' => 'Orders table', 'type' => 'builder', 'spec' => [
                'formId' => $formAId, 'viz' => 'table',
                'joins' => [['via' => 'customer', 'formId' => $formBId, 'type' => 'left']],
                'columns' => ['item', $formBId . '::name'],
                'sort' => ['by' => $formBId . '::name', 'dir' => 'desc'],
            ]],
            // Grouped bar with HAVING.
            ['id' => 'r2', 'name' => 'Items', 'type' => 'builder', 'spec' => [
                'formId' => $formAId, 'viz' => 'bar', 'groupBy' => ['field' => 'item'], 'measure' => ['fn' => 'count'], 'having' => ['op' => 'gte', 'value' => 1],
            ]],
            ['id' => 'd1', 'name' => 'Overview', 'type' => 'document', 'blocks' => [
                ['id' => 'b1', 'kind' => 'text', 'title' => 'Intro', 'body' => 'hi'],
                ['id' => 'b2', 'kind' => 'report', 'reportId' => 'r1'],
            ]],
        ];
        self::$apps->updateApp($appId, ['reports' => $reports]);

        $pack = self::$packs->exportApp($appId, $this->userId);
        $packReports = $pack['apps'][0]['reports'] ?? [];
        $this->assertCount(3, $packReports, 'all reports export');
        $r1 = $this->findBy($packReports, 'reportId', 'r1');
        $this->assertIsArray($r1['spec']['sort'] ?? null, 'sort object survives export');
        $this->assertStringStartsWith('@pack:', $r1['spec']['sort']['by'], 'joined sort field is portable');
        $this->assertSame('desc', $r1['spec']['sort']['dir']);
        $r2 = $this->findBy($packReports, 'reportId', 'r2');
        $this->assertSame('gte', $r2['spec']['having']['op'] ?? null, 'having survives export');
        // No real ids leak in the exported reports.
        $raw = json_encode($packReports);
        $this->assertStringNotContainsString($formBId, $raw);
        $this->assertStringNotContainsString($formAId, $raw);

        // Re-import into a second account and confirm refs remap to the new form ids.
        $importer = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan, cloud_until) VALUES (?, ?, 'x', 'T', 'personal', DATE_ADD(NOW(), INTERVAL 30 DAY))")
            ->execute([$importer, $importer . '@test.local']);
        try {
            $res = self::$packs->importPack($pack, $importer);
            $newApp = self::$apps->getApp($res['apps'][0]['id']);
            $newReports = $newApp['reports'] ?? [];
            $this->assertCount(3, $newReports);
            $newR1 = $this->findFirst($newReports, static fn ($r) => ($r['name'] ?? '') === 'Orders table');
            $this->assertIsArray($newR1['spec']['sort'] ?? null, 'sort object round-trips');
            $this->assertStringContainsString('::', $newR1['spec']['sort']['by'], 'joined sort ref remapped to a real form id');
            $this->assertStringNotContainsString('@pack:', $newR1['spec']['sort']['by']);
            $this->assertSame('desc', $newR1['spec']['sort']['dir']);
            $newR2 = $this->findFirst($newReports, static fn ($r) => ($r['name'] ?? '') === 'Items');
            $this->assertSame('gte', $newR2['spec']['having']['op'] ?? null, 'having round-trips');
            // The document's report block was remapped to the imported chart's new id.
            $newDoc = $this->findFirst($newReports, static fn ($r) => ($r['type'] ?? '') === 'document');
            $reportBlock = $this->findFirst($newDoc['blocks'], static fn ($b) => ($b['kind'] ?? '') === 'report');
            $this->assertSame($newR1['id'], $reportBlock['reportId'], 'document report block points at the imported chart');
        } finally {
            $this->cleanupUser($importer);
        }
    }

    public function testValidatorDropsForeignAndBrokenReports(): void
    {
        [$appId, $formAId, $formBId] = $this->buildSampleApp();
        $foreign = $this->uuid();
        self::$forms->createForm(['id' => $foreign, 'userId' => $this->userId, 'title' => 'Foreign', 'status' => 'published', 'fields' => [['id' => 'x', 'type' => 'short_text', 'label' => 'X', 'required' => false]]]);
        $validator = new AppReportService(self::$apps, self::$forms);

        $clean = $validator->sanitizeReports([
            ['id' => 'ok', 'name' => 'Good', 'type' => 'builder', 'spec' => ['formId' => $formAId, 'viz' => 'bar', 'groupBy' => ['field' => 'item'], 'measure' => ['fn' => 'count']]],
            ['id' => 'foreign', 'name' => 'Foreign base', 'type' => 'builder', 'spec' => ['formId' => $foreign, 'viz' => 'kpi', 'measure' => ['fn' => 'count']]],
            ['id' => 'badjoin', 'name' => 'Bad join', 'type' => 'builder', 'spec' => ['formId' => $formAId, 'viz' => 'bar', 'joins' => [['via' => 'nope', 'formId' => $formBId]], 'groupBy' => ['field' => 'item'], 'measure' => ['fn' => 'count']]],
            ['id' => 'badfield', 'name' => 'Bad field', 'type' => 'builder', 'spec' => ['formId' => $formAId, 'viz' => 'table', 'columns' => ['item', 'ghost_field']]],
            ['id' => 'doc-broken', 'name' => 'Broken doc', 'type' => 'document', 'blocks' => [['kind' => 'report', 'reportId' => 'foreign']]],
            ['id' => 'doc-ok', 'name' => 'Good doc', 'type' => 'document', 'blocks' => [['kind' => 'report', 'reportId' => 'ok']]],
        ], $appId);

        $ids = array_column($clean, 'id');
        $this->assertContains('ok', $ids, 'a valid chart survives');
        $this->assertNotContains('foreign', $ids, 'a chart on a form outside the app is dropped');
        $this->assertNotContains('doc-broken', $ids, 'a document with only a broken report block is dropped');
        $this->assertContains('doc-ok', $ids, 'a document referencing a valid chart survives');
        // Bad join dropped but the report kept; ghost column dropped.
        $badjoin = $this->findFirst($clean, static fn ($r) => ($r['id'] ?? '') === 'badjoin');
        $this->assertArrayNotHasKey('joins', $badjoin['spec'], 'a join that is not a real linked_record is dropped');
        $badfield = $this->findFirst($clean, static fn ($r) => ($r['id'] ?? '') === 'badfield');
        $this->assertSame(['item'], $badfield['spec']['columns'], 'a non-existent column ref is dropped');
    }

    private function findBy(array $rows, string $key, string $val): array
    {
        foreach ($rows as $r) { if (($r[$key] ?? null) === $val) { return $r; } }
        $this->fail("no row with $key=$val");
    }

    private function findFirst(array $rows, callable $pred): array
    {
        foreach ($rows as $r) { if ($pred($r)) { return $r; } }
        $this->fail('no matching row');
    }

    private function cleanupUser(string $uid): void
    {
        $appIds = self::$pdo->prepare('SELECT id FROM apps WHERE owner_id = ?');
        $appIds->execute([$uid]);
        foreach ($appIds->fetchAll(PDO::FETCH_COLUMN) as $aid) {
            self::$pdo->prepare('DELETE FROM app_forms WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?)')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$aid]);
        }
        self::$pdo->prepare('DELETE FROM apps WHERE owner_id = ?')->execute([$uid]);
        self::$pdo->prepare('DELETE FROM pack_installations WHERE user_id = ?')->execute([$uid]);
        self::$pdo->prepare('DELETE FROM forms WHERE user_id = ?')->execute([$uid]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
    }
}

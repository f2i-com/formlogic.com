<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppService;
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
}

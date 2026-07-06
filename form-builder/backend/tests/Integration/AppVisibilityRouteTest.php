<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Constants\AppPermissions;
use FormLogic\Controllers\AppPublicController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppDomainService;
use FormLogic\Services\AppResponseService;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FormService;
use FormLogic\Services\ResponseService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Response as SlimResponse;

/**
 * Route-level test for the member-visibility filtering (launch-review #3): drives the real
 * AppPublicController::getApp / getForm against a real DB, verifying the whole boundary — membership +
 * permissions + app forms + sanitisation — not just the pure filter functions. Skipped without a test DB.
 */
class AppVisibilityRouteTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static AppPublicController $ctrl;

    /** @var string[] */ private array $userIds = [];
    /** @var string[] */ private array $formIds = [];
    private string $appId = '';

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
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/fl-vis-' . bin2hex(random_bytes(5)));
        $formService = new FormService($conn, $sqlite);
        $responseService = new ResponseService($conn, $sqlite);
        self::$ctrl = new AppPublicController(
            new AppService($conn, $formService),
            new AppUserService($conn),
            new AppResponseService($conn, $sqlite, $responseService, null, $formService),
            $formService,
            $responseService,
            $conn,
            $sqlite,
            new AppDomainService($conn)
        );
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        if ($this->appId !== '') {
            self::$pdo->prepare('DELETE FROM app_forms WHERE app_id = ?')->execute([$this->appId]);
            self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$this->appId]);
            self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?)')->execute([$this->appId]);
            self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$this->appId]);
            self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$this->appId]);
        }
        foreach ($this->formIds as $fid) {
            self::$pdo->prepare('DELETE FROM forms WHERE id = ?')->execute([$fid]);
        }
        foreach ($this->userIds as $uid) {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
        }
    }

    private function uuid(): string { return bin2hex(random_bytes(10)); }

    private function makeUser(): string
    {
        $id = 'u' . $this->uuid();
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan, cloud_until) VALUES (?, ?, 'x', 'T', 'personal', DATE_ADD(NOW(), INTERVAL 30 DAY))")
            ->execute([$id, $id . '@test.local']);
        $this->userIds[] = $id;
        return $id;
    }

    private function makeForm(string $ownerId): string
    {
        $id = 'form' . $this->uuid();
        self::$pdo->prepare("INSERT INTO forms (id, user_id, title, status) VALUES (?, ?, 'T', 'published')")->execute([$id, $ownerId]);
        $this->formIds[] = $id;
        return $id;
    }

    private function addFormToApp(string $appId, string $formId): void
    {
        self::$pdo->prepare("INSERT INTO app_forms (id, app_id, form_id, display_name, sort_order, is_visible, settings) VALUES (?, ?, ?, 'T', 0, 1, '{}')")
            ->execute(['af' . $this->uuid(), $appId, $formId]);
    }

    private function grantFormPerm(string $appId, string $userId, string $formId, string $perm): void
    {
        $role = 'role' . $this->uuid();
        self::$pdo->prepare("INSERT INTO app_roles (id, app_id, name, is_system, sort_order) VALUES (?, ?, ?, 0, 0)")->execute([$role, $appId, 'R' . substr($role, 0, 10)]);
        self::$pdo->prepare("INSERT INTO app_role_permissions (id, role_id, form_id, permission) VALUES (?, ?, ?, ?)")->execute(['arp' . $this->uuid(), $role, $formId, $perm]);
        self::$pdo->prepare("INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at) VALUES (?, ?, ?, ?, 'active', NOW())")->execute(['au' . $this->uuid(), $appId, $userId, $role]);
    }

    /** @return array{app:string,formA:string,formB:string,owner:string,member:string,slug:string} */
    private function seedApp(): array
    {
        $owner = $this->makeUser();
        $member = $this->makeUser();
        $formA = $this->makeForm($owner);
        $formB = $this->makeForm($owner);
        $appId = 'app' . $this->uuid();
        $slug = 'vis' . substr($this->uuid(), 0, 12);
        $nav = json_encode([
            ['formId' => $formA, 'displayName' => 'A', 'sortOrder' => 0, 'isVisible' => true],
            ['formId' => $formB, 'displayName' => 'B', 'sortOrder' => 1, 'isVisible' => true],
        ]);
        $dash = json_encode(['enabled' => true, 'kind' => 'dashboard', 'dashboard' => ['version' => 1, 'widgets' => [
            ['id' => 'wA', 'kind' => 'report', 'spec' => ['formId' => $formA, 'viz' => 'kpi'], 'layout' => []],
            ['id' => 'wB', 'kind' => 'report', 'spec' => ['formId' => $formB, 'viz' => 'kpi'], 'layout' => []],
        ]]]);
        $reports = json_encode([
            ['id' => 'rA', 'type' => 'builder', 'spec' => ['formId' => $formA, 'viz' => 'bar']],
            ['id' => 'rB', 'type' => 'builder', 'spec' => ['formId' => $formB, 'viz' => 'bar']],
        ]);
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status, settings, nav_config, custom_screen, reports) VALUES (?, ?, 'T', ?, 'published', '{}', ?, ?, ?)")
            ->execute([$appId, $owner, $slug, $nav, $dash, $reports]);
        $this->appId = $appId;
        // Owner needs a membership row to resolve a role (owner_id bypass grants all perms).
        $this->grantFormPerm($appId, $owner, $formA, AppPermissions::VIEW_ALL_RESPONSES);
        $this->addFormToApp($appId, $formA);
        $this->addFormToApp($appId, $formB);
        // Member: view_all on Form A ONLY.
        $this->grantFormPerm($appId, $member, $formA, AppPermissions::VIEW_ALL_RESPONSES);

        return ['app' => $appId, 'formA' => $formA, 'formB' => $formB, 'owner' => $owner, 'member' => $member, 'slug' => $slug];
    }

    /** @return array{status:int, body:array} */
    private function getApp(?string $userId, string $slug): array
    {
        $req = $this->createMock(ServerRequestInterface::class);
        $req->method('getAttribute')->willReturnCallback(fn($n) => $n === 'userId' ? $userId : null);
        $out = self::$ctrl->getApp($req, new SlimResponse(), ['slug' => $slug]);
        return ['status' => $out->getStatusCode(), 'body' => json_decode((string) $out->getBody(), true) ?: []];
    }

    private function getFormStatus(?string $userId, string $slug, string $formId): int
    {
        $req = $this->createMock(ServerRequestInterface::class);
        $req->method('getAttribute')->willReturnCallback(fn($n) => $n === 'userId' ? $userId : null);
        return self::$ctrl->getForm($req, new SlimResponse(), ['slug' => $slug, 'formId' => $formId])->getStatusCode();
    }

    public function testMemberSeesOnlyPermittedFormAndNoTraceOfHiddenForm(): void
    {
        $s = $this->seedApp();

        $r = $this->getApp($s['member'], $s['slug']);
        $this->assertSame(200, $r['status']);

        // Only Form A schema is returned.
        $formIds = array_column($r['body']['forms'] ?? [], 'formId');
        $this->assertSame([$s['formA']], $formIds);

        // Form B is absent from every corner of the app payload.
        $blob = json_encode($r['body']);
        $this->assertStringNotContainsString($s['formB'], $blob, 'no reference to the hidden form anywhere in the app payload');
        $this->assertSame([$s['formA']], array_column($r['body']['app']['navConfig'] ?? [], 'formId'));
        $widgetForms = array_map(fn($w) => $w['spec']['formId'] ?? null, $r['body']['app']['customScreen']['dashboard']['widgets'] ?? []);
        $this->assertSame([$s['formA']], array_values(array_filter($widgetForms)));
        $reportForms = array_map(fn($rep) => $rep['spec']['formId'] ?? null, $r['body']['app']['reports'] ?? []);
        $this->assertSame([$s['formA']], array_values(array_filter($reportForms)));

        // Direct schema fetch: A is 200, B is 404.
        $this->assertSame(200, $this->getFormStatus($s['member'], $s['slug'], $s['formA']));
        $this->assertSame(404, $this->getFormStatus($s['member'], $s['slug'], $s['formB']));
    }

    public function testOwnerSeesEverything(): void
    {
        $s = $this->seedApp();
        $r = $this->getApp($s['owner'], $s['slug']);
        $this->assertSame(200, $r['status']);
        $formIds = array_column($r['body']['forms'] ?? [], 'formId');
        sort($formIds);
        $expected = [$s['formA'], $s['formB']];
        sort($expected);
        $this->assertSame($expected, $formIds);
        $this->assertSame(200, $this->getFormStatus($s['owner'], $s['slug'], $s['formB']));
    }
}

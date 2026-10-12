<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use Firebase\JWT\JWT;
use FormLogic\Constants\AppPermissions;
use FormLogic\Controllers\AppController;
use FormLogic\Controllers\AppUserController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Http\AdminActingAsRoutes;
use FormLogic\Middleware\AdminActAsMiddleware;
use FormLogic\Middleware\AdminGateMiddleware;
use FormLogic\Middleware\AuthMiddleware;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\AuditService;
use FormLogic\Services\AuthService;
use FormLogic\Services\FormService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Container\ContainerInterface;
use Psr\Http\Message\ResponseInterface;
use Slim\Factory\AppFactory;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Routing\RouteCollectorProxy;

/**
 * A platform admin acting as an owner for support (/api/admin/users/{ownerId}/...) is the owner
 * to everything the members screens ask: the apps list and the app itself say so (canManage,
 * ownerId), and the rule that only the owner changes a member holding an app-level role, or a
 * role's app-level grants, lets them through. Through the real middleware chain, as
 * AdminActingAsTest runs it.
 *
 * Acting as an account gives that account's rights and no more: acting as a delegated manager
 * is refused what the manager is refused. Without acting, an admin is no member of the app.
 */
class AdminActingAsMembersTest extends TestCase
{
    private const JWT_SECRET = 'acting-as-members-test-secret-0123456789';

    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static AppService $apps;
    private static AppUserService $appUsers;
    private static \Slim\App $slim;
    private static string $tmpRoot = '';

    /** @var string[] */
    private array $userIds = [];
    private string $ownerId = '';
    private string $adminId = '';
    private string $managerId = '';
    private string $appId = '';
    private string $adminRoleId = '';
    private string $memberRoleId = '';
    private string $appAdminMembership = '';

    public static function setUpBeforeClass(): void
    {
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) {
            \Dotenv\Dotenv::createImmutable($root)->safeLoad();
        }
        try {
            $conn = new MySQLConnection([
                'host' => $_ENV['DB_HOST'] ?? '127.0.0.1',
                'port' => $_ENV['DB_PORT'] ?? '3306',
                'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
                'username' => $_ENV['DB_USERNAME'] ?? 'root',
                'password' => $_ENV['DB_PASSWORD'] ?? '',
                'charset' => 'utf8mb4',
                'collation' => 'utf8mb4_unicode_ci',
            ]);
            $conn->getConnection()->query('SELECT 1');
            $conn->initializeSchema();
            $conn->runMigrations();
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
        self::$mysql = $conn;
        self::$pdo = $conn->getConnection();
        self::$tmpRoot = sys_get_temp_dir() . '/formlogic-actingas-members-' . bin2hex(random_bytes(4));
        mkdir(self::$tmpRoot, 0777, true);

        self::$apps = new AppService($conn, new FormService($conn, new SQLiteConnection(self::$tmpRoot . '/sqlite')));
        self::$appUsers = new AppUserService($conn);
        $audit = new AuditService($conn, null, 'acting-as-members-test-hmac-key');
        $auth = new AuthService($conn, [
            'secret' => self::JWT_SECRET,
            'expiry' => 3600,
            'algorithm' => 'HS256',
            'issuer' => 'formlogic',
            'audience' => 'formlogic-api',
        ]);

        // The two controllers the members screens talk to, wired as public/index.php wires them.
        $controllers = [
            AppController::class => new AppController(self::$apps, null, $audit, null, null, self::$appUsers),
            AppUserController::class => new AppUserController(self::$appUsers, self::$apps, $audit),
        ];
        $container = new class ($controllers) implements ContainerInterface {
            public function __construct(private array $services)
            {
            }
            public function get(string $id): mixed
            {
                return $this->services[$id];
            }
            public function has(string $id): bool
            {
                return isset($this->services[$id]);
            }
        };

        self::$slim = AppFactory::create();
        self::$slim->group('/api/admin/users/{ownerId}', function (RouteCollectorProxy $group) use ($container) {
            AdminActingAsRoutes::register($group, $container);
        })
            ->add(new AdminActAsMiddleware($auth, $audit))
            ->add(new AdminGateMiddleware($auth))
            ->add(new AuthMiddleware($auth));
        self::$slim->addRoutingMiddleware();
    }

    public static function tearDownAfterClass(): void
    {
        if (self::$tmpRoot !== '' && is_dir(self::$tmpRoot)) {
            @rmdir(self::$tmpRoot . '/sqlite');
            @rmdir(self::$tmpRoot);
        }
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->ownerId = $this->makeUser(false);
        $this->adminId = $this->makeUser(true);
        $this->managerId = $this->makeUser(false);

        $app = self::$apps->createApp(['name' => 'Support Desk'], $this->ownerId);
        $this->appId = (string) $app['id'];
        self::$apps->publishApp($this->appId, null, $this->ownerId);

        $this->adminRoleId = $this->makeRole('App admin', [AppPermissions::MANAGE_APP]);
        $managerRoleId = $this->makeRole('People manager', [AppPermissions::MANAGE_USERS, AppPermissions::MANAGE_ROLES]);
        $this->memberRoleId = $this->makeRole('Clerk', [AppPermissions::VIEW_OWN_RESPONSES]);

        $this->addMember($this->managerId, $managerRoleId);
        $this->appAdminMembership = $this->addMember($this->makeUser(false), $this->adminRoleId);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        if ($this->appId !== '') {
            self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$this->appId]);
            self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?)')->execute([$this->appId]);
            self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$this->appId]);
            self::$pdo->prepare('DELETE FROM app_versions WHERE app_id = ?')->execute([$this->appId]);
            self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$this->appId]);
        }
        foreach ($this->userIds as $uid) {
            self::$pdo->prepare('DELETE FROM audit_log WHERE user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
        }
        $this->userIds = [];
    }

    private function makeUser(bool $isAdmin): string
    {
        $id = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, is_admin) VALUES (?, ?, 'x', 'T', ?)")
            ->execute([$id, $id . '@test.local', $isAdmin ? 1 : 0]);
        $this->userIds[] = $id;
        return $id;
    }

    /** @param string[] $appLevel */
    private function makeRole(string $name, array $appLevel): string
    {
        $role = self::$appUsers->createRole($this->appId, ['name' => $name]);
        self::$appUsers->setRolePermissions(
            (string) $role['id'],
            array_map(static fn (string $p): array => ['formId' => null, 'permission' => $p], $appLevel),
            true
        );
        return (string) $role['id'];
    }

    private function addMember(string $userId, string $roleId): string
    {
        $id = 'au-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at) VALUES (?, ?, ?, ?, 'active', NOW())")
            ->execute([$id, $this->appId, $userId, $roleId]);
        return $id;
    }

    private function tokenFor(string $userId): string
    {
        $iat = time();
        return JWT::encode([
            'iss' => 'formlogic', 'aud' => 'formlogic-api', 'sub' => $userId, 'email' => $userId . '@test.local',
            'iat' => $iat, 'nbf' => $iat, 'exp' => $iat + 3600, 'tv' => 0,
        ], self::JWT_SECRET, 'HS256');
    }

    /** A request an admin makes while acting as $asUserId. */
    private function acting(string $asUserId, string $method, string $path, ?array $body = null): ResponseInterface
    {
        $request = (new ServerRequestFactory())->createServerRequest($method, "/api/admin/users/{$asUserId}{$path}")
            ->withHeader('Authorization', 'Bearer ' . $this->tokenFor($this->adminId));
        if ($body !== null) {
            $request = $request->withParsedBody($body);
        }
        return self::$slim->handle($request);
    }

    private function json(ResponseInterface $response): array
    {
        $response->getBody()->rewind();
        return json_decode((string) $response->getBody(), true) ?? [];
    }

    private function membership(string $appUserId): ?array
    {
        $stmt = self::$pdo->prepare('SELECT role_id, status FROM app_users WHERE id = ?');
        $stmt->execute([$appUserId]);
        return $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
    }

    public function testTheAppsListAndTheAppTellAnActingAdminTheyManageIt(): void
    {
        $list = $this->json($this->acting($this->ownerId, 'GET', '/apps'));
        $listed = array_values(array_filter($list['apps'] ?? [], fn (array $a): bool => $a['id'] === $this->appId));
        $this->assertCount(1, $listed);
        $this->assertTrue($listed[0]['canManage']);
        $this->assertSame($this->ownerId, $listed[0]['ownerId'] ?? null);

        // The app itself, which the App Studio's access step is given: ownerId is the owner's, not
        // the admin's, so only canManage tells the screen that this viewer acts as the owner.
        $shown = $this->json($this->acting($this->ownerId, 'GET', "/apps/{$this->appId}"))['app'] ?? [];
        $this->assertSame($this->ownerId, $shown['ownerId'] ?? null);
        $this->assertTrue($shown['canManage'] ?? null, 'GET /apps/{id} must say the owner (or an admin acting as them) manages the app');
    }

    public function testAMemberIsToldTheyDoNotManageTheApp(): void
    {
        $shown = $this->json($this->acting($this->managerId, 'GET', "/apps/{$this->appId}"))['app'] ?? [];
        $this->assertSame($this->appId, $shown['id'] ?? null);
        $this->assertFalse($shown['canManage'] ?? null);
        $this->assertArrayNotHasKey('ownerId', $shown);
    }

    public function testAnActingAdminChangesAMemberWhoHoldsAnAppLevelRole(): void
    {
        $users = $this->json($this->acting($this->ownerId, 'GET', "/apps/{$this->appId}/users"))['users'] ?? [];
        $row = array_values(array_filter($users, fn (array $u): bool => $u['id'] === $this->appAdminMembership))[0] ?? null;
        $this->assertNotNull($row);
        $this->assertTrue($row['holdsAppLevelRole']);

        $suspend = $this->acting($this->ownerId, 'PUT', "/apps/{$this->appId}/users/{$this->appAdminMembership}", ['status' => 'suspended']);
        $this->assertSame(200, $suspend->getStatusCode(), (string) $suspend->getBody());
        $this->assertSame('suspended', $this->membership($this->appAdminMembership)['status']);

        $reRole = $this->acting($this->ownerId, 'PUT', "/apps/{$this->appId}/users/{$this->appAdminMembership}", ['roleId' => $this->memberRoleId, 'status' => 'active']);
        $this->assertSame(200, $reRole->getStatusCode(), (string) $reRole->getBody());
        $this->assertSame($this->memberRoleId, $this->membership($this->appAdminMembership)['role_id']);

        // ...and gives an app-level role back, which only the owner may.
        $promote = $this->acting($this->ownerId, 'PUT', "/apps/{$this->appId}/users/{$this->appAdminMembership}", ['roleId' => $this->adminRoleId]);
        $this->assertSame(200, $promote->getStatusCode(), (string) $promote->getBody());

        $remove = $this->acting($this->ownerId, 'DELETE', "/apps/{$this->appId}/users/{$this->appAdminMembership}");
        $this->assertSame(200, $remove->getStatusCode(), (string) $remove->getBody());
        $this->assertNull($this->membership($this->appAdminMembership));
    }

    public function testAnActingAdminChangesARolesAppLevelGrants(): void
    {
        $grant = $this->acting($this->ownerId, 'PUT', "/apps/{$this->appId}/roles/{$this->memberRoleId}/permissions", [
            'permissions' => [['formId' => null, 'permission' => AppPermissions::MANAGE_USERS]],
        ]);
        $this->assertSame(200, $grant->getStatusCode(), (string) $grant->getBody());
        $this->assertSame([AppPermissions::MANAGE_USERS], array_column(self::$appUsers->getRolePermissions($this->memberRoleId), 'permission'));

        $drop = $this->acting($this->ownerId, 'PUT', "/apps/{$this->appId}/roles/{$this->adminRoleId}/permissions", ['permissions' => []]);
        $this->assertSame(200, $drop->getStatusCode(), (string) $drop->getBody());
        $this->assertSame([], self::$appUsers->getRolePermissions($this->adminRoleId));
    }

    public function testActingAsADelegatedManagerGivesTheManagersRightsAndNoMore(): void
    {
        $suspend = $this->acting($this->managerId, 'PUT', "/apps/{$this->appId}/users/{$this->appAdminMembership}", ['status' => 'suspended']);
        $this->assertSame(400, $suspend->getStatusCode());
        $this->assertStringContainsString('Only the app owner', $this->json($suspend)['message'] ?? '');
        $this->assertSame('active', $this->membership($this->appAdminMembership)['status']);

        $grant = $this->acting($this->managerId, 'PUT', "/apps/{$this->appId}/roles/{$this->memberRoleId}/permissions", [
            'permissions' => [['formId' => null, 'permission' => AppPermissions::MANAGE_APP]],
        ]);
        $this->assertSame(400, $grant->getStatusCode());
    }

    public function testWithoutActingAnAdminIsNoMemberOfTheApp(): void
    {
        // The admin's own id on the acting route: the same controllers, run as the admin's account.
        $this->assertSame(403, $this->acting($this->adminId, 'GET', "/apps/{$this->appId}/users")->getStatusCode());
        $this->assertSame(404, $this->acting($this->adminId, 'GET', "/apps/{$this->appId}")->getStatusCode());
        $this->assertFalse(self::$appUsers->hasPermission($this->appId, $this->adminId, AppPermissions::MANAGE_USERS));
    }
}

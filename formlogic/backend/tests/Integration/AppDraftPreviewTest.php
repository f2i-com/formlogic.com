<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

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
 * Draft-app runtime preview (studio "Use app" before the first publish):
 *
 *  - AppService::isRuntimeVisible — published visible to anyone (membership is
 *    enforced separately), a DRAFT only to its owner, archived to nobody;
 *  - GET /api/app/{slug} — the owner gets a 200 preview of their draft app,
 *    while a non-owner member and an anonymous request keep the 404 (a draft
 *    must not leak its existence to anyone but the owner);
 *  - GET /api/app/{slug}/membership follows the same rule (the runtime shell
 *    calls it right after the app config);
 *  - once published, the member's runtime opens as before.
 *
 * Skipped unless a test database is reachable (same setup as AppActivityRelationsTest).
 */
class AppDraftPreviewTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static SQLiteConnection $sqlite;
    private static AppService $appService;
    private static AppUserService $appUserService;
    private static AppPublicController $publicCtrl;

    /** @var string[] */ private array $userIds = [];
    /** @var string[] */ private array $appIds = [];

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
        self::$sqlite = new SQLiteConnection(sys_get_temp_dir() . '/fl-draftprev-' . bin2hex(random_bytes(5)));
        $formService = new FormService($conn, self::$sqlite);
        $responseService = new ResponseService($conn, self::$sqlite);
        self::$appService = new AppService($conn, $formService);
        self::$appUserService = new AppUserService($conn);
        self::$publicCtrl = new AppPublicController(
            self::$appService,
            self::$appUserService,
            new AppResponseService($conn, self::$sqlite, $responseService, null, $formService),
            $formService,
            $responseService,
            $conn,
            self::$sqlite,
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
        foreach ($this->appIds as $appId) {
            self::$pdo->prepare('DELETE FROM app_versions WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_forms WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?)')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$appId]);
        }
        foreach ($this->userIds as $uid) {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
        }
        $this->appIds = $this->userIds = [];
    }

    private function uuid(): string
    {
        return bin2hex(random_bytes(10));
    }

    private function makeUser(): string
    {
        $id = 'u' . $this->uuid();
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan, cloud_until) VALUES (?, ?, 'x', 'T', 'personal', DATE_ADD(NOW(), INTERVAL 30 DAY))")
            ->execute([$id, $id . '@test.local']);
        $this->userIds[] = $id;
        return $id;
    }

    /** @return array{status:int, body:array} */
    private function callRuntime(string $method, ?string $userId, string $slug): array
    {
        $req = $this->createMock(ServerRequestInterface::class);
        $req->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $userId : null);
        $req->method('getParsedBody')->willReturn([]);
        $req->method('getQueryParams')->willReturn([]);
        $out = self::$publicCtrl->{$method}($req, new SlimResponse(), ['slug' => $slug]);
        return ['status' => $out->getStatusCode(), 'body' => json_decode((string) $out->getBody(), true) ?: []];
    }

    public function testIsRuntimeVisibleMatrix(): void
    {
        $svc = self::$appService;
        $draft = ['status' => 'draft', 'ownerId' => 'owner-1'];
        $published = ['status' => 'published', 'ownerId' => 'owner-1'];
        $archived = ['status' => 'archived', 'ownerId' => 'owner-1'];

        $this->assertTrue($svc->isRuntimeVisible($published, null), 'published visible anonymously');
        $this->assertTrue($svc->isRuntimeVisible($published, 'someone-else'));
        $this->assertTrue($svc->isRuntimeVisible($draft, 'owner-1'), 'draft visible to its owner');
        $this->assertFalse($svc->isRuntimeVisible($draft, 'someone-else'), 'draft hidden from non-owners');
        $this->assertFalse($svc->isRuntimeVisible($draft, null), 'draft hidden anonymously');
        $this->assertFalse($svc->isRuntimeVisible($draft, ''), 'empty user id never unlocks a draft');
        $this->assertFalse($svc->isRuntimeVisible($archived, 'owner-1'), 'archived never resolves');
    }

    public function testOwnerPreviewsDraftRuntimeOthersGet404(): void
    {
        $owner = $this->makeUser();
        $member = $this->makeUser();
        $app = self::$appService->createApp(['name' => 'Draft preview app'], $owner);
        $this->appIds[] = $app['id'];
        $this->assertSame('draft', $app['status']);

        // Add the second user as an active member (invited flow shortcut: direct row).
        $roles = self::$appUserService->getRoles($app['id']);
        $memberRole = null;
        foreach ($roles as $role) {
            if ($role['name'] === 'Member') {
                $memberRole = $role;
            }
        }
        $this->assertNotNull($memberRole);
        self::$pdo->prepare("INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at) VALUES (?, ?, ?, ?, 'active', NOW())")
            ->execute(['au' . $this->uuid(), $app['id'], $member, $memberRole['id']]);

        // Owner: full draft preview, flagged as managing.
        $ownerRes = $this->callRuntime('getApp', $owner, $app['slug']);
        $this->assertSame(200, $ownerRes['status']);
        $this->assertSame('draft', $ownerRes['body']['app']['status'] ?? null);
        $this->assertTrue($ownerRes['body']['app']['canManage'] ?? false);

        // Non-owner member + anonymous: the draft does not exist for them.
        $this->assertSame(404, $this->callRuntime('getApp', $member, $app['slug'])['status']);
        $this->assertSame(404, $this->callRuntime('getApp', null, $app['slug'])['status']);

        // Membership follows the same rule.
        $this->assertSame(200, $this->callRuntime('membership', $owner, $app['slug'])['status']);
        $this->assertSame(404, $this->callRuntime('membership', $member, $app['slug'])['status']);

        // Publish → the member's runtime opens as before.
        self::$appService->publishApp($app['id'], null, $owner);
        $this->assertSame(200, $this->callRuntime('getApp', $member, $app['slug'])['status']);
    }
}

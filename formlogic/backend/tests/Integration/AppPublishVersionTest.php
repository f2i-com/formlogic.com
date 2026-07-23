<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\AppController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\FormService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Response as SlimResponse;

/**
 * App Studio publish flow — AppService::publishApp / listAppVersions +
 * AppController::publish / versions (POST /api/apps/{id}/publish,
 * GET /api/apps/{id}/versions). Verifies:
 *
 *  - publish flips status → published, bumps published_version (1, 2, …), stamps
 *    published_at, and inserts exactly one app_versions history row per publish
 *  - the history row carries the (trimmed, 160-cap) label and the publisher id
 *  - listAppVersions returns newest-first with camelCase keys
 *  - unpublishing (status → draft via updateApp) does NOT rewind the version
 *  - controller: owner 200 with { app, version }; non-owner and unknown id 404;
 *    versions endpoint is member-readable
 *
 * Skipped unless a test database is reachable (same setup as AppCompanionTest).
 */
class AppPublishVersionTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static AppService $apps;
    private static AppController $ctrl;

    /** @var string[] */
    private array $userIds = [];
    /** @var string[] */
    private array $appIds = [];

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
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/fl-publish-' . bin2hex(random_bytes(5)));
        $formService = new FormService($conn, $sqlite);
        self::$apps = new AppService($conn, $formService);
        self::$ctrl = new AppController(self::$apps);
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
    }

    private function uuid(): string
    {
        return bin2hex(random_bytes(14));
    }

    private function makeUser(): string
    {
        $id = 'u-' . $this->uuid();
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan, cloud_until) VALUES (?, ?, 'x', 'T', 'personal', DATE_ADD(NOW(), INTERVAL 30 DAY))")
            ->execute([$id, $id . '@test.local']);
        $this->userIds[] = $id;
        return $id;
    }

    private function makeApp(string $ownerId, string $name = 'Studio App'): array
    {
        $app = self::$apps->createApp(['name' => $name], $ownerId);
        $this->appIds[] = $app['id'];
        return $app;
    }

    /** @return array{status:int, body:array} */
    private function callPublish(?string $userId, string $appId, array $body = []): array
    {
        $req = $this->createMock(ServerRequestInterface::class);
        $req->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $userId : null);
        $req->method('getParsedBody')->willReturn($body);
        $out = self::$ctrl->publish($req, new SlimResponse(), ['id' => $appId]);
        return ['status' => $out->getStatusCode(), 'body' => json_decode((string) $out->getBody(), true) ?: []];
    }

    /** @return array{status:int, body:array} */
    private function callVersions(?string $userId, string $appId): array
    {
        $req = $this->createMock(ServerRequestInterface::class);
        $req->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $userId : null);
        $req->method('getParsedBody')->willReturn([]);
        $out = self::$ctrl->versions($req, new SlimResponse(), ['id' => $appId]);
        return ['status' => $out->getStatusCode(), 'body' => json_decode((string) $out->getBody(), true) ?: []];
    }

    public function testPublishBumpsVersionStampsTimestampAndRecordsHistory(): void
    {
        $owner = $this->makeUser();
        $app = $this->makeApp($owner);

        $this->assertSame('draft', $app['status']);
        $this->assertSame(0, $app['publishedVersion']);
        $this->assertNull($app['publishedAt']);

        $first = self::$apps->publishApp($app['id'], 'Initial release', $owner);
        $this->assertNotNull($first);
        $this->assertSame(1, $first['version']);
        $this->assertSame('published', $first['app']['status']);
        $this->assertSame(1, $first['app']['publishedVersion']);
        $this->assertNotNull($first['app']['publishedAt']);

        $second = self::$apps->publishApp($app['id']);
        $this->assertSame(2, $second['version']);
        $this->assertSame(2, $second['app']['publishedVersion']);

        $versions = self::$apps->listAppVersions($app['id']);
        $this->assertCount(2, $versions);
        // Newest first, camelCase keys, label + publisher carried on the first row.
        $this->assertSame(2, $versions[0]['version']);
        $this->assertNull($versions[0]['label']);
        $this->assertSame(1, $versions[1]['version']);
        $this->assertSame('Initial release', $versions[1]['label']);
        $this->assertSame($owner, $versions[1]['publishedBy']);
    }

    public function testLabelIsTrimmedAndCapped(): void
    {
        $owner = $this->makeUser();
        $app = $this->makeApp($owner);

        self::$apps->publishApp($app['id'], '  ' . str_repeat('x', 200) . '  ', $owner);
        $versions = self::$apps->listAppVersions($app['id']);
        $this->assertSame(160, mb_strlen($versions[0]['label']));

        // A whitespace-only label stores as null, not ''.
        self::$apps->publishApp($app['id'], '   ', $owner);
        $versions = self::$apps->listAppVersions($app['id']);
        $this->assertNull($versions[0]['label']);
    }

    public function testUnpublishKeepsVersionCounter(): void
    {
        $owner = $this->makeUser();
        $app = $this->makeApp($owner);

        self::$apps->publishApp($app['id'], null, $owner);
        self::$apps->updateApp($app['id'], ['status' => 'draft']);

        $reread = self::$apps->getApp($app['id']);
        $this->assertSame('draft', $reread['status']);
        // The version pointer survives an unpublish — republishing continues at 2.
        $this->assertSame(1, $reread['publishedVersion']);

        $again = self::$apps->publishApp($app['id'], null, $owner);
        $this->assertSame(2, $again['version']);
    }

    public function testControllerOwnerPublishesNonOwnerGets404(): void
    {
        $owner = $this->makeUser();
        $stranger = $this->makeUser();
        $app = $this->makeApp($owner);

        $denied = $this->callPublish($stranger, $app['id'], ['label' => 'nope']);
        $this->assertSame(404, $denied['status']);
        $this->assertSame([], self::$apps->listAppVersions($app['id']));

        $missing = $this->callPublish($owner, 'app-does-not-exist');
        $this->assertSame(404, $missing['status']);

        $ok = $this->callPublish($owner, $app['id'], ['label' => 'v1 go-live']);
        $this->assertSame(200, $ok['status']);
        $this->assertSame(1, $ok['body']['version']);
        $this->assertSame('published', $ok['body']['app']['status']);
        $this->assertSame(1, $ok['body']['app']['publishedVersion']);

        $history = $this->callVersions($owner, $app['id']);
        $this->assertSame(200, $history['status']);
        $this->assertCount(1, $history['body']['versions']);
        $this->assertSame('v1 go-live', $history['body']['versions'][0]['label']);
    }
}

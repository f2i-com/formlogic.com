<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\FormService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * A no-op `customScreen` replay must NEVER elevate custom-screen trust.
 *
 * AppService::updateApp stamps `custom_screen_trust = 'owner'` on the rule "the owner
 * authored this screen". But the key rides along in any whole-app PUT — the App
 * Settings page used to send its entire mount-time snapshot — so simply renaming an
 * app promoted an IMPORTED pack screen from 'untrusted' to 'owner', handing unreviewed
 * third-party code the full record/connector SDK (sdkRuntime's TRUSTED_ONLY actions).
 *
 * The rule is now: re-stamp only when the screen BODY actually changes.
 */
class AppScreenTrustReplayTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static AppService $apps;

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
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/formlogic-trustreplay-' . bin2hex(random_bytes(4)));
        self::$apps = new AppService($conn, new FormService($conn, $sqlite));
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
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
        $ids = self::$pdo->prepare('SELECT id FROM apps WHERE owner_id = ?');
        $ids->execute([$this->userId]);
        foreach ($ids->fetchAll(PDO::FETCH_COLUMN) as $aid) {
            self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$aid]);
        }
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
    }

    /** @return array{0:string,1:array<string,mixed>} trust level + provenance */
    private function trustOf(string $appId): array
    {
        $stmt = self::$pdo->prepare('SELECT custom_screen_trust, custom_screen_provenance FROM apps WHERE id = ?');
        $stmt->execute([$appId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC) ?: [];
        return [
            (string) ($row['custom_screen_trust'] ?? ''),
            json_decode((string) ($row['custom_screen_provenance'] ?? 'null'), true) ?? [],
        ];
    }

    private function makeAppWithImportedScreen(): string
    {
        $app = self::$apps->createApp([
            'name' => 'Trust replay ' . bin2hex(random_bytes(3)),
            'slug' => 'trust-' . bin2hex(random_bytes(5)),
        ], $this->userId);
        $appId = (string) $app['id'];
        // Simulate a pack import: a screen the owner never wrote, quarantined as
        // visual-only by the import boundary.
        self::$pdo->prepare('UPDATE apps SET custom_screen = ? WHERE id = ?')
            ->execute([json_encode(['enabled' => true, 'kind' => 'code', 'html' => '<p>vendor</p>']), $appId]);
        self::$apps->setCustomScreenTrust($appId, 'untrusted', ['source' => 'pack', 'packId' => 'vendor.pack']);
        return $appId;
    }

    public function testReplayingAnUnchangedImportedScreenDoesNotPromoteItToOwnerTrust(): void
    {
        $appId = $this->makeAppWithImportedScreen();
        [$before] = $this->trustOf($appId);
        $this->assertSame('untrusted', $before);

        // Exactly what a whole-app PUT did: read the app, change something unrelated,
        // and send the screen straight back.
        $current = self::$apps->getApp($appId);
        self::$apps->updateApp($appId, [
            'name' => 'Renamed app',
            'customScreen' => $current['customScreen'],
        ]);

        [$after, $provenance] = $this->trustOf($appId);
        $this->assertSame('untrusted', $after, 'Renaming an app must not elevate an imported screen to owner trust');
        $this->assertSame('pack', $provenance['source'] ?? null);
    }

    public function testStrippedTrustMarkersOnTheWayBackInStillCountAsUnchanged(): void
    {
        $appId = $this->makeAppWithImportedScreen();
        // App::toArray stamps _trust/_provenance into the screen it hands the client,
        // so the round trip returns a body with extra keys. That must not read as an edit.
        $current = self::$apps->getApp($appId);
        $screen = $current['customScreen'];
        $screen['_trust'] = 'untrusted';
        $screen['_provenance'] = ['source' => 'pack'];

        self::$apps->updateApp($appId, ['customScreen' => $screen]);

        [$after] = $this->trustOf($appId);
        $this->assertSame('untrusted', $after);
    }

    public function testGenuinelyEditingTheScreenStillStampsOwnerTrust(): void
    {
        $appId = $this->makeAppWithImportedScreen();

        self::$apps->updateApp($appId, [
            'customScreen' => ['enabled' => true, 'kind' => 'code', 'html' => '<p>the owner wrote this</p>'],
        ]);

        [$after, $provenance] = $this->trustOf($appId);
        $this->assertSame('owner', $after, 'A real screen edit by the owner is owner-authored');
        $this->assertSame('owner', $provenance['source'] ?? null);
    }

    public function testClearingTheScreenIsAChangeAndResetsProvenance(): void
    {
        $appId = $this->makeAppWithImportedScreen();

        self::$apps->updateApp($appId, ['customScreen' => null]);

        $stmt = self::$pdo->prepare('SELECT custom_screen, custom_screen_trust FROM apps WHERE id = ?');
        $stmt->execute([$appId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC) ?: [];
        // `?? 'sentinel'` can never observe a genuine NULL — it treats null as absent.
        $this->assertTrue(array_key_exists('custom_screen', $row));
        $this->assertNull($row['custom_screen']);
        $this->assertSame('owner', (string) ($row['custom_screen_trust'] ?? ''));
    }
}

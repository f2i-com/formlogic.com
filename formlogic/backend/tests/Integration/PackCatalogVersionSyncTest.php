<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\PackCatalogService;
use PDO;
use PHPUnit\Framework\TestCase;

final class PackCatalogVersionSyncTest extends TestCase
{
    private static ?PDO $pdo = null;
    private static ?PackCatalogService $catalog = null;
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
        self::$pdo = $mysql->getConnection();
        self::$catalog = new PackCatalogService($mysql);
    }

    protected function setUp(): void
    {
        if (self::$pdo === null || self::$catalog === null) {
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
        self::$pdo->prepare('DELETE FROM pack_catalog WHERE publisher_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
    }

    public function testSameVersionRefreshesInPlaceAndChangedVersionPublishesNewRow(): void
    {
        $v100 = $this->pack('1.0.0', 'first', 1);
        $published = self::$catalog->publishPack($v100, $this->userId, [
            'slug' => 'version-sync-' . bin2hex(random_bytes(4)),
            'name' => 'Version sync test',
            'version' => '1.0.0',
        ]);
        $catalogId = $published['catalogId'];
        $initialVersionId = $published['versionId'];

        $refreshed = self::$catalog->syncPublishedPackVersion(
            $catalogId,
            $this->pack('1.0.0', 'rebuilt', 2),
            $this->userId
        );
        $this->assertSame('refreshed', $refreshed['action']);
        $this->assertSame($initialVersionId, $refreshed['versionId']);
        $this->assertSame(1, $this->versionCount($catalogId));
        $stored100 = self::$catalog->getPackVersion($catalogId, $initialVersionId);
        $this->assertSame('1.0.0', $stored100['version']);
        $this->assertSame('rebuilt', $stored100['pack_data']['packMeta']['description']);
        $this->assertSame(2, (int) $stored100['form_count']);

        $new = self::$catalog->syncPublishedPackVersion(
            $catalogId,
            $this->pack('1.0.1', 'new version', 3),
            $this->userId,
            'New emitted version'
        );
        $this->assertSame('published', $new['action']);
        $this->assertSame('1.0.1', $new['version']);
        $this->assertNotSame($initialVersionId, $new['versionId']);
        $this->assertSame(2, $this->versionCount($catalogId));
        $stored101 = self::$catalog->getPackVersion($catalogId, $new['versionId']);
        $this->assertSame('1.0.1', $stored101['version']);
        $this->assertSame('1.0.1', $stored101['pack_data']['packMeta']['version']);
        $this->assertSame('new version', $stored101['pack_data']['packMeta']['description']);

        $again = self::$catalog->syncPublishedPackVersion(
            $catalogId,
            $this->pack('1.0.1', 'rebuilt new version', 1),
            $this->userId
        );
        $this->assertSame('refreshed', $again['action']);
        $this->assertSame($new['versionId'], $again['versionId']);
        $this->assertSame(2, $this->versionCount($catalogId));
    }

    /** @return array<string,mixed> */
    private function pack(string $version, string $description, int $formCount): array
    {
        $forms = [];
        for ($i = 0; $i < $formCount; $i++) {
            $forms[] = [
                'packFormId' => 'form-' . $i,
                'title' => 'Form ' . $i,
                'fields' => [],
            ];
        }
        return [
            'formatVersion' => 1,
            'packMeta' => [
                'id' => 'version-sync',
                'name' => 'Version sync',
                'version' => $version,
                'description' => $description,
            ],
            'forms' => $forms,
            'apps' => [],
        ];
    }

    private function versionCount(string $catalogId): int
    {
        $stmt = self::$pdo->prepare('SELECT COUNT(*) FROM pack_versions WHERE catalog_id = ?');
        $stmt->execute([$catalogId]);
        return (int) $stmt->fetchColumn();
    }
}

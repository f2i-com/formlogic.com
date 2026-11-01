<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\FlowKvService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * A flow keys by short codes and tokens, and flow_kv.k used to ignore case, so voucher:AB12 and
 * voucher:ab12 were one entry and the second customer's write replaced the first's with no error.
 */
final class FlowKvKeyCaseTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private string $userId = '';

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
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->userId = 'u' . bin2hex(random_bytes(10));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$this->userId, $this->userId . '@test.local']);
    }

    protected function tearDown(): void
    {
        self::$pdo?->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
    }

    private function collation(): string
    {
        return (string) self::$pdo->query("SHOW FULL COLUMNS FROM flow_kv LIKE 'k'")->fetch(PDO::FETCH_ASSOC)['Collation'];
    }

    public function testKeysThatDifferOnlyByCaseAreTwoEntries(): void
    {
        $kv = new FlowKvService(self::$mysql);

        $kv->put($this->userId, null, 'app', 'voucher:AB12', 'first customer');
        $kv->put($this->userId, null, 'app', 'voucher:ab12', 'second customer');
        $kv->put($this->userId, null, 'app', 'Voucher:Ab12', 'third customer');

        self::assertCount(3, $kv->list($this->userId, null, 'app'));
        self::assertSame('first customer', $kv->get($this->userId, null, 'app', 'voucher:AB12')['v']);
        self::assertSame('second customer', $kv->get($this->userId, null, 'app', 'voucher:ab12')['v']);
        self::assertTrue($kv->delete($this->userId, null, 'app', 'voucher:ab12'));
        self::assertNull($kv->get($this->userId, null, 'app', 'voucher:ab12'));
        self::assertNotNull($kv->get($this->userId, null, 'app', 'voucher:AB12'));
    }

    public function testASiteWithTheOldColumnIsMovedAcrossWithItsRowsAndARerunChangesNothing(): void
    {
        self::$pdo->exec('ALTER TABLE flow_kv MODIFY COLUMN k VARCHAR(190) COLLATE utf8mb4_unicode_ci NOT NULL');
        try {
            self::assertSame('utf8mb4_unicode_ci', $this->collation());
            $kv = new FlowKvService(self::$mysql);
            $kv->put($this->userId, null, 'app', 'voucher:AB12', 'kept');
            $kv->put($this->userId, null, 'app', 'voucher:CD34', 'kept too');

            self::$mysql->runMigrations();
            self::assertSame('utf8mb4_bin', $this->collation());
            self::$mysql->runMigrations();
            self::assertSame('utf8mb4_bin', $this->collation());

            self::assertSame('kept', $kv->get($this->userId, null, 'app', 'voucher:AB12')['v']);
            self::assertSame('kept too', $kv->get($this->userId, null, 'app', 'voucher:CD34')['v']);
            $kv->put($this->userId, null, 'app', 'voucher:ab12', 'now apart');
            self::assertSame('kept', $kv->get($this->userId, null, 'app', 'voucher:AB12')['v']);
        } finally {
            self::$pdo->exec('ALTER TABLE flow_kv MODIFY COLUMN k VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL');
        }
    }
}

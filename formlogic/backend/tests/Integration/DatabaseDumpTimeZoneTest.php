<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\MaintenanceService;
use FormLogic\Services\UpgradeService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * The whole-site dump holds UTC, and RESTORE.txt tells an operator to load it through the mysql
 * client, in a session in the server's own zone. So the dump has to say which zone it is in, as
 * mysqldump's does. Here it is loaded the way that command does, statement by statement, in a
 * session in Sydney: a time in the hour Sydney skips stopped such a load, and every other
 * TIMESTAMP came back moved.
 *
 * Skipped unless a test database is reachable.
 */
class DatabaseDumpTimeZoneTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static array $config = [];
    private string $tmp = '';
    private string $scratchDb = '';
    private string $userId = '';

    public static function setUpBeforeClass(): void
    {
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) {
            \Dotenv\Dotenv::createImmutable($root)->safeLoad();
        }
        self::$config = [
            'host' => $_ENV['DB_HOST'] ?? '127.0.0.1',
            'port' => $_ENV['DB_PORT'] ?? '3306',
            'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
            'username' => $_ENV['DB_USERNAME'] ?? 'root',
            'password' => $_ENV['DB_PASSWORD'] ?? '',
            'charset' => 'utf8mb4',
            'collation' => 'utf8mb4_unicode_ci',
        ];
        try {
            $conn = new MySQLConnection(self::$config);
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
        $this->tmp = sys_get_temp_dir() . '/fl-dumpzone-' . bin2hex(random_bytes(5));
        mkdir($this->tmp, 0777, true);
        $this->scratchDb = self::$config['database'] . '_load_' . bin2hex(random_bytes(3));
        $this->userId = 'dump-zone-' . bin2hex(random_bytes(6));
    }

    protected function tearDown(): void
    {
        self::$pdo?->exec("DROP DATABASE IF EXISTS `{$this->scratchDb}`");
        self::$pdo?->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
        foreach (glob($this->tmp . '/*') ?: [] as $file) {
            @unlink($file);
        }
        @rmdir($this->tmp);
    }

    public function testADumpLoadedInAnotherZoneKeepsEveryMoment(): void
    {
        // 02:30 on 4 October 2026 is an hour Sydney's clocks skip.
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, created_at, updated_at) VALUES (?, ?, 'x', 'Zone', '2026-10-04 02:30:00', '2026-07-01 09:00:00')")
            ->execute([$this->userId, $this->userId . '@example.com']);

        $upgrade = new UpgradeService($this->tmp . '/nowhere', self::$mysql, new MaintenanceService($this->tmp . '/maintenance.json'));
        $upgrade->dumpDatabase($this->tmp . '/database.sql.gz');

        self::$pdo->exec("CREATE DATABASE `{$this->scratchDb}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
        $dsn = sprintf('mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4', self::$config['host'], self::$config['port'], $this->scratchDb);
        $load = new PDO($dsn, self::$config['username'], self::$config['password'], [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        try {
            $load->exec("SET time_zone = 'Australia/Sydney'");
        } catch (\PDOException) {
            $load->exec("SET time_zone = '+11:00'"); // a server with no zone tables: the move still shows
        }
        foreach (explode("\n", (string) gzdecode((string) file_get_contents($this->tmp . '/database.sql.gz'))) as $line) {
            if ($line !== '' && !str_starts_with($line, '--')) {
                $load->exec($line);
            }
        }

        $load->exec("SET time_zone = '+00:00'");
        $row = $load->query("SELECT created_at, updated_at FROM users WHERE id = " . $load->quote($this->userId))->fetch(PDO::FETCH_ASSOC);
        $this->assertSame(['created_at' => '2026-10-04 02:30:00', 'updated_at' => '2026-07-01 09:00:00'], $row);
    }

    public function testTheZoneComesBeforeAnyRow(): void
    {
        $upgrade = new UpgradeService($this->tmp . '/nowhere', self::$mysql, new MaintenanceService($this->tmp . '/maintenance.json'));
        $upgrade->dumpDatabase($this->tmp . '/database.sql.gz');
        $dump = (string) gzdecode((string) file_get_contents($this->tmp . '/database.sql.gz'));
        $zone = strpos($dump, "SET time_zone = '+00:00';\n");
        $this->assertNotFalse($zone);
        $this->assertLessThan(strpos($dump, 'INSERT INTO'), $zone);
    }
}

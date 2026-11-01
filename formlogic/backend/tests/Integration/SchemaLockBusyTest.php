<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * A migration that outlasts the 15 s a request waits for it. That was an unexplained 500, and every
 * site runs a full migration on its first request of v0.1.21. This takes those 15 s, holding a lock
 * that is the whole MySQL server's, so a suite run beside it on another database can feel it.
 */
final class SchemaLockBusyTest extends TestCase
{
    /** @var array<string, string> */
    private static array $config = [];
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $holder = null;

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
            self::$mysql = new MySQLConnection(self::$config);
            self::$mysql->ensureSchemaCurrent();
            self::$holder = new PDO(
                sprintf('mysql:host=%s;port=%s;dbname=%s', self::$config['host'], self::$config['port'], self::$config['database']),
                self::$config['username'],
                self::$config['password'],
                [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
            );
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
    }

    protected function setUp(): void
    {
        // This connection's stale stamp makes a request try to migrate, and the other holds the lock.
        self::$mysql->getConnection()->prepare('DELETE FROM schema_meta WHERE meta_key = ?')->execute([MySQLConnection::SCHEMA_STAMP_KEY]);
        self::assertSame(1, (int) self::$holder->query("SELECT GET_LOCK('formlogic_schema_migration', 5)")->fetchColumn());
    }

    protected function tearDown(): void
    {
        self::$holder->query("SELECT RELEASE_LOCK('formlogic_schema_migration')");
        self::$mysql->ensureSchemaCurrent();
    }

    /** The real entry point, so that the container doesn't get to turn it into something else. */
    public function testARequestIsToldToTryAgain(): void
    {
        $backend = dirname(__DIR__, 2);
        $environment = array_merge(array_filter(getenv(), 'is_string'), [
            'APP_ENV' => 'development',
            'DB_HOST' => self::$config['host'],
            'DB_PORT' => self::$config['port'],
            'DB_DATABASE' => self::$config['database'],
            'DB_USERNAME' => self::$config['username'],
            'DB_PASSWORD' => self::$config['password'],
            'REQUEST_URI' => '/api/health',
            'REQUEST_METHOD' => 'GET',
            'HTTP_HOST' => 'localhost',
            'SCRIPT_NAME' => '/api/index.php',
        ]);
        $process = proc_open(
            [PHP_BINARY, '-d', 'variables_order=EGPCS', '-d', 'display_errors=0', '-d', 'log_errors=0', $backend . '/public/index.php'],
            [1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
            $pipes,
            $backend,
            $environment
        );
        self::assertIsResource($process);
        $output = (string) stream_get_contents($pipes[1]);
        stream_get_contents($pipes[2]);
        proc_close($process);

        $answer = json_decode($output, true);
        self::assertIsArray($answer, $output);
        self::assertSame('migration_in_progress', $answer['code'], $output);
        self::assertTrue($answer['retryable']);
    }
}

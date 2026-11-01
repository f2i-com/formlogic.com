<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\FormService;
use FormLogic\Services\WebhookService;
use PDO;
use PHPUnit\Framework\TestCase;

/** The retry worker, when a worker before it died or its database went away. */
final class WebhookWorkerTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    /** @var array<string, string> */
    private static array $config = [];

    private string $userId = '';
    private string $formId = '';
    private string $webhookId = '';

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
        $this->userId = 'u' . bin2hex(random_bytes(10));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$this->userId, $this->userId . '@test.local']);
        $forms = new FormService(self::$mysql, new SQLiteConnection(sys_get_temp_dir() . '/fl-webhook-worker-' . bin2hex(random_bytes(5))));
        $this->formId = (string) $forms->createForm(['title' => 'Hooks', 'userId' => $this->userId])['id'];
        $this->webhookId = 'wh' . bin2hex(random_bytes(10));
        self::$pdo->prepare("INSERT INTO webhooks (id, form_id, user_id, url, secret, events) VALUES (?, ?, ?, 'https://hooks.example/x', 's', '[\"response.created\"]')")
            ->execute([$this->webhookId, $this->formId, $this->userId]);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        self::$pdo->prepare('DELETE FROM forms WHERE id = ?')->execute([$this->formId]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
    }

    private function delivery(string $status, int $attempt, string $nextRetry): string
    {
        $id = 'd' . bin2hex(random_bytes(10));
        self::$pdo->prepare("INSERT INTO webhook_deliveries (id, webhook_id, event, payload, attempt, next_retry_at, status) VALUES (?, ?, 'response.created', '{\"answers\":{\"a\":\"private\"}}', ?, {$nextRetry}, ?)")
            ->execute([$id, $this->webhookId, $attempt, $status]);
        return $id;
    }

    private function row(string $id): array
    {
        $stmt = self::$pdo->prepare('SELECT status, payload, next_retry_at, success FROM webhook_deliveries WHERE id = ?');
        $stmt->execute([$id]);
        return $stmt->fetch(PDO::FETCH_ASSOC);
    }

    public function testADeliveryWhoseWorkerDiedOnTheLastAttemptIsFinished(): void
    {
        $id = $this->delivery('retrying', 5, 'DATE_SUB(NOW(), INTERVAL 1 MINUTE)');

        $result = (new WebhookService(self::$mysql))->processPendingRetries();

        $row = $this->row($id);
        self::assertSame('exhausted', $row['status']);
        self::assertNull($row['payload'], 'its copy of the answers goes, as it does for any finished delivery');
        self::assertNull($row['next_retry_at']);
        self::assertSame(1, $result['abandoned']);
    }

    public function testALastAttemptStillInProgressIsLeftAlone(): void
    {
        $id = $this->delivery('retrying', 5, 'DATE_ADD(NOW(), INTERVAL 5 MINUTE)');

        (new WebhookService(self::$mysql))->processPendingRetries();

        self::assertSame('retrying', $this->row($id)['status']);
    }

    /** A worker on its loop, past the point where it could find another holding the lock. @return array{0: resource, 1: array<int, resource>} */
    private function startLoop(): array
    {
        $env = [
            'DB_HOST' => self::$config['host'], 'DB_PORT' => self::$config['port'], 'DB_DATABASE' => self::$config['database'],
            'DB_USERNAME' => self::$config['username'], 'DB_PASSWORD' => self::$config['password'],
            'SystemRoot' => (string) getenv('SystemRoot'), 'PATH' => (string) getenv('PATH'), 'APP_ENV' => 'development',
        ];
        $pipes = [];
        $worker = dirname(__DIR__, 2) . '/bin/webhook-worker.php';
        // To a file, not a pipe: on Windows a read of an empty pipe waits for the worker to end.
        $this->errorLog = (string) tempnam(sys_get_temp_dir(), 'fl-worker-');
        $process = proc_open(
            [PHP_BINARY, '-d', 'variables_order=EGPCS', '-d', 'xdebug.mode=off', $worker, '--loop', '--interval=1'],
            [1 => ['pipe', 'w'], 2 => ['file', $this->errorLog, 'a']],
            $pipes,
            null,
            $env
        );
        self::assertIsResource($process);

        // Another test run's worker would hold the lock, and this one would stop straight away.
        usleep(1200000);
        $status = proc_get_status($process);
        if (!$status['running']) {
            $out = (string) file_get_contents($this->errorLog);
            proc_close($process);
            self::markTestSkipped('A worker is already running here: ' . $out);
        }
        return [$process, $pipes];
    }

    private string $errorLog = '';

    private function errors(): string
    {
        return (string) file_get_contents($this->errorLog);
    }

    /** @param resource $process */
    private function waitForExit($process, float $seconds): array
    {
        $deadline = microtime(true) + $seconds;
        do {
            usleep(100000);
            $status = proc_get_status($process);
        } while ($status['running'] && microtime(true) < $deadline);
        return $status;
    }

    /**
     * Not a deadlock, which can't be had to order from another process without changing the
     * server's settings for everyone on it, but the same path: a pass that fails on the database
     * with a connection that's still good. SqlErrorGuardMiddlewareTest holds busy and lost apart.
     */
    public function testAPassThatFailsDoesNotEndTheLoopAndThreeInARowDo(): void
    {
        [$process, $pipes] = $this->startLoop();
        try {
            self::$pdo->exec('RENAME TABLE webhook_deliveries TO webhook_deliveries_away');
            $deadline = microtime(true) + 5;
            while (substr_count($this->errors(), 'database error') < 1 && microtime(true) < $deadline) {
                usleep(50000);
            }
            self::assertSame(1, substr_count($this->errors(), 'database error'), $this->errors());
            self::$pdo->exec('RENAME TABLE webhook_deliveries_away TO webhook_deliveries');

            // It carries on, and a pass that works starts the count again.
            $status = $this->waitForExit($process, 2.5);
            self::assertTrue($status['running'], $this->errors());
            self::assertSame(1, substr_count($this->errors(), 'database error'), 'nothing is wrong any more');

            self::$pdo->exec('RENAME TABLE webhook_deliveries TO webhook_deliveries_away');
            $status = $this->waitForExit($process, 8);
            self::assertFalse($status['running'], 'three in a row: something else has to look at this');
            self::assertSame(1, $status['exitcode'], $this->errors());
            self::assertSame(4, substr_count($this->errors(), 'database error'), $this->errors());
        } finally {
            $tables = self::$pdo->query("SHOW TABLES LIKE 'webhook_deliveries_away'")->fetchAll();
            if ($tables !== []) {
                self::$pdo->exec('RENAME TABLE webhook_deliveries_away TO webhook_deliveries');
            }
            if (proc_get_status($process)['running']) {
                proc_terminate($process);
            }
            fclose($pipes[1]);
            proc_close($process);
            @unlink($this->errorLog);
        }
    }

    public function testTheLoopExitsNonZeroWhenItsConnectionIsLost(): void
    {
        [$process, $pipes] = $this->startLoop();

        // What a MySQL restart does to it.
        $victims = self::$pdo->prepare('SELECT ID FROM information_schema.PROCESSLIST WHERE DB = ? AND ID <> CONNECTION_ID()');
        $victims->execute([self::$config['database']]);
        foreach ($victims->fetchAll(PDO::FETCH_COLUMN) as $victim) {
            self::$pdo->exec('KILL ' . (int) $victim);
        }

        $status = $this->waitForExit($process, 8);

        $stillRunning = $status['running'];
        if ($stillRunning) {
            proc_terminate($process);
        }
        $err = $this->errors();
        fclose($pipes[1]);
        proc_close($process);
        @unlink($this->errorLog);

        self::assertFalse($stillRunning, 'it stops, so that a supervisor or cron can start one that works');
        self::assertSame(1, $status['exitcode'], $err);
        self::assertSame(1, substr_count($err, 'database error'), 'at the first failure, not the third: ' . $err);
    }
}

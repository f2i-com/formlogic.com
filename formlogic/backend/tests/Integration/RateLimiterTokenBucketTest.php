<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\RateLimiter;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * The token bucket (RateLimiter::take), against MySQL: a burst is taken at once, then calls are
 * slowed to the sustained rate, each refusal saying how long until the next token. An app's page
 * that went over its 120 calls a minute was refused everything, a save included, until the minute
 * ended; it is now slowed to two calls a second.
 */
final class RateLimiterTokenBucketTest extends TestCase
{
    private static ?PDO $pdo = null;
    private static array $config = [];
    private RateLimiter $limiter;
    private string $key = '';

    public static function setUpBeforeClass(): void
    {
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) \Dotenv\Dotenv::createImmutable($root)->safeLoad();
        self::$config = [
            'host' => $_ENV['DB_HOST'] ?? '127.0.0.1', 'port' => $_ENV['DB_PORT'] ?? '3306', 'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
            'username' => $_ENV['DB_USERNAME'] ?? 'root', 'password' => $_ENV['DB_PASSWORD'] ?? '', 'charset' => 'utf8mb4', 'collation' => 'utf8mb4_unicode_ci',
        ];
        try {
            $conn = new MySQLConnection(self::$config);
            $conn->getConnection()->query('SELECT 1');
            $conn->initializeSchema();
            $conn->runMigrations();
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
        self::$pdo = $conn->getConnection();
    }

    protected function setUp(): void
    {
        if (self::$pdo === null) $this->markTestSkipped('No test database');
        $this->limiter = new RateLimiter(self::$pdo);
        $this->key = 'bucket-test:' . bin2hex(random_bytes(8));
    }

    protected function tearDown(): void
    {
        if (self::$pdo !== null && $this->key !== '') $this->limiter->clear($this->key);
    }

    /**
     * A whole second an hour from now, for a test's own clock: steps of half a second from it are
     * exact, and the limiter's clean-up (which forgets buckets idle for a day) never takes it for one.
     */
    private static function moment(): float
    {
        return (float) (time() + 3600);
    }

    /** How many of $calls, made at the moments given, were taken. */
    private function taken(int $capacity, int $perSeconds, array $moments): int
    {
        $count = 0;
        foreach ($moments as $moment) {
            if ($this->limiter->take($this->key, $capacity, $perSeconds, $moment)['allowed']) $count++;
        }
        return $count;
    }

    public function testABurstIsTakenAtOnceThenCallsAreSlowedNotLockedOut(): void
    {
        $start = self::moment();
        // Ten at once, refilled at ten every ten seconds: one a second.
        for ($call = 1; $call <= 10; $call++) {
            $taken = $this->limiter->take($this->key, 10, 10, $start);
            $this->assertSame([true, 0, 10 - $call], [$taken['allowed'], $taken['retryAfter'], $taken['remaining']], "call {$call} of the burst");
        }
        $refused = $this->limiter->take($this->key, 10, 10, $start);
        $this->assertSame(['allowed' => false, 'retryAfter' => 1, 'remaining' => 0], $refused, 'the next token is a second away, not the rest of the window');
        // Asking again while refused takes nothing and costs nothing: the wait does not grow.
        for ($again = 0; $again < 50; $again++) $this->limiter->take($this->key, 10, 10, $start + 0.2);
        $this->assertSame(1, $this->limiter->take($this->key, 10, 10, $start + 0.5)['retryAfter']);
        // A second on, one more is taken, and only one.
        $this->assertTrue($this->limiter->take($this->key, 10, 10, $start + 1.0)['allowed']);
        $this->assertFalse($this->limiter->take($this->key, 10, 10, $start + 1.0)['allowed']);
        // From then on a caller keeping to the sustained rate is never refused.
        $steady = array_map(static fn(int $second): float => $start + 2.0 + $second, range(0, 59));
        $this->assertSame(60, $this->taken(10, 10, $steady));
        // One asking twice as fast is given the sustained rate, spread evenly: every other call.
        $fast = array_map(static fn(int $half): float => $start + 62.0 + $half * 0.5, range(0, 59));
        $this->assertSame(30, $this->taken(10, 10, $fast));
    }

    public function testAnIdleBucketFillsAgainAndNoFurther(): void
    {
        $start = self::moment();
        $this->assertSame(10, $this->taken(10, 10, array_fill(0, 15, $start)), 'a burst of fifteen: ten are taken');
        // Half the time to fill: half the tokens are back.
        $this->assertSame(5, $this->taken(10, 10, array_fill(0, 15, $start + 5.0)));
        // Idle for an hour: a full bucket, not an hour's worth.
        $this->assertSame(10, $this->taken(10, 10, array_fill(0, 40, $start + 3600.0)));
    }

    /** An app's page and backend calls: 120 at once, refilled at 120 a minute (public/index.php, $nativeLimiter). */
    public function testTheNativeLimitKeepsItsSustainedRate(): void
    {
        $start = self::moment();
        $this->assertSame(120, $this->taken(120, 60, array_fill(0, 150, $start)), 'the burst a busy page makes');
        $refused = $this->limiter->take($this->key, 120, 60, $start);
        $this->assertSame([false, 1], [$refused['allowed'], $refused['retryAfter']], 'half a second to the next call, said as a whole second');
        $this->assertTrue($this->limiter->take($this->key, 120, 60, $start + 0.5)['allowed'], 'slowed to two calls a second');
        // Hammering for the next minute: 120 more, the same sustained rate the fixed minute allowed,
        // where the fixed minute refused every one of them until it ended.
        $hammer = array_map(static fn(int $tick): float => $start + 1.0 + $tick * 0.1, range(0, 599));
        $this->assertSame(120, $this->taken(120, 60, $hammer));
    }

    public function testEachKeyHasItsOwnBucket(): void
    {
        $other = $this->key . ':other';
        try {
            $start = self::moment();
            $this->assertSame(3, $this->taken(3, 60, array_fill(0, 5, $start)));
            $this->assertTrue($this->limiter->take($other, 3, 60, $start)['allowed'], 'another member, or the same member in another app');
            // Forgetting a key empties its bucket's debt.
            $this->limiter->clear($this->key);
            $this->assertTrue($this->limiter->take($this->key, 3, 60, $start)['allowed']);
        } finally {
            $this->limiter->clear($other);
        }
    }

    /** Calls at the same moment from many PHP workers: the last token is given once. */
    public function testWorkersAtOnceTakeNoMoreThanTheBucketHolds(): void
    {
        if (!function_exists('proc_open')) $this->markTestSkipped('Needs proc_open');
        $workers = 14;
        $capacity = 5;
        $at = microtime(true) + 2.5 + $workers * 0.15;
        $script = dirname(__DIR__) . '/Support/bucket-race.php';
        $file = sys_get_temp_dir() . '/formlogic-bucket-race-' . bin2hex(random_bytes(4)) . '.json';
        // Refilled over an hour: no token comes back while the race runs.
        file_put_contents($file, json_encode(['db' => self::$config, 'key' => $this->key, 'capacity' => $capacity, 'perSeconds' => 3600, 'at' => $at]));
        try {
            $running = [];
            for ($worker = 0; $worker < $workers; $worker++) {
                $process = proc_open([PHP_BINARY, '-d', 'xdebug.mode=off', $script, $file], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
                $this->assertIsResource($process);
                $running[] = [$process, $pipes];
            }
            $allowed = 0;
            $refused = 0;
            foreach ($running as [$process, $pipes]) {
                $out = json_decode((string) stream_get_contents($pipes[1]), true);
                $problem = (string) stream_get_contents($pipes[2]);
                fclose($pipes[1]);
                fclose($pipes[2]);
                proc_close($process);
                $this->assertIsArray($out, $problem);
                $out['allowed'] ? $allowed++ : $refused++;
                if (!$out['allowed']) $this->assertGreaterThanOrEqual(1, $out['retryAfter']);
            }
            $this->assertSame([$capacity, $workers - $capacity], [$allowed, $refused]);
        } finally {
            @unlink($file);
        }
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\Packages\InstallJobService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * DESK-502: jobs survive a disconnect, reject replay and cross-device use, and resume
 * idempotently. Each of those is what stops a half-finished install from becoming two
 * installs, or someone else's install.
 */
class InstallJobTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static InstallJobService $jobs;

    private string $userId = '';
    private string $otherUserId = '';

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
        self::$jobs = new InstallJobService($conn);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        foreach (['userId', 'otherUserId'] as $prop) {
            $this->$prop = 'u-' . bin2hex(random_bytes(12));
            self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
                ->execute([$this->$prop, $this->$prop . '@test.local']);
        }
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        foreach ([$this->userId, $this->otherUserId] as $id) {
            if ($id !== '') {
                self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$id]);
            }
        }
    }

    public function testTheHappyPathIsClaimProgressComplete(): void
    {
        $job = self::$jobs->enqueue($this->userId, 'distribution-install', ['distributionId' => 'com.acme.svc']);
        $this->assertSame('queued', $job['state']);

        $token = self::$jobs->claim($job['id'], $this->userId, 'device-1');
        $this->assertNotNull($token);
        $this->assertSame('running', self::$jobs->get($job['id'], $this->userId)['state']);

        $this->assertTrue(self::$jobs->progress($job['id'], 'device-1', $token, 40, 'staging'));
        $mid = self::$jobs->get($job['id'], $this->userId);
        $this->assertSame(40, $mid['progress']);
        $this->assertSame('staging', $mid['step']);

        $this->assertTrue(self::$jobs->complete($job['id'], 'device-1', $token, true));
        $done = self::$jobs->get($job['id'], $this->userId);
        $this->assertSame('succeeded', $done['state']);
        $this->assertSame(100, $done['progress']);
    }

    public function testExactlyOneDeviceWinsARaceAndTheOtherIsTold(): void
    {
        $job = self::$jobs->enqueue($this->userId, 'distribution-install');

        $first = self::$jobs->claim($job['id'], $this->userId, 'device-1');
        $second = self::$jobs->claim($job['id'], $this->userId, 'device-2');

        $this->assertNotNull($first, 'the first claimant wins');
        $this->assertNull($second, 'the loser is refused, not left half-running');
        $this->assertSame('device-1', self::$jobs->get($job['id'], $this->userId)['deviceId']);
    }

    public function testAForeignDeviceOrWrongTokenCannotDriveTheJob(): void
    {
        $job = self::$jobs->enqueue($this->userId, 'distribution-install');
        $token = self::$jobs->claim($job['id'], $this->userId, 'device-1');

        // Another device, and the right device with a stale/guessed token.
        $this->assertFalse(self::$jobs->progress($job['id'], 'device-2', $token, 50, 'hijack'));
        $this->assertFalse(self::$jobs->progress($job['id'], 'device-1', str_repeat('0', 64), 50, 'hijack'));
        $this->assertFalse(self::$jobs->complete($job['id'], 'device-2', $token, true));

        $state = self::$jobs->get($job['id'], $this->userId);
        $this->assertSame('running', $state['state'], 'the real job is untouched');
        $this->assertSame(0, $state['progress']);
    }

    public function testATerminalJobNeverReopens(): void
    {
        $job = self::$jobs->enqueue($this->userId, 'distribution-install');
        $token = self::$jobs->claim($job['id'], $this->userId, 'device-1');
        $this->assertTrue(self::$jobs->complete($job['id'], 'device-1', $token, false, 'verify_failed', 'digest mismatch'));

        // Replaying the completion — this is how a once-only install becomes twice.
        $this->assertFalse(self::$jobs->complete($job['id'], 'device-1', $token, true));
        $this->assertFalse(self::$jobs->progress($job['id'], 'device-1', $token, 90, 'late'));

        $done = self::$jobs->get($job['id'], $this->userId);
        $this->assertSame('failed', $done['state'], 'a failure does not become a success on replay');
        $this->assertSame('verify_failed', $done['errorCode']);
    }

    public function testResumingIsIdempotentAndOwnerBound(): void
    {
        $job = self::$jobs->enqueue($this->userId, 'distribution-install');
        $token = self::$jobs->claim($job['id'], $this->userId, 'device-1');
        self::$jobs->progress($job['id'], 'device-1', $token, 30, 'fetching');

        // The device drops and reconnects: it gets ITS job back, at the same progress.
        $resumed = self::$jobs->resume($job['id'], $this->userId, 'device-1', $token);
        $this->assertNotNull($resumed);
        $this->assertSame(30, $resumed['progress']);
        $this->assertSame($job['id'], $resumed['id'], 'resuming never mints a second job');

        // A different device, or a wrong token, resumes nothing.
        $this->assertNull(self::$jobs->resume($job['id'], $this->userId, 'device-2', $token));
        $this->assertNull(self::$jobs->resume($job['id'], $this->userId, 'device-1', str_repeat('f', 64)));
    }

    public function testJobsAreOwnerScoped(): void
    {
        $job = self::$jobs->enqueue($this->userId, 'distribution-install');
        $this->assertNull(self::$jobs->get($job['id'], $this->otherUserId), 'a foreign job is invisible');
        $this->assertNull(self::$jobs->claim($job['id'], $this->otherUserId, 'device-x'), 'and unclaimable');
        $this->assertFalse(self::$jobs->cancel($job['id'], $this->otherUserId));
        $this->assertSame([], self::$jobs->listForOwner($this->otherUserId));
        $this->assertSame('queued', self::$jobs->get($job['id'], $this->userId)['state']);
    }

    public function testCancelStopsQueuedAndRunningWorkButNotFinishedWork(): void
    {
        $queued = self::$jobs->enqueue($this->userId, 'distribution-install');
        $this->assertTrue(self::$jobs->cancel($queued['id'], $this->userId));
        $this->assertSame('cancelled', self::$jobs->get($queued['id'], $this->userId)['state']);

        $finished = self::$jobs->enqueue($this->userId, 'distribution-install');
        $token = self::$jobs->claim($finished['id'], $this->userId, 'device-1');
        self::$jobs->complete($finished['id'], 'device-1', $token, true);
        $this->assertFalse(self::$jobs->cancel($finished['id'], $this->userId), 'a finished job stays as it finished');
        $this->assertSame('succeeded', self::$jobs->get($finished['id'], $this->userId)['state']);
    }

    public function testTheBrowserApiNeverReturnsTheDevicesClaimToken(): void
    {
        // The token is a device's proof of ownership. Handing it to a browser would let any
        // page that can read a job drive someone's install.
        $job = self::$jobs->enqueue($this->userId, 'distribution-install');
        self::$jobs->claim($job['id'], $this->userId, 'device-1');

        $controller = new \FormLogic\Controllers\PackageJobController(self::$jobs);
        $req = $this->createMock(\Psr\Http\Message\ServerRequestInterface::class);
        $req->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $this->userId : null);

        $one = json_decode((string) $controller->get($req, new \Slim\Psr7\Response(), ['id' => $job['id']])->getBody(), true);
        $this->assertArrayHasKey('state', $one['job']);
        $this->assertArrayNotHasKey('claimToken', $one['job']);

        $all = json_decode((string) $controller->list($req, new \Slim\Psr7\Response())->getBody(), true);
        foreach ($all['jobs'] as $listed) {
            $this->assertArrayNotHasKey('claimToken', $listed);
        }

        // …but the service still holds it, so the owning device can keep working.
        $this->assertNotNull(self::$jobs->get($job['id'], $this->userId)['claimToken']);
    }

    public function testAnAbandonedJobExpiresInsteadOfRunningForever(): void
    {
        $job = self::$jobs->enqueue($this->userId, 'distribution-install');
        self::$jobs->claim($job['id'], $this->userId, 'device-gone');
        // Simulate the device never coming back.
        self::$pdo->prepare('UPDATE package_install_jobs SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?')
            ->execute([$job['id']]);

        $this->assertGreaterThan(0, self::$jobs->expireStale());
        $expired = self::$jobs->get($job['id'], $this->userId);
        $this->assertSame('failed', $expired['state'], 'a UI waiting on this job resolves instead of hanging');
        $this->assertSame('job_expired', $expired['errorCode']);
    }
}

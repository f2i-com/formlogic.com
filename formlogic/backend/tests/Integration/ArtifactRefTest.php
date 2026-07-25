<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\Flows\ArtifactService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * SRV-404: the ArtifactRef subsystem.
 *
 * Asserts the four acceptance properties directly: no local paths leak, authorized reachable
 * consumers can retrieve artifacts, cross-device/expired/unauthorized access fails, and cleanup
 * is deterministic. Skipped without a test database.
 */
class ArtifactRefTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static string $root = '';

    private string $userId = '';
    private ArtifactService $artifacts;

    public static function setUpBeforeClass(): void
    {
        $base = dirname(__DIR__, 2);
        if (is_file($base . '/.env')) {
            \Dotenv\Dotenv::createImmutable($base)->safeLoad();
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
        self::$root = sys_get_temp_dir() . '/fl-artifacts-' . bin2hex(random_bytes(4));
    }

    public static function tearDownAfterClass(): void
    {
        if (self::$root !== '' && is_dir(self::$root)) {
            self::rmrf(self::$root);
        }
    }

    private static function rmrf(string $dir): void
    {
        foreach (scandir($dir) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            $path = $dir . '/' . $entry;
            is_dir($path) ? self::rmrf($path) : @unlink($path);
        }
        @rmdir($dir);
    }

    protected function setUp(): void
    {
        $this->userId = 'art-' . bin2hex(random_bytes(8));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$this->userId, $this->userId . '@example.com']);
        $this->artifacts = new ArtifactService(self::$mysql, self::$root);
    }

    protected function tearDown(): void
    {
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
    }

    // ── No local paths leak ─────────────────────────────────────────────────────────────────

    public function testTheRefCarriesNoPathUrlOrStorageKey(): void
    {
        $ref = $this->artifacts->store($this->userId, 'PNGDATA', [
            'kind' => 'image',
            'mediaType' => 'image/png',
            'filename' => 'poster.png',
        ]);

        $this->assertSame(
            ['$artifact', 'kind', 'mediaType', 'byteSize', 'locality', 'digest', 'expiresAt', 'filename'],
            array_keys($ref),
            'the wire shape is exactly the contract — no storage key, path, or URL'
        );
        $this->assertMatchesRegularExpression('/^art_[a-z0-9]{24}$/', $ref['$artifact']);
        $this->assertSame(hash('sha256', 'PNGDATA'), $ref['digest']);
        $this->assertSame(7, $ref['byteSize']);
        $this->assertSame('cloud', $ref['locality']);

        // Belt and braces: nothing in the serialized ref resembles a filesystem location, and
        // the id itself is opaque rather than derived from anything the caller supplied.
        $json = json_encode($ref);
        foreach ([self::$root, 'storage/', ':\\', 'http://', 'https://', '.bin'] as $needle) {
            $this->assertStringNotContainsString($needle, (string) $json, "the ref must not leak '$needle'");
        }
        $this->assertStringNotContainsString('poster', $ref['$artifact'], 'the id is not derived from the filename');
    }

    public function testAFilenameCannotEscapeTheArtifactDirectory(): void
    {
        $ref = $this->artifacts->store($this->userId, 'x', ['filename' => '../../../../etc/passwd']);
        $this->assertSame('passwd', $ref['filename'], 'the filename is display-only and stripped to a leaf');

        // The stored bytes landed inside the artifact root regardless of what the name claimed.
        $key = self::$pdo->query('SELECT storage_key FROM flow_artifacts ORDER BY created_at DESC LIMIT 1')->fetchColumn();
        $this->assertStringNotContainsString('..', (string) $key);
        $this->assertTrue(is_file(self::$root . '/' . $key), 'bytes are stored under the artifact root');
    }

    // ── Authorized reachable consumers can retrieve ─────────────────────────────────────────

    public function testTheOwnerCanReadCloudArtifactBytes(): void
    {
        $ref = $this->artifacts->store($this->userId, 'hello artifact', ['kind' => 'text', 'mediaType' => 'text/plain']);
        $read = $this->artifacts->read($this->userId, $ref['$artifact']);
        $this->assertTrue($read['ok']);
        $this->assertSame('hello artifact', $read['bytes']);
        $this->assertSame($ref['$artifact'], $read['ref']['$artifact']);
    }

    // ── Unauthorized / expired / cross-device access fails ──────────────────────────────────

    public function testAnotherAccountCannotResolveOrReadTheArtifact(): void
    {
        $ref = $this->artifacts->store($this->userId, 'secret bytes');

        $stranger = 'art-x-' . bin2hex(random_bytes(6));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'S')")
            ->execute([$stranger, $stranger . '@example.com']);

        $resolved = $this->artifacts->resolve($stranger, $ref['$artifact']);
        $this->assertFalse($resolved['ok']);
        // Identical to a nonexistent id: the endpoint is never an existence oracle.
        $this->assertSame('artifact_not_found', $resolved['code']);
        $missing = $this->artifacts->resolve($stranger, 'art_' . str_repeat('z', 24));
        $this->assertSame($missing['code'], $resolved['code']);

        $read = $this->artifacts->read($stranger, $ref['$artifact']);
        $this->assertFalse($read['ok']);
        $this->assertSame('artifact_not_found', $read['code']);

        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$stranger]);
    }

    public function testMalformedIdsFailClosedWithoutTouchingStorage(): void
    {
        foreach (['', 'art_short', '../../etc/passwd', 'art_' . str_repeat('A', 24)] as $bad) {
            $result = $this->artifacts->resolve($this->userId, $bad);
            $this->assertFalse($result['ok'], "'$bad' must not resolve");
            $this->assertSame('artifact_not_found', $result['code']);
        }
    }

    public function testAnExpiredArtifactRefusesEvenBeforeCleanupRuns(): void
    {
        $ref = $this->artifacts->store($this->userId, 'stale');
        // Expire it in place — the sweep has NOT run. Expiry is a property of the ref.
        self::$pdo->prepare('UPDATE flow_artifacts SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?')
            ->execute([$ref['$artifact']]);

        $resolved = $this->artifacts->resolve($this->userId, $ref['$artifact']);
        $this->assertFalse($resolved['ok']);
        $this->assertSame('artifact_expired', $resolved['code']);
        $this->assertSame('artifact_expired', $this->artifacts->read($this->userId, $ref['$artifact'])['code']);
    }

    public function testDeviceArtifactsAreOnlyReachableFromTheirOwnDevice(): void
    {
        $ref = $this->artifacts->registerDeviceArtifact($this->userId, 'desk-A', [
            'kind' => 'audio',
            'mediaType' => 'audio/wav',
            'byteSize' => 4096,
        ]);
        $this->assertSame('device', $ref['locality']);
        $this->assertSame('desk-A', $ref['deviceId']);

        // The producing device resolves it.
        $this->assertTrue($this->artifacts->resolve($this->userId, $ref['$artifact'], 'desk-A')['ok']);

        // Another device — and the browser, which has no device at all — do not.
        foreach (['desk-B', null] as $consumer) {
            $result = $this->artifacts->resolve($this->userId, $ref['$artifact'], $consumer);
            $this->assertFalse($result['ok']);
            $this->assertSame('artifact_wrong_device', $result['code']);
        }

        // Even on its own device, the CLOUD has no bytes to hand over — it says so rather than
        // returning an empty artifact that looks like content.
        $read = $this->artifacts->read($this->userId, $ref['$artifact'], 'desk-A');
        $this->assertFalse($read['ok']);
        $this->assertSame('artifact_remote', $read['code']);
    }

    public function testARowWhoseBytesVanishedReportsMissingContentRatherThanEmptyData(): void
    {
        $ref = $this->artifacts->store($this->userId, 'gone soon');
        $key = self::$pdo->query('SELECT storage_key FROM flow_artifacts ORDER BY created_at DESC LIMIT 1')->fetchColumn();
        unlink(self::$root . '/' . $key);

        $read = $this->artifacts->read($this->userId, $ref['$artifact']);
        $this->assertFalse($read['ok']);
        $this->assertSame('artifact_missing_content', $read['code']);
    }

    // ── Quota ───────────────────────────────────────────────────────────────────────────────

    public function testQuotaRefusesOnceTheOwnerIsFull(): void
    {
        // Fill the budget with device registrations (no bytes written, same accounting). One
        // artifact can never reach the quota on its own — the per-artifact ceiling is lower.
        $each = ArtifactService::MAX_ARTIFACT_BYTES;
        for ($held = 0; $held < ArtifactService::QUOTA_BYTES; $held += $each) {
            $this->artifacts->registerDeviceArtifact($this->userId, 'desk-A', ['byteSize' => $each]);
        }
        $usage = $this->artifacts->usage($this->userId);
        $this->assertSame(ArtifactService::QUOTA_BYTES, $usage['bytes']);

        try {
            $this->artifacts->store($this->userId, 'one more byte');
            $this->fail('storing past the quota must refuse');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('artifact_quota_exceeded', $e->getMessage());
        }

        // Expired artifacts do not count against the budget — the ceiling is about LIVE bytes.
        self::$pdo->prepare('UPDATE flow_artifacts SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE user_id = ?')
            ->execute([$this->userId]);
        $this->assertSame(0, $this->artifacts->usage($this->userId)['bytes']);
        $this->assertNotEmpty($this->artifacts->store($this->userId, 'room again'));
    }

    public function testAnOversizeArtifactRefusesBeforeAnythingIsWritten(): void
    {
        try {
            $this->artifacts->registerDeviceArtifact($this->userId, 'desk-A', [
                'byteSize' => ArtifactService::MAX_ARTIFACT_BYTES + 1,
            ]);
            $this->fail('an oversize artifact must refuse');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('artifact_too_large', $e->getMessage());
        }
        $this->assertSame(0, $this->artifacts->usage($this->userId)['count'], 'nothing was recorded');
    }

    // ── Cleanup is deterministic ────────────────────────────────────────────────────────────

    public function testSweepRemovesExactlyTheExpiredArtifactsAndIsIdempotent(): void
    {
        $live = $this->artifacts->store($this->userId, 'keep me');
        $doomedA = $this->artifacts->store($this->userId, 'AAAA');
        $doomedB = $this->artifacts->store($this->userId, 'BBBBBB');
        $device = $this->artifacts->registerDeviceArtifact($this->userId, 'desk-A', ['byteSize' => 99]);

        foreach ([$doomedA, $doomedB, $device] as $expired) {
            self::$pdo->prepare('UPDATE flow_artifacts SET expires_at = DATE_SUB(NOW(), INTERVAL 1 HOUR) WHERE id = ?')
                ->execute([$expired['$artifact']]);
        }
        $keys = self::$pdo->prepare('SELECT storage_key FROM flow_artifacts WHERE id IN (?, ?)');
        $keys->execute([$doomedA['$artifact'], $doomedB['$artifact']]);
        $doomedFiles = array_map(fn ($k) => self::$root . '/' . $k, $keys->fetchAll(PDO::FETCH_COLUMN));
        foreach ($doomedFiles as $file) {
            $this->assertTrue(is_file($file));
        }

        $first = $this->artifacts->sweep();
        $this->assertSame(3, $first['removed'], 'exactly the expired rows, cloud and device alike');
        $this->assertSame(4 + 6 + 99, $first['bytesFreed']);
        foreach ($doomedFiles as $file) {
            $this->assertFalse(is_file($file), 'expired bytes are unlinked, not orphaned');
        }

        // The live artifact is untouched and still readable.
        $this->assertTrue($this->artifacts->read($this->userId, $live['$artifact'])['ok']);

        // Deterministic: an immediate second run has nothing left to do.
        $second = $this->artifacts->sweep();
        $this->assertSame(['removed' => 0, 'bytesFreed' => 0, 'orphanFilesRemoved' => 0], $second);
    }

    public function testDeletingAnArtifactIsOwnerScopedAndIdempotent(): void
    {
        $ref = $this->artifacts->store($this->userId, 'delete me');
        $this->assertTrue($this->artifacts->delete($this->userId, $ref['$artifact']));
        $this->assertFalse($this->artifacts->delete($this->userId, $ref['$artifact']), 'deleting twice is not an error');
        $this->assertSame('artifact_not_found', $this->artifacts->resolve($this->userId, $ref['$artifact'])['code']);
    }

    public function testErasingTheAccountTakesItsArtifactsWithIt(): void
    {
        $this->artifacts->store($this->userId, 'account bound');
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
        $count = self::$pdo->prepare('SELECT COUNT(*) FROM flow_artifacts WHERE user_id = ?');
        $count->execute([$this->userId]);
        $this->assertSame(0, (int) $count->fetchColumn(), 'artifacts cascade with the owner');
    }

    public function testIsRefRecognisesTheHandleShapeAndNothingElse(): void
    {
        $ref = $this->artifacts->store($this->userId, 'x');
        $this->assertTrue(ArtifactService::isRef($ref));
        foreach ([null, 'art_abc', 42, [], ['$artifact' => 'nope'], ['$artifact' => 123]] as $notRef) {
            $this->assertFalse(ArtifactService::isRef($notRef));
        }
    }
}

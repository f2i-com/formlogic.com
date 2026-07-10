<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\FormService;
use FormLogic\Services\ResponseService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Records-retention purge (audit PRIV-001): a form whose settings carry
 * `retentionDays` sheds responses older than the TTL through the FULL
 * deleteResponse path (SQLite row + MySQL response_metadata), while fresh
 * rows and no-retention forms are untouched. The sweep is hour-throttled so
 * a burst of submissions pays for at most one purge scan.
 *
 * Skipped unless a test database is reachable (same setup as the other
 * integration suites).
 */
class RetentionPurgeTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static SQLiteConnection $sqlite;
    private static FormService $formService;
    private static ResponseService $responses;

    /** @var string[] */ private array $userIds = [];
    /** @var string[] */ private array $formIds = [];

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
        self::$sqlite = new SQLiteConnection(sys_get_temp_dir() . '/fl-retention-' . bin2hex(random_bytes(5)));
        self::$formService = new FormService($conn, self::$sqlite);
        self::$responses = new ResponseService($conn, self::$sqlite);
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
        foreach ($this->formIds as $fid) {
            self::$pdo->prepare('DELETE FROM response_metadata WHERE form_id = ?')->execute([$fid]);
            self::$pdo->prepare('DELETE FROM forms WHERE id = ?')->execute([$fid]);
        }
        foreach ($this->userIds as $uid) {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
        }
    }

    private function uuid(): string { return bin2hex(random_bytes(10)); }

    private function makeUser(): string
    {
        $id = 'u' . $this->uuid();
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan, cloud_until) VALUES (?, ?, 'x', 'T', 'personal', DATE_ADD(NOW(), INTERVAL 30 DAY))")
            ->execute([$id, $id . '@test.local']);
        $this->userIds[] = $id;
        return $id;
    }

    /** @param array<string,mixed> $settings */
    private function makeForm(string $ownerId, array $settings): string
    {
        $form = self::$formService->createForm([
            'user_id' => $ownerId,
            'title' => 'Turns',
            'status' => 'published',
            'settings' => $settings,
            'fields' => [
                ['id' => 'transcript', 'type' => 'short_text', 'label' => 'Transcript', 'required' => false, 'order' => 0, 'properties' => []],
            ],
        ]);
        $id = (string) $form['id'];
        $this->formIds[] = $id;
        return $id;
    }

    private function createResponse(string $formId, string $text): string
    {
        $created = self::$responses->createResponse($formId, ['answers' => ['transcript' => $text]]);
        $this->assertIsArray($created);
        return (string) $created['id'];
    }

    /** Backdate a response in BOTH stores and clear the hour throttle. */
    private function ageOut(string $formId, string $responseId, int $days): void
    {
        $db = self::$sqlite->getFormDatabase($formId);
        $old = date('Y-m-d H:i:s', time() - $days * 86400);
        $db->prepare('UPDATE responses SET submitted_at = :t WHERE id = :id')
            ->execute(['t' => $old, 'id' => $responseId]);
        self::$pdo->prepare('UPDATE response_metadata SET submitted_at = ? WHERE id = ?')
            ->execute([$old, $responseId]);
        $db->exec("DELETE FROM form_data WHERE key = 'retention_purged_hour'");
    }

    public function testExpiredRowsPurgedFromBothStoresFreshRowsSurvive(): void
    {
        $owner = $this->makeUser();
        $formId = $this->makeForm($owner, ['retentionDays' => 30]);
        $expired = $this->createResponse($formId, 'old call turn');
        $fresh = $this->createResponse($formId, 'new call turn');
        $this->ageOut($formId, $expired, 40);

        $deleted = self::$responses->purgeExpiredIfDue($formId);

        $this->assertSame(1, $deleted);
        $db = self::$sqlite->getFormDatabase($formId);
        $ids = $db->query('SELECT id FROM responses')->fetchAll(PDO::FETCH_COLUMN);
        $this->assertSame([$fresh], $ids, 'only the fresh row survives in SQLite');
        $meta = self::$pdo->prepare('SELECT id FROM response_metadata WHERE form_id = ?');
        $meta->execute([$formId]);
        $this->assertSame([$fresh], $meta->fetchAll(PDO::FETCH_COLUMN), 'MySQL metadata purged with the row');
    }

    public function testSecondSweepInTheSameHourIsThrottled(): void
    {
        $owner = $this->makeUser();
        $formId = $this->makeForm($owner, ['retentionDays' => 30]);
        $expired = $this->createResponse($formId, 'stale');
        $this->ageOut($formId, $expired, 40);

        $this->assertSame(1, self::$responses->purgeExpiredIfDue($formId));

        // Another expired row appears, but this hour's slot is already claimed.
        $again = $this->createResponse($formId, 'stale again');
        $db = self::$sqlite->getFormDatabase($formId);
        $db->prepare('UPDATE responses SET submitted_at = :t WHERE id = :id')
            ->execute(['t' => date('Y-m-d H:i:s', time() - 40 * 86400), 'id' => $again]);

        $this->assertSame(0, self::$responses->purgeExpiredIfDue($formId), 'hour throttle skips the rescan');
    }

    public function testFormWithoutRetentionSettingIsNeverPurged(): void
    {
        $owner = $this->makeUser();
        $formId = $this->makeForm($owner, []);
        $old = $this->createResponse($formId, 'ancient but kept');
        $this->ageOut($formId, $old, 400);

        $this->assertSame(0, self::$responses->purgeExpiredIfDue($formId));
        $db = self::$sqlite->getFormDatabase($formId);
        $this->assertSame(
            [$old],
            $db->query('SELECT id FROM responses')->fetchAll(PDO::FETCH_COLUMN),
            'no retention setting — rows are permanent'
        );
    }
}

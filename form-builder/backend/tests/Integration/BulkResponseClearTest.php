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
 * Bulk response clear (Device Setup 'start fresh'): ONE operation removes
 * every row of a form and keeps the mirrors clean — response_metadata and
 * response_links rows go with them, and the denormalized forms.response_count
 * resyncs to zero. Replaces the per-row loop whose bounded passes stalled on
 * a 983-row Transcript Turns table (live report 2026-07-14).
 *
 * Skipped unless a test database is reachable.
 */
class BulkResponseClearTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
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
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/fl-bulkclear-' . bin2hex(random_bytes(5)));
        self::$formService = new FormService($conn, $sqlite);
        self::$responses = new ResponseService($conn, $sqlite);
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
            self::$pdo->prepare('DELETE FROM forms WHERE id = ?')->execute([$fid]);
        }
        foreach ($this->userIds as $uid) {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
        }
    }

    private function makeUser(): string
    {
        $id = 'u' . bin2hex(random_bytes(10));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan, cloud_until) VALUES (?, ?, 'x', 'T', 'personal', DATE_ADD(NOW(), INTERVAL 30 DAY))")
            ->execute([$id, $id . '@test.local']);
        $this->userIds[] = $id;
        return $id;
    }

    public function testBulkClearRemovesRowsMirrorsAndResyncsCount(): void
    {
        $owner = $this->makeUser();
        $form = self::$formService->createForm([
            'user_id' => $owner,
            'title' => 'Transcript Turns',
            'status' => 'published',
            'fields' => [
                ['id' => 'text', 'type' => 'short_text', 'label' => 'Text', 'required' => false, 'order' => 0, 'properties' => []],
            ],
        ]);
        $formId = (string) $form['id'];
        $this->formIds[] = $formId;

        $ids = [];
        for ($i = 0; $i < 12; $i++) {
            $r = self::$responses->createResponse($formId, ['answers' => ['text' => "turn {$i}"]]);
            $this->assertIsArray($r);
            $ids[] = (string) $r['id'];
        }
        // A cross-form link row that must disappear with its source response.
        self::$pdo->prepare("INSERT INTO response_links (id, source_form_id, source_response_id, target_form_id, target_response_id, field_id) VALUES (?, ?, ?, ?, ?, 'f')")
            ->execute(['lk' . bin2hex(random_bytes(8)), $formId, $ids[0], $formId, $ids[1]]);

        $deleted = self::$responses->deleteAllResponses($formId);
        $this->assertSame(12, $deleted);

        $remaining = self::$responses->getFormResponses($formId, ['limit' => 100]);
        $this->assertCount(0, $remaining);

        // Mirrors: metadata + links gone.
        $ph = implode(',', array_fill(0, count($ids), '?'));
        $meta = self::$pdo->prepare("SELECT COUNT(*) FROM response_metadata WHERE id IN ($ph)");
        $meta->execute($ids);
        $this->assertSame(0, (int) $meta->fetchColumn());
        $links = self::$pdo->prepare('SELECT COUNT(*) FROM response_links WHERE source_response_id = ? OR target_response_id = ?');
        $links->execute([$ids[0], $ids[1]]);
        $this->assertSame(0, (int) $links->fetchColumn());

        // Denormalized count resynced to zero.
        $count = self::$pdo->prepare('SELECT response_count FROM forms WHERE id = ?');
        $count->execute([$formId]);
        $this->assertSame(0, (int) $count->fetchColumn());

        // Idempotent: clearing an already-empty form is a zero, not an error.
        $this->assertSame(0, self::$responses->deleteAllResponses($formId));
    }
}

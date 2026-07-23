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
 * Audit FL-16 — CSV import rides the canonical response validation pipeline:
 * required fields, choice enums, ranges, and email rules apply exactly as they
 * do on the API/MCP write paths; invalid rows are never inserted (structured
 * per-row errors instead); calculated/unknown columns are stripped. Skipped
 * without a test DB.
 */
class CsvImportValidationTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static FormService $formService;
    private static ResponseService $responses;
    private static SQLiteConnection $sqlite;

    private string $userId = '';
    private string $formId = '';
    /** @var array[] */
    private array $fields = [];

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
        self::$sqlite = new SQLiteConnection(sys_get_temp_dir() . '/fl-csvimport-' . bin2hex(random_bytes(5)));
        self::$formService = new FormService($conn, self::$sqlite);
        self::$responses = new ResponseService($conn, self::$sqlite);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->userId = 'u' . bin2hex(random_bytes(10));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$this->userId, $this->userId . '@test.local']);

        $this->fields = [
            ['id' => 'email', 'type' => 'email', 'label' => 'Email', 'required' => true, 'order' => 0, 'properties' => []],
            ['id' => 'age', 'type' => 'number', 'label' => 'Age', 'required' => false, 'order' => 1, 'properties' => ['min' => 0, 'max' => 120]],
            ['id' => 'color', 'type' => 'dropdown', 'label' => 'Color', 'required' => false, 'order' => 2, 'properties' => [
                'options' => [
                    ['value' => 'opt_red', 'label' => 'Red'],
                    ['value' => 'opt_blue', 'label' => 'Blue'],
                ],
            ]],
            ['id' => 'total', 'type' => 'calculated', 'label' => 'Total', 'required' => false, 'order' => 3, 'properties' => []],
        ];
        $form = self::$formService->createForm([
            'user_id' => $this->userId,
            'title' => 'Import Target',
            'status' => 'published',
            'fields' => $this->fields,
        ]);
        $this->formId = $form['id'];
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        if ($this->formId !== '') {
            self::$pdo->prepare('DELETE FROM response_metadata WHERE form_id = ?')->execute([$this->formId]);
            self::$pdo->prepare('DELETE FROM forms WHERE id = ?')->execute([$this->formId]);
        }
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
    }

    /** @return array{created:int, skipped:int, total:int, errors:array} */
    private function import(array $rows): array
    {
        $mapping = ['Email' => 'email', 'Age' => 'age', 'Color' => 'color', 'Total' => 'total'];
        return self::$responses->importResponses($this->formId, $rows, $mapping, $this->fields);
    }

    private function storedAnswers(): array
    {
        $db = self::$sqlite->getFormDatabase($this->formId);
        $rows = $db->query('SELECT answers FROM responses ORDER BY submitted_at ASC')->fetchAll(PDO::FETCH_COLUMN);
        return array_map(static fn ($json) => json_decode((string) $json, true), $rows);
    }

    public function testValidRowsNormalizeLikeApiSubmissionAndCalculatedIsStripped(): void
    {
        $result = $this->import([
            ['Email' => 'a@test.local', 'Age' => '42', 'Color' => 'opt_red', 'Total' => 'should-not-store'],
        ]);
        $this->assertSame(1, $result['created']);
        $this->assertSame(0, $result['skipped']);

        $stored = $this->storedAnswers();
        $this->assertCount(1, $stored);
        $this->assertSame('a@test.local', $stored[0]['email']);
        $this->assertSame(42.0, (float) $stored[0]['age']);
        $this->assertSame('opt_red', $stored[0]['color']);
        $this->assertArrayNotHasKey('total', $stored[0], 'calculated columns are computed, never stored raw');
    }

    public function testInvalidRowsAreNeverInsertedAndReportStructuredErrors(): void
    {
        $result = $this->import([
            ['Email' => '', 'Age' => '30', 'Color' => 'opt_red', 'Total' => ''],          // missing required
            ['Email' => 'not-an-email', 'Age' => '30', 'Color' => 'opt_red', 'Total' => ''], // bad email
            ['Email' => 'b@test.local', 'Age' => '999', 'Color' => 'opt_red', 'Total' => ''], // out of range
            ['Email' => 'c@test.local', 'Age' => '30', 'Color' => 'purple', 'Total' => ''],   // enum violation
            ['Email' => 'd@test.local', 'Age' => 'NaNful', 'Color' => 'opt_blue', 'Total' => ''], // non-numeric number
            ['Email' => 'ok@test.local', 'Age' => '25', 'Color' => 'opt_blue', 'Total' => ''],    // valid
        ]);

        $this->assertSame(1, $result['created'], 'only the valid row may be inserted');
        $this->assertSame(5, $result['skipped']);
        $this->assertCount(5, $result['errors']);
        foreach ($result['errors'] as $error) {
            $this->assertIsInt($error['row']);
            $this->assertNotEmpty($error['errors']);
        }

        $stored = $this->storedAnswers();
        $this->assertCount(1, $stored);
        $this->assertSame('ok@test.local', $stored[0]['email']);

        // The MySQL metadata mirror agrees (no orphaned/invisible records).
        $count = self::$pdo->prepare('SELECT COUNT(*) FROM response_metadata WHERE form_id = ?');
        $count->execute([$this->formId]);
        $this->assertSame(1, (int) $count->fetchColumn());
    }
}

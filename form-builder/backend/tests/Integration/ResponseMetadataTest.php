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
 * Submission identity trail: every persisted response records the identifying
 * request metadata the controllers capture — IP address, user agent (browser),
 * referrer, Accept-Language and (when the submitter is signed in) their account
 * id — and reads it back verbatim for the owner's response views and exports.
 */
class ResponseMetadataTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static SQLiteConnection $sqlite;
    private static FormService $forms;
    private static ResponseService $responses;
    private static string $tmpRoot = '';

    private string $userId = '';
    private string $formId = '';

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
        self::$tmpRoot = sys_get_temp_dir() . '/formlogic-respmeta-test-' . bin2hex(random_bytes(4));
        mkdir(self::$tmpRoot . '/sqlite', 0777, true);
        self::$sqlite = new SQLiteConnection(self::$tmpRoot . '/sqlite');
        self::$forms = new FormService($conn, self::$sqlite);
        self::$responses = new ResponseService($conn, self::$sqlite);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->userId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$this->userId, $this->userId . '@test.local']);

        $form = self::$forms->createForm([
            'title' => 'Metadata form', 'userId' => $this->userId, 'status' => 'published',
            'fields' => [['id' => 'name', 'type' => 'short_text', 'label' => 'Name', 'required' => false]],
        ]);
        $this->formId = (string) $form['id'];
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null || $this->userId === '') {
            return;
        }
        self::$pdo->prepare('DELETE FROM forms WHERE user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
    }

    public function testResponseStoresAndReturnsTheFullIdentityTrail(): void
    {
        $created = self::$responses->createResponse($this->formId, [
            'answers' => ['name' => 'Alice'],
            'ipAddress' => '203.0.113.42',
            'userAgent' => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/138.0.0.0 Safari/537.36',
            'referrer' => 'https://example.com/contact',
            'language' => 'en-AU,en;q=0.9',
            'submittedByUserId' => $this->userId,
        ], null);
        $this->assertIsArray($created);

        $stored = self::$responses->getResponse($this->formId, (string) $created['id']);
        $this->assertNotNull($stored);
        $meta = $stored['metadata'];
        $this->assertSame('203.0.113.42', $meta['ipAddress']);
        $this->assertSame('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/138.0.0.0 Safari/537.36', $meta['userAgent']);
        $this->assertSame('https://example.com/contact', $meta['referrer']);
        $this->assertSame('en-AU,en;q=0.9', $meta['language']);
        $this->assertSame($this->userId, $meta['submittedByUserId']);
    }

    public function testAnonymousResponseStoresNullIdentityFieldsWithoutErrors(): void
    {
        $created = self::$responses->createResponse($this->formId, [
            'answers' => ['name' => 'Anon'],
            'ipAddress' => '198.51.100.7',
            'userAgent' => 'curl/8.14.1',
        ], null);
        $this->assertIsArray($created);

        $meta = self::$responses->getResponse($this->formId, (string) $created['id'])['metadata'];
        $this->assertSame('198.51.100.7', $meta['ipAddress']);
        $this->assertNull($meta['language']);
        $this->assertNull($meta['submittedByUserId']);
    }
}

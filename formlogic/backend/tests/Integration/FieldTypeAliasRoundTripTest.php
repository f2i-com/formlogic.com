<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use Dotenv\Dotenv;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\FormService;
use PHPUnit\Framework\TestCase;

/**
 * Round-trip proof for the legacy field-type aliases: a form saved with text/textarea
 * fields is stored AND read back with the canonical types (short_text/long_text) — the
 * renderer never sees the legacy names. Live incident: two "E2EE live check" forms
 * carried type "text" and rendered "Field type not supported".
 */
class FieldTypeAliasRoundTripTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?\PDO $pdo = null;
    private static SQLiteConnection $sqlite;
    private static FormService $svc;

    /** @var string[] */
    private array $formIds = [];
    /** @var string[] */
    private array $userIds = [];

    public static function setUpBeforeClass(): void
    {
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) {
            Dotenv::createImmutable($root)->safeLoad();
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
        self::$sqlite = new SQLiteConnection(sys_get_temp_dir() . '/fl-alias-' . bin2hex(random_bytes(5)));
        self::$svc = new FormService($conn, self::$sqlite);
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
            self::$pdo->prepare("DELETE FROM store_ops WHERE entity_type = 'form' AND entity_id = ?")->execute([$fid]);
            self::$sqlite->deleteFormDatabase($fid);
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

    public function testLegacyTypesAreStoredAndReadBackCanonical(): void
    {
        $userId = $this->makeUser();
        $formId = 'f' . bin2hex(random_bytes(10));
        $this->formIds[] = $formId;

        self::$svc->createForm([
            'id' => $formId,
            'userId' => $userId,
            'title' => 'Alias round trip',
            'fields' => [
                ['id' => 'f_name', 'type' => 'text', 'label' => 'Full name', 'required' => false, 'order' => 0, 'properties' => []],
                ['id' => 'f_notes', 'type' => 'textarea', 'label' => 'Notes', 'required' => false, 'order' => 1, 'properties' => []],
                ['id' => 'f_email', 'type' => 'email', 'label' => 'Email', 'required' => false, 'order' => 2, 'properties' => []],
            ],
        ]);

        // Write path: the per-form SQLite already holds canonical types.
        $raw = self::$sqlite->getFormDatabase($formId)
            ->query('SELECT id, type FROM fields ORDER BY field_order ASC')
            ->fetchAll(\PDO::FETCH_KEY_PAIR);
        $this->assertSame(
            ['f_name' => 'short_text', 'f_notes' => 'long_text', 'f_email' => 'email'],
            $raw
        );

        // Read path: the API-shaped form carries canonical types too.
        $form = self::$svc->getForm($formId);
        $this->assertNotNull($form);
        $types = array_column($form['fields'], 'type', 'id');
        $this->assertSame('short_text', $types['f_name']);
        $this->assertSame('long_text', $types['f_notes']);
        $this->assertSame('email', $types['f_email']);
    }

    public function testPreExistingLegacyRowsReadBackCanonical(): void
    {
        // Rows written BEFORE the alias existed stay legacy in SQLite; the read path
        // must still normalize them.
        $userId = $this->makeUser();
        $formId = 'f' . bin2hex(random_bytes(10));
        $this->formIds[] = $formId;

        self::$svc->createForm([
            'id' => $formId,
            'userId' => $userId,
            'title' => 'Legacy rows',
            'fields' => [
                ['id' => 'f_name', 'type' => 'short_text', 'label' => 'Full name', 'required' => false, 'order' => 0, 'properties' => []],
            ],
        ]);
        self::$sqlite->getFormDatabase($formId)
            ->exec("UPDATE fields SET type = 'text' WHERE id = 'f_name'");

        $form = self::$svc->getForm($formId);
        $this->assertNotNull($form);
        $this->assertSame('short_text', $form['fields'][0]['type']);
    }
}

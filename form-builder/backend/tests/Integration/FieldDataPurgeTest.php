<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\FileStorageService;
use FormLogic\Services\FormService;
use FormLogic\Services\ResponseService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Field-data lifecycle behind the builder's delete-field dialog:
 *  - countResponsesWithFieldValue counts only non-empty values;
 *  - purgeFieldData strips the key from every answers blob, removes computed
 *    values under the same name, drops the field's response_links rows, and
 *    deletes uploaded files the doomed values referenced — while leaving every
 *    OTHER field's data untouched.
 */
class FieldDataPurgeTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static SQLiteConnection $sqlite;
    private static FormService $forms;
    private static ResponseService $responses;
    private static string $tmpRoot = '';
    private static string $uploadsPath = '';

    private string $userId = '';
    private string $formId = '';
    private string $targetFormId = '';
    private string $targetResponseId = '';

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
        self::$tmpRoot = sys_get_temp_dir() . '/formlogic-fieldpurge-test-' . bin2hex(random_bytes(4));
        self::$uploadsPath = self::$tmpRoot . '/uploads';
        mkdir(self::$tmpRoot . '/sqlite', 0777, true);
        mkdir(self::$uploadsPath, 0777, true);

        self::$sqlite = new SQLiteConnection(self::$tmpRoot . '/sqlite');
        self::$forms = new FormService($conn, self::$sqlite);
        self::$responses = new ResponseService(
            $conn,
            self::$sqlite,
            null,
            null,
            null,
            new FileStorageService(['storagePath' => self::$uploadsPath])
        );
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->userId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$this->userId, $this->userId . '@test.local']);

        $target = self::$forms->createForm([
            'title' => 'Targets', 'userId' => $this->userId, 'status' => 'published',
            'fields' => [['id' => 'name', 'type' => 'short_text', 'label' => 'Name', 'required' => false]],
        ]);
        $this->targetFormId = (string) $target['id'];
        self::$responses->createResponse($this->targetFormId, ['answers' => ['name' => 'T1']], null);
        $this->targetResponseId = (string) self::$sqlite->getFormDatabase($this->targetFormId)
            ->query('SELECT id FROM responses LIMIT 1')->fetchColumn();

        $form = self::$forms->createForm([
            'title' => 'Purge me', 'userId' => $this->userId, 'status' => 'published',
            'fields' => [
                ['id' => 'keep_me', 'type' => 'short_text', 'label' => 'Keep', 'required' => false],
                ['id' => 'doomed', 'type' => 'short_text', 'label' => 'Doomed', 'required' => false],
                ['id' => 'attachment', 'type' => 'file_upload', 'label' => 'Attachment', 'required' => false],
                ['id' => 'client', 'type' => 'linked_record', 'label' => 'Client', 'required' => false,
                 'properties' => ['targetFormId' => $this->targetFormId, 'displayFieldIds' => ['name']]],
            ],
        ]);
        $this->formId = (string) $form['id'];
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null || $this->userId === '') {
            return;
        }
        self::$pdo->prepare('DELETE FROM response_links WHERE source_form_id IN (SELECT id FROM forms WHERE user_id = ?)')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM forms WHERE user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
    }

    public function testUsageCountsOnlyNonEmptyValues(): void
    {
        self::$responses->createResponse($this->formId, ['answers' => ['keep_me' => 'a', 'doomed' => 'value']], null);
        self::$responses->createResponse($this->formId, ['answers' => ['keep_me' => 'b', 'doomed' => '']], null);
        self::$responses->createResponse($this->formId, ['answers' => ['keep_me' => 'c']], null);

        $this->assertSame(1, self::$responses->countResponsesWithFieldValue($this->formId, 'doomed'));
        $this->assertSame(3, self::$responses->countResponsesWithFieldValue($this->formId, 'keep_me'));
        $this->assertSame(0, self::$responses->countResponsesWithFieldValue($this->formId, 'never_existed'));
    }

    public function testPurgeRemovesAnswersComputedLinksAndFiles(): void
    {
        $fileId = 'file-' . bin2hex(random_bytes(8));
        $uploadDir = self::$uploadsPath . '/' . $this->formId;
        mkdir($uploadDir, 0777, true);
        file_put_contents($uploadDir . '/' . $fileId . '.pdf', 'BYTES');

        self::$responses->createResponse($this->formId, ['answers' => [
            'keep_me' => 'stays',
            'doomed' => 'goes',
        ]], null);
        self::$responses->createResponse($this->formId, ['answers' => [
            'keep_me' => 'also stays',
            'attachment' => [[
                'id' => $fileId, 'originalFilename' => 'doc.pdf', 'storedFilename' => $fileId . '.pdf',
                'size' => 5, 'mimeType' => 'application/pdf',
                'url' => "/api/files/{$this->formId}/{$fileId}/doc.pdf",
            ]],
            'client' => $this->targetResponseId,
        ]], null);

        $db = self::$sqlite->getFormDatabase($this->formId);
        $ids = $db->query('SELECT id FROM responses ORDER BY rowid')->fetchAll(PDO::FETCH_COLUMN);
        $db->prepare('INSERT INTO computed (response_id, field_name, field_value) VALUES (?, ?, ?)')
            ->execute([$ids[0], 'doomed', json_encode('computed-too')]);
        $fields = self::$forms->getForm($this->formId)['fields'];
        self::$responses->syncResponseLinks($this->formId, $ids[1], $fields, ['client' => $this->targetResponseId]);
        $linkCount = self::$pdo->prepare('SELECT COUNT(*) FROM response_links WHERE source_form_id = ? AND field_id = ?');
        $linkCount->execute([$this->formId, 'client']);
        $this->assertSame(1, (int) $linkCount->fetchColumn(), 'fixture link exists');

        // 1. Purge the plain text field: its key vanishes, everything else stays.
        $this->assertSame(1, self::$responses->purgeFieldData($this->formId, 'doomed'));
        $answers = array_map(
            static fn ($raw) => json_decode((string) $raw, true),
            $db->query('SELECT answers FROM responses ORDER BY rowid')->fetchAll(PDO::FETCH_COLUMN)
        );
        $this->assertArrayNotHasKey('doomed', $answers[0]);
        $this->assertSame('stays', $answers[0]['keep_me']);
        $this->assertSame('also stays', $answers[1]['keep_me']);
        $computed = (int) $db->query("SELECT COUNT(*) FROM computed WHERE field_name = 'doomed'")->fetchColumn();
        $this->assertSame(0, $computed, 'computed values under the purged name removed');

        // 2. Purge the file field: the answer AND the physical file go away.
        $this->assertSame(1, self::$responses->purgeFieldData($this->formId, 'attachment'));
        $this->assertFileDoesNotExist($uploadDir . '/' . $fileId . '.pdf');

        // 3. Purge the linked_record field: its response_links rows go away.
        $this->assertSame(1, self::$responses->purgeFieldData($this->formId, 'client'));
        $linkCount->execute([$this->formId, 'client']);
        $this->assertSame(0, (int) $linkCount->fetchColumn());

        // Untouched field intact after all three purges; re-purging is a no-op.
        $this->assertSame(2, self::$responses->countResponsesWithFieldValue($this->formId, 'keep_me'));
        $this->assertSame(0, self::$responses->purgeFieldData($this->formId, 'doomed'));
    }
}

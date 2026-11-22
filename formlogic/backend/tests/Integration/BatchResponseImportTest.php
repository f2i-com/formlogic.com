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
 * Verifies structured batch import + Pass-2 linked_record patching used by
 * the Database Import & Migration studio: parent/child FK remapping,
 * response_links synchronization, self-referencing Pass-2 cycles, and
 * per-row validation error reporting without aborting valid rows.
 */
class BatchResponseImportTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static SQLiteConnection $sqlite;
    private static FormService $forms;
    private static ResponseService $responses;
    private static string $tmpRoot = '';

    private string $userId = '';
    /** @var array<int, string> */
    private array $createdFormIds = [];

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
        self::$tmpRoot = sys_get_temp_dir() . '/formlogic-batch-import-' . bin2hex(random_bytes(4));
        mkdir(self::$tmpRoot . '/sqlite', 0777, true);
        self::$sqlite = new SQLiteConnection(self::$tmpRoot . '/sqlite');
        self::$forms = new FormService($conn, self::$sqlite);
        self::$responses = new ResponseService($conn, self::$sqlite);
    }

    protected function setUp(): void
    {
        if (self::$pdo === null) {
            self::markTestSkipped('No test database available');
        }
        $this->userId = 'batch-u-' . bin2hex(random_bytes(4));
        $this->createdFormIds = [];
        self::$pdo->prepare(
            'INSERT INTO users (id, email, password_hash, name) VALUES (:id, :email, :hash, :name)'
        )->execute([
            'id' => $this->userId,
            'email' => $this->userId . '@example.test',
            'hash' => password_hash('pw', PASSWORD_BCRYPT),
            'name' => 'Batch Tester',
        ]);
    }

    protected function tearDown(): void
    {
        if (self::$pdo !== null) {
            foreach ($this->createdFormIds as $fid) {
                self::$pdo->prepare('DELETE FROM response_links WHERE source_form_id = :id OR target_form_id = :t')->execute(['id' => $fid, 't' => $fid]);
                self::$pdo->prepare('DELETE FROM response_metadata WHERE form_id = :id')->execute(['id' => $fid]);
                self::$pdo->prepare('DELETE FROM forms WHERE id = :id')->execute(['id' => $fid]);
            }
            self::$pdo->prepare('DELETE FROM users WHERE id = :id')->execute(['id' => $this->userId]);
        }
    }

    public function testParentChildBatchImportSyncsResponseLinksAndReportsBadRows(): void
    {
        $customersForm = self::$forms->createForm([
            'userId' => $this->userId,
            'title' => 'Customers',
            'status' => 'published',
            'fields' => [
                ['id' => 'legacy_id', 'type' => 'short_text', 'label' => 'Legacy ID', 'required' => false, 'order' => 0],
                ['id' => 'full_name', 'type' => 'short_text', 'label' => 'Full Name', 'required' => true, 'order' => 1],
                ['id' => 'email', 'type' => 'email', 'label' => 'Email', 'required' => true, 'order' => 2],
                ['id' => 'vip', 'type' => 'checkboxes', 'label' => 'VIP', 'required' => false, 'order' => 3, 'properties' => [
                    'options' => [['id' => 'yes', 'label' => 'Yes', 'value' => 'yes']],
                ]],
            ],
        ]);
        $this->createdFormIds[] = $customersForm['id'];

        $ordersForm = self::$forms->createForm([
            'userId' => $this->userId,
            'title' => 'Orders',
            'status' => 'published',
            'fields' => [
                ['id' => 'order_no', 'type' => 'short_text', 'label' => 'Order No', 'required' => true, 'order' => 0],
                ['id' => 'amount', 'type' => 'number', 'label' => 'Amount', 'required' => true, 'order' => 1],
                ['id' => 'customer', 'type' => 'linked_record', 'label' => 'Customer', 'required' => true, 'order' => 2, 'properties' => [
                    'targetFormId' => $customersForm['id'],
                    'displayFieldIds' => ['full_name'],
                ]],
            ],
        ]);
        $this->createdFormIds[] = $ordersForm['id'];

        // Import 3 customer rows — 2 valid, 1 invalid email.
        $custResult = self::$responses->batchImportResponses(
            $customersForm['id'],
            [
                ['clientKey' => '101', 'answers' => ['legacy_id' => '101', 'full_name' => 'Ada Lovelace', 'email' => 'ada@example.com', 'vip' => true]],
                ['clientKey' => '102', 'answers' => ['legacy_id' => '102', 'full_name' => 'Bad Email', 'email' => 'not-an-email', 'vip' => false]],
                ['clientKey' => '103', 'answers' => ['legacy_id' => '103', 'full_name' => 'Grace Hopper', 'email' => 'grace@example.com', 'vip' => '0']],
            ],
            $customersForm['fields'],
            $this->userId
        );

        self::assertSame(2, $custResult['created']);
        self::assertSame(1, $custResult['failed']);
        self::assertSame(3, $custResult['total']);
        self::assertNotEmpty($custResult['results'][0]['responseId'] ?? '');
        self::assertSame('101', $custResult['results'][0]['clientKey']);
        self::assertArrayHasKey('error', $custResult['results'][1]);
        self::assertNotEmpty($custResult['results'][2]['responseId'] ?? '');

        $adaId = (string) $custResult['results'][0]['responseId'];
        $graceId = (string) $custResult['results'][2]['responseId'];

        // Verify boolean coercion on VIP checkboxes.
        $adaRow = self::$responses->getResponse($customersForm['id'], $adaId);
        self::assertSame(['yes'], $adaRow['answers']['vip'] ?? null);
        $graceRow = self::$responses->getResponse($customersForm['id'], $graceId);
        self::assertSame([], $graceRow['answers']['vip'] ?? null);

        // Import child orders referencing remapped parent response IDs.
        $ordResult = self::$responses->batchImportResponses(
            $ordersForm['id'],
            [
                ['clientKey' => 'ORD-1', 'answers' => ['order_no' => 'ORD-1', 'amount' => '199.50', 'customer' => $adaId]],
                ['clientKey' => 'ORD-2', 'answers' => ['order_no' => 'ORD-2', 'amount' => 45, 'customer' => $graceId]],
            ],
            $ordersForm['fields'],
            $this->userId
        );
        self::assertSame(2, $ordResult['created']);
        self::assertSame(0, $ordResult['failed']);

        // Confirm MySQL response_links inverse index was populated for both orders.
        $stmt = self::$pdo->prepare('SELECT COUNT(*) FROM response_links WHERE source_form_id = :sf AND target_form_id = :tf');
        $stmt->execute(['sf' => $ordersForm['id'], 'tf' => $customersForm['id']]);
        self::assertSame(2, (int) $stmt->fetchColumn());
    }

    public function testSelfReferencingPass2PatchLinks(): void
    {
        $employeesForm = self::$forms->createForm([
            'userId' => $this->userId,
            'title' => 'Employees',
            'status' => 'published',
            'fields' => [
                ['id' => 'emp_name', 'type' => 'short_text', 'label' => 'Name', 'required' => true, 'order' => 0],
            ],
        ]);
        $this->createdFormIds[] = $employeesForm['id'];

        $updatedFields = [
            ['id' => 'emp_name', 'type' => 'short_text', 'label' => 'Name', 'required' => true, 'order' => 0],
            ['id' => 'manager', 'type' => 'linked_record', 'label' => 'Manager', 'required' => true, 'order' => 1, 'properties' => [
                'targetFormId' => $employeesForm['id'],
                'displayFieldIds' => ['emp_name'],
            ]],
        ];
        self::$forms->updateForm($employeesForm['id'], ['fields' => $updatedFields]);

        // Pass 1: defer required check on cyclic self-referencing 'manager' field.
        $pass1 = self::$responses->batchImportResponses(
            $employeesForm['id'],
            [
                ['clientKey' => '1', 'answers' => ['emp_name' => 'CEO']],
                ['clientKey' => '2', 'answers' => ['emp_name' => 'VP Eng']],
            ],
            $updatedFields,
            $this->userId,
            null,
            ['manager']
        );
        self::assertSame(2, $pass1['created']);
        $ceoId = (string) $pass1['results'][0]['responseId'];
        $vpId = (string) $pass1['results'][1]['responseId'];

        // Pass 2: patch VP Eng -> manager = CEO.
        $pass2 = self::$responses->batchPatchResponseLinks(
            $employeesForm['id'],
            [
                ['responseId' => $vpId, 'links' => ['manager' => $ceoId]],
            ],
            $updatedFields
        );
        self::assertSame(1, $pass2['updated']);
        self::assertSame(0, $pass2['failed']);

        $vpRow = self::$responses->getResponse($employeesForm['id'], $vpId);
        self::assertSame($ceoId, $vpRow['answers']['manager'] ?? null);

        $stmt = self::$pdo->prepare('SELECT target_response_id FROM response_links WHERE source_response_id = :src');
        $stmt->execute(['src' => $vpId]);
        self::assertSame($ceoId, $stmt->fetchColumn());
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\DataCloudSigner;
use FormLogic\Services\DataOperationLogService;
use FormLogic\Services\FormService;
use FormLogic\Services\ResponseService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Audit FL-05 (stopgap until data-nodes N3+ signed tombstones): a PLACED
 * private dataset must REFUSE permanent deletion — a bare row delete would
 * leave replicas unaware and let the data resurrect on replay, while the API
 * reported success. Legacy (unplaced) forms keep the old delete path.
 * Skipped without a test DB.
 */
class PlacedDatasetDeletionGuardTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static FormService $formService;
    private static ResponseService $responses;

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
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/fl-placedel-' . bin2hex(random_bytes(5)));
        self::$formService = new FormService($conn, $sqlite);
        self::$responses = new ResponseService($conn, $sqlite);
        $signer = new DataCloudSigner(sys_get_temp_dir() . '/fl-placedel-signer-' . bin2hex(random_bytes(4)) . '.key');
        self::$responses->setDataOperationLog(new DataOperationLogService($conn, $signer));
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->userId = 'u' . bin2hex(random_bytes(10));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$this->userId, $this->userId . '@test.local']);
        $form = self::$formService->createForm([
            'user_id' => $this->userId,
            'title' => 'Placed dataset',
            'status' => 'published',
            'fields' => [
                ['id' => 'note', 'type' => 'short_text', 'label' => 'Note', 'required' => false, 'order' => 0, 'properties' => []],
            ],
        ]);
        $this->formId = $form['id'];
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        self::$pdo->prepare('DELETE FROM data_placement_manifests WHERE dataset_id = ?')->execute([$this->formId]);
        self::$pdo->prepare('DELETE FROM response_metadata WHERE form_id = ?')->execute([$this->formId]);
        self::$pdo->prepare('DELETE FROM forms WHERE id = ?')->execute([$this->formId]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
    }

    public function testPlacedDatasetRefusesDeletionAndKeepsTheRow(): void
    {
        $created = self::$responses->createResponse($this->formId, ['answers' => ['note' => 'keep me']]);
        $this->assertIsArray($created);
        $responseId = (string) $created['id'];

        // Place the dataset (epoch-1 manifest row is what placementFor reads).
        self::$pdo->prepare("
            INSERT INTO data_placement_manifests
                (id, dataset_id, form_id, storage_epoch, manifest_hash, primary_replica_id,
                 signed_bytes, owner_signer_key_id, owner_signer_fingerprint, created_at)
            VALUES (?, ?, ?, 1, ?, 'replica-1', '', 'k1', ?, NOW())
        ")->execute([
            'pm-' . bin2hex(random_bytes(8)),
            $this->formId,
            $this->formId,
            str_repeat('a', 64),
            str_repeat('b', 64),
        ]);

        try {
            self::$responses->deleteResponse($this->formId, $responseId);
            $this->fail('deletion on a placed dataset must refuse');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('placement_tombstones_unimplemented', $e->getMessage());
        }
        try {
            self::$responses->deleteAllResponses($this->formId);
            $this->fail('bulk deletion on a placed dataset must refuse');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('placement_tombstones_unimplemented', $e->getMessage());
        }

        // Nothing was deleted — the authoritative row survives.
        $this->assertNotNull(self::$responses->getResponse($this->formId, $responseId));

        // Un-place the dataset → the legacy delete path works again.
        self::$pdo->prepare('DELETE FROM data_placement_manifests WHERE dataset_id = ?')->execute([$this->formId]);
        self::$responses->setDataOperationLog(new DataOperationLogService(
            self::$mysql,
            new DataCloudSigner(sys_get_temp_dir() . '/fl-placedel-signer2-' . bin2hex(random_bytes(4)) . '.key')
        ));
        $this->assertTrue(self::$responses->deleteResponse($this->formId, $responseId));
    }
}

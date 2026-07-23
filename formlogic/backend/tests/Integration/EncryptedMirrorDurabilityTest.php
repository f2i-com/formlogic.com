<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\DataCloudSigner;
use FormLogic\Services\DataOperationLogService;
use FormLogic\Services\FormService;
use FormLogic\Services\ReconcileService;
use FormLogic\Services\ResponseService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Audit FL-04 — durable cross-store reconciliation replaces destructive
 * compensation:
 *   1. a TRANSIENT MySQL mirror failure keeps the durably-committed response
 *      and its signed operation (the head never rewinds) and reports success;
 *      reconciliation restores the missing metadata mirror idempotently;
 *   2. rollbackAppend is HEAD-GUARDED — an operation that is no longer the
 *      head refuses to roll back (the chain never rewinds beneath op N+1);
 *   3. ReconcileService row-repair reinserts metadata the mirror lost and
 *      drops orphans whose authoritative row is gone.
 * Skipped without a test DB.
 */
class EncryptedMirrorDurabilityTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static SQLiteConnection $sqlite;
    private static string $sqlitePath = '';
    private static FormService $formService;
    private static ResponseService $responses;
    private static DataOperationLogService $opLog;

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
        self::$sqlitePath = sys_get_temp_dir() . '/fl-mirrordur-' . bin2hex(random_bytes(5));
        self::$sqlite = new SQLiteConnection(self::$sqlitePath);
        self::$formService = new FormService($conn, self::$sqlite);
        self::$responses = new ResponseService($conn, self::$sqlite);
        self::$opLog = new DataOperationLogService(
            $conn,
            new DataCloudSigner(sys_get_temp_dir() . '/fl-mirrordur-signer-' . bin2hex(random_bytes(4)) . '.key')
        );
        self::$responses->setDataOperationLog(self::$opLog);
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
            'title' => 'Mirror durability',
            'status' => 'published',
            'fields' => [
                ['id' => 'note', 'type' => 'short_text', 'label' => 'Note', 'required' => false, 'order' => 0, 'properties' => []],
            ],
        ]);
        $this->formId = $form['id'];
        self::$opLog->invalidatePlacementCache();
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        // Restore the mirror table if a failed test left it renamed away.
        try {
            self::$pdo->exec('RENAME TABLE response_metadata_flt TO response_metadata');
        } catch (\Throwable) {
            // not renamed — normal
        }
        self::$pdo->prepare('DELETE FROM data_placement_manifests WHERE dataset_id = ?')->execute([$this->formId]);
        self::$pdo->prepare('DELETE FROM data_dataset_high_water WHERE dataset_id = ?')->execute([$this->formId]);
        self::$pdo->prepare('DELETE FROM form_encryption WHERE form_id = ?')->execute([$this->formId]);
        self::$pdo->prepare('DELETE FROM response_metadata WHERE form_id = ?')->execute([$this->formId]);
        self::$pdo->prepare('DELETE FROM forms WHERE id = ?')->execute([$this->formId]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
    }

    private function placeAsPrivate(): void
    {
        self::$pdo->prepare("
            INSERT INTO form_encryption (form_id, mode, current_ingest_epoch, current_fk_epoch, state, enabled_by, enabled_at)
            VALUES (?, 'private', 1, 1, 'active', ?, NOW())
        ")->execute([$this->formId, $this->userId]);
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
        self::$opLog->invalidatePlacementCache();
    }

    public function testTransientMirrorFailureKeepsTheCommittedResponseAndReconciles(): void
    {
        $this->placeAsPrivate();
        $recordId = 'rec-' . bin2hex(random_bytes(10));

        // Fault injection: the MySQL mirror insert fails hard (table absent).
        self::$pdo->exec('RENAME TABLE response_metadata TO response_metadata_flt');
        try {
            $result = self::$responses->createEncryptedResponse(
                $this->formId,
                ['recordId' => $recordId, 'rev' => 1],
                null,
                null
            );
            $this->assertSame($recordId, $result['id'], 'the durably-committed response reports success');
        } finally {
            self::$pdo->exec('RENAME TABLE response_metadata_flt TO response_metadata');
        }

        // Authoritative store + signed chain are intact — nothing was rewound.
        $db = self::$sqlite->getFormDatabase($this->formId);
        $row = $db->prepare('SELECT COUNT(*) FROM responses WHERE id = ?');
        $row->execute([$recordId]);
        $this->assertSame(1, (int) $row->fetchColumn(), 'the authoritative row survives the mirror failure');
        $this->assertSame(1, (int) $db->query('SELECT COUNT(*) FROM replication_operations')->fetchColumn());
        $this->assertSame(1, (int) $db->query('SELECT last_sequence FROM op_log_state WHERE id = 1')->fetchColumn());

        // The mirror is missing — reconciliation restores it idempotently.
        $meta = self::$pdo->prepare('SELECT COUNT(*) FROM response_metadata WHERE id = ?');
        $meta->execute([$recordId]);
        $this->assertSame(0, (int) $meta->fetchColumn());

        $svc = new ReconcileService(self::$pdo, self::$sqlite, self::$sqlitePath, sys_get_temp_dir());
        $repair = $svc->repairResponseMirrors();
        $this->assertGreaterThanOrEqual(1, $repair['inserted']);
        $meta->execute([$recordId]);
        $this->assertSame(1, (int) $meta->fetchColumn(), 'reconciliation restores the metadata mirror');

        // Idempotent: a second pass changes nothing.
        $again = $svc->repairResponseMirrors();
        $this->assertNotContains($this->formId, $again['formsRepaired']);
    }

    public function testRollbackAppendRefusesWhenNoLongerTheHead(): void
    {
        $this->placeAsPrivate();
        $db = self::$sqlite->getFormDatabase($this->formId);
        self::$opLog->ensureLogSchema($db);
        $placement = self::$opLog->placementFor($this->formId);
        $this->assertNotNull($placement);
        $now = date('Y-m-d H:i:s');

        $envA = ['recordId' => 'rec-a', 'rev' => 1];
        $envB = ['recordId' => 'rec-b', 'rev' => 1];
        $ctxA = self::$opLog->appendCreate($db, $this->formId, $placement, $envA, json_encode($envA), $now);
        $ctxB = self::$opLog->appendCreate($db, $this->formId, $placement, $envB, json_encode($envB), $now);

        // Op A is BENEATH op B — rewinding would corrupt the chain: refused.
        $this->assertFalse(self::$opLog->rollbackAppend($db, $ctxA), 'a non-head op must refuse to roll back');
        $this->assertSame(2, (int) $db->query('SELECT COUNT(*) FROM replication_operations')->fetchColumn());
        $this->assertSame(2, (int) $db->query('SELECT last_sequence FROM op_log_state WHERE id = 1')->fetchColumn());

        // Op B IS the head — its rollback is the legal compensation.
        $this->assertTrue(self::$opLog->rollbackAppend($db, $ctxB));
        $this->assertSame(1, (int) $db->query('SELECT COUNT(*) FROM replication_operations')->fetchColumn());
        $this->assertSame(1, (int) $db->query('SELECT last_sequence FROM op_log_state WHERE id = 1')->fetchColumn());
    }

    public function testRowRepairRestoresMissingAndDropsOrphanedMetadata(): void
    {
        // Plain (unplaced) form: two real responses.
        $first = self::$responses->createResponse($this->formId, ['answers' => ['note' => 'one']]);
        $second = self::$responses->createResponse($this->formId, ['answers' => ['note' => 'two']]);
        $this->assertIsArray($first);
        $this->assertIsArray($second);

        // Simulate a lost mirror row + TWO orphaned ones. (One lost + one orphan
        // would keep the counts equal — the documented gate-evading swap shape —
        // so the fixture uses an unequal count that the repair targets.)
        self::$pdo->prepare('DELETE FROM response_metadata WHERE id = ?')->execute([$first['id']]);
        $orphanStmt = self::$pdo->prepare("INSERT INTO response_metadata (id, form_id, status, submitted_at) VALUES (?, ?, 'submitted', NOW())");
        $orphanStmt->execute(['orphan-' . bin2hex(random_bytes(8)), $this->formId]);
        $orphanStmt->execute(['orphan-' . bin2hex(random_bytes(8)), $this->formId]);

        $svc = new ReconcileService(self::$pdo, self::$sqlite, self::$sqlitePath, sys_get_temp_dir());
        $repair = $svc->repairResponseMirrors();
        $this->assertContains($this->formId, $repair['formsRepaired']);
        $this->assertGreaterThanOrEqual(1, $repair['inserted']);
        $this->assertGreaterThanOrEqual(1, $repair['orphansDeleted']);

        $meta = self::$pdo->prepare('SELECT COUNT(*) FROM response_metadata WHERE form_id = ?');
        $meta->execute([$this->formId]);
        $this->assertSame(2, (int) $meta->fetchColumn(), 'exactly the two authoritative rows are mirrored');
        $check = self::$pdo->prepare('SELECT COUNT(*) FROM response_metadata WHERE id = ?');
        $check->execute([$first['id']]);
        $this->assertSame(1, (int) $check->fetchColumn(), 'the lost mirror row is restored');
    }
}

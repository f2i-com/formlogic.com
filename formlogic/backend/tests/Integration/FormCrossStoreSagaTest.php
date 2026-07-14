<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\FormDeletionIncompleteException;
use FormLogic\Services\FormService;
use FormLogic\Services\ReconcileService;
use PDO;
use PDOStatement;
use PHPUnit\Framework\TestCase;

/**
 * SQLite double with injectable disk failures at the two cross-store boundaries:
 * opening/writing the per-form database (create/update fields save) and removing it
 * (delete cleanup).
 */
class SagaFailingSqliteConnection extends SQLiteConnection
{
    /** Open failures: -1 = never fail; N ≥ 0 = allow N more successful opens, then throw. */
    public int $failOpenAfter = -1;
    public bool $failDelete = false;

    public function getFormDatabase(string $formId): PDO
    {
        if ($this->failOpenAfter >= 0) {
            if ($this->failOpenAfter === 0) {
                throw new \PDOException('injected SQLite open failure');
            }
            $this->failOpenAfter--;
        }
        return parent::getFormDatabase($formId);
    }

    public function deleteFormDatabase(string $formId): bool
    {
        if ($this->failDelete) {
            return false; // simulate a locked/undeletable file — nothing removed
        }
        return parent::deleteFormDatabase($formId);
    }
}

/**
 * PDO double that fails exactly updateForm's metadata UPDATE (the only forms UPDATE
 * that binds :updated_at) — the MySQL side of the update saga.
 */
class SagaFailingPdo extends PDO
{
    public bool $failFormMetaUpdate = false;

    #[\ReturnTypeWillChange]
    public function prepare($query, $options = [])
    {
        if ($this->failFormMetaUpdate
            && str_contains($query, 'UPDATE forms SET')
            && str_contains($query, ':updated_at')) {
            throw new \PDOException('injected MySQL failure on forms metadata update');
        }
        return parent::prepare($query, $options);
    }
}

/**
 * Audit FL-DATA-001 — cross-store (MySQL ↔ per-form SQLite ↔ filesystem) form mutations
 * are sagas with durable op records, compensation, and verified completion. Failure
 * injection at every boundary must stay retryable, never expose a half-created object,
 * and never report success while the stores disagree. Skipped without a test DB.
 */
class FormCrossStoreSagaTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static SagaFailingSqliteConnection $sqlite;
    private static FormService $svc;
    /** @var array<string,mixed> */
    private static array $config;

    /** @var string[] */
    private array $formIds = [];
    /** @var string[] */
    private array $userIds = [];

    public static function setUpBeforeClass(): void
    {
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) {
            \Dotenv\Dotenv::createImmutable($root)->safeLoad();
        }
        self::$config = [
            'host' => $_ENV['DB_HOST'] ?? '127.0.0.1',
            'port' => $_ENV['DB_PORT'] ?? '3306',
            'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
            'username' => $_ENV['DB_USERNAME'] ?? 'root',
            'password' => $_ENV['DB_PASSWORD'] ?? '',
            'charset' => 'utf8mb4',
            'collation' => 'utf8mb4_unicode_ci',
        ];
        try {
            $conn = new MySQLConnection(self::$config);
            $conn->getConnection()->query('SELECT 1');
            $conn->initializeSchema();
            $conn->runMigrations();
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
        self::$mysql = $conn;
        self::$pdo = $conn->getConnection();
        self::$sqlite = new SagaFailingSqliteConnection(sys_get_temp_dir() . '/fl-saga-' . bin2hex(random_bytes(5)));
        self::$svc = new FormService($conn, self::$sqlite);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        self::$sqlite->failOpenAfter = -1;
        self::$sqlite->failDelete = false;
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        self::$sqlite->failOpenAfter = -1;
        self::$sqlite->failDelete = false;
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

    private function uuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }

    /** @return string the new form's id */
    private function makeForm(FormService $svc, string $userId, string $title = 'Before'): string
    {
        $id = $this->uuid();
        $this->formIds[] = $id;
        $svc->createForm([
            'id' => $id,
            'userId' => $userId,
            'title' => $title,
            'fields' => [
                ['id' => 'original_field', 'type' => 'short_text', 'label' => 'Original', 'required' => false, 'order' => 0, 'properties' => []],
            ],
        ]);
        return $id;
    }

    /** @return array<int,array<string,mixed>> */
    private function opsFor(string $formId): array
    {
        $stmt = self::$pdo->prepare("SELECT * FROM store_ops WHERE entity_type = 'form' AND entity_id = ?");
        $stmt->execute([$formId]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
    }

    private function formRow(string $formId): ?array
    {
        $stmt = self::$pdo->prepare('SELECT * FROM forms WHERE id = ?');
        $stmt->execute([$formId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row === false ? null : $row;
    }

    // ── create ────────────────────────────────────────────────────────────────

    public function testCreateCompensatesSoNoHalfCreatedFormIsExposed(): void
    {
        $userId = $this->makeUser();
        $id = $this->uuid();
        $this->formIds[] = $id;

        self::$sqlite->failOpenAfter = 0;
        try {
            self::$svc->createForm([
                'id' => $id,
                'userId' => $userId,
                'title' => 'Doomed',
                'fields' => [['id' => 'f1', 'type' => 'short_text', 'label' => 'F1', 'order' => 0]],
            ]);
            $this->fail('createForm must rethrow the fields-save failure');
        } catch (\PDOException $e) {
            // expected — the injected SQLite failure
        }

        $this->assertNull($this->formRow($id), 'the metadata row must be compensated away — no half-created form');
        $this->assertFalse(self::$sqlite->formDatabaseExists($id), 'no stray SQLite file');
        $this->assertSame([], $this->opsFor($id), 'compensated create leaves no pending op');
    }

    public function testCleanCreateLeavesNoPendingOps(): void
    {
        $userId = $this->makeUser();
        $formId = $this->makeForm(self::$svc, $userId);

        $form = self::$svc->getForm($formId);
        $this->assertNotNull($form);
        $this->assertCount(1, $form['fields']);
        $this->assertSame([], $this->opsFor($formId));
    }

    // ── delete ────────────────────────────────────────────────────────────────

    public function testDeleteDiskFailureIsTruthfulDurableAndResumable(): void
    {
        $userId = $this->makeUser();
        $formId = $this->makeForm(self::$svc, $userId);
        $this->assertTrue(self::$sqlite->formDatabaseExists($formId));

        // Boundary failure: metadata delete commits, disk cleanup fails.
        self::$sqlite->failDelete = true;
        try {
            self::$svc->deleteForm($formId);
            $this->fail('deleteForm must not report success while the stores disagree');
        } catch (FormDeletionIncompleteException $e) {
            // expected — truthful failure
        }

        $this->assertNull($this->formRow($formId), 'metadata delete committed');
        $this->assertTrue(self::$sqlite->formDatabaseExists($formId), 'SQLite file still on disk');
        $ops = $this->opsFor($formId);
        $this->assertCount(1, $ops, 'the durable delete intent survives');
        $this->assertSame('form_delete', $ops[0]['op_type']);
        $this->assertSame($userId, $ops[0]['user_id'], 'op attributes the pending PII to its owner');
        $this->assertSame(1, (int) $ops[0]['attempts']);
        $this->assertNotEmpty($ops[0]['last_error']);

        // The pending op is visible to reconciliation once past the in-flight age filter.
        self::$pdo->prepare("UPDATE store_ops SET created_at = NOW() - INTERVAL 120 SECOND WHERE entity_id = ?")
            ->execute([$formId]);
        $recon = new ReconcileService(self::$pdo, self::$sqlite, sys_get_temp_dir(), sys_get_temp_dir());
        $reported = array_filter($recon->pendingStoreOps(), fn (array $op) => $op['entityId'] === $formId);
        $this->assertCount(1, $reported, 'reconcile reports the pending op');

        // Repair the disk, retry the SAME call — the saga resumes and completes.
        self::$sqlite->failDelete = false;
        $this->assertTrue(self::$svc->deleteForm($formId), 'retry resumes the pending deletion');
        $this->assertFalse(self::$sqlite->formDatabaseExists($formId), 'disk verified clean');
        $this->assertSame([], $this->opsFor($formId), 'no pending work remains');
    }

    public function testResumePendingDeletionIsOwnerBound(): void
    {
        $userId = $this->makeUser();
        $formId = $this->makeForm(self::$svc, $userId);

        self::$sqlite->failDelete = true;
        try {
            self::$svc->deleteForm($formId);
            $this->fail('expected FormDeletionIncompleteException');
        } catch (FormDeletionIncompleteException $e) {
        }
        self::$sqlite->failDelete = false;

        $this->assertNull(self::$svc->resumePendingDeletion($formId, 'someone-else'), 'another user cannot resume (or probe) the deletion');
        $this->assertCount(1, $this->opsFor($formId), 'op untouched by the foreign attempt');

        $this->assertTrue(self::$svc->resumePendingDeletion($formId, $userId));
        $this->assertFalse(self::$sqlite->formDatabaseExists($formId));
        $this->assertSame([], $this->opsFor($formId));
    }

    public function testDeleteOfUnknownFormStillReturnsFalse(): void
    {
        $this->assertFalse(self::$svc->deleteForm($this->uuid()));
    }

    // ── update ────────────────────────────────────────────────────────────────

    public function testUpdateFieldsFailureLeavesMetadataUntouched(): void
    {
        $userId = $this->makeUser();
        $formId = $this->makeForm(self::$svc, $userId, 'Before');

        // updateForm READS the form first (one successful open), then the failure
        // hits exactly the fields-save boundary.
        self::$sqlite->failOpenAfter = 1;
        try {
            self::$svc->updateForm($formId, [
                'title' => 'After',
                'fields' => [['id' => 'new_field', 'type' => 'short_text', 'label' => 'New', 'order' => 0]],
            ]);
            $this->fail('updateForm must rethrow the fields-save failure');
        } catch (\PDOException $e) {
            // expected
        }
        self::$sqlite->failOpenAfter = -1;

        // Fields-first ordering: the MySQL row was never touched, so no partial update
        // (previously title/settings committed while the fields silently didn't).
        $this->assertSame('Before', $this->formRow($formId)['title']);
        $form = self::$svc->getForm($formId);
        $this->assertSame('original_field', $form['fields'][0]['id'] ?? null, 'original fields intact');

        // Compensation could not run (SQLite fully down), so the op stays pending —
        // conservative operator visibility rather than silent success.
        $ops = $this->opsFor($formId);
        $this->assertCount(1, $ops);
        $this->assertSame('form_update', $ops[0]['op_type']);
        $this->assertStringContainsString('compensation failed', (string) $ops[0]['last_error']);
    }

    public function testUpdateMysqlFailureRestoresPreviousFields(): void
    {
        // FormService over a PDO that fails exactly the forms metadata UPDATE.
        $proxy = new SagaFailingPdo(
            sprintf(
                'mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4',
                self::$config['host'],
                self::$config['port'],
                self::$config['database']
            ),
            self::$config['username'],
            self::$config['password'],
            [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]
        );
        $conn = new class (self::$config, $proxy) extends MySQLConnection {
            private PDO $proxyPdo;
            public function __construct(array $config, PDO $proxy)
            {
                parent::__construct($config);
                $this->proxyPdo = $proxy;
            }
            public function getConnection(): PDO
            {
                return $this->proxyPdo;
            }
        };
        $svc = new FormService($conn, self::$sqlite);

        $userId = $this->makeUser();
        $formId = $this->makeForm($svc, $userId, 'Before');

        $proxy->failFormMetaUpdate = true;
        try {
            $svc->updateForm($formId, [
                'title' => 'After',
                'fields' => [['id' => 'replacement_field', 'type' => 'short_text', 'label' => 'R', 'order' => 0]],
            ]);
            $this->fail('updateForm must rethrow the MySQL failure');
        } catch (\PDOException $e) {
            $this->assertStringContainsString('injected MySQL failure', $e->getMessage());
        }
        $proxy->failFormMetaUpdate = false;

        // All-or-nothing: MySQL untouched AND the already-saved new fields rolled back.
        $this->assertSame('Before', $this->formRow($formId)['title']);
        $form = $svc->getForm($formId);
        $this->assertCount(1, $form['fields']);
        $this->assertSame('original_field', $form['fields'][0]['id'] ?? null, 'previous fields restored');
        $this->assertSame([], $this->opsFor($formId), 'compensated update leaves no pending op');
    }

    // ── account-erasure support ──────────────────────────────────────────────

    public function testPendingCleanupIsUserScopedAndRetryable(): void
    {
        $userId = $this->makeUser();
        $otherUser = $this->makeUser();
        $f1 = $this->makeForm(self::$svc, $userId);
        $f2 = $this->makeForm(self::$svc, $userId);
        $f3 = $this->makeForm(self::$svc, $otherUser);

        self::$sqlite->failDelete = true;
        foreach ([$f1, $f2] as $fid) {
            try {
                self::$svc->deleteForm($fid);
                $this->fail('expected FormDeletionIncompleteException');
            } catch (FormDeletionIncompleteException $e) {
            }
        }

        $this->assertSame(2, self::$svc->pendingCleanupCount($userId));
        $this->assertSame(0, self::$svc->pendingCleanupCount($otherUser), 'other users unaffected');

        // Repair, then the user-scoped retry (the account-erasure resume path).
        self::$sqlite->failDelete = false;
        $result = self::$svc->retryPendingCleanup($userId);
        $this->assertSame(['retried' => 2, 'completed' => 2, 'stillPending' => 0], $result);
        $this->assertSame(0, self::$svc->pendingCleanupCount($userId));
        $this->assertFalse(self::$sqlite->formDatabaseExists($f1));
        $this->assertFalse(self::$sqlite->formDatabaseExists($f2));
        $this->assertTrue(self::$sqlite->formDatabaseExists($f3), 'other user\'s form untouched');
    }
}

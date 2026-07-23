<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use FormLogic\Support\DataCanonicalJson;

/**
 * N3b — the Cloud-primary signed operation log (plan §12, §27-N3;
 * docs/FORMLOGIC_DATA_NODES.md §12).
 *
 * For a Private form WITH an owner-signed placement (N3a baseline), every
 * envelope write appends an flop:1 operation — signed by the placement-bound
 * Cloud authority key, hash-chained, sequence-contiguous — in the SAME SQLite
 * transaction as the row mutation (plan §10.2), then refreshes a signed
 * flcheckpoint:1 head and the Cloud high-water anchor (data_dataset_high_water).
 * This log is the catch-up source Cloud→Desktop migration replays.
 *
 * legacy_cloud_primary forms (no signed placement) are untouched — no schema
 * changes, no ops — exactly as before.
 *
 * v1 caveats (documented in docs §12): the Cloud primary predates the N3c
 * lease service, so ops carry a random per-operation writeLeaseId and
 * fencingGeneration 1 (lease enforcement begins when a second primary is
 * possible). Head-checkpoint logical roots are recomputed O(n) per write —
 * fine at current scale; an incremental root is queued for N5.
 */
final class DataOperationLogService
{
    public const PROTOCOL = 'formlogic-data-sync/1';
    public const REPLICA_ID = 'cloud';

    /** @var array<string, array{storage_epoch: int, manifest_hash: string}|null> */
    private array $placementCache = [];

    public function __construct(
        private MySQLConnection $mysql,
        private DataCloudSigner $signer,
    ) {
    }

    /** The latest signed placement for a form, or null (legacy_cloud_primary). */
    public function placementFor(string $formId): ?array
    {
        if (array_key_exists($formId, $this->placementCache)) {
            return $this->placementCache[$formId];
        }
        $stmt = $this->mysql->getConnection()->prepare(
            'SELECT storage_epoch, manifest_hash FROM data_placement_manifests
             WHERE dataset_id = ? ORDER BY storage_epoch DESC LIMIT 1'
        );
        $stmt->execute([$formId]);
        $row = $stmt->fetch(\PDO::FETCH_ASSOC);
        return $this->placementCache[$formId] = (is_array($row)
            ? ['storage_epoch' => (int) $row['storage_epoch'], 'manifest_hash' => (string) $row['manifest_hash']]
            : null);
    }

    /** Test/request-boundary cache reset. */
    public function invalidatePlacementCache(): void
    {
        $this->placementCache = [];
    }

    /**
     * Idempotently add the replication tables + row-version columns to a
     * per-form SQLite database (plan §10.2 — the columns land BEFORE any
     * operation routing; existing rows read as row_version 1 / active).
     */
    public function ensureLogSchema(\PDO $db): void
    {
        $db->exec('CREATE TABLE IF NOT EXISTS replication_operations (
            operation_id TEXT PRIMARY KEY,
            storage_epoch INTEGER NOT NULL,
            sequence INTEGER NOT NULL UNIQUE,
            kind TEXT NOT NULL,
            entity_id TEXT,
            operation_hash TEXT NOT NULL,
            placement_manifest_hash TEXT NOT NULL,
            encryption_manifest_hash TEXT,
            write_lease_id TEXT NOT NULL,
            fencing_generation INTEGER NOT NULL,
            base_rev INTEGER,
            rev INTEGER,
            expected_row_version INTEGER,
            row_version INTEGER,
            cipher_hash TEXT,
            canonical_operation TEXT NOT NULL,
            origin_replica_id TEXT NOT NULL,
            previous_hash TEXT,
            signer_key_id TEXT NOT NULL,
            signer_key_generation INTEGER NOT NULL,
            signature TEXT NOT NULL,
            committed_at TEXT NOT NULL
        )');
        $db->exec('CREATE TABLE IF NOT EXISTS op_log_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            storage_epoch INTEGER NOT NULL,
            last_sequence INTEGER NOT NULL DEFAULT 0,
            last_operation_hash TEXT,
            head_checkpoint TEXT
        )');
        $columns = [];
        foreach ($db->query('PRAGMA table_info(responses)')->fetchAll(\PDO::FETCH_ASSOC) as $col) {
            $columns[(string) $col['name']] = true;
        }
        if (!isset($columns['row_version'])) {
            $db->exec("ALTER TABLE responses ADD COLUMN row_version INTEGER NOT NULL DEFAULT 1");
        }
        if (!isset($columns['lifecycle_state'])) {
            $db->exec("ALTER TABLE responses ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'active'");
        }
        if (!isset($columns['trashed_at'])) {
            $db->exec('ALTER TABLE responses ADD COLUMN trashed_at TEXT');
        }
    }

    /**
     * Append a response.create operation INSIDE the caller's open SQLite
     * transaction. Returns the rollback context for the caller's
     * compensation path (MySQL mirror-gate failure).
     *
     * @param array<string,mixed> $envelope
     * @param array{storage_epoch: int, manifest_hash: string} $placement
     * @return array{operationId: string, previous: array{last_sequence: int, last_operation_hash: ?string, head_checkpoint: ?string}}
     */
    public function appendCreate(\PDO $db, string $formId, array $placement, array $envelope, string $answersJson, string $now): array
    {
        return $this->appendOp($db, $formId, $placement, 'response.create', $envelope, $answersJson, [
            'rev' => (int) ($envelope['rev'] ?? 1),
            'rowVersion' => 1,
        ], $now);
    }

    /**
     * Append a response.envelope.put operation INSIDE the caller's open
     * transaction (after its CAS UPDATE succeeded).
     *
     * @param array<string,mixed> $envelope
     * @param array{storage_epoch: int, manifest_hash: string} $placement
     * @return array{operationId: string, previous: array{last_sequence: int, last_operation_hash: ?string, head_checkpoint: ?string}}
     */
    public function appendEnvelopePut(
        \PDO $db,
        string $formId,
        array $placement,
        array $envelope,
        string $answersJson,
        int $expectedRev,
        int $newRowVersion,
        string $now,
    ): array {
        return $this->appendOp($db, $formId, $placement, 'response.envelope.put', $envelope, $answersJson, [
            'baseRev' => $expectedRev,
            'rev' => (int) ($envelope['rev'] ?? $expectedRev + 1),
            'expectedRowVersion' => $newRowVersion - 1,
            'rowVersion' => $newRowVersion,
        ], $now);
    }

    /**
     * Compensate a just-appended operation whose row mutation must be undone
     * (MySQL mirror-gate POLICY refusal — not-a-private-form / duplicate id).
     * The op was never acknowledged or served; state rewinds to the captured
     * previous head.
     *
     * HEAD-GUARDED (audit FL-04): committed signed history must NEVER rewind
     * beneath a later append. The rollback is only legal while the compensated
     * operation is provably still the head (state.last_sequence ==
     * previous.last_sequence + 1); a concurrent append after it makes the
     * rewind corrupt the chain under op N+1, so this REFUSES (returns false,
     * logs loudly) and the caller must leave the row in place too.
     *
     * @param array{operationId: string, previous: array{last_sequence: int, last_operation_hash: ?string, head_checkpoint: ?string}} $context
     * @return bool true when the op was rolled back; false when it is no longer the head
     */
    public function rollbackAppend(\PDO $db, array $context): bool
    {
        $expectedHeadSequence = (int) $context['previous']['last_sequence'] + 1;
        $state = $db->query('SELECT last_sequence FROM op_log_state WHERE id = 1')
            ->fetch(\PDO::FETCH_ASSOC);
        if ($state === false || (int) $state['last_sequence'] !== $expectedHeadSequence) {
            error_log(sprintf(
                'DataOperationLogService: REFUSING rollbackAppend of %s — sequence %d is no longer the head (state at %s); the signed chain never rewinds beneath a later append (audit FL-04)',
                (string) $context['operationId'],
                $expectedHeadSequence,
                $state === false ? 'unknown' : (string) $state['last_sequence']
            ));
            return false;
        }
        $db->prepare('DELETE FROM replication_operations WHERE operation_id = ?')
            ->execute([$context['operationId']]);
        $db->prepare('UPDATE op_log_state SET last_sequence = ?, last_operation_hash = ?, head_checkpoint = ? WHERE id = 1')
            ->execute([
                $context['previous']['last_sequence'],
                $context['previous']['last_operation_hash'],
                $context['previous']['head_checkpoint'],
            ]);
        return true;
    }

    /** Push the committed head into the Cloud anchor (best-effort redundancy). */
    public function syncHighWater(string $formId): void
    {
        $state = $this->mysqlHighWaterSource($formId);
        if ($state === null) {
            return;
        }
        $this->mysql->getConnection()->prepare(
            'INSERT INTO data_dataset_high_water
                (dataset_id, storage_epoch, last_acknowledged_sequence, last_operation_hash,
                 checkpoint_hash, placement_manifest_hash, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                storage_epoch = VALUES(storage_epoch),
                last_acknowledged_sequence = VALUES(last_acknowledged_sequence),
                last_operation_hash = VALUES(last_operation_hash),
                checkpoint_hash = VALUES(checkpoint_hash),
                placement_manifest_hash = VALUES(placement_manifest_hash),
                updated_at = VALUES(updated_at)'
        )->execute([
            $formId,
            $state['storage_epoch'],
            $state['last_sequence'],
            $state['last_operation_hash'],
            $state['checkpoint_hash'],
            $state['placement_manifest_hash'],
            gmdate('Y-m-d H:i:s'),
        ]);
    }

    /** The stored signed head checkpoint (decoded), or null. */
    public function headCheckpoint(\PDO $db): ?array
    {
        try {
            $raw = $db->query('SELECT head_checkpoint FROM op_log_state WHERE id = 1')->fetchColumn();
        } catch (\PDOException) {
            return null;
        }
        if (!is_string($raw) || $raw === '') {
            return null;
        }
        $decoded = json_decode($raw, true);
        return is_array($decoded) ? $decoded : null;
    }

    /** @return list<string> canonical operation JSON strings, sequence order */
    public function operationLines(\PDO $db): array
    {
        try {
            $rows = $db->query('SELECT canonical_operation FROM replication_operations ORDER BY sequence')
                ->fetchAll(\PDO::FETCH_COLUMN);
        } catch (\PDOException) {
            return [];
        }
        return array_map('strval', $rows);
    }

    // ── internals ────────────────────────────────────────────────────────────

    /** @param array<string,mixed> $envelope */
    private function appendOp(
        \PDO $db,
        string $formId,
        array $placement,
        string $kind,
        array $envelope,
        string $answersJson,
        array $casFields,
        string $now,
    ): array {
        $state = $db->query('SELECT last_sequence, last_operation_hash, head_checkpoint, storage_epoch FROM op_log_state WHERE id = 1')
            ->fetch(\PDO::FETCH_ASSOC);
        if (!is_array($state)) {
            $db->prepare('INSERT INTO op_log_state (id, storage_epoch, last_sequence, last_operation_hash, head_checkpoint) VALUES (1, ?, 0, NULL, NULL)')
                ->execute([$placement['storage_epoch']]);
            $state = ['last_sequence' => 0, 'last_operation_hash' => null, 'head_checkpoint' => null, 'storage_epoch' => $placement['storage_epoch']];
        }
        $previous = [
            'last_sequence' => (int) $state['last_sequence'],
            'last_operation_hash' => $state['last_operation_hash'] !== null ? (string) $state['last_operation_hash'] : null,
            'head_checkpoint' => $state['head_checkpoint'] !== null ? (string) $state['head_checkpoint'] : null,
        ];
        $sequence = $previous['last_sequence'] + 1;
        $cipherHash = hash('sha256', $answersJson);
        $recordId = (string) ($envelope['recordId'] ?? '');
        $createdAt = str_replace(' ', 'T', $now) . 'Z';
        $identity = $this->signer->publicIdentity();

        $op = [
            'protocol' => self::PROTOCOL,
            'operationId' => $this->uuidV4(),
            'datasetId' => $formId,
            'placementManifestHash' => $placement['manifest_hash'],
            'encryptionManifestHash' => $this->encryptionManifestHash($formId, $envelope),
            'storageEpoch' => $placement['storage_epoch'],
            // Pre-lease Cloud primary (docs §12): random per-op lease id,
            // fencing generation 1, until the N3c lease service exists.
            'writeLeaseId' => $this->uuidV4(),
            'fencingGeneration' => 1,
            'sequence' => $sequence,
            'kind' => $kind,
            'entityId' => $recordId,
            'cipherHash' => $cipherHash,
            'payload' => ['envelope' => $envelope, 'updatedAt' => $createdAt],
            'originReplicaId' => self::REPLICA_ID,
            'previousOperationHash' => $previous['last_operation_hash'],
            'createdAt' => $createdAt,
            'signerKeyId' => $identity['keyId'],
            'signerKeyGeneration' => 1,
        ] + $casFields;
        $op['signature'] = $this->signer->sign(DataCanonicalJson::DOMAIN_OPERATION, $op);
        $opHash = DataCanonicalJson::hashHex(
            DataCanonicalJson::DOMAIN_OPERATION,
            array_diff_key($op, ['signature' => true]),
        );
        $canonicalOperation = json_encode($op, JSON_UNESCAPED_SLASHES);
        if ($canonicalOperation === false) {
            throw new \RuntimeException('operation does not serialize');
        }

        $db->prepare('INSERT INTO replication_operations
            (operation_id, storage_epoch, sequence, kind, entity_id, operation_hash,
             placement_manifest_hash, encryption_manifest_hash, write_lease_id, fencing_generation,
             base_rev, rev, expected_row_version, row_version, cipher_hash, canonical_operation,
             origin_replica_id, previous_hash, signer_key_id, signer_key_generation, signature, committed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )->execute([
            $op['operationId'], $op['storageEpoch'], $sequence, $kind, $recordId, $opHash,
            $op['placementManifestHash'], $op['encryptionManifestHash'], $op['writeLeaseId'], 1,
            $casFields['baseRev'] ?? null, $casFields['rev'] ?? null,
            $casFields['expectedRowVersion'] ?? null, $casFields['rowVersion'] ?? null,
            $cipherHash, $canonicalOperation, self::REPLICA_ID, $previous['last_operation_hash'],
            $op['signerKeyId'], 1, $op['signature'], $now,
        ]);

        $head = $this->buildHeadCheckpoint($db, $formId, $placement, $sequence, $opHash, $previous['head_checkpoint'], $createdAt);
        $db->prepare('UPDATE op_log_state SET storage_epoch = ?, last_sequence = ?, last_operation_hash = ?, head_checkpoint = ? WHERE id = 1')
            ->execute([$placement['storage_epoch'], $sequence, $opHash, $head]);

        return ['operationId' => $op['operationId'], 'previous' => $previous];
    }

    /**
     * The exact accepted public manifest this envelope names (plan §12.2:
     * "resolves to exactly one already committed immutable signed public-form
     * manifest") — pinned as sha256 of the manifest row's exact signed bytes.
     * @param array<string,mixed> $envelope
     */
    private function encryptionManifestHash(string $formId, array $envelope): ?string
    {
        $stmt = $this->mysql->getConnection()->prepare(
            'SELECT signed_bytes FROM form_manifests
             WHERE form_id = ? AND key_id = ? AND ingest_epoch = ? AND schema_version = ? AND schema_hash = ?
             LIMIT 1'
        );
        $stmt->execute([
            $formId,
            (string) ($envelope['keyId'] ?? ''),
            (int) ($envelope['epoch'] ?? 0),
            (int) ($envelope['schemaVersion'] ?? 0),
            (string) ($envelope['schemaHash'] ?? ''),
        ]);
        $bytes = $stmt->fetchColumn();
        return is_string($bytes) ? hash('sha256', $bytes) : null;
    }

    /** Signed flcheckpoint:1 head over the CURRENT (in-transaction) state. */
    private function buildHeadCheckpoint(
        \PDO $db,
        string $formId,
        array $placement,
        int $sequence,
        string $opHash,
        ?string $previousHeadJson,
        string $createdAt,
    ): string {
        $entries = [];
        $recordCount = 0;
        $rows = $db->query('SELECT id, row_version, answers FROM responses WHERE lifecycle_state = \'active\'');
        foreach ($rows->fetchAll(\PDO::FETCH_ASSOC) as $row) {
            $answers = (string) $row['answers'];
            $rev = json_decode($answers, true)['rev'] ?? 0;
            $entries[] = ['response', (string) $row['id'], (int) $row['row_version'], (int) $rev, hash('sha256', $answers)];
            $recordCount++;
        }
        $artifactLines = DataControlArtifacts::linesFor($this->mysql->getConnection(), $formId);
        foreach (DataControlArtifacts::rootEntries($artifactLines) as $entry) {
            $entries[] = $entry;
        }
        $logicalRoot = DataCanonicalJson::logicalRootHex($formId, $entries);

        $previousHash = null;
        if (is_string($previousHeadJson) && $previousHeadJson !== '') {
            $prev = json_decode($previousHeadJson, true);
            if (is_array($prev)) {
                $previousHash = DataCanonicalJson::hashHex(
                    DataCanonicalJson::DOMAIN_CHECKPOINT,
                    array_diff_key($prev, ['signature' => true]),
                );
            }
        }
        $identity = $this->signer->publicIdentity();
        $checkpoint = [
            'protocol' => self::PROTOCOL,
            'datasetId' => $formId,
            'placementManifestHash' => $placement['manifest_hash'],
            'storageEpoch' => $placement['storage_epoch'],
            'lastSequence' => $sequence,
            'lastOperationHash' => $opHash,
            'recordCount' => $recordCount,
            'tombstoneCount' => 0,
            'tombstoneLedgerCoverageSequence' => 0,
            'tombstoneLedgerRoot' => null,
            'attachmentCount' => 0,
            'chunkCount' => 0,
            'versionsRepresented' => $this->versionsRepresented($formId),
            'logicalRoot' => $logicalRoot,
            'previousCheckpointHash' => $previousHash,
            'replicaId' => self::REPLICA_ID,
            'createdAt' => $createdAt,
            'signerKeyId' => $identity['keyId'],
            'signerKeyGeneration' => 1,
        ];
        $checkpoint['signature'] = $this->signer->sign(DataCanonicalJson::DOMAIN_CHECKPOINT, $checkpoint);
        $json = json_encode($checkpoint, JSON_UNESCAPED_SLASHES);
        if ($json === false) {
            throw new \RuntimeException('checkpoint does not serialize');
        }
        return $json;
    }

    /** @return array{schemaVersions: list<int>, ingestEpochs: list<int>, fkEpochs: list<int>} */
    private function versionsRepresented(string $formId): array
    {
        $pdo = $this->mysql->getConnection();
        $col = static fn(\PDOStatement $s): array => array_values(array_map('intval', $s->fetchAll(\PDO::FETCH_COLUMN)));
        $sv = $pdo->prepare('SELECT DISTINCT version FROM form_schema_versions WHERE form_id = ? ORDER BY version');
        $sv->execute([$formId]);
        $ie = $pdo->prepare('SELECT DISTINCT epoch FROM form_ingestion_keys WHERE form_id = ? ORDER BY epoch');
        $ie->execute([$formId]);
        $fk = $pdo->prepare('SELECT DISTINCT fk_epoch FROM form_ingestion_keys WHERE form_id = ? ORDER BY fk_epoch');
        $fk->execute([$formId]);
        return ['schemaVersions' => $col($sv), 'ingestEpochs' => $col($ie), 'fkEpochs' => $col($fk)];
    }

    /** MySQL high-water source values read back from the committed sqlite state. */
    private function mysqlHighWaterSource(string $formId): ?array
    {
        // The caller just committed; reopen the same per-form database handle
        // through its own connection cache is the ResponseService's job — here
        // we read via a lightweight direct query using the head we maintain.
        return $this->pendingHighWater[$formId] ?? null;
    }

    /** @var array<string, array<string,mixed>> */
    private array $pendingHighWater = [];

    /** Called by the writer after COMMIT with the head it just persisted. */
    public function stageHighWater(\PDO $db, string $formId): void
    {
        $state = $db->query('SELECT storage_epoch, last_sequence, last_operation_hash, head_checkpoint FROM op_log_state WHERE id = 1')
            ->fetch(\PDO::FETCH_ASSOC);
        if (!is_array($state)) {
            return;
        }
        $checkpointHash = null;
        $head = json_decode((string) $state['head_checkpoint'], true);
        if (is_array($head)) {
            $checkpointHash = DataCanonicalJson::hashHex(
                DataCanonicalJson::DOMAIN_CHECKPOINT,
                array_diff_key($head, ['signature' => true]),
            );
        }
        $this->pendingHighWater[$formId] = [
            'storage_epoch' => (int) $state['storage_epoch'],
            'last_sequence' => (int) $state['last_sequence'],
            'last_operation_hash' => $state['last_operation_hash'],
            'checkpoint_hash' => $checkpointHash,
            'placement_manifest_hash' => is_array($head) ? ($head['placementManifestHash'] ?? null) : null,
        ];
    }

    private function uuidV4(): string
    {
        $data = random_bytes(16);
        $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
        $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Support\DataCanonicalJson;

/**
 * N2 — Cloud-primary Desktop snapshots (plan §18, §27-N2;
 * docs/FORMLOGIC_DATA_NODES.md §9).
 *
 * Builds a portable LOGICAL data-only package of one Private form's dataset:
 * canonical __flenc envelopes (exact stored bytes, transferred as opaque
 * strings so no re-encode can drift a cipherHash), the form's signed/wrapped
 * E2EE control artifacts, empty tombstone/operation logs (no op log until N3),
 * a synthesized Cloud checkpoint, and a signed backup manifest with per-file
 * hashes + the flroot:1 logical root. Contains NO raw key of any kind — every
 * secret stays in its existing wrapped form (plan §18.2).
 *
 * Read-only over live data: the Cloud placement/SQLite files are never
 * changed (N2 gate). Packages are staged under <storage>/data-snapshots/<id>/
 * for the authenticated desktop to download file-by-file, then deleted
 * (explicitly or by TTL sweep).
 *
 * Frozen N2 package pins (docs/FORMLOGIC_DATA_NODES.md §9):
 * - responses.ndjson.enc line: {id, status, submittedAt, updatedAt,
 *   rowVersion, lifecycleState, trashedAt, rev, cipherHash, answersRaw}.
 *   The Cloud per-form schema has no row-version columns yet (they arrive
 *   with N3 operation routing), so rowVersion=1 / lifecycleState=active /
 *   trashedAt=null are DERIVED defaults.
 * - control.ndjson line: {kind: manifest|schema|ingestion|grant, id, ...}.
 *   An artifact's logical-root hash is sha256 over the EXACT line bytes.
 * - logical root entries: ["response", id, rowVersion, rev, cipherHash] and
 *   ["artifact", kind, id, lineSha256] (matches the desktop store).
 * - legacy_cloud_primary (no signed placement yet): storageEpoch 0,
 *   checkpoint placementManifestHash null, no placement-manifest.json.
 */
final class DataSnapshotService
{
    public const PROTOCOL = 'formlogic-data-sync/1';
    /** Refuse to stage packages beyond this total (the N3 relay adds real chunking). */
    public const MAX_PACKAGE_BYTES = 268_435_456; // 256 MiB
    public const SNAPSHOT_TTL_SECONDS = 3600;

    private const PACKAGE_FILES = [
        'backup-index.json',
        'manifests/checkpoint.json',
        'data/responses.ndjson.enc',
        'data/control.ndjson',
        'data/tombstones.ndjson',
        'data/operations.ndjson',
    ];

    private DataStagedArtifactIndex $artifacts;

    public function __construct(
        private MySQLConnection $mysql,
        private SQLiteConnection $sqlite,
        private DataCloudSigner $signer,
        private string $snapshotRoot,
    ) {
        $this->artifacts = new DataStagedArtifactIndex($mysql);
    }

    /**
     * Private forms of this owner that are snapshot-eligible.
     * @return list<array{formId: string, title: string, responses: int, state: string}>
     */
    public function eligibleForms(string $ownerUserId): array
    {
        $pdo = $this->mysql->getConnection();
        $stmt = $pdo->prepare(
            'SELECT f.id, f.title, fe.state FROM forms f
             JOIN form_encryption fe ON fe.form_id = f.id
             WHERE f.user_id = ? AND fe.mode = "private" AND fe.state IN ("active", "enabling")
             ORDER BY f.title'
        );
        $stmt->execute([$ownerUserId]);
        $out = [];
        foreach ($stmt->fetchAll(\PDO::FETCH_ASSOC) as $row) {
            $count = 0;
            if ($this->sqlite->formDatabaseExists($row['id'])) {
                $count = (int) $this->sqlite->getFormDatabase($row['id'])
                    ->query('SELECT count(*) FROM responses')->fetchColumn();
            }
            $out[] = [
                'formId' => $row['id'],
                'title' => (string) $row['title'],
                'responses' => $count,
                'state' => (string) $row['state'],
            ];
        }
        return $out;
    }

    /**
     * Build a snapshot package. Returns the manifest plus download metadata.
     *
     * @return array{snapshotId: string, backupId: string, manifest: array<string,mixed>, files: list<array{path: string, sha256: string, bytes: int}>}
     */
    public function createSnapshot(string $ownerUserId, string $formId, ?string $nodeId = null): array
    {
        $this->sweepExpired();
        $pdo = $this->mysql->getConnection();
        $stmt = $pdo->prepare(
            'SELECT f.id, fe.state, fe.current_ingest_epoch, fe.current_fk_epoch FROM forms f
             JOIN form_encryption fe ON fe.form_id = f.id
             WHERE f.id = ? AND f.user_id = ? AND fe.mode = "private" AND fe.state IN ("active", "enabling")'
        );
        $stmt->execute([$formId, $ownerUserId]);
        $form = $stmt->fetch(\PDO::FETCH_ASSOC);
        if ($form === false) {
            // Plaintext forms are structurally ineligible (plan §3.3): a
            // data-only package may carry ONLY E2EE envelopes.
            throw new \RuntimeException('snapshot_form_ineligible');
        }

        $snapshotId = bin2hex(random_bytes(16));
        $backupId = sprintf(
            '%s-%s-%s',
            gmdate('Ymd\THis\Z'),
            substr($formId, 0, 8),
            substr($snapshotId, 0, 8)
        );
        $dir = $this->snapshotDir($snapshotId);
        if (!mkdir($dir, 0700, true) && !is_dir($dir)) {
            throw new \RuntimeException('could not create the snapshot staging directory');
        }
        foreach (['manifests', 'data'] as $sub) {
            if (!mkdir($dir . '/' . $sub, 0700, true) && !is_dir($dir . '/' . $sub)) {
                throw new \RuntimeException('could not create the snapshot staging directory');
            }
        }
        // Ownership row FIRST (review FL-002): the artifact is bound to its
        // owner/node before any content exists; a crash mid-build leaves an
        // expired row + dir the sweep finishes.
        $this->artifacts->record($snapshotId, DataStagedArtifactIndex::KIND_SNAPSHOT, $ownerUserId, $nodeId, self::SNAPSHOT_TTL_SECONDS);

        try {
            return $this->buildPackage($dir, $snapshotId, $backupId, $ownerUserId, $formId);
        } catch (\Throwable $e) {
            $this->purgeSnapshotFiles($snapshotId);
            $this->artifacts->finishDelete($snapshotId);
            throw $e;
        }
    }

    /** @return array{snapshotId: string, backupId: string, manifest: array<string,mixed>, files: list<array{path: string, sha256: string, bytes: int}>} */
    private function buildPackage(string $dir, string $snapshotId, string $backupId, string $ownerUserId, string $formId): array
    {
        $now = gmdate('Y-m-d\TH:i:s\Z');
        $rootEntries = [];
        $schemaVersions = [];
        $ingestEpochs = [];
        $fkEpochs = [];

        // ── responses.ndjson.enc — exact stored envelope bytes, opaque ──────
        // All per-form SQLite reads (rows + op log + head state) happen inside
        // ONE read transaction so a concurrent write cannot interleave between
        // them (WAL snapshot isolation).
        $responseCount = 0;
        $responsesLines = [];
        $opLines = [];
        $storedHead = null;
        if ($this->sqlite->formDatabaseExists($formId)) {
            $formDb = $this->sqlite->getFormDatabase($formId);
            $formDb->beginTransaction();
            try {
                try {
                    $rows = $formDb->query(
                        'SELECT id, answers, status, submitted_at, updated_at, row_version, lifecycle_state, trashed_at
                         FROM responses ORDER BY id'
                    )->fetchAll(\PDO::FETCH_ASSOC);
                } catch (\PDOException) {
                    // Legacy form: the N3b columns do not exist yet.
                    $rows = $formDb->query(
                        'SELECT id, answers, status, submitted_at, updated_at FROM responses ORDER BY id'
                    )->fetchAll(\PDO::FETCH_ASSOC);
                }
                foreach ($rows as $row) {
                    $answersRaw = (string) $row['answers'];
                    $envelope = json_decode($answersRaw, true);
                    if (!is_array($envelope) || ($envelope['__flenc'] ?? null) !== 1) {
                        // A non-envelope row inside a Private form is corruption,
                        // not exportable data (review: authoritative tri-state).
                        throw new \RuntimeException('snapshot_corrupt_row: non-envelope answers in a private form');
                    }
                    $rev = (int) ($envelope['rev'] ?? 1);
                    $rowVersion = (int) ($row['row_version'] ?? 1);
                    $cipherHash = hash('sha256', $answersRaw);
                    $line = json_encode([
                        'id' => (string) $row['id'],
                        'status' => (string) ($row['status'] ?? 'submitted'),
                        'submittedAt' => (string) ($row['submitted_at'] ?? ''),
                        'updatedAt' => (string) ($row['updated_at'] ?? ''),
                        'rowVersion' => $rowVersion,
                        'lifecycleState' => (string) ($row['lifecycle_state'] ?? 'active'),
                        'trashedAt' => $row['trashed_at'] ?? null,
                        'rev' => $rev,
                        'cipherHash' => $cipherHash,
                        'answersRaw' => $answersRaw,
                    ], JSON_UNESCAPED_SLASHES);
                    if ($line === false) {
                        throw new \RuntimeException('snapshot response row does not serialize');
                    }
                    $responsesLines[] = $line;
                    $rootEntries[] = ['response', (string) $row['id'], $rowVersion, $rev, $cipherHash];
                    $responseCount++;
                }
                // N3b op log: real operation history + the signed head checkpoint.
                try {
                    $opLines = array_map('strval', $formDb
                        ->query('SELECT canonical_operation FROM replication_operations ORDER BY sequence')
                        ->fetchAll(\PDO::FETCH_COLUMN));
                    $headRaw = $formDb->query('SELECT head_checkpoint FROM op_log_state WHERE id = 1')->fetchColumn();
                    if (is_string($headRaw) && $headRaw !== '') {
                        $decoded = json_decode($headRaw, true);
                        if (is_array($decoded)) {
                            $storedHead = $decoded;
                        }
                    }
                } catch (\PDOException) {
                    // Legacy form: no op log yet.
                }
                $formDb->commit();
            } catch (\Throwable $e) {
                if ($formDb->inTransaction()) {
                    $formDb->rollBack();
                }
                throw $e;
            }
        }
        $this->writeFile($dir . '/data/responses.ndjson.enc', implode("\n", $responsesLines) . ($responsesLines ? "\n" : ''));

        // ── control.ndjson — signed/wrapped E2EE control artifacts ───────────
        // SHARED line builder (DataControlArtifacts): the per-write head
        // checkpoints hash these exact bytes, so packages and checkpoints can
        // never disagree about an artifact's root entry.
        $pdo = $this->mysql->getConnection();
        $artifactLines = DataControlArtifacts::linesFor($pdo, $formId);
        $controlLines = [];
        foreach ($artifactLines as $artifact) {
            $controlLines[] = $artifact['line'];
            $decoded = json_decode($artifact['line'], true);
            if (is_array($decoded)) {
                if (isset($decoded['schemaVersion'])) {
                    $schemaVersions[(int) $decoded['schemaVersion']] = true;
                }
                if ($artifact['kind'] === 'schema' && isset($decoded['version'])) {
                    $schemaVersions[(int) $decoded['version']] = true;
                }
                if (isset($decoded['ingestEpoch'])) {
                    $ingestEpochs[(int) $decoded['ingestEpoch']] = true;
                }
                if ($artifact['kind'] === 'ingestion' && isset($decoded['epoch'])) {
                    $ingestEpochs[(int) $decoded['epoch']] = true;
                }
                if (isset($decoded['fkEpoch'])) {
                    $fkEpochs[(int) $decoded['fkEpoch']] = true;
                }
            }
        }
        foreach (DataControlArtifacts::rootEntries($artifactLines) as $entry) {
            $rootEntries[] = $entry;
        }
        $this->writeFile($dir . '/data/control.ndjson', implode("\n", $controlLines) . ($controlLines ? "\n" : ''));

        // Tombstones arrive with the N3c continuity ledger; operations are the
        // REAL signed history when the form has an op log (empty for legacy).
        $this->writeFile($dir . '/data/tombstones.ndjson', '');
        $this->writeFile($dir . '/data/operations.ndjson', implode("\n", $opLines) . ($opLines ? "\n" : ''));

        $logicalRoot = DataCanonicalJson::logicalRootHex($formId, $rootEntries);
        $identity = $this->signer->publicIdentity();

        ksort($schemaVersions);
        ksort($ingestEpochs);
        ksort($fkEpochs);
        $versionsRepresented = [
            'schemaVersions' => array_map('intval', array_keys($schemaVersions)),
            'ingestEpochs' => array_map('intval', array_keys($ingestEpochs)),
            'fkEpochs' => array_map('intval', array_keys($fkEpochs)),
        ];

        if ($storedHead !== null) {
            // N3b: the REAL primary-signed head checkpoint rides along verbatim
            // (its own signature stays valid). Its logicalRoot reflects state at
            // the last WRITE — a later control-artifact publish can lag until
            // the N3c publication barrier sequences those too; the package
            // manifest's own logicalRoot below is always the packaged truth.
            $checkpoint = $storedHead;
        } else {
            // Synthesized checkpoint for legacy_cloud_primary (epoch 0).
            $checkpoint = [
                'protocol' => self::PROTOCOL,
                'datasetId' => $formId,
                'placementManifestHash' => null,
                'storageEpoch' => 0,
                'lastSequence' => 0,
                'lastOperationHash' => null,
                'recordCount' => $responseCount,
                'tombstoneCount' => 0,
                'tombstoneLedgerCoverageSequence' => 0,
                'tombstoneLedgerRoot' => null,
                'attachmentCount' => 0,
                'chunkCount' => 0,
                'versionsRepresented' => $versionsRepresented,
                'logicalRoot' => $logicalRoot,
                'previousCheckpointHash' => null,
                'replicaId' => 'cloud',
                'createdAt' => $now,
                'signerKeyId' => $identity['keyId'],
                'signerKeyGeneration' => 1,
            ];
            $checkpoint['signature'] = $this->signer->sign(DataCanonicalJson::DOMAIN_CHECKPOINT, $checkpoint);
        }
        $checkpointHash = DataCanonicalJson::hashHex(
            DataCanonicalJson::DOMAIN_CHECKPOINT,
            array_diff_key($checkpoint, ['signature' => true]),
        );
        $this->writeFile($dir . '/manifests/checkpoint.json', $this->encodePretty($checkpoint));

        $this->writeFile($dir . '/backup-index.json', $this->encodePretty([
            'v' => 1,
            'backupId' => $backupId,
            'backupType' => 'data_only',
            'formId' => $formId,
            'datasetId' => $formId,
            'legacyCloudPrimary' => true,
            'createdAt' => $now,
        ]));

        // ── signed backup manifest over every packaged file ──────────────────
        $files = [];
        $totalBytes = 0;
        foreach (self::PACKAGE_FILES as $path) {
            $bytes = (string) file_get_contents($dir . '/' . $path);
            $files[] = ['path' => $path, 'sha256' => hash('sha256', $bytes), 'bytes' => strlen($bytes)];
            $totalBytes += strlen($bytes);
        }
        if ($totalBytes > self::MAX_PACKAGE_BYTES) {
            throw new \RuntimeException('snapshot_too_large');
        }
        $manifest = [
            'protocol' => self::PROTOCOL,
            'formatVersion' => 1,
            'backupType' => 'data_only',
            'backupId' => $backupId,
            'accountId' => $ownerUserId,
            'sourceReplicaId' => 'cloud',
            'datasets' => [['datasetId' => $formId, 'formId' => $formId]],
            'createdAt' => $now,
            'storageEpoch' => (int) ($checkpoint['storageEpoch'] ?? 0),
            'checkpointHash' => $checkpointHash,
            'lastSequence' => (int) ($checkpoint['lastSequence'] ?? 0),
            'lastOperationHash' => $checkpoint['lastOperationHash'] ?? null,
            'counts' => [
                'responses' => $responseCount,
                'tombstones' => 0,
                'attachments' => 0,
                'chunks' => 0,
            ],
            'versionsRepresented' => $versionsRepresented,
            'files' => $files,
            'logicalRoot' => $logicalRoot,
            'incrementalParent' => null,
            'requiredRestoreCapabilities' => [self::PROTOCOL],
            'signerKeyId' => $identity['keyId'],
            'signerKeyGeneration' => 1,
            'authorityCertificateRef' => null,
            'signature' => '',
        ];
        unset($manifest['signature']);
        $manifest['signature'] = $this->signer->sign(DataCanonicalJson::DOMAIN_BACKUP, $manifest);
        $this->writeFile($dir . '/manifests/backup-manifest.json', $this->encodePretty($manifest));

        return [
            'snapshotId' => $snapshotId,
            'backupId' => $backupId,
            'manifest' => $manifest,
            'files' => $files,
        ];
    }

    /**
     * Absolute path of a staged package file, or null when the caller does not
     * own the snapshot or the path is outside the allowlist. Ownership misses
     * and missing IDs are indistinguishable (review FL-002).
     */
    public function snapshotFilePath(string $ownerUserId, string $snapshotId, string $relativePath): ?string
    {
        if (!preg_match('/^[0-9a-f]{32}$/', $snapshotId)) {
            return null;
        }
        if (!$this->artifacts->resolveOwned($snapshotId, DataStagedArtifactIndex::KIND_SNAPSHOT, $ownerUserId)) {
            return null;
        }
        $allowed = array_merge(self::PACKAGE_FILES, ['manifests/backup-manifest.json']);
        if (!in_array($relativePath, $allowed, true)) {
            return null;
        }
        $path = $this->snapshotDir($snapshotId) . '/' . $relativePath;
        return is_file($path) ? $path : null;
    }

    /**
     * Owner-checked delete. Returns false — leaving every file and the
     * ownership row untouched — when the caller does not own the snapshot.
     */
    public function deleteSnapshotOwned(string $ownerUserId, string $snapshotId): bool
    {
        if (!preg_match('/^[0-9a-f]{32}$/', $snapshotId)) {
            return false;
        }
        if (!$this->artifacts->beginDelete($snapshotId, DataStagedArtifactIndex::KIND_SNAPSHOT, $ownerUserId)) {
            return false;
        }
        $this->purgeSnapshotFiles($snapshotId);
        $this->artifacts->finishDelete($snapshotId);
        return true;
    }

    /** Unlink staged files without any ownership semantics (internal + sweep). */
    private function purgeSnapshotFiles(string $snapshotId): void
    {
        if (!preg_match('/^[0-9a-f]{32}$/', $snapshotId)) {
            return;
        }
        $dir = $this->snapshotDir($snapshotId);
        if (!is_dir($dir)) {
            return;
        }
        $it = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::CHILD_FIRST,
        );
        foreach ($it as $item) {
            $item->isDir() ? @rmdir($item->getPathname()) : @unlink($item->getPathname());
        }
        @rmdir($dir);
    }

    public function sweepExpired(): void
    {
        // Finish crash-interrupted deletes and expire stale rows first…
        foreach ($this->artifacts->sweepable(DataStagedArtifactIndex::KIND_SNAPSHOT) as $id) {
            $this->purgeSnapshotFiles($id);
            $this->artifacts->finishDelete($id);
        }
        // …then reap orphan directories (pre-ownership-index stagings or rows
        // lost to a partial failure) by mtime.
        if (!is_dir($this->snapshotRoot)) {
            return;
        }
        foreach ((array) scandir($this->snapshotRoot) as $entry) {
            if (!is_string($entry) || !preg_match('/^[0-9a-f]{32}$/', $entry)) {
                continue;
            }
            $dir = $this->snapshotRoot . '/' . $entry;
            if (is_dir($dir) && filemtime($dir) < time() - self::SNAPSHOT_TTL_SECONDS) {
                $this->purgeSnapshotFiles($entry);
                $this->artifacts->finishDelete($entry);
            }
        }
    }

    private function snapshotDir(string $snapshotId): string
    {
        return $this->snapshotRoot . '/' . $snapshotId;
    }

    private function writeFile(string $path, string $content): void
    {
        if (file_put_contents($path, $content) === false) {
            throw new \RuntimeException('could not write snapshot file ' . basename($path));
        }
    }

    private function encodePretty(array $value): string
    {
        $json = json_encode($value, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
        if ($json === false) {
            throw new \RuntimeException('snapshot JSON does not serialize');
        }
        return $json . "\n";
    }
}

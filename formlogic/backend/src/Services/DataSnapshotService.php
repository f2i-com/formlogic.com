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

    public function __construct(
        private MySQLConnection $mysql,
        private SQLiteConnection $sqlite,
        private DataCloudSigner $signer,
        private string $snapshotRoot,
    ) {
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
    public function createSnapshot(string $ownerUserId, string $formId): array
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

        try {
            return $this->buildPackage($dir, $snapshotId, $backupId, $ownerUserId, $formId);
        } catch (\Throwable $e) {
            $this->deleteSnapshot($snapshotId);
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
        $responseCount = 0;
        $responsesLines = [];
        if ($this->sqlite->formDatabaseExists($formId)) {
            $rows = $this->sqlite->getFormDatabase($formId)->query(
                'SELECT id, answers, status, submitted_at, updated_at FROM responses ORDER BY id'
            );
            foreach ($rows->fetchAll(\PDO::FETCH_ASSOC) as $row) {
                $answersRaw = (string) $row['answers'];
                $envelope = json_decode($answersRaw, true);
                if (!is_array($envelope) || ($envelope['__flenc'] ?? null) !== 1) {
                    // A non-envelope row inside a Private form is corruption,
                    // not exportable data (review: authoritative tri-state).
                    throw new \RuntimeException('snapshot_corrupt_row: non-envelope answers in a private form');
                }
                $rev = (int) ($envelope['rev'] ?? 1);
                $cipherHash = hash('sha256', $answersRaw);
                $line = json_encode([
                    'id' => (string) $row['id'],
                    'status' => (string) ($row['status'] ?? 'submitted'),
                    'submittedAt' => (string) ($row['submitted_at'] ?? ''),
                    'updatedAt' => (string) ($row['updated_at'] ?? ''),
                    'rowVersion' => 1,
                    'lifecycleState' => 'active',
                    'trashedAt' => null,
                    'rev' => $rev,
                    'cipherHash' => $cipherHash,
                    'answersRaw' => $answersRaw,
                ], JSON_UNESCAPED_SLASHES);
                if ($line === false) {
                    throw new \RuntimeException('snapshot response row does not serialize');
                }
                $responsesLines[] = $line;
                $rootEntries[] = ['response', (string) $row['id'], 1, $rev, $cipherHash];
                $responseCount++;
            }
        }
        $this->writeFile($dir . '/data/responses.ndjson.enc', implode("\n", $responsesLines) . ($responsesLines ? "\n" : ''));

        // ── control.ndjson — signed/wrapped E2EE control artifacts ───────────
        $pdo = $this->mysql->getConnection();
        $controlLines = [];
        $addArtifact = function (string $kind, string $id, array $fields) use (&$controlLines, &$rootEntries): void {
            $line = json_encode(['kind' => $kind, 'id' => $id] + $fields, JSON_UNESCAPED_SLASHES);
            if ($line === false) {
                throw new \RuntimeException('snapshot control artifact does not serialize');
            }
            $controlLines[] = $line;
            $rootEntries[] = ['artifact', $kind, $id, hash('sha256', $line)];
        };

        $stmt = $pdo->prepare('SELECT * FROM form_manifests WHERE form_id = ? ORDER BY manifest_seq');
        $stmt->execute([$formId]);
        foreach ($stmt->fetchAll(\PDO::FETCH_ASSOC) as $m) {
            $schemaVersions[(int) $m['schema_version']] = true;
            $ingestEpochs[(int) $m['ingest_epoch']] = true;
            $addArtifact('manifest', (string) $m['id'], [
                'manifestSeq' => (int) $m['manifest_seq'],
                'keyId' => (string) $m['key_id'],
                'ingestEpoch' => (int) $m['ingest_epoch'],
                'schemaVersion' => (int) $m['schema_version'],
                'schemaHash' => (string) $m['schema_hash'],
                'contentSuite' => (string) $m['content_suite'],
                'wrapSuite' => (string) $m['wrap_suite'],
                'signerKeyId' => (string) $m['signer_key_id'],
                'signerPk' => (string) $m['signer_pk'],
                'signedBytes' => base64_encode((string) $m['signed_bytes']),
                'signature' => base64_encode((string) $m['signature']),
                'createdAt' => (string) $m['created_at'],
                'expiresAt' => $m['expires_at'],
                'supersededAt' => $m['superseded_at'],
            ]);
        }
        $stmt = $pdo->prepare('SELECT * FROM form_schema_versions WHERE form_id = ? ORDER BY version');
        $stmt->execute([$formId]);
        foreach ($stmt->fetchAll(\PDO::FETCH_ASSOC) as $s) {
            $schemaVersions[(int) $s['version']] = true;
            $addArtifact('schema', (string) $s['id'], [
                'version' => (int) $s['version'],
                'schemaJson' => base64_encode((string) $s['schema_json']),
                'schemaHash' => (string) $s['schema_hash'],
                'createdAt' => (string) $s['created_at'],
            ]);
        }
        $stmt = $pdo->prepare('SELECT * FROM form_ingestion_keys WHERE form_id = ? ORDER BY epoch');
        $stmt->execute([$formId]);
        foreach ($stmt->fetchAll(\PDO::FETCH_ASSOC) as $k) {
            $ingestEpochs[(int) $k['epoch']] = true;
            $fkEpochs[(int) $k['fk_epoch']] = true;
            $addArtifact('ingestion', (string) $k['id'], [
                'epoch' => (int) $k['epoch'],
                'publicKey' => (string) $k['public_key'],
                'wrappedSecret' => base64_encode((string) $k['wrapped_secret']),
                'fkEpoch' => (int) $k['fk_epoch'],
                'state' => (string) $k['state'],
                'acceptUntil' => $k['accept_until'],
                'createdAt' => (string) $k['created_at'],
            ]);
        }
        $stmt = $pdo->prepare('SELECT * FROM form_key_grants WHERE form_id = ? ORDER BY fk_epoch, user_id');
        $stmt->execute([$formId]);
        foreach ($stmt->fetchAll(\PDO::FETCH_ASSOC) as $g) {
            $fkEpochs[(int) $g['fk_epoch']] = true;
            $addArtifact('grant', (string) $g['id'], [
                'userId' => (string) $g['user_id'],
                'fkEpoch' => (int) $g['fk_epoch'],
                'wrappedKey' => base64_encode((string) $g['wrapped_key']),
                'wrapSuite' => (string) $g['wrap_suite'],
                'role' => (string) $g['role'],
                'grantorUserId' => (string) $g['grantor_user_id'],
                'grantorKeyId' => (string) $g['grantor_key_id'],
                'granteePk' => (string) $g['grantee_pk'],
                'sigVersion' => (int) $g['sig_version'],
                'signature' => base64_encode((string) $g['signature']),
                'expiresAt' => $g['expires_at'],
                'state' => (string) $g['state'],
            ]);
        }
        $this->writeFile($dir . '/data/control.ndjson', implode("\n", $controlLines) . ($controlLines ? "\n" : ''));

        // No tombstone/operation history exists before N3 — present but empty,
        // so a restorer never has to guess whether the logs were omitted.
        $this->writeFile($dir . '/data/tombstones.ndjson', '');
        $this->writeFile($dir . '/data/operations.ndjson', '');

        $logicalRoot = DataCanonicalJson::logicalRootHex($formId, $rootEntries);
        $identity = $this->signer->publicIdentity();

        // ── synthesized Cloud checkpoint (legacy_cloud_primary: epoch 0) ────
        ksort($schemaVersions);
        ksort($ingestEpochs);
        ksort($fkEpochs);
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
            'versionsRepresented' => [
                'schemaVersions' => array_map('intval', array_keys($schemaVersions)),
                'ingestEpochs' => array_map('intval', array_keys($ingestEpochs)),
                'fkEpochs' => array_map('intval', array_keys($fkEpochs)),
            ],
            'logicalRoot' => $logicalRoot,
            'previousCheckpointHash' => null,
            'replicaId' => 'cloud',
            'createdAt' => $now,
            'signerKeyId' => $identity['keyId'],
            'signerKeyGeneration' => 1,
        ];
        $checkpoint['signature'] = $this->signer->sign(DataCanonicalJson::DOMAIN_CHECKPOINT, $checkpoint);
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
            'storageEpoch' => 0,
            'checkpointHash' => $checkpointHash,
            'lastSequence' => 0,
            'lastOperationHash' => null,
            'counts' => [
                'responses' => $responseCount,
                'tombstones' => 0,
                'attachments' => 0,
                'chunks' => 0,
            ],
            'versionsRepresented' => $checkpoint['versionsRepresented'],
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

    /** Absolute path of a staged package file, or null when outside the allowlist. */
    public function snapshotFilePath(string $snapshotId, string $relativePath): ?string
    {
        if (!preg_match('/^[0-9a-f]{32}$/', $snapshotId)) {
            return null;
        }
        $allowed = array_merge(self::PACKAGE_FILES, ['manifests/backup-manifest.json']);
        if (!in_array($relativePath, $allowed, true)) {
            return null;
        }
        $path = $this->snapshotDir($snapshotId) . '/' . $relativePath;
        return is_file($path) ? $path : null;
    }

    public function deleteSnapshot(string $snapshotId): void
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
        if (!is_dir($this->snapshotRoot)) {
            return;
        }
        foreach ((array) scandir($this->snapshotRoot) as $entry) {
            if (!is_string($entry) || !preg_match('/^[0-9a-f]{32}$/', $entry)) {
                continue;
            }
            $dir = $this->snapshotRoot . '/' . $entry;
            if (is_dir($dir) && filemtime($dir) < time() - self::SNAPSHOT_TTL_SECONDS) {
                $this->deleteSnapshot($entry);
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

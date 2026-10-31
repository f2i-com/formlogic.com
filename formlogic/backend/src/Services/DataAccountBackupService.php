<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Support\BackupEnvelope;
use FormLogic\Support\DataCanonicalJson;

/**
 * Whole-account backup to a linked Desktop, sealed END-TO-END for transfer
 * (docs/FORMLOGIC_DATA_NODES.md §10).
 *
 * Unlike the Private-form snapshot lane (already-E2EE envelopes), an account
 * backup CONTAINS PLAINTEXT form data — that is its point: the user wants a
 * desktop-held copy of everything, encrypted or not. So the archive is sealed
 * BEFORE it leaves this service:
 *
 *   1. the requesting desktop sends a fresh ephemeral X25519 public key over
 *      the authenticated API channel;
 *   2. we build the existing AccountBackupService zip, mint a random 32-byte
 *      file key + our own ephemeral X25519 pair, box the file key to the
 *      desktop key (sodium crypto_box), and chunk-encrypt the zip with
 *      XChaCha20-Poly1305 (nonce = 16-byte base || 64-bit BE chunk index; AAD
 *      binds backupId + index + count, so truncation/reorder fails closed);
 *   3. the plaintext zip is deleted; only the sealed payload + a
 *      DataCloudSigner-signed header are staged for download.
 *
 * Nothing between this function and the requesting desktop's in-memory
 * ephemeral secret — relays, staging disk, HTTP layers — sees plaintext. The
 * desktop re-encrypts at rest under its own node storage key; recovery of the
 * local copy therefore needs THAT desktop (the Cloud original remains the
 * primary). TLS still wraps the hop; this sealing is not a substitute for the
 * record-level E2EE of Private forms.
 */
final class DataAccountBackupService
{
    public const PROTOCOL = 'formlogic-data-sync/1';
    public const CIPHER = 'xchacha20p1305-chunked.1';
    public const CHUNK_BYTES = 4_194_304; // 4 MiB
    public const MAX_ZIP_BYTES = 268_435_456; // 256 MiB — matches the snapshot cap
    public const TTL_SECONDS = 3600;
    /** Domain prefix of the node-signed ephemeral-key challenge (review FL-001). */
    public const REQUEST_SIGNATURE_DOMAIN = 'flaccountreq:1';
    /** The same challenge for one app or form, sealed to a key that outlives this computer. */
    public const SOURCE_SIGNATURE_DOMAIN = 'flsourcebackup:1';
    /** And for putting a backup back: it names the bytes, so a signature can't be reused for others. */
    public const RESTORE_SIGNATURE_DOMAIN = 'flsourcerestore:1';
    /** Freshness window for the signed challenge, either direction. */
    public const REQUEST_SIGNATURE_WINDOW_SECONDS = 600;
    /** A restore is signed before it is sent, and a large one on a slow line takes a while to arrive. */
    public const RESTORE_SIGNATURE_WINDOW_SECONDS = 3600;

    private DataStagedArtifactIndex $artifacts;

    public function __construct(
        private AccountBackupService $backups,
        private DataCloudSigner $signer,
        private string $stagingRoot,
        \FormLogic\Database\MySQLConnection $mysql,
    ) {
        $this->artifacts = new DataStagedArtifactIndex($mysql);
    }

    /**
     * Build a sealed account backup for the requesting node's ephemeral key.
     *
     * The transfer key is BOUND to the approved node (review FL-001): the
     * request must carry an Ed25519 signature by the node's enrolled signing
     * key over `flaccountreq:1|<requestedAt>|<ephemeralPk>`, with requestedAt
     * inside a short freshness window. An attacker holding only the API key
     * cannot substitute their own X25519 key — they cannot produce the node
     * signature — so a captured request can only ever seal data back to the
     * enrolled desktop.
     *
     * @param array<string,mixed> $request {ephemeralPk, requestedAt, ephemeralPkSignature}
     * @param array<string,mixed> $node    the resolved approved data_nodes row
     * @return array{backupId: string, header: array<string,mixed>}
     */
    public function create(string $userId, array $request, array $node): array
    {
        $this->sweepExpired();
        $desktopEphemeralPkB64 = (string) ($request['ephemeralPk'] ?? '');
        $desktopPk = base64_decode($desktopEphemeralPkB64, true);
        if (!is_string($desktopPk) || strlen($desktopPk) !== SODIUM_CRYPTO_BOX_PUBLICKEYBYTES) {
            throw new \RuntimeException('account_backup_bad_ephemeral_key');
        }
        $requestedAt = (string) ($request['requestedAt'] ?? '');
        $ts = DataNodeService::parseRfc3339Utc($requestedAt);
        if ($ts === null || abs(time() - $ts) > self::REQUEST_SIGNATURE_WINDOW_SECONDS) {
            throw new \RuntimeException('account_backup_key_unbound');
        }
        $sig = base64_decode((string) ($request['ephemeralPkSignature'] ?? ''), true);
        $nodePk = base64_decode((string) ($node['signing_public_key'] ?? ''), true);
        $message = self::REQUEST_SIGNATURE_DOMAIN . '|' . $requestedAt . '|' . $desktopEphemeralPkB64;
        if (
            !is_string($sig) || strlen($sig) !== SODIUM_CRYPTO_SIGN_BYTES
            || !is_string($nodePk) || strlen($nodePk) !== SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES
            || !sodium_crypto_sign_verify_detached($sig, $message, $nodePk)
        ) {
            throw new \RuntimeException('account_backup_key_unbound');
        }

        $zipPath = $this->backups->exportAccount($userId);
        try {
            $zipBytes = (int) filesize($zipPath);
            if ($zipBytes <= 0 || $zipBytes > self::MAX_ZIP_BYTES) {
                throw new \RuntimeException('account_backup_too_large');
            }
            $zipSha = hash_file('sha256', $zipPath);
            if (!is_string($zipSha)) {
                throw new \RuntimeException('could not hash the backup archive');
            }

            $backupId = 'acct-' . bin2hex(random_bytes(16));
            $dir = $this->stagingRoot . '/' . $backupId;
            if (!mkdir($dir, 0700, true) && !is_dir($dir)) {
                throw new \RuntimeException('could not create the account-backup staging directory');
            }
            // Ownership row FIRST (review FL-002): bound to owner + node before
            // any sealed byte exists.
            $this->artifacts->record(
                $backupId,
                DataStagedArtifactIndex::KIND_ACCOUNT_BACKUP,
                $userId,
                is_string($node['id'] ?? null) ? $node['id'] : null,
                self::TTL_SECONDS,
            );

            $fileKey = random_bytes(32);
            $baseNonce = random_bytes(16);
            $cloudPair = sodium_crypto_box_keypair();
            $cloudPk = sodium_crypto_box_publickey($cloudPair);
            $cloudSk = sodium_crypto_box_secretkey($cloudPair);
            $keyNonce = random_bytes(SODIUM_CRYPTO_BOX_NONCEBYTES);
            $boxPair = sodium_crypto_box_keypair_from_secretkey_and_publickey($cloudSk, $desktopPk);
            $wrappedKey = sodium_crypto_box($fileKey, $keyNonce, $boxPair);

            $chunkCount = (int) ceil($zipBytes / self::CHUNK_BYTES);
            $in = fopen($zipPath, 'rb');
            $out = fopen($dir . '/payload.bin', 'wb');
            if ($in === false || $out === false) {
                throw new \RuntimeException('could not stage the sealed payload');
            }
            try {
                for ($i = 0; $i < $chunkCount; $i++) {
                    $chunk = (string) fread($in, self::CHUNK_BYTES);
                    if ($chunk === '') {
                        throw new \RuntimeException('backup archive shrank while sealing');
                    }
                    $nonce = $baseNonce . pack('J', $i);
                    $aad = sprintf('flaccount:1|%s|%d|%d', $backupId, $i, $chunkCount);
                    $ct = sodium_crypto_aead_xchacha20poly1305_ietf_encrypt($chunk, $aad, $nonce, $fileKey);
                    fwrite($out, pack('N', strlen($ct)) . $ct);
                }
            } finally {
                fclose($in);
                fclose($out);
            }

            // Real content counts for the catalog/UI, read from the archive's
            // own manifest (forms/apps/flows/responses/files) and SIGNED with
            // the header so a tampered count cannot misrepresent a backup.
            $counts = ['forms' => 0, 'apps' => 0, 'flows' => 0, 'responses' => 0, 'files' => 0];
            $za = new \ZipArchive();
            if ($za->open($zipPath) === true) {
                $manifestRaw = $za->getFromName('manifest.json');
                if (is_string($manifestRaw)) {
                    $decoded = json_decode($manifestRaw, true);
                    foreach (array_keys($counts) as $key) {
                        $counts[$key] = (int) ($decoded['counts'][$key] ?? 0);
                    }
                }
                $za->close();
            }

            $identity = $this->signer->publicIdentity();
            $header = [
                'v' => 1,
                'kind' => 'account-backup',
                'counts' => $counts,
                'protocol' => self::PROTOCOL,
                'backupId' => $backupId,
                'accountId' => $userId,
                'createdAt' => gmdate('Y-m-d\TH:i:s\Z'),
                'cipher' => self::CIPHER,
                'chunkBytes' => self::CHUNK_BYTES,
                'chunkCount' => $chunkCount,
                'zipBytes' => $zipBytes,
                'zipSha256' => $zipSha,
                'baseNonce' => base64_encode($baseNonce),
                'cloudEphemeralPk' => base64_encode($cloudPk),
                'keyNonce' => base64_encode($keyNonce),
                'wrappedKey' => base64_encode($wrappedKey),
                'signerKeyId' => $identity['keyId'],
                'signerKeyGeneration' => 1,
            ];
            // Same signer + flbackup:1 domain as snapshot manifests; the signed
            // `kind` field is what verifiers dispatch on, so an account header
            // can never pass where a snapshot manifest is expected (both sides
            // check kind before anything else).
            $header['signature'] = $this->signer->sign(DataCanonicalJson::DOMAIN_BACKUP, $header);
            file_put_contents($dir . '/header.json', json_encode($header, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT) . "\n");

            sodium_memzero($fileKey);
            sodium_memzero($cloudSk);
            return ['backupId' => $backupId, 'header' => $header];
        } finally {
            @unlink($zipPath);
        }
    }

    /**
     * One app or form, sealed for the requesting node as a BackupEnvelope.
     *
     * Unlike create(), the key is not ephemeral: a backup kept for years must open after this
     * computer is gone, so the desktop holds a long-term key with its own recovery. The rule is
     * the same: the enrolled node signs the key and what it asks for, so a stolen API key can't
     * name a key of its own, or turn one request into a request for something else.
     *
     * @param array<string,mixed> $request {kind, id, recipientPk, requestedAt, recipientPkSignature}
     * @param array<string,mixed> $node    the resolved approved data_nodes row
     * @return array{backupId: string, header: array<string,mixed>}
     */
    public function createSource(string $userId, array $request, array $node): array
    {
        $this->sweepExpired();
        $kind = (string) ($request['kind'] ?? '');
        $id = (string) ($request['id'] ?? '');
        $recipientB64 = (string) ($request['recipientPk'] ?? '');
        $recipient = base64_decode($recipientB64, true);
        if (!in_array($kind, ['app', 'form'], true) || preg_match('/^[a-zA-Z0-9_-]{1,100}$/D', $id) !== 1) {
            throw new \RuntimeException('source_backup_bad_source');
        }
        if (!is_string($recipient) || strlen($recipient) !== SODIUM_CRYPTO_BOX_PUBLICKEYBYTES) {
            throw new \RuntimeException('account_backup_bad_ephemeral_key');
        }
        $requestedAt = (string) ($request['requestedAt'] ?? '');
        $this->assertSignedByNode(
            $node,
            $requestedAt,
            self::SOURCE_SIGNATURE_DOMAIN . '|' . $requestedAt . '|' . $recipientB64 . '|' . $kind . '|' . $id,
            (string) ($request['recipientPkSignature'] ?? ''),
            self::REQUEST_SIGNATURE_WINDOW_SECONDS,
        );

        $zipPath = $this->backups->exportSource($userId, $kind, $id);
        try {
            $zipBytes = (int) filesize($zipPath);
            // Not more than a restore takes: a backup that can't be put back is no backup.
            if ($zipBytes <= 0 || $zipBytes > min(self::MAX_ZIP_BYTES, $this->backups->maxImportBytes())) {
                throw new \RuntimeException('account_backup_too_large');
            }
            $backupId = 'acct-' . bin2hex(random_bytes(16));
            $dir = $this->stagingRoot . '/' . $backupId;
            if (!mkdir($dir, 0700, true) && !is_dir($dir)) {
                throw new \RuntimeException('could not create the account-backup staging directory');
            }
            $this->artifacts->record(
                $backupId,
                DataStagedArtifactIndex::KIND_ACCOUNT_BACKUP,
                $userId,
                is_string($node['id'] ?? null) ? $node['id'] : null,
                self::TTL_SECONDS,
            );
            BackupEnvelope::seal($zipPath, $dir . '/payload.bin', ['publicKey' => $recipient]);

            $identity = $this->signer->publicIdentity();
            $header = [
                'v' => 1,
                'kind' => 'source-backup',
                'source' => ['kind' => $kind, 'id' => $id, 'name' => $this->sourceName($zipPath, $kind)],
                'counts' => $this->countsIn($zipPath),
                'protocol' => self::PROTOCOL,
                'backupId' => $backupId,
                'accountId' => $userId,
                'createdAt' => gmdate('Y-m-d\TH:i:s\Z'),
                'cipher' => BackupEnvelope::CIPHER,
                'zipBytes' => $zipBytes,
                'zipSha256' => (string) hash_file('sha256', $zipPath),
                'signerKeyId' => $identity['keyId'],
                'signerKeyGeneration' => 1,
            ];
            $header['signature'] = $this->signer->sign(DataCanonicalJson::DOMAIN_BACKUP, $header);
            file_put_contents($dir . '/header.json', json_encode($header, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT) . "\n");
            return ['backupId' => $backupId, 'header' => $header];
        } finally {
            @unlink($zipPath);
        }
    }

    /**
     * Puts a backup back as new copies, as Settings → Restore does.
     *
     * @param array<string,mixed> $node
     * @return array<string,mixed> the importAccount summary
     */
    public function restoreSource(string $userId, string $zipPath, string $requestedAt, string $signature, array $node): array
    {
        $this->assertSignedByNode(
            $node,
            $requestedAt,
            self::RESTORE_SIGNATURE_DOMAIN . '|' . $requestedAt . '|' . hash_file('sha256', $zipPath),
            $signature,
            self::RESTORE_SIGNATURE_WINDOW_SECONDS,
        );
        return $this->backups->importAccount($zipPath, $userId);
    }

    /** See AccountBackupService::scratchFile. */
    public function scratchFile(string $suffix): string
    {
        return $this->backups->scratchFile($suffix);
    }

    /** @param array<string,mixed> $node */
    private function assertSignedByNode(array $node, string $requestedAt, string $message, string $signature, int $window): void
    {
        $ts = DataNodeService::parseRfc3339Utc($requestedAt);
        if ($ts === null || abs(time() - $ts) > $window) {
            throw new \RuntimeException('account_backup_key_unbound');
        }
        $sig = base64_decode($signature, true);
        $nodePk = base64_decode((string) ($node['signing_public_key'] ?? ''), true);
        if (
            !is_string($sig) || strlen($sig) !== SODIUM_CRYPTO_SIGN_BYTES
            || !is_string($nodePk) || strlen($nodePk) !== SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES
            || !sodium_crypto_sign_verify_detached($sig, $message, $nodePk)
        ) {
            throw new \RuntimeException('account_backup_key_unbound');
        }
    }

    /** @return array<string,int> what the archive's own manifest counted */
    private function countsIn(string $zipPath): array
    {
        $counts = ['forms' => 0, 'apps' => 0, 'flows' => 0, 'responses' => 0, 'files' => 0];
        $za = new \ZipArchive();
        if ($za->open($zipPath) === true) {
            $decoded = json_decode((string) $za->getFromName('manifest.json'), true);
            foreach (array_keys($counts) as $key) {
                $counts[$key] = (int) ($decoded['counts'][$key] ?? 0);
            }
            $za->close();
        }
        return $counts;
    }

    private function sourceName(string $zipPath, string $kind): string
    {
        $za = new \ZipArchive();
        if ($za->open($zipPath) !== true) {
            return '';
        }
        $structure = json_decode((string) $za->getFromName('backup.json'), true);
        $za->close();
        return (string) ($kind === 'app' ? ($structure['apps'][0]['name'] ?? '') : ($structure['forms'][0]['title'] ?? ''));
    }

    /**
     * Absolute payload path, or null when the caller does not own the staged
     * backup. Ownership misses and unknown IDs are indistinguishable
     * (review FL-002).
     */
    public function payloadPath(string $ownerUserId, string $backupId): ?string
    {
        if (!preg_match('/^acct-[0-9a-f]{32}$/', $backupId)) {
            return null;
        }
        if (!$this->artifacts->resolveOwned($backupId, DataStagedArtifactIndex::KIND_ACCOUNT_BACKUP, $ownerUserId)) {
            return null;
        }
        $path = $this->stagingRoot . '/' . $backupId . '/payload.bin';
        return is_file($path) ? $path : null;
    }

    /**
     * Owner-checked delete. Returns false — leaving files and metadata
     * untouched — when the caller does not own the staged backup.
     */
    public function deleteOwned(string $ownerUserId, string $backupId): bool
    {
        if (!preg_match('/^acct-[0-9a-f]{32}$/', $backupId)) {
            return false;
        }
        if (!$this->artifacts->beginDelete($backupId, DataStagedArtifactIndex::KIND_ACCOUNT_BACKUP, $ownerUserId)) {
            return false;
        }
        $this->purgeFiles($backupId);
        $this->artifacts->finishDelete($backupId);
        return true;
    }

    /** Unlink staged files without ownership semantics (internal + sweep). */
    private function purgeFiles(string $backupId): void
    {
        if (!preg_match('/^acct-[0-9a-f]{32}$/', $backupId)) {
            return;
        }
        $dir = $this->stagingRoot . '/' . $backupId;
        foreach (['payload.bin', 'header.json'] as $f) {
            @unlink($dir . '/' . $f);
        }
        @rmdir($dir);
    }

    public function sweepExpired(): void
    {
        foreach ($this->artifacts->sweepable(DataStagedArtifactIndex::KIND_ACCOUNT_BACKUP) as $id) {
            $this->purgeFiles($id);
            $this->artifacts->finishDelete($id);
        }
        if (!is_dir($this->stagingRoot)) {
            return;
        }
        foreach ((array) scandir($this->stagingRoot) as $entry) {
            if (!is_string($entry) || !preg_match('/^acct-[0-9a-f]{32}$/', $entry)) {
                continue;
            }
            $dir = $this->stagingRoot . '/' . $entry;
            if (is_dir($dir) && filemtime($dir) < time() - self::TTL_SECONDS) {
                $this->purgeFiles($entry);
                $this->artifacts->finishDelete($entry);
            }
        }
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Services;

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
    /** Freshness window for the signed challenge, either direction. */
    public const REQUEST_SIGNATURE_WINDOW_SECONDS = 600;

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

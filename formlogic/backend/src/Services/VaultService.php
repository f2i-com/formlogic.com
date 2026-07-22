<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use PDO;

/**
 * E2EE user vault storage (docs/E2EE_PRIVATE_FORMS_PLAN.md §5/§7/§16-P2).
 *
 * The server stores ONLY wrapped/sealed material: the Argon2id-derived
 * passphrase key never leaves the browser; wrapped_umk / wrapped_umk_recovery /
 * enc_key_bundle are XChaCha20-Poly1305 blobs the server cannot open. Byte
 * fields live in VARBINARY as raw bytes (base64 exists only at the API
 * boundary); the two public keys are canonical base64 VARCHARs.
 *
 * Create is CREATE-ONLY (the PK insert is the atomic gate → vault_exists);
 * passphrase change is a version-checked compare-and-swap UPDATE that touches
 * passphrase-side fields only (plan: "passphrase change rewraps the UMK only").
 * KDF parameters are validated on every write: pinned minimums (opslimit 3 /
 * memlimit 64 MiB), sane maximums (10 / 256 MiB — corrupt values would freeze
 * the browser), and per-account MONOTONICITY on rewrap (a downgrade below the
 * stored values loses the CAS → 400 kdf_downgrade).
 */
final class VaultService
{
    public const KDF = 'argon2id13.1';
    public const MIN_OPSLIMIT = 3;
    public const MIN_MEMLIMIT = 67_108_864; // 64 MiB
    // Sane maximums (security review): absurd parameters would freeze the
    // browser's Argon2id derivation — the server refuses to store them.
    public const MAX_OPSLIMIT = 10;
    public const MAX_MEMLIMIT = 268_435_456; // 256 MiB

    public const SALT_BYTES = 16;
    public const WRAPPED_UMK_BYTES = 72;       // 24B nonce || 32B key || 16B tag
    public const PUBLIC_KEY_BYTES = 32;
    public const MIN_KEY_BUNDLE_BYTES = 100;
    public const MAX_KEY_BUNDLE_BYTES = 512;

    private PDO $mysql;

    public function __construct(MySQLConnection|PDO $mysql)
    {
        $this->mysql = $mysql instanceof MySQLConnection ? $mysql->getConnection() : $mysql;
    }

    /**
     * The wire-shaped vault for GET /api/vault, or null when none exists.
     *
     * @return array<string,mixed>|null
     */
    public function getVault(string $userId): ?array
    {
        $stmt = $this->mysql->prepare('SELECT * FROM user_vaults WHERE user_id = :u');
        $stmt->execute(['u' => $userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return is_array($row) ? $this->toWire($row) : null;
    }

    /**
     * Create the user's vault — create-only; an existing row is a 409 vault_exists.
     *
     * @param array<string,mixed> $body
     * @return array<string,mixed> the stored vault (wire shape, version 1)
     * @throws EncryptionRequestException
     */
    public function createVault(string $userId, array $body): array
    {
        if (($body['kdf'] ?? null) !== self::KDF) {
            $this->invalid('kdf must be ' . self::KDF);
        }
        $salt = $this->requireBytes($body, 'kdfSalt', self::SALT_BYTES, self::SALT_BYTES);
        [$opslimit, $memlimit] = $this->requireKdfParams($body);
        $wrappedUmk = $this->requireBytes($body, 'wrappedUmk', self::WRAPPED_UMK_BYTES, self::WRAPPED_UMK_BYTES);
        // Recovery is MANDATORY at vault creation (plan D5) — losing the passphrase
        // without a recovery kit means the data is gone; the server enforces the kit.
        $wrappedUmkRecovery = $this->requireBytes($body, 'wrappedUmkRecovery', self::WRAPPED_UMK_BYTES, self::WRAPPED_UMK_BYTES);
        $encKeyBundle = $this->requireBytes($body, 'encKeyBundle', self::MIN_KEY_BUNDLE_BYTES, self::MAX_KEY_BUNDLE_BYTES);
        $x25519Pk = $this->requireBytes($body, 'x25519Pk', self::PUBLIC_KEY_BYTES, self::PUBLIC_KEY_BYTES);
        $ed25519Pk = $this->requireBytes($body, 'ed25519Pk', self::PUBLIC_KEY_BYTES, self::PUBLIC_KEY_BYTES);

        $now = date('Y-m-d H:i:s');
        try {
            $this->mysql->prepare("
                INSERT INTO user_vaults
                    (user_id, version, kdf, kdf_salt, kdf_memlimit, kdf_opslimit,
                     wrapped_umk, wrapped_umk_recovery, enc_key_bundle, x25519_pk, ed25519_pk,
                     created_at, updated_at)
                VALUES
                    (:u, 1, :kdf, :salt, :mem, :ops, :umk, :umk_rec, :bundle, :xpk, :edpk, :now, :now2)
            ")->execute([
                'u' => $userId,
                'kdf' => self::KDF,
                'salt' => $salt,
                'mem' => $memlimit,
                'ops' => $opslimit,
                'umk' => $wrappedUmk,
                'umk_rec' => $wrappedUmkRecovery,
                'bundle' => $encKeyBundle,
                'xpk' => base64_encode($x25519Pk),
                'edpk' => base64_encode($ed25519Pk),
                'now' => $now,
                'now2' => $now,
            ]);
        } catch (\PDOException $e) {
            if ($e->getCode() === '23000' || (isset($e->errorInfo[1]) && (int) $e->errorInfo[1] === 1062)) {
                throw new EncryptionRequestException('vault_exists', 'A vault already exists for this account.', 409);
            }
            throw $e;
        }

        $vault = $this->getVault($userId);
        if ($vault === null) {
            throw new \RuntimeException('Vault row vanished after insert');
        }
        return $vault;
    }

    /**
     * Version-checked passphrase change: ONE atomic conditional UPDATE — never
     * read-then-write. Only the passphrase-side fields move (salt, KDF params,
     * wrapped UMK); recovery wrap, key bundle and public keys are untouched.
     * KDF parameters are monotonic per account (security review): the WHERE
     * clause refuses any downgrade below the STORED opslimit/memlimit in the
     * same atomic write — a losing CAS is then diagnosed as version conflict
     * vs kdf_downgrade from the current row.
     *
     * @param array<string,mixed> $body {expectedVersion, kdfSalt, kdfOpslimit, kdfMemlimit, wrappedUmk}
     * @return array<string,mixed> the updated vault (wire shape)
     * @throws EncryptionRequestException
     */
    public function changePassphrase(string $userId, array $body): array
    {
        $expectedVersion = $body['expectedVersion'] ?? null;
        if (!is_int($expectedVersion) || $expectedVersion < 1) {
            $this->invalid('expectedVersion must be a positive integer');
        }
        $salt = $this->requireBytes($body, 'kdfSalt', self::SALT_BYTES, self::SALT_BYTES);
        [$opslimit, $memlimit] = $this->requireKdfParams($body);
        $wrappedUmk = $this->requireBytes($body, 'wrappedUmk', self::WRAPPED_UMK_BYTES, self::WRAPPED_UMK_BYTES);

        $stmt = $this->mysql->prepare("
            UPDATE user_vaults
            SET kdf_salt = :salt, kdf_opslimit = :ops, kdf_memlimit = :mem,
                wrapped_umk = :umk, version = version + 1, updated_at = :now
            WHERE user_id = :u AND version = :expected
              AND kdf_opslimit <= :ops2 AND kdf_memlimit <= :mem2
        ");
        $stmt->execute([
            'salt' => $salt,
            'ops' => $opslimit,
            'mem' => $memlimit,
            'umk' => $wrappedUmk,
            'now' => date('Y-m-d H:i:s'),
            'u' => $userId,
            'expected' => $expectedVersion,
            'ops2' => $opslimit,
            'mem2' => $memlimit,
        ]);
        if ($stmt->rowCount() === 0) {
            $vault = $this->getVault($userId);
            if ($vault === null) {
                throw new EncryptionRequestException('vault_not_found', 'No vault exists for this account.', 404);
            }
            if ((int) $vault['version'] !== $expectedVersion) {
                throw new EncryptionRequestException(
                    'vault_version_conflict',
                    'The vault changed since it was loaded — unlock again and retry.',
                    409,
                    ['currentVersion' => $vault['version']]
                );
            }
            // The version matched, so the KDF monotonicity clause lost the CAS.
            throw new EncryptionRequestException(
                'kdf_downgrade',
                'KDF parameters cannot be lowered — passphrase changes are upgrade-only (kdfOpslimit/kdfMemlimit must be >= the stored values).',
                400
            );
        }

        $vault = $this->getVault($userId);
        if ($vault === null) {
            throw new \RuntimeException('Vault row vanished after update');
        }
        return $vault;
    }

    /**
     * @param array<string,string|int|null> $row
     * @return array<string,mixed>
     */
    private function toWire(array $row): array
    {
        return [
            'version' => (int) $row['version'],
            'kdf' => (string) $row['kdf'],
            'kdfSalt' => base64_encode((string) $row['kdf_salt']),
            'kdfOpslimit' => (int) $row['kdf_opslimit'],
            'kdfMemlimit' => (int) $row['kdf_memlimit'],
            'wrappedUmk' => base64_encode((string) $row['wrapped_umk']),
            'wrappedUmkRecovery' => $row['wrapped_umk_recovery'] !== null
                ? base64_encode((string) $row['wrapped_umk_recovery'])
                : null,
            'encKeyBundle' => base64_encode((string) $row['enc_key_bundle']),
            'x25519Pk' => (string) $row['x25519_pk'],
            'ed25519Pk' => (string) $row['ed25519_pk'],
        ];
    }

    /**
     * @return array{0: int, 1: int} [opslimit, memlimit]
     * @throws EncryptionRequestException
     */
    private function requireKdfParams(array $body): array
    {
        $ops = $body['kdfOpslimit'] ?? null;
        $mem = $body['kdfMemlimit'] ?? null;
        if (!is_int($ops) || $ops < self::MIN_OPSLIMIT) {
            $this->invalid('kdfOpslimit must be an integer >= ' . self::MIN_OPSLIMIT);
        }
        if (!is_int($mem) || $mem < self::MIN_MEMLIMIT) {
            $this->invalid('kdfMemlimit must be an integer >= ' . self::MIN_MEMLIMIT . ' (64 MiB)');
        }
        if ($ops > self::MAX_OPSLIMIT) {
            $this->invalid('kdfOpslimit must be <= ' . self::MAX_OPSLIMIT);
        }
        if ($mem > self::MAX_MEMLIMIT) {
            $this->invalid('kdfMemlimit must be <= ' . self::MAX_MEMLIMIT . ' (256 MiB)');
        }
        return [$ops, $mem];
    }

    /**
     * Decode a required canonical-base64 byte field with an exact/inclusive length
     * range. Returns RAW bytes for VARBINARY storage.
     *
     * @param array<string,mixed> $body
     * @throws EncryptionRequestException
     */
    private function requireBytes(array $body, string $field, int $minBytes, int $maxBytes): string
    {
        $value = $body[$field] ?? null;
        if (!is_string($value) || $value === '' || strlen($value) % 4 !== 0) {
            $this->invalid("{$field} must be canonical base64");
        }
        $decoded = base64_decode($value, true);
        if ($decoded === false || base64_encode($decoded) !== $value) {
            $this->invalid("{$field} must be canonical base64");
        }
        $len = strlen($decoded);
        if ($len < $minBytes || $len > $maxBytes) {
            $expected = $minBytes === $maxBytes ? "exactly {$minBytes}" : "{$minBytes}..{$maxBytes}";
            $this->invalid("{$field} must decode to {$expected} bytes");
        }
        return $decoded;
    }

    private function invalid(string $message): never
    {
        throw new EncryptionRequestException('vault_invalid', $message, 400);
    }
}

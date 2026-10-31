<?php

declare(strict_types=1);

namespace FormLogic\Support;

use PDO;

/**
 * Encryption at rest for values the server has to read back: hosted app records, two-factor
 * secrets and webhook signing secrets (docs/SOFTN_APP_DATA_PROTECTION_PLAN.md, Phase 1).
 *
 * The key is DATA_ENCRYPTION_KEY, in the environment rather than the database or storage folders,
 * so a copied database, storage folder or backup can't be read without it. Someone who has the
 * whole server has the key too; that is what the plan's Sealed level is for.
 *
 * With no key this does nothing and values stay plain, so an upgrade keeps working until the
 * operator sets one. A value without the prefix reads as itself: it was stored before the key,
 * and `bin/encrypt-data.php` brings it in. A key that is set but unusable refuses to seal, because
 * an operator who asked for encryption must not quietly get plain text.
 *
 * Each value names where it lives in its associated data, so moving one to another row fails
 * rather than decrypts.
 */
final class DataEncryption
{
    public const KEY_ENV = 'DATA_ENCRYPTION_KEY';
    /** Comma-separated. Old keys read what they sealed until `bin/encrypt-data.php` has moved it on. */
    public const PREVIOUS_KEYS_ENV = 'DATA_ENCRYPTION_KEY_PREVIOUS';

    private const PREFIX = 'fle1.';
    private const CHECK_META_KEY = 'data_encryption_check';
    private const CHECK_TEXT = 'formlogic-data-encryption-check';
    private const CHECK_CONTEXT = 'system_meta.data_encryption_check';
    private const MIGRATED_META_KEY = 'data_encryption_last_run';

    /**
     * @param array<string,string> $keys key id => subkey
     */
    private function __construct(
        private readonly array $keys,
        private readonly ?string $currentId,
        private readonly bool $usable,
    ) {
    }

    public static function fromEnvironment(): self
    {
        $current = Environment::nonEmpty(self::KEY_ENV);
        $previous = array_filter(array_map('trim', explode(',', (string) Environment::nonEmpty(self::PREVIOUS_KEYS_ENV, ''))), 'strlen');
        $keys = [];
        $currentId = null;
        $usable = true;
        foreach ($current === null ? $previous : [$current, ...$previous] as $index => $text) {
            $raw = self::parseKey($text);
            if ($raw === null) {
                $usable = false;
                continue;
            }
            $id = substr(bin2hex(sodium_crypto_generichash('formlogic.data-key-id', $raw, 16)), 0, 12);
            $keys[$id] = sodium_crypto_kdf_derive_from_key(SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_KEYBYTES, 1, 'flsealv1', $raw);
            if ($index === 0 && $current !== null) {
                $currentId = $id;
            }
        }
        return new self($keys, $currentId, $usable);
    }

    private static function parseKey(string $text): ?string
    {
        $text = trim($text);
        $key = strlen($text) === 64 && ctype_xdigit($text)
            ? hex2bin($text)
            : base64_decode(str_starts_with($text, 'base64:') ? substr($text, 7) : $text, true);
        return is_string($key) && strlen($key) === SODIUM_CRYPTO_KDF_KEYBYTES ? $key : null;
    }

    public static function generateKey(): string
    {
        return bin2hex(random_bytes(SODIUM_CRYPTO_KDF_KEYBYTES));
    }

    /** True once new values are being encrypted. */
    public function enabled(): bool
    {
        return $this->usable && $this->currentId !== null;
    }

    /** False when a key is set but can't be used, so nothing may be sealed or trusted. */
    public function usable(): bool
    {
        return $this->usable;
    }

    public function currentKeyId(): ?string
    {
        return $this->currentId;
    }

    public static function isSealed(?string $stored): bool
    {
        return $stored !== null && str_starts_with($stored, self::PREFIX);
    }

    /** Encrypted for $context, or $plain when no key is set. */
    public function seal(string $plain, string $context): string
    {
        if (!$this->usable) {
            throw new DataEncryptionException('DATA_ENCRYPTION_KEY is not a valid key');
        }
        if ($this->currentId === null) {
            return $plain;
        }
        $nonce = random_bytes(SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_NPUBBYTES);
        $sealed = sodium_crypto_aead_xchacha20poly1305_ietf_encrypt($plain, $context, $nonce, $this->keys[$this->currentId]);
        return self::PREFIX . $this->currentId . '.' . self::encode($nonce . $sealed);
    }

    /** The value stored for $context. A value that was never sealed reads as itself. */
    public function open(string $stored, string $context): string
    {
        if (!self::isSealed($stored)) {
            return $stored;
        }
        $parts = explode('.', $stored, 3);
        $key = $this->keys[$parts[1] ?? ''] ?? null;
        $bytes = self::decode($parts[2] ?? '');
        if ($key === null || $bytes === null || strlen($bytes) < SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_NPUBBYTES) {
            throw new DataEncryptionException('Stored data cannot be read');
        }
        $plain = sodium_crypto_aead_xchacha20poly1305_ietf_decrypt(
            substr($bytes, SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_NPUBBYTES),
            $context,
            substr($bytes, 0, SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_NPUBBYTES),
            $key
        );
        if (!is_string($plain)) {
            throw new DataEncryptionException('Stored data cannot be read');
        }
        return $plain;
    }

    /** $stored as it should be now: sealed, and under the current key. */
    public function resealed(string $stored, string $context): string
    {
        if (self::isSealed($stored) && (explode('.', $stored, 3)[1] ?? '') === $this->currentId) {
            return $stored;
        }
        return $this->seal($this->open($stored, $context), $context);
    }

    /**
     * What the health check and the admin Doctor show. Reading the check value is how a mistyped
     * key, or another server's .env, is noticed all at once and not one row at a time.
     *
     * @return array{ok: bool, critical: bool, detail: string, warning?: string}
     */
    public function health(PDO $mysql): array
    {
        if (!$this->usable) {
            return ['ok' => false, 'critical' => true, 'detail' => 'a data encryption key is set but is not a 32-byte hex or base64 value'];
        }
        $check = self::readMeta($mysql, self::CHECK_META_KEY);
        if ($this->currentId === null) {
            if ($check !== null) {
                return ['ok' => false, 'critical' => true, 'detail' => 'data here is encrypted, but DATA_ENCRYPTION_KEY is not set'];
            }
            return [
                'ok' => true, 'critical' => false, 'detail' => 'not configured',
                'warning' => 'hosted app records and two-factor and webhook secrets are stored unencrypted: set DATA_ENCRYPTION_KEY, then run bin/encrypt-data.php',
            ];
        }
        if ($check === null) {
            $this->recordKeyCheck($mysql);
            $check = self::readMeta($mysql, self::CHECK_META_KEY);
        }
        try {
            if ($check === null || !hash_equals(self::CHECK_TEXT, $this->open($check, self::CHECK_CONTEXT))) {
                throw new DataEncryptionException('Stored data cannot be read');
            }
        } catch (DataEncryptionException) {
            return ['ok' => false, 'critical' => true, 'detail' => 'DATA_ENCRYPTION_KEY is not the key this data was encrypted with'];
        }
        $health = ['ok' => true, 'critical' => false, 'detail' => 'on (key ' . $this->currentId . '). Keep the key backed up apart from the database, and encrypt the server\'s disk: that cannot be checked from here'];
        $waiting = $this->unsealedSecrets($mysql);
        if ($waiting > 0 || self::readMeta($mysql, self::MIGRATED_META_KEY) === null || !$this->sealedByCurrentKey($check)) {
            $health['warning'] = 'data stored before this key is not encrypted under it yet: run bin/encrypt-data.php';
        }
        return $health;
    }

    private function sealedByCurrentKey(string $stored): bool
    {
        return (explode('.', $stored, 3)[1] ?? '') === $this->currentId;
    }

    private function unsealedSecrets(PDO $mysql): int
    {
        try {
            $like = self::PREFIX . '%';
            $users = $mysql->prepare('SELECT COUNT(*) FROM users WHERE mfa_secret IS NOT NULL AND mfa_secret NOT LIKE ?');
            $users->execute([$like]);
            $webhooks = $mysql->prepare('SELECT COUNT(*) FROM webhooks WHERE secret NOT LIKE ?');
            $webhooks->execute([$like]);
            return (int) $users->fetchColumn() + (int) $webhooks->fetchColumn();
        } catch (\PDOException) {
            return 0;
        }
    }

    /** Leaves a small sealed value in the database, for health() to prove the key against. */
    public function recordKeyCheck(PDO $mysql): void
    {
        self::writeMeta($mysql, self::CHECK_META_KEY, $this->seal(self::CHECK_TEXT, self::CHECK_CONTEXT));
    }

    public function recordMigrated(PDO $mysql): void
    {
        $this->recordKeyCheck($mysql);
        self::writeMeta($mysql, self::MIGRATED_META_KEY, gmdate('c'));
    }

    private static function readMeta(PDO $mysql, string $key): ?string
    {
        $stmt = $mysql->prepare('SELECT meta_value FROM system_meta WHERE meta_key = ?');
        $stmt->execute([$key]);
        $value = $stmt->fetchColumn();
        return is_string($value) ? $value : null;
    }

    private static function writeMeta(PDO $mysql, string $key, string $value): void
    {
        $mysql->prepare('INSERT INTO system_meta (meta_key, meta_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE meta_value = VALUES(meta_value)')
            ->execute([$key, $value]);
    }

    public static function encode(string $bytes): string
    {
        return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
    }

    public static function decode(string $text): ?string
    {
        $bytes = base64_decode(strtr($text, '-_', '+/'), true);
        return is_string($bytes) ? $bytes : null;
    }
}

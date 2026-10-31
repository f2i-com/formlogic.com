<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Support\DataEncryption;
use FormLogic\Support\DataEncryptionException;
use PDO;

/**
 * A hosted app's records at rest. Each app has its own key, kept in its own database wrapped under
 * DATA_ENCRYPTION_KEY, so erasing the database erases the key and changing the master key rewraps
 * one row per app rather than rewriting every record.
 *
 * Collection, id and timestamps stay readable: the app lists by them. Only `data` is encrypted.
 * Nothing leaves the server encrypted this way: a backup can be restored under a new id or on
 * another server, so exports are decrypted (HostedAppService::decryptCopy) and a restore encrypts
 * again under the new app's key.
 */
final class HostedRecordCipher
{
    public const PREFIX = 'flr1.';

    private ?string $key = null;

    public function __construct(
        private readonly PDO $db,
        private readonly string $databaseId,
        private readonly DataEncryption $crypto,
    ) {
    }

    public static function forApp(PDO $db, string $appId): self
    {
        return new self($db, hash('sha256', $appId), DataEncryption::fromEnvironment());
    }

    /** Whether a stored value was encrypted by any server, under any key. */
    public static function isEncrypted(string $stored): bool
    {
        return str_starts_with($stored, self::PREFIX) || DataEncryption::isSealed($stored);
    }

    /**
     * Encrypted for this row, or $data as it is when no key is set. Called inside the write's own
     * transaction, so two first writes can't make two keys.
     */
    public function seal(string $collection, string $id, string $data): string
    {
        $context = $this->context($collection, $id);
        if (!$this->crypto->enabled()) {
            return $this->crypto->seal($data, $context);
        }
        $nonce = random_bytes(SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_NPUBBYTES);
        return self::PREFIX . DataEncryption::encode($nonce . sodium_crypto_aead_xchacha20poly1305_ietf_encrypt($data, $context, $nonce, $this->key(true)));
    }

    /** The row's data. One stored before the key reads as itself. */
    public function open(string $collection, string $id, string $stored): string
    {
        if (!str_starts_with($stored, self::PREFIX)) {
            return $stored;
        }
        $bytes = DataEncryption::decode(substr($stored, strlen(self::PREFIX)));
        if ($bytes === null || strlen($bytes) < SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_NPUBBYTES) {
            throw new DataEncryptionException('Stored data cannot be read');
        }
        $plain = sodium_crypto_aead_xchacha20poly1305_ietf_decrypt(
            substr($bytes, SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_NPUBBYTES),
            $this->context($collection, $id),
            substr($bytes, 0, SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_NPUBBYTES),
            $this->key(false)
        );
        if (!is_string($plain)) {
            throw new DataEncryptionException('Stored data cannot be read');
        }
        return $plain;
    }

    /** Wraps this app's key under the current master key, if it has one yet. */
    public function rewrapKey(): void
    {
        $wrapped = $this->wrappedKey();
        if ($wrapped !== null) {
            $this->db->prepare('UPDATE app_key SET wrapped=? WHERE id=1')->execute([$this->crypto->resealed($wrapped, $this->keyContext())]);
        }
    }

    private function key(bool $create): string
    {
        if ($this->key !== null) {
            return $this->key;
        }
        $wrapped = $this->wrappedKey();
        if ($wrapped === null && $create) {
            $this->db->prepare('INSERT OR IGNORE INTO app_key (id, wrapped) VALUES (1, ?)')
                ->execute([$this->crypto->seal(random_bytes(SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_KEYBYTES), $this->keyContext())]);
            $wrapped = $this->wrappedKey();
        }
        // open() passes a value without the prefix straight through, and a key must never be one.
        if ($wrapped === null || !DataEncryption::isSealed($wrapped)) {
            throw new DataEncryptionException('Stored data cannot be read');
        }
        return $this->key = $this->crypto->open($wrapped, $this->keyContext());
    }

    private function wrappedKey(): ?string
    {
        $wrapped = $this->db->query('SELECT wrapped FROM app_key WHERE id=1')->fetchColumn();
        return is_string($wrapped) ? $wrapped : null;
    }

    private function keyContext(): string
    {
        return 'hosted-key:' . $this->databaseId;
    }

    private function context(string $collection, string $id): string
    {
        return implode("\0", ['hosted-record', $this->databaseId, $collection, $id]);
    }
}

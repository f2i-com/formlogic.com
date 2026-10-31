<?php

declare(strict_types=1);

namespace FormLogic\Support;

/**
 * A backup file sealed for whoever may open it. One random file key encrypts the file; each
 * recipient gets that key wrapped their own way, so a file can open with a person's passphrase and
 * with an offline key alike.
 *
 *   "FLBK1\n" | uint32 header length | header JSON | chunks
 *
 * Each chunk is a uint32 length and XChaCha20-Poly1305 over up to 4 MiB, the same construction as
 * DataAccountBackupService: the nonce is 16 random bytes and a 64-bit chunk index, and the
 * associated data names the file, the index and the count, so a chunk can't be moved, dropped or
 * added. Everything is standard libsodium, so OAIY opens these without any PHP.
 *
 * Recipients:
 *   - publicKey: a libsodium sealed box to an X25519 key. The server can seal to it and can't
 *     open it, so a thief who takes the whole server gets nothing from the file.
 *   - passphrase: Argon2id. The file carries its cost, which is capped on the way in, because an
 *     uploaded file must not be able to ask this server for a terabyte of memory.
 *   - server: wrapped under DATA_ENCRYPTION_KEY, for files only this server needs to read back.
 */
final class BackupEnvelope
{
    public const MAGIC = "FLBK1\n";
    public const EXTENSION = '.flbk';
    public const CHUNK_BYTES = 4_194_304;
    public const CIPHER = 'xchacha20p1305-chunked.1';
    public const MIN_PASSPHRASE_LENGTH = 12;

    private const MAX_HEADER_BYTES = 65_536;
    /** libsodium's own floor for Argon2id, which PHP doesn't name. */
    private const MIN_PWHASH_OPS = 1;
    private const MIN_PWHASH_MEMORY = 8192;
    private const MAX_PWHASH_OPS = 10;
    private const MAX_PWHASH_MEMORY = 1_073_741_824;

    public static function isSealed(string $path): bool
    {
        $handle = @fopen($path, 'rb');
        if ($handle === false) {
            return false;
        }
        $magic = fread($handle, strlen(self::MAGIC));
        fclose($handle);
        return $magic === self::MAGIC;
    }

    /**
     * Encrypts $source into $destination, in one rename. $source stays.
     *
     * @param array{publicKey?: string, passphrase?: string, server?: DataEncryption} $to at least one
     */
    public static function seal(string $source, string $destination, array $to): void
    {
        $size = (int) filesize($source);
        if ($size <= 0) {
            throw new DataEncryptionException('There is nothing to seal');
        }
        $id = bin2hex(random_bytes(16));
        $fileKey = random_bytes(SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_KEYBYTES);
        $baseNonce = random_bytes(16);
        $count = (int) ceil($size / self::CHUNK_BYTES);
        $header = [
            'v' => 1,
            'id' => $id,
            'cipher' => self::CIPHER,
            'chunkBytes' => self::CHUNK_BYTES,
            'chunkCount' => $count,
            'plainBytes' => $size,
            'baseNonce' => base64_encode($baseNonce),
            'createdAt' => gmdate('Y-m-d\TH:i:s\Z'),
            'recipients' => self::recipients($id, $fileKey, $to),
        ];

        $staged = $destination . '.partial-' . bin2hex(random_bytes(4));
        $in = fopen($source, 'rb');
        $out = fopen($staged, 'wb');
        if ($in === false || $out === false) {
            throw new DataEncryptionException('The backup could not be sealed');
        }
        try {
            @chmod($staged, 0600);
            self::writeHeader($out, $header);
            for ($i = 0; $i < $count; $i++) {
                $chunk = self::readFully($in, self::CHUNK_BYTES);
                if ($chunk === '') {
                    throw new DataEncryptionException('The backup changed while it was being sealed');
                }
                $sealed = sodium_crypto_aead_xchacha20poly1305_ietf_encrypt($chunk, self::chunkData($id, $i, $count), $baseNonce . pack('J', $i), $fileKey);
                self::writeAll($out, pack('N', strlen($sealed)) . $sealed);
            }
            fclose($out);
            $out = null;
            if (!rename($staged, $destination)) {
                throw new DataEncryptionException('The backup could not be sealed');
            }
        } finally {
            fclose($in);
            if ($out !== null) {
                fclose($out);
            }
            if (is_file($staged)) {
                unlink($staged);
            }
            sodium_memzero($fileKey);
        }
    }

    /**
     * Decrypts $source into $destination. Nothing appears at $destination unless every chunk
     * checked, so a damaged or cut-short file leaves nothing half-restored.
     *
     * @param array{secretKey?: string, passphrase?: string, server?: DataEncryption} $with
     */
    public static function open(string $source, string $destination, array $with): void
    {
        $in = @fopen($source, 'rb');
        if ($in === false) {
            throw new DataEncryptionException('This backup cannot be read');
        }
        $staged = $destination . '.partial-' . bin2hex(random_bytes(4));
        $out = null;
        try {
            $header = self::readHeader($in);
            $fileKey = self::fileKey($header, $with);
            $out = fopen($staged, 'wb');
            if ($out === false) {
                throw new DataEncryptionException('This backup cannot be read');
            }
            @chmod($staged, 0600);
            $count = (int) $header['chunkCount'];
            $baseNonce = (string) base64_decode((string) $header['baseNonce'], true);
            for ($i = 0; $i < $count; $i++) {
                $length = unpack('N', self::readFully($in, 4) . "\0\0\0\0");
                $bytes = (int) ($length[1] ?? 0);
                if ($bytes <= 0 || $bytes > self::CHUNK_BYTES + SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_ABYTES) {
                    throw new DataEncryptionException('This backup is damaged');
                }
                $plain = sodium_crypto_aead_xchacha20poly1305_ietf_decrypt(self::readFully($in, $bytes), self::chunkData((string) $header['id'], $i, $count), $baseNonce . pack('J', $i), $fileKey);
                if (!is_string($plain)) {
                    throw new DataEncryptionException('This backup is damaged');
                }
                self::writeAll($out, $plain);
            }
            sodium_memzero($fileKey);
            if (fread($in, 1) !== '') {
                throw new DataEncryptionException('This backup is damaged');
            }
            fclose($out);
            $out = null;
            if (!rename($staged, $destination)) {
                throw new DataEncryptionException('This backup cannot be read');
            }
        } finally {
            fclose($in);
            if ($out !== null) {
                fclose($out);
            }
            if (is_file($staged)) {
                unlink($staged);
            }
        }
    }

    /**
     * Whether the server's wrapping of this file is on the current key. Changing a wrapped key
     * touches only the header: the chunks stay as they are.
     */
    public static function rewrap(string $path, DataEncryption $server): bool
    {
        $in = fopen($path, 'rb');
        if ($in === false) {
            throw new DataEncryptionException('This backup cannot be read');
        }
        $staged = $path . '.partial-' . bin2hex(random_bytes(4));
        try {
            $header = self::readHeader($in);
            $changed = false;
            foreach ($header['recipients'] as $i => $recipient) {
                if (($recipient['kind'] ?? '') !== 'server') {
                    continue;
                }
                $next = $server->resealed((string) $recipient['wrapped'], self::serverContext((string) $header['id']));
                $changed = $changed || $next !== $recipient['wrapped'];
                $header['recipients'][$i]['wrapped'] = $next;
            }
            if (!$changed) {
                return false;
            }
            $out = fopen($staged, 'wb');
            if ($out === false) {
                throw new DataEncryptionException('This backup cannot be read');
            }
            @chmod($staged, 0600);
            self::writeHeader($out, $header);
            stream_copy_to_stream($in, $out);
            fclose($out);
            fclose($in);
            $in = null;
            if (!rename($staged, $path)) {
                throw new DataEncryptionException('This backup cannot be read');
            }
            return true;
        } finally {
            if ($in !== null) {
                fclose($in);
            }
            if (is_file($staged)) {
                unlink($staged);
            }
        }
    }

    /** A key pair for BACKUP_PUBLIC_KEY: public first, as base64. */
    public static function generateKeyPair(): array
    {
        $pair = sodium_crypto_box_keypair();
        return [base64_encode(sodium_crypto_box_publickey($pair)), base64_encode(sodium_crypto_box_secretkey($pair))];
    }

    /** The 32-byte public key in $base64, or null. */
    public static function parseKey(?string $base64): ?string
    {
        $raw = base64_decode(trim((string) $base64), true);
        return is_string($raw) && strlen($raw) === SODIUM_CRYPTO_BOX_PUBLICKEYBYTES ? $raw : null;
    }

    /**
     * @param array{publicKey?: string, passphrase?: string, server?: DataEncryption} $to
     * @return list<array<string, mixed>>
     */
    private static function recipients(string $id, string $fileKey, array $to): array
    {
        $recipients = [];
        if (isset($to['publicKey'])) {
            $recipients[] = [
                'kind' => 'publicKey',
                'keyId' => substr(hash('sha256', $to['publicKey']), 0, 16),
                'sealedKey' => base64_encode(sodium_crypto_box_seal($fileKey, $to['publicKey'])),
            ];
        }
        if (isset($to['passphrase'])) {
            $salt = random_bytes(SODIUM_CRYPTO_PWHASH_SALTBYTES);
            $ops = SODIUM_CRYPTO_PWHASH_OPSLIMIT_MODERATE;
            $memory = SODIUM_CRYPTO_PWHASH_MEMLIMIT_MODERATE;
            $nonce = random_bytes(SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_NPUBBYTES);
            $derived = sodium_crypto_pwhash(SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_KEYBYTES, $to['passphrase'], $salt, $ops, $memory, SODIUM_CRYPTO_PWHASH_ALG_ARGON2ID13);
            $recipients[] = [
                'kind' => 'passphrase',
                'kdf' => 'argon2id13',
                'salt' => base64_encode($salt),
                'opsLimit' => $ops,
                'memLimit' => $memory,
                'nonce' => base64_encode($nonce),
                'wrapped' => base64_encode(sodium_crypto_aead_xchacha20poly1305_ietf_encrypt($fileKey, self::passphraseData($id), $nonce, $derived)),
            ];
            sodium_memzero($derived);
        }
        if (isset($to['server'])) {
            if (!$to['server']->enabled()) {
                throw new DataEncryptionException('Set DATA_ENCRYPTION_KEY to a valid key first');
            }
            $recipients[] = ['kind' => 'server', 'wrapped' => $to['server']->seal($fileKey, self::serverContext($id))];
        }
        if ($recipients === []) {
            throw new DataEncryptionException('A sealed backup needs someone who can open it');
        }
        return $recipients;
    }

    /**
     * @param array<string, mixed> $header
     * @param array{secretKey?: string, passphrase?: string, server?: DataEncryption} $with
     */
    private static function fileKey(array $header, array $with): string
    {
        $id = (string) $header['id'];
        foreach ($header['recipients'] as $recipient) {
            $kind = $recipient['kind'] ?? '';
            if ($kind === 'publicKey' && isset($with['secretKey'])) {
                $sealed = base64_decode((string) ($recipient['sealedKey'] ?? ''), true);
                $pair = sodium_crypto_box_keypair_from_secretkey_and_publickey($with['secretKey'], sodium_crypto_box_publickey_from_secretkey($with['secretKey']));
                $key = is_string($sealed) ? sodium_crypto_box_seal_open($sealed, $pair) : false;
                sodium_memzero($pair);
                if (is_string($key)) {
                    return $key;
                }
            }
            if ($kind === 'passphrase' && isset($with['passphrase'])) {
                $key = self::openPassphrase($id, $recipient, $with['passphrase']);
                if ($key !== null) {
                    return $key;
                }
            }
            if ($kind === 'server' && isset($with['server']) && DataEncryption::isSealed((string) ($recipient['wrapped'] ?? ''))) {
                return $with['server']->open((string) $recipient['wrapped'], self::serverContext($id));
            }
        }
        throw new DataEncryptionException('That does not open this backup');
    }

    /** @param array<string, mixed> $recipient */
    private static function openPassphrase(string $id, array $recipient, string $passphrase): ?string
    {
        $ops = (int) ($recipient['opsLimit'] ?? 0);
        $memory = (int) ($recipient['memLimit'] ?? 0);
        $salt = base64_decode((string) ($recipient['salt'] ?? ''), true);
        $nonce = base64_decode((string) ($recipient['nonce'] ?? ''), true);
        $wrapped = base64_decode((string) ($recipient['wrapped'] ?? ''), true);
        if (
            ($recipient['kdf'] ?? '') !== 'argon2id13'
            || $ops < self::MIN_PWHASH_OPS || $ops > self::MAX_PWHASH_OPS
            || $memory < self::MIN_PWHASH_MEMORY || $memory > self::MAX_PWHASH_MEMORY
            || !is_string($salt) || strlen($salt) !== SODIUM_CRYPTO_PWHASH_SALTBYTES
            || !is_string($nonce) || strlen($nonce) !== SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_NPUBBYTES
            || !is_string($wrapped)
        ) {
            throw new DataEncryptionException('This backup is damaged');
        }
        $derived = sodium_crypto_pwhash(SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_KEYBYTES, $passphrase, $salt, $ops, $memory, SODIUM_CRYPTO_PWHASH_ALG_ARGON2ID13);
        $key = sodium_crypto_aead_xchacha20poly1305_ietf_decrypt($wrapped, self::passphraseData($id), $nonce, $derived);
        sodium_memzero($derived);
        return is_string($key) ? $key : null;
    }

    /** @return array<string, mixed> */
    private static function readHeader($in): array
    {
        if (self::readFully($in, strlen(self::MAGIC)) !== self::MAGIC) {
            throw new DataEncryptionException('This is not a sealed backup');
        }
        $length = unpack('N', self::readFully($in, 4) . "\0\0\0\0");
        $bytes = (int) ($length[1] ?? 0);
        if ($bytes <= 0 || $bytes > self::MAX_HEADER_BYTES) {
            throw new DataEncryptionException('This backup is damaged');
        }
        $header = json_decode(self::readFully($in, $bytes), true);
        if (
            !is_array($header) || ($header['v'] ?? null) !== 1 || ($header['cipher'] ?? null) !== self::CIPHER
            || !is_string($header['id'] ?? null) || !is_int($header['chunkCount'] ?? null) || $header['chunkCount'] < 1
            || !is_string($header['baseNonce'] ?? null) || strlen((string) base64_decode($header['baseNonce'], true)) !== 16
            || !is_array($header['recipients'] ?? null)
        ) {
            throw new DataEncryptionException('This backup is damaged');
        }
        return $header;
    }

    /** @param array<string, mixed> $header */
    private static function writeHeader($out, array $header): void
    {
        $json = json_encode($header, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
        self::writeAll($out, self::MAGIC . pack('N', strlen($json)) . $json);
    }

    private static function chunkData(string $id, int $index, int $count): string
    {
        return sprintf('flbk:1|%s|%d|%d', $id, $index, $count);
    }

    private static function passphraseData(string $id): string
    {
        return 'flbk-passphrase:1|' . $id;
    }

    private static function serverContext(string $id): string
    {
        return 'backup-file-key:' . $id;
    }

    private static function readFully($in, int $bytes): string
    {
        $read = '';
        while (strlen($read) < $bytes && !feof($in)) {
            $piece = fread($in, $bytes - strlen($read));
            if ($piece === false || $piece === '') {
                break;
            }
            $read .= $piece;
        }
        return $read;
    }

    private static function writeAll($out, string $bytes): void
    {
        if (fwrite($out, $bytes) !== strlen($bytes)) {
            throw new DataEncryptionException('The disk is full');
        }
    }
}

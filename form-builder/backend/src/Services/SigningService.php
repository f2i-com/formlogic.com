<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use PDO;

/**
 * Detached signatures for client manifests (spec §25) and application packages (§29.6).
 *
 * Uses Ed25519 (libsodium) when available so third parties — the native runtime, package
 * verifiers — can check a signature against the server's PUBLIC key without any shared
 * secret. Falls back to HMAC-SHA256 (symmetric) when sodium is missing. The keypair is
 * generated once and persisted in system_meta.
 */
class SigningService
{
    private PDO $mysql;
    private const META_KEY = 'signing_keypair_v1';

    public function __construct(MySQLConnection $mysql)
    {
        $this->mysql = $mysql->getConnection();
    }

    private function ed25519(): bool
    {
        return function_exists('sodium_crypto_sign_detached');
    }

    public function keyId(): string
    {
        return 'formlogic-' . ($this->ed25519() ? 'ed25519' : 'hs256') . '-1';
    }

    /**
     * @return array{alg:string, secret:string, public:string} raw keys (base64-decoded on use).
     * For HMAC, secret === public (the shared key), and `public` is NOT exposed publicly.
     */
    private function keypair(): array
    {
        $stmt = $this->mysql->prepare("SELECT meta_value FROM system_meta WHERE meta_key = :k LIMIT 1");
        $stmt->execute(['k' => self::META_KEY]);
        $stored = $stmt->fetchColumn();
        if (is_string($stored) && $stored !== '') {
            $decoded = json_decode($stored, true);
            if (is_array($decoded) && isset($decoded['alg'], $decoded['secret'], $decoded['public'])) {
                return $decoded;
            }
        }

        if ($this->ed25519()) {
            $kp = sodium_crypto_sign_keypair();
            $pair = [
                'alg' => 'Ed25519',
                'secret' => base64_encode(sodium_crypto_sign_secretkey($kp)),
                'public' => base64_encode(sodium_crypto_sign_publickey($kp)),
            ];
        } else {
            $key = base64_encode(random_bytes(32));
            $pair = ['alg' => 'HS256', 'secret' => $key, 'public' => $key];
        }

        $ins = $this->mysql->prepare(
            "INSERT INTO system_meta (meta_key, meta_value) VALUES (:k, :v)
             ON DUPLICATE KEY UPDATE meta_value = meta_value" // never overwrite an existing keypair
        );
        $ins->execute(['k' => self::META_KEY, 'v' => json_encode($pair)]);
        // Re-read in case of a concurrent insert (keep everyone on the same key).
        $stmt->execute(['k' => self::META_KEY]);
        $again = $stmt->fetchColumn();
        $decoded = is_string($again) ? json_decode($again, true) : null;
        return is_array($decoded) ? $decoded : $pair;
    }

    private function b64url(string $bin): string
    {
        return rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');
    }

    private function b64urlDecode(string $s): string
    {
        return (string) base64_decode(strtr($s, '-_', '+/'));
    }

    /**
     * Canonical JSON of a payload. Normalizes through an assoc-decode round-trip so that
     * empty {} vs [] (and other JSON-boundary ambiguities) collapse identically on both the
     * signing side and a verifier that received the payload over the wire — otherwise a
     * signature would fail to reproduce after the payload crossed a JSON boundary.
     */
    private function canonical(array $payload): string
    {
        $normalized = json_decode((string) json_encode($payload), true);
        return (string) json_encode(is_array($normalized) ? $normalized : $payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    }

    /**
     * Sign a payload, returning the signed envelope (spec §25).
     * @return array{payload:array, signature:string, alg:string, keyId:string}
     */
    public function sign(array $payload): array
    {
        $kp = $this->keypair();
        $msg = $this->canonical($payload);
        if ($kp['alg'] === 'Ed25519') {
            $sig = sodium_crypto_sign_detached($msg, base64_decode($kp['secret']));
        } else {
            $sig = hash_hmac('sha256', $msg, base64_decode($kp['secret']), true);
        }
        return [
            'payload' => $payload,
            'signature' => $this->b64url($sig),
            'alg' => $kp['alg'],
            'keyId' => $this->keyId(),
        ];
    }

    /** Verify a signed envelope produced by sign(). */
    public function verify(array $signed): bool
    {
        if (!isset($signed['payload'], $signed['signature'], $signed['alg']) || !is_array($signed['payload'])) {
            return false;
        }
        $kp = $this->keypair();
        if ($signed['alg'] !== $kp['alg']) {
            return false;
        }
        $msg = $this->canonical($signed['payload']);
        $sig = $this->b64urlDecode((string) $signed['signature']);
        if ($kp['alg'] === 'Ed25519') {
            return sodium_crypto_sign_verify_detached($sig, $msg, base64_decode($kp['public']));
        }
        return hash_equals(hash_hmac('sha256', $msg, base64_decode($kp['secret']), true), $sig);
    }

    /** Public verification material (safe to expose). Ed25519 public key, or null for HMAC. */
    public function publicKeyInfo(): array
    {
        $kp = $this->keypair();
        return [
            'alg' => $kp['alg'],
            'keyId' => $this->keyId(),
            // Never expose the HMAC secret; only the Ed25519 public key is shareable.
            'publicKey' => $kp['alg'] === 'Ed25519' ? $kp['public'] : null,
        ];
    }
}

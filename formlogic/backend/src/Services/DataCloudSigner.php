<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Support\DataCanonicalJson;

/**
 * Cloud-side Ed25519 signing identity for data-node artifacts
 * (docs/FORMLOGIC_DATA_NODES.md §9-N2, plan §6 "dedicated service replica
 * signing key").
 *
 * N2 scope: signs snapshot backup manifests + synthesized checkpoints so a
 * Desktop can verify package INTEGRITY end-to-end. It is NOT the owner chain:
 * until N3 placement binds this key's fingerprint under the owner's vault
 * signature, desktops pin it TOFU over the authenticated API channel and
 * label results "provenance: cloud-signed (owner chain pending)".
 *
 * Key material: 32-byte seed, base64 in DATA_CLOUD_SIGNING_SEED when set
 * (multi-server installs), else generated once into
 * <storage>/keys/data-cloud-signing.key (0600). The seed never leaves the
 * server; only the public key is served.
 */
final class DataCloudSigner
{
    private ?string $seed = null;

    public function __construct(
        private string $keyFilePath,
        private ?string $envSeedB64 = null,
    ) {
    }

    /** @return array{publicKey: string, keyId: string, fingerprint: string} */
    public function publicIdentity(): array
    {
        $pk = $this->publicKeyRaw();
        return [
            'publicKey' => base64_encode($pk),
            'keyId' => DataCanonicalJson::keyId($pk),
            'fingerprint' => DataCanonicalJson::fingerprint($pk),
        ];
    }

    /** Sign a structure (without its signature field) under the given domain. */
    public function sign(string $domain, mixed $structure): string
    {
        $pair = sodium_crypto_sign_seed_keypair($this->seedRaw());
        $sk = sodium_crypto_sign_secretkey($pair);
        try {
            return DataCanonicalJson::signB64($domain, $structure, $sk);
        } finally {
            sodium_memzero($sk);
        }
    }

    public function publicKeyRaw(): string
    {
        $pair = sodium_crypto_sign_seed_keypair($this->seedRaw());
        return sodium_crypto_sign_publickey($pair);
    }

    private function seedRaw(): string
    {
        if ($this->seed !== null) {
            return $this->seed;
        }
        if ($this->envSeedB64 !== null && $this->envSeedB64 !== '') {
            $decoded = base64_decode($this->envSeedB64, true);
            if (!is_string($decoded) || strlen($decoded) !== SODIUM_CRYPTO_SIGN_SEEDBYTES) {
                throw new \RuntimeException('DATA_CLOUD_SIGNING_SEED must be base64 of exactly 32 bytes');
            }
            return $this->seed = $decoded;
        }
        if (is_file($this->keyFilePath)) {
            $decoded = base64_decode(trim((string) file_get_contents($this->keyFilePath)), true);
            if (is_string($decoded) && strlen($decoded) === SODIUM_CRYPTO_SIGN_SEEDBYTES) {
                return $this->seed = $decoded;
            }
            // Malformed key file: fail closed rather than silently rotating the
            // signer (desktops pin the public key — a silent rotation would
            // brick every pinned node until re-pairing).
            throw new \RuntimeException('data-cloud-signing.key is malformed; refusing to rotate silently');
        }
        $dir = dirname($this->keyFilePath);
        if (!is_dir($dir) && !mkdir($dir, 0700, true) && !is_dir($dir)) {
            throw new \RuntimeException('could not create the signing key directory');
        }

        // First-boot generation is SERIALIZED across workers (audit FL-07): without a
        // lock, concurrent workers each generate a different seed, race one fixed temp
        // path, and split the signing identity (desktops pin the public key — a split
        // identity breaks verification for whichever nodes pinned the loser). The lock
        // file is separate from the key file so the key is only ever observed complete.
        $lockPath = $this->keyFilePath . '.lock';
        $lock = fopen($lockPath, 'c');
        if ($lock === false) {
            throw new \RuntimeException('could not open the cloud signing key lock file');
        }
        try {
            if (!flock($lock, LOCK_EX)) {
                throw new \RuntimeException('could not lock the cloud signing key file');
            }
            // Another worker may have published while we waited on the lock.
            if (!is_file($this->keyFilePath)) {
                $seed = random_bytes(SODIUM_CRYPTO_SIGN_SEEDBYTES);
                // Unique temp name (never a shared fixed path) + exclusive create;
                // permissions are restricted BEFORE the secret is written, so the
                // seed is never readable under a permissive umask even briefly.
                $tmp = $this->keyFilePath . '.tmp.' . bin2hex(random_bytes(8));
                $fh = fopen($tmp, 'x');
                if ($fh === false) {
                    throw new \RuntimeException('could not create the cloud signing seed temp file');
                }
                try {
                    @chmod($tmp, 0600);
                    if (fwrite($fh, base64_encode($seed)) === false || !fflush($fh)) {
                        throw new \RuntimeException('could not write the cloud signing seed');
                    }
                    if (function_exists('fsync')) {
                        fsync($fh);
                    }
                } finally {
                    fclose($fh);
                }
                if (!rename($tmp, $this->keyFilePath)) {
                    @unlink($tmp);
                    throw new \RuntimeException('could not persist the cloud signing seed');
                }
                @chmod($this->keyFilePath, 0600);
            }
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }

        // ALWAYS re-read and validate the persisted file before caching: every worker
        // must end up signing with the seed that actually won publication, never the
        // one it happened to generate locally.
        $decoded = base64_decode(trim((string) file_get_contents($this->keyFilePath)), true);
        if (!is_string($decoded) || strlen($decoded) !== SODIUM_CRYPTO_SIGN_SEEDBYTES) {
            throw new \RuntimeException('persisted cloud signing seed failed validation');
        }
        return $this->seed = $decoded;
    }
}

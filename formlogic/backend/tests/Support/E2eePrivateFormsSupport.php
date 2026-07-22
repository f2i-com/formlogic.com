<?php

declare(strict_types=1);

namespace FormLogic\Tests\Support;

use FormLogic\Services\EnvelopeValidator;
use PDO;

/**
 * Shared fixtures for the E2EE Private Forms integration tests: real sodium
 * keypairs, vault bodies, enable bodies with REAL Ed25519 manifest + grant
 * signatures, and structurally-valid __flenc:1 envelopes. Canonical strings
 * are rebuilt here INDEPENDENTLY of FormEncryptionService so a drift in either
 * side fails the signature check instead of silently agreeing.
 */
trait E2eePrivateFormsSupport
{
    /**
     * @return array{signSk: string, signPk: string, boxSk: string, boxPk: string}
     *         raw byte strings (sign* = Ed25519, box* = X25519)
     */
    protected function makeKeys(): array
    {
        $signKp = sodium_crypto_sign_keypair();
        $boxKp = sodium_crypto_box_keypair();
        return [
            'signSk' => sodium_crypto_sign_secretkey($signKp),
            'signPk' => sodium_crypto_sign_publickey($signKp),
            'boxSk' => sodium_crypto_box_secretkey($boxKp),
            'boxPk' => sodium_crypto_box_publickey($boxKp),
        ];
    }

    /** A valid PUT /api/vault body for the given keys. @return array<string,mixed> */
    protected function vaultBody(array $keys): array
    {
        return [
            'kdf' => 'argon2id13.1',
            'kdfSalt' => base64_encode(random_bytes(16)),
            'kdfOpslimit' => 3,
            'kdfMemlimit' => 67_108_864,
            'wrappedUmk' => base64_encode(random_bytes(72)),
            'wrappedUmkRecovery' => base64_encode(random_bytes(72)),
            'encKeyBundle' => base64_encode(random_bytes(160)),
            'x25519Pk' => base64_encode($keys['boxPk']),
            'ed25519Pk' => base64_encode($keys['signPk']),
        ];
    }

    /**
     * A complete, correctly-signed POST /api/forms/{id}/encryption body.
     *
     * @param array{signSk: string, signPk: string, boxPk: string} $keys the OWNER's vault keys
     * @return array<string,mixed>
     */
    protected function enableBody(string $formId, string $userId, array $keys, string $schemaJson): array
    {
        $keyId = 'fik_' . bin2hex(random_bytes(8));
        $grantId = 'fkg_' . bin2hex(random_bytes(8));
        $ingestPkB64 = base64_encode(random_bytes(32));
        $wrappedKey = random_bytes(80);
        $schemaHash = hash('sha256', $schemaJson);
        $signerKeyId = substr(hash('sha256', $keys['signPk']), 0, 16);

        $manifestCanonical = 'flmanifest:1|' . $formId . '|' . $keyId . '|1|' . $ingestPkB64
            . '|' . EnvelopeValidator::CONTENT_SUITE . '|' . EnvelopeValidator::WRAP_SUITE
            . '|1|' . $schemaHash . '|' . $signerKeyId . '|-';
        $grantCanonical = 'flgrant:1|' . $grantId . '|' . $formId . '|1|' . $userId . '|' . $userId
            . '|' . hash('sha256', $keys['boxPk']) . '|' . hash('sha256', $wrappedKey)
            . '|' . EnvelopeValidator::WRAP_SUITE . '|owner|-';

        return [
            'keyId' => $keyId,
            'ingestEpoch' => 1,
            'fkEpoch' => 1,
            'ingestionPublicKey' => $ingestPkB64,
            'wrappedIngestionSecret' => base64_encode(random_bytes(72)),
            'grant' => [
                'grantId' => $grantId,
                'wrappedKey' => base64_encode($wrappedKey),
                'signature' => base64_encode(sodium_crypto_sign_detached($grantCanonical, $keys['signSk'])),
                'role' => 'owner',
                'sigVersion' => 1,
            ],
            'schema' => ['schemaJson' => $schemaJson, 'schemaHash' => $schemaHash],
            'manifest' => [
                'signature' => base64_encode(sodium_crypto_sign_detached($manifestCanonical, $keys['signSk'])),
                'signerKeyId' => $signerKeyId,
                'expiresAt' => null,
            ],
        ];
    }

    /** A signed schema-publish body for version $version. @return array<string,mixed> */
    protected function schemaPublishBody(string $formId, array $keys, string $schemaJson, int $version, string $keyId, string $ingestPkB64, int $epoch = 1): array
    {
        $schemaHash = hash('sha256', $schemaJson);
        $signerKeyId = substr(hash('sha256', $keys['signPk']), 0, 16);
        $canonical = 'flmanifest:1|' . $formId . '|' . $keyId . '|' . $epoch . '|' . $ingestPkB64
            . '|' . EnvelopeValidator::CONTENT_SUITE . '|' . EnvelopeValidator::WRAP_SUITE
            . '|' . $version . '|' . $schemaHash . '|' . $signerKeyId . '|-';
        return [
            'schema' => ['schemaJson' => $schemaJson, 'schemaHash' => $schemaHash],
            'manifest' => [
                'signature' => base64_encode(sodium_crypto_sign_detached($canonical, $keys['signSk'])),
                'signerKeyId' => $signerKeyId,
                'expiresAt' => null,
            ],
        ];
    }

    /**
     * A structurally-valid __flenc:1 envelope for a stored manifest tuple.
     *
     * @return array<string,mixed>
     */
    protected function makeEnvelope(string $keyId, string $schemaHash, ?string $recordId = null, int $rev = 1, int $epoch = 1, int $schemaVersion = 1): array
    {
        return [
            '__flenc' => 1,
            'recordId' => $recordId ?? $this->uuid4(),
            'rev' => $rev,
            'keyId' => $keyId,
            'epoch' => $epoch,
            'content' => EnvelopeValidator::CONTENT_SUITE,
            'wrap' => EnvelopeValidator::WRAP_SUITE,
            'schemaVersion' => $schemaVersion,
            'schemaHash' => $schemaHash,
            'wrappedDek' => base64_encode(random_bytes(80)),
            'nonce' => base64_encode(random_bytes(24)),
            'ct' => base64_encode(random_bytes(96)),
        ];
    }

    protected function uuid4(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }

    /** Insert a bare users row (FK target for forms/vaults) and return its id. */
    protected function insertUser(PDO $pdo, string $prefix = 'u'): string
    {
        $id = $prefix . '-' . bin2hex(random_bytes(12));
        $pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan, cloud_until) VALUES (?, ?, 'x', 'E2EE Test', 'personal', DATE_ADD(NOW(), INTERVAL 30 DAY))")
            ->execute([$id, $id . '@test.local']);
        return $id;
    }
}

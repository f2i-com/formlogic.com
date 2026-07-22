<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Services\DataCloudSigner;
use FormLogic\Services\DataNodeService;
use FormLogic\Services\DataPlacementService;
use FormLogic\Support\DataCanonicalJson;

/**
 * N3a — node enrolment/approval + the epoch-1 placement baseline
 * (plan §13.1-§13.2, §6; docs/FORMLOGIC_DATA_NODES.md §11): identity is
 * server-derived from the raw key, approval requires a fully-matching
 * owner-signed flnodecert:1, key rotation demands re-approval, and the
 * placement baseline is owner-signed, structure-checked, and CAS-protected.
 */
final class DataNodeEnrolmentTest extends E2eeTestCase
{
    private static DataNodeService $nodes;
    private static DataPlacementService $placement;
    private static DataCloudSigner $signer;

    public static function setUpBeforeClass(): void
    {
        parent::setUpBeforeClass();
        if (self::$mysql === null) {
            return;
        }
        self::$nodes = new DataNodeService(self::$mysql);
        self::$signer = new DataCloudSigner(self::$tmpRoot . '/keys/data-cloud-signing.key');
        self::$placement = new DataPlacementService(self::$mysql, self::$signer);
    }

    /** @return array{apiKeyId: string, connectionId: string} */
    private function makeConnection(): array
    {
        $apiKeyId = 'ak-' . bin2hex(random_bytes(8));
        $connectionId = 'dc-' . bin2hex(random_bytes(8));
        self::$pdo->prepare(
            'INSERT INTO desktop_connections (id, owner_user_id, device_name, desktop_instance_id, api_key_id)
             VALUES (?, ?, "Test Desktop", ?, ?)'
        )->execute([$connectionId, $this->userId, 'inst-' . bin2hex(random_bytes(6)), $apiKeyId]);
        return ['apiKeyId' => $apiKeyId, 'connectionId' => $connectionId];
    }

    /** @return array<string,mixed> */
    private function signedCert(array $node, array $vault, array $over = []): array
    {
        $edPkRaw = base64_decode($vault['ed25519PkB64']);
        $cert = array_merge([
            'protocol' => 'formlogic-data-sync/1',
            'kind' => 'node-authority',
            'nodeId' => $node['id'],
            'connectionId' => $node['connectionId'],
            'ownerUserId' => $this->userId,
            'signingKeyId' => $node['signingKeyId'],
            'signingKeyGeneration' => $node['signingKeyGeneration'],
            'signingPublicKey' => $node['signingPublicKey'],
            'fingerprint' => $node['fingerprint'],
            'capabilities' => ['storage'],
            'issuedAt' => gmdate('Y-m-d\TH:i:s\Z'),
            'expiresAt' => null,
            'ownerSignerKeyId' => DataCanonicalJson::keyId($edPkRaw),
            'ownerSignerFingerprint' => DataCanonicalJson::fingerprint($edPkRaw),
        ], $over);
        $cert['signature'] = DataCanonicalJson::signB64(
            DataCanonicalJson::DOMAIN_NODE_CERT,
            $cert,
            $vault['ed25519SkRaw'],
        );
        return $cert;
    }

    public function testEnrolmentApprovalRotationAndRevocation(): void
    {
        $vault = $this->makeVault($this->userId);
        $conn = $this->makeConnection();
        $pair = sodium_crypto_sign_keypair();
        $pkB64 = base64_encode(sodium_crypto_sign_publickey($pair));

        // Registration derives identity server-side — bogus client-sent
        // keyId/fingerprint are ignored, never trusted.
        $node = self::$nodes->register($this->userId, $conn['apiKeyId'], [
            'signingPublicKey' => $pkB64,
            'displayName' => 'Office PC',
            'keyId' => 'ffffffffffffffff',
            'fingerprint' => str_repeat('f', 64),
        ]);
        self::assertSame('pending', $node['status']);
        self::assertFalse($node['approved']);
        self::assertSame(DataCanonicalJson::keyId(base64_decode($pkB64)), $node['signingKeyId']);
        self::assertSame(DataCanonicalJson::fingerprint(base64_decode($pkB64)), $node['fingerprint']);
        self::assertSame(1, $node['signingKeyGeneration']);

        // A tampered certificate field is refused; a wrong signer is refused.
        $edPkRaw = base64_decode($vault['ed25519PkB64']);
        try {
            self::$nodes->approve($this->userId, $node['id'], $this->signedCert($node, $vault, ['fingerprint' => str_repeat('0', 64)]), $edPkRaw);
            self::fail('mismatched cert must be refused');
        } catch (\RuntimeException $e) {
            self::assertStringStartsWith('data_node_cert_mismatch', $e->getMessage());
        }
        $mallory = $this->makeVault($this->makeUser());
        $cert = $this->signedCert($node, $vault);
        $cert['signature'] = DataCanonicalJson::signB64(DataCanonicalJson::DOMAIN_NODE_CERT, array_diff_key($cert, ['signature' => true]), $mallory['ed25519SkRaw']);
        try {
            self::$nodes->approve($this->userId, $node['id'], $cert, $edPkRaw);
            self::fail('foreign signer must be refused');
        } catch (\RuntimeException $e) {
            self::assertSame('data_node_cert_signature', $e->getMessage());
        }

        // A correct owner-signed certificate approves the node.
        $approved = self::$nodes->approve($this->userId, $node['id'], $this->signedCert($node, $vault), $edPkRaw);
        self::assertSame('approved', $approved['status']);
        self::assertTrue($approved['approved']);

        // Key ROTATION drops authority: pending again, generation bumped,
        // certificate cleared — the old cert cannot re-approve (generation
        // mismatch).
        $newPair = sodium_crypto_sign_keypair();
        $rotated = self::$nodes->register($this->userId, $conn['apiKeyId'], [
            'signingPublicKey' => base64_encode(sodium_crypto_sign_publickey($newPair)),
        ]);
        self::assertSame($node['id'], $rotated['id'], 'one node per connection');
        self::assertSame('pending', $rotated['status']);
        self::assertSame(2, $rotated['signingKeyGeneration']);
        self::assertFalse($rotated['approved']);
        try {
            self::$nodes->approve($this->userId, $node['id'], $this->signedCert($node, $vault), $edPkRaw);
            self::fail('stale-generation cert must be refused');
        } catch (\RuntimeException $e) {
            self::assertStringStartsWith('data_node_cert_mismatch', $e->getMessage());
        }

        // Revocation sticks; approve on a revoked node is refused.
        $revoked = self::$nodes->revoke($this->userId, $node['id']);
        self::assertSame('revoked', $revoked['status']);
        try {
            self::$nodes->approve($this->userId, $node['id'], $this->signedCert($rotated, $vault), $edPkRaw);
            self::fail('revoked node must not be approvable');
        } catch (\RuntimeException $e) {
            self::assertSame('data_node_revoked', $e->getMessage());
        }
        self::$pdo->prepare('DELETE FROM data_nodes WHERE id = ?')->execute([$node['id']]);
        self::$pdo->prepare('DELETE FROM desktop_connections WHERE id = ?')->execute([$conn['connectionId']]);
    }

    /** @return array<string,mixed> */
    private function signedBaseline(string $formId, array $vault, array $over = []): array
    {
        $edPkRaw = base64_decode($vault['ed25519PkB64']);
        $identity = self::$signer->publicIdentity();
        $authority = [
            'keyId' => $identity['keyId'],
            'generation' => 1,
            'ed25519PublicKey' => $identity['publicKey'],
            'fingerprint' => $identity['fingerprint'],
        ];
        $manifest = array_merge([
            'protocol' => 'formlogic-data-sync/1',
            'datasetId' => $formId,
            'formId' => $formId,
            'protocolVersion' => 1,
            'storageEpoch' => 1,
            'primaryReplicaId' => 'cloud',
            'replicas' => [[
                'replicaId' => 'cloud',
                'kind' => 'cloud',
                'role' => 'primary',
                'desiredState' => 'active',
                'authoritySigningKey' => $authority,
                'transportKeyFingerprint' => $identity['fingerprint'],
            ]],
            'offlineSubmissionPolicy' => ['mode' => 'reject'],
            'readFallbackPolicy' => ['mode' => 'none'],
            'leaseAuthority' => $authority,
            'cutoverCheckpointHash' => null,
            'recoveryAuthorization' => null,
            'previousManifestHash' => null,
            'createdAt' => gmdate('Y-m-d\TH:i:s\Z'),
            'ownerSignerKeyId' => DataCanonicalJson::keyId($edPkRaw),
            'ownerSignerGeneration' => 1,
            'ownerSignerFingerprint' => DataCanonicalJson::fingerprint($edPkRaw),
        ], $over);
        $manifest['signature'] = DataCanonicalJson::signB64(
            DataCanonicalJson::DOMAIN_PLACEMENT,
            $manifest,
            $vault['ed25519SkRaw'],
        );
        return $manifest;
    }

    public function testPlacementBaselineSignedCasAndEligibility(): void
    {
        $form = $this->makeDraftForm();
        $formId = (string) $form['id'];
        ['vault' => $vault] = $this->enablePrivateForm($formId);
        $edPkRaw = base64_decode($vault['ed25519PkB64']);

        $before = self::$placement->get($formId, $this->userId);
        self::assertTrue($before['legacyCloudPrimary']);
        self::assertNull($before['placement']);

        // Wrong-epoch and tampered structures are refused before any write.
        try {
            self::$placement->putBaseline($formId, $this->userId, $this->signedBaseline($formId, $vault, ['storageEpoch' => 2]), $edPkRaw);
            self::fail('epoch 2 without epoch 1 must be refused');
        } catch (\RuntimeException $e) {
            self::assertStringStartsWith('placement_invalid', $e->getMessage());
        }
        $bad = $this->signedBaseline($formId, $vault);
        $bad['primaryReplicaId'] = 'desktop';
        try {
            self::$placement->putBaseline($formId, $this->userId, $bad, $edPkRaw);
            self::fail('signed-field tamper must be refused');
        } catch (\RuntimeException $e) {
            self::assertStringStartsWith('placement_invalid', $e->getMessage());
        }

        // The correct owner-signed baseline lands and re-verifies from storage.
        $state = self::$placement->putBaseline($formId, $this->userId, $this->signedBaseline($formId, $vault), $edPkRaw);
        self::assertFalse($state['legacyCloudPrimary']);
        self::assertSame(1, $state['placement']['storageEpoch']);
        $stored = $state['placement']['manifest'];
        self::assertTrue(DataCanonicalJson::verify(DataCanonicalJson::DOMAIN_PLACEMENT, $stored, $edPkRaw));
        self::assertSame(
            $state['placement']['manifestHash'],
            DataCanonicalJson::hashHex(DataCanonicalJson::DOMAIN_PLACEMENT, array_diff_key($stored, ['signature' => true])),
        );

        // CAS: a second baseline conflicts; plaintext forms are ineligible.
        try {
            self::$placement->putBaseline($formId, $this->userId, $this->signedBaseline($formId, $vault), $edPkRaw);
            self::fail('duplicate baseline must conflict');
        } catch (\RuntimeException $e) {
            self::assertSame('placement_conflict', $e->getMessage());
        }
        $plain = $this->makeDraftForm();
        try {
            self::$placement->get((string) $plain['id'], $this->userId);
            self::fail('plaintext form must be ineligible');
        } catch (\RuntimeException $e) {
            self::assertSame('placement_form_ineligible', $e->getMessage());
        }
        self::$pdo->prepare('DELETE FROM data_placement_manifests WHERE dataset_id = ?')->execute([$formId]);
    }
}

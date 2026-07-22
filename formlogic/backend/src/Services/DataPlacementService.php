<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use FormLogic\Support\DataCanonicalJson;

/**
 * Owner-signed data placement (plan §6, docs/FORMLOGIC_DATA_NODES.md §11).
 *
 * N3a scope: the EPOCH-1 BASELINE only. An existing Private form starts as
 * legacy_cloud_primary (no manifest rows); the owner's first visit to Data
 * Storage signs a storageEpoch-1 flplacement:1 manifest with their VAULT
 * Ed25519 key, declaring Cloud as the (only) primary replica and binding the
 * Cloud service signing key as its authority + lease authority. That signed
 * baseline is what upgrades snapshot provenance beyond TOFU and is the
 * prerequisite for every migration/replica epoch (plan §6: "No migration or
 * replica enrolment is allowed until that signed baseline exists").
 *
 * The manifest is append-only and CAS-protected by UNIQUE(dataset, epoch);
 * epochs > 1 (replica enrolment, desktop primary, cutover) arrive with N3b+.
 */
final class DataPlacementService
{
    public const PROTOCOL = 'formlogic-data-sync/1';

    public function __construct(
        private MySQLConnection $mysql,
        private DataCloudSigner $signer,
    ) {
    }

    /**
     * Current placement state for the owner's Private form.
     * @return array<string,mixed>
     */
    public function get(string $formId, string $userId): array
    {
        $this->assertOwnedPrivateForm($formId, $userId);
        $row = $this->latest($formId);
        return [
            'formId' => $formId,
            'placement' => $row === null ? null : [
                'storageEpoch' => (int) $row['storage_epoch'],
                'manifestHash' => $row['manifest_hash'],
                'primaryReplicaId' => $row['primary_replica_id'],
                'createdAt' => $row['created_at'],
                'manifest' => json_decode((string) $row['signed_bytes'], true),
            ],
            'legacyCloudPrimary' => $row === null,
            'cloudSigner' => $this->signer->publicIdentity(),
        ];
    }

    /**
     * Store the owner-signed epoch-1 baseline after full verification.
     *
     * @param array<string,mixed> $manifest
     * @param string $ownerEd25519PkRaw raw vault signing public key
     * @return array<string,mixed>
     */
    public function putBaseline(string $formId, string $userId, array $manifest, string $ownerEd25519PkRaw): array
    {
        $this->assertOwnedPrivateForm($formId, $userId);
        if ($this->latest($formId) !== null) {
            throw new \RuntimeException('placement_conflict');
        }

        $signerIdentity = $this->signer->publicIdentity();
        $expectedAuthority = [
            'keyId' => $signerIdentity['keyId'],
            'generation' => 1,
            'ed25519PublicKey' => $signerIdentity['publicKey'],
            'fingerprint' => $signerIdentity['fingerprint'],
        ];
        $expect = [
            'protocol' => self::PROTOCOL,
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
                'authoritySigningKey' => $expectedAuthority,
                'transportKeyFingerprint' => $signerIdentity['fingerprint'],
            ]],
            'offlineSubmissionPolicy' => ['mode' => 'reject'],
            'readFallbackPolicy' => ['mode' => 'none'],
            'leaseAuthority' => $expectedAuthority,
            'cutoverCheckpointHash' => null,
            'recoveryAuthorization' => null,
            'previousManifestHash' => null,
            'ownerSignerKeyId' => DataCanonicalJson::keyId($ownerEd25519PkRaw),
            'ownerSignerGeneration' => 1,
            'ownerSignerFingerprint' => DataCanonicalJson::fingerprint($ownerEd25519PkRaw),
        ];
        foreach ($expect as $field => $value) {
            if (($manifest[$field] ?? null) !== $value) {
                throw new \RuntimeException('placement_invalid:' . $field);
            }
        }
        if (!is_string($manifest['createdAt'] ?? null)) {
            throw new \RuntimeException('placement_invalid:createdAt');
        }
        if (!DataCanonicalJson::verify(DataCanonicalJson::DOMAIN_PLACEMENT, $manifest, $ownerEd25519PkRaw)) {
            throw new \RuntimeException('placement_signature_invalid');
        }

        $hash = DataCanonicalJson::hashHex(
            DataCanonicalJson::DOMAIN_PLACEMENT,
            array_diff_key($manifest, ['signature' => true]),
        );
        $pdo = $this->mysql->getConnection();
        try {
            $pdo->prepare(
                'INSERT INTO data_placement_manifests (id, dataset_id, form_id, storage_epoch,
                    manifest_hash, previous_manifest_hash, primary_replica_id, signed_bytes,
                    owner_signer_key_id, owner_signer_fingerprint, created_at)
                 VALUES (?, ?, ?, 1, ?, NULL, "cloud", ?, ?, ?, ?)'
            )->execute([
                'dpm_' . bin2hex(random_bytes(16)),
                $formId,
                $formId,
                $hash,
                json_encode($manifest, JSON_UNESCAPED_SLASHES),
                $expect['ownerSignerKeyId'],
                $expect['ownerSignerFingerprint'],
                gmdate('Y-m-d H:i:s'),
            ]);
        } catch (\PDOException $e) {
            // UNIQUE(dataset, epoch) = the CAS: a concurrent baseline loses.
            if ((int) ($e->errorInfo[1] ?? 0) === 1062) {
                throw new \RuntimeException('placement_conflict');
            }
            throw $e;
        }
        return $this->get($formId, $userId);
    }

    private function latest(string $formId): ?array
    {
        $stmt = $this->mysql->getConnection()->prepare(
            'SELECT * FROM data_placement_manifests WHERE dataset_id = ? ORDER BY storage_epoch DESC LIMIT 1'
        );
        $stmt->execute([$formId]);
        $row = $stmt->fetch(\PDO::FETCH_ASSOC);
        return is_array($row) ? $row : null;
    }

    private function assertOwnedPrivateForm(string $formId, string $userId): void
    {
        $stmt = $this->mysql->getConnection()->prepare(
            'SELECT 1 FROM forms f JOIN form_encryption fe ON fe.form_id = f.id
             WHERE f.id = ? AND f.user_id = ? AND fe.mode = "private" AND fe.state IN ("active", "enabling")'
        );
        $stmt->execute([$formId, $userId]);
        if ($stmt->fetchColumn() === false) {
            // Placement is a Private-form concept only (plan §3.3).
            throw new \RuntimeException('placement_form_ineligible');
        }
    }
}

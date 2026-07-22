<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use FormLogic\Support\DataCanonicalJson;

/**
 * Data-node enrolment + owner approval (plan §13.1-§13.2,
 * docs/FORMLOGIC_DATA_NODES.md §11).
 *
 * A desktop REGISTERS its data-node signing identity over its authenticated
 * flk_ channel; the server derives keyId/fingerprint from the raw key itself
 * (never trusting client-computed values) and binds the node to the
 * desktop_connections row that owns the API key — never to a self-reported
 * instance id (plan §8.2). A node starts `pending` and grants NOTHING until
 * the owner approves it in the browser by signing an flnodecert:1
 * node-authority certificate with their VAULT Ed25519 key. A changed signing
 * key on re-registration is a rotation: the node drops back to `pending`,
 * its certificate is cleared, and its key generation increments — re-approval
 * is mandatory (plan §6 rotation rules).
 */
final class DataNodeService
{
    public const PROTOCOL = 'formlogic-data-sync/1';

    public function __construct(private MySQLConnection $mysql)
    {
    }

    /**
     * Register/heartbeat a node over the desktop's authenticated channel.
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    public function register(string $userId, string $apiKeyId, array $body): array
    {
        $pdo = $this->mysql->getConnection();
        $stmt = $pdo->prepare('SELECT id FROM desktop_connections WHERE owner_user_id = ? AND api_key_id = ?');
        $stmt->execute([$userId, $apiKeyId]);
        $connectionId = $stmt->fetchColumn();
        if (!is_string($connectionId)) {
            throw new \RuntimeException('data_node_no_connection');
        }

        $pkRaw = base64_decode((string) ($body['signingPublicKey'] ?? ''), true);
        if (!is_string($pkRaw) || strlen($pkRaw) !== SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES) {
            throw new \RuntimeException('data_node_bad_key');
        }
        $pkB64 = base64_encode($pkRaw);
        $keyId = DataCanonicalJson::keyId($pkRaw);
        $fingerprint = DataCanonicalJson::fingerprint($pkRaw);
        $displayName = mb_substr(trim((string) ($body['displayName'] ?? 'FormLogic Desktop')), 0, 120) ?: 'FormLogic Desktop';
        $transportFp = (string) ($body['transportKeyFingerprint'] ?? '');
        $transportFp = preg_match('/^[0-9a-f]{64}$/', $transportFp) ? $transportFp : null;
        $protocolMin = max(1, (int) ($body['protocolMin'] ?? 1));
        $protocolMax = max($protocolMin, (int) ($body['protocolMax'] ?? 1));
        $capabilities = array_values(array_filter(
            array_slice((array) ($body['capabilities'] ?? ['storage']), 0, 10),
            static fn($c) => is_string($c) && $c !== '' && strlen($c) <= 40,
        ));
        $now = gmdate('Y-m-d H:i:s');

        $stmt = $pdo->prepare('SELECT * FROM data_nodes WHERE desktop_connection_id = ?');
        $stmt->execute([$connectionId]);
        $existing = $stmt->fetch(\PDO::FETCH_ASSOC);

        if (is_array($existing)) {
            if ($existing['signing_public_key'] !== $pkB64) {
                // Key rotation: authority resets until the owner re-approves.
                $pdo->prepare(
                    'UPDATE data_nodes SET signing_public_key = ?, signing_key_id = ?, fingerprint = ?,
                        signing_key_generation = signing_key_generation + 1, status = "pending",
                        owner_signed_certificate = NULL, certificate_expires_at = NULL,
                        roster_revision = roster_revision + 1, display_name = ?, transport_key_fingerprint = ?,
                        protocol_min = ?, protocol_max = ?, capabilities_json = ?,
                        last_seen_at = ?, last_storage_heartbeat_at = ?, updated_at = ?
                     WHERE id = ?'
                )->execute([
                    $pkB64, $keyId, $fingerprint, $displayName, $transportFp,
                    $protocolMin, $protocolMax, json_encode($capabilities), $now, $now, $now,
                    $existing['id'],
                ]);
            } else {
                $pdo->prepare(
                    'UPDATE data_nodes SET display_name = ?, transport_key_fingerprint = ?,
                        protocol_min = ?, protocol_max = ?, capabilities_json = ?,
                        last_seen_at = ?, last_storage_heartbeat_at = ?, updated_at = ?
                     WHERE id = ?'
                )->execute([
                    $displayName, $transportFp, $protocolMin, $protocolMax,
                    json_encode($capabilities), $now, $now, $now, $existing['id'],
                ]);
            }
            return $this->format($this->rowById((string) $existing['id']));
        }

        $id = 'dn_' . bin2hex(random_bytes(16));
        $pdo->prepare(
            'INSERT INTO data_nodes (id, desktop_connection_id, owner_user_id, display_name,
                signing_public_key, signing_key_id, signing_key_generation, fingerprint,
                transport_key_fingerprint, protocol_min, protocol_max, capabilities_json,
                roster_revision, last_seen_at, last_storage_heartbeat_at, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 1, ?, ?, "pending", ?, ?)'
        )->execute([
            $id, $connectionId, $userId, $displayName, $pkB64, $keyId, $fingerprint,
            $transportFp, $protocolMin, $protocolMax, json_encode($capabilities),
            $now, $now, $now, $now,
        ]);
        return $this->format($this->rowById($id));
    }

    /** @return list<array<string,mixed>> */
    public function listForOwner(string $userId): array
    {
        $stmt = $this->mysql->getConnection()
            ->prepare('SELECT * FROM data_nodes WHERE owner_user_id = ? ORDER BY created_at');
        $stmt->execute([$userId]);
        return array_map(fn(array $r) => $this->format($r), $stmt->fetchAll(\PDO::FETCH_ASSOC));
    }

    /** The node bound to the calling desktop's API key, or null. */
    public function selfForConnection(string $userId, string $apiKeyId): ?array
    {
        $stmt = $this->mysql->getConnection()->prepare(
            'SELECT n.* FROM data_nodes n
             JOIN desktop_connections c ON c.id = n.desktop_connection_id
             WHERE n.owner_user_id = ? AND c.api_key_id = ?'
        );
        $stmt->execute([$userId, $apiKeyId]);
        $row = $stmt->fetch(\PDO::FETCH_ASSOC);
        return is_array($row) ? $this->format($row) : null;
    }

    /**
     * Store the owner-signed flnodecert:1 node-authority certificate after
     * FULL verification against the node row AND the owner's vault key.
     *
     * @param array<string,mixed> $certificate
     * @param string $ownerEd25519PkRaw raw 32-byte vault signing public key
     */
    public function approve(string $userId, string $nodeId, array $certificate, string $ownerEd25519PkRaw): array
    {
        $row = $this->rowById($nodeId);
        if ($row === null || $row['owner_user_id'] !== $userId) {
            throw new \RuntimeException('data_node_not_found');
        }
        if ($row['status'] === 'revoked') {
            throw new \RuntimeException('data_node_revoked');
        }
        $expect = [
            'protocol' => self::PROTOCOL,
            'kind' => 'node-authority',
            'nodeId' => $row['id'],
            'connectionId' => $row['desktop_connection_id'],
            'ownerUserId' => $userId,
            'signingKeyId' => $row['signing_key_id'],
            'signingKeyGeneration' => (int) $row['signing_key_generation'],
            'signingPublicKey' => $row['signing_public_key'],
            'fingerprint' => $row['fingerprint'],
            'ownerSignerKeyId' => DataCanonicalJson::keyId($ownerEd25519PkRaw),
            'ownerSignerFingerprint' => DataCanonicalJson::fingerprint($ownerEd25519PkRaw),
        ];
        foreach ($expect as $field => $value) {
            if (($certificate[$field] ?? null) !== $value) {
                throw new \RuntimeException('data_node_cert_mismatch:' . $field);
            }
        }
        if (!is_array($certificate['capabilities'] ?? null) || !is_string($certificate['issuedAt'] ?? null)) {
            throw new \RuntimeException('data_node_cert_mismatch:shape');
        }
        $expiresAt = $certificate['expiresAt'] ?? null;
        if ($expiresAt !== null && !is_string($expiresAt)) {
            throw new \RuntimeException('data_node_cert_mismatch:expiresAt');
        }
        if (!DataCanonicalJson::verify(DataCanonicalJson::DOMAIN_NODE_CERT, $certificate, $ownerEd25519PkRaw)) {
            throw new \RuntimeException('data_node_cert_signature');
        }
        $this->mysql->getConnection()->prepare(
            'UPDATE data_nodes SET status = "approved", owner_signed_certificate = ?,
                certificate_expires_at = ?, roster_revision = roster_revision + 1, updated_at = ?
             WHERE id = ?'
        )->execute([
            json_encode($certificate, JSON_UNESCAPED_SLASHES),
            $expiresAt !== null ? str_replace(['T', 'Z'], [' ', ''], $expiresAt) : null,
            gmdate('Y-m-d H:i:s'),
            $nodeId,
        ]);
        return $this->format($this->rowById($nodeId));
    }

    /** Revoke node authority (plan §13.4 — credentials/data cleanup are separate actions). */
    public function revoke(string $userId, string $nodeId): array
    {
        $row = $this->rowById($nodeId);
        if ($row === null || $row['owner_user_id'] !== $userId) {
            throw new \RuntimeException('data_node_not_found');
        }
        $this->mysql->getConnection()->prepare(
            'UPDATE data_nodes SET status = "revoked", revoked_at = ?,
                roster_revision = roster_revision + 1, updated_at = ? WHERE id = ?'
        )->execute([gmdate('Y-m-d H:i:s'), gmdate('Y-m-d H:i:s'), $nodeId]);
        return $this->format($this->rowById($nodeId));
    }

    private function rowById(string $id): ?array
    {
        $stmt = $this->mysql->getConnection()->prepare('SELECT * FROM data_nodes WHERE id = ?');
        $stmt->execute([$id]);
        $row = $stmt->fetch(\PDO::FETCH_ASSOC);
        return is_array($row) ? $row : null;
    }

    /** @param array<string,mixed>|null $row */
    private function format(?array $row): array
    {
        if ($row === null) {
            throw new \RuntimeException('data_node_not_found');
        }
        return [
            'id' => $row['id'],
            'connectionId' => $row['desktop_connection_id'],
            'displayName' => $row['display_name'],
            'signingPublicKey' => $row['signing_public_key'],
            'signingKeyId' => $row['signing_key_id'],
            'signingKeyGeneration' => (int) $row['signing_key_generation'],
            'fingerprint' => $row['fingerprint'],
            'transportKeyFingerprint' => $row['transport_key_fingerprint'],
            'status' => $row['status'],
            'approved' => $row['status'] === 'approved' && $row['owner_signed_certificate'] !== null,
            'certificateExpiresAt' => $row['certificate_expires_at'],
            'protocolMin' => (int) $row['protocol_min'],
            'protocolMax' => (int) $row['protocol_max'],
            'capabilities' => json_decode((string) ($row['capabilities_json'] ?? '[]'), true) ?: [],
            'rosterRevision' => (int) $row['roster_revision'],
            'lastSeenAt' => $row['last_seen_at'],
            'revokedAt' => $row['revoked_at'],
            'createdAt' => $row['created_at'],
        ];
    }
}

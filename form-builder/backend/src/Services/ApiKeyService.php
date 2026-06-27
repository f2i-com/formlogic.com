<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;

class ApiKeyService
{
    private MySQLConnection $db;

    private const MAX_KEYS_PER_USER = 25;
    private const KEY_PREFIX = 'flk_';
    private const VALID_SCOPES = [
        'forms:read',
        'responses:read',
        'responses:write',
        'responses:manage',
        'webhooks:read',
        'webhooks:write',
    ];

    public function __construct(MySQLConnection $db)
    {
        $this->db = $db;
    }

    /**
     * Create a new API key for a user.
     * Returns the full key (only time it's available) plus key metadata.
     */
    public function createKey(string $userId, string $name, array $scopes, ?array $formIds = null, ?string $expiresAt = null): array
    {
        $pdo = $this->db->getConnection();

        // Validate name
        $name = trim($name);
        if (empty($name) || strlen($name) > 255) {
            throw new \InvalidArgumentException('Key name is required and must be under 255 characters');
        }

        // Validate scopes
        if (empty($scopes)) {
            throw new \InvalidArgumentException('At least one scope is required');
        }
        foreach ($scopes as $scope) {
            if (!in_array($scope, self::VALID_SCOPES, true)) {
                throw new \InvalidArgumentException("Invalid scope: $scope");
            }
        }

        // Validate formIds if provided
        if ($formIds !== null) {
            if (!is_array($formIds) || empty($formIds)) {
                throw new \InvalidArgumentException('formIds must be a non-empty array of form IDs');
            }
            foreach ($formIds as $id) {
                if (!is_string($id) || !preg_match('/^[a-f0-9\-]{36}$/', $id)) {
                    throw new \InvalidArgumentException('Each formId must be a valid UUID');
                }
            }
        }

        // Validate expiry if provided
        if ($expiresAt !== null) {
            $ts = strtotime($expiresAt);
            if ($ts === false || $ts <= time()) {
                throw new \InvalidArgumentException('Expiration date must be in the future');
            }
            // Normalize to a MySQL-valid datetime so a relative/ambiguous but
            // strtotime-parseable value (e.g. "+30 days", "tomorrow") can't reach
            // the TIMESTAMP column and throw a strict-mode PDOException.
            $expiresAt = date('Y-m-d H:i:s', $ts);
        }

        // Use transaction to prevent race condition on key count check
        $pdo->beginTransaction();
        try {
            // Check key limit (within transaction for atomicity)
            $stmt = $pdo->prepare('SELECT COUNT(*) FROM api_keys WHERE user_id = ? AND is_active = 1');
            $stmt->execute([$userId]);
            if ((int) $stmt->fetchColumn() >= self::MAX_KEYS_PER_USER) {
                throw new \RuntimeException('Maximum number of API keys reached (' . self::MAX_KEYS_PER_USER . ')');
            }

            // Generate key: flk_ + 40 hex chars
            $rawKey = bin2hex(random_bytes(20));
            $fullKey = self::KEY_PREFIX . $rawKey;
            $keyPrefix = substr($fullKey, 0, 12);
            $keyHash = hash('sha256', $fullKey);

            $id = $this->generateId();

            $stmt = $pdo->prepare('
                INSERT INTO api_keys (id, user_id, name, key_prefix, key_hash, scopes, form_ids, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ');
            $stmt->execute([
                $id,
                $userId,
                $name,
                $keyPrefix,
                $keyHash,
                json_encode(array_values(array_unique($scopes))),
                $formIds !== null ? json_encode($formIds) : null,
                $expiresAt,
            ]);

            $pdo->commit();
        } catch (\Throwable $e) {
            // Roll back on ANY failure. PDOException extends RuntimeException, so the
            // previous RuntimeException-first catch rethrew DB errors WITHOUT a
            // rollback, leaving the transaction open.
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        return [
            'id' => $id,
            'name' => $name,
            'keyPrefix' => $keyPrefix,
            'key' => $fullKey,
            'scopes' => array_values(array_unique($scopes)),
            'formIds' => $formIds,
            'lastUsedAt' => null,
            'expiresAt' => $expiresAt,
            'createdAt' => date('c'),
        ];
    }

    /**
     * Validate an API key and return key data if valid.
     * Returns null if key is invalid, expired, or revoked.
     */
    public function validateKey(string $fullKey): ?array
    {
        if (strpos($fullKey, self::KEY_PREFIX) !== 0) {
            return null;
        }

        $keyHash = hash('sha256', $fullKey);
        $pdo = $this->db->getConnection();

        $stmt = $pdo->prepare('
            SELECT id, user_id, name, key_prefix, scopes, form_ids, expires_at, is_active
            FROM api_keys
            WHERE key_hash = ?
        ');
        $stmt->execute([$keyHash]);
        $row = $stmt->fetch(\PDO::FETCH_ASSOC);

        if (!$row) {
            return null;
        }

        if (!$row['is_active']) {
            return null;
        }

        // Check expiration
        if ($row['expires_at'] !== null && strtotime($row['expires_at']) <= time()) {
            return null;
        }

        return [
            'id' => $row['id'],
            'userId' => $row['user_id'],
            'name' => $row['name'],
            'keyPrefix' => $row['key_prefix'],
            'scopes' => json_decode($row['scopes'], true) ?: [],
            'formIds' => $row['form_ids'] !== null ? (json_decode($row['form_ids'], true) ?: []) : null,
        ];
    }

    /**
     * Update last_used_at and last_used_ip for usage tracking.
     */
    public function recordUsage(string $keyId, string $ip): void
    {
        $pdo = $this->db->getConnection();
        $stmt = $pdo->prepare('UPDATE api_keys SET last_used_at = NOW(), last_used_ip = ? WHERE id = ?');
        $stmt->execute([$ip, $keyId]);
    }

    /**
     * List all API keys for a user (never returns key hash).
     */
    public function listKeys(string $userId): array
    {
        $pdo = $this->db->getConnection();
        $stmt = $pdo->prepare('
            SELECT id, name, key_prefix, scopes, form_ids, last_used_at, last_used_ip, expires_at, is_active, created_at
            FROM api_keys
            WHERE user_id = ? AND is_active = 1
            ORDER BY created_at DESC
        ');
        $stmt->execute([$userId]);
        $rows = $stmt->fetchAll(\PDO::FETCH_ASSOC);

        return array_map(function ($row) {
            return [
                'id' => $row['id'],
                'name' => $row['name'],
                'keyPrefix' => $row['key_prefix'],
                'scopes' => json_decode($row['scopes'], true) ?: [],
                'formIds' => $row['form_ids'] !== null ? (json_decode($row['form_ids'], true) ?: []) : null,
                'lastUsedAt' => $row['last_used_at'],
                'expiresAt' => $row['expires_at'],
                'createdAt' => $row['created_at'],
            ];
        }, $rows);
    }

    /**
     * Revoke (soft-delete) an API key.
     */
    public function revokeKey(string $keyId, string $userId): bool
    {
        $pdo = $this->db->getConnection();
        $stmt = $pdo->prepare('UPDATE api_keys SET is_active = 0 WHERE id = ? AND user_id = ?');
        $stmt->execute([$keyId, $userId]);
        return $stmt->rowCount() > 0;
    }

    private function generateId(): string
    {
        return sprintf(
            '%04x%04x-%04x-%04x-%04x-%04x%04x%04x',
            random_int(0, 0xffff), random_int(0, 0xffff),
            random_int(0, 0xffff),
            random_int(0, 0x0fff) | 0x4000,
            random_int(0, 0x3fff) | 0x8000,
            random_int(0, 0xffff), random_int(0, 0xffff), random_int(0, 0xffff)
        );
    }
}

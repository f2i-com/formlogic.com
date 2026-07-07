<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use PDO;

/**
 * Flow KV storage (docs/FORMLOGIC_FLOWS.md §9): small persistent key/value state for flows,
 * keyed by (owner, app, scope, key). Scopes are free-form labels like 'flow:<slug>' or 'app'.
 *
 * The workspace scope stores app_id as '' (empty string, NOT NULL) so the MySQL UNIQUE key
 * actually dedupes — UNIQUE ignores NULLs — which is also why flow_kv carries no app FK.
 * The API surface maps appId null ↔ '' transparently.
 *
 * Caps (enforced here, on every write path): value ≤ 64 KiB (encoded JSON), ≤ 500 keys per
 * (owner, app, scope). $maxKeysPerScope is a constructor override for tests only.
 */
class FlowKvService
{
    public const MAX_VALUE_BYTES = 65536;      // 64 KiB per encoded value
    public const MAX_KEYS_PER_SCOPE = 500;
    public const SCOPE_PATTERN = '/^[a-z][a-z0-9:_.-]{0,63}$/';
    public const KEY_PATTERN = '/^[A-Za-z0-9][A-Za-z0-9:_.\/-]{0,189}$/';

    private PDO $mysql;
    private int $maxKeysPerScope;

    public function __construct(MySQLConnection $mysql, int $maxKeysPerScope = self::MAX_KEYS_PER_SCOPE)
    {
        $this->mysql = $mysql->getConnection();
        $this->maxKeysPerScope = $maxKeysPerScope;
    }

    /**
     * List entries for a scope (or every scope when $scope is null), values decoded.
     * @return array[]
     */
    public function list(string $ownerUserId, ?string $appId, ?string $scope = null): array
    {
        $where = 'owner_user_id = :o AND app_id = :a';
        $params = ['o' => $ownerUserId, 'a' => $appId ?? ''];
        if ($scope !== null && $scope !== '') {
            $where .= ' AND scope = :s';
            $params['s'] = $this->sanitizeScope($scope);
        }
        $stmt = $this->mysql->prepare("SELECT * FROM flow_kv WHERE {$where} ORDER BY scope ASC, k ASC");
        $stmt->execute($params);
        return array_map([$this, 'formatEntry'], $stmt->fetchAll());
    }

    /** One entry, or null. */
    public function get(string $ownerUserId, ?string $appId, string $scope, string $key): ?array
    {
        $stmt = $this->mysql->prepare("
            SELECT * FROM flow_kv WHERE owner_user_id = :o AND app_id = :a AND scope = :s AND k = :k
        ");
        $stmt->execute([
            'o' => $ownerUserId,
            'a' => $appId ?? '',
            's' => $this->sanitizeScope($scope),
            'k' => $this->sanitizeKey($key),
        ]);
        $row = $stmt->fetch();
        return $row ? $this->formatEntry($row) : null;
    }

    /**
     * Upsert one key. Enforces the value-size and keys-per-scope caps.
     * @throws \InvalidArgumentException on invalid scope/key, oversized value, or a full scope
     */
    public function put(string $ownerUserId, ?string $appId, string $scope, string $key, mixed $value): array
    {
        $scope = $this->sanitizeScope($scope);
        $key = $this->sanitizeKey($key);

        $encoded = json_encode($value);
        if ($encoded === false || strlen($encoded) > self::MAX_VALUE_BYTES) {
            throw new \InvalidArgumentException('Value exceeds the 64KB limit');
        }

        // Keys-per-scope cap: only NEW keys count against it (updates always pass). The check +
        // insert isn't one atomic statement, but the cap is a soft quota, not a security gate.
        $exists = $this->mysql->prepare("SELECT 1 FROM flow_kv WHERE owner_user_id = :o AND app_id = :a AND scope = :s AND k = :k");
        $exists->execute(['o' => $ownerUserId, 'a' => $appId ?? '', 's' => $scope, 'k' => $key]);
        if (!$exists->fetchColumn()) {
            $count = $this->mysql->prepare("SELECT COUNT(*) FROM flow_kv WHERE owner_user_id = :o AND app_id = :a AND scope = :s");
            $count->execute(['o' => $ownerUserId, 'a' => $appId ?? '', 's' => $scope]);
            if ((int) $count->fetchColumn() >= $this->maxKeysPerScope) {
                throw new \InvalidArgumentException("This scope already holds the maximum of {$this->maxKeysPerScope} keys");
            }
        }

        $stmt = $this->mysql->prepare("
            INSERT INTO flow_kv (id, owner_user_id, app_id, scope, k, v)
            VALUES (:id, :o, :a, :s, :k, :v)
            ON DUPLICATE KEY UPDATE v = VALUES(v)
        ");
        $stmt->execute([
            'id' => $this->uuidV4(),
            'o' => $ownerUserId,
            'a' => $appId ?? '',
            's' => $scope,
            'k' => $key,
            'v' => $encoded,
        ]);

        return $this->get($ownerUserId, $appId, $scope, $key) ?? throw new \RuntimeException('Flow KV write failed');
    }

    /** Delete one key. Returns whether a row was removed. */
    public function delete(string $ownerUserId, ?string $appId, string $scope, string $key): bool
    {
        $stmt = $this->mysql->prepare("
            DELETE FROM flow_kv WHERE owner_user_id = :o AND app_id = :a AND scope = :s AND k = :k
        ");
        $stmt->execute([
            'o' => $ownerUserId,
            'a' => $appId ?? '',
            's' => $this->sanitizeScope($scope),
            'k' => $this->sanitizeKey($key),
        ]);
        return $stmt->rowCount() > 0;
    }

    /** @throws \InvalidArgumentException */
    private function sanitizeScope(string $scope): string
    {
        if (!preg_match(self::SCOPE_PATTERN, $scope)) {
            throw new \InvalidArgumentException("Invalid scope (use e.g. 'app' or 'flow:<slug>', max 64 chars)");
        }
        return $scope;
    }

    /** @throws \InvalidArgumentException */
    private function sanitizeKey(string $key): string
    {
        if (!preg_match(self::KEY_PATTERN, $key)) {
            throw new \InvalidArgumentException('Invalid key (letters, digits, . _ : / -, max 190 chars)');
        }
        return $key;
    }

    private function formatEntry(array $row): array
    {
        $value = null;
        if (isset($row['v']) && $row['v'] !== null && $row['v'] !== '') {
            $decoded = json_decode((string) $row['v'], true);
            $value = json_last_error() === JSON_ERROR_NONE ? $decoded : null;
        }
        return [
            'appId' => ($row['app_id'] ?? '') === '' ? null : $row['app_id'],
            'scope' => $row['scope'],
            'k' => $row['k'],
            'v' => $value,
            'updatedAt' => $row['updated_at'],
        ];
    }

    private function uuidV4(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}

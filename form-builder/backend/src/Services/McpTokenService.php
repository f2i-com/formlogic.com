<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use PDO;

/**
 * Issues + validates ephemeral MCP session tokens. A token lets an external AI drive the API through
 * the MCP server, scoped to one user (and optionally one app), with a hard TTL AND an idle timeout, so
 * a leaked/forgotten link stops working quickly. Tokens are stored hashed (sha256), never in plaintext.
 */
class McpTokenService
{
    private const TOKEN_PREFIX = 'flm_';
    private const DEFAULT_TTL = 3600;           // 1h — short by default (paste into an AI, build, done)
    private const DEFAULT_IDLE = 900;           // 15m idle timeout
    private const MAX_TTL = 86400;              // 24h hard ceiling

    /** Builder scopes granted by default — deliberately EXCLUDES responses:* (submission data). */
    public const DEFAULT_SCOPES = ['apps:read', 'apps:write', 'forms:read', 'forms:write', 'screens:write'];
    public const ALL_SCOPES = ['apps:read', 'apps:write', 'forms:read', 'forms:write', 'screens:write', 'responses:read', 'responses:write'];

    public function __construct(private MySQLConnection $mysql) {}

    private function db(): PDO
    {
        return $this->mysql->getConnection();
    }

    /**
     * Mint a token. Returns ['token' => '<plaintext, shown once>', 'id', 'expiresAt', 'idleTimeout'].
     */
    public function create(string $userId, ?string $appId = null, int $ttl = self::DEFAULT_TTL, int $idle = self::DEFAULT_IDLE, ?array $scopes = null): array
    {
        $ttl = max(300, min($ttl, self::MAX_TTL));   // 5m … 24h
        $idle = max(300, min($idle, self::MAX_TTL));
        $scopes = array_values(array_intersect(self::ALL_SCOPES, $scopes ?? self::DEFAULT_SCOPES));
        if (empty($scopes)) {
            $scopes = self::DEFAULT_SCOPES;
        }
        $id = $this->uuid();
        $raw = self::TOKEN_PREFIX . bin2hex(random_bytes(24));
        $hash = hash('sha256', $raw);
        $expiresAt = date('Y-m-d H:i:s', time() + $ttl);

        $stmt = $this->db()->prepare("
            INSERT INTO mcp_sessions (id, user_id, app_id, token_hash, scopes, expires_at, idle_timeout_seconds, created_at)
            VALUES (:id, :user_id, :app_id, :hash, :scopes, :expires_at, :idle, :created_at)
        ");
        $stmt->execute([
            'id' => $id,
            'user_id' => $userId,
            'app_id' => $appId,
            'hash' => $hash,
            'scopes' => json_encode($scopes),
            'expires_at' => $expiresAt,
            'idle' => $idle,
            'created_at' => date('Y-m-d H:i:s'),
        ]);

        return ['token' => $raw, 'id' => $id, 'appId' => $appId, 'scopes' => $scopes, 'expiresAt' => $expiresAt, 'idleTimeout' => $idle];
    }

    /**
     * Validate a token. Returns ['id','userId','appId'] or null. Enforces revoke, hard expiry, AND idle
     * timeout, then bumps last_used_at so the idle window slides forward while in use.
     */
    public function validate(string $token, ?string $ip = null): ?array
    {
        if (!str_starts_with($token, self::TOKEN_PREFIX)) {
            return null;
        }
        $hash = hash('sha256', $token);
        $stmt = $this->db()->prepare("
            SELECT id, user_id, app_id, scopes, expires_at, idle_timeout_seconds, last_used_at, revoked_at
            FROM mcp_sessions WHERE token_hash = :hash LIMIT 1
        ");
        $stmt->execute(['hash' => $hash]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row || $row['revoked_at'] !== null) {
            return null;
        }
        $now = time();
        if (strtotime($row['expires_at']) < $now) {
            return null;
        }
        if ($row['last_used_at'] !== null && ($now - strtotime($row['last_used_at'])) > (int) $row['idle_timeout_seconds']) {
            return null; // idle-timed-out
        }
        $upd = $this->db()->prepare("UPDATE mcp_sessions SET last_used_at = :ts, last_used_ip = :ip WHERE id = :id");
        $upd->execute(['ts' => date('Y-m-d H:i:s', $now), 'ip' => $ip, 'id' => $row['id']]);

        $scopes = is_string($row['scopes'] ?? null) ? (json_decode($row['scopes'], true) ?: self::DEFAULT_SCOPES) : self::DEFAULT_SCOPES;
        return ['id' => $row['id'], 'userId' => $row['user_id'], 'appId' => $row['app_id'], 'scopes' => $scopes];
    }

    /** Active (non-revoked, non-expired) sessions for a user — for the "Connect an AI" UI. */
    public function listActive(string $userId, ?string $appId = null): array
    {
        $sql = "SELECT id, app_id, scopes, expires_at, idle_timeout_seconds, last_used_at, created_at
                FROM mcp_sessions WHERE user_id = :uid AND revoked_at IS NULL AND expires_at > NOW()";
        $params = ['uid' => $userId];
        if ($appId !== null) {
            $sql .= " AND app_id = :app";
            $params['app'] = $appId;
        }
        $sql .= " ORDER BY created_at DESC";
        $stmt = $this->db()->prepare($sql);
        $stmt->execute($params);
        return array_map(static fn ($r) => [
            'id' => $r['id'],
            'appId' => $r['app_id'],
            'scopes' => is_string($r['scopes'] ?? null) ? (json_decode($r['scopes'], true) ?: []) : [],
            'expiresAt' => $r['expires_at'],
            'idleTimeout' => (int) $r['idle_timeout_seconds'],
            'lastUsedAt' => $r['last_used_at'],
            'createdAt' => $r['created_at'],
        ], $stmt->fetchAll(PDO::FETCH_ASSOC));
    }

    /** Revoke a session the user owns. Returns true if a row was revoked. */
    public function revoke(string $id, string $userId): bool
    {
        $stmt = $this->db()->prepare("UPDATE mcp_sessions SET revoked_at = NOW() WHERE id = :id AND user_id = :uid AND revoked_at IS NULL");
        $stmt->execute(['id' => $id, 'uid' => $userId]);
        return $stmt->rowCount() > 0;
    }

    private function uuid(): string
    {
        $d = random_bytes(16);
        $d[6] = chr((ord($d[6]) & 0x0f) | 0x40);
        $d[8] = chr((ord($d[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($d), 4));
    }
}

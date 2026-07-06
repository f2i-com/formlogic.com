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
    /** OAuth-minted access tokens share the flm_ prefix (validate() accepts them unchanged). */
    public const OAUTH_TOKEN_PREFIX = 'flm_oauth_';
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
     *
     * $creator = a "creator" token: it can create NEW apps but is confined to the apps/forms it creates
     * (it never sees or touches the owner's existing apps). Implies app_id = null. Used by "Hand to an AI".
     */
    public function create(string $userId, ?string $appId = null, int $ttl = self::DEFAULT_TTL, int $idle = self::DEFAULT_IDLE, ?array $scopes = null, bool $creator = false): array
    {
        $this->purgeExpired(); // opportunistic GC of dead sessions
        $ttl = max(300, min($ttl, self::MAX_TTL));   // 5m … 24h
        $idle = max(300, min($idle, self::MAX_TTL));
        $scopes = array_values(array_intersect(self::ALL_SCOPES, $scopes ?? self::DEFAULT_SCOPES));
        if (empty($scopes)) {
            $scopes = self::DEFAULT_SCOPES;
        }
        if ($creator) {
            $appId = null; // a creator token is not pre-scoped to an existing app
        }
        $id = $this->uuid();
        $raw = self::TOKEN_PREFIX . bin2hex(random_bytes(24));
        $hash = hash('sha256', $raw);
        $expiresAt = date('Y-m-d H:i:s', time() + $ttl);

        $stmt = $this->db()->prepare("
            INSERT INTO mcp_sessions (id, user_id, app_id, token_hash, scopes, created_ids, expires_at, idle_timeout_seconds, created_at)
            VALUES (:id, :user_id, :app_id, :hash, :scopes, :created_ids, :expires_at, :idle, :created_at)
        ");
        $stmt->execute([
            'id' => $id,
            'user_id' => $userId,
            'app_id' => $appId,
            'hash' => $hash,
            'scopes' => json_encode($scopes),
            'created_ids' => $creator ? json_encode(['apps' => [], 'forms' => []]) : null,
            'expires_at' => $expiresAt,
            'idle' => $idle,
            'created_at' => date('Y-m-d H:i:s'),
        ]);

        return ['token' => $raw, 'id' => $id, 'appId' => $appId, 'scopes' => $scopes, 'creator' => $creator, 'expiresAt' => $expiresAt, 'idleTimeout' => $idle];
    }

    /**
     * Mint an OAuth access token (the /api/oauth/token endpoint). Same session row + validation
     * pipeline as manual tokens — plus AUDIENCE BINDING: the row stores the RFC 8707 resource
     * ('<origin>/api/mcp') the token was issued for, and McpController rejects it on any other host.
     * The idle timeout is pinned to the TTL so the ABSOLUTE expiry (default 3600s) is what governs;
     * OAuth clients renew via the refresh grant, not by sliding an idle window.
     */
    public function createOAuth(string $userId, ?string $appId, ?array $scopes, string $resource, int $ttl = 3600): array
    {
        $this->purgeExpired();
        $ttl = max(300, min($ttl, self::MAX_TTL));
        $scopes = array_values(array_intersect(self::ALL_SCOPES, $scopes ?? self::DEFAULT_SCOPES));
        if (empty($scopes)) {
            $scopes = self::DEFAULT_SCOPES;
        }
        $id = $this->uuid();
        $raw = self::OAUTH_TOKEN_PREFIX . bin2hex(random_bytes(24));
        $expiresAt = date('Y-m-d H:i:s', time() + $ttl);
        $stmt = $this->db()->prepare("
            INSERT INTO mcp_sessions (id, user_id, app_id, token_hash, scopes, created_ids, resource, expires_at, idle_timeout_seconds, created_at)
            VALUES (:id, :user_id, :app_id, :hash, :scopes, NULL, :resource, :expires_at, :idle, :created_at)
        ");
        $stmt->execute([
            'id' => $id,
            'user_id' => $userId,
            'app_id' => $appId,
            'hash' => hash('sha256', $raw),
            'scopes' => json_encode($scopes),
            'resource' => $resource,
            'expires_at' => $expiresAt,
            'idle' => $ttl,
            'created_at' => date('Y-m-d H:i:s'),
        ]);
        return ['token' => $raw, 'id' => $id, 'appId' => $appId, 'scopes' => $scopes, 'expiresAt' => $expiresAt, 'resource' => $resource];
    }

    /**
     * Record an app/form a creator token just created, so the token can keep managing it on later calls.
     * No-op for non-creator tokens (created_ids is null). $kind is internal ('apps' | 'forms').
     */
    public function recordCreated(string $sessionId, string $kind, string $resourceId): void
    {
        if ($kind !== 'apps' && $kind !== 'forms') {
            return;
        }
        $stmt = $this->db()->prepare(
            "UPDATE mcp_sessions
             SET created_ids = JSON_ARRAY_APPEND(COALESCE(created_ids, '{\"apps\":[],\"forms\":[]}'), :path, :id)
             WHERE id = :sid AND created_ids IS NOT NULL"
        );
        $stmt->execute(['path' => '$.' . $kind, 'id' => $resourceId, 'sid' => $sessionId]);
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
            SELECT id, user_id, app_id, scopes, created_ids, resource, expires_at, idle_timeout_seconds, last_used_at, revoked_at
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
        // created_ids present => a creator token; normalize to {apps:[],forms:[]}, else null.
        $created = null;
        if (is_string($row['created_ids'] ?? null)) {
            $decoded = json_decode($row['created_ids'], true);
            $created = ['apps' => array_values((array) ($decoded['apps'] ?? [])), 'forms' => array_values((array) ($decoded['forms'] ?? []))];
        }
        return [
            'id' => $row['id'],
            'userId' => $row['user_id'],
            'appId' => $row['app_id'],
            'scopes' => $scopes,
            'created' => $created,
            // OAuth-minted tokens carry the resource they were issued for (audience binding);
            // NULL for manual flm_ tokens.
            'resource' => isset($row['resource']) && is_string($row['resource']) ? $row['resource'] : null,
        ];
    }

    /** Active (non-revoked, non-expired) sessions for a user — for the "Connect an AI" UI. */
    public function listActive(string $userId, ?string $appId = null): array
    {
        $this->purgeExpired(); // tidy dead sessions whenever the Connect UI lists them
        $sql = "SELECT id, app_id, scopes, created_ids, expires_at, idle_timeout_seconds, last_used_at, created_at
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
            'creator' => ($r['created_ids'] ?? null) !== null,
            'scopes' => is_string($r['scopes'] ?? null) ? (json_decode($r['scopes'], true) ?: []) : [],
            'expiresAt' => $r['expires_at'],
            'idleTimeout' => (int) $r['idle_timeout_seconds'],
            'lastUsedAt' => $r['last_used_at'],
            'createdAt' => $r['created_at'],
        ], $stmt->fetchAll(PDO::FETCH_ASSOC));
    }

    /**
     * Delete dead sessions: hard-expired (past TTL), idle-timed-out, or revoked. Runs opportunistically
     * from create()/listActive() so expired "Connect an AI" links don't accumulate in the table. Global
     * (cleans every user's) — the table is tiny and rows are only ever short-lived. Fails soft.
     */
    public function purgeExpired(): int
    {
        try {
            $stmt = $this->db()->query(
                "DELETE FROM mcp_sessions
                 WHERE expires_at < NOW()
                    OR revoked_at IS NOT NULL
                    OR (last_used_at IS NOT NULL AND DATE_ADD(last_used_at, INTERVAL idle_timeout_seconds SECOND) < NOW())"
            );
            return $stmt->rowCount();
        } catch (\Throwable $e) {
            return 0;
        }
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

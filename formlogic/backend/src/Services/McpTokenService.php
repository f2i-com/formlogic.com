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
    /** listActive() names an OAuth connection that holds no live access token by its grant: this prefix + the refresh family id. */
    private const GRANT_ID_PREFIX = 'grant-';

    /** Builder scopes granted by default — deliberately EXCLUDES responses:* (submission data). */
    public const DEFAULT_SCOPES = ['apps:read', 'apps:write', 'forms:read', 'forms:write', 'screens:write'];
    public const ALL_SCOPES = [
        'apps:read', 'apps:write', 'forms:read', 'forms:write', 'screens:write',
        'responses:read', 'responses:write', 'connector:command',
        // First-party Aokie Companion OAuth client. These scopes authorize
        // only the short-lived admission exchange; they are not MCP tools.
        'aokie:state', 'aokie:monitor', 'aokie:consult', 'aokie:takeover', 'aokie:resume',
        'aokie:assistance', 'aokie:end_caller',
    ];

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
            'created_ids' => $creator ? json_encode(['apps' => [], 'forms' => [], 'blueprints' => []]) : null,
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
    public function createOAuth(
        string $userId,
        ?string $appId,
        ?array $scopes,
        string $resource,
        int $ttl = 3600,
        ?string $oauthClientId = null,
        ?string $deviceId = null,
        ?string $refreshFamilyId = null,
    ): array
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
            INSERT INTO mcp_sessions
                (id, user_id, app_id, token_hash, scopes, created_ids, resource, oauth_client_id,
                 device_id, refresh_family_id, expires_at, idle_timeout_seconds, created_at)
            VALUES
                (:id, :user_id, :app_id, :hash, :scopes, NULL, :resource, :oauth_client_id,
                 :device_id, :refresh_family_id, :expires_at, :idle, :created_at)
        ");
        $stmt->execute([
            'id' => $id,
            'user_id' => $userId,
            'app_id' => $appId,
            'hash' => hash('sha256', $raw),
            'scopes' => json_encode($scopes),
            'resource' => $resource,
            'oauth_client_id' => $oauthClientId,
            'device_id' => $deviceId,
            'refresh_family_id' => $refreshFamilyId,
            'expires_at' => $expiresAt,
            'idle' => $ttl,
            'created_at' => date('Y-m-d H:i:s'),
        ]);
        return [
            'token' => $raw,
            'id' => $id,
            'appId' => $appId,
            'scopes' => $scopes,
            'expiresAt' => $expiresAt,
            'resource' => $resource,
            'oauthClientId' => $oauthClientId,
            'deviceId' => $deviceId,
            'refreshFamilyId' => $refreshFamilyId,
        ];
    }

    /**
     * Record an app, form or diagram a creator token just created, so the token can keep managing it
     * on later calls. No-op for non-creator tokens (created_ids is null). $kind is internal
     * ('apps' | 'forms' | 'blueprints').
     */
    public function recordCreated(string $sessionId, string $kind, string $resourceId): void
    {
        if (!in_array($kind, ['apps', 'forms', 'blueprints'], true)) {
            return;
        }
        // $kind is one of the three literals above, so the path is safe to write into the statement.
        // A session minted before a kind existed has no list for it, and JSON_ARRAY_APPEND leaves
        // the document unchanged when the path is missing: add the empty list first.
        $path = '$.' . $kind;
        $stmt = $this->db()->prepare(
            "UPDATE mcp_sessions
             SET created_ids = JSON_ARRAY_APPEND(
                 IF(JSON_CONTAINS_PATH(created_ids, 'one', '{$path}'), created_ids, JSON_SET(created_ids, '{$path}', JSON_ARRAY())),
                 '{$path}', :id)
             WHERE id = :sid AND created_ids IS NOT NULL"
        );
        $stmt->execute(['id' => $resourceId, 'sid' => $sessionId]);
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
            SELECT id, user_id, app_id, scopes, created_ids, resource, oauth_client_id, device_id,
                   refresh_family_id,
                   expires_at, idle_timeout_seconds, last_used_at, revoked_at
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
        // created_ids present => a creator token; normalize to {apps:[],forms:[],blueprints:[]}, else null.
        $created = null;
        if (is_string($row['created_ids'] ?? null)) {
            $decoded = json_decode($row['created_ids'], true);
            $created = [
                'apps' => array_values((array) ($decoded['apps'] ?? [])),
                'forms' => array_values((array) ($decoded['forms'] ?? [])),
                'blueprints' => array_values((array) ($decoded['blueprints'] ?? [])),
            ];
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
            'oauthClientId' => isset($row['oauth_client_id']) && is_string($row['oauth_client_id'])
                ? $row['oauth_client_id']
                : null,
            'deviceId' => isset($row['device_id']) && is_string($row['device_id'])
                ? $row['device_id']
                : null,
            'refreshFamilyId' => isset($row['refresh_family_id']) && is_string($row['refresh_family_id'])
                ? $row['refresh_family_id']
                : null,
        ];
    }

    /**
     * Active (non-revoked, non-expired) sessions for a user — for the "Connect an AI" UI.
     *
     * An OAuth connection outlives its access tokens: an hour after its last use it has no session
     * row left, while its refresh token lets the client back in for 30 days. Such a connection is
     * listed too, as one entry whose id revoke() takes, or it could be neither seen nor ended.
     */
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
        $sessions = array_map(static fn ($r) => [
            'id' => $r['id'],
            'appId' => $r['app_id'],
            'creator' => ($r['created_ids'] ?? null) !== null,
            'scopes' => is_string($r['scopes'] ?? null) ? (json_decode($r['scopes'], true) ?: []) : [],
            'expiresAt' => $r['expires_at'],
            'idleTimeout' => (int) $r['idle_timeout_seconds'],
            'lastUsedAt' => $r['last_used_at'],
            'createdAt' => $r['created_at'],
        ], $stmt->fetchAll(PDO::FETCH_ASSOC));
        return array_merge($sessions, $this->idleOAuthGrants($userId, $appId));
    }

    /**
     * OAuth connections of the user that can still refresh but hold no live access token, in
     * listActive()'s shape. The Aokie Companion's grants are left out: they are devices, listed
     * and revoked where the devices are.
     */
    private function idleOAuthGrants(string $userId, ?string $appId): array
    {
        $sql = "SELECT rt.family_id, rt.app_id, rt.scopes, rt.expires_at, rt.created_at
                FROM mcp_oauth_refresh_tokens rt
                WHERE rt.user_id = :uid AND rt.revoked_at IS NULL AND rt.rotated_at IS NULL AND rt.expires_at > NOW()
                  AND rt.client_id <> :companion
                  AND NOT EXISTS (
                      SELECT 1 FROM mcp_sessions s
                      WHERE s.refresh_family_id = rt.family_id AND s.revoked_at IS NULL AND s.expires_at > NOW()
                  )";
        $params = ['uid' => $userId, 'companion' => McpOAuthService::AOKIE_COMPANION_CLIENT_ID];
        if ($appId !== null) {
            $sql .= " AND rt.app_id = :app";
            $params['app'] = $appId;
        }
        $sql .= " ORDER BY rt.created_at DESC";
        try {
            $stmt = $this->db()->prepare($sql);
            $stmt->execute($params);
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        } catch (\PDOException) {
            return []; // a database without the OAuth tables has no such connections
        }
        $grants = [];
        foreach ($rows as $r) {
            // One entry per grant: a confidential client keeps one refresh token, a public one the
            // newest of its rotation.
            $grants[(string) $r['family_id']] ??= [
                'id' => self::GRANT_ID_PREFIX . $r['family_id'],
                'appId' => $r['app_id'],
                'creator' => false,
                'scopes' => is_string($r['scopes'] ?? null) ? (json_decode($r['scopes'], true) ?: []) : [],
                'expiresAt' => $r['expires_at'],
                'idleTimeout' => McpOAuthService::ACCESS_TOKEN_TTL,
                'lastUsedAt' => null,
                'createdAt' => $r['created_at'],
                'idle' => true,
            ];
        }
        return array_values($grants);
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

    /**
     * Revoke a session the user owns. Returns true if a row was revoked.
     *
     * An OAuth-minted session is one access token of a grant. The grant's refresh tokens and its
     * other access tokens are revoked with it: otherwise the client is back on its next refresh,
     * for as long as the refresh token lives, and "revoke" would end an hour-long token only.
     */
    public function revoke(string $id, string $userId): bool
    {
        if (str_starts_with($id, self::GRANT_ID_PREFIX)) {
            // An idle OAuth connection, named by its grant (listActive()).
            return $this->revokeGrant(substr($id, strlen(self::GRANT_ID_PREFIX)), $userId);
        }
        $family = $this->db()->prepare("SELECT refresh_family_id FROM mcp_sessions WHERE id = :id AND user_id = :uid");
        $family->execute(['id' => $id, 'uid' => $userId]);
        $familyId = $family->fetchColumn();

        $stmt = $this->db()->prepare("UPDATE mcp_sessions SET revoked_at = NOW() WHERE id = :id AND user_id = :uid AND revoked_at IS NULL");
        $stmt->execute(['id' => $id, 'uid' => $userId]);
        $revoked = $stmt->rowCount() > 0;

        if ($revoked && is_string($familyId) && $familyId !== '') {
            $this->revokeGrant($familyId, $userId);
        }
        return $revoked;
    }

    /** Revoke every refresh token and access token of one of the user's OAuth grants. True if a refresh token was revoked. */
    private function revokeGrant(string $familyId, string $userId): bool
    {
        if ($familyId === '') {
            return false;
        }
        $refresh = $this->db()->prepare("UPDATE mcp_oauth_refresh_tokens SET revoked_at = NOW() WHERE family_id = :f AND user_id = :uid AND revoked_at IS NULL");
        $refresh->execute(['f' => $familyId, 'uid' => $userId]);
        $this->db()->prepare("UPDATE mcp_sessions SET revoked_at = NOW() WHERE refresh_family_id = :f AND user_id = :uid AND revoked_at IS NULL")
            ->execute(['f' => $familyId, 'uid' => $userId]);
        return $refresh->rowCount() > 0;
    }

    private function uuid(): string
    {
        $d = random_bytes(16);
        $d[6] = chr((ord($d[6]) & 0x0f) | 0x40);
        $d[8] = chr((ord($d[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($d), 4));
    }
}

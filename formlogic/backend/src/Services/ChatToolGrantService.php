<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use PDO;

/**
 * Chat tool grants (plan Phase 6 §5.4/§6): short-lived tokens the browser mints once per
 * chat turn, bound to the minting USER + ONE desktop instance + the `ai:chat-tools` scope.
 * The grant travels INSIDE the sealed tunnel envelope; the desktop presents it to
 * POST /api/ai/chat-tools/execute, which verifies it here and then runs the tool AS THE
 * GRANTING USER.
 *
 * Storage mirrors ApiKeyService's hashed-token pattern: only the sha256 of the token is
 * persisted, so a database read can never replay a grant. Expired rows are reaped
 * opportunistically during verification (no cron): rows expired for over an hour are
 * deleted, while a freshly-expired grant is kept just long enough to answer with the
 * honest typed `grant_expired` (instead of collapsing into `grant_invalid`).
 */
class ChatToolGrantService
{
    /** Grant lifetime (plan §5.4: 10 minutes; the browser mints one per turn). */
    public const TTL_SECONDS = 600;
    /** The single scope a chat-tool grant carries (plan §6). */
    public const SCOPE = 'ai:chat-tools';

    private const TOKEN_PREFIX = 'ctg_';
    /** Freshly-expired grants stay readable this long so verification can say grant_expired. */
    private const EXPIRED_RETENTION_SECONDS = 3600;

    /** Same shape DesktopCommandService enforces for desktop instance ids. */
    public const INSTANCE_ID_PATTERN = '/^[A-Za-z0-9._-]+$/';
    public const MAX_INSTANCE_ID = 128;

    private PDO $mysql;

    public function __construct(MySQLConnection $mysql)
    {
        $this->mysql = $mysql->getConnection();
    }

    /**
     * Mint a grant for $userId bound to $instanceId. The caller resolves/validates the
     * instance first (controller: explicit id → ownership check; absent → the Phase-1
     * relay target resolution).
     *
     * @return array{grantToken: string, expiresAt: string} expiresAt is ISO-8601 UTC.
     */
    public function mint(string $userId, string $instanceId): array
    {
        $token = self::TOKEN_PREFIX . bin2hex(random_bytes(24));
        $expiresTs = time() + self::TTL_SECONDS;
        $stmt = $this->mysql->prepare("
            INSERT INTO chat_tool_grants (id, token_hash, user_id, desktop_instance_id, scope, expires_at)
            VALUES (:id, :hash, :user, :instance, :scope, :exp)
        ");
        $stmt->execute([
            'id' => $this->uuid(),
            'hash' => hash('sha256', $token),
            'user' => $userId,
            'instance' => $instanceId,
            'scope' => self::SCOPE,
            'exp' => date('Y-m-d H:i:s', $expiresTs),
        ]);
        return [
            'grantToken' => $token,
            'expiresAt' => gmdate('Y-m-d\TH:i:s\Z', $expiresTs),
        ];
    }

    /**
     * Verify a presented grant token. Sweeps long-expired rows first (opportunistic GC).
     * Expiry is decided in SQL (expires_at > NOW()) — never by comparing a MySQL timestamp
     * against PHP's clock (the two timezones need not agree).
     *
     * @return array{userId: string, desktopInstanceId: string, scope: string}
     * @throws \RuntimeException 'grant_invalid' (malformed/unknown token) | 'grant_expired'
     */
    public function verify(string $token): array
    {
        $this->cleanupExpired();
        if (!str_starts_with($token, self::TOKEN_PREFIX) || strlen($token) > 128) {
            throw new \RuntimeException('grant_invalid');
        }
        $stmt = $this->mysql->prepare("
            SELECT user_id, desktop_instance_id, scope, (expires_at > NOW()) AS still_valid
            FROM chat_tool_grants WHERE token_hash = :hash LIMIT 1
        ");
        $stmt->execute(['hash' => hash('sha256', $token)]);
        $row = $stmt->fetch();
        if (!$row || ($row['scope'] ?? '') !== self::SCOPE) {
            throw new \RuntimeException('grant_invalid');
        }
        if ((int) ($row['still_valid'] ?? 0) !== 1) {
            throw new \RuntimeException('grant_expired');
        }
        return [
            'userId' => (string) $row['user_id'],
            'desktopInstanceId' => (string) $row['desktop_instance_id'],
            'scope' => (string) $row['scope'],
        ];
    }

    /**
     * Instance-binding check (plan §5.4): whether $instanceId is one of $ownerUserId's
     * registered desktop connections — the same ownership model the Phase-1 v1 desktop-ai
     * routes enforce (a connection row under the flk_ key's owner). Used both at mint
     * (an explicit instanceId must belong to the minting user's workspace) and at execute
     * (the grant's bound instance must belong to the presenting key's owner —
     * `grant_instance_mismatch` otherwise).
     */
    public function instanceBelongsTo(string $ownerUserId, string $instanceId): bool
    {
        if ($instanceId === '') {
            return false;
        }
        $stmt = $this->mysql->prepare("
            SELECT id FROM desktop_connections WHERE owner_user_id = :o AND desktop_instance_id = :i LIMIT 1
        ");
        $stmt->execute(['o' => $ownerUserId, 'i' => $instanceId]);
        return (bool) $stmt->fetchColumn();
    }

    /** Opportunistic reaping of long-expired grants (rides verification; fails soft). */
    private function cleanupExpired(): void
    {
        $retention = self::EXPIRED_RETENTION_SECONDS; // int class constant, safe to interpolate
        try {
            $this->mysql->exec("DELETE FROM chat_tool_grants WHERE expires_at < (NOW() - INTERVAL {$retention} SECOND)");
        } catch (\Throwable) {
            // GC is best-effort
        }
    }

    private function uuid(): string
    {
        $d = random_bytes(16);
        $d[6] = chr((ord($d[6]) & 0x0f) | 0x40);
        $d[8] = chr((ord($d[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($d), 4));
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use PDO;

/**
 * Remote command relay (docs/API.md §connector:relay): a web member enqueues a connector command
 * (e.g. an Aokie call action) for a paired FormLogic Desktop runtime running on another machine;
 * the desktop long-polls for pending commands, CLAIMS one (pending→claimed exactly-once) and
 * COMPLETES it (claimed→done|failed). Web reads the result back.
 *
 * Reserve-first on the UNIQUE idempotency_key (same gate as flow runs): a duplicate enqueue returns
 * the existing row with created=false. Pending commands expire 60s after creation (opportunistically
 * swept to 'expired' on read); a stale desktop can never claim an ancient command.
 */
class DesktopCommandService
{
    /** Pending commands are short-lived: a call the receptionist must pick up now, not in an hour. */
    public const COMMAND_TTL_SECONDS = 60;
    public const MAX_PAYLOAD_BYTES = 16384;    // 16 KiB request payload
    public const MAX_RESULT_BYTES = 65536;     // 64 KiB result / error blob
    public const MAX_CONNECTOR_ID = 64;
    public const MAX_COMMAND = 96;
    public const MAX_IDEMPOTENCY_KEY = 255;

    /** Terminal statuses a desktop may complete a claimed command with. */
    public const COMPLETE_STATUSES = ['done', 'failed'];

    /** Long-poll ceiling: a single pending request blocks at most 25s before returning empty. */
    public const MAX_WAIT_MS = 25000;
    private const POLL_INTERVAL_MS = 500;

    private PDO $mysql;

    public function __construct(MySQLConnection $mysql)
    {
        $this->mysql = $mysql->getConnection();
    }

    /**
     * Enqueue a connector command for the owner's desktop runtime. Reserve-first on idempotency_key:
     * a duplicate returns the existing row (created=false). status 'pending', expires 60s out.
     *
     * @return array{command: array, created: bool}
     * @throws \InvalidArgumentException on invalid payload / foreign idempotency-key reuse
     */
    public function enqueue(string $ownerUserId, string $requestedByUserId, ?string $appId, array $data): array
    {
        $connectorId = $data['connectorId'] ?? null;
        if (!is_string($connectorId) || $connectorId === '' || strlen($connectorId) > self::MAX_CONNECTOR_ID) {
            throw new \InvalidArgumentException('connectorId is required (max ' . self::MAX_CONNECTOR_ID . ' chars)');
        }
        $command = $data['command'] ?? null;
        if (!is_string($command) || $command === '' || strlen($command) > self::MAX_COMMAND) {
            throw new \InvalidArgumentException('command is required (max ' . self::MAX_COMMAND . ' chars)');
        }

        $payloadJson = null;
        if (isset($data['payload']) && $data['payload'] !== null) {
            if (!is_array($data['payload'])) {
                throw new \InvalidArgumentException('payload must be an object');
            }
            $json = json_encode($data['payload']);
            if ($json === false || strlen($json) > self::MAX_PAYLOAD_BYTES) {
                throw new \InvalidArgumentException('payload exceeds the ' . self::MAX_PAYLOAD_BYTES . '-byte limit');
            }
            $payloadJson = $json;
        }

        $idempotencyKey = $data['idempotencyKey'] ?? null;
        if ($idempotencyKey === null || $idempotencyKey === '') {
            // No key supplied → a fresh random one (no dedupe; every enqueue is distinct).
            $idempotencyKey = 'cmd-' . bin2hex(random_bytes(16));
        }
        if (!is_string($idempotencyKey) || strlen($idempotencyKey) > self::MAX_IDEMPOTENCY_KEY) {
            throw new \InvalidArgumentException('idempotencyKey must be a string (max ' . self::MAX_IDEMPOTENCY_KEY . ' chars)');
        }

        $id = $this->uuid();
        try {
            $stmt = $this->mysql->prepare("
                INSERT INTO desktop_commands
                    (id, owner_user_id, app_id, connector_id, command, payload_json, idempotency_key,
                     status, requested_by_user_id, expires_at)
                VALUES
                    (:id, :owner, :app, :connector, :command, :payload, :key, 'pending', :req, :exp)
            ");
            $stmt->execute([
                'id' => $id,
                'owner' => $ownerUserId,
                'app' => $appId,
                'connector' => $connectorId,
                'command' => $command,
                'payload' => $payloadJson,
                'key' => $idempotencyKey,
                'req' => $requestedByUserId,
                'exp' => date('Y-m-d H:i:s', time() + self::COMMAND_TTL_SECONDS),
            ]);
        } catch (\PDOException $e) {
            if (!$this->isDuplicateKey($e)) {
                throw $e;
            }
            // Reserved already: return the existing row — but only within the same owner (never
            // leak a foreign command id under a reused key).
            $find = $this->mysql->prepare("SELECT * FROM desktop_commands WHERE idempotency_key = :k LIMIT 1");
            $find->execute(['k' => $idempotencyKey]);
            $row = $find->fetch();
            if (!$row || ($row['owner_user_id'] ?? null) !== $ownerUserId) {
                throw new \InvalidArgumentException('This idempotency key was already used');
            }
            return ['command' => $this->format($row), 'created' => false];
        }

        return ['command' => $this->get($id, $ownerUserId) ?? throw new \RuntimeException('Command enqueue failed'), 'created' => true];
    }

    /** One command by id, scoped to the owner. */
    public function get(string $id, string $ownerUserId): ?array
    {
        $stmt = $this->mysql->prepare("SELECT * FROM desktop_commands WHERE id = :id AND owner_user_id = :o");
        $stmt->execute(['id' => $id, 'o' => $ownerUserId]);
        $row = $stmt->fetch();
        return $row ? $this->format($row) : null;
    }

    /**
     * Seconds since the owner's desktop runtime was last seen, or null if never/none. A linked
     * FormLogic Desktop long-polls the connector:relay surface continuously (≤25s), so a fresh
     * last_used_at on an active connector:relay key is a reliable "the desktop is online" signal —
     * used to fast-fail commands when no desktop is polling instead of waiting the full timeout.
     */
    public function ownerDesktopLastSeenSeconds(string $ownerUserId): ?int
    {
        $stmt = $this->mysql->prepare(
            "SELECT TIMESTAMPDIFF(SECOND, MAX(last_used_at), NOW()) AS age
             FROM api_keys
             WHERE user_id = :o AND is_active = 1 AND last_used_at IS NOT NULL
               AND scopes LIKE '%connector:relay%'"
        );
        $stmt->execute(['o' => $ownerUserId]);
        $age = $stmt->fetchColumn();
        return $age === null || $age === false ? null : (int) $age;
    }

    /**
     * Pending, non-expired commands for the owner's runtime, oldest first. Sweeps stale pending
     * rows to 'expired' first. $sinceId, when given, returns only commands created strictly after
     * that command's created_at (a simple cursor the long-poll advances).
     * @return array[]
     */
    public function listPending(string $ownerUserId, ?string $sinceId = null, int $limit = 50): array
    {
        $this->expireStale($ownerUserId);
        $limit = max(1, min(200, $limit));

        $where = "owner_user_id = :o AND status = 'pending' AND expires_at > NOW()";
        $params = ['o' => $ownerUserId];
        if ($sinceId !== null && $sinceId !== '') {
            $where .= " AND created_at > (SELECT created_at FROM desktop_commands WHERE id = :since AND owner_user_id = :o2)";
            $params['since'] = $sinceId;
            $params['o2'] = $ownerUserId;
        }
        $stmt = $this->mysql->prepare("SELECT * FROM desktop_commands WHERE {$where} ORDER BY created_at ASC, id ASC LIMIT {$limit}");
        $stmt->execute($params);
        return array_map([$this, 'format'], $stmt->fetchAll());
    }

    /**
     * Long-poll: return pending commands as soon as any exist, or after up to $waitMs (capped at
     * MAX_WAIT_MS). Polls every POLL_INTERVAL_MS. $waitMs=0 returns immediately (the default the
     * tests exercise). Sleeping happens between DB polls, so a command enqueued mid-wait is picked
     * up within one interval.
     * @return array[]
     */
    public function pollPending(string $ownerUserId, ?string $sinceId, int $waitMs, int $limit = 50): array
    {
        $waitMs = max(0, min($waitMs, self::MAX_WAIT_MS));
        $deadline = microtime(true) + ($waitMs / 1000);
        do {
            $pending = $this->listPending($ownerUserId, $sinceId, $limit);
            if ($pending !== [] || $waitMs === 0) {
                return $pending;
            }
            if (microtime(true) >= $deadline) {
                return $pending;
            }
            usleep(self::POLL_INTERVAL_MS * 1000);
        } while (microtime(true) < $deadline);
        return $this->listPending($ownerUserId, $sinceId, $limit);
    }

    /**
     * Claim a pending command (pending→claimed exactly-once via the atomic UPDATE): returns the
     * claimed command; null when it doesn't exist; throws \RuntimeException('already_claimed') when
     * it exists but isn't pending (→ 409).
     * @throws \InvalidArgumentException on invalid payload
     */
    public function claim(string $id, string $ownerUserId, array $data): ?array
    {
        $instanceId = null;
        if (isset($data['instanceId']) && $data['instanceId'] !== null && $data['instanceId'] !== '') {
            if (!is_string($data['instanceId']) || strlen($data['instanceId']) > 120) {
                throw new \InvalidArgumentException('instanceId must be a string ≤ 120 chars');
            }
            $instanceId = $data['instanceId'];
        }

        // Only a still-pending, non-expired command can be claimed.
        $stmt = $this->mysql->prepare("
            UPDATE desktop_commands
            SET status = 'claimed', claimed_by = :cb, claimed_at = NOW()
            WHERE id = :id AND owner_user_id = :o AND status = 'pending' AND expires_at > NOW()
        ");
        $stmt->execute(['cb' => $instanceId, 'id' => $id, 'o' => $ownerUserId]);

        if ($stmt->rowCount() === 0) {
            $existing = $this->get($id, $ownerUserId);
            if ($existing === null) {
                return null;
            }
            throw new \RuntimeException('already_claimed');
        }
        return $this->get($id, $ownerUserId);
    }

    /**
     * Complete a claimed command (claimed→done|failed) with an optional result/error blob. Returns
     * the updated command; null when not found; throws \RuntimeException('not_claimed') when it is
     * not in the claimed state (→ 409).
     * @throws \InvalidArgumentException on invalid payload
     */
    public function complete(string $id, string $ownerUserId, array $data): ?array
    {
        $status = $data['status'] ?? null;
        if (!is_string($status) || !in_array($status, self::COMPLETE_STATUSES, true)) {
            throw new \InvalidArgumentException('status must be one of: ' . implode(', ', self::COMPLETE_STATUSES));
        }

        $resultJson = null;
        if (isset($data['result']) && $data['result'] !== null) {
            $json = json_encode($data['result']);
            if ($json === false || strlen($json) > self::MAX_RESULT_BYTES) {
                throw new \InvalidArgumentException('result exceeds the ' . self::MAX_RESULT_BYTES . '-byte limit');
            }
            $resultJson = $json;
        }
        $errorJson = null;
        if (isset($data['error']) && $data['error'] !== null) {
            $json = json_encode($data['error']);
            if ($json === false || strlen($json) > self::MAX_RESULT_BYTES) {
                throw new \InvalidArgumentException('error exceeds the ' . self::MAX_RESULT_BYTES . '-byte limit');
            }
            $errorJson = $json;
        }

        $stmt = $this->mysql->prepare("
            UPDATE desktop_commands
            SET status = :s, result_json = :result, error_json = :error, finished_at = NOW()
            WHERE id = :id AND owner_user_id = :o AND status = 'claimed'
        ");
        $stmt->execute(['s' => $status, 'result' => $resultJson, 'error' => $errorJson, 'id' => $id, 'o' => $ownerUserId]);

        if ($stmt->rowCount() === 0) {
            $existing = $this->get($id, $ownerUserId);
            if ($existing === null) {
                return null;
            }
            throw new \RuntimeException('not_claimed');
        }
        return $this->get($id, $ownerUserId);
    }

    /**
     * Sweep pending commands past their expiry to 'expired' (opportunistic GC, owner-scoped). The
     * existing cleanup cron should also call this globally — see docs/API.md §connector:relay.
     * Fails soft.
     */
    public function expireStale(?string $ownerUserId = null): int
    {
        try {
            if ($ownerUserId !== null) {
                $stmt = $this->mysql->prepare("UPDATE desktop_commands SET status = 'expired' WHERE owner_user_id = :o AND status = 'pending' AND expires_at <= NOW()");
                $stmt->execute(['o' => $ownerUserId]);
                return $stmt->rowCount();
            }
            $stmt = $this->mysql->query("UPDATE desktop_commands SET status = 'expired' WHERE status = 'pending' AND expires_at <= NOW()");
            return $stmt->rowCount();
        } catch (\Throwable $e) {
            return 0;
        }
    }

    // ── Internals ──

    private function isDuplicateKey(\PDOException $e): bool
    {
        return $e->getCode() === '23000' || (isset($e->errorInfo[1]) && (int) $e->errorInfo[1] === 1062);
    }

    private function format(array $row): array
    {
        return [
            'commandId' => $row['id'],
            'ownerUserId' => $row['owner_user_id'],
            'appId' => $row['app_id'],
            'connectorId' => $row['connector_id'],
            'command' => $row['command'],
            'payload' => $this->decodeJson($row['payload_json']),
            'idempotencyKey' => $row['idempotency_key'],
            'status' => $row['status'],
            'result' => $this->decodeJson($row['result_json']),
            'error' => $this->decodeJson($row['error_json']),
            'requestedByUserId' => $row['requested_by_user_id'],
            'claimedBy' => $row['claimed_by'] ?? null,
            'createdAt' => $row['created_at'],
            'claimedAt' => $row['claimed_at'] ?? null,
            'finishedAt' => $row['finished_at'] ?? null,
            'expiresAt' => $row['expires_at'],
        ];
    }

    private function decodeJson(?string $json)
    {
        if ($json === null || $json === '') {
            return null;
        }
        $decoded = json_decode($json, true);
        return $decoded === null && json_last_error() !== JSON_ERROR_NONE ? null : $decoded;
    }

    private function uuid(): string
    {
        $d = random_bytes(16);
        $d[6] = chr((ord($d[6]) & 0x0f) | 0x40);
        $d[8] = chr((ord($d[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($d), 4));
    }
}

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
 * the existing row with created=false. An unclaimed 'pending' row expires 60s after creation; a
 * 'claimed' row a desktop crashed/lost connectivity on before completing is reclaimed on its own,
 * longer timer anchored to claimed_at (see expireStale()) — a stale desktop can never claim an
 * ancient command, and a crashed claim can't hold a row hostage forever.
 */
class DesktopCommandService
{
    /** Pending commands are short-lived: a call the receptionist must pick up now, not in an hour. */
    public const COMMAND_TTL_SECONDS = 60;
    /** Call-control commands go stale with the CALL (audit INT-005/C-14): an answer/reject/hangup
     *  no desktop picked up within seconds must expire, never fire against a later call state. */
    public const CALL_COMMAND_TTL_SECONDS = 15;
    /** expireStale()'s 'claimed' staleness threshold — see that method's docblock for the reasoning. */
    public const CLAIMED_STALE_SECONDS = 300;
    public const MAX_PAYLOAD_BYTES = 16384;    // 16 KiB request payload
    public const MAX_RESULT_BYTES = 65536;     // 64 KiB result / error blob
    public const MAX_CONNECTOR_ID = 64;
    public const MAX_COMMAND = 96;
    public const MAX_IDEMPOTENCY_KEY = 255;

    /**
     * Aokie's authenticated realtime/bootstrap channel owns these commands.
     * They must never cross the public member/MCP desktop-command relay, even
     * when a caller holds an exact, wildcard, or bare connector grant.
     */
    private const PRIVATE_AOKIE_RELAY_COMMANDS = [
        'call.remoteStatus',
        'call.assistance.respond',
        'call.takeOver',
        'call.resumeBot',
        'call.endCaller',
        'call.declineWaiting',
    ];

    public const PRIVATE_AOKIE_RELAY_MESSAGE =
        'This Aokie command is private to the authenticated realtime/bootstrap channel and cannot use the public connector relay';

    /** Terminal statuses a desktop may complete a claimed command with. */
    public const COMPLETE_STATUSES = ['done', 'failed'];

    /** Long-poll ceiling: a single pending request blocks at most 25s before returning empty. */
    public const MAX_WAIT_MS = 25000;
    private const POLL_INTERVAL_MS = 500;

    /** ROUTE-001: a desktop connection heartbeated within this window counts as online —
     *  the same 90s the MCP desktop_status check uses (a linked desktop long-polls ≤25s). */
    public const DESKTOP_FRESH_SECONDS = 90;
    /** Same shape FlowService::upsertDesktopConnection() enforces for desktop instance ids. */
    private const INSTANCE_ID_PATTERN = '/^[A-Za-z0-9._-]+$/';
    private const MAX_INSTANCE_ID = 128;

    private PDO $mysql;

    public function __construct(MySQLConnection $mysql)
    {
        $this->mysql = $mysql->getConnection();
    }

    public static function isPrivateAokieRelayCommand(string $connectorId, string $command): bool
    {
        if (strtolower(trim($connectorId)) !== 'aokie') {
            return false;
        }

        $command = trim($command);
        return str_starts_with($command, 'remote.')
            || in_array($command, self::PRIVATE_AOKIE_RELAY_COMMANDS, true);
    }

    /** @throws \InvalidArgumentException when a private Aokie command reaches a public relay surface. */
    public static function assertPublicRelayCommand(string $connectorId, string $command): void
    {
        if (self::isPrivateAokieRelayCommand($connectorId, $command)) {
            throw new \InvalidArgumentException(self::PRIVATE_AOKIE_RELAY_MESSAGE);
        }
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
        // Defense in depth for direct callers such as MCP: reject before payload
        // processing, idempotency reservation, targeting, or persistence.
        self::assertPublicRelayCommand($connectorId, $command);

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

        // ROUTE-001: an optional TARGET desktop instance. Set by the CONTROLLERS from
        // resolveTargetInstance() (assignment / implicit-single) — ingress surfaces must
        // never pass a client-supplied value through unvalidated, since the target decides
        // which machine may act on the command.
        $targetInstanceId = null;
        if (isset($data['targetInstanceId']) && $data['targetInstanceId'] !== null && $data['targetInstanceId'] !== '') {
            $t = $data['targetInstanceId'];
            if (!is_string($t) || strlen($t) > self::MAX_INSTANCE_ID || !preg_match(self::INSTANCE_ID_PATTERN, $t)) {
                throw new \InvalidArgumentException('targetInstanceId must match the desktop instance id shape');
            }
            $targetInstanceId = $t;
        }

        $id = $this->uuid();
        try {
            $stmt = $this->mysql->prepare("
                INSERT INTO desktop_commands
                    (id, owner_user_id, app_id, connector_id, command, payload_json, idempotency_key,
                     status, requested_by_user_id, target_instance_id, expires_at)
                VALUES
                    (:id, :owner, :app, :connector, :command, :payload, :key, 'pending', :req, :target, :exp)
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
                'target' => $targetInstanceId,
                'exp' => date('Y-m-d H:i:s', time() + $this->ttlFor($command)),
            ]);
        } catch (\PDOException $e) {
            if (!$this->isDuplicateKey($e)) {
                throw $e;
            }
            // Reserved already: return the existing row — but only within the same owner (never
            // leak a foreign command id under a reused key). Same owner scope as the unique
            // index (audit FL-08).
            $find = $this->mysql->prepare("SELECT * FROM desktop_commands WHERE owner_user_id = :o AND idempotency_key = :k LIMIT 1");
            $find->execute(['o' => $ownerUserId, 'k' => $idempotencyKey]);
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

    /** True when the owner has at least one linked FormLogic Desktop (any freshness). */
    public function hasLinkedDesktop(string $ownerUserId): bool
    {
        $stmt = $this->mysql->prepare("SELECT 1 FROM desktop_connections WHERE owner_user_id = :o LIMIT 1");
        $stmt->execute(['o' => $ownerUserId]);
        return $stmt->fetchColumn() !== false;
    }

    /**
     * Pending, non-expired commands for the owner's runtime, oldest first. Sweeps stale pending
     * rows to 'expired' first. $sinceId, when given, returns only commands created strictly after
     * that command's created_at (a simple cursor the long-poll advances).
     *
     * ROUTE-001: $instanceId is the POLLING desktop's identity. A targeted command is visible
     * ONLY to its target; untargeted rows stay visible to every poller (legacy fan-out). A
     * poller that doesn't identify itself sees only untargeted rows — a non-target IGNORES
     * (never even sees) another machine's commands rather than racing to claim-and-fail them.
     * @return array[]
     */
    public function listPending(string $ownerUserId, ?string $sinceId = null, int $limit = 50, ?string $instanceId = null): array
    {
        $this->expireStale($ownerUserId);
        $limit = max(1, min(200, $limit));

        $where = "owner_user_id = :o AND status = 'pending' AND expires_at > NOW()";
        $params = ['o' => $ownerUserId];
        if ($instanceId !== null && $instanceId !== '') {
            $where .= " AND (target_instance_id IS NULL OR target_instance_id = :inst)";
            $params['inst'] = $instanceId;
        } else {
            $where .= " AND target_instance_id IS NULL";
        }
        if ($sinceId !== null && $sinceId !== '') {
            // Composite (created_at, id) cursor (audit FL-06): created_at is second-precision,
            // so "strictly after the cursor's timestamp" permanently skipped same-second rows,
            // and an unknown/deleted cursor made the old scalar subquery NULL (empty stream
            // forever). Unknown cursor → reset (cursor-less): only still-pending rows are ever
            // returned, so re-delivery is harmless.
            $cur = $this->mysql->prepare('SELECT created_at FROM desktop_commands WHERE id = :since AND owner_user_id = :o2');
            $cur->execute(['since' => $sinceId, 'o2' => $ownerUserId]);
            $cursorCreatedAt = $cur->fetchColumn();
            if ($cursorCreatedAt !== false && $cursorCreatedAt !== null) {
                $where .= " AND (created_at > :cts OR (created_at = :cts2 AND id > :cid))";
                $params['cts'] = $cursorCreatedAt;
                $params['cts2'] = $cursorCreatedAt;
                $params['cid'] = $sinceId;
            }
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
    public function pollPending(string $ownerUserId, ?string $sinceId, int $waitMs, int $limit = 50, ?string $instanceId = null): array
    {
        $waitMs = max(0, min($waitMs, self::MAX_WAIT_MS));
        $deadline = microtime(true) + ($waitMs / 1000);
        do {
            $pending = $this->listPending($ownerUserId, $sinceId, $limit, $instanceId);
            if ($pending !== [] || $waitMs === 0) {
                return $pending;
            }
            if (microtime(true) >= $deadline) {
                return $pending;
            }
            usleep(self::POLL_INTERVAL_MS * 1000);
        } while (microtime(true) < $deadline);
        return $this->listPending($ownerUserId, $sinceId, $limit, $instanceId);
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

        // Only a still-pending, non-expired command can be claimed — and only by its
        // TARGET when it has one (ROUTE-001). A claimer that doesn't identify itself
        // can claim only untargeted rows; a mismatched instance can't claim at all,
        // even if it somehow learned the command id (listPending already hides it).
        $targetSql = $instanceId !== null
            ? ' AND (target_instance_id IS NULL OR target_instance_id = :ti)'
            : ' AND target_instance_id IS NULL';
        $params = ['cb' => $instanceId, 'id' => $id, 'o' => $ownerUserId];
        if ($instanceId !== null) {
            $params['ti'] = $instanceId;
        }
        $stmt = $this->mysql->prepare("
            UPDATE desktop_commands
            SET status = 'claimed', claimed_by = :cb, claimed_at = NOW()
            WHERE id = :id AND owner_user_id = :o AND status = 'pending' AND expires_at > NOW(){$targetSql}
        ");
        $stmt->execute($params);

        if ($stmt->rowCount() === 0) {
            $existing = $this->get($id, $ownerUserId);
            if ($existing === null) {
                return null;
            }
            // Distinguish "someone else beat you" from "this was never yours": a
            // still-pending row we refused to claim can only mean a target mismatch.
            if (
                ($existing['status'] ?? '') === 'pending'
                && ($existing['targetInstanceId'] ?? null) !== null
                && $existing['targetInstanceId'] !== $instanceId
            ) {
                throw new \RuntimeException('targeted_elsewhere');
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

        // Claimant binding (audit INT-005/C-14): when the completer identifies itself,
        // it must be the SAME instance that claimed the command — a second desktop
        // under the owner can never complete (or overwrite) another's claim.
        $instanceId = null;
        if (isset($data['instanceId']) && $data['instanceId'] !== null && $data['instanceId'] !== '') {
            if (!is_string($data['instanceId']) || strlen($data['instanceId']) > 120) {
                throw new \InvalidArgumentException('instanceId must be a string ≤ 120 chars');
            }
            $instanceId = $data['instanceId'];
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

        // Claimant binding is ALWAYS enforced (audit FL-01): a command claimed WITH an
        // identity may only be completed by that identity — omitting instanceId no longer
        // bypasses the check. Rows claimed without one (legacy) stay completable by anyone
        // holding the owner's key until the one-time key binding upgrades them.
        $params = ['s' => $status, 'result' => $resultJson, 'error' => $errorJson, 'id' => $id, 'o' => $ownerUserId, 'cb1' => $instanceId, 'cb2' => $instanceId];
        $stmt = $this->mysql->prepare("
            UPDATE desktop_commands
            SET status = :s, result_json = :result, error_json = :error, finished_at = NOW()
            WHERE id = :id AND owner_user_id = :o AND status = 'claimed'
              AND (claimed_by IS NULL OR (:cb1 IS NOT NULL AND claimed_by = :cb2))
        ");
        $stmt->execute($params);

        if ($stmt->rowCount() === 0) {
            $existing = $this->get($id, $ownerUserId);
            if ($existing === null) {
                return null;
            }
            if (
                ($existing['status'] ?? '') === 'claimed'
                && ($existing['claimedBy'] ?? null) !== null
                && $existing['claimedBy'] !== $instanceId
            ) {
                throw new \RuntimeException('claimed_elsewhere');
            }
            throw new \RuntimeException('not_claimed');
        }
        return $this->get($id, $ownerUserId);
    }

    /**
     * Server-derived desktop identity (audit FL-01). The desktop_connections row BOUND to
     * the authenticated API key is the authority for "which install is calling":
     *   - key bound to a real instance → that instance; a DIFFERENT claimed id is refused
     *     (a sibling key under the same account can never impersonate another install);
     *   - any key claiming an instance whose row is bound to ANOTHER key → refused;
     *   - unbound key + unbound/unknown claim → the claim passes through (legacy
     *     hand-entered keys; the next api-key heartbeat binds the row once).
     * 'oauth-…' placeholder rows (minted at link time, absorbed by the first heartbeat)
     * are synthetic and never authoritative for derivation.
     *
     * @throws \RuntimeException 'instance_mismatch' on an impersonation attempt
     */
    public function resolveDesktopIdentity(string $ownerUserId, ?string $apiKeyId, ?string $claimedInstanceId): ?string
    {
        return self::resolveDesktopIdentityWithPdo($this->mysql, $ownerUserId, $apiKeyId, $claimedInstanceId);
    }

    /**
     * The ONE implementation of the FL-01 identity contract (see resolveDesktopIdentity's
     * docblock) — static + PDO-parameterised so services that don't hold this class
     * (FlowService's owner-run surface) enforce the identical rule without duplicating it.
     * @throws \RuntimeException 'instance_mismatch' on an impersonation attempt
     */
    public static function resolveDesktopIdentityWithPdo(PDO $pdo, string $ownerUserId, ?string $apiKeyId, ?string $claimedInstanceId): ?string
    {
        $claimed = $claimedInstanceId !== null && $claimedInstanceId !== '' ? $claimedInstanceId : null;
        $key = $apiKeyId !== null && $apiKeyId !== '' ? $apiKeyId : null;
        if ($key !== null) {
            $stmt = $pdo->prepare(
                'SELECT desktop_instance_id FROM desktop_connections WHERE owner_user_id = :o AND api_key_id = :k LIMIT 1'
            );
            $stmt->execute(['o' => $ownerUserId, 'k' => $key]);
            $bound = $stmt->fetchColumn();
            if (is_string($bound) && $bound !== '' && !str_starts_with($bound, 'oauth-')) {
                if ($claimed !== null && $claimed !== $bound) {
                    throw new \RuntimeException('instance_mismatch');
                }
                return $bound;
            }
        }
        if ($claimed !== null) {
            $stmt = $pdo->prepare(
                'SELECT api_key_id FROM desktop_connections WHERE owner_user_id = :o AND desktop_instance_id = :i LIMIT 1'
            );
            $stmt->execute(['o' => $ownerUserId, 'i' => $claimed]);
            $row = $stmt->fetch();
            if ($row !== false && $row['api_key_id'] !== null && (string) $row['api_key_id'] !== $key) {
                throw new \RuntimeException('instance_mismatch');
            }
        }
        return $claimed;
    }

    /**
     * ROUTE-001: which desktop instance should a command for this connector be TARGETED at?
     *
     * Resolution order (deterministic; NO implicit failover):
     *   1. Explicit connector assignment with a pinned desktop connection → that connection's
     *      instance id, EVEN IF it is currently offline — the command then expires visibly
     *      instead of being silently serviced by a machine without the phone attached.
     *   2. No pin, exactly ONE fresh (≤90s) desktop connection → implicit single target
     *      (mirrors INT-004's implicit-single app routing).
     *   3. No pin, ZERO fresh connections → untargeted (legacy fan-out): a desktop that is
     *      just (re)starting — or one that predates connection registration — can still pick
     *      the command up inside its TTL.
     *   4. No pin, 2+ fresh connections → AMBIGUOUS: refuse, naming the candidates, so the
     *      wrong computer can never claim-and-fail a call command (the audit's core scenario).
     *
     * @return array{target: ?string, error: ?string, desktops: array[]}
     *         desktops = the fresh candidates (id/deviceName/instance/lastSeenAt) when ambiguous.
     */
    public function resolveTargetInstance(string $ownerUserId, string $connectorId): array
    {
        // 1) Explicit pin via the connector assignment.
        $stmt = $this->mysql->prepare("
            SELECT dc.desktop_instance_id
            FROM connector_assignments ca
            JOIN desktop_connections dc ON dc.id = ca.desktop_connection_id
            WHERE ca.owner_user_id = :o AND ca.connector_id = :c AND ca.desktop_connection_id IS NOT NULL
            LIMIT 1
        ");
        $stmt->execute(['o' => $ownerUserId, 'c' => $connectorId]);
        $pinned = $stmt->fetchColumn();
        if (is_string($pinned) && $pinned !== '') {
            return ['target' => $pinned, 'error' => null, 'desktops' => []];
        }

        // 2-4) Fresh connections decide.
        $fresh = self::DESKTOP_FRESH_SECONDS;
        $stmt = $this->mysql->prepare("
            SELECT id, device_name, desktop_instance_id, last_seen_at
            FROM desktop_connections
            WHERE owner_user_id = :o AND last_seen_at IS NOT NULL
              AND last_seen_at > (NOW() - INTERVAL {$fresh} SECOND)
            ORDER BY last_seen_at DESC
        ");
        $stmt->execute(['o' => $ownerUserId]);
        $rows = $stmt->fetchAll();
        if (count($rows) === 1) {
            return ['target' => (string) $rows[0]['desktop_instance_id'], 'error' => null, 'desktops' => []];
        }
        if (count($rows) === 0) {
            return ['target' => null, 'error' => null, 'desktops' => []];
        }
        return [
            'target' => null,
            'error' => 'ambiguous_desktop',
            'desktops' => array_map(static fn (array $r) => [
                'id' => $r['id'],
                'deviceName' => $r['device_name'],
                'desktopInstanceId' => $r['desktop_instance_id'],
                'lastSeenAt' => $r['last_seen_at'],
            ], $rows),
        ];
    }

    /**
     * ROUTE-001: map desktop instance ids → device names (owner-scoped), so command
     * read-backs can show WHICH machine a command was aimed at / handled by.
     * @param string[] $instanceIds
     * @return array<string, string> instanceId => deviceName
     */
    public function describeInstances(string $ownerUserId, array $instanceIds): array
    {
        $ids = array_values(array_unique(array_filter($instanceIds, static fn ($v) => is_string($v) && $v !== '')));
        if ($ids === []) {
            return [];
        }
        $placeholders = implode(',', array_fill(0, count($ids), '?'));
        $stmt = $this->mysql->prepare(
            "SELECT desktop_instance_id, device_name FROM desktop_connections
             WHERE owner_user_id = ? AND desktop_instance_id IN ({$placeholders})"
        );
        $stmt->execute([$ownerUserId, ...$ids]);
        $out = [];
        foreach ($stmt->fetchAll() as $row) {
            $out[(string) $row['desktop_instance_id']] = (string) $row['device_name'];
        }
        return $out;
    }

    /** Seconds a freshly-enqueued command stays claimable (audit INT-005: call control is short). */
    private function ttlFor(string $command): int
    {
        return str_starts_with($command, 'call.')
            ? self::CALL_COMMAND_TTL_SECONDS
            : self::COMMAND_TTL_SECONDS;
    }

    /**
     * Sweep stale commands to 'expired' (opportunistic GC, owner-scoped when polled; the cleanup
     * cron also calls this globally — see bin/desktop-commands-cleanup.php). Fails soft.
     *
     * Two branches, anchored on DIFFERENT timestamps because they answer different questions:
     *   - 'pending' rows past their own `expires_at` (set once at enqueue() time) — the original
     *     behavior: nothing ever claimed it in time.
     *   - 'claimed' rows whose `claimed_at` (set once at claim() time, never touched again) is older
     *     than CLAIMED_STALE_SECONDS — a command a desktop CLAIMED but crashed/lost connectivity
     *     before completing.
     *
     * The claimed branch deliberately does NOT reuse `expires_at`: that column is fixed at
     * enqueue()-time and never extended by claim(), so a command claimed late in its 60s pending
     * window (e.g. the desktop was mid-backoff after a transient long-poll error, or is working
     * through several commands claimed in the same poll batch) can still be genuinely in-flight —
     * its claiming desktop healthy and actively executing it — for a few more seconds after
     * `expires_at` has already passed. Gating on `expires_at` here would expire that still-live row
     * out from under its own claimant: the eventual legitimate complete() call would then fail with
     * 409 ('not_claimed') and the real result would be silently dropped. `claimed_at` is the
     * timestamp of the event we're actually trying to detect abandonment SINCE — the same principle
     * FlowService::reclaimStuckRuns() applies via `started_at` for flow runs.
     *
     * CLAIMED_STALE_SECONDS (300s / 5 min) is comfortably longer than any plausible legitimate
     * claim→complete duration (long-poll + a single connector dispatch call normally completes in
     * well under a second) while still reclaiming a genuinely crashed claim in a bounded, short
     * window — not the 7-day retention period bin/desktop-commands-cleanup.php would otherwise take
     * to eventually sweep away a 'claimed' row nothing else ever revisits.
     *
     * Each scope (owner-scoped / global) runs its two UPDATEs inside one transaction, so a mid-sweep
     * failure can't half-apply (first UPDATE committed, second throws) while still reporting 0.
     */
    public function expireStale(?string $ownerUserId = null): int
    {
        $claimedCutoff = self::CLAIMED_STALE_SECONDS; // int class constant, safe to interpolate
        try {
            $this->mysql->beginTransaction();
            $total = 0;
            if ($ownerUserId !== null) {
                $stmt = $this->mysql->prepare("UPDATE desktop_commands SET status = 'expired' WHERE owner_user_id = :o AND status = 'pending' AND expires_at <= NOW()");
                $stmt->execute(['o' => $ownerUserId]);
                $total += $stmt->rowCount();

                $stmt = $this->mysql->prepare("UPDATE desktop_commands SET status = 'expired' WHERE owner_user_id = :o AND status = 'claimed' AND claimed_at IS NOT NULL AND claimed_at < (NOW() - INTERVAL {$claimedCutoff} SECOND)");
                $stmt->execute(['o' => $ownerUserId]);
                $total += $stmt->rowCount();
            } else {
                $stmt = $this->mysql->query("UPDATE desktop_commands SET status = 'expired' WHERE status = 'pending' AND expires_at <= NOW()");
                $total += $stmt->rowCount();

                $stmt = $this->mysql->query("UPDATE desktop_commands SET status = 'expired' WHERE status = 'claimed' AND claimed_at IS NOT NULL AND claimed_at < (NOW() - INTERVAL {$claimedCutoff} SECOND)");
                $total += $stmt->rowCount();
            }
            $this->mysql->commit();
            return $total;
        } catch (\Throwable $e) {
            if ($this->mysql->inTransaction()) {
                $this->mysql->rollBack();
            }
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
            'targetInstanceId' => $row['target_instance_id'] ?? null,
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

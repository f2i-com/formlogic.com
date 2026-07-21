<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use PDO;

/**
 * E2E AI relay channel (docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md §5/§6/§7, Phase 1).
 *
 * A web member enqueues a SEALED AI request (NaCl-box envelope the backend cannot read) for
 * their linked FormLogic Desktop; the desktop long-polls the lane, CLAIMS one request
 * (single-flight FIFO per target desktop), streams sealed reply frames back, and COMPLETES
 * the request. The relay stores only routing metadata (owner, requester, target, provider,
 * kind, sizes, timing) plus the sealed bodies — and complete()/expireStale() PURGE the
 * envelope + frame content, so plaintext chat content never touches the backend and sealed
 * content never meaningfully outlives its request (terminal OUT frames get a short
 * FRAME_GRACE_SECONDS drain window for the reply stream, then expireStale() reaps them).
 *
 * Queueing mirrors DesktopCommandService (reserve-first on the UNIQUE idempotency_key,
 * opportunistic expiry, claimant binding), with the AI-lane rules of plan §5.2:
 *   - caps: per-user ≤ 2 in flight (typed queue_full_user), per-target ≤ 8 (queue_full_desktop);
 *   - TTL 5 min for a pending request; a claimed/streaming request is reaped after
 *     CLAIMED_STALE_SECONDS of SILENCE (claimed_at doubles as the activity anchor — it is
 *     refreshed on every frame append, since an LLM stream can legitimately run for minutes);
 *   - single-flight per target: claim() is ONE atomic UPDATE guarded by NOT EXISTS
 *     (claimed|streaming sibling for the same target);
 *   - queue position is computed at read time, never stored.
 *
 * Target resolution (assignment pin → implicit single fresh desktop → 409 ambiguous_desktop)
 * lives in DesktopCommandService::resolveTargetInstance and is applied by the controller,
 * exactly like the connector-command relay.
 */
class DesktopAiRelayService
{
    /** Pending requests are short-lived: a chat turn the desktop must pick up now (plan §5.2). */
    public const REQUEST_TTL_SECONDS = 300;
    /** A claimed/streaming request silent for this long is reaped (see expireStale()). */
    public const CLAIMED_STALE_SECONDS = 300;

    /** Sealed OUT frames of a terminal request survive this long so the reply stream can drain. */
    public const FRAME_GRACE_SECONDS = 60;
    /** AI-lane caps (plan §5.2). */
    public const MAX_IN_FLIGHT_PER_USER = 2;
    public const MAX_IN_FLIGHT_PER_TARGET = 8;
    public const MAX_ENVELOPE_BYTES = 262144;    // 256 KiB sealed request envelope
    public const MAX_FRAME_BYTES = 4194304;      // 4 MiB per sealed frame
    public const MAX_KIND = 32;
    public const MAX_PROVIDER_ID = 128;
    public const MAX_IDEMPOTENCY_KEY = 255;

    /** Terminal statuses a desktop may complete a claimed request with. */
    public const COMPLETE_STATUSES = ['done', 'failed'];

    /** Long-poll ceiling: a single pending request blocks at most 25s before returning empty. */
    public const MAX_WAIT_MS = 25000;
    private const POLL_INTERVAL_MS = 500;

    /** Same shape DesktopCommandService enforces for desktop instance ids. */
    private const INSTANCE_ID_PATTERN = '/^[A-Za-z0-9._-]+$/';
    private const MAX_INSTANCE_ID = 128;

    private PDO $mysql;

    public function __construct(MySQLConnection $mysql)
    {
        $this->mysql = $mysql->getConnection();
    }

    /**
     * Enqueue a sealed AI request for the owner's desktop. Reserve-first on idempotency_key:
     * a duplicate returns the existing row (created=false). status 'pending', expires 5 min out.
     *
     * @return array{request: array, created: bool}
     * @throws \InvalidArgumentException on invalid payload / foreign idempotency-key reuse
     * @throws \RuntimeException 'queue_full_user'|'queue_full_desktop' on a tripped lane cap
     */
    public function enqueue(string $ownerUserId, string $requestingUserId, array $data): array
    {
        $kind = $data['kind'] ?? null;
        if (!is_string($kind) || !preg_match('/^[a-z0-9][a-z0-9._-]{0,31}$/', $kind)) {
            throw new \InvalidArgumentException('kind is required (lowercase token, max ' . self::MAX_KIND . ' chars)');
        }
        $providerId = $data['providerId'] ?? null;
        // The ':' admits the union's service form ('service:llama-cpp') — the desktop's
        // chat lane can target a chat-capable local service, not only gateway providers.
        if (!is_string($providerId) || !preg_match('/^[a-z0-9][a-z0-9._:-]{0,127}$/', $providerId)) {
            throw new \InvalidArgumentException('providerId is required (lowercase token, max ' . self::MAX_PROVIDER_ID . ' chars)');
        }
        $ephPub = $data['ephPub'] ?? null;
        if (!is_string($ephPub) || strlen($ephPub) > 64 || base64_decode($ephPub, true) === false
            || strlen((string) base64_decode($ephPub, true)) !== 32) {
            throw new \InvalidArgumentException('ephPub must be a base64-encoded 32-byte X25519 public key');
        }

        $envelope = $data['envelope'] ?? null;
        if (!is_string($envelope) || $envelope === '') {
            throw new \InvalidArgumentException('envelope is required (base64 sealed body)');
        }
        $envelopeBytes = base64_decode($envelope, true);
        if ($envelopeBytes === false || strlen($envelopeBytes) > self::MAX_ENVELOPE_BYTES) {
            throw new \InvalidArgumentException('envelope exceeds the ' . self::MAX_ENVELOPE_BYTES . '-byte limit');
        }

        $idempotencyKey = $data['idempotencyKey'] ?? null;
        if ($idempotencyKey === null || $idempotencyKey === '') {
            // No key supplied → a fresh random one (no dedupe; every enqueue is distinct).
            $idempotencyKey = 'aireq-' . bin2hex(random_bytes(16));
        }
        if (!is_string($idempotencyKey) || strlen($idempotencyKey) > self::MAX_IDEMPOTENCY_KEY) {
            throw new \InvalidArgumentException('idempotencyKey must be a string (max ' . self::MAX_IDEMPOTENCY_KEY . ' chars)');
        }

        // The CONTROLLER sets the target from resolveTargetInstance() (assignment pin /
        // implicit single fresh desktop); a client-supplied value never passes through.
        $targetInstanceId = null;
        if (isset($data['targetInstanceId']) && $data['targetInstanceId'] !== null && $data['targetInstanceId'] !== '') {
            $t = $data['targetInstanceId'];
            if (!is_string($t) || strlen($t) > self::MAX_INSTANCE_ID || !preg_match(self::INSTANCE_ID_PATTERN, $t)) {
                throw new \InvalidArgumentException('targetInstanceId must match the desktop instance id shape');
            }
            $targetInstanceId = $t;
        }

        // Lane caps (plan §5.2) count every non-terminal row for the lane — a pending row is
        // queued, a claimed/streaming one is being serviced; both occupy the single flight.
        // Expire stale rows first so the caps reflect live occupancy.
        $this->expireStale($ownerUserId);
        if ($this->countInFlightForUser($ownerUserId, $requestingUserId) >= self::MAX_IN_FLIGHT_PER_USER) {
            throw new \RuntimeException('queue_full_user');
        }
        if ($this->countInFlightForTarget($ownerUserId, $targetInstanceId) >= self::MAX_IN_FLIGHT_PER_TARGET) {
            throw new \RuntimeException('queue_full_desktop');
        }

        $id = $this->uuid();
        try {
            $stmt = $this->mysql->prepare("
                INSERT INTO desktop_ai_requests
                    (id, owner_user_id, requesting_user_id, target_instance_id, provider_id, kind,
                     eph_pub, envelope, status, idempotency_key, expires_at)
                VALUES
                    (:id, :owner, :req, :target, :provider, :kind, :eph, :env, 'pending', :key, :exp)
            ");
            $stmt->execute([
                'id' => $id,
                'owner' => $ownerUserId,
                'req' => $requestingUserId,
                'target' => $targetInstanceId,
                'provider' => $providerId,
                'kind' => $kind,
                'eph' => $ephPub,
                'env' => $envelopeBytes,
                'key' => $idempotencyKey,
                'exp' => date('Y-m-d H:i:s', time() + self::REQUEST_TTL_SECONDS),
            ]);
        } catch (\PDOException $e) {
            if (!$this->isDuplicateKey($e)) {
                throw $e;
            }
            // Reserved already: return the existing row — but only within the same owner (never
            // leak a foreign request id under a reused key).
            $find = $this->mysql->prepare("SELECT * FROM desktop_ai_requests WHERE idempotency_key = :k LIMIT 1");
            $find->execute(['k' => $idempotencyKey]);
            $row = $find->fetch();
            if (!$row || ($row['owner_user_id'] ?? null) !== $ownerUserId) {
                throw new \InvalidArgumentException('This idempotency key was already used');
            }
            return ['request' => $this->format($row), 'created' => false];
        }

        return ['request' => $this->get($id, $ownerUserId) ?? throw new \RuntimeException('Request enqueue failed'), 'created' => true];
    }

    /** One request by id, scoped to the owner. */
    public function get(string $id, string $ownerUserId): ?array
    {
        $stmt = $this->mysql->prepare("SELECT * FROM desktop_ai_requests WHERE id = :id AND owner_user_id = :o");
        $stmt->execute(['id' => $id, 'o' => $ownerUserId]);
        $row = $stmt->fetch();
        return $row ? $this->format($row) : null;
    }

    /**
     * One request by id, visible to either party scope (the account owner OR the requesting
     * user). The web {id} routes resolve through this so a member-delegated request stays
     * reachable to its requester; the controller then enforces the requesting-user match
     * (owner gets 403, a stranger outside both scopes gets 404 — no existence oracle).
     */
    public function getForAccess(string $id, string $userId): ?array
    {
        $stmt = $this->mysql->prepare("
            SELECT * FROM desktop_ai_requests WHERE id = :id AND (requesting_user_id = :u OR owner_user_id = :o)
        ");
        $stmt->execute(['id' => $id, 'u' => $userId, 'o' => $userId]);
        $row = $stmt->fetch();
        return $row ? $this->format($row) : null;
    }

    /** Lightweight status read for the SSE loop's terminal detection. */
    public function getStatus(string $id, string $ownerUserId): ?string
    {
        $stmt = $this->mysql->prepare("SELECT status FROM desktop_ai_requests WHERE id = :id AND owner_user_id = :o");
        $stmt->execute(['id' => $id, 'o' => $ownerUserId]);
        $status = $stmt->fetchColumn();
        return $status === false ? null : (string) $status;
    }

    /**
     * Live queue position (plan §5.2: computed at read, never stored): the number of pending,
     * non-expired requests AHEAD of this one for the same owner + target, in the same FIFO
     * order listPending serves (created_at, id). 0 for a non-pending request; null if unknown.
     */
    public function queuePosition(string $id, string $ownerUserId): ?int
    {
        $stmt = $this->mysql->prepare("SELECT created_at, target_instance_id, status FROM desktop_ai_requests WHERE id = :id AND owner_user_id = :o");
        $stmt->execute(['id' => $id, 'o' => $ownerUserId]);
        $row = $stmt->fetch();
        if (!$row) {
            return null;
        }
        if (($row['status'] ?? '') !== 'pending') {
            return 0;
        }
        $pos = $this->mysql->prepare("
            SELECT COUNT(*) FROM desktop_ai_requests
            WHERE owner_user_id = :o AND status = 'pending' AND expires_at > NOW()
              AND target_instance_id <=> :t
              AND (created_at < :c OR (created_at = :c2 AND id < :id))
        ");
        $pos->execute([
            'o' => $ownerUserId,
            't' => $row['target_instance_id'],
            'c' => $row['created_at'],
            'c2' => $row['created_at'],
            'id' => $id,
        ]);
        return (int) $pos->fetchColumn();
    }

    /**
     * Pending, non-expired requests for the owner's runtime, oldest first (FIFO). Sweeps stale
     * rows to 'expired' first. Visibility mirrors DesktopCommandService::listPending: a targeted
     * request is visible ONLY to its target instance; untargeted rows are visible to every
     * poller (legacy fan-out); a poller that doesn't identify itself sees only untargeted rows.
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
            $where .= " AND created_at > (SELECT created_at FROM desktop_ai_requests WHERE id = :since AND owner_user_id = :o2)";
            $params['since'] = $sinceId;
            $params['o2'] = $ownerUserId;
        }
        $stmt = $this->mysql->prepare("SELECT * FROM desktop_ai_requests WHERE {$where} ORDER BY created_at ASC, id ASC LIMIT {$limit}");
        $stmt->execute($params);
        return array_map([$this, 'format'], $stmt->fetchAll());
    }

    /**
     * Long-poll: return pending requests as soon as any exist, or after up to $waitMs (capped
     * at MAX_WAIT_MS). $waitMs=0 returns immediately (the default the tests exercise).
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
     * Claim a pending request (pending→claimed) exactly-once AND single-flight per target
     * (plan §5.2): ONE atomic UPDATE that fails when the row is no longer pending, when the
     * claiming instance isn't the target, OR when a claimed/streaming sibling already occupies
     * the lane. Returns the claimed request; null when it doesn't exist; throws
     * \RuntimeException('already_claimed'|'targeted_elsewhere'|'lane_busy') on the conflicts
     * (→ 409; lane_busy tells the desktop another request is in flight — try again later).
     * @throws \InvalidArgumentException on invalid payload
     */
    public function claim(string $id, string $ownerUserId, array $data): ?array
    {
        $instanceId = null;
        if (isset($data['instanceId']) && $data['instanceId'] !== null && $data['instanceId'] !== '') {
            if (!is_string($data['instanceId']) || strlen($data['instanceId']) > self::MAX_INSTANCE_ID) {
                throw new \InvalidArgumentException('instanceId must be a string ≤ ' . self::MAX_INSTANCE_ID . ' chars');
            }
            $instanceId = $data['instanceId'];
        }

        // Only a still-pending, non-expired request can be claimed — and only by its TARGET
        // when it has one. The NOT EXISTS guard is the single-flight rule: no claimed or
        // streaming sibling for the same target (NULL-safe compare groups untargeted rows).
        // The sibling probe reads through a derived table because MySQL forbids selecting
        // from the UPDATE target directly.
        $targetSql = $instanceId !== null
            ? ' AND (r.target_instance_id IS NULL OR r.target_instance_id = :ti)'
            : ' AND r.target_instance_id IS NULL';
        $params = ['cb' => $instanceId, 'id' => $id, 'o' => $ownerUserId, 'o2' => $ownerUserId];
        if ($instanceId !== null) {
            $params['ti'] = $instanceId;
        }
        $stmt = $this->mysql->prepare("
            UPDATE desktop_ai_requests AS r
            SET r.status = 'claimed', r.claimed_by = :cb, r.claimed_at = NOW()
            WHERE r.id = :id AND r.owner_user_id = :o AND r.status = 'pending' AND r.expires_at > NOW(){$targetSql}
              AND NOT EXISTS (
                  SELECT 1 FROM (
                      SELECT s.target_instance_id AS busy_target
                      FROM desktop_ai_requests s
                      WHERE s.owner_user_id = :o2 AND s.status IN ('claimed', 'streaming')
                  ) AS busy
                  WHERE busy.busy_target <=> r.target_instance_id
              )
        ");
        $stmt->execute($params);

        if ($stmt->rowCount() === 0) {
            // Expiry is computed in SQL (expires_at > NOW()), never by comparing a MySQL
            // timestamp against PHP's clock — the two timezones need not agree.
            $check = $this->mysql->prepare("
                SELECT status, target_instance_id, (expires_at > NOW()) AS still_valid
                FROM desktop_ai_requests WHERE id = :id AND owner_user_id = :o
            ");
            $check->execute(['id' => $id, 'o' => $ownerUserId]);
            $existing = $check->fetch();
            if (!$existing) {
                return null;
            }
            // Distinguish "someone else beat you" from "this was never yours": a
            // still-pending row we refused to claim can only mean a target mismatch
            // or a busy lane.
            if (
                ($existing['status'] ?? '') === 'pending'
                && ($existing['target_instance_id'] ?? null) !== null
                && $existing['target_instance_id'] !== $instanceId
            ) {
                throw new \RuntimeException('targeted_elsewhere');
            }
            if (($existing['status'] ?? '') === 'pending' && (int) ($existing['still_valid'] ?? 0) === 1) {
                // Still pending and target-matched: the NOT EXISTS guard refused → the lane
                // is occupied by a claimed/streaming sibling. (An expired pending row reads
                // as already_claimed, matching DesktopCommandService's 409 wording.)
                throw new \RuntimeException('lane_busy');
            }
            throw new \RuntimeException('already_claimed');
        }
        return $this->get($id, $ownerUserId);
    }

    /**
     * Append a sealed OUT frame (desktop → browser) to a claimed/streaming request. Claimant-
     * bound like complete(): only the instance that claimed the request may stream for it.
     * The first out-frame transitions claimed→streaming; every append refreshes claimed_at,
     * which doubles as the lane's activity anchor for expireStale() (a long LLM stream stays
     * alive while it keeps producing).
     *
     * @return array{seq: int, status: string}
     * @throws \InvalidArgumentException on invalid payload
     * @throws \RuntimeException 'not_claimed'|'claimed_elsewhere' on state/claimant conflicts
     */
    public function appendFrame(string $id, string $ownerUserId, string $envelope, ?string $instanceId): array
    {
        $envelopeBytes = base64_decode($envelope, true);
        if ($envelopeBytes === false || $envelopeBytes === '' || strlen($envelopeBytes) > self::MAX_FRAME_BYTES) {
            throw new \InvalidArgumentException('envelope must be a base64 sealed frame of at most ' . self::MAX_FRAME_BYTES . ' bytes');
        }

        $this->mysql->beginTransaction();
        try {
            // Lock the row and verify state/claimant explicitly. rowCount() on the UPDATE
            // below can't be used for this: it counts CHANGED rows, and a second frame
            // appended inside the same second changes nothing (status is already
            // 'streaming' and claimed_at=NOW() is unchanged) — it would read as a false
            // 'not_claimed'. The FOR UPDATE lock serializes concurrent appends instead.
            $lock = $this->mysql->prepare("
                SELECT status, claimed_by FROM desktop_ai_requests
                WHERE id = :id AND owner_user_id = :o FOR UPDATE
            ");
            $lock->execute(['id' => $id, 'o' => $ownerUserId]);
            $row = $lock->fetch();
            if (!$row) {
                $this->mysql->rollBack();
                throw new \RuntimeException('not_found');
            }
            if (
                $instanceId !== null
                && in_array($row['status'] ?? '', ['claimed', 'streaming'], true)
                && ($row['claimed_by'] ?? null) !== null
                && $row['claimed_by'] !== $instanceId
            ) {
                $this->mysql->rollBack();
                throw new \RuntimeException('claimed_elsewhere');
            }
            if (!in_array($row['status'] ?? '', ['claimed', 'streaming'], true)) {
                $this->mysql->rollBack();
                throw new \RuntimeException('not_claimed');
            }
            $this->mysql->prepare("
                UPDATE desktop_ai_requests SET status = 'streaming', claimed_at = NOW() WHERE id = :id
            ")->execute(['id' => $id]);
            $insert = $this->mysql->prepare("
                INSERT INTO desktop_ai_frames (request_id, direction, envelope) VALUES (:id, 'out', :env)
            ");
            $insert->execute(['id' => $id, 'env' => $envelopeBytes]);
            $seq = (int) $this->mysql->lastInsertId();
            $this->mysql->commit();
        } catch (\Throwable $e) {
            if ($this->mysql->inTransaction()) {
                $this->mysql->rollBack();
            }
            throw $e;
        }
        return ['seq' => $seq, 'status' => 'streaming'];
    }

    /**
     * Append a sealed IN frame (browser → desktop; plan §5.4 confirm-mode replies). Only a
     * request the desktop has already claimed can take input — a pending request has no
     * producer waiting on it, and a terminal one must not grow content again.
     *
     * @return array{seq: int}
     * @throws \InvalidArgumentException on invalid payload
     * @throws \RuntimeException 'not_claimed' when the request is not claimed/streaming
     */
    public function appendInput(string $id, string $ownerUserId, string $envelope): array
    {
        $envelopeBytes = base64_decode($envelope, true);
        if ($envelopeBytes === false || $envelopeBytes === '' || strlen($envelopeBytes) > self::MAX_FRAME_BYTES) {
            throw new \InvalidArgumentException('envelope must be a base64 sealed frame of at most ' . self::MAX_FRAME_BYTES . ' bytes');
        }
        $existing = $this->get($id, $ownerUserId);
        if ($existing === null) {
            throw new \RuntimeException('not_found');
        }
        if (!in_array($existing['status'] ?? '', ['claimed', 'streaming'], true)) {
            throw new \RuntimeException('not_claimed');
        }
        $insert = $this->mysql->prepare("
            INSERT INTO desktop_ai_frames (request_id, direction, envelope) VALUES (:id, 'in', :env)
        ");
        $insert->execute(['id' => $id, 'env' => $envelopeBytes]);
        return ['seq' => (int) $this->mysql->lastInsertId()];
    }

    /**
     * Desktop-side read of IN frames (confirm-mode input) with seq > $since, claimant-bound:
     * only the claiming instance may read a request's input channel.
     *
     * @return array{frames: array[], status: string}|null null when the request doesn't exist
     * @throws \RuntimeException 'not_claimed'|'claimed_elsewhere' on claimant conflicts
     */
    public function fetchInput(string $id, string $ownerUserId, int $since, ?string $instanceId): ?array
    {
        $existing = $this->get($id, $ownerUserId);
        if ($existing === null) {
            return null;
        }
        if ($instanceId !== null) {
            if (($existing['claimedBy'] ?? null) === null) {
                throw new \RuntimeException('not_claimed');
            }
            if ($existing['claimedBy'] !== $instanceId) {
                throw new \RuntimeException('claimed_elsewhere');
            }
        }
        return [
            'frames' => $this->fetchFrames($id, 'in', $since),
            'status' => (string) $existing['status'],
        ];
    }

    /**
     * Web-side read of OUT frames (the sealed reply stream) with seq > $since, oldest first.
     * Requesting-user enforcement happens in the controller before this is called.
     * @return array[] rows of {seq, envelope(base64)}
     */
    public function fetchOutput(string $id, string $ownerUserId, int $since, int $limit = 200): array
    {
        // The owner scope keeps a guessed id from reading another tenant's stream even if a
        // controller check is ever lost; frames carry no owner column of their own.
        $stmt = $this->mysql->prepare("SELECT id FROM desktop_ai_requests WHERE id = :id AND owner_user_id = :o");
        $stmt->execute(['id' => $id, 'o' => $ownerUserId]);
        if (!$stmt->fetchColumn()) {
            return [];
        }
        return $this->fetchFrames($id, 'out', $since, $limit);
    }

    /**
     * Complete a claimed request (claimed|streaming→done|failed), claimant-bound, and purge
     * the sealed REQUEST envelope + inbound frames immediately (plan §7). Sealed OUT frames
     * deliberately survive for FRAME_GRACE_SECONDS after completion: an instant-completing
     * request (kind=providers/models) would otherwise purge its reply between two SSE poll
     * ticks and the reader would see 'done' with no frames — found live 2026-07-22. The
     * grace purge rides expireStale(). Returns the updated request; null when not found;
     * throws \RuntimeException('not_claimed'|'claimed_elsewhere') on conflicts (→ 409).
     * @throws \InvalidArgumentException on invalid payload
     */
    public function complete(string $id, string $ownerUserId, array $data): ?array
    {
        $status = $data['status'] ?? null;
        if (!is_string($status) || !in_array($status, self::COMPLETE_STATUSES, true)) {
            throw new \InvalidArgumentException('status must be one of: ' . implode(', ', self::COMPLETE_STATUSES));
        }

        $instanceId = null;
        if (isset($data['instanceId']) && $data['instanceId'] !== null && $data['instanceId'] !== '') {
            if (!is_string($data['instanceId']) || strlen($data['instanceId']) > self::MAX_INSTANCE_ID) {
                throw new \InvalidArgumentException('instanceId must be a string ≤ ' . self::MAX_INSTANCE_ID . ' chars');
            }
            $instanceId = $data['instanceId'];
        }

        // Claimant binding (same rule as DesktopCommandService): when the completer identifies
        // itself, it must be the SAME instance that claimed the request. The envelope is nulled
        // by the same UPDATE so terminal rows never retain sealed content.
        $claimantSql = $instanceId !== null ? ' AND (claimed_by IS NULL OR claimed_by = :cb)' : '';
        $params = ['s' => $status, 'id' => $id, 'o' => $ownerUserId];
        if ($instanceId !== null) {
            $params['cb'] = $instanceId;
        }

        $this->mysql->beginTransaction();
        try {
            $stmt = $this->mysql->prepare("
                UPDATE desktop_ai_requests
                SET status = :s, envelope = NULL, finished_at = NOW()
                WHERE id = :id AND owner_user_id = :o AND status IN ('claimed', 'streaming'){$claimantSql}
            ");
            $stmt->execute($params);
            if ($stmt->rowCount() === 0) {
                $this->mysql->rollBack();
                $existing = $this->get($id, $ownerUserId);
                if ($existing === null) {
                    return null;
                }
                if (
                    $instanceId !== null
                    && in_array($existing['status'] ?? '', ['claimed', 'streaming'], true)
                    && ($existing['claimedBy'] ?? null) !== null
                    && $existing['claimedBy'] !== $instanceId
                ) {
                    throw new \RuntimeException('claimed_elsewhere');
                }
                throw new \RuntimeException('not_claimed');
            }
            $this->mysql->prepare("DELETE FROM desktop_ai_frames WHERE request_id = :id AND direction = 'in'")
                ->execute(['id' => $id]);
            $this->mysql->commit();
        } catch (\Throwable $e) {
            if ($this->mysql->inTransaction()) {
                $this->mysql->rollBack();
            }
            throw $e;
        }
        return $this->get($id, $ownerUserId);
    }

    /**
     * Publish (or rotate) a desktop's long-term X25519 public key onto its connection row.
     * False when the owner has no connection row for the instance (the desktop heartbeats its
     * row first; plan §5.1 publishes on boot when the server has no key).
     */
    public function publishPubkey(string $ownerUserId, string $instanceId, string $publicKey): bool
    {
        // Existence check first: rowCount() on the UPDATE counts CHANGED rows, so
        // re-publishing the SAME key (idempotent boot publish) would read as a false
        // "unknown instance".
        $find = $this->mysql->prepare("
            SELECT id FROM desktop_connections WHERE owner_user_id = :o AND desktop_instance_id = :i
        ");
        $find->execute(['o' => $ownerUserId, 'i' => $instanceId]);
        if (!$find->fetchColumn()) {
            return false;
        }
        $stmt = $this->mysql->prepare("
            UPDATE desktop_connections SET e2e_public_key = :k
            WHERE owner_user_id = :o AND desktop_instance_id = :i
        ");
        $stmt->execute(['k' => $publicKey, 'o' => $ownerUserId, 'i' => $instanceId]);
        return true;
    }

    /** The published key for a connection, or null when none was ever published (e2e_key_unknown). */
    public function getPubkey(string $ownerUserId, string $instanceId): ?string
    {
        $stmt = $this->mysql->prepare("
            SELECT e2e_public_key FROM desktop_connections
            WHERE owner_user_id = :o AND desktop_instance_id = :i
        ");
        $stmt->execute(['o' => $ownerUserId, 'i' => $instanceId]);
        $key = $stmt->fetchColumn();
        return is_string($key) && $key !== '' ? $key : null;
    }

    /**
     * Sweep stale requests to 'expired', purging their sealed content in the same pass
     * (opportunistic GC, owner-scoped when polled; fails soft like DesktopCommandService).
     *
     * Two branches, mirroring DesktopCommandService::expireStale:
     *   - 'pending' rows past their enqueue-anchored expires_at (nothing claimed them in time);
     *   - 'claimed'/'streaming' rows whose claimed_at — refreshed on every appended frame, so
     *     it tracks lane ACTIVITY, not just the claim moment — is older than
     *     CLAIMED_STALE_SECONDS. A silently-crashed desktop's claim can't hold the single
     *     flight hostage, while a request that keeps streaming frames is never reaped.
     */
    public function expireStale(?string $ownerUserId = null): int
    {
        $claimedCutoff = self::CLAIMED_STALE_SECONDS; // int class constant, safe to interpolate
        $ownerSql = $ownerUserId !== null ? ' AND owner_user_id = :o' : '';
        $params = $ownerUserId !== null ? ['o' => $ownerUserId] : [];
        try {
            $this->mysql->beginTransaction();
            $select = $this->mysql->prepare("
                SELECT id FROM desktop_ai_requests
                WHERE (status = 'pending' AND expires_at <= NOW())
                   OR (status IN ('claimed', 'streaming') AND claimed_at IS NOT NULL
                       AND claimed_at < (NOW() - INTERVAL {$claimedCutoff} SECOND))
                   {$ownerSql}
            ");
            $select->execute($params);
            $ids = $select->fetchAll(PDO::FETCH_COLUMN);
            if ($ids === []) {
                $this->mysql->commit();
                $this->purgeGracedFrames();
                return 0;
            }
            $quoted = implode(',', array_map(fn ($id) => $this->mysql->quote((string) $id), $ids));
            $this->mysql->exec("UPDATE desktop_ai_requests SET status = 'expired', envelope = NULL, finished_at = NOW() WHERE id IN ({$quoted})");
            $this->mysql->exec("DELETE FROM desktop_ai_frames WHERE request_id IN ({$quoted})");
            $this->mysql->commit();
            $this->purgeGracedFrames();
            return count($ids);
        } catch (\Throwable $e) {
            if ($this->mysql->inTransaction()) {
                $this->mysql->rollBack();
            }
            return 0;
        }
    }

    /**
     * Reap OUT frames of terminal requests once FRAME_GRACE_SECONDS have passed since
     * completion — the deferred half of complete()'s purge (see its docblock): the reply
     * stream gets a drain window, then the sealed content leaves the database.
     */
    private function purgeGracedFrames(): void
    {
        $grace = self::FRAME_GRACE_SECONDS; // int class constant, safe to interpolate
        try {
            $this->mysql->exec("
                DELETE f FROM desktop_ai_frames f
                JOIN desktop_ai_requests r ON r.id = f.request_id
                WHERE r.status IN ('done', 'failed', 'expired')
                  AND r.finished_at IS NOT NULL
                  AND r.finished_at < (NOW() - INTERVAL {$grace} SECOND)
            ");
        } catch (\Throwable) {
            // Reaping is best-effort on this pass; the next expireStale() retries.
        }
    }

    // ── Internals ──

    /** Non-terminal lane occupancy for one requesting user (any target). */
    private function countInFlightForUser(string $ownerUserId, string $requestingUserId): int
    {
        $stmt = $this->mysql->prepare("
            SELECT COUNT(*) FROM desktop_ai_requests
            WHERE owner_user_id = :o AND requesting_user_id = :u AND status IN ('pending', 'claimed', 'streaming')
        ");
        $stmt->execute(['o' => $ownerUserId, 'u' => $requestingUserId]);
        return (int) $stmt->fetchColumn();
    }

    /** Non-terminal lane occupancy for one target desktop (NULL = the untargeted pool). */
    private function countInFlightForTarget(string $ownerUserId, ?string $targetInstanceId): int
    {
        $stmt = $this->mysql->prepare("
            SELECT COUNT(*) FROM desktop_ai_requests
            WHERE owner_user_id = :o AND status IN ('pending', 'claimed', 'streaming')
              AND target_instance_id <=> :t
        ");
        $stmt->execute(['o' => $ownerUserId, 't' => $targetInstanceId]);
        return (int) $stmt->fetchColumn();
    }

    /** @return array[] rows of {seq, envelope(base64)} */
    private function fetchFrames(string $requestId, string $direction, int $since, int $limit = 200): array
    {
        $limit = max(1, min(500, $limit));
        $stmt = $this->mysql->prepare("
            SELECT seq, envelope FROM desktop_ai_frames
            WHERE request_id = :id AND direction = :dir AND seq > :since
            ORDER BY seq ASC LIMIT {$limit}
        ");
        $stmt->execute(['id' => $requestId, 'dir' => $direction, 'since' => max(0, $since)]);
        $frames = [];
        foreach ($stmt->fetchAll() as $row) {
            $frames[] = [
                'seq' => (int) $row['seq'],
                'envelope' => base64_encode((string) $row['envelope']),
            ];
        }
        return $frames;
    }

    private function isDuplicateKey(\PDOException $e): bool
    {
        return $e->getCode() === '23000' || (isset($e->errorInfo[1]) && (int) $e->errorInfo[1] === 1062);
    }

    private function format(array $row): array
    {
        return [
            'requestId' => $row['id'],
            'ownerUserId' => $row['owner_user_id'],
            'requestingUserId' => $row['requesting_user_id'],
            'targetInstanceId' => $row['target_instance_id'] ?? null,
            'providerId' => $row['provider_id'],
            'kind' => $row['kind'],
            'ephPub' => $row['eph_pub'],
            'envelope' => $row['envelope'] !== null ? base64_encode((string) $row['envelope']) : null,
            'idempotencyKey' => $row['idempotency_key'],
            'status' => $row['status'],
            'claimedBy' => $row['claimed_by'] ?? null,
            'createdAt' => $row['created_at'],
            'claimedAt' => $row['claimed_at'] ?? null,
            'finishedAt' => $row['finished_at'] ?? null,
            'expiresAt' => $row['expires_at'],
        ];
    }

    private function uuid(): string
    {
        $d = random_bytes(16);
        $d[6] = chr((ord($d[6]) & 0x0f) | 0x40);
        $d[8] = chr((ord($d[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($d), 4));
    }
}

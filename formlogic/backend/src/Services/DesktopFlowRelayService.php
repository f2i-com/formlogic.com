<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use PDO;

/**
 * E2E flow-run relay channel (docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md §5.2/§5.7, Phase 5).
 *
 * A web member enqueues a SEALED flow run (a NaCl-box envelope carrying the run inputs +
 * context, which the backend cannot read) for their linked FormLogic Desktop; the desktop
 * long-polls the lane, CLAIMS one run (single-flight FIFO per target desktop), streams sealed
 * progress frames back, and COMPLETES it with a sealed result. The relay stores only routing
 * metadata (owner, requester, target, flow id, sizes, timing) plus the sealed bodies — and
 * complete()/expireStale() PURGE the envelope + frame content, so plaintext flow content never
 * touches the backend and sealed content never outlives its run.
 *
 * Result retention (the flow lane's one deliberate difference from the AI lane): a flow run's
 * RESULT must be retrievable after completion, so complete() purges the request envelope +
 * frames but KEEPS result_envelope until the requester reads the run row ONCE
 * (consumeResultEnvelope(), called by the controller's web GET) — read-once-then-purge is the
 * honest E2E design. A result nobody reads is still bounded: expireStale() purges terminal-row
 * results older than RESULT_RETENTION_SECONDS.
 *
 * Queueing mirrors DesktopAiRelayService (reserve-first on the UNIQUE idempotency_key,
 * opportunistic expiry, claimant binding), with the flow-lane rules of plan §5.2:
 *   - caps: per-user ≤ 2 in flight (typed queue_full_user), per-target ≤ 4 (queue_full_desktop);
 *   - TTL 15 min for a pending run; a claimed/streaming run is reaped after
 *     CLAIMED_STALE_SECONDS of SILENCE (claimed_at doubles as the activity anchor — it is
 *     refreshed on every frame append, since a flow can legitimately run for minutes);
 *   - single-flight per target: claim() is ONE atomic UPDATE guarded by NOT EXISTS
 *     (claimed|streaming sibling for the same target);
 *   - queue position is computed at read time, never stored.
 *
 * Target resolution (assignment pin → implicit single fresh desktop → 409 ambiguous_desktop)
 * lives in DesktopCommandService::resolveTargetInstance and is applied by the controller with
 * the reserved connector id 'desktop-flow', exactly like the AI lane's 'desktop-ai'.
 */
class DesktopFlowRelayService
{
    /** Pending runs are short-lived but outlive a chat turn: a flow the desktop must start soon (plan §5.2). */
    public const REQUEST_TTL_SECONDS = 900;
    /** A claimed/streaming run silent for this long is reaped (see expireStale()). */
    public const CLAIMED_STALE_SECONDS = 900;
    /** A completed run's unread sealed result is retained at most this long (read-once GC). */
    public const RESULT_RETENTION_SECONDS = 86400;
    /** Flow-lane caps (plan §5.2). */
    public const MAX_IN_FLIGHT_PER_USER = 2;
    public const MAX_IN_FLIGHT_PER_TARGET = 4;
    public const MAX_ENVELOPE_BYTES = 262144;    // 256 KiB sealed request envelope
    public const MAX_FRAME_BYTES = 1048576;      // 1 MiB per sealed progress frame
    public const MAX_RESULT_BYTES = 1048576;     // 1 MiB sealed result envelope
    public const MAX_IDEMPOTENCY_KEY = 255;

    /** Terminal statuses a desktop may complete a claimed run with. */
    public const COMPLETE_STATUSES = ['done', 'failed'];

    /** Long-poll ceiling: a single pending run blocks at most 25s before returning empty. */
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
     * Enqueue a sealed flow run for the owner's desktop. Reserve-first on idempotency_key:
     * a duplicate returns the existing row (created=false). status 'pending', expires 15 min out.
     * The CONTROLLER validates the flow id against the owner's flow library before calling this.
     *
     * @return array{request: array, created: bool}
     * @throws \InvalidArgumentException on invalid payload / foreign idempotency-key reuse
     * @throws \RuntimeException 'queue_full_user'|'queue_full_desktop' on a tripped lane cap
     */
    public function enqueue(string $ownerUserId, string $requestingUserId, array $data): array
    {
        $flowId = $data['flowId'] ?? null;
        if (!is_string($flowId) || !preg_match('/^[A-Za-z0-9._-]{1,64}$/', $flowId)) {
            throw new \InvalidArgumentException('flowId is required (max 64 chars)');
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
            $idempotencyKey = 'flowrun-' . bin2hex(random_bytes(16));
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
        // Expire stale rows first so the caps reflect live occupancy (BEFORE the enqueue
        // transaction — expireStale manages its own). The count + insert are SERIALIZED per
        // owner behind a FOR UPDATE lock on the owner's users row (audit FL-18): without
        // it, concurrent enqueues both pass the count and overshoot the cap.
        $this->expireStale($ownerUserId);
        $id = $this->uuid();
        $wrapped = !$this->mysql->inTransaction();
        if ($wrapped) {
            $this->mysql->beginTransaction();
        }
        try {
            $lock = $this->mysql->prepare('SELECT id FROM users WHERE id = :o FOR UPDATE');
            $lock->execute(['o' => $ownerUserId]);
            if ($this->countInFlightForUser($ownerUserId, $requestingUserId) >= self::MAX_IN_FLIGHT_PER_USER) {
                throw new \RuntimeException('queue_full_user');
            }
            if ($this->countInFlightForTarget($ownerUserId, $targetInstanceId) >= self::MAX_IN_FLIGHT_PER_TARGET) {
                throw new \RuntimeException('queue_full_desktop');
            }

            $stmt = $this->mysql->prepare("
                INSERT INTO desktop_flow_runs
                    (id, owner_user_id, requesting_user_id, target_instance_id, flow_id,
                     eph_pub, envelope, status, idempotency_key, expires_at)
                VALUES
                    (:id, :owner, :req, :target, :flow, :eph, :env, 'pending', :key, :exp)
            ");
            $stmt->execute([
                'id' => $id,
                'owner' => $ownerUserId,
                'req' => $requestingUserId,
                'target' => $targetInstanceId,
                'flow' => $flowId,
                'eph' => $ephPub,
                'env' => $envelopeBytes,
                'key' => $idempotencyKey,
                'exp' => date('Y-m-d H:i:s', time() + self::REQUEST_TTL_SECONDS),
            ]);
            if ($wrapped) {
                $this->mysql->commit();
            }
        } catch (\Throwable $e) {
            if ($wrapped && $this->mysql->inTransaction()) {
                $this->mysql->rollBack();
            }
            if (!($e instanceof \PDOException) || !$this->isDuplicateKey($e)) {
                throw $e;
            }
            // Reserved already: return the existing row — but only within the same owner (never
            // leak a foreign run id under a reused key). Same owner scope as the unique
            // index (audit FL-08).
            $find = $this->mysql->prepare("SELECT * FROM desktop_flow_runs WHERE owner_user_id = :o AND idempotency_key = :k LIMIT 1");
            $find->execute(['o' => $ownerUserId, 'k' => $idempotencyKey]);
            $row = $find->fetch();
            if (!$row) {
                throw new \InvalidArgumentException('This idempotency key was already used');
            }
            return ['request' => $this->format($row), 'created' => false];
        }

        return ['request' => $this->get($id, $ownerUserId) ?? throw new \RuntimeException('Run enqueue failed'), 'created' => true];
    }

    /** One run by id, scoped to the owner. */
    public function get(string $id, string $ownerUserId): ?array
    {
        $stmt = $this->mysql->prepare("SELECT * FROM desktop_flow_runs WHERE id = :id AND owner_user_id = :o");
        $stmt->execute(['id' => $id, 'o' => $ownerUserId]);
        $row = $stmt->fetch();
        return $row ? $this->format($row) : null;
    }

    /**
     * One run by id, visible to either party scope (the account owner OR the requesting
     * user). The web {id} routes resolve through this so a member-delegated run stays
     * reachable to its requester; the controller then enforces the requesting-user match
     * (owner gets 403, a stranger outside both scopes gets 404 — no existence oracle).
     */
    public function getForAccess(string $id, string $userId): ?array
    {
        $stmt = $this->mysql->prepare("
            SELECT * FROM desktop_flow_runs WHERE id = :id AND (requesting_user_id = :u OR owner_user_id = :o)
        ");
        $stmt->execute(['id' => $id, 'u' => $userId, 'o' => $userId]);
        $row = $stmt->fetch();
        return $row ? $this->format($row) : null;
    }

    /** Lightweight status read for the SSE loop's terminal detection. */
    public function getStatus(string $id, string $ownerUserId): ?string
    {
        $stmt = $this->mysql->prepare("SELECT status FROM desktop_flow_runs WHERE id = :id AND owner_user_id = :o");
        $stmt->execute(['id' => $id, 'o' => $ownerUserId]);
        $status = $stmt->fetchColumn();
        return $status === false ? null : (string) $status;
    }

    /**
     * Live queue position (plan §5.2: computed at read, never stored): the number of pending,
     * non-expired runs AHEAD of this one for the same owner + target, in the same FIFO
     * order listPending serves (created_at, id). 0 for a non-pending run; null if unknown.
     */
    public function queuePosition(string $id, string $ownerUserId): ?int
    {
        $stmt = $this->mysql->prepare("SELECT created_at, target_instance_id, status FROM desktop_flow_runs WHERE id = :id AND owner_user_id = :o");
        $stmt->execute(['id' => $id, 'o' => $ownerUserId]);
        $row = $stmt->fetch();
        if (!$row) {
            return null;
        }
        if (($row['status'] ?? '') !== 'pending') {
            return 0;
        }
        $pos = $this->mysql->prepare("
            SELECT COUNT(*) FROM desktop_flow_runs
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
     * Pending, non-expired runs for the owner's runtime, oldest first (FIFO). Sweeps stale
     * rows to 'expired' first. Visibility mirrors DesktopAiRelayService: a targeted run is
     * visible ONLY to its target instance; untargeted rows are visible to every poller
     * (legacy fan-out); a poller that doesn't identify itself sees only untargeted rows.
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
            // Composite (created_at, id) cursor (audit FL-06) — see DesktopCommandService::listPending.
            $cur = $this->mysql->prepare('SELECT created_at FROM desktop_flow_runs WHERE id = :since AND owner_user_id = :o2');
            $cur->execute(['since' => $sinceId, 'o2' => $ownerUserId]);
            $cursorCreatedAt = $cur->fetchColumn();
            if ($cursorCreatedAt !== false && $cursorCreatedAt !== null) {
                $where .= " AND (created_at > :cts OR (created_at = :cts2 AND id > :cid))";
                $params['cts'] = $cursorCreatedAt;
                $params['cts2'] = $cursorCreatedAt;
                $params['cid'] = $sinceId;
            }
        }
        $stmt = $this->mysql->prepare("SELECT * FROM desktop_flow_runs WHERE {$where} ORDER BY created_at ASC, id ASC LIMIT {$limit}");
        $stmt->execute($params);
        return array_map([$this, 'format'], $stmt->fetchAll());
    }

    /**
     * Long-poll: return pending runs as soon as any exist, or after up to $waitMs (capped
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
     * Claim a pending run (pending→claimed) exactly-once AND single-flight per target
     * (plan §5.2): ONE atomic UPDATE that fails when the row is no longer pending, when the
     * claiming instance isn't the target, OR when a claimed/streaming sibling already occupies
     * the lane. Returns the claimed run; null when it doesn't exist; throws
     * \RuntimeException('already_claimed'|'targeted_elsewhere'|'lane_busy') on the conflicts
     * (→ 409; lane_busy tells the desktop another run is in flight — try again later).
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

        // Only a still-pending, non-expired run can be claimed — and only by its TARGET
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
            UPDATE desktop_flow_runs AS r
            SET r.status = 'claimed', r.claimed_by = :cb, r.claimed_at = NOW()
            WHERE r.id = :id AND r.owner_user_id = :o AND r.status = 'pending' AND r.expires_at > NOW(){$targetSql}
              AND NOT EXISTS (
                  SELECT 1 FROM (
                      SELECT s.target_instance_id AS busy_target
                      FROM desktop_flow_runs s
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
                FROM desktop_flow_runs WHERE id = :id AND owner_user_id = :o
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
                // as already_claimed, matching the AI lane's 409 wording.)
                throw new \RuntimeException('lane_busy');
            }
            throw new \RuntimeException('already_claimed');
        }
        return $this->get($id, $ownerUserId);
    }

    /**
     * Append a sealed progress frame (desktop → browser) to a claimed/streaming run. Claimant-
     * bound like complete(): only the instance that claimed the run may stream for it.
     * The first frame transitions claimed→streaming; every append refreshes claimed_at,
     * which doubles as the lane's activity anchor for expireStale() (a long flow run stays
     * alive while it keeps producing).
     *
     * @return array{seq: int, status: string}
     * @throws \InvalidArgumentException on invalid payload
     * @throws \RuntimeException 'not_found'|'not_claimed'|'claimed_elsewhere' on state/claimant conflicts
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
                SELECT status, claimed_by FROM desktop_flow_runs
                WHERE id = :id AND owner_user_id = :o FOR UPDATE
            ");
            $lock->execute(['id' => $id, 'o' => $ownerUserId]);
            $row = $lock->fetch();
            if (!$row) {
                $this->mysql->rollBack();
                throw new \RuntimeException('not_found');
            }
            // Claimant binding is ALWAYS enforced (audit FL-01): an identity-claimed run may
            // only be streamed to by that identity — an anonymous append no longer bypasses.
            if (
                in_array($row['status'] ?? '', ['claimed', 'streaming'], true)
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
                UPDATE desktop_flow_runs SET status = 'streaming', claimed_at = NOW() WHERE id = :id
            ")->execute(['id' => $id]);
            $insert = $this->mysql->prepare("
                INSERT INTO desktop_flow_run_frames (request_id, envelope) VALUES (:id, :env)
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
     * Web-side read of the sealed progress frames with seq > $since, oldest first.
     * Requesting-user enforcement happens in the controller before this is called.
     * @return array[] rows of {seq, envelope(base64)}
     */
    public function fetchOutput(string $id, string $ownerUserId, int $since, int $limit = 200): array
    {
        // The owner scope keeps a guessed id from reading another tenant's stream even if a
        // controller check is ever lost; frames carry no owner column of their own.
        $stmt = $this->mysql->prepare("SELECT id FROM desktop_flow_runs WHERE id = :id AND owner_user_id = :o");
        $stmt->execute(['id' => $id, 'o' => $ownerUserId]);
        if (!$stmt->fetchColumn()) {
            return [];
        }
        $limit = max(1, min(500, $limit));
        $stmt = $this->mysql->prepare("
            SELECT seq, envelope FROM desktop_flow_run_frames
            WHERE request_id = :id AND seq > :since
            ORDER BY seq ASC LIMIT {$limit}
        ");
        $stmt->execute(['id' => $id, 'since' => max(0, $since)]);
        $frames = [];
        foreach ($stmt->fetchAll() as $row) {
            $frames[] = [
                'seq' => (int) $row['seq'],
                'envelope' => base64_encode((string) $row['envelope']),
            ];
        }
        return $frames;
    }

    /**
     * Complete a claimed run (claimed|streaming→done|failed), claimant-bound. Stores the sealed
     * result envelope (if any) and PURGES the request envelope + progress frames (plan §7: the
     * backend keeps sealed bodies only for the run's lifetime). The RESULT envelope survives
     * until the requester reads the run row once (consumeResultEnvelope) — a flow run's result
     * must be retrievable after completion, unlike a chat request's.
     * Returns the updated run; null when not found; throws
     * \RuntimeException('not_claimed'|'claimed_elsewhere') on conflicts (→ 409).
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

        $resultBytes = null;
        if (isset($data['resultEnvelope']) && $data['resultEnvelope'] !== null && $data['resultEnvelope'] !== '') {
            if (!is_string($data['resultEnvelope'])) {
                throw new \InvalidArgumentException('resultEnvelope must be a base64 sealed result');
            }
            $decoded = base64_decode($data['resultEnvelope'], true);
            if ($decoded === false || $decoded === '' || strlen($decoded) > self::MAX_RESULT_BYTES) {
                throw new \InvalidArgumentException('resultEnvelope exceeds the ' . self::MAX_RESULT_BYTES . '-byte limit');
            }
            $resultBytes = $decoded;
        }

        // Claimant binding is ALWAYS enforced (audit FL-01, same rule as the AI lane): an
        // identity-claimed run may only be completed by that identity — omitting instanceId
        // no longer bypasses. The envelope is nulled by the same UPDATE so terminal rows
        // never retain the request body.
        $params = ['s' => $status, 'result' => $resultBytes, 'id' => $id, 'o' => $ownerUserId, 'cb1' => $instanceId, 'cb2' => $instanceId];

        $this->mysql->beginTransaction();
        try {
            $stmt = $this->mysql->prepare("
                UPDATE desktop_flow_runs
                SET status = :s, envelope = NULL, result_envelope = :result, finished_at = NOW()
                WHERE id = :id AND owner_user_id = :o AND status IN ('claimed', 'streaming')
                  AND (claimed_by IS NULL OR (:cb1 IS NOT NULL AND claimed_by = :cb2))
            ");
            $stmt->execute($params);
            if ($stmt->rowCount() === 0) {
                $this->mysql->rollBack();
                $existing = $this->get($id, $ownerUserId);
                if ($existing === null) {
                    return null;
                }
                if (
                    in_array($existing['status'] ?? '', ['claimed', 'streaming'], true)
                    && ($existing['claimedBy'] ?? null) !== null
                    && $existing['claimedBy'] !== $instanceId
                ) {
                    throw new \RuntimeException('claimed_elsewhere');
                }
                throw new \RuntimeException('not_claimed');
            }
            $this->mysql->prepare("DELETE FROM desktop_flow_run_frames WHERE request_id = :id")->execute(['id' => $id]);
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
     * Read-once result retrieval (the flow lane's E2E result design, see the class docblock):
     * returns the sealed result envelope (base64) of a terminal run and purges it in the same
     * transaction — the FIRST reader gets the result, every later reader gets null. Returns
     * null when the run has no stored result (not finished, already consumed, or completed
     * without one).
     */
    public function consumeResultEnvelope(string $id, string $ownerUserId): ?string
    {
        $this->mysql->beginTransaction();
        try {
            $lock = $this->mysql->prepare("
                SELECT result_envelope FROM desktop_flow_runs
                WHERE id = :id AND owner_user_id = :o AND status IN ('done', 'failed') FOR UPDATE
            ");
            $lock->execute(['id' => $id, 'o' => $ownerUserId]);
            $row = $lock->fetch();
            if (!$row || $row['result_envelope'] === null) {
                $this->mysql->commit();
                return null;
            }
            $this->mysql->prepare("
                UPDATE desktop_flow_runs SET result_envelope = NULL WHERE id = :id
            ")->execute(['id' => $id]);
            $this->mysql->commit();
            return base64_encode((string) $row['result_envelope']);
        } catch (\Throwable $e) {
            if ($this->mysql->inTransaction()) {
                $this->mysql->rollBack();
            }
            throw $e;
        }
    }

    /**
     * Sweep stale rows (opportunistic GC, owner-scoped when polled; fails soft like the AI lane).
     *
     * Three branches:
     *   - 'pending' rows past their enqueue-anchored expires_at (nothing claimed them in time)
     *     → 'expired', all sealed content purged;
     *   - 'claimed'/'streaming' rows whose claimed_at — refreshed on every appended frame, so
     *     it tracks lane ACTIVITY, not just the claim moment — is older than
     *     CLAIMED_STALE_SECONDS → 'expired', all sealed content purged. A silently-crashed
     *     desktop's claim can't hold the single flight hostage, while a run that keeps
     *     streaming frames is never reaped;
     *   - terminal rows whose unread result envelope is older than RESULT_RETENTION_SECONDS
     *     → the result is purged (read-once GC; the routing row itself stays for history).
     */
    public function expireStale(?string $ownerUserId = null): int
    {
        $claimedCutoff = self::CLAIMED_STALE_SECONDS; // int class constant, safe to interpolate
        $resultCutoff = self::RESULT_RETENTION_SECONDS;
        $ownerSql = $ownerUserId !== null ? ' AND owner_user_id = :o' : '';
        $params = $ownerUserId !== null ? ['o' => $ownerUserId] : [];
        try {
            $this->mysql->beginTransaction();
            $select = $this->mysql->prepare("
                SELECT id FROM desktop_flow_runs
                WHERE (status = 'pending' AND expires_at <= NOW())
                   OR (status IN ('claimed', 'streaming') AND claimed_at IS NOT NULL
                       AND claimed_at < (NOW() - INTERVAL {$claimedCutoff} SECOND))
                   {$ownerSql}
            ");
            $select->execute($params);
            $ids = $select->fetchAll(PDO::FETCH_COLUMN);
            $reaped = 0;
            if ($ids !== []) {
                $quoted = implode(',', array_map(fn ($id) => $this->mysql->quote((string) $id), $ids));
                $this->mysql->exec("UPDATE desktop_flow_runs SET status = 'expired', envelope = NULL, result_envelope = NULL, finished_at = NOW() WHERE id IN ({$quoted})");
                $this->mysql->exec("DELETE FROM desktop_flow_run_frames WHERE request_id IN ({$quoted})");
                $reaped = count($ids);
            }
            $purge = $this->mysql->prepare("
                UPDATE desktop_flow_runs SET result_envelope = NULL
                WHERE status IN ('done', 'failed') AND result_envelope IS NOT NULL
                  AND finished_at IS NOT NULL AND finished_at < (NOW() - INTERVAL {$resultCutoff} SECOND)
                  {$ownerSql}
            ");
            $purge->execute($params);
            $this->mysql->commit();
            return $reaped;
        } catch (\Throwable $e) {
            if ($this->mysql->inTransaction()) {
                $this->mysql->rollBack();
            }
            return 0;
        }
    }

    // ── Internals ──

    /** Non-terminal lane occupancy for one requesting user (any target). */
    private function countInFlightForUser(string $ownerUserId, string $requestingUserId): int
    {
        $stmt = $this->mysql->prepare("
            SELECT COUNT(*) FROM desktop_flow_runs
            WHERE owner_user_id = :o AND requesting_user_id = :u AND status IN ('pending', 'claimed', 'streaming')
        ");
        $stmt->execute(['o' => $ownerUserId, 'u' => $requestingUserId]);
        return (int) $stmt->fetchColumn();
    }

    /** Non-terminal lane occupancy for one target desktop (NULL = the untargeted pool). */
    private function countInFlightForTarget(string $ownerUserId, ?string $targetInstanceId): int
    {
        $stmt = $this->mysql->prepare("
            SELECT COUNT(*) FROM desktop_flow_runs
            WHERE owner_user_id = :o AND status IN ('pending', 'claimed', 'streaming')
              AND target_instance_id <=> :t
        ");
        $stmt->execute(['o' => $ownerUserId, 't' => $targetInstanceId]);
        return (int) $stmt->fetchColumn();
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
            'flowId' => $row['flow_id'],
            'ephPub' => $row['eph_pub'],
            'envelope' => $row['envelope'] !== null ? base64_encode((string) $row['envelope']) : null,
            'resultAvailable' => $row['result_envelope'] !== null,
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

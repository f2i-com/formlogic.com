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
 *   - single-flight per target and lane: claim() is ONE atomic UPDATE guarded by NOT EXISTS
 *     (claimed|streaming sibling for the same target in the same lane). A picture (`image`)
 *     has a lane of its own, so a desktop holds one picture and one request of any other kind;
 *   - App AI's turns (SOURCE_APP_AI) keep their own limits and take none of the requester's;
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
    /** A request its own desktop has left silent this long is let go when it claims the next. */
    public const ABANDONED_SECONDS = 30;
    /**
     * A picture is let go after this much silence instead (App AI, docs/HOSTED_APPS.md): drawing one
     * takes a minute or more, OAIY sends a progress frame about every 5 seconds (15 before contract
     * §0.13), and gives up on its own after 240.
     */
    public const ABANDONED_PICTURE_SECONDS = 300;
    /**
     * The kind of a picture request. A desktop holds one of these beside one request of any other
     * kind: the claim's single flight is per target AND per lane, so a chat is never held up by a
     * picture being drawn.
     */
    public const PICTURE_KIND = 'image';
    /**
     * A request queued by App AI's worker (AppAiWorker) rather than by a person: it keeps its own
     * limits, so it takes none of the requester's two places. Only the server sets it.
     */
    public const SOURCE_APP_AI = 'app-ai';

    /** Sealed OUT frames of a terminal request survive this long so the reply stream can drain. */
    public const FRAME_GRACE_SECONDS = 60;
    /** AI-lane caps (plan §5.2). */
    public const MAX_IN_FLIGHT_PER_USER = 2;
    public const MAX_IN_FLIGHT_PER_TARGET = 8;
    public const MAX_ENVELOPE_BYTES = 262144;    // 256 KiB sealed request envelope
    public const MAX_FRAME_BYTES = 4194304;      // 4 MiB per sealed frame
    public const MAX_REQUEST_BYTES = 67108864;   // 64 MiB across one request's frames, each way
    public const MAX_KIND = 32;
    public const MAX_PROVIDER_ID = 128;
    public const MAX_IDEMPOTENCY_KEY = 255;

    /** Terminal statuses a desktop may complete a claimed request with. */
    public const COMPLETE_STATUSES = ['done', 'failed'];

    /** Long-poll ceiling: a single pending request blocks at most 25s before returning empty. */
    public const MAX_WAIT_MS = 25000;
    private const POLL_INTERVAL_MS = 500;
    /**
     * A held long-poll sweeps (expiry, and the purge of graced frames that rides it) once as it
     * starts and then at most this often, not on every POLL_INTERVAL_MS round. Delivery never
     * waits on it: the read filters `expires_at > NOW()` itself. See
     * DesktopCommandService::SWEEP_INTERVAL_SECONDS.
     */
    public const SWEEP_INTERVAL_SECONDS = 5.0;

    /**
     * Whether a row may go to its owner's computer: always when the owner asked, and a member's turn
     * (the site's AI and camera checks, SiteDesktopAi) only while the owner is an administrator.
     * Asked as a turn is listed and claimed, so a turn queued before an administrator's rights were
     * taken away is never handed to their computer after (SiteAiDesktopSettings::ownerIsAdmin).
     * %s is the table's alias.
     */
    private const SERVED_SQL = '(%1$s.requesting_user_id = %1$s.owner_user_id OR EXISTS (SELECT 1 FROM users a WHERE a.id = %1$s.owner_user_id AND a.is_admin = 1))';

    /** Same shape DesktopCommandService enforces for desktop instance ids. */
    private const INSTANCE_ID_PATTERN = '/^[A-Za-z0-9._-]+$/';
    private const MAX_INSTANCE_ID = 128;

    private PDO $mysql;

    public function __construct(MySQLConnection $mysql, private readonly float $sweepIntervalSeconds = self::SWEEP_INTERVAL_SECONDS, private readonly int $maxRequestBytes = self::MAX_REQUEST_BYTES)
    {
        $this->mysql = $mysql->getConnection();
    }

    /**
     * Enqueue a sealed AI request for the owner's desktop. Reserve-first on idempotency_key:
     * a duplicate returns the existing row (created=false). status 'pending', expires 5 min out.
     *
     * @return array{request: array, created: bool}
     * @throws \InvalidArgumentException on invalid payload / foreign idempotency-key reuse
     * @throws \RuntimeException 'queue_full_user'|'queue_full_desktop'|'queue_full_lane' on a tripped lane cap
     *
     * $source: SOURCE_APP_AI for App AI's worker, which is not held to the requester's own cap; null
     * for everything else. A separate argument, never read from $data, which a browser writes.
     *
     * $laneCap: how many turns the target may have waiting or running in this turn's lane (the
     * picture lane, or the other), for a caller that keeps a smaller cap of its own (SiteDesktopAi).
     * It is counted with the others, under the same lock, so two turns queued at once cannot both
     * take its last place.
     */
    public function enqueue(string $ownerUserId, string $requestingUserId, array $data, ?string $source = null, ?int $laneCap = null): array
    {
        if ($source !== null && $source !== self::SOURCE_APP_AI) {
            throw new \InvalidArgumentException('Unknown request source');
        }
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
            if ($source !== self::SOURCE_APP_AI && $this->countInFlightForUser($ownerUserId, $requestingUserId) >= self::MAX_IN_FLIGHT_PER_USER) {
                throw new \RuntimeException('queue_full_user');
            }
            if ($this->countInFlightForTarget($ownerUserId, $targetInstanceId) >= self::MAX_IN_FLIGHT_PER_TARGET) {
                throw new \RuntimeException('queue_full_desktop');
            }
            if ($laneCap !== null && $this->countInFlightForTarget($ownerUserId, $targetInstanceId, $kind === self::PICTURE_KIND) >= $laneCap) {
                throw new \RuntimeException('queue_full_lane');
            }

            $stmt = $this->mysql->prepare("
                INSERT INTO desktop_ai_requests
                    (id, owner_user_id, requesting_user_id, target_instance_id, provider_id, kind,
                     eph_pub, envelope, status, idempotency_key, expires_at, source)
                VALUES
                    (:id, :owner, :req, :target, :provider, :kind, :eph, :env, 'pending', :key, :exp, :source)
            ");
            $stmt->execute([
                'id' => $id,
                'owner' => $ownerUserId,
                'req' => $requestingUserId,
                'target' => $targetInstanceId,
                'provider' => $providerId,
                'kind' => $kind,
                'source' => $source,
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
            // leak a foreign request id under a reused key). The lookup carries the same
            // owner scope as the unique index (audit FL-08).
            $find = $this->mysql->prepare("SELECT * FROM desktop_ai_requests WHERE owner_user_id = :o AND idempotency_key = :k LIMIT 1");
            $find->execute(['o' => $ownerUserId, 'k' => $idempotencyKey]);
            $row = $find->fetch();
            if (!$row) {
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
     * Where a request stands, for a server-side reader that waits on it without holding a worker
     * (SiteDesktopAi::collect): its status, whether a computer ever took it (`taken`: one let go
     * unclaimed is a busy or absent computer, not a failing one), and its age in seconds, by the
     * database's own clock, never PHP's. Also its `kind` and the public key it was sealed with
     * (`ephPub`, base64), by which a reader can tell it is the turn it asked for. Null when it is not
     * $ownerUserId's.
     *
     * @return array{status: string, taken: bool, age: int, kind: string, ephPub: string}|null
     */
    public function progress(string $id, string $ownerUserId): ?array
    {
        $stmt = $this->mysql->prepare("
            SELECT status, claimed_at IS NOT NULL AS taken, TIMESTAMPDIFF(SECOND, created_at, NOW()) AS age, kind, eph_pub
            FROM desktop_ai_requests WHERE id = :id AND owner_user_id = :o
        ");
        $stmt->execute(['id' => $id, 'o' => $ownerUserId]);
        $row = $stmt->fetch();
        return $row ? ['status' => (string) $row['status'], 'taken' => (bool) $row['taken'], 'age' => (int) $row['age'], 'kind' => (string) $row['kind'], 'ephPub' => (string) $row['eph_pub']] : null;
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
        $served = sprintf(self::SERVED_SQL, 'desktop_ai_requests');
        $pos = $this->mysql->prepare("
            SELECT COUNT(*) FROM desktop_ai_requests
            WHERE owner_user_id = :o AND status = 'pending' AND expires_at > NOW() AND {$served}
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
        return $this->readPending($ownerUserId, $sinceId, $limit, $instanceId);
    }

    /**
     * The read half of listPending(): what this poller may see right now, without sweeping. A
     * row past its expires_at is never returned, swept or not.
     * @return array[]
     */
    private function readPending(string $ownerUserId, ?string $sinceId, int $limit, ?string $instanceId): array
    {
        $limit = max(1, min(200, $limit));

        $where = "owner_user_id = :o AND status = 'pending' AND expires_at > NOW() AND " . sprintf(self::SERVED_SQL, 'desktop_ai_requests');
        $params = ['o' => $ownerUserId];
        if ($instanceId !== null && $instanceId !== '') {
            $where .= " AND (target_instance_id IS NULL OR target_instance_id = :inst)";
            $params['inst'] = $instanceId;
        } else {
            $where .= " AND target_instance_id IS NULL";
        }
        if ($sinceId !== null && $sinceId !== '') {
            // Composite (created_at, id) cursor (audit FL-06) — see DesktopCommandService::listPending.
            $cur = $this->mysql->prepare('SELECT created_at FROM desktop_ai_requests WHERE id = :since AND owner_user_id = :o2');
            $cur->execute(['since' => $sinceId, 'o2' => $ownerUserId]);
            $cursorCreatedAt = $cur->fetchColumn();
            if ($cursorCreatedAt !== false && $cursorCreatedAt !== null) {
                $where .= " AND (created_at > :cts OR (created_at = :cts2 AND id > :cid))";
                $params['cts'] = $cursorCreatedAt;
                $params['cts2'] = $cursorCreatedAt;
                $params['cid'] = $sinceId;
            }
        }
        $stmt = $this->mysql->prepare("SELECT * FROM desktop_ai_requests WHERE {$where} ORDER BY created_at ASC, id ASC LIMIT {$limit}");
        $stmt->execute($params);
        return array_map([$this, 'format'], $stmt->fetchAll());
    }

    /** Seconds within which a lane poll does not write its time again: a computer polls about every 25. */
    public const POLLED_EVERY_SECONDS = 20;

    /**
     * The computer asked its AI lane for work: noted on its connection (`ai_polled_at`), which is what
     * App AI, the site's AI and camera checks call "online" (SiteAiDesktopSettings::online, AppAiService),
     * rather than its heartbeat, which a computer sends whether or not anything on it takes AI requests.
     * Written at most every POLLED_EVERY_SECONDS; never fails the poll.
     */
    public function notePolled(string $ownerUserId, string $instanceId): void
    {
        try {
            $this->mysql->prepare(
                'UPDATE desktop_connections SET ai_polled_at = NOW() WHERE owner_user_id = ? AND desktop_instance_id = ? '
                . 'AND (ai_polled_at IS NULL OR ai_polled_at < (NOW() - INTERVAL ' . self::POLLED_EVERY_SECONDS . ' SECOND))'
            )->execute([$ownerUserId, $instanceId]);
        } catch (\Throwable $e) {
            error_log('Desktop AI lane: when the computer asked for work was not noted: ' . get_class($e) . ' ' . $e->getMessage());
        }
    }

    /**
     * Long-poll: return pending requests as soon as one of them could be claimed, or after up to
     * $waitMs (capped at MAX_WAIT_MS) with whatever is pending. $waitMs=0 returns immediately (the
     * default the tests exercise).
     *
     * A request waiting for a lane its computer is busy in (claimable) is not a reason to answer at
     * once: the computer could only be refused it (lane_busy), and would poll again within a couple
     * of seconds, for as long as its turn runs. It is held instead, and answered the moment the lane
     * comes free.
     *
     * Every poll sweeps once as it starts, whatever its wait, and a held one again only when
     * SWEEP_INTERVAL_SECONDS have passed — not on every round (see that constant).
     * @return array[]
     */
    public function pollPending(string $ownerUserId, ?string $sinceId, int $waitMs, int $limit = 50, ?string $instanceId = null): array
    {
        if ($instanceId !== null) $this->notePolled($ownerUserId, $instanceId);
        $waitMs = LongPollBudget::milliseconds($waitMs, self::MAX_WAIT_MS);
        $deadline = microtime(true) + ($waitMs / 1000);
        $sweepDue = 0.0;
        do {
            if (microtime(true) >= $sweepDue) {
                $this->expireStale($ownerUserId);
                $sweepDue = microtime(true) + $this->sweepIntervalSeconds;
            }
            $pending = $this->readPending($ownerUserId, $sinceId, $limit, $instanceId);
            if ($waitMs === 0 || ($pending !== [] && $this->claimable($ownerUserId, $pending, $instanceId))) {
                return $pending;
            }
            if (microtime(true) >= $deadline) {
                return $pending;
            }
            usleep(self::POLL_INTERVAL_MS * 1000);
        } while (microtime(true) < $deadline);
        return $this->readPending($ownerUserId, $sinceId, $limit, $instanceId);
    }

    /**
     * Whether $instanceId could claim any of $pending now, by claim()'s own rule: no claimed or
     * streaming request holds that request's lane on its target, unless it is one this computer
     * left silent long enough to be let go as it claims the next (releaseAbandoned). Should the
     * check itself fail, the answer is yes, and the poll answers as it did before it held.
     *
     * @param array[] $pending
     */
    private function claimable(string $ownerUserId, array $pending, ?string $instanceId): bool
    {
        $ids = array_values(array_map(static fn (array $row): string => (string) $row['requestId'], $pending));
        $marks = implode(',', array_fill(0, count($ids), '?'));
        // int class constants, safe to interpolate
        $picture = self::ABANDONED_PICTURE_SECONDS;
        $other = self::ABANDONED_SECONDS;
        try {
            $stmt = $this->mysql->prepare("
                SELECT 1 FROM desktop_ai_requests r
                WHERE r.owner_user_id = ? AND r.id IN ({$marks})
                  AND NOT EXISTS (
                      SELECT 1 FROM desktop_ai_requests s
                      WHERE s.owner_user_id = r.owner_user_id AND s.status IN ('claimed', 'streaming')
                        AND s.target_instance_id <=> r.target_instance_id
                        AND (s.kind = 'image') = (r.kind = 'image')
                        AND NOT (s.claimed_by <=> ? AND s.claimed_at < (NOW() - INTERVAL IF(s.kind = 'image', {$picture}, {$other}) SECOND))
                  )
                LIMIT 1
            ");
            $stmt->execute([$ownerUserId, ...$ids, $instanceId]);
            return $stmt->fetchColumn() !== false;
        } catch (\PDOException $e) {
            error_log('Desktop AI lane: whether a waiting request could be claimed was not read, so the poll answers at once: ' . $e->getMessage());
            return true;
        }
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
            // A computer taking work is asking its lane for it (notePolled), as a poll is.
            $this->notePolled($ownerUserId, $instanceId);
        }

        // Only a still-pending, non-expired request can be claimed — and only by its TARGET
        // when it has one. The NOT EXISTS guard is the single-flight rule: no claimed or
        // streaming sibling for the same target (NULL-safe compare groups untargeted rows) in
        // the same lane: a picture's lane is its own, beside every other kind's (PICTURE_KIND).
        // The sibling probe reads through a derived table because MySQL forbids selecting
        // from the UPDATE target directly.
        $targetSql = $instanceId !== null
            ? ' AND (r.target_instance_id IS NULL OR r.target_instance_id = :ti)'
            : ' AND r.target_instance_id IS NULL';
        $params = ['cb' => $instanceId, 'id' => $id, 'o' => $ownerUserId, 'o2' => $ownerUserId];
        if ($instanceId !== null) {
            $params['ti'] = $instanceId;
        }
        $served = sprintf(self::SERVED_SQL, 'r');
        $stmt = $this->mysql->prepare("
            UPDATE desktop_ai_requests AS r
            SET r.status = 'claimed', r.claimed_by = :cb, r.claimed_at = NOW()
            WHERE r.id = :id AND r.owner_user_id = :o AND r.status = 'pending' AND r.expires_at > NOW(){$targetSql}
              AND {$served}
              AND NOT EXISTS (
                  SELECT 1 FROM (
                      SELECT s.target_instance_id AS busy_target, (s.kind = 'image') AS busy_picture
                      FROM desktop_ai_requests s
                      WHERE s.owner_user_id = :o2 AND s.status IN ('claimed', 'streaming')
                  ) AS busy
                  WHERE busy.busy_target <=> r.target_instance_id AND busy.busy_picture = (r.kind = 'image')
              )
        ");
        $stmt->execute($params);

        if ($stmt->rowCount() === 0) {
            // Expiry is computed in SQL (expires_at > NOW()), never by comparing a MySQL
            // timestamp against PHP's clock — the two timezones need not agree.
            $check = $this->mysql->prepare("
                SELECT r.status, r.kind, r.target_instance_id, (r.expires_at > NOW()) AS still_valid, {$served} AS served
                FROM desktop_ai_requests r WHERE r.id = :id AND r.owner_user_id = :o
            ");
            $check->execute(['id' => $id, 'o' => $ownerUserId]);
            $existing = $check->fetch();
            if (!$existing) {
                return null;
            }
            if ((int) ($existing['served'] ?? 1) === 0) {
                // A member's turn for a computer whose owner is no longer an administrator: not this
                // computer's to take, as if another had.
                throw new \RuntimeException('already_claimed');
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
                if ($instanceId !== null && $this->releaseAbandoned($ownerUserId, $instanceId, ($existing['kind'] ?? null) === self::PICTURE_KIND)) {
                    return $this->claim($id, $ownerUserId, $data);
                }
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
        // A computer writing a turn's answer is at work on its lane (notePolled): one that does not poll while it
        // writes (OAIY before 0.1.14 answered inside its poll loop) stays online through a long answer. Before the
        // frame's own transaction, as a statement of its own.
        if ($instanceId !== null && $instanceId !== '') $this->notePolled($ownerUserId, $instanceId);

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
            // Claimant binding is ALWAYS enforced (audit FL-01): a request claimed WITH an
            // identity may only be streamed to by that identity — an anonymous append no
            // longer bypasses the check.
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
                // Cancelled by whoever asked (cancel()), or let go as too old or too silent
                // (expireStale, releaseAbandoned): the computer that held it is told so, for it to
                // stop the work (contract §0.13). Any other state is what it always was.
                throw new \RuntimeException(self::wasLetGo($row['status'] ?? null, $row['claimed_by'] ?? null, $instanceId) ? 'cancelled' : 'not_claimed');
            }
            $this->assertFrameFits($id, 'out', strlen($envelopeBytes));
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
     * Frames are held in MySQL, which every account shares, until the request ends, and a request
     * that keeps producing never ends by itself. Refusing one leaves claimed_at alone, so a
     * desktop that goes on past this is reaped as stale.
     */
    private function assertFrameFits(string $id, string $direction, int $bytes): void
    {
        $held = $this->mysql->prepare('SELECT COALESCE(SUM(LENGTH(envelope)), 0) FROM desktop_ai_frames WHERE request_id = :id AND direction = :d');
        $held->execute(['id' => $id, 'd' => $direction]);
        if ((int) $held->fetchColumn() + $bytes > $this->maxRequestBytes) {
            throw new \InvalidArgumentException('This request has reached its limit of ' . $this->maxRequestBytes . ' bytes');
        }
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
        $this->assertFrameFits($id, 'in', strlen($envelopeBytes));
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
        // Claimant binding is ALWAYS enforced (audit FL-01): an identity-claimed request's
        // input channel is readable only by that identity — an anonymous read no longer
        // bypasses the check. Legacy identity-less claims stay readable by the owner's key.
        if (($existing['claimedBy'] ?? null) !== null) {
            if ($existing['claimedBy'] !== $instanceId) {
                throw new \RuntimeException('claimed_elsewhere');
            }
        } elseif ($instanceId !== null) {
            throw new \RuntimeException('not_claimed');
        }
        return [
            'frames' => $this->fetchFrames($id, 'in', $since),
            'status' => (string) $existing['status'],
        ];
    }

    /**
     * Web-side read of OUT frames (the sealed reply stream) with seq > $since, oldest first.
     * Requesting-user enforcement happens in the controller before this is called. With
     * $maxFrameBytes, a frame larger than that comes back with a null envelope, its bytes never
     * read out of MySQL: a server-side reader (SiteDesktopAi) takes no frame larger than OAIY sends,
     * where the lane keeps up to MAX_FRAME_BYTES for browsers.
     * @return array[] rows of {seq, envelope(base64)|null}
     */
    public function fetchOutput(string $id, string $ownerUserId, int $since, int $limit = 200, ?int $maxFrameBytes = null): array
    {
        // The owner scope keeps a guessed id from reading another tenant's stream even if a
        // controller check is ever lost; frames carry no owner column of their own.
        $stmt = $this->mysql->prepare("SELECT id FROM desktop_ai_requests WHERE id = :id AND owner_user_id = :o");
        $stmt->execute(['id' => $id, 'o' => $ownerUserId]);
        if (!$stmt->fetchColumn()) {
            return [];
        }
        return $this->fetchFrames($id, 'out', $since, $limit, $maxFrameBytes);
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

        // Claimant binding is ALWAYS enforced (audit FL-01, same rule as
        // DesktopCommandService): an identity-claimed request may only be completed by
        // that identity — omitting instanceId no longer bypasses the check. The envelope
        // is nulled by the same UPDATE so terminal rows never retain sealed content.
        $params = ['s' => $status, 'id' => $id, 'o' => $ownerUserId, 'cb1' => $instanceId, 'cb2' => $instanceId];

        $this->mysql->beginTransaction();
        try {
            $stmt = $this->mysql->prepare("
                UPDATE desktop_ai_requests
                SET status = :s, envelope = NULL, finished_at = NOW()
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
                // A request let go while the computer worked on it: told as its frames are.
                throw new \RuntimeException(self::wasLetGo($existing['status'] ?? null, $existing['claimedBy'] ?? null, $instanceId) ? 'cancelled' : 'not_claimed');
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
     * With no owner it sweeps everyone's rows, which bin/desktop-commands-cleanup.php does: the
     * only thing that reaches an owner who never polls again.
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
            // The two stale conditions are ONE parenthesised group so {$ownerSql} constrains both:
            // AND binds tighter than OR, and the unparenthesised form scoped only the claimed
            // branch, so every poll expired every tenant's overdue pending rows (and scanned the
            // whole table to find them).
            $select = $this->mysql->prepare("
                SELECT id FROM desktop_ai_requests
                WHERE ((status = 'pending' AND expires_at <= NOW())
                    OR (status IN ('claimed', 'streaming') AND claimed_at IS NOT NULL
                        AND claimed_at < (NOW() - INTERVAL {$claimedCutoff} SECOND)))
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
     * A desktop runs one turn at a time, so a desktop asking for the next has let go of any it
     * still holds: it was closed or crashed mid-turn, or never heard the reply to its claim. That
     * turn would otherwise hold the lane, and one of the person's two places, until
     * CLAIMED_STALE_SECONDS had passed. Only the same desktop, only in the lane it asks for
     * ($picture: the picture lane), and only after a silence: ABANDONED_SECONDS, or for a picture
     * ABANDONED_PICTURE_SECONDS. A desktop that did serve two at once is told lane_busy as it
     * always was.
     */
    private function releaseAbandoned(string $ownerUserId, string $instanceId, bool $picture): bool
    {
        // int class constants, safe to interpolate
        $quiet = $picture ? self::ABANDONED_PICTURE_SECONDS : self::ABANDONED_SECONDS;
        $lane = $picture ? "kind = 'image'" : "kind <> 'image'";
        $this->mysql->beginTransaction();
        try {
            $select = $this->mysql->prepare("
                SELECT id FROM desktop_ai_requests
                WHERE owner_user_id = :o AND claimed_by = :i AND status IN ('claimed', 'streaming') AND {$lane}
                  AND claimed_at < (NOW() - INTERVAL {$quiet} SECOND)
                FOR UPDATE
            ");
            $select->execute(['o' => $ownerUserId, 'i' => $instanceId]);
            $ids = $select->fetchAll(PDO::FETCH_COLUMN);
            if ($ids === []) {
                $this->mysql->commit();
                return false;
            }
            $quoted = implode(',', array_map(fn ($id) => $this->mysql->quote((string) $id), $ids));
            $this->mysql->exec("UPDATE desktop_ai_requests SET status = 'expired', envelope = NULL, finished_at = NOW() WHERE id IN ({$quoted})");
            $this->mysql->exec("DELETE FROM desktop_ai_frames WHERE request_id IN ({$quoted})");
            $this->mysql->commit();
            return true;
        } catch (\Throwable $e) {
            if ($this->mysql->inTransaction()) {
                $this->mysql->rollBack();
            }
            throw $e;
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

    /** Non-terminal lane occupancy for one requesting user (any target), App AI's own turns aside. */
    private function countInFlightForUser(string $ownerUserId, string $requestingUserId): int
    {
        $stmt = $this->mysql->prepare("
            SELECT COUNT(*) FROM desktop_ai_requests
            WHERE owner_user_id = :o AND requesting_user_id = :u AND status IN ('pending', 'claimed', 'streaming')
              AND NOT (source <=> 'app-ai')
        ");
        $stmt->execute(['o' => $ownerUserId, 'u' => $requestingUserId]);
        return (int) $stmt->fetchColumn();
    }

    /**
     * Turns waiting for or being served by one desktop (SiteDesktopAi keeps its own, smaller caps):
     * every kind, or with $picture only the picture lane (true) or only the other (false).
     */
    public function inFlightForTarget(string $ownerUserId, string $targetInstanceId, ?bool $picture = null): int
    {
        $this->expireStale($ownerUserId);
        return $this->countInFlightForTarget($ownerUserId, $targetInstanceId, $picture);
    }

    /**
     * A pending request its reader has given up on: expired now, so the desktop never spends its
     * one lane on a turn nobody waits for. A claimed one is left to finish. True when it was pending.
     */
    public function abandon(string $id, string $ownerUserId): bool
    {
        $stmt = $this->mysql->prepare("
            UPDATE desktop_ai_requests SET status = 'expired', envelope = NULL, finished_at = NOW()
            WHERE id = :id AND owner_user_id = :o AND status = 'pending'
        ");
        $stmt->execute(['id' => $id, 'o' => $ownerUserId]);
        return $stmt->rowCount() === 1;
    }

    /**
     * A request whoever asked no longer wants, whatever it is doing (App AI: its app cancelled the
     * job, the job ran out of time, or the answer ran past what is read): expired now, its sealed
     * content gone. A pending one is never handed out. A claimed or streaming one frees its lane at
     * once, and the computer still working on it is answered `cancelled` on its next frame
     * (appendFrame) and on its completion, for it to stop (contract §0.13). True when it was open.
     */
    public function cancel(string $id, string $ownerUserId): bool
    {
        return $this->cancelSaying($id, $ownerUserId) !== null;
    }

    /**
     * cancel(), saying what the request was doing as it was let go: 'pending' (no computer had taken
     * it, so nothing was asked of the AI), 'claimed' or 'streaming' (one was working on it), or null
     * (it was not open). Read under the row's lock: a claim, one atomic UPDATE of a pending row, waits
     * for it, and then finds the row expired, so a request said 'pending' here was never taken.
     */
    public function cancelSaying(string $id, string $ownerUserId): ?string
    {
        $this->mysql->beginTransaction();
        try {
            $read = $this->mysql->prepare('SELECT status FROM desktop_ai_requests WHERE id = :id AND owner_user_id = :o FOR UPDATE');
            $read->execute(['id' => $id, 'o' => $ownerUserId]);
            $was = $read->fetchColumn();
            $was = is_string($was) && in_array($was, ['pending', 'claimed', 'streaming'], true) ? $was : null;
            if ($was !== null) {
                $this->mysql->prepare("UPDATE desktop_ai_requests SET status = 'expired', envelope = NULL, finished_at = NOW() WHERE id = :id")->execute(['id' => $id]);
                $this->mysql->prepare('DELETE FROM desktop_ai_frames WHERE request_id = :id')->execute(['id' => $id]);
            }
            $this->mysql->commit();
            return $was;
        } catch (\Throwable $e) {
            if ($this->mysql->inTransaction()) {
                $this->mysql->rollBack();
            }
            throw $e;
        }
    }

    /**
     * Whether a request in $status was let go under the computer $instanceId that held it (or under
     * nobody: it was never claimed): cancelled, or expired as too old or too silent. Its frames and
     * its completion are then answered `cancelled`. A computer that never held it is not told.
     */
    private static function wasLetGo(?string $status, ?string $claimedBy, ?string $instanceId): bool
    {
        return $status === 'expired' && ($claimedBy === null || $claimedBy === $instanceId);
    }

    /** Non-terminal lane occupancy for one target desktop (NULL = the untargeted pool), of one lane or both. */
    private function countInFlightForTarget(string $ownerUserId, ?string $targetInstanceId, ?bool $picture = null): int
    {
        $lane = $picture === null ? '' : ($picture ? " AND kind = 'image'" : " AND kind <> 'image'");
        $stmt = $this->mysql->prepare("
            SELECT COUNT(*) FROM desktop_ai_requests
            WHERE owner_user_id = :o AND status IN ('pending', 'claimed', 'streaming')
              AND target_instance_id <=> :t{$lane}
        ");
        $stmt->execute(['o' => $ownerUserId, 't' => $targetInstanceId]);
        return (int) $stmt->fetchColumn();
    }

    /** @return array[] rows of {seq, envelope(base64)|null}: null for a frame past $maxFrameBytes */
    private function fetchFrames(string $requestId, string $direction, int $since, int $limit = 200, ?int $maxFrameBytes = null): array
    {
        $limit = max(1, min(500, $limit));
        // An int, safe to interpolate: a frame past it is named by its seq and never read.
        $envelope = $maxFrameBytes === null ? 'envelope' : 'CASE WHEN LENGTH(envelope) <= ' . max(1, $maxFrameBytes) . ' THEN envelope END AS envelope';
        $stmt = $this->mysql->prepare("
            SELECT seq, {$envelope} FROM desktop_ai_frames
            WHERE request_id = :id AND direction = :dir AND seq > :since
            ORDER BY seq ASC LIMIT {$limit}
        ");
        $stmt->execute(['id' => $requestId, 'dir' => $direction, 'since' => max(0, $since)]);
        $frames = [];
        foreach ($stmt->fetchAll() as $row) {
            $frames[] = [
                'seq' => (int) $row['seq'],
                'envelope' => $row['envelope'] === null ? null : base64_encode((string) $row['envelope']),
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

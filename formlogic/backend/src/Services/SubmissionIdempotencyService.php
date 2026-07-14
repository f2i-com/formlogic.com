<?php

declare(strict_types=1);

namespace FormLogic\Services;

use PDO;

/**
 * THE submission-idempotency ledger (audit FL-IDEM-001) — one implementation for the three
 * submission entry points (classic public, app runtime, external API) that previously kept
 * hand-copied helpers in each controller.
 *
 * Reserve-first pattern: the table's UNIQUE(scope..., idempotency_key) is the atomic gate.
 * Every reservation is a LEASE identified by the row's unique id, and complete/release only
 * ever touch the caller's OWN lease. Without that binding, a slow original request that lost
 * its reservation to a 600s stale takeover could still complete or delete the SUCCESSOR's
 * row (both predicates matched "the current pending row"), so the ledger recorded the wrong
 * response — or lost the reservation entirely and let a replay double-submit.
 *
 * Fail-open by design: idempotency is best-effort protection for retries; a ledger outage
 * must never block a real submission (the callers treat 'unavailable' as "submit without
 * idempotency", exactly like a request that sent no key).
 */
class SubmissionIdempotencyService
{
    /** The two ledgers and the scope columns each is keyed by (code-controlled, never input). */
    private const TABLES = [
        'form_submission_idempotency' => ['form_id'],
        'app_submission_idempotency' => ['app_id', 'form_id'],
    ];

    /** Same threshold the flow-run reclaim uses: a pending row older than this is abandoned. */
    public const STALE_TAKEOVER_SECONDS = 600;

    private ?PDO $mysql;

    public function __construct(?PDO $mysql)
    {
        $this->mysql = $mysql;
    }

    /**
     * Reserve (scope, key) before doing any work.
     *
     * @param array<string,string> $scope scope-column => value (must match the table's column set)
     * @return array{state:'owner', lease:string}
     *       | array{state:'existing', response_id:?string, payload_hash:string, status:string}
     *       | array{state:'unavailable'}
     */
    public function reserve(string $table, array $scope, ?string $userId, string $key, string $payloadHash): array
    {
        $cols = $this->scopeColumns($table, $scope);
        if ($this->mysql === null || $cols === null) {
            return ['state' => 'unavailable'];
        }
        $lease = $this->uuidV4();
        try {
            $scopeCols = implode(', ', $cols);
            $scopePlaceholders = implode(', ', array_map(static fn (string $c) => ':' . $c, $cols));
            $stmt = $this->mysql->prepare(
                "INSERT INTO {$table} (id, {$scopeCols}, user_id, idempotency_key, response_id, payload_hash, status, created_at)
                 VALUES (:id, {$scopePlaceholders}, :u, :k, NULL, :h, 'pending', NOW())"
            );
            $stmt->execute(['id' => $lease, 'u' => $userId, 'k' => $key, 'h' => $payloadHash] + $scope);
            return ['state' => 'owner', 'lease' => $lease];
        } catch (\PDOException $e) {
            // 23000 / MySQL 1062 = duplicate key → a row already exists for this key.
            $dup = $e->getCode() === '23000' || (isset($e->errorInfo[1]) && (int) $e->errorInfo[1] === 1062);
            if ($dup) {
                $existing = $this->find($table, $scope, $key);
                // If it vanished between the failed insert and this read (a racing release), fail open.
                return $existing ?? ['state' => 'unavailable'];
            }
            // Any other DB error: fail open — idempotency is best-effort, never block a real submit.
            return ['state' => 'unavailable'];
        } catch (\Throwable) {
            return ['state' => 'unavailable'];
        }
    }

    /**
     * Atomically take over an ABANDONED reservation (still 'pending' past the stale threshold):
     * the guarded DELETE is the race gate — of N concurrent retriers exactly one deletes the old
     * row, and only a successful delete attempts the re-reserve. Returns the NEW lease id when
     * this caller won, null otherwise.
     *
     * @param array<string,string> $scope
     */
    public function takeOver(string $table, array $scope, ?string $userId, string $key, string $payloadHash, int $staleSeconds = self::STALE_TAKEOVER_SECONDS): ?string
    {
        $cols = $this->scopeColumns($table, $scope);
        if ($this->mysql === null || $cols === null) {
            return null;
        }
        $staleSeconds = max(1, $staleSeconds);
        try {
            $where = implode(' AND ', array_map(static fn (string $c) => "{$c} = :{$c}", $cols));
            $del = $this->mysql->prepare(
                "DELETE FROM {$table}
                 WHERE {$where} AND idempotency_key = :k
                   AND status = 'pending' AND created_at < (NOW() - INTERVAL {$staleSeconds} SECOND)"
            );
            $del->execute(['k' => $key] + $scope);
            if ($del->rowCount() === 0) {
                return null;
            }
            $reserved = $this->reserve($table, $scope, $userId, $key, $payloadHash);
            return $reserved['state'] === 'owner' ? $reserved['lease'] : null;
        } catch (\Throwable) {
            // Takeover is best-effort; the caller falls back to the "still processing" response.
            return null;
        }
    }

    /**
     * Record the created response on OUR lease only. A slow original whose reservation was
     * taken over holds a lease id that no longer exists — its update matches nothing, so it
     * can never stamp its (duplicate) response over the successor's row.
     */
    public function complete(string $table, array $scope, string $key, string $lease, string $responseId): void
    {
        $cols = $this->scopeColumns($table, $scope);
        if ($this->mysql === null || $cols === null) {
            return;
        }
        try {
            $where = implode(' AND ', array_map(static fn (string $c) => "{$c} = :{$c}", $cols));
            $stmt = $this->mysql->prepare(
                "UPDATE {$table} SET response_id = :r, status = 'completed'
                 WHERE id = :lease AND {$where} AND idempotency_key = :k AND status = 'pending'"
            );
            $stmt->execute(['r' => $responseId, 'lease' => $lease, 'k' => $key] + $scope);
        } catch (\Throwable) {
            // ignore — the response is already persisted; a failed ledger update only risks a
            // future duplicate on replay, never data loss.
        }
    }

    /**
     * Release an unfulfilled reservation — OUR lease only, so a dispossessed original can
     * never delete the successor's in-flight reservation (which let a later replay run the
     * whole pipeline again and double-submit).
     */
    public function release(string $table, array $scope, string $key, string $lease): void
    {
        $cols = $this->scopeColumns($table, $scope);
        if ($this->mysql === null || $cols === null) {
            return;
        }
        try {
            $where = implode(' AND ', array_map(static fn (string $c) => "{$c} = :{$c}", $cols));
            $stmt = $this->mysql->prepare(
                "DELETE FROM {$table} WHERE id = :lease AND {$where} AND idempotency_key = :k AND status = 'pending'"
            );
            $stmt->execute(['lease' => $lease, 'k' => $key] + $scope);
        } catch (\Throwable) {
            // ignore
        }
    }

    /**
     * @param array<string,string> $scope
     * @return array{state:'existing', response_id:?string, payload_hash:string, status:string}|null
     */
    public function find(string $table, array $scope, string $key): ?array
    {
        $cols = $this->scopeColumns($table, $scope);
        if ($this->mysql === null || $cols === null) {
            return null;
        }
        try {
            $where = implode(' AND ', array_map(static fn (string $c) => "{$c} = :{$c}", $cols));
            $stmt = $this->mysql->prepare(
                "SELECT response_id, payload_hash, status FROM {$table}
                 WHERE {$where} AND idempotency_key = :k LIMIT 1"
            );
            $stmt->execute(['k' => $key] + $scope);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!is_array($row)) {
                return null;
            }
            return [
                'state' => 'existing',
                'response_id' => is_string($row['response_id'] ?? null) ? $row['response_id'] : null,
                'payload_hash' => (string) ($row['payload_hash'] ?? ''),
                'status' => (string) ($row['status'] ?? ''),
            ];
        } catch (\Throwable) {
            return null;
        }
    }

    /**
     * Validate the table is one of the two known ledgers and the scope covers exactly its
     * key columns (identifiers are interpolated into SQL, so both are strictly allowlisted).
     * @param array<string,string> $scope
     * @return string[]|null the table's scope columns, or null when invalid
     */
    private function scopeColumns(string $table, array $scope): ?array
    {
        $cols = self::TABLES[$table] ?? null;
        if ($cols === null) {
            return null;
        }
        $given = array_keys($scope);
        sort($given);
        $expected = $cols;
        sort($expected);
        return $given === $expected ? $cols : null;
    }

    private function uuidV4(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}

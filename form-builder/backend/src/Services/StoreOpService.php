<?php

declare(strict_types=1);

namespace FormLogic\Services;

use PDO;

/**
 * Durable cross-store operation ledger (audit FL-DATA-001).
 *
 * FormLogic mutations span up to three stores that cannot share a transaction: MySQL
 * metadata, the per-form SQLite database, and the uploads directory. A crash or disk
 * failure between stores previously left them silently disagreeing (the worst case: a
 * form's MySQL row deleted while its SQLite responses — PII — stayed on disk, with the
 * delete reported as success).
 *
 * A store_ops row is the durable record of a cross-store mutation IN FLIGHT: it is
 * written in the same MySQL transaction as the metadata change, and removed only once
 * every store has been verified to agree. A row that outlives its request therefore IS
 * the failure state — operator-visible (reconcile report / health check), retryable
 * (reconcile --fix, account-erasure resume, re-issued deletes), and owner-retaining
 * (account erasure refuses to drop the users row while the user has pending ops).
 *
 * Row existence = pending work. Completed ops are deleted, not archived — history
 * belongs to logs; the ledger stays small and every row demands action.
 */
class StoreOpService
{
    public function __construct(private PDO $mysql)
    {
    }

    /**
     * Record a cross-store operation. Call INSIDE the same MySQL transaction as the
     * metadata mutation it describes, so the intent commits (or rolls back) atomically
     * with the change it protects.
     *
     * @param array<string,mixed> $detail small JSON-serializable context for operators
     * @return string the op id (pass to finish()/fail())
     */
    public function begin(string $opType, string $entityType, string $entityId, ?string $userId, array $detail = []): string
    {
        $id = $this->uuidV4();
        $stmt = $this->mysql->prepare(
            "INSERT INTO store_ops (id, op_type, entity_type, entity_id, user_id, detail, attempts, created_at, updated_at)
             VALUES (:id, :op_type, :entity_type, :entity_id, :user_id, :detail, 0, NOW(), NOW())"
        );
        $stmt->execute([
            'id' => $id,
            'op_type' => $opType,
            'entity_type' => $entityType,
            'entity_id' => $entityId,
            'user_id' => $userId,
            'detail' => empty($detail) ? null : json_encode($detail),
        ]);
        return $id;
    }

    /** Every store verified in agreement — the op no longer represents pending work. */
    public function finish(?string $opId): void
    {
        if ($opId === null || $opId === '') {
            return;
        }
        $stmt = $this->mysql->prepare("DELETE FROM store_ops WHERE id = :id");
        $stmt->execute(['id' => $opId]);
    }

    /**
     * Clear every pending op for an entity. Used when the entity's deletion has been
     * verified across all stores: any older create/update op about it is moot.
     */
    public function finishAllForEntity(string $entityType, string $entityId): void
    {
        $stmt = $this->mysql->prepare(
            "DELETE FROM store_ops WHERE entity_type = :entity_type AND entity_id = :entity_id"
        );
        $stmt->execute(['entity_type' => $entityType, 'entity_id' => $entityId]);
    }

    /** The op's side effects could not be completed/verified — keep it pending with the cause. */
    public function fail(?string $opId, string $error): void
    {
        if ($opId === null || $opId === '') {
            return;
        }
        $stmt = $this->mysql->prepare(
            "UPDATE store_ops SET attempts = attempts + 1, last_error = :err, updated_at = NOW() WHERE id = :id"
        );
        $stmt->execute(['err' => mb_substr($error, 0, 2000), 'id' => $opId]);
    }

    /**
     * @return array<string,mixed>|null the oldest pending op for the entity (optionally
     *         of one type), or null when the entity has no pending work.
     */
    public function pendingForEntity(string $entityType, string $entityId, ?string $opType = null): ?array
    {
        $sql = "SELECT * FROM store_ops WHERE entity_type = :entity_type AND entity_id = :entity_id";
        $params = ['entity_type' => $entityType, 'entity_id' => $entityId];
        if ($opType !== null) {
            $sql .= " AND op_type = :op_type";
            $params['op_type'] = $opType;
        }
        $sql .= " ORDER BY created_at ASC LIMIT 1";
        $stmt = $this->mysql->prepare($sql);
        $stmt->execute($params);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row === false ? null : $row;
    }

    /**
     * @param int $olderThanSeconds only ops at least this old (0 = all); lets read-only
     *        reports skip rows that are merely in flight on a live request.
     * @return array<int,array<string,mixed>>
     */
    public function listPending(?string $opType = null, ?string $userId = null, int $olderThanSeconds = 0, int $limit = 500): array
    {
        $conditions = [];
        $params = [];
        if ($opType !== null) {
            $conditions[] = "op_type = :op_type";
            $params['op_type'] = $opType;
        }
        if ($userId !== null) {
            $conditions[] = "user_id = :user_id";
            $params['user_id'] = $userId;
        }
        if ($olderThanSeconds > 0) {
            $conditions[] = "created_at <= NOW() - INTERVAL :age SECOND";
        }
        $sql = "SELECT * FROM store_ops"
            . (empty($conditions) ? '' : ' WHERE ' . implode(' AND ', $conditions))
            . " ORDER BY created_at ASC LIMIT :limit";
        $stmt = $this->mysql->prepare($sql);
        foreach ($params as $k => $v) {
            $stmt->bindValue($k, $v);
        }
        if ($olderThanSeconds > 0) {
            $stmt->bindValue('age', $olderThanSeconds, PDO::PARAM_INT);
        }
        $stmt->bindValue('limit', max(1, min($limit, 1000)), PDO::PARAM_INT);
        $stmt->execute();
        return $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
    }

    /** Pending ops attributed to a user — the account-erasure retention gate. */
    public function countPendingForUser(string $userId): int
    {
        $stmt = $this->mysql->prepare("SELECT COUNT(*) FROM store_ops WHERE user_id = :user_id");
        $stmt->execute(['user_id' => $userId]);
        return (int) $stmt->fetchColumn();
    }

    /** @return int pending ops at least $olderThanSeconds old (for health/reconcile summaries). */
    public function countPending(int $olderThanSeconds = 0): int
    {
        if ($olderThanSeconds > 0) {
            $stmt = $this->mysql->prepare(
                "SELECT COUNT(*) FROM store_ops WHERE created_at <= NOW() - INTERVAL :age SECOND"
            );
            $stmt->bindValue('age', $olderThanSeconds, PDO::PARAM_INT);
            $stmt->execute();
        } else {
            $stmt = $this->mysql->query("SELECT COUNT(*) FROM store_ops");
        }
        return (int) $stmt->fetchColumn();
    }

    private function uuidV4(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}

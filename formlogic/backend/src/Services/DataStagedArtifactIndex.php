<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;

/**
 * Ownership metadata for STAGED data-node artifacts (snapshots + sealed
 * account backups) — review FL-002.
 *
 * Staged artifact IDs are 128-bit random, but secrecy is not an authorization
 * control: every GET/DELETE must prove the caller owns the artifact. Each
 * staged directory gets exactly one row here at creation; lookups require an
 * exact (id, kind, owner) match on an `active`, unexpired row, and misses are
 * indistinguishable from missing IDs (uniform 404 upstream).
 *
 * Deletion is a crash-resumable state machine: the row transitions to
 * `deleting` FIRST (single conditional UPDATE — the ownership check and the
 * state transition are one atomic statement), then files are unlinked
 * idempotently, then the row is removed. A crash between those steps leaves a
 * `deleting` row that the sweep finishes later; it can never resurrect an
 * artifact or leak one to another tenant.
 */
final class DataStagedArtifactIndex
{
    public const KIND_SNAPSHOT = 'snapshot';
    public const KIND_ACCOUNT_BACKUP = 'account_backup';

    public function __construct(private MySQLConnection $mysql)
    {
    }

    /** Record a freshly staged artifact for its owner. */
    public function record(string $artifactId, string $kind, string $ownerUserId, ?string $nodeId, int $ttlSeconds): void
    {
        $now = time();
        $this->mysql->getConnection()->prepare(
            'INSERT INTO data_staged_artifacts (id, kind, owner_user_id, node_id, state, created_at, expires_at)
             VALUES (?, ?, ?, ?, "active", ?, ?)
             ON DUPLICATE KEY UPDATE kind = VALUES(kind), owner_user_id = VALUES(owner_user_id),
                node_id = VALUES(node_id), state = "active", created_at = VALUES(created_at),
                expires_at = VALUES(expires_at)'
        )->execute([
            $artifactId,
            $kind,
            $ownerUserId,
            $nodeId,
            gmdate('Y-m-d H:i:s', $now),
            gmdate('Y-m-d H:i:s', $now + $ttlSeconds),
        ]);
    }

    /** True only for an active, unexpired artifact owned by exactly this user. */
    public function resolveOwned(string $artifactId, string $kind, string $ownerUserId): bool
    {
        $stmt = $this->mysql->getConnection()->prepare(
            'SELECT 1 FROM data_staged_artifacts
             WHERE id = ? AND kind = ? AND owner_user_id = ? AND state = "active" AND expires_at > ?'
        );
        $stmt->execute([$artifactId, $kind, $ownerUserId, gmdate('Y-m-d H:i:s')]);
        return $stmt->fetchColumn() !== false;
    }

    /**
     * Atomically claim an owned artifact for deletion. Returns false (leaving
     * every file and row untouched) when the caller does not own it.
     */
    public function beginDelete(string $artifactId, string $kind, string $ownerUserId): bool
    {
        $stmt = $this->mysql->getConnection()->prepare(
            'UPDATE data_staged_artifacts SET state = "deleting"
             WHERE id = ? AND kind = ? AND owner_user_id = ?'
        );
        $stmt->execute([$artifactId, $kind, $ownerUserId]);
        return $stmt->rowCount() > 0;
    }

    /** Final step after the files are gone (idempotent). */
    public function finishDelete(string $artifactId): void
    {
        $this->mysql->getConnection()
            ->prepare('DELETE FROM data_staged_artifacts WHERE id = ?')
            ->execute([$artifactId]);
    }

    /**
     * IDs the sweeper must unlink and finalize: expired rows plus `deleting`
     * rows a crash left behind.
     *
     * @return list<string>
     */
    public function sweepable(string $kind): array
    {
        $stmt = $this->mysql->getConnection()->prepare(
            'SELECT id FROM data_staged_artifacts
             WHERE kind = ? AND (state = "deleting" OR expires_at <= ?) LIMIT 200'
        );
        $stmt->execute([$kind, gmdate('Y-m-d H:i:s')]);
        return array_map('strval', $stmt->fetchAll(\PDO::FETCH_COLUMN));
    }
}

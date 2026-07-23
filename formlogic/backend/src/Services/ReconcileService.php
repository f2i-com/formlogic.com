<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\SQLiteConnection;
use PDO;

/**
 * Detects (and optionally repairs) drift between the dual stores: MySQL metadata
 * (forms / response_metadata / response_links) and the per-form SQLite response files.
 * Drift can arise after a partial failure (e.g. a best-effort delete that only hit one store).
 *
 * - report() is READ-ONLY.
 * - fix() applies only SAFE repairs: re-sync forms.response_count, delete response_links
 *   that point at a non-existent form, and (when constructed with a FormService) retry
 *   pending form-deletion cleanups from the store_ops ledger — those carry a durable
 *   delete INTENT, so completing them is safe by construction. Orphaned SQLite files /
 *   upload dirs with no recorded intent are reported but never auto-deleted (they may
 *   hold recoverable data).
 */
class ReconcileService
{
    /** report() ignores ops younger than this — they're merely in flight on a live request. */
    private const OP_REPORT_MIN_AGE_SECONDS = 60;

    public function __construct(
        private PDO $mysql,
        private SQLiteConnection $sqlite,
        private string $formsPath,
        private string $uploadsPath,
        private ?FormService $formService = null
    ) {
    }

    /** @return array<string, string[]> formId lists keyed by drift type — cheap (no SQLite opens). */
    public function fileDrift(): array
    {
        $formIds = $this->formIds();
        $formSet = array_fill_keys($formIds, true);

        $sqliteIds = [];
        foreach (glob(rtrim($this->formsPath, '/') . '/*.sqlite') ?: [] as $path) {
            $sqliteIds[] = basename($path, '.sqlite');
        }
        $sqliteSet = array_fill_keys($sqliteIds, true);

        $uploadIds = [];
        if (is_dir($this->uploadsPath)) {
            foreach (scandir($this->uploadsPath) ?: [] as $entry) {
                if ($entry !== '.' && $entry !== '..' && is_dir($this->uploadsPath . '/' . $entry)) {
                    $uploadIds[] = $entry;
                }
            }
        }

        return [
            'missingSqlite' => array_values(array_filter($formIds, fn($id) => !isset($sqliteSet[$id]))),
            'orphanedSqlite' => array_values(array_filter($sqliteIds, fn($id) => !isset($formSet[$id]))),
            'orphanedUploads' => array_values(array_filter($uploadIds, fn($id) => !isset($formSet[$id]))),
        ];
    }

    /** @return array full read-only report including per-form count drift + orphaned links. */
    public function report(): array
    {
        $files = $this->fileDrift();

        // Per-form count drift: SQLite responses vs MySQL response_metadata vs cached response_count.
        $countDrift = [];
        $cached = [];
        foreach ($this->mysql->query('SELECT id, COALESCE(response_count, 0) AS rc FROM forms') as $r) {
            $cached[$r['id']] = (int) $r['rc'];
        }
        $metaCounts = [];
        foreach ($this->mysql->query('SELECT form_id, COUNT(*) AS c FROM response_metadata GROUP BY form_id') as $r) {
            $metaCounts[$r['form_id']] = (int) $r['c'];
        }
        foreach (array_keys($cached) as $formId) {
            if (in_array($formId, $files['missingSqlite'], true)) {
                continue; // no SQLite file → already reported
            }
            $sqliteCount = $this->sqliteResponseCount($formId);
            $metaCount = $metaCounts[$formId] ?? 0;
            $cachedCount = $cached[$formId];
            if ($sqliteCount === null) {
                continue; // unreadable — skip
            }
            if ($sqliteCount !== $metaCount || $sqliteCount !== $cachedCount) {
                $countDrift[] = [
                    'formId' => $formId,
                    'sqlite' => $sqliteCount,
                    'metadata' => $metaCount,
                    'cached' => $cachedCount,
                ];
            }
        }

        // response_links pointing at a non-existent source/target form.
        $orphanedLinks = (int) $this->mysql->query(
            'SELECT COUNT(*) FROM response_links rl
             WHERE rl.source_form_id NOT IN (SELECT id FROM forms)
                OR rl.target_form_id NOT IN (SELECT id FROM forms)'
        )->fetchColumn();

        return [
            'missingSqlite' => $files['missingSqlite'],
            'orphanedSqlite' => $files['orphanedSqlite'],
            'orphanedUploads' => $files['orphanedUploads'],
            'countDrift' => $countDrift,
            'orphanedResponseLinks' => $orphanedLinks,
            'pendingStoreOps' => $this->pendingStoreOps(),
        ];
    }

    /**
     * Pending cross-store operations (audit FL-DATA-001) — each row is a mutation whose
     * stores were never verified in agreement (crashed create, failed delete cleanup).
     * The operator-visible failure state; form_delete rows are retryable via fix().
     *
     * @return array<int,array<string,mixed>>
     */
    public function pendingStoreOps(): array
    {
        try {
            $stmt = $this->mysql->prepare(
                "SELECT id, op_type, entity_type, entity_id, user_id, attempts, last_error, created_at,
                        TIMESTAMPDIFF(SECOND, created_at, NOW()) AS age_seconds
                 FROM store_ops
                 WHERE created_at <= NOW() - INTERVAL :age SECOND
                 ORDER BY created_at ASC LIMIT 500"
            );
            $stmt->bindValue('age', self::OP_REPORT_MIN_AGE_SECONDS, PDO::PARAM_INT);
            $stmt->execute();
            return array_map(static fn (array $r) => [
                'opId' => $r['id'],
                'opType' => $r['op_type'],
                'entityType' => $r['entity_type'],
                'entityId' => $r['entity_id'],
                'userId' => $r['user_id'],
                'attempts' => (int) $r['attempts'],
                'lastError' => $r['last_error'],
                'ageSeconds' => (int) $r['age_seconds'],
            ], $stmt->fetchAll(PDO::FETCH_ASSOC) ?: []);
        } catch (\Throwable $e) {
            return []; // table not migrated yet — nothing to report
        }
    }

    /**
     * ROW-level response-mirror repair (audit FL-04): the per-form SQLite store
     * is authoritative — reinsert response_metadata rows it has that MySQL lost
     * (a mirror insert that failed AFTER the durable commit now defers here
     * instead of destroying the committed row), and drop metadata rows whose
     * authoritative response no longer exists. Idempotent (INSERT IGNORE /
     * keyed DELETE); scans only forms whose counts disagree, so the cron cost
     * stays proportional to actual drift. (Equal counts with a 1-for-1 id swap
     * would evade the gate — accepted: that shape requires two independent
     * partial failures and still surfaces in the Doctor's drift report.)
     *
     * @return array{inserted:int, orphansDeleted:int, formsRepaired:string[]}
     */
    public function repairResponseMirrors(): array
    {
        $inserted = 0;
        $orphansDeleted = 0;
        $formsRepaired = [];

        $metaCounts = [];
        foreach ($this->mysql->query('SELECT form_id, COUNT(*) AS c FROM response_metadata GROUP BY form_id') as $r) {
            $metaCounts[$r['form_id']] = (int) $r['c'];
        }

        foreach ($this->formIds() as $formId) {
            $sqliteCount = $this->sqliteResponseCount($formId);
            if ($sqliteCount === null) {
                continue; // no/unreadable SQLite store — fileDrift reports it
            }
            if ($sqliteCount === ($metaCounts[$formId] ?? 0)) {
                continue;
            }

            try {
                $db = $this->sqlite->getFormDatabase($formId);
                $rows = $db->query('SELECT id, status, submitted_at FROM responses')
                    ->fetchAll(PDO::FETCH_ASSOC) ?: [];
            } catch (\Throwable $e) {
                continue;
            }
            $sqliteById = [];
            foreach ($rows as $row) {
                $sqliteById[(string) $row['id']] = $row;
            }

            $metaStmt = $this->mysql->prepare('SELECT id FROM response_metadata WHERE form_id = ?');
            $metaStmt->execute([$formId]);
            $metaIds = array_map('strval', $metaStmt->fetchAll(PDO::FETCH_COLUMN) ?: []);
            $metaIdSet = array_fill_keys($metaIds, true);

            $repairedThisForm = false;
            $insertStmt = $this->mysql->prepare(
                'INSERT IGNORE INTO response_metadata (id, form_id, status, submitted_at)
                 VALUES (:id, :form_id, :status, :submitted_at)'
            );
            foreach ($sqliteById as $id => $row) {
                if (isset($metaIdSet[$id])) {
                    continue;
                }
                $insertStmt->execute([
                    'id' => $id,
                    'form_id' => $formId,
                    'status' => (string) ($row['status'] ?? 'submitted'),
                    'submitted_at' => (string) ($row['submitted_at'] ?? gmdate('Y-m-d H:i:s')),
                ]);
                $inserted += $insertStmt->rowCount();
                $repairedThisForm = true;
            }

            $orphaned = array_values(array_filter($metaIds, static fn (string $id) => !isset($sqliteById[$id])));
            foreach (array_chunk($orphaned, 500) as $chunk) {
                $ph = implode(',', array_fill(0, count($chunk), '?'));
                $del = $this->mysql->prepare("DELETE FROM response_metadata WHERE form_id = ? AND id IN ($ph)");
                $del->execute(array_merge([$formId], $chunk));
                $orphansDeleted += $del->rowCount();
                $repairedThisForm = true;
            }

            if ($repairedThisForm) {
                $formsRepaired[] = $formId;
            }
        }

        return [
            'inserted' => $inserted,
            'orphansDeleted' => $orphansDeleted,
            'formsRepaired' => $formsRepaired,
        ];
    }

    /** Apply safe repairs. @return array<string, int|string[]> summary of what changed. */
    public function fix(): array
    {
        // Audit FL-04: row-level mirror repair runs FIRST, so the count resync
        // below reconciles against the repaired metadata state.
        $mirror = $this->repairResponseMirrors();

        $report = $this->report();
        $resynced = [];
        foreach ($report['countDrift'] as $d) {
            // Preserve updated_at (mirrors ResponseService::syncResponseCount) — a count resync
            // is maintenance, not a content edit, so it must not bump the form's "Last Modified".
            $stmt = $this->mysql->prepare('UPDATE forms SET response_count = :c, updated_at = updated_at WHERE id = :id');
            $stmt->execute(['c' => $d['sqlite'], 'id' => $d['formId']]);
            $resynced[] = $d['formId'];
        }
        $linksDeleted = $this->mysql->exec(
            'DELETE FROM response_links
             WHERE source_form_id NOT IN (SELECT id FROM (SELECT id FROM forms) f1)
                OR target_form_id NOT IN (SELECT id FROM (SELECT id FROM forms) f2)'
        );

        // Retry pending form-deletion cleanups — safe: each carries a durable delete
        // intent recorded atomically with the (already committed) metadata removal.
        // Crashed create/update ops are only REPORTED: their intended content is
        // unknown, so repairing them is an operator decision, not an auto-delete.
        $cleanupRetries = ['retried' => 0, 'completed' => 0, 'stillPending' => 0];
        if ($this->formService !== null) {
            try {
                $cleanupRetries = $this->formService->retryPendingCleanup();
            } catch (\Throwable $e) {
                // leave zeros — the report still lists the pending ops
            }
        }

        return [
            'mirrorRowsInserted' => $mirror['inserted'],
            'mirrorOrphansDeleted' => $mirror['orphansDeleted'],
            'mirrorFormsRepaired' => $mirror['formsRepaired'],
            'responseCountsResynced' => $resynced,
            'orphanedLinksDeleted' => (int) $linksDeleted,
            'deleteCleanupsRetried' => $cleanupRetries['retried'],
            'deleteCleanupsCompleted' => $cleanupRetries['completed'],
            'deleteCleanupsStillPending' => $cleanupRetries['stillPending'],
        ];
    }

    /** @return string[] */
    private function formIds(): array
    {
        return array_map('strval', $this->mysql->query('SELECT id FROM forms')->fetchAll(PDO::FETCH_COLUMN) ?: []);
    }

    private function sqliteResponseCount(string $formId): ?int
    {
        try {
            if (!$this->sqlite->formDatabaseExists($formId)) {
                return null;
            }
            $db = $this->sqlite->getFormDatabase($formId);
            return (int) $db->query('SELECT COUNT(*) FROM responses')->fetchColumn();
        } catch (\Throwable $e) {
            return null;
        }
    }
}

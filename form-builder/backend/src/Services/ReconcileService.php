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
 * - fix() applies only SAFE repairs: re-sync forms.response_count, and delete response_links
 *   that point at a non-existent form. Orphaned SQLite files / upload dirs are reported but never
 *   auto-deleted (they may hold recoverable data).
 */
class ReconcileService
{
    public function __construct(
        private PDO $mysql,
        private SQLiteConnection $sqlite,
        private string $formsPath,
        private string $uploadsPath
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
        ];
    }

    /** Apply safe repairs. @return array<string, int|string[]> summary of what changed. */
    public function fix(): array
    {
        $report = $this->report();
        $resynced = [];
        foreach ($report['countDrift'] as $d) {
            $stmt = $this->mysql->prepare('UPDATE forms SET response_count = :c WHERE id = :id');
            $stmt->execute(['c' => $d['sqlite'], 'id' => $d['formId']]);
            $resynced[] = $d['formId'];
        }
        $linksDeleted = $this->mysql->exec(
            'DELETE FROM response_links
             WHERE source_form_id NOT IN (SELECT id FROM (SELECT id FROM forms) f1)
                OR target_form_id NOT IN (SELECT id FROM (SELECT id FROM forms) f2)'
        );
        return [
            'responseCountsResynced' => $resynced,
            'orphanedLinksDeleted' => (int) $linksDeleted,
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

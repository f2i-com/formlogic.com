<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use PDO;

/**
 * In-place upgrades through the admin panel: upload the CI-built release zip
 * (built UI at the zip root, backend under api/, manifest.json with sha256s),
 * validate + stage it, auto-export the MySQL database, snapshot the current
 * code, apply the new files, and roll back from the snapshot if needed.
 *
 * DATA SAFETY INVARIANTS (the reason this class exists):
 *  - api/.env, api/storage/** (per-form SQLite databases, uploads, packs) and
 *    api/logs/** are NEVER written by apply/rollback — every copy filters them
 *    on BOTH the source and destination side (see PROTECTED_API_PATHS).
 *  - the MySQL database is exported to a backup BEFORE any apply.
 *  - maintenance mode is enabled around an apply so nothing writes mid-swap.
 *  - schema migrations self-apply on the FIRST request served by the new code
 *    (MySQLConnection::ensureSchemaCurrent md5-stamps itself), so this class
 *    never runs new-version migrations from old loaded classes.
 */
class UpgradeService
{
    /** Paths (relative to the api root) an upgrade must never write or restore over. */
    private const PROTECTED_API_PATHS = ['.env', 'storage', 'logs'];

    /** Web-root entries never touched when applying the zip-root files (the api
     *  dir is handled by the api-side copy; on dev machines webRoot/api is a junction). */
    private const PROTECTED_WEB_PATHS = ['api'];

    private PDO $pdo;

    public function __construct(
        private string $apiRoot,
        private MySQLConnection $mysql,
        private MaintenanceService $maintenance,
    ) {
        $this->pdo = $mysql->getConnection();
    }

    public static function defaultApiRoot(): string
    {
        return dirname(__DIR__, 2);
    }

    // ── layout + status ─────────────────────────────────────────────────────

    /**
     * Where this installation lives. 'deployed' = the packaged single-domain
     * layout (web root with index.html, backend under api/). 'dev' = a source
     * checkout (web root = ui/dist). Anything else is unsupported for apply.
     */
    public function layout(): array
    {
        $apiRoot = rtrim($this->apiRoot, '/\\');
        $webRoot = null;
        $mode = 'unknown';
        $override = (string) ($_ENV['FORMLOGIC_WEB_ROOT'] ?? '');
        if ($override !== '' && is_dir($override)) {
            $webRoot = realpath($override) ?: $override;
            $mode = 'env-override';
        } elseif (strtolower(basename($apiRoot)) === 'api' && is_file(dirname($apiRoot) . '/index.html')) {
            $webRoot = dirname($apiRoot);
            $mode = 'deployed';
        } elseif (is_file(dirname($apiRoot) . '/ui/dist/index.html')) {
            $webRoot = dirname($apiRoot) . '/ui/dist';
            $mode = 'dev';
        }
        return ['apiRoot' => $apiRoot, 'webRoot' => $webRoot, 'mode' => $mode, 'supported' => $webRoot !== null];
    }

    /** The running app version: api/VERSION (written by the packager) → schema_meta stamp → 'dev'. */
    public function currentVersion(): string
    {
        $file = $this->apiRoot . '/VERSION';
        if (is_file($file)) {
            $v = trim((string) @file_get_contents($file));
            if ($v !== '') {
                return $v;
            }
        }
        try {
            $stmt = $this->pdo->query("SELECT meta_value FROM schema_meta WHERE meta_key = 'app_version'");
            $v = $stmt ? $stmt->fetchColumn() : false;
            if ($v !== false && $v !== null && $v !== '') {
                return (string) $v;
            }
        } catch (\Throwable) {
        }
        return 'dev';
    }

    public function status(): array
    {
        return [
            'currentVersion' => $this->currentVersion(),
            'layout' => $this->layout(),
            'staged' => $this->stagedInfo(),
            'backups' => $this->listBackups(),
            'history' => $this->history(),
            'maintenance' => $this->maintenance->status(),
        ];
    }

    // ── upload + validate + stage ───────────────────────────────────────────

    /**
     * Accept an uploaded package zip, extract it to the staging area and verify
     * it: manifest.json version + per-file sha256 (packages without a manifest —
     * pre-manifest releases — are allowed but flagged integrity 'unverified'),
     * plus structural checks. Returns the staged-package report.
     * @throws \RuntimeException on any validation failure (staging is cleared)
     */
    public function stageUploadedPackage(string $zipPath): array
    {
        if (!class_exists(\ZipArchive::class)) {
            throw new \RuntimeException('The PHP zip extension is required for upgrades');
        }
        $staging = $this->stagingDir();
        $this->rrmdir($staging);
        if (!@mkdir($staging, 0750, true)) {
            throw new \RuntimeException('Cannot create the staging directory');
        }

        try {
            $zip = new \ZipArchive();
            if ($zip->open($zipPath) !== true) {
                throw new \RuntimeException('The uploaded file is not a readable zip archive');
            }
            // Zip-slip guard: refuse entries that escape the staging dir.
            for ($i = 0; $i < $zip->numFiles; $i++) {
                $name = (string) $zip->getNameIndex($i);
                $norm = str_replace('\\', '/', $name);
                if (str_contains($norm, '../') || str_starts_with($norm, '/') || preg_match('/^[a-zA-Z]:/', $norm)) {
                    throw new \RuntimeException("Unsafe path in archive: {$name}");
                }
            }
            if (!$zip->extractTo($staging)) {
                throw new \RuntimeException('Could not extract the archive (disk full or permissions?)');
            }
            $zip->close();

            // Structural checks: this must be the single-domain FormLogic package.
            foreach (['index.html', 'api/public/index.php', 'api/vendor/autoload.php', 'api/database/schema.sql'] as $required) {
                if (!is_file("{$staging}/{$required}")) {
                    throw new \RuntimeException("Not a FormLogic release package — missing {$required}");
                }
            }

            $manifest = null;
            $integrity = 'unverified';
            $verified = 0;
            if (is_file("{$staging}/manifest.json")) {
                $manifest = json_decode((string) file_get_contents("{$staging}/manifest.json"), true);
                if (!is_array($manifest) || !is_string($manifest['version'] ?? null) || !is_array($manifest['files'] ?? null)) {
                    throw new \RuntimeException('manifest.json is present but malformed');
                }
                foreach ($manifest['files'] as $rel => $sha) {
                    $abs = "{$staging}/{$rel}";
                    if (!is_file($abs)) {
                        throw new \RuntimeException("Package integrity failure: {$rel} listed in the manifest is missing");
                    }
                    if (!hash_equals((string) $sha, hash_file('sha256', $abs) ?: '')) {
                        throw new \RuntimeException("Package integrity failure: {$rel} does not match its manifest checksum");
                    }
                    $verified++;
                }
                $integrity = 'verified';
            }

            $version = is_array($manifest) ? (string) $manifest['version']
                : trim((string) @file_get_contents("{$staging}/VERSION"));
            if ($version === '') {
                throw new \RuntimeException('The package carries no version (no manifest.json and no VERSION file)');
            }

            $info = [
                'version' => $version,
                'integrity' => $integrity,
                'verifiedFiles' => $verified,
                'currentVersion' => $this->currentVersion(),
                'isDowngrade' => version_compare($this->normalizeVersion($version), $this->normalizeVersion($this->currentVersion()), '<'),
                'stagedAt' => gmdate('c'),
            ];
            file_put_contents("{$staging}/.staged-info.json", json_encode($info));
            return $info;
        } catch (\Throwable $e) {
            $this->rrmdir($staging);
            throw $e instanceof \RuntimeException ? $e : new \RuntimeException($e->getMessage(), 0, $e);
        }
    }

    public function stagedInfo(): ?array
    {
        $file = $this->stagingDir() . '/.staged-info.json';
        if (!is_file($file)) {
            return null;
        }
        $info = json_decode((string) file_get_contents($file), true);
        return is_array($info) ? $info : null;
    }

    public function discardStagedPackage(): void
    {
        $this->rrmdir($this->stagingDir());
    }

    // ── apply ────────────────────────────────────────────────────────────────

    /**
     * Apply the staged package. Steps (each recorded in the returned journal):
     * maintenance on → DB export → code snapshot → copy api/ (protected paths
     * excluded) → copy web-root files → stamp version → history. Migrations run
     * automatically on the next request served by the new code.
     * @throws \RuntimeException with the journal context on failure
     */
    public function apply(string $actingUserId, bool $keepMaintenanceOn = false): array
    {
        @set_time_limit(600);
        $staged = $this->stagedInfo();
        if ($staged === null) {
            throw new \RuntimeException('No validated package is staged — upload one first');
        }
        $layout = $this->layout();
        if (!$layout['supported']) {
            throw new \RuntimeException('This installation layout is not recognized — set FORMLOGIC_WEB_ROOT in .env to the folder holding index.html');
        }

        $journal = [];
        $fromVersion = $this->currentVersion();
        $maintenanceWasOn = $this->maintenance->enabled();

        // 1. Close the site so nothing writes mid-swap (kept on if it already was).
        if (!$maintenanceWasOn) {
            $this->maintenance->enable('We are upgrading FormLogic — back in a few minutes.', $actingUserId);
        }
        $journal[] = 'Maintenance mode enabled';

        try {
            // 2. Automatic database export + code snapshot = the revert point.
            $backupId = gmdate('Ymd-His') . '-' . substr(bin2hex(random_bytes(3)), 0, 6);
            $backupDir = $this->backupsDir() . '/' . $backupId;
            @mkdir($backupDir, 0750, true);
            $this->dumpDatabase("{$backupDir}/database.sql.gz");
            $journal[] = 'Database exported to backup';

            $counts = $this->copyTree($this->apiRoot, "{$backupDir}/api", self::PROTECTED_API_PATHS);
            $journal[] = "Backend snapshot taken ({$counts} files)";
            $counts = $this->copyTree($layout['webRoot'], "{$backupDir}/web", self::PROTECTED_WEB_PATHS);
            $journal[] = "Frontend snapshot taken ({$counts} files)";
            file_put_contents("{$backupDir}/backup-info.json", json_encode([
                'id' => $backupId, 'at' => gmdate('c'), 'version' => $fromVersion, 'by' => $actingUserId,
            ], JSON_PRETTY_PRINT));

            // 3. Apply: backend first, then the web root. Protected paths are
            //    excluded on the DESTINATION side, and the package's own (empty)
            //    api/storage skeleton is excluded on the SOURCE side — the
            //    per-form SQLite databases are never written under any input.
            $staging = $this->stagingDir();
            $counts = $this->copyTree("{$staging}/api", $this->apiRoot, self::PROTECTED_API_PATHS);
            $journal[] = "Backend files applied ({$counts} files)";
            $counts = $this->copyTree($staging, $layout['webRoot'], array_merge(self::PROTECTED_WEB_PATHS, ['.staged-info.json']));
            $journal[] = "Frontend files applied ({$counts} files)";

            // 4. Version stamps: api/VERSION already copied; mirror into schema_meta
            //    (the same stamp bin/upgrade.php writes) so --check agrees.
            $this->stampSchemaMeta($staged['version']);
            $journal[] = "Version stamped ({$fromVersion} → {$staged['version']})";

            $this->appendHistory([
                'action' => 'upgrade', 'at' => gmdate('c'), 'by' => $actingUserId,
                'fromVersion' => $fromVersion, 'toVersion' => $staged['version'],
                'backupId' => $backupId, 'integrity' => $staged['integrity'],
            ]);
            $this->discardStagedPackage();

            // 5. Reopen unless the admin asked to stay closed (or it was already closed).
            if (!$maintenanceWasOn && !$keepMaintenanceOn) {
                $this->maintenance->disable($actingUserId);
                $journal[] = 'Maintenance mode disabled';
            } else {
                $journal[] = 'Maintenance mode left ON (turn it off from the Maintenance tab)';
            }
            $journal[] = 'Schema migrations will run automatically on the next request';

            return [
                'ok' => true,
                'fromVersion' => $fromVersion,
                'toVersion' => $staged['version'],
                'backupId' => $backupId,
                'journal' => $journal,
            ];
        } catch (\Throwable $e) {
            // Leave maintenance ON — a half-applied tree must not serve users.
            $journal[] = 'FAILED: ' . $e->getMessage();
            throw new \RuntimeException(
                'Upgrade failed (site left in maintenance mode; use Rollback if files were already applied): '
                . $e->getMessage() . ' | journal: ' . implode(' → ', $journal),
                0,
                $e
            );
        }
    }

    // ── rollback / restore ──────────────────────────────────────────────────

    /** Restore the code snapshot from a backup (the DB is NOT auto-restored — see restoreDatabase). */
    public function rollback(string $backupId, string $actingUserId): array
    {
        @set_time_limit(600);
        $backupDir = $this->backupDirFor($backupId);
        $layout = $this->layout();
        if (!$layout['supported']) {
            throw new \RuntimeException('This installation layout is not recognized');
        }
        if (!is_dir("{$backupDir}/api") || !is_dir("{$backupDir}/web")) {
            throw new \RuntimeException('This backup has no code snapshot to restore');
        }

        $maintenanceWasOn = $this->maintenance->enabled();
        if (!$maintenanceWasOn) {
            $this->maintenance->enable('We are restoring a previous version — back shortly.', $actingUserId);
        }
        $journal = ['Maintenance mode enabled'];
        $fromVersion = $this->currentVersion();

        $counts = $this->copyTree("{$backupDir}/api", $this->apiRoot, self::PROTECTED_API_PATHS);
        $journal[] = "Backend restored ({$counts} files)";
        $counts = $this->copyTree("{$backupDir}/web", $layout['webRoot'], self::PROTECTED_WEB_PATHS);
        $journal[] = "Frontend restored ({$counts} files)";

        $info = json_decode((string) @file_get_contents("{$backupDir}/backup-info.json"), true);
        $restoredVersion = is_array($info) ? (string) ($info['version'] ?? 'unknown') : 'unknown';
        $this->stampSchemaMeta($restoredVersion !== 'unknown' ? $restoredVersion : $fromVersion);

        $this->appendHistory([
            'action' => 'rollback', 'at' => gmdate('c'), 'by' => $actingUserId,
            'fromVersion' => $fromVersion, 'toVersion' => $restoredVersion, 'backupId' => $backupId,
        ]);

        if (!$maintenanceWasOn) {
            $this->maintenance->disable($actingUserId);
            $journal[] = 'Maintenance mode disabled';
        }
        $journal[] = 'Database was NOT restored (records created since the upgrade are intact) — restore it separately only if needed';

        return ['ok' => true, 'restoredVersion' => $restoredVersion, 'journal' => $journal];
    }

    /**
     * Restore the MySQL export from a backup. DESTRUCTIVE for anything written
     * since that backup — requires the literal confirm phrase. Per-form SQLite
     * databases are untouched (they were never part of the problem).
     */
    public function restoreDatabase(string $backupId, string $confirm, string $actingUserId): array
    {
        if ($confirm !== 'RESTORE-DATABASE') {
            throw new \RuntimeException("Confirmation phrase mismatch — send confirm: 'RESTORE-DATABASE'");
        }
        @set_time_limit(600);
        $dump = $this->backupDirFor($backupId) . '/database.sql.gz';
        if (!is_file($dump)) {
            throw new \RuntimeException('This backup has no database export');
        }

        $maintenanceWasOn = $this->maintenance->enabled();
        if (!$maintenanceWasOn) {
            $this->maintenance->enable('We are restoring data — back shortly.', $actingUserId);
        }

        $gz = gzopen($dump, 'rb');
        if ($gz === false) {
            throw new \RuntimeException('Cannot open the database export');
        }
        $statements = 0;
        try {
            $this->pdo->exec('SET FOREIGN_KEY_CHECKS=0');
            $buffer = '';
            while (!gzeof($gz)) {
                $buffer .= gzread($gz, 1 << 20);
                // Our own dump format: exactly one statement per line, ";"-terminated
                // (newlines inside values are \n-escaped at dump time).
                while (($nl = strpos($buffer, "\n")) !== false) {
                    $line = substr($buffer, 0, $nl);
                    $buffer = substr($buffer, $nl + 1);
                    $line = rtrim($line, "\r");
                    if ($line === '' || str_starts_with($line, '--')) {
                        continue;
                    }
                    $this->pdo->exec($line);
                    $statements++;
                }
            }
            if (trim($buffer) !== '' && !str_starts_with(trim($buffer), '--')) {
                $this->pdo->exec(trim($buffer));
                $statements++;
            }
        } finally {
            try {
                $this->pdo->exec('SET FOREIGN_KEY_CHECKS=1');
            } catch (\Throwable) {
            }
            gzclose($gz);
        }

        $this->appendHistory([
            'action' => 'restore-database', 'at' => gmdate('c'), 'by' => $actingUserId, 'backupId' => $backupId,
        ]);
        if (!$maintenanceWasOn) {
            $this->maintenance->disable($actingUserId);
        }
        return ['ok' => true, 'statements' => $statements];
    }

    /** On-demand database export (same dumper the automatic pre-upgrade backup uses). */
    public function exportDatabaseBackup(string $actingUserId): array
    {
        @set_time_limit(600);
        $backupId = gmdate('Ymd-His') . '-' . substr(bin2hex(random_bytes(3)), 0, 6) . '-manual';
        $backupDir = $this->backupsDir() . '/' . $backupId;
        @mkdir($backupDir, 0750, true);
        $this->dumpDatabase("{$backupDir}/database.sql.gz");
        file_put_contents("{$backupDir}/backup-info.json", json_encode([
            'id' => $backupId, 'at' => gmdate('c'), 'version' => $this->currentVersion(), 'by' => $actingUserId, 'manual' => true,
        ], JSON_PRETTY_PRINT));
        $this->appendHistory(['action' => 'db-export', 'at' => gmdate('c'), 'by' => $actingUserId, 'backupId' => $backupId]);
        return ['ok' => true, 'backupId' => $backupId];
    }

    public function listBackups(): array
    {
        $dir = $this->backupsDir();
        if (!is_dir($dir)) {
            return [];
        }
        $out = [];
        foreach (scandir($dir, SCANDIR_SORT_DESCENDING) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..' || !is_dir("{$dir}/{$entry}")) {
                continue;
            }
            $info = json_decode((string) @file_get_contents("{$dir}/{$entry}/backup-info.json"), true);
            $out[] = [
                'id' => $entry,
                'at' => is_array($info) ? ($info['at'] ?? null) : null,
                'version' => is_array($info) ? ($info['version'] ?? null) : null,
                'manual' => is_array($info) ? (bool) ($info['manual'] ?? false) : false,
                'hasCode' => is_dir("{$dir}/{$entry}/api"),
                'hasDatabase' => is_file("{$dir}/{$entry}/database.sql.gz"),
                'sizeBytes' => $this->dirSize("{$dir}/{$entry}"),
            ];
        }
        return array_slice($out, 0, 20);
    }

    // ── internals ────────────────────────────────────────────────────────────

    public function uploadsDir(): string
    {
        return $this->apiRoot . '/storage/upgrades';
    }

    private function stagingDir(): string
    {
        return $this->uploadsDir() . '/staging';
    }

    private function backupsDir(): string
    {
        return $this->apiRoot . '/storage/backups';
    }

    private function backupDirFor(string $backupId): string
    {
        // Ids are self-generated; still, never let a crafted id escape the backups dir.
        if (!preg_match('/^[a-zA-Z0-9\-]{1,64}$/', $backupId)) {
            throw new \RuntimeException('Invalid backup id');
        }
        $dir = $this->backupsDir() . '/' . $backupId;
        if (!is_dir($dir)) {
            throw new \RuntimeException('Backup not found');
        }
        return $dir;
    }

    /**
     * Recursive copy with top-level exclusions applied to BOTH sides: an entry
     * whose top-level name is protected is neither read from the source nor
     * written over at the destination. Returns the number of files copied.
     */
    private function copyTree(string $src, string $dst, array $excludeTopLevel): int
    {
        if (!is_dir($src)) {
            throw new \RuntimeException("Source directory missing: {$src}");
        }
        $exclude = array_map('strtolower', $excludeTopLevel);
        $count = 0;
        $entries = scandir($src) ?: [];
        foreach ($entries as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            if (in_array(strtolower(rtrim($entry, '/\\')), $exclude, true)) {
                continue;
            }
            $count += $this->copyEntry("{$src}/{$entry}", "{$dst}/{$entry}");
        }
        return $count;
    }

    private function copyEntry(string $src, string $dst): int
    {
        if (is_link($src)) {
            return 0; // never follow links out of the tree
        }
        if (is_dir($src)) {
            if (!is_dir($dst) && !@mkdir($dst, 0750, true)) {
                throw new \RuntimeException("Cannot create directory {$dst}");
            }
            $count = 0;
            foreach (scandir($src) ?: [] as $entry) {
                if ($entry === '.' || $entry === '..') {
                    continue;
                }
                $count += $this->copyEntry("{$src}/{$entry}", "{$dst}/{$entry}");
            }
            return $count;
        }
        $dir = dirname($dst);
        if (!is_dir($dir) && !@mkdir($dir, 0750, true)) {
            throw new \RuntimeException("Cannot create directory {$dir}");
        }
        if (!@copy($src, $dst)) {
            throw new \RuntimeException("Cannot copy {$src} → {$dst}");
        }
        return 1;
    }

    /**
     * Pure-PHP MySQL export (no mysqldump dependency): DROP+CREATE per table +
     * chunked INSERTs, one statement per line ("\n"/"\r" inside values are
     * \-escaped so restoreDatabase can split on newlines safely), gzip-written.
     */
    private function dumpDatabase(string $outGzPath): void
    {
        $gz = gzopen($outGzPath, 'wb6');
        if ($gz === false) {
            throw new \RuntimeException('Cannot create the database export file');
        }
        try {
            gzwrite($gz, "-- FormLogic database export " . gmdate('c') . "\n");
            gzwrite($gz, "SET NAMES utf8mb4;\n");
            gzwrite($gz, "SET FOREIGN_KEY_CHECKS=0;\n");
            $tables = $this->pdo->query('SHOW TABLES')->fetchAll(PDO::FETCH_COLUMN);
            foreach ($tables as $table) {
                $quoted = '`' . str_replace('`', '``', (string) $table) . '`';
                $create = $this->pdo->query("SHOW CREATE TABLE {$quoted}")->fetch(PDO::FETCH_ASSOC);
                $createSql = $create['Create Table'] ?? ($create['Create View'] ?? null);
                if ($createSql === null) {
                    continue;
                }
                gzwrite($gz, "DROP TABLE IF EXISTS {$quoted};\n");
                // One line per statement: collapse the pretty-printed CREATE.
                gzwrite($gz, preg_replace('/\r?\n/', ' ', $createSql) . ";\n");

                $stmt = $this->pdo->query("SELECT * FROM {$quoted}");
                $batch = [];
                while (($row = $stmt->fetch(PDO::FETCH_ASSOC)) !== false) {
                    $values = [];
                    foreach ($row as $value) {
                        if ($value === null) {
                            $values[] = 'NULL';
                        } else {
                            // Escape real newlines so every statement stays on one line.
                            $values[] = str_replace(["\r", "\n"], ['\\r', '\\n'], $this->pdo->quote((string) $value));
                        }
                    }
                    $batch[] = '(' . implode(',', $values) . ')';
                    if (count($batch) >= 200) {
                        gzwrite($gz, "INSERT INTO {$quoted} VALUES " . implode(',', $batch) . ";\n");
                        $batch = [];
                    }
                }
                if ($batch !== []) {
                    gzwrite($gz, "INSERT INTO {$quoted} VALUES " . implode(',', $batch) . ";\n");
                }
            }
            gzwrite($gz, "SET FOREIGN_KEY_CHECKS=1;\n");
        } finally {
            gzclose($gz);
        }
    }

    private function stampSchemaMeta(string $version): void
    {
        try {
            $this->pdo->exec("CREATE TABLE IF NOT EXISTS schema_meta (
                meta_key VARCHAR(64) NOT NULL PRIMARY KEY,
                meta_value TEXT NULL,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
            $stmt = $this->pdo->prepare("
                INSERT INTO schema_meta (meta_key, meta_value) VALUES
                    ('app_version', :v), ('last_upgrade_at', :at), ('upgrade_source', 'admin-panel')
                ON DUPLICATE KEY UPDATE meta_value = VALUES(meta_value)
            ");
            $stmt->execute(['v' => $version, 'at' => gmdate('c')]);
        } catch (\Throwable) {
            // stamping is informational — never fail an upgrade over it
        }
    }

    private function history(): array
    {
        $file = $this->uploadsDir() . '/history.json';
        $data = json_decode((string) @file_get_contents($file), true);
        return is_array($data) ? array_slice(array_reverse($data), 0, 20) : [];
    }

    private function appendHistory(array $entry): void
    {
        $file = $this->uploadsDir() . '/history.json';
        @mkdir(dirname($file), 0750, true);
        $data = json_decode((string) @file_get_contents($file), true);
        $data = is_array($data) ? $data : [];
        $data[] = $entry;
        @file_put_contents($file, json_encode(array_slice($data, -100), JSON_PRETTY_PRINT));
    }

    /** "v1.2.3" and sha-date dev versions both become comparable strings. */
    private function normalizeVersion(string $v): string
    {
        $v = ltrim(trim($v), 'vV');
        return preg_match('/^\d+\.\d+/', $v) ? $v : '0.0.0';
    }

    private function rrmdir(string $dir): void
    {
        if (!is_dir($dir)) {
            return;
        }
        foreach (scandir($dir) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            $path = "{$dir}/{$entry}";
            if (is_dir($path) && !is_link($path)) {
                $this->rrmdir($path);
            } else {
                @unlink($path);
            }
        }
        @rmdir($dir);
    }

    private function dirSize(string $dir): int
    {
        $size = 0;
        foreach (scandir($dir) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            $path = "{$dir}/{$entry}";
            $size += is_dir($path) ? $this->dirSize($path) : (int) @filesize($path);
        }
        return $size;
    }
}

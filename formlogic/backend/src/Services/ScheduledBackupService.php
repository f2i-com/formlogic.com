<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use FormLogic\Support\BackupEnvelope;
use FormLogic\Support\Environment;
use PDO;
use Psr\Log\LoggerInterface;
use Psr\Log\NullLogger;

/**
 * Scheduled site-wide backups (bin/backup-accounts.php, run daily from cron /
 * Task Scheduler; also runnable from the admin panel).
 *
 * Each run writes a UTC-dated folder:
 *
 *   storage/backups/scheduled/YYYY-MM-DD/
 *   ├── accounts/<userId>.zip   one full account backup per user — the EXACT
 *   │                           format Settings → Backup & restore imports
 *   ├── database.sql.gz         whole-site MySQL dump (UpgradeService dumper)
 *   ├── site-manifest.json      per-user results (sha256, sizes, errors) + totals
 *   └── RESTORE.txt             the three restore paths, spelled out
 *
 * Re-running on the same day refreshes that day's folder (idempotent); only the
 * newest `backups.retentionDays` day-folders are kept. Per-user failures are
 * recorded and skipped — one broken account must never kill the site backup.
 * The shared demo account is excluded (provisioning regenerates it).
 *
 * Restores: a single account restores through the existing import pipeline
 * (restoreAccount() / the admin user page / Settings → Restore — creates NEW
 * copies, never overwrites); a whole-site disaster restore = database.sql.gz +
 * the sqlite/upload files carried VERBATIM (original ids) inside each zip.
 */
final class ScheduledBackupService
{
    /** Set it, and every nightly file is sealed to this key: the server can write them and can't read them. */
    public const SEALING_KEY_ENV = 'BACKUP_PUBLIC_KEY';
    public const LAST_RUN_KEY = 'scheduled_backup_last_run';
    public const LAST_STATUS_KEY = 'scheduled_backup_last_status';

    private PDO $pdo;
    private LoggerInterface $logger;
    private int $retentionDays;
    private bool $includeFiles;
    private string $baseDir;

    public function __construct(
        MySQLConnection $mysql,
        private AccountBackupService $accountBackup,
        private UpgradeService $upgrade,
        array $backupConfig,
        ?LoggerInterface $logger = null,
    ) {
        $this->pdo = $mysql->getConnection();
        $this->logger = $logger ?? new NullLogger();
        $this->retentionDays = max(1, (int) ($backupConfig['retentionDays'] ?? 7));
        $this->includeFiles = (bool) ($backupConfig['scheduledIncludeFiles'] ?? true);
        // Overridable so tests never touch (or PRUNE) the real folder.
        $this->baseDir = (string) ($backupConfig['scheduledDir'] ?? dirname(__DIR__, 2) . '/storage/backups/scheduled');
    }

    /**
     * One full backup pass — staged, verified, atomically published
     * (review FL-003), under a cross-process lock owned by THIS service
     * (review FL-005: CLI, cron, and admin all funnel through here).
     *
     * @return array{date:string, users:int, ok:int, failed:int,
     *   totalBytes:int, prunedDays:string[], errors: array<int,array{userId:string,email:string,error:string}>}
     * @throws BackupAlreadyRunningException when another run holds the lock
     */
    public function run(): array
    {
        if (!$this->acquireLock()) {
            throw new BackupAlreadyRunningException();
        }
        try {
            return $this->runLocked();
        } finally {
            $this->releaseLock();
        }
    }

    private function runLocked(): array
    {
        $startedAt = gmdate('c');
        $date = gmdate('Y-m-d');
        $base = $this->scheduledDir();
        $dayDir = $base . '/' . $date;
        $this->recoverInterruptedPublish($base);

        // Build the ENTIRE run in a unique sibling staging directory; the
        // published day folder is only ever replaced by a verified complete
        // run (review FL-003 — the old code deleted the good backup first).
        $stagingDir = $base . '/.staging-' . $date . '-' . bin2hex(random_bytes(4));
        $accountsDir = $stagingDir . '/accounts';
        if (!mkdir($accountsDir, 0750, true) && !is_dir($accountsDir)) {
            throw new \RuntimeException('Could not create the scheduled backup staging directory');
        }

        try {
            $summary = $this->buildInto($stagingDir, $accountsDir, $date, $startedAt);
        } catch (\Throwable $e) {
            $this->removeDir($stagingDir);
            $this->recordFailureDiagnostic($base, $date, $e);
            throw $e;
        }

        // ── atomic publish ───────────────────────────────────────────────────
        $previous = null;
        if (is_dir($dayDir)) {
            $previous = $base . '/.previous-' . $date . '-' . bin2hex(random_bytes(4));
            if (!rename($dayDir, $previous)) {
                $this->removeDir($stagingDir);
                throw new \RuntimeException('Could not move the existing day folder aside for publication');
            }
        }
        if (!rename($stagingDir, $dayDir)) {
            if ($previous !== null) {
                @rename($previous, $dayDir); // the prior good backup must survive
            }
            $this->removeDir($stagingDir);
            throw new \RuntimeException('Could not publish the scheduled backup day folder');
        }
        if ($previous !== null) {
            $this->removeDir($previous);
        }
        @unlink($base . '/.failed-' . $date . '.json');

        // While apps can't be decrypted, older days may be the last copies of them.
        $summary['prunedDays'] = ($summary['undecryptableApps'] ?? 0) > 0 ? [] : $this->prune();
        // Heartbeat ONLY after atomic publication (review FL-003).
        $this->stampHeartbeat((string) $summary['finishedAt'], $summary);
        return $summary;
    }

    /**
     * The key nightly files are sealed to, or null when they stay plain. A key that is set but
     * wrong stops the run: an operator who asked for sealed backups must not quietly get plain ones.
     */
    private function sealingKey(): ?string
    {
        $text = Environment::nonEmpty(self::SEALING_KEY_ENV);
        if ($text === null) {
            return null;
        }
        $key = BackupEnvelope::parseKey($text);
        if ($key === null) {
            throw new \RuntimeException(self::SEALING_KEY_ENV . ' is not a valid public key');
        }
        return $key;
    }

    /** Seals $path and removes the plain file. @return string the sealed file */
    private function sealFile(string $path, string $publicKey): string
    {
        $sealed = $path . BackupEnvelope::EXTENSION;
        BackupEnvelope::seal($path, $sealed, ['publicKey' => $publicKey]);
        if (!unlink($path)) {
            throw new \RuntimeException('Could not remove the plain copy of a sealed backup');
        }
        return $sealed;
    }

    /** @return array<string,mixed> the summary (without prunedDays) */
    private function buildInto(string $stagingDir, string $accountsDir, string $date, string $startedAt): array
    {
        $sealTo = $this->sealingKey();
        $demoEmail = strtolower((string) ($_ENV['DEMO_EMAIL'] ?? 'demo@formlogic.local'));
        $stmt = $this->pdo->query('SELECT id, email FROM users ORDER BY created_at ASC, id ASC');
        $users = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $manifestUsers = [];
        $errors = [];
        $ok = 0;
        $undecryptable = 0;
        $totalBytes = 0;
        foreach ($users as $user) {
            $userId = (string) $user['id'];
            $email = (string) $user['email'];
            if (strtolower($email) === $demoEmail) {
                continue; // shared demo account is provisioning-managed
            }
            try {
                // Scheduled archives stay under operator control, so they are the ONE
                // place native app host keys are carried (audit FL-02): a site restore
                // must bring native apps back DECRYPTABLE. The Settings download never
                // includes them.
                $tmpZip = $this->accountBackup->exportAccount($userId, ['includeFiles' => $this->includeFiles, 'includeHostSecrets' => true]);
                $dest = $accountsDir . '/' . $userId . '.zip';
                if (!rename($tmpZip, $dest) && !copy($tmpZip, $dest)) {
                    @unlink($tmpZip);
                    throw new \RuntimeException('Could not move the account zip into the staging folder');
                }
                @unlink($tmpZip); // no-op after a successful rename
                $verified = $this->verifyAccountZip($dest);
                if ($sealTo !== null) {
                    $dest = $this->sealFile($dest, $sealTo);
                }
                $this->syncFile($dest);
                $size = (int) filesize($dest);
                $totalBytes += $size;
                $manifestUsers[] = [
                    'id' => $userId,
                    // The manifest stays readable, so it shouldn't list who has an account here.
                    'email' => $sealTo === null ? $email : null,
                    'file' => 'accounts/' . basename($dest),
                    'sizeBytes' => $size,
                    'sha256' => hash_file('sha256', $dest),
                    // What the zip actually carries (from ITS manifest) — a restore
                    // operator can see native apps are included without unzipping.
                    'counts' => $verified['counts'],
                    // Anything it had to leave out, such as an app waiting on recovery.
                    'warnings' => $verified['warnings'],
                ];
                $ok++;
                if ($verified['undecryptable'] > 0) {
                    $undecryptable += $verified['undecryptable'];
                    $errors[] = ['userId' => $userId, 'email' => $sealTo === null ? $email : null, 'error' => 'Left out apps that could not be decrypted: check DATA_ENCRYPTION_KEY'];
                }
            } catch (\Throwable $e) {
                // Record + continue: one broken account must not kill the site backup.
                $this->logger->error('Scheduled backup: account export failed', ['userId' => $userId, 'error' => $e->getMessage()]);
                // What didn't pass must not be published, least of all plain in a sealed day.
                foreach ([$accountsDir . '/' . $userId . '.zip', $accountsDir . '/' . $userId . '.zip' . BackupEnvelope::EXTENSION] as $left) {
                    @unlink($left);
                }
                $err = ['userId' => $userId, 'email' => $sealTo === null ? $email : null, 'error' => substr($e->getMessage(), 0, 300)];
                $errors[] = $err;
                $manifestUsers[] = $err + ['file' => null, 'sizeBytes' => 0, 'sha256' => null];
            }
        }

        // Whole-site MySQL dump (users/passwords/apps metadata — the accounts zips
        // carry the record databases; together they are a complete site backup).
        // dumpDatabase itself is snapshot-consistent, checked, verified, and
        // atomically renamed into place (review FL-004).
        $dump = $stagingDir . '/database.sql.gz';
        $this->upgrade->dumpDatabase($dump);
        if ($sealTo !== null) {
            $dump = $this->sealFile($dump, $sealTo);
        }
        $totalBytes += (int) filesize($dump);

        $finishedAt = gmdate('c');
        $summary = [
            'date' => $date,
            'users' => count($manifestUsers),
            'ok' => $ok,
            'failed' => count($errors),
            'undecryptableApps' => $undecryptable,
            'totalBytes' => $totalBytes,
            'includeFiles' => $this->includeFiles,
            'sealed' => $sealTo !== null,
            'startedAt' => $startedAt,
            'finishedAt' => $finishedAt,
        ];
        $manifestJson = json_encode([
            'kind' => 'formlogic.scheduledBackup',
            'formatVersion' => 1,
            'retentionDays' => $this->retentionDays,
        ] + $summary + ['usersDetail' => $manifestUsers, 'errors' => $errors], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
        if (!is_string($manifestJson)) {
            throw new \RuntimeException('Could not serialize the site manifest');
        }
        $this->writeChecked($stagingDir . '/site-manifest.json', $manifestJson);
        $this->writeChecked($stagingDir . '/RESTORE.txt', $this->restoreReadme());

        // Manifest completeness: every ok entry's file must exist with the
        // recorded hash before the run may publish.
        foreach ($manifestUsers as $entry) {
            if (($entry['file'] ?? null) === null) {
                continue;
            }
            $path = $stagingDir . '/' . $entry['file'];
            if (!is_file($path) || hash_file('sha256', $path) !== $entry['sha256']) {
                throw new \RuntimeException('Staged backup failed verification: ' . $entry['file']);
            }
        }

        $summary['errors'] = $errors;
        return $summary;
    }

    // ── FL-003/FL-005 internals ──────────────────────────────────────────────

    /** Cross-process mutual exclusion via a DB advisory lock (review FL-005). */
    private function acquireLock(): bool
    {
        try {
            $db = (string) $this->pdo->query('SELECT DATABASE()')->fetchColumn();
            $stmt = $this->pdo->prepare('SELECT GET_LOCK(?, 0)');
            $stmt->execute(['formlogic.scheduled_backup.' . $db]);
            return (int) $stmt->fetchColumn() === 1;
        } catch (\Throwable $e) {
            // Cannot prove exclusivity → refuse to run (fail closed).
            $this->logger->error('Scheduled backup: could not acquire the run lock', ['error' => $e->getMessage()]);
            return false;
        }
    }

    private function releaseLock(): void
    {
        try {
            $db = (string) $this->pdo->query('SELECT DATABASE()')->fetchColumn();
            $stmt = $this->pdo->prepare('SELECT RELEASE_LOCK(?)');
            $stmt->execute(['formlogic.scheduled_backup.' . $db]);
            $stmt->fetchColumn();
        } catch (\Throwable) {
            // A dropped connection releases the lock server-side anyway.
        }
    }

    /**
     * Heal a crash inside the two-step publish swap: a `.previous-<date>-*`
     * folder with NO published day folder is the last good backup — restore it.
     */
    private function recoverInterruptedPublish(string $base): void
    {
        foreach (scandir($base) ?: [] as $entry) {
            if (preg_match('/^\.previous-(\d{4}-\d{2}-\d{2})-[0-9a-f]+$/', $entry, $m) !== 1) {
                continue;
            }
            $dayDir = $base . '/' . $m[1];
            if (!is_dir($dayDir)) {
                @rename($base . '/' . $entry, $dayDir);
            }
        }
    }

    /**
     * Zip readability + backup-manifest presence + snapshot provenance before a
     * zip may publish. Every SQLite entry the manifest indexes must also carry a
     * verified snapshot record (audit FL-01): a checksum alone is not evidence
     * that the archived database is a complete logical snapshot.
     *
     * @return array{counts: array<string,int>, warnings: list<string>, undecryptable: int} the zip's own manifest counts, what it left out, and how many apps because they would not decrypt
     */
    private function verifyAccountZip(string $path): array
    {
        $zip = new \ZipArchive();
        if ($zip->open($path) !== true) {
            throw new \RuntimeException('Account zip failed readability verification');
        }
        $hasManifest = $zip->locateName('backup.json') !== false;
        $manifest = json_decode((string) $zip->getFromName('manifest.json'), true);
        $zip->close();
        if (!$hasManifest || !is_array($manifest)) {
            throw new \RuntimeException('Account zip is missing its backup manifest');
        }
        $snapshots = is_array($manifest['snapshots'] ?? null) ? $manifest['snapshots'] : [];
        foreach (array_keys(is_array($manifest['entries'] ?? null) ? $manifest['entries'] : []) as $entry) {
            if (!str_ends_with((string) $entry, '.sqlite')) {
                continue;
            }
            $record = $snapshots[$entry] ?? null;
            if (!is_array($record) || ($record['quickCheck'] ?? null) !== 'ok' || ($record['consistency'] ?? null) !== \FormLogic\Database\SqliteSnapshot::CONSISTENCY_SNAPSHOT) {
                throw new \RuntimeException('Account zip carries a database without a verified consistent snapshot record: ' . $entry);
            }
        }
        $counts = [];
        foreach (is_array($manifest['counts'] ?? null) ? $manifest['counts'] : [] as $key => $value) {
            $counts[(string) $key] = (int) $value;
        }
        $warnings = array_values(array_filter(is_array($manifest['warnings'] ?? null) ? $manifest['warnings'] : [], 'is_string'));
        return ['counts' => $counts, 'warnings' => $warnings, 'undecryptable' => (int) ($manifest['undecryptableApps'] ?? 0)];
    }

    private function writeChecked(string $path, string $content): void
    {
        if (file_put_contents($path, $content) !== strlen($content)) {
            throw new \RuntimeException('Short write while staging ' . basename($path));
        }
        $this->syncFile($path);
    }

    /** Best-effort fsync so a power loss cannot publish unsynced bytes. */
    private function syncFile(string $path): void
    {
        $h = @fopen($path, 'ab');
        if ($h === false) {
            return;
        }
        @fflush($h);
        if (function_exists('fsync')) {
            @fsync($h);
        }
        fclose($h);
    }

    /** A content-free diagnostic of the failed run (review FL-003). */
    private function recordFailureDiagnostic(string $base, string $date, \Throwable $e): void
    {
        @file_put_contents($base . '/.failed-' . $date . '.json', json_encode([
            'date' => $date,
            'failedAt' => gmdate('c'),
            'error' => substr($e->getMessage(), 0, 500),
        ], JSON_PRETTY_PRINT));
    }

    /** Day folders newest-first with their manifest summaries. */
    public function listRuns(): array
    {
        $dir = $this->scheduledDir();
        if (!is_dir($dir)) {
            return [];
        }
        $out = [];
        foreach (scandir($dir, SCANDIR_SORT_DESCENDING) ?: [] as $entry) {
            if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $entry) !== 1 || !is_dir("{$dir}/{$entry}")) {
                continue;
            }
            $manifest = json_decode((string) @file_get_contents("{$dir}/{$entry}/site-manifest.json"), true);
            $out[] = [
                'date' => $entry,
                'users' => is_array($manifest) ? (int) ($manifest['ok'] ?? 0) : 0,
                'failed' => is_array($manifest) ? (int) ($manifest['failed'] ?? 0) : 0,
                'totalBytes' => is_array($manifest) ? (int) ($manifest['totalBytes'] ?? 0) : 0,
                'finishedAt' => is_array($manifest) ? ($manifest['finishedAt'] ?? null) : null,
                'includeFiles' => is_array($manifest) ? (bool) ($manifest['includeFiles'] ?? true) : true,
                'sealed' => is_array($manifest) && ($manifest['sealed'] ?? false) === true,
                // Which accounts this day can restore (id/email/size — structure only).
                'accounts' => is_array($manifest)
                    ? array_values(array_map(
                        static fn (array $u) => ['id' => $u['id'] ?? null, 'email' => $u['email'] ?? null, 'sizeBytes' => (int) ($u['sizeBytes'] ?? 0), 'error' => $u['error'] ?? null],
                        array_filter($manifest['usersDetail'] ?? [], 'is_array')
                    ))
                    : [],
            ];
        }
        return $out;
    }

    /** @return array{lastRun: ?string, lastStatus: ?array} the heartbeat system_meta keys */
    public function lastRun(): array
    {
        $read = function (string $key): ?string {
            try {
                $stmt = $this->pdo->prepare('SELECT meta_value FROM system_meta WHERE meta_key = :k');
                $stmt->execute(['k' => $key]);
                $val = $stmt->fetchColumn();
                return ($val === false || $val === null) ? null : (string) $val;
            } catch (\Throwable) {
                return null;
            }
        };
        $statusRaw = $read(self::LAST_STATUS_KEY);
        $status = $statusRaw !== null ? json_decode($statusRaw, true) : null;
        return [
            'lastRun' => $read(self::LAST_RUN_KEY),
            'lastStatus' => is_array($status) ? $status : null,
        ];
    }

    /**
     * Admin-panel recovery: restore one account from a scheduled backup day INTO
     * that user's account (new copies — never overwrites; same pipeline as the
     * Settings → Restore upload).
     *
     * @return array the AccountBackupService::importAccount summary
     */
    public function restoreAccount(string $date, string $userId): array
    {
        if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $date) !== 1) {
            throw new \InvalidArgumentException('Invalid backup date');
        }
        $zip = $this->scheduledDir() . '/' . $date . '/accounts/' . basename($userId) . '.zip';
        if (!is_file($zip) && is_file($zip . BackupEnvelope::EXTENSION)) {
            throw new \RuntimeException('This backup is sealed, and the server cannot open it. Open the day\'s folder with backend/bin/open-backup.php and your secret key, then restore it again.');
        }
        if (!is_file($zip)) {
            throw new \RuntimeException("No backup for this account exists on {$date}");
        }
        return $this->accountBackup->importAccount($zip, $userId, ['serverHeld' => true]);
    }

    // ── internals ────────────────────────────────────────────────────────────

    /** Keep the newest retentionDays day-folders; remove the rest. @return string[] pruned */
    private function prune(): array
    {
        $dir = $this->scheduledDir();
        $days = [];
        foreach (scandir($dir) ?: [] as $entry) {
            if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $entry) === 1 && is_dir("{$dir}/{$entry}")) {
                $days[] = $entry;
            }
        }
        rsort($days); // newest first (ISO dates sort lexicographically)
        $pruned = [];
        foreach (array_slice($days, $this->retentionDays) as $old) {
            $this->removeDir("{$dir}/{$old}");
            $pruned[] = $old;
        }
        // Crash leftovers: day-old staging/previous folders and out-of-retention
        // failure diagnostics.
        foreach (scandir($dir) ?: [] as $entry) {
            $path = "{$dir}/{$entry}";
            if (preg_match('/^\.(staging|previous)-/', $entry) === 1 && is_dir($path) && (int) filemtime($path) < time() - 86400) {
                $this->removeDir($path);
            }
            if (
                preg_match('/^\.failed-(\d{4}-\d{2}-\d{2})\.json$/', $entry, $m) === 1
                && (int) strtotime($m[1] . ' UTC') < time() - $this->retentionDays * 86400
            ) {
                @unlink($path);
            }
        }
        return $pruned;
    }

    private function stampHeartbeat(string $finishedAt, array $summary): void
    {
        try {
            $stmt = $this->pdo->prepare('
                INSERT INTO system_meta (meta_key, meta_value) VALUES (:k, :v)
                ON DUPLICATE KEY UPDATE meta_value = :v2
            ');
            $stmt->execute(['k' => self::LAST_RUN_KEY, 'v' => $finishedAt, 'v2' => $finishedAt]);
            $status = (string) json_encode([
                'date' => $summary['date'], 'users' => $summary['users'], 'ok' => $summary['ok'],
                'failed' => $summary['failed'], 'totalBytes' => $summary['totalBytes'],
            ]);
            $stmt->execute(['k' => self::LAST_STATUS_KEY, 'v' => $status, 'v2' => $status]);
        } catch (\Throwable $e) {
            $this->logger->warning('Scheduled backup: could not stamp heartbeat', ['error' => $e->getMessage()]);
        }
    }

    private function scheduledDir(): string
    {
        if (!is_dir($this->baseDir) && !mkdir($this->baseDir, 0750, true) && !is_dir($this->baseDir)) {
            throw new \RuntimeException('Could not create the scheduled-backups directory');
        }
        return $this->baseDir;
    }

    private function removeDir(string $dir): void
    {
        if (!is_dir($dir)) {
            return;
        }
        foreach (scandir($dir) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            $path = $dir . '/' . $entry;
            is_dir($path) ? $this->removeDir($path) : @unlink($path);
        }
        @rmdir($dir);
    }

    private function restoreReadme(): string
    {
        return <<<TXT
FormLogic scheduled backup — how to restore
===========================================

0) SEALED FILES
   If the files here end in .flbk, the backup is sealed to your BACKUP_PUBLIC_KEY.
   Open it first, on a machine that has the secret key:
      php backend/bin/open-backup.php <this folder> --secret-key-file=<your secret key file>
   That writes the .zip and database.sql.gz beside the sealed files. Everything
   below then applies as written. The server can't open these itself.

1) ONE ACCOUNT (self-service or via the admin panel)
   accounts/<userId>.zip is a complete account backup in the same format the
   app's Settings -> Backup & restore accepts. Import it there (or an admin can
   restore it from the user's page in the admin panel). This creates NEW copies
   of the apps/forms/records — nothing existing is overwritten.

2) WHOLE SITE (disaster recovery, server access required)
   a. Restore database.sql.gz into MySQL (it is one statement per line):
      gunzip -c database.sql.gz | mysql -u <user> -p <database>
   b. Each accounts/<userId>.zip carries that user's record databases VERBATIM
      (original ids) under data/forms/*.sqlite and uploaded files under files/.
      Every *.sqlite is a single self-contained consistent snapshot (see
      'snapshots' in the zip's manifest.json) - copy it as one file:
        data/forms/*.sqlite  ->  backend/storage/forms/
        files/<formId>/*     ->  backend/storage/uploads/<formId>/
      The ids match the restored MySQL rows, so everything lines up. (A form
      whose id is not a UUID, which only the API can choose, is stored under
      another name: bring that one back through path 1.)
   c. Apps keep their own storage, in the same zip:
        native/<appId>/project.json        a native app's source and media
        native/<appId>/application.sqlite  its private record database
        native/<appId>/host-config.json    its host KEY MATERIAL - present only
                            in these scheduled archives; keep this folder as
                            private as the MySQL dump.
        hosted/<appId>/application.sqlite  a hosted app's deployment, private
                            actions and records
      Once step a is done, put them back under their original ids, so the
      restored rows, links, members and visitors' saved data find them:
        php backend/bin/restore-app-storage.php <this folder>
      Run it again whenever you like: storage already there is never replaced.
      Do NOT copy these files into backend/storage/ by hand - the names there
      are hashes of the app id and the runtime validates the source on install.
      A native app restored WITHOUT host-config.json gets new keys and says so:
      values it sealed or signed before cannot be read.

3) MOVE ACCOUNTS TO ANOTHER SERVER
   Import individual accounts/<userId>.zip files through Settings -> Backup &
   restore on the new server (ids are regenerated safely on import). Native
   apps are re-installed on the new server; it must have the native runtime
   prepared, or import with native apps skipped.

Backups exclude webhook signing secrets, app members/invitations, custom
domains and API keys (see 'excluded' in each zip's backup.json).
CONSISTENCY: each database file is one point-in-time snapshot; the set of
files plus the MySQL dump is captured sequentially, not as one global
transaction (see 'consistency' in each zip's manifest.json).
TXT;
    }
}

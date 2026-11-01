<?php

declare(strict_types=1);

// A web request never runs this. The folder can be reachable on a server without the bundle's
// rewrites, and a visit would run it with the site's credentials.
if (isset($_SERVER['REQUEST_METHOD'])) {
    http_response_code(404);
    exit;
}

/**
 * Scheduled site-wide backup (ScheduledBackupService).
 *
 * Writes storage/backups/scheduled/<YYYY-MM-DD>/ with one restorable zip per
 * account (the same format Settings → Backup & restore imports) plus a
 * whole-site MySQL dump + manifest, then prunes to backups.retentionDays
 * (default 7). Safe to re-run: the same day's folder is refreshed in place.
 *
 * Schedule it DAILY:
 *   Linux cron:
 *     15 2 * * * php /path/to/formlogic/backend/bin/backup-accounts.php >> /path/to/formlogic/backend/logs/formlogic-backup.log 2>&1
 *   Windows (Task Scheduler, this dev box):
 *     schtasks /Create /TN "FormLogic nightly backup" /SC DAILY /ST 02:15 ^
 *       /TR "php C:\wamp64\www\formlogic-app\formlogic\backend\bin\backup-accounts.php"
 *
 * Then the nightly maintenance: recycle-bin purge, upload clean-up, record retention and the
 * webhook log. That runs after a backup that failed too: a disk too full to write the dump is
 * when the space it frees is needed most.
 *
 * Exits non-zero when the run failed or ANY account failed to back up, so cron mail /
 * monitoring notices. The admin panel (Platform → Scheduled backups) shows the same runs
 * and can trigger one on demand.
 */

require __DIR__ . '/../vendor/autoload.php';

// Match the web app: PHP timezone UTC so date() aligns with the DB session.
date_default_timezone_set('UTC');

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AccountBackupService;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FlowService;
use FormLogic\Services\FormService;
use FormLogic\Services\ResponseService;
use FormLogic\Services\ScheduledBackupService;
use FormLogic\Services\TrashService;
use FormLogic\Services\UpgradeService;
use Psr\Log\NullLogger;

// Load environment + settings (mirrors public/index.php bootstrap).
if (class_exists(\Dotenv\Dotenv::class) && is_file(__DIR__ . '/../.env')) {
    \Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();
}
$config = require __DIR__ . '/../config/settings.php';
$settings = $config['settings'];

$mysql = new MySQLConnection($settings['mysql']);
try {
    $mysql->ensureSchemaCurrent();
} catch (\Throwable $e) {
    fwrite(STDERR, sprintf("[%s] schema init failed: %s\n", date('c'), $e->getMessage()));
}

// Mutual exclusion lives INSIDE ScheduledBackupService::run() (review FL-005:
// one cross-process DB advisory lock shared by cron, CLI, and the admin panel
// — a local file lock could not exclude the web process).

@set_time_limit(0);

$sqlite = new SQLiteConnection($settings['sqlite']['storage_path']);
$formService = new FormService($mysql, $sqlite);
$responseService = new ResponseService($mysql, $sqlite);
$appService = new AppService($mysql, $formService);
$flowService = new FlowService($mysql);
$accountBackup = new AccountBackupService(
    $mysql,
    $sqlite,
    $formService,
    $appService,
    new AppUserService($mysql),
    $flowService,
    $responseService,
    $settings['backups'] ?? [],
    $settings['sqlite']['storage_path'],
    $settings['uploads']['storagePath'] ?? __DIR__ . '/../storage/uploads',
    null,
    new NullLogger()
);
$scheduled = new ScheduledBackupService(
    $mysql,
    $accountBackup,
    new UpgradeService(UpgradeService::defaultApiRoot(), $mysql, new \FormLogic\Services\MaintenanceService(\FormLogic\Services\MaintenanceService::defaultPath())),
    $settings['backups'] ?? [],
    new NullLogger()
);

$exitCode = 0;
$anotherRunning = false;
try {
    $summary = $scheduled->run();
    printf(
        "[%s] backup %s: %d/%d accounts ok, %.1f MB total%s%s\n",
        date('c'),
        $summary['date'],
        $summary['ok'],
        $summary['users'],
        $summary['totalBytes'] / 1024 / 1024,
        $summary['prunedDays'] !== [] ? ', pruned ' . implode(', ', $summary['prunedDays']) : '',
        $summary['failed'] > 0 ? sprintf(', %d FAILED', $summary['failed']) : ''
    );
    foreach ($summary['errors'] as $err) {
        fwrite(STDERR, sprintf("  FAILED %s (%s): %s\n", $err['email'], $err['userId'], $err['error']));
    }
    if ($summary['failed'] > 0) {
        $exitCode = 1;
    }
} catch (\FormLogic\Services\BackupAlreadyRunningException) {
    $anotherRunning = true;
    fwrite(STDERR, sprintf("[%s] another backup run is already in progress; leaving the purges to run after a backup\n", date('c')));
} catch (\Throwable $e) {
    $exitCode = 1;
    fwrite(STDERR, sprintf("[%s] backup run FAILED: %s\n", date('c'), $e->getMessage()));
}

// The purges below delete files. A backup reads an account's files when it closes that account's
// zip, so a file deleted under it fails the whole account for the night. Beside another run they
// wait: this job, if that is what's running, does them when it finishes; the admin panel's run
// doesn't, and tomorrow night's does. Their failures are reported, and don't fail the run.
if (!$anotherRunning) {
    // Nightly maintenance shares this job: purge recycle-bin items past their
    // 30-day window (trash.retentionDays) + sweep orphaned snapshot zips.
    try {
        $trash = new TrashService(
            $mysql,
            $sqlite,
            $accountBackup,
            $formService,
            $appService,
            $flowService,
            $settings['trash'] ?? [],
            new NullLogger()
        );
        $purged = $trash->purgeExpired();
        printf("[%s] trash purge: %d expired item(s), %d orphan zip(s)\n", date('c'), $purged['items'], $purged['orphans']);
    } catch (\Throwable $e) {
        fwrite(STDERR, sprintf("[%s] trash purge FAILED: %s\n", date('c'), $e->getMessage()));
    }

    // Upload garbage collection (FILE-PRIV-001): reclaim abandoned pending uploads and
    // orphan-marked files across EVERY form — the on-mutation sweeps only fire on forms
    // with traffic, so this pass gives a time-based guarantee on quiet forms. Both
    // sweeps are reference-checked (a file a response still points at is never deleted).
    try {
        $uploadsConfig = $settings['uploads'] ?? [];
        $uploadsConfig['storagePath'] = $uploadsConfig['storagePath'] ?? __DIR__ . '/../storage/uploads';
        $fileStorage = new \FormLogic\Services\FileStorageService($uploadsConfig);
        $gcResponseService = new ResponseService($mysql, $sqlite, null, new NullLogger(), null, $fileStorage);
        $gcForms = 0;
        $gcFiles = 0;
        foreach ($mysql->getConnection()->query('SELECT id FROM forms')->fetchAll(\PDO::FETCH_COLUMN) as $gcFormId) {
            if (!$fileStorage->hasUploads((string) $gcFormId)) {
                continue;
            }
            $gcFiles += $gcResponseService->sweepFileGarbage((string) $gcFormId, true);
            $gcForms++;
        }
        printf("[%s] upload GC: %d file(s) reclaimed across %d form dir(s)\n", date('c'), $gcFiles, $gcForms);
    } catch (\Throwable $e) {
        fwrite(STDERR, sprintf("[%s] upload GC FAILED: %s\n", date('c'), $e->getMessage()));
    }

    // Records past a form's retention period.
    try {
        $retentionResponses = new ResponseService($mysql, $sqlite, null, new NullLogger(), null, $fileStorage ?? null);
        // Without it a record of a placed dataset would go with no signed tombstone, and come back on replay.
        $retentionResponses->setDataOperationLog(new \FormLogic\Services\DataOperationLogService($mysql, new \FormLogic\Services\DataCloudSigner(
            dirname((string) ($settings['uploads']['storagePath'] ?? __DIR__ . '/../storage/uploads')) . '/keys/data-cloud-signing.key',
            \FormLogic\Support\Environment::get('DATA_CLOUD_SIGNING_SEED', '') ?: null
        )));
        $expired = 0;
        foreach ($mysql->getConnection()->query("SELECT id FROM forms WHERE settings LIKE '%retentionDays%'")->fetchAll(\PDO::FETCH_COLUMN) as $retentionFormId) {
            try {
                $expired += $retentionResponses->purgeAllExpired((string) $retentionFormId);
            } catch (\Throwable $e) {
                fwrite(STDERR, sprintf("[%s] retention FAILED for form %s: %s\n", date('c'), $retentionFormId, $e->getMessage()));
            }
        }
        printf("[%s] retention: %d expired record(s)\n", date('c'), $expired);
    } catch (\Throwable $e) {
        fwrite(STDERR, sprintf("[%s] retention FAILED: %s\n", date('c'), $e->getMessage()));
    }
}

// Old webhook deliveries are rows, nothing a backup is reading, so these go either way.
try {
    $oldDeliveries = (new \FormLogic\Services\WebhookService($mysql, new NullLogger()))->purgeDeliveries();
    printf("[%s] webhook log: %d old deliverie(s)\n", date('c'), $oldDeliveries);
} catch (\Throwable $e) {
    fwrite(STDERR, sprintf("[%s] webhook log FAILED: %s\n", date('c'), $e->getMessage()));
}

exit($exitCode);

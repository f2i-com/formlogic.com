<?php

declare(strict_types=1);

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
 *     15 2 * * * php /path/to/form-builder/backend/bin/backup-accounts.php >> /var/log/formlogic-backup.log 2>&1
 *   Windows (Task Scheduler, this dev box):
 *     schtasks /Create /TN "FormLogic nightly backup" /SC DAILY /ST 02:15 ^
 *       /TR "php C:\wamp64\www\formlogic-app\form-builder\backend\bin\backup-accounts.php"
 *
 * Exits non-zero when ANY account failed to back up, so cron mail / monitoring
 * notices. The admin panel (Platform → Scheduled backups) shows the same runs
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
    $mysql->initializeSchema();
    $mysql->runMigrations();
} catch (\Throwable $e) {
    fwrite(STDERR, sprintf("[%s] schema init failed: %s\n", date('c'), $e->getMessage()));
}

// Single-instance guard so overlapping runs (cron tick + admin "Run now") don't collide.
$lockHandle = fopen(sys_get_temp_dir() . '/formlogic-account-backup.lock', 'c');
if ($lockHandle === false || !flock($lockHandle, LOCK_EX | LOCK_NB)) {
    fwrite(STDERR, sprintf("[%s] another backup run is already in progress; exiting\n", date('c')));
    exit(0);
}

@set_time_limit(0);

$sqlite = new SQLiteConnection($settings['sqlite']['storage_path']);
$formService = new FormService($mysql, $sqlite);
$responseService = new ResponseService($mysql, $sqlite);
$accountBackup = new AccountBackupService(
    $mysql,
    $sqlite,
    $formService,
    new AppService($mysql, $formService),
    new AppUserService($mysql),
    new FlowService($mysql),
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

try {
    $summary = $scheduled->run();
} catch (\Throwable $e) {
    fwrite(STDERR, sprintf("[%s] backup run FAILED: %s\n", date('c'), $e->getMessage()));
    exit(1);
}

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

exit($summary['failed'] > 0 ? 1 : 0);

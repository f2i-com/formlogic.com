<?php

declare(strict_types=1);

/**
 * Dual-store reconcile doctor.
 *
 * Reports drift between MySQL metadata (forms / response_metadata / response_links) and the
 * per-form SQLite response files:
 *   - forms with no SQLite file (and orphaned SQLite files / upload dirs with no form)
 *   - per-form response-count drift (SQLite vs response_metadata vs cached forms.response_count)
 *   - response_links pointing at a non-existent form
 *
 * Usage:
 *   php bin/reconcile.php            # read-only report
 *   php bin/reconcile.php --fix      # also apply SAFE repairs (re-sync counts, drop orphan links)
 *
 * Orphaned SQLite files / upload dirs are reported but never auto-deleted (may hold recoverable
 * data) — remove them manually after review.
 */

require __DIR__ . '/../vendor/autoload.php';
date_default_timezone_set('UTC');

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\ReconcileService;

if (class_exists(\Dotenv\Dotenv::class) && is_file(__DIR__ . '/../.env')) {
    \Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();
}
$config = require __DIR__ . '/../config/settings.php';

$mysql = new MySQLConnection($config['settings']['mysql']);
$formsPath = $config['settings']['sqlite']['storage_path'];
$sqlite = new SQLiteConnection($formsPath);
$uploadsPath = $config['settings']['uploads']['storagePath'] ?? (__DIR__ . '/../storage/uploads');

$svc = new ReconcileService($mysql->getConnection(), $sqlite, $formsPath, $uploadsPath);
$report = $svc->report();

$issues = 0;
$line = function (string $label, $value) use (&$issues): void {
    $count = is_array($value) ? count($value) : (int) $value;
    $issues += $count;
    $flag = $count > 0 ? '⚠ ' : '✓ ';
    fwrite(STDOUT, sprintf("%s%-26s %d%s\n", $flag, $label, $count,
        (is_array($value) && $count > 0 && $count <= 10) ? '  ' . implode(', ', array_map(
            fn($v) => is_array($v) ? ($v['formId'] ?? json_encode($v)) : (string) $v,
            $value
        )) : ''));
};

fwrite(STDOUT, "Dual-store reconcile report (" . date('c') . ")\n");
fwrite(STDOUT, str_repeat('-', 48) . "\n");
$line('forms missing SQLite', $report['missingSqlite']);
$line('orphaned SQLite files', $report['orphanedSqlite']);
$line('orphaned upload dirs', $report['orphanedUploads']);
$line('response-count drift', $report['countDrift']);
$line('orphaned response_links', $report['orphanedResponseLinks']);
fwrite(STDOUT, str_repeat('-', 48) . "\n");

if (in_array('--fix', $argv, true)) {
    $fixed = $svc->fix();
    fwrite(STDOUT, sprintf(
        "Applied safe repairs: re-synced %d response count(s), deleted %d orphaned link(s).\n",
        count($fixed['responseCountsResynced']),
        $fixed['orphanedLinksDeleted']
    ));
    fwrite(STDOUT, "(Orphaned SQLite files / upload dirs are left in place — remove manually after review.)\n");
} elseif ($issues > 0) {
    fwrite(STDOUT, "Run with --fix to re-sync counts and drop orphaned links.\n");
}

exit($issues > 0 ? 1 : 0);

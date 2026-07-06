<?php

declare(strict_types=1);

/**
 * Offline-sync idempotency ledger cleanup (review #15).
 *
 * The app_submission_idempotency table gains one row per (app, form, idempotency_key) so a replayed
 * offline submission returns the ORIGINAL response instead of creating a duplicate. Those rows are only
 * useful for as long as a client might replay a queued submission — after that they are dead weight, so
 * this maintenance job DELETEs rows older than IDEMPOTENCY_RETENTION_DAYS (default 30).
 *
 * Run from cron, e.g. once a day:
 *   17 3 * * * php /path/to/form-builder/backend/bin/idempotency-cleanup.php >> /var/log/formlogic-idempotency.log 2>&1
 *
 * Options:
 *   --days=N     override the retention window (else IDEMPOTENCY_RETENTION_DAYS, else 30)
 *   --dry-run    report how many rows WOULD be deleted without deleting them
 *
 * Deletes in bounded batches so a large backlog doesn't hold one long lock. Idempotent + safe to re-run.
 * The DB schema (incl. the created_at index) is created by the web app on boot; this job assumes the
 * application has been deployed at least once.
 */

require __DIR__ . '/../vendor/autoload.php';

// Match the web app: PHP timezone UTC so created_at comparisons align with the DB session.
date_default_timezone_set('UTC');

use FormLogic\Database\MySQLConnection;

/**
 * Parse the retention window (days): a --days=N CLI flag wins, else IDEMPOTENCY_RETENTION_DAYS, else 30.
 * Clamped to a minimum of 1 day so a bad value can't wipe still-live idempotency rows.
 *
 * @param array<int,string> $argv
 */
function idempotencyRetentionDays(array $argv, array $env): int
{
    $days = null;
    foreach ($argv as $arg) {
        if (preg_match('/^--days=(\d+)$/', $arg, $m)) {
            $days = (int) $m[1];
        }
    }
    if ($days === null) {
        $envVal = $env['IDEMPOTENCY_RETENTION_DAYS'] ?? null;
        if ($envVal !== null && $envVal !== '' && ctype_digit((string) $envVal)) {
            $days = (int) $envVal;
        }
    }
    if ($days === null || $days < 1) {
        $days = ($days !== null && $days < 1) ? 1 : 30;
    }
    return $days;
}

// Guard so this file is require-able from a unit test (which only exercises idempotencyRetentionDays()).
// Everything below — env/settings load + DB work — is skipped so the pure parsing function can be tested
// without a DB or a valid production settings.php.
if (PHP_SAPI !== 'cli' || (defined('IDEMPOTENCY_CLEANUP_NO_RUN') && IDEMPOTENCY_CLEANUP_NO_RUN)) {
    return;
}

// Load environment + settings (mirrors public/index.php bootstrap).
if (class_exists(\Dotenv\Dotenv::class) && is_file(__DIR__ . '/../.env')) {
    \Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();
}
$config = require __DIR__ . '/../config/settings.php';
$mysqlConfig = $config['settings']['mysql'];

$argvSafe = is_array($argv ?? null) ? $argv : [];
$dryRun = in_array('--dry-run', $argvSafe, true);
$days = idempotencyRetentionDays($argvSafe, $_ENV);

$mysql = new MySQLConnection($mysqlConfig);
// Ensure the table + created_at index exist even if this runs before the web app booted (both idempotent).
try {
    $mysql->initializeSchema();
    $mysql->runMigrations();
} catch (\Throwable $e) {
    fwrite(STDERR, sprintf("[%s] schema init failed: %s\n", date('c'), $e->getMessage()));
}
$pdo = $mysql->getConnection();

// Single-instance guard so overlapping cron ticks don't both run a pass.
$lockHandle = fopen(sys_get_temp_dir() . '/formlogic-idempotency-cleanup.lock', 'c');
if ($lockHandle === false || !flock($lockHandle, LOCK_EX | LOCK_NB)) {
    fwrite(STDERR, sprintf("[%s] another idempotency cleanup is already running; exiting\n", date('c')));
    exit(0);
}

$cutoff = (new \DateTimeImmutable("-{$days} days"))->format('Y-m-d H:i:s');

try {
    if ($dryRun) {
        $stmt = $pdo->prepare('SELECT COUNT(*) FROM app_submission_idempotency WHERE created_at < :cutoff');
        $stmt->execute(['cutoff' => $cutoff]);
        $would = (int) $stmt->fetchColumn();
        fwrite(STDOUT, sprintf(
            "[%s] idempotency cleanup DRY RUN: %d row(s) older than %d day(s) (< %s) would be deleted.\n",
            date('c'),
            $would,
            $days,
            $cutoff
        ));
        exit(0);
    }

    // Delete in bounded batches so a large backlog doesn't take one long table lock.
    $batch = 5000;
    $total = 0;
    do {
        $stmt = $pdo->prepare('DELETE FROM app_submission_idempotency WHERE created_at < :cutoff LIMIT ' . $batch);
        $stmt->execute(['cutoff' => $cutoff]);
        $deleted = $stmt->rowCount();
        $total += $deleted;
    } while ($deleted === $batch);

    fwrite(STDOUT, sprintf(
        "[%s] idempotency cleanup: deleted %d row(s) older than %d day(s) (< %s).\n",
        date('c'),
        $total,
        $days,
        $cutoff
    ));
} catch (\Throwable $e) {
    fwrite(STDERR, sprintf("[%s] idempotency cleanup error: %s\n", date('c'), $e->getMessage()));
    exit(1);
}

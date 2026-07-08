<?php

declare(strict_types=1);

/**
 * desktop_commands table cleanup (Tier-1 audit item #5).
 *
 * DesktopCommandService::enqueue() writes one row per connector_command relay call (docs/API.md
 * §connector:relay); claim()/complete() advance it to a terminal status ('done'/'failed'), and
 * expireStale() opportunistically sweeps old unclaimed 'pending' rows to 'expired' on read. Nothing
 * ever DELETEs a row, so completed/failed/expired commands accumulate forever. This maintenance job
 * DELETEs rows in a TERMINAL status ('done', 'failed', 'expired') older than
 * DESKTOP_COMMANDS_RETENTION_DAYS (default 7 — these are short-lived relay calls, not records anyone
 * needs to keep long-term), plus any leftover 'pending'/'claimed' row that is ALSO past its own
 * expires_at (a command a desktop never claimed/completed and nothing has swept yet) — never a row
 * that is still genuinely live within its expiry window, regardless of age.
 *
 * Run from cron, e.g. once a day:
 *   23 3 * * * php /path/to/form-builder/backend/bin/desktop-commands-cleanup.php >> /var/log/formlogic-desktop-commands.log 2>&1
 *
 * Options:
 *   --days=N     override the retention window (else DESKTOP_COMMANDS_RETENTION_DAYS, else 7)
 *   --dry-run    report how many rows WOULD be deleted without deleting them
 *
 * Deletes in bounded batches so a large backlog doesn't hold one long lock. Idempotent + safe to re-run.
 * The DB schema is created by the web app on boot; this job assumes the application has been deployed
 * at least once.
 */

require __DIR__ . '/../vendor/autoload.php';

// Match the web app: PHP timezone UTC so created_at comparisons align with the DB session.
date_default_timezone_set('UTC');

use FormLogic\Database\MySQLConnection;

/**
 * Parse the retention window (days): a --days=N CLI flag wins, else DESKTOP_COMMANDS_RETENTION_DAYS,
 * else 7. Clamped to a minimum of 1 day so a bad value can't wipe still-live rows.
 *
 * @param array<int,string> $argv
 */
function desktopCommandsRetentionDays(array $argv, array $env): int
{
    $days = null;
    foreach ($argv as $arg) {
        if (preg_match('/^--days=(\d+)$/', $arg, $m)) {
            $days = (int) $m[1];
        }
    }
    if ($days === null) {
        $envVal = $env['DESKTOP_COMMANDS_RETENTION_DAYS'] ?? null;
        if ($envVal !== null && $envVal !== '' && ctype_digit((string) $envVal)) {
            $days = (int) $envVal;
        }
    }
    if ($days === null || $days < 1) {
        $days = ($days !== null && $days < 1) ? 1 : 7;
    }
    return $days;
}

// Guard so this file is require-able from a unit test (which only exercises
// desktopCommandsRetentionDays()). Everything below — env/settings load + DB work — is skipped so the
// pure parsing function can be tested without a DB or a valid production settings.php.
if (PHP_SAPI !== 'cli' || (defined('DESKTOP_COMMANDS_CLEANUP_NO_RUN') && DESKTOP_COMMANDS_CLEANUP_NO_RUN)) {
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
$days = desktopCommandsRetentionDays($argvSafe, $_ENV);

$mysql = new MySQLConnection($mysqlConfig);
// Ensure the table exists even if this runs before the web app booted (both idempotent).
try {
    $mysql->initializeSchema();
    $mysql->runMigrations();
} catch (\Throwable $e) {
    fwrite(STDERR, sprintf("[%s] schema init failed: %s\n", date('c'), $e->getMessage()));
}
$pdo = $mysql->getConnection();

// Single-instance guard so overlapping cron ticks don't both run a pass.
$lockHandle = fopen(sys_get_temp_dir() . '/formlogic-desktop-commands-cleanup.lock', 'c');
if ($lockHandle === false || !flock($lockHandle, LOCK_EX | LOCK_NB)) {
    fwrite(STDERR, sprintf("[%s] another desktop-commands cleanup is already running; exiting\n", date('c')));
    exit(0);
}

$cutoff = (new \DateTimeImmutable("-{$days} days"))->format('Y-m-d H:i:s');

// Terminal statuses are safe to delete purely by age; 'pending'/'claimed' rows are only swept when
// they are ALSO past their own expires_at (a command nothing ever claimed/completed and expireStale()
// hasn't gotten to) — a still-live pending/claimed row is never touched regardless of how the
// --days window is set.
$where = "created_at < :cutoff AND (status IN ('done', 'failed', 'expired') OR expires_at < NOW())";

try {
    if ($dryRun) {
        $stmt = $pdo->prepare("SELECT COUNT(*) FROM desktop_commands WHERE {$where}");
        $stmt->execute(['cutoff' => $cutoff]);
        $would = (int) $stmt->fetchColumn();
        fwrite(STDOUT, sprintf(
            "[%s] desktop_commands cleanup DRY RUN: %d row(s) older than %d day(s) (< %s) would be deleted.\n",
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
        $stmt = $pdo->prepare("DELETE FROM desktop_commands WHERE {$where} LIMIT " . $batch);
        $stmt->execute(['cutoff' => $cutoff]);
        $deleted = $stmt->rowCount();
        $total += $deleted;
    } while ($deleted === $batch);

    fwrite(STDOUT, sprintf(
        "[%s] desktop_commands cleanup: deleted %d row(s) older than %d day(s) (< %s).\n",
        date('c'),
        $total,
        $days,
        $cutoff
    ));
} catch (\Throwable $e) {
    fwrite(STDERR, sprintf("[%s] desktop_commands cleanup error: %s\n", date('c'), $e->getMessage()));
    exit(1);
}

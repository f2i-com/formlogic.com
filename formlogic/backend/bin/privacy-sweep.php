<?php

declare(strict_types=1);

/**
 * Private-form privacy sweep (docs/E2EE_PRIVATE_FORMS_PLAN.md §12).
 *
 * Private (end-to-end encrypted) forms keep response_metadata.ip_address only for
 * abuse/rate-limit forensics. After the retention window (30 days) the address is
 * nulled out — the server should not hold long-term IP histories for respondents
 * whose answers it cannot read. user_agent/completion_time are never written for
 * private forms, so ip_address is the only column that ages out. Rows belonging to
 * non-private forms are untouched.
 *
 * Schedule with the nightly maintenance jobs, e.g.:
 *   41 3 * * * php /path/to/formlogic/backend/bin/privacy-sweep.php >> /var/log/formlogic-privacy-sweep.log 2>&1
 *
 * Options:
 *   --days=N     override the retention window (else PRIVACY_SWEEP_RETENTION_DAYS, else 30)
 *   --dry-run    report how many rows WOULD be nulled without changing them
 *
 * Idempotent + safe to re-run. The actual sweep lives in
 * FormEncryptionService::runPrivacySweep() so integration tests drive it directly.
 */

require __DIR__ . '/../vendor/autoload.php';

// Match the web app: PHP timezone UTC so submitted_at comparisons align with the DB session.
date_default_timezone_set('UTC');

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\FormEncryptionService;

/**
 * Parse the retention window (days): a --days=N CLI flag wins, else
 * PRIVACY_SWEEP_RETENTION_DAYS, else 30. Clamped to a minimum of 1 day.
 *
 * @param array<int,string> $argv
 */
function privacySweepRetentionDays(array $argv, array $env): int
{
    $days = null;
    foreach ($argv as $arg) {
        if (preg_match('/^--days=(\d+)$/', $arg, $m)) {
            $days = (int) $m[1];
        }
    }
    if ($days === null) {
        $envVal = $env['PRIVACY_SWEEP_RETENTION_DAYS'] ?? null;
        if ($envVal !== null && $envVal !== '' && ctype_digit((string) $envVal)) {
            $days = (int) $envVal;
        }
    }
    if ($days === null || $days < 1) {
        $days = ($days !== null && $days < 1) ? 1 : 30;
    }
    return $days;
}

// Guard so this file is require-able from a unit test (which only exercises
// privacySweepRetentionDays()). Everything below — env/settings load + DB work —
// is skipped. Mirrors bin/idempotency-cleanup.php.
if (PHP_SAPI !== 'cli' || (defined('PRIVACY_SWEEP_NO_RUN') && PRIVACY_SWEEP_NO_RUN)) {
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
$days = privacySweepRetentionDays($argvSafe, $_ENV);

$mysql = new MySQLConnection($mysqlConfig);
// Ensure the E2EE tables exist even if this runs before the web app booted (idempotent).
try {
    $mysql->initializeSchema();
    $mysql->runMigrations();
} catch (\Throwable $e) {
    fwrite(STDERR, sprintf("[%s] schema init failed: %s\n", date('c'), $e->getMessage()));
}

// Single-instance guard so overlapping cron ticks don't both run a pass.
$lockHandle = fopen(sys_get_temp_dir() . '/formlogic-privacy-sweep.lock', 'c');
if ($lockHandle === false || !flock($lockHandle, LOCK_EX | LOCK_NB)) {
    fwrite(STDERR, sprintf("[%s] another privacy sweep is already running; exiting\n", date('c')));
    exit(0);
}

try {
    $service = new FormEncryptionService($mysql);
    $count = $service->runPrivacySweep($days, $dryRun);
    fwrite(STDOUT, sprintf(
        $dryRun
            ? "[%s] privacy sweep DRY RUN: %d private-form response_metadata row(s) older than %d day(s) would have ip_address nulled.\n"
            : "[%s] privacy sweep: nulled ip_address on %d private-form response_metadata row(s) older than %d day(s).\n",
        date('c'),
        $count,
        $days
    ));
    exit(0);
} catch (\Throwable $e) {
    fwrite(STDERR, sprintf("[%s] privacy sweep error: %s\n", date('c'), $e->getMessage()));
    exit(1);
}

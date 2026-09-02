<?php

declare(strict_types=1);

/**
 * flow_run_logs stuck-run reclaim (Rotation 5 Tier-2 audit item #5).
 *
 * FlowService::claimRun()/claimOwnerRun() (queued→running) and a direct, non-queued
 * reserveRun()/reserveOwnerRun() (straight into running) stamp started_at = NOW() the instant a run
 * begins executing, but NOTHING in FlowService ever revisits a 'running' row afterward. If the
 * claiming FormLogic Desktop instance (or browser runtime) crashes, loses power, or loses
 * connectivity before calling completeRun()/completeOwnerRun(), the row — and anything gated on its
 * completion — is stuck at 'running' forever with no automatic retry path short of a manual DB
 * UPDATE. This maintenance job calls FlowService::reclaimStuckRuns() to revert any 'running' row
 * whose started_at is older than FLOW_RUN_STALE_SECONDS (default 600 = 10 minutes; see that
 * method's docblock for the full reasoning) to a terminal 'error' status with a clear error_json
 * message, stamping finished_at — freeing anything polling for the run's completion and making the
 * underlying trigger event retriable.
 *
 * No schema migration was needed for this fix: started_at is already set at the exact moment a run
 * transitions to 'running' (verified against every INSERT/UPDATE in FlowService.php that sets
 * status = 'running'), so it already IS the "when did this claim begin" timestamp this sweep needs.
 *
 * Run from cron, e.g. every 5 minutes — a stuck run actively blocks whatever is waiting on it, so
 * this should run more often than the nightly idempotency/desktop-commands cleanups, though far
 * less often than the 1-minute webhook-worker since a genuine crash is rare (note: the minute field
 * below is written as "0-59/5" rather than the equivalent "star-slash-5" so this cron line doesn't
 * prematurely close this very docblock comment):
 *   0-59/5 * * * * php /path/to/formlogic/backend/bin/flow-runs-reclaim.php >> /var/log/formlogic-flow-runs-reclaim.log 2>&1
 *
 * Options:
 *   --seconds=N  override the staleness threshold (else FLOW_RUN_STALE_SECONDS, else 600)
 *   --dry-run    report how many rows WOULD be reclaimed without changing them
 *
 * Reclaims in bounded batches (inside FlowService::reclaimStuckRuns()) so a large stuck backlog
 * (e.g. after an infra outage that took out every claiming instance at once) never holds one long
 * table lock. Idempotent + safe to re-run. The DB schema is created by the web app on boot; this job
 * assumes the application has been deployed at least once.
 */

require __DIR__ . '/../vendor/autoload.php';

// Match the web app: PHP timezone UTC so started_at comparisons align with the DB session.
date_default_timezone_set('UTC');

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\FlowService;

/**
 * Parse the staleness threshold (seconds): a --seconds=N CLI flag wins, else FLOW_RUN_STALE_SECONDS,
 * else 600. Clamped to a minimum of 1 second so a bad value can't reclaim genuinely-live runs.
 *
 * @param array<int,string> $argv
 */
function flowRunStaleSeconds(array $argv, array $env): int
{
    $seconds = null;
    foreach ($argv as $arg) {
        if (preg_match('/^--seconds=(\d+)$/', $arg, $m)) {
            $seconds = (int) $m[1];
        }
    }
    if ($seconds === null) {
        $envVal = $env['FLOW_RUN_STALE_SECONDS'] ?? null;
        if ($envVal !== null && $envVal !== '' && ctype_digit((string) $envVal)) {
            $seconds = (int) $envVal;
        }
    }
    if ($seconds !== null && $seconds < 1) {
        // Clamping 0 to 1 second turned a typo into "reclaim every run older than a
        // second": each cron tick flipped every in-flight run to error and every
        // later completion to 409. A nonsensical threshold falls back to the
        // default and says so.
        fwrite(STDERR, "flow-runs-reclaim: ignoring staleness threshold {$seconds}s (must be >= 1); using 600s\n");
        $seconds = null;
    }
    return $seconds ?? 600;
}

// Guard so this file is require-able from a unit test (which only exercises flowRunStaleSeconds()).
// Everything below — env/settings load + DB work — is skipped so the pure parsing function can be
// tested without a DB or a valid production settings.php.
if (PHP_SAPI !== 'cli' || (defined('FLOW_RUNS_RECLAIM_NO_RUN') && FLOW_RUNS_RECLAIM_NO_RUN)) {
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
$seconds = flowRunStaleSeconds($argvSafe, $_ENV);

$mysql = new MySQLConnection($mysqlConfig);
// Ensure the table exists even if this runs before the web app booted (both idempotent).
try {
    $mysql->initializeSchema();
    $mysql->runMigrations();
} catch (\Throwable $e) {
    fwrite(STDERR, sprintf("[%s] schema init failed: %s\n", date('c'), $e->getMessage()));
}

// Single-instance guard so overlapping cron ticks don't both run a pass.
$lockHandle = fopen(sys_get_temp_dir() . '/formlogic-flow-runs-reclaim.lock', 'c');
if ($lockHandle === false || !flock($lockHandle, LOCK_EX | LOCK_NB)) {
    fwrite(STDERR, sprintf("[%s] another flow-runs reclaim is already running; exiting\n", date('c')));
    exit(0);
}

$flows = new FlowService($mysql);

try {
    $count = $flows->reclaimStuckRuns($seconds, $dryRun);
    if ($dryRun) {
        fwrite(STDOUT, sprintf(
            "[%s] flow-runs reclaim DRY RUN: %d run(s) stuck at 'running' for more than %d second(s) would be reclaimed.\n",
            date('c'),
            $count,
            $seconds
        ));
        exit(0);
    }

    fwrite(STDOUT, sprintf(
        "[%s] flow-runs reclaim: reclaimed %d run(s) stuck at 'running' for more than %d second(s).\n",
        date('c'),
        $count,
        $seconds
    ));
} catch (\Throwable $e) {
    fwrite(STDERR, sprintf("[%s] flow-runs reclaim error: %s\n", date('c'), $e->getMessage()));
    exit(1);
}

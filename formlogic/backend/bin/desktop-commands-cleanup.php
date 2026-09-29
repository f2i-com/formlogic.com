<?php

declare(strict_types=1);

/**
 * desktop_commands table cleanup (Tier-1 audit item #5; claimed-row expiry added for Tier-2 #5).
 *
 * DesktopCommandService::enqueue() writes one row per connector_command relay call (docs/API.md
 * §connector:relay); claim()/complete() advance it to a terminal status ('done'/'failed'), and
 * expireStale() opportunistically sweeps stale rows to 'expired' on read — BOTH an unclaimed
 * 'pending' row nothing ever claimed AND a 'claimed' row whose claiming desktop crashed/lost
 * connectivity before completing it (see DesktopCommandService::expireStale() docblock). Nothing
 * ever DELETEs a row, so completed/failed/expired commands accumulate forever. This job first calls
 * expireStale() globally — so a claimed-but-abandoned row flips to 'expired' promptly instead of
 * sitting at 'claimed' for up to $days days before the DELETE below finally removes it outright —
 * then DELETEs rows in a TERMINAL status ('done', 'failed', 'expired') older than
 * DESKTOP_COMMANDS_RETENTION_DAYS (default 7 — these are short-lived relay calls, not records anyone
 * needs to keep long-term), plus any leftover 'pending'/'claimed' row that is ALSO past its own
 * expires_at (in case expireStale() above failed soft) — never a row that is still genuinely live
 * within its expiry window, regardless of age.
 *
 * That first step also sweeps the two SEALED relay lanes, desktop_ai_requests and desktop_flow_runs,
 * for EVERY owner. A poll on those lanes expires only its own owner's overdue rows (it must not reach
 * into other tenants' rows, nor scan the table for them), so an owner who never polls again would
 * otherwise keep an overdue sealed request or run, sealed body and all, until they next use the lane.
 * Expiring a row purges that body, so how long sealed content can outlive its request is bounded by
 * how often THIS job runs: nightly leaves up to a day, and hourly bounds it to the hour (the job is
 * idempotent and lock-guarded; the sweep across all owners scans the three tables, which is fine at
 * cron cadence).
 *
 * Run from cron, e.g. once a day:
 *   23 3 * * * php /path/to/formlogic/backend/bin/desktop-commands-cleanup.php >> /var/log/formlogic-desktop-commands.log 2>&1
 *
 * Options:
 *   --days=N     override the retention window (else DESKTOP_COMMANDS_RETENTION_DAYS, else 7)
 *   --dry-run    report how many rows WOULD be expired/deleted (on all three lanes) without changing them
 *
 * Deletes in bounded batches so a large backlog doesn't hold one long lock. Idempotent + safe to re-run.
 * The DB schema is created by the web app on boot; this job assumes the application has been deployed
 * at least once.
 */

require __DIR__ . '/../vendor/autoload.php';

// Match the web app: PHP timezone UTC so created_at comparisons align with the DB session.
date_default_timezone_set('UTC');

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\DesktopAiRelayService;
use FormLogic\Services\DesktopCommandService;
use FormLogic\Services\DesktopFlowRelayService;

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

/**
 * The sweep this job runs first, on every relay lane and for EVERY owner (expireStale() with no owner):
 * the connector commands, the sealed AI requests and the sealed flow runs. A swept AI request or flow run
 * also has its sealed body purged. Each lane's sweep fails soft, as it does on a poll.
 *
 * With $dryRun nothing is changed: the result is how many rows the real sweep would expire right now,
 * by the same two predicates each service applies —
 *   - 'pending' rows past their own expires_at (nothing claimed them in time);
 *   - 'claimed' (and, on the AI and flow lanes, 'streaming') rows whose claimed_at — NOT expires_at,
 *     which is fixed at enqueue() time and can pass while a claimed row is still genuinely in flight —
 *     is older than that lane's CLAIMED_STALE_SECONDS.
 * (The flow lane's read-once purge of old unread results is not an expiry and is not counted.)
 *
 * @return array{commands:int, ai:int, flow:int} rows expired, or with $dryRun rows that would be
 */
function desktopRelaySweep(MySQLConnection $mysql, bool $dryRun): array
{
    if (!$dryRun) {
        return [
            'commands' => (new DesktopCommandService($mysql))->expireStale(),
            'ai' => (new DesktopAiRelayService($mysql))->expireStale(),
            'flow' => (new DesktopFlowRelayService($mysql))->expireStale(),
        ];
    }
    $pdo = $mysql->getConnection();
    // The interpolated values are class constants and literals, never input.
    $count = static fn (string $table, string $inFlight, int $silentSeconds): int => (int) $pdo->query(
        "SELECT COUNT(*) FROM {$table} WHERE "
        . "(status = 'pending' AND expires_at <= NOW()) "
        . "OR (status IN ({$inFlight}) AND claimed_at IS NOT NULL AND claimed_at < (NOW() - INTERVAL {$silentSeconds} SECOND))"
    )->fetchColumn();
    return [
        'commands' => $count('desktop_commands', "'claimed'", DesktopCommandService::CLAIMED_STALE_SECONDS),
        'ai' => $count('desktop_ai_requests', "'claimed', 'streaming'", DesktopAiRelayService::CLAIMED_STALE_SECONDS),
        'flow' => $count('desktop_flow_runs', "'claimed', 'streaming'", DesktopFlowRelayService::CLAIMED_STALE_SECONDS),
    ];
}

// Guard so this file is require-able from a unit test (which only exercises
// desktopCommandsRetentionDays() and desktopRelaySweep()). Everything below — env/settings load + DB work — is
// skipped so those functions can be tested without a valid production settings.php.
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
        // Report (never mutate) how many stale rows each lane's expireStale() would flip to 'expired'
        // (see desktopRelaySweep() for the predicates, which are those methods' own, as a SELECT).
        $staleWould = desktopRelaySweep($mysql, true);
        fwrite(STDOUT, sprintf(
            "[%s] desktop_commands cleanup DRY RUN: %d stale pending/claimed row(s) would be expired.\n",
            date('c'),
            $staleWould['commands']
        ));
        fwrite(STDOUT, sprintf(
            "[%s] desktop_ai_requests cleanup DRY RUN: %d stale pending/claimed/streaming request(s) would be expired and their sealed content purged.\n",
            date('c'),
            $staleWould['ai']
        ));
        fwrite(STDOUT, sprintf(
            "[%s] desktop_flow_runs cleanup DRY RUN: %d stale pending/claimed/streaming run(s) would be expired and their sealed content purged.\n",
            date('c'),
            $staleWould['flow']
        ));

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

    // Real run only: expire stale pending/claimed rows FIRST (see docblock) so a crashed desktop's
    // claimed-but-abandoned command is visible as 'expired' well before the age-based delete below
    // ever gets to it — and so an idle owner's overdue sealed AI requests and flow runs lose their
    // sealed content, which no poll of theirs will do for them.
    $expired = desktopRelaySweep($mysql, false);
    fwrite(STDOUT, sprintf("[%s] desktop_commands cleanup: expired %d stale pending/claimed row(s).\n", date('c'), $expired['commands']));
    fwrite(STDOUT, sprintf("[%s] desktop_ai_requests cleanup: expired %d stale pending/claimed/streaming request(s), sealed content purged.\n", date('c'), $expired['ai']));
    fwrite(STDOUT, sprintf("[%s] desktop_flow_runs cleanup: expired %d stale pending/claimed/streaming run(s), sealed content purged.\n", date('c'), $expired['flow']));

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

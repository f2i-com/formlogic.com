<?php

declare(strict_types=1);

/**
 * flow_outcome_events recovery sweep (extensible-flows plan §9/§14.5).
 *
 * Outcome events are normally dispatched INLINE right after the terminal transition
 * commits; a row left 'pending' means that inline dispatch never finished (process died,
 * DB hiccup). This job re-dispatches them at-least-once — handler enqueues are idempotent
 * (UNIQUE flowoutcome:<runId>:<bindingId> keys), so replays are no-ops. Rows that keep
 * failing park as 'failed' after the attempt ceiling. Safe to re-run; single-instance
 * locked. Cron it beside flow-runs-reclaim.php (every few minutes is plenty).
 */

require __DIR__ . '/../vendor/autoload.php';

date_default_timezone_set('UTC');

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\FlowService;

if (PHP_SAPI !== 'cli') {
    return;
}

if (class_exists(\Dotenv\Dotenv::class) && is_file(__DIR__ . '/../.env')) {
    \Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();
}
$config = require __DIR__ . '/../config/settings.php';

$mysql = new MySQLConnection($config['settings']['mysql']);
try {
    $mysql->initializeSchema();
    $mysql->runMigrations();
} catch (\Throwable $e) {
    fwrite(STDERR, sprintf("[%s] schema init failed: %s\n", date('c'), $e->getMessage()));
}

$lockHandle = fopen(sys_get_temp_dir() . '/formlogic-flow-outcome-dispatch.lock', 'c');
if ($lockHandle === false || !flock($lockHandle, LOCK_EX | LOCK_NB)) {
    fwrite(STDERR, sprintf("[%s] another outcome dispatch is already running; exiting\n", date('c')));
    exit(0);
}

$flows = new FlowService($mysql);

try {
    // Audit FL-03: first re-emit outcome rows that were LOST after their terminal
    // transition committed (cloud-runner / reclaim emission failures) — then
    // re-dispatch anything still pending.
    $reconciled = $flows->reconcileMissingOutcomeEvents();
    $processed = $flows->dispatchPendingOutcomeEvents(200);
    fwrite(STDOUT, sprintf(
        "[%s] flow-outcome dispatch: reconciled %d missing event(s), processed %d pending event(s).\n",
        date('c'),
        $reconciled,
        $processed
    ));
    exit(0);
} catch (\Throwable $e) {
    fwrite(STDERR, sprintf("[%s] flow-outcome dispatch failed: %s\n", date('c'), $e->getMessage()));
    exit(1);
}

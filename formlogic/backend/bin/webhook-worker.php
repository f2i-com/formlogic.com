<?php

declare(strict_types=1);

// A web request never runs this. The folder can be reachable on a server without the bundle's
// rewrites, and a visit would run it with the site's credentials.
if (isset($_SERVER['REQUEST_METHOD'])) {
    http_response_code(404);
    exit;
}

/**
 * Webhook retry worker.
 *
 * Re-delivers webhook events that failed their initial (synchronous) attempt,
 * using exponential backoff (1m, 5m, 30m, 2h, 6h) up to 5 attempts. SSRF guards
 * are re-applied at send time inside WebhookService, so deferred retries are safe.
 *
 * Run from cron, e.g. once a minute:
 *   * * * * * php /path/to/formlogic/backend/bin/webhook-worker.php >> /path/to/formlogic/backend/logs/formlogic-webhooks.log 2>&1
 *
 * Or run continuously (for hosts without cron) — sleeps 60s between passes, or --interval=N:
 *   php bin/webhook-worker.php --loop
 * It exits 1 after a database error, for the supervisor or the next cron run to start a new one.
 *
 * The DB schema (retry columns) is created automatically by the web app on boot;
 * this worker assumes the application has been deployed at least once.
 */

require __DIR__ . '/../vendor/autoload.php';

// Match the web app: PHP timezone UTC so date() aligns with the DB session.
date_default_timezone_set('UTC');

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\WebhookService;
use Psr\Log\NullLogger;

// Load environment + settings (mirrors public/index.php bootstrap).
if (class_exists(\Dotenv\Dotenv::class) && is_file(__DIR__ . '/../.env')) {
    \Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();
}
$config = require __DIR__ . '/../config/settings.php';
$mysqlConfig = $config['settings']['mysql'];

$mysql = new MySQLConnection($mysqlConfig);
// Ensure the retry columns exist even if the worker runs before the web app
// has booted (under the lock the web app migrates under).
try {
    $mysql->ensureSchemaCurrent();
} catch (\Throwable $e) {
    fwrite(STDERR, sprintf("[%s] schema init failed: %s\n", date('c'), $e->getMessage()));
}
$webhookService = new WebhookService($mysql, new NullLogger());

// Single-instance guard so overlapping cron ticks don't both run a pass.
$lockHandle = \FormLogic\Support\CronLock::take('webhook-worker');
if ($lockHandle === null) {
    fwrite(STDERR, sprintf("[%s] another webhook worker is already running; exiting\n", date('c')));
    exit(0);
}

$loop = in_array('--loop', $argv, true);
$interval = 60;
foreach ($argv as $arg) {
    if (preg_match('/^--interval=([1-9]\d*)$/D', $arg, $m)) {
        $interval = (int) $m[1];
    }
}

do {
    try {
        $result = $webhookService->processPendingRetries();
        if ($result['processed'] > 0) {
            fwrite(STDOUT, sprintf(
                "[%s] webhook retries: processed=%d sent=%d failed=%d abandoned=%d\n",
                date('c'),
                $result['processed'],
                $result['sent'],
                $result['failed'],
                $result['abandoned']
            ));
        }
    } catch (\PDOException $e) {
        fwrite(STDERR, sprintf("[%s] webhook worker database error: %s\n", date('c'), $e->getMessage()));
        // This connection can't be trusted again: WebhookService keeps it, so every later pass
        // would fail too while this process kept the lock and cron took it to be running. Let go
        // of both, and whatever runs this next starts with a new connection.
        flock($lockHandle, LOCK_UN);
        exit(1);
    } catch (\Throwable $e) {
        fwrite(STDERR, sprintf("[%s] webhook worker error: %s\n", date('c'), $e->getMessage()));
    }

    if ($loop) {
        sleep($interval);
    }
} while ($loop);

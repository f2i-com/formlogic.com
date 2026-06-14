<?php

declare(strict_types=1);

/**
 * Webhook retry worker.
 *
 * Re-delivers webhook events that failed their initial (synchronous) attempt,
 * using exponential backoff (1m, 5m, 30m, 2h, 6h) up to 5 attempts. SSRF guards
 * are re-applied at send time inside WebhookService, so deferred retries are safe.
 *
 * Run from cron, e.g. once a minute:
 *   * * * * * php /path/to/form-builder/backend/bin/webhook-worker.php >> /var/log/formlogic-webhooks.log 2>&1
 *
 * Or run continuously (for hosts without cron) — sleeps 60s between passes:
 *   php bin/webhook-worker.php --loop
 *
 * The DB schema (retry columns) is created automatically by the web app on boot;
 * this worker assumes the application has been deployed at least once.
 */

require __DIR__ . '/../vendor/autoload.php';

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
$webhookService = new WebhookService($mysql, new NullLogger());

$loop = in_array('--loop', $argv, true);

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
    } catch (\Throwable $e) {
        fwrite(STDERR, sprintf("[%s] webhook worker error: %s\n", date('c'), $e->getMessage()));
    }

    if ($loop) {
        sleep(60);
    }
} while ($loop);

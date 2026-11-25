<?php

declare(strict_types=1);

// A web request never runs this. The folder can be reachable on a server without the bundle's
// rewrites, and a visit would run it with the site's credentials.
if (isset($_SERVER['REQUEST_METHOD'])) {
    http_response_code(404);
    exit;
}

/**
 * SRV-404 artifact cleanup sweep.
 *
 * Removes exactly the artifacts whose `expires_at` has passed — oldest first — and unlinks their
 * stored bytes. Deterministic and idempotent: the same database state always produces the same
 * removal set, and a second run immediately after removes nothing.
 *
 * Expiry is a property of the ref, not of this job: an expired artifact already refuses to
 * resolve, so a late or missed sweep costs disk, never access. That separation is what lets this
 * run on an ordinary cron schedule without being security-critical.
 *
 * Cron it beside flow-runs-reclaim.php (hourly is ample).
 */

require __DIR__ . '/../vendor/autoload.php';

date_default_timezone_set('UTC');

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\Flows\ArtifactService;

if (PHP_SAPI !== 'cli') {
    return;
}

if (class_exists(\Dotenv\Dotenv::class) && is_file(__DIR__ . '/../.env')) {
    \Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();
}
\FormLogic\Support\Environment::bootstrap();
$settings = require __DIR__ . '/../config/settings.php';
$config = $settings['settings']['mysql'];

$lockHandle = \FormLogic\Support\CronLock::take('artifact-sweep');
if ($lockHandle === null) {
    fwrite(STDERR, sprintf("[%s] another artifact sweep is already running; exiting\n", date('c')));
    exit(0);
}

try {
    $mysql = new MySQLConnection($config);
    try {
        $mysql->ensureSchemaCurrent();
    } catch (\Throwable $e) {
        fwrite(STDERR, sprintf("[%s] schema init failed: %s\n", date('c'), $e->getMessage()));
    }
    $summary = (new ArtifactService($mysql))->sweep(2000);
    // Drafts for the SoftN directory expire the same way: a site where nobody drafts again would keep them.
    $drafts = \FormLogic\Services\SoftnDirectoryService::sweepExpired($mysql->getConnection());
} catch (\Throwable $e) {
    fwrite(STDERR, 'Artifact sweep failed: ' . $e->getMessage() . "\n");
    exit(1);
}

printf(
    "Artifact sweep: removed %d artifact(s), freed %s bytes; %d expired directory draft(s).\n",
    $summary['removed'],
    number_format($summary['bytesFreed']),
    $drafts
);

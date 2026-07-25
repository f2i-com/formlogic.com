<?php

declare(strict_types=1);

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

$config = [
    'host' => $_ENV['DB_HOST'] ?? 'localhost',
    'port' => $_ENV['DB_PORT'] ?? '3306',
    'database' => $_ENV['DB_DATABASE'] ?? 'formlogic',
    'username' => $_ENV['DB_USERNAME'] ?? 'formlogic',
    'password' => $_ENV['DB_PASSWORD'] ?? '',
    'charset' => 'utf8mb4',
    'collation' => 'utf8mb4_unicode_ci',
];

try {
    $mysql = new MySQLConnection($config);
    $summary = (new ArtifactService($mysql))->sweep(2000);
} catch (\Throwable $e) {
    fwrite(STDERR, 'Artifact sweep failed: ' . $e->getMessage() . "\n");
    exit(1);
}

printf(
    "Artifact sweep: removed %d artifact(s), freed %s bytes.\n",
    $summary['removed'],
    number_format($summary['bytesFreed'])
);

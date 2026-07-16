<?php

/**
 * Idempotent schema migrations for an EXISTING FormLogic database.
 *
 * Fresh installs get the full schema from schema.sql; this script applies schema
 * changes that were added after the initial install. It is safe to run repeatedly.
 *
 * Usage (from the backend/ directory):
 *     php database/migrate.php
 */

declare(strict_types=1);

require __DIR__ . '/../vendor/autoload.php';
Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();

use FormLogic\Database\MySQLConnection;

$conf = [
    'host' => $_ENV['DB_HOST'] ?? 'localhost',
    'port' => $_ENV['DB_PORT'] ?? '3306',
    'database' => $_ENV['DB_DATABASE'] ?? 'formlogic',
    'username' => $_ENV['DB_USERNAME'] ?? 'formlogic',
    'password' => $_ENV['DB_PASSWORD'] ?? '',
    'charset' => 'utf8mb4',
    'collation' => 'utf8mb4_unicode_ci',
];

try {
    $pdo = (new MySQLConnection($conf))->getConnection();
} catch (Throwable $e) {
    fwrite(STDERR, 'Database connection failed: ' . $e->getMessage() . "\n");
    exit(1);
}

$db = $conf['database'];

$columnExists = static function (PDO $pdo, string $db, string $table, string $column): bool {
    $stmt = $pdo->prepare(
        'SELECT 1 FROM information_schema.columns
         WHERE table_schema = :db AND table_name = :t AND column_name = :c LIMIT 1'
    );
    $stmt->execute(['db' => $db, 't' => $table, 'c' => $column]);
    return (bool) $stmt->fetchColumn();
};

$applied = [];

// 1. Shared rate-limit / login-throttle store (commit aa802fc).
$pdo->exec("CREATE TABLE IF NOT EXISTS `rate_limits` (
  `bucket` char(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `window_start` bigint NOT NULL,
  `hits` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`bucket`,`window_start`),
  KEY `idx_window_start` (`window_start`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$applied[] = 'rate_limits table ensured';

// 2. JWT revocation: users.token_version (commit aff594d).
if (!$columnExists($pdo, $db, 'users', 'token_version')) {
    $pdo->exec('ALTER TABLE `users` ADD COLUMN `token_version` int NOT NULL DEFAULT 0');
    $applied[] = 'users.token_version added';
} else {
    $applied[] = 'users.token_version already present';
}

// 3. Aokie v2 endpoint identity and peer-roster pinning.
$aokieColumns = [
    'holder_key_thumbprint' => 'ALTER TABLE `aokie_companion_devices` ADD COLUMN `holder_key_thumbprint` varchar(64) NULL AFTER `grants`',
    'endpoint_public_key' => 'ALTER TABLE `aokie_companion_devices` ADD COLUMN `endpoint_public_key` json NULL AFTER `holder_key_thumbprint`',
    'approved_peer_key_thumbprints' => 'ALTER TABLE `aokie_companion_devices` ADD COLUMN `approved_peer_key_thumbprints` json NULL AFTER `endpoint_public_key`',
    'peer_roster_revision' => 'ALTER TABLE `aokie_companion_devices` ADD COLUMN `peer_roster_revision` bigint unsigned NULL AFTER `approved_peer_key_thumbprints`',
    'peer_roster_hash' => 'ALTER TABLE `aokie_companion_devices` ADD COLUMN `peer_roster_hash` varchar(64) NULL AFTER `peer_roster_revision`',
    'desktop_connection_id' => 'ALTER TABLE `aokie_companion_devices` ADD COLUMN `desktop_connection_id` varchar(36) NULL AFTER `peer_roster_hash`',
];
foreach ($aokieColumns as $column => $ddl) {
    if (!$columnExists($pdo, $db, 'aokie_companion_devices', $column)) {
        $pdo->exec($ddl);
        $applied[] = "aokie_companion_devices.{$column} added";
    } else {
        $applied[] = "aokie_companion_devices.{$column} already present";
    }
}
$index = $pdo->prepare(
    'SELECT 1 FROM information_schema.statistics
     WHERE table_schema = :db AND table_name = :t AND index_name = :i LIMIT 1'
);
$index->execute([
    'db' => $db,
    't' => 'aokie_companion_devices',
    'i' => 'idx_aokie_companion_desktop',
]);
if ($index->fetchColumn() === false) {
    $pdo->exec('ALTER TABLE `aokie_companion_devices` ADD INDEX `idx_aokie_companion_desktop` (`desktop_connection_id`)');
    $applied[] = 'aokie_companion_devices desktop index added';
} else {
    $applied[] = 'aokie_companion_devices desktop index already present';
}

echo "Migrations complete for database '{$db}':\n";
foreach ($applied as $step) {
    echo "  - {$step}\n";
}

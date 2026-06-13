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

echo "Migrations complete for database '{$db}':\n";
foreach ($applied as $step) {
    echo "  - {$step}\n";
}

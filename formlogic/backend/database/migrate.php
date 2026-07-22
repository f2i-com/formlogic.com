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

// 4. Hosted Aokie Companion relay mailbox (pack services wave 2). The seq
//    AUTO_INCREMENT is the delivery cursor; rows are opaque signed frames with
//    a 120s TTL swept on every relay POST.
$pdo->exec("CREATE TABLE IF NOT EXISTS `aokie_companion_relay_frames` (
  `seq` bigint unsigned NOT NULL AUTO_INCREMENT,
  `app_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `to_party` varchar(120) COLLATE utf8mb4_unicode_ci NOT NULL,
  `from_party` varchar(120) COLLATE utf8mb4_unicode_ci NOT NULL,
  `admission_subject_id` varchar(200) COLLATE utf8mb4_unicode_ci NULL,
  `admission_grants` json NULL,
  `frame` mediumtext COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`seq`),
  KEY `idx_aokie_relay_inbox` (`app_id`,`to_party`,`seq`),
  KEY `idx_aokie_relay_expiry` (`created_at`),
  CONSTRAINT `aokie_companion_relay_frames_ibfk_1` FOREIGN KEY (`app_id`) REFERENCES `apps` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$applied[] = 'aokie_companion_relay_frames table ensured';
if (!$columnExists($pdo, $db, 'aokie_companion_relay_frames', 'admission_subject_id')) {
    // Nullable by design: pre-subject rows are explicitly unauthenticated and
    // are exposed as subjectId:null rather than trusting their inner payload.
    $pdo->exec('ALTER TABLE `aokie_companion_relay_frames` ADD COLUMN `admission_subject_id` varchar(200) COLLATE utf8mb4_unicode_ci NULL AFTER `from_party`');
    $applied[] = 'aokie_companion_relay_frames.admission_subject_id added';
} else {
    $applied[] = 'aokie_companion_relay_frames.admission_subject_id already present';
}
if (!$columnExists($pdo, $db, 'aokie_companion_relay_frames', 'admission_grants')) {
    // Nullable by design: rows written by the pre-authority relay become NULL
    // and are exposed as grants:[] rather than inheriting any authority.
    $pdo->exec('ALTER TABLE `aokie_companion_relay_frames` ADD COLUMN `admission_grants` json NULL AFTER `from_party`');
    $applied[] = 'aokie_companion_relay_frames.admission_grants added';
} else {
    $applied[] = 'aokie_companion_relay_frames.admission_grants already present';
}

// 5. E2EE Private Forms (docs/E2EE_PRIVATE_FORMS_PLAN.md §7). All byte fields are
//    raw bytes in VARBINARY/MEDIUMBLOB; public keys are canonical base64 VARCHAR.
//    Deliberately NO foreign keys to forms/users: these rows survive a form's
//    trash → restore round trip and are lifecycle-managed by TrashService.
$pdo->exec("CREATE TABLE IF NOT EXISTS `user_vaults` (
  `user_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `version` int NOT NULL DEFAULT '1',
  `kdf` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `kdf_salt` varbinary(16) NOT NULL,
  `kdf_memlimit` int unsigned NOT NULL,
  `kdf_opslimit` int unsigned NOT NULL,
  `wrapped_umk` varbinary(128) NOT NULL,
  `wrapped_umk_recovery` varbinary(128) DEFAULT NULL,
  `enc_key_bundle` varbinary(512) NOT NULL,
  `x25519_pk` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `ed25519_pk` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  PRIMARY KEY (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$applied[] = 'user_vaults table ensured';

$pdo->exec("CREATE TABLE IF NOT EXISTS `form_encryption` (
  `form_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `mode` enum('private') COLLATE utf8mb4_unicode_ci NOT NULL,
  `current_ingest_epoch` int NOT NULL DEFAULT '1',
  `current_fk_epoch` int NOT NULL DEFAULT '1',
  `state` enum('active','trashed') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active',
  `enabled_by` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `enabled_at` datetime DEFAULT NULL,
  PRIMARY KEY (`form_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$applied[] = 'form_encryption table ensured';

$pdo->exec("CREATE TABLE IF NOT EXISTS `form_schema_versions` (
  `id` varchar(40) COLLATE utf8mb4_unicode_ci NOT NULL,
  `form_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `version` int NOT NULL,
  `schema_json` mediumblob NOT NULL,
  `schema_hash` char(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_form_version` (`form_id`,`version`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$applied[] = 'form_schema_versions table ensured';

$pdo->exec("CREATE TABLE IF NOT EXISTS `form_ingestion_keys` (
  `id` varchar(40) COLLATE utf8mb4_unicode_ci NOT NULL,
  `form_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `epoch` int NOT NULL,
  `public_key` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `wrapped_secret` varbinary(128) NOT NULL,
  `fk_epoch` int NOT NULL,
  `state` enum('active','retiring','retired','trashed') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active',
  `accept_until` datetime DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_form_epoch` (`form_id`,`epoch`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$applied[] = 'form_ingestion_keys table ensured';

$pdo->exec("CREATE TABLE IF NOT EXISTS `form_manifests` (
  `id` varchar(40) COLLATE utf8mb4_unicode_ci NOT NULL,
  `form_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `manifest_seq` int NOT NULL,
  `key_id` varchar(40) COLLATE utf8mb4_unicode_ci NOT NULL,
  `ingest_epoch` int NOT NULL,
  `schema_version` int NOT NULL,
  `schema_hash` char(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `content_suite` varchar(48) COLLATE utf8mb4_unicode_ci NOT NULL,
  `wrap_suite` varchar(48) COLLATE utf8mb4_unicode_ci NOT NULL,
  `signer_key_id` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL,
  `signer_pk` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `signed_bytes` mediumblob NOT NULL,
  `signature` varbinary(64) NOT NULL,
  `created_at` datetime NOT NULL,
  `expires_at` datetime DEFAULT NULL,
  `superseded_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_form_seq` (`form_id`,`manifest_seq`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$applied[] = 'form_manifests table ensured';

$pdo->exec("CREATE TABLE IF NOT EXISTS `form_key_grants` (
  `id` varchar(40) COLLATE utf8mb4_unicode_ci NOT NULL,
  `form_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `user_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `fk_epoch` int NOT NULL,
  `wrapped_key` varbinary(128) NOT NULL,
  `wrap_suite` varchar(48) COLLATE utf8mb4_unicode_ci NOT NULL,
  `role` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'owner',
  `grantor_user_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `grantor_key_id` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL,
  `grantee_pk` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `sig_version` smallint NOT NULL DEFAULT '1',
  `signature` varbinary(64) NOT NULL,
  `expires_at` datetime DEFAULT NULL,
  `state` enum('active','revoked','trashed') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active',
  `created_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_form_user_epoch` (`form_id`,`user_id`,`fk_epoch`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$applied[] = 'form_key_grants table ensured';

// Durable publication history: v1 private forms are strictly post-feature creations.
if (!$columnExists($pdo, $db, 'forms', 'ever_published_at')) {
    $pdo->exec('ALTER TABLE `forms` ADD COLUMN `ever_published_at` datetime DEFAULT NULL AFTER `published_at`');
    $pdo->exec('UPDATE `forms` SET `ever_published_at` = NOW()');
    $applied[] = 'forms.ever_published_at added + backfilled';
} else {
    $applied[] = 'forms.ever_published_at already present';
}
echo "Migrations complete for database '{$db}':\n";
foreach ($applied as $step) {
    echo "  - {$step}\n";
}

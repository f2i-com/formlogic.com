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
// 5b. form_encryption.state was created here without 'enabling' while schema.sql and
//     FormEncryptionService::beginEnable both use it (enable-race hardening, commit
//     a15b04e). Widen the enum on DBs that came through the old migrate block.
$stateType = $pdo->prepare(
    'SELECT COLUMN_TYPE FROM information_schema.columns
     WHERE table_schema = ? AND table_name = ? AND column_name = ?'
);
$stateType->execute([$db, 'form_encryption', 'state']);
$stateColumn = (string) $stateType->fetchColumn();
if ($stateColumn !== '' && !str_contains($stateColumn, 'enabling')) {
    $pdo->exec("ALTER TABLE `form_encryption` MODIFY `state`
        enum('enabling','active','trashed') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active'");
    $applied[] = "form_encryption.state widened to include 'enabling'";
} else {
    $applied[] = 'form_encryption.state already includes enabling';
}

// 6. Encrypted data nodes — N0 schema skeleton
//    (docs/FORMLOGIC_DESKTOP_ENCRYPTED_DATA_NODES_PLAN.md §22, docs/FORMLOGIC_DATA_NODES.md).
//    Signed artifacts store their exact canonical bytes (flcanon/1) so hashes/signatures
//    re-verify byte-for-byte. data_nodes carries no FK to desktop_connections on purpose:
//    unlinking a connection revokes the node (status), it never silently deletes history.
$pdo->exec("CREATE TABLE IF NOT EXISTS `data_nodes` (
  `id` varchar(40) COLLATE utf8mb4_unicode_ci NOT NULL,
  `desktop_connection_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `owner_user_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `workspace_id` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `display_name` varchar(120) COLLATE utf8mb4_unicode_ci NOT NULL,
  `signing_public_key` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `signing_key_id` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL,
  `signing_key_generation` int NOT NULL DEFAULT '1',
  `fingerprint` char(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `transport_key_fingerprint` char(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `owner_signed_certificate` mediumblob DEFAULT NULL,
  `certificate_expires_at` datetime DEFAULT NULL,
  `protocol_min` int NOT NULL DEFAULT '1',
  `protocol_max` int NOT NULL DEFAULT '1',
  `capabilities_json` json DEFAULT NULL,
  `roster_revision` int NOT NULL DEFAULT '1',
  `last_seen_at` datetime DEFAULT NULL,
  `last_storage_heartbeat_at` datetime DEFAULT NULL,
  `status` enum('pending','approved','revoked') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  `revoked_at` datetime DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_data_node_connection` (`desktop_connection_id`),
  KEY `idx_data_node_owner` (`owner_user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$applied[] = 'data_nodes table ensured';

$pdo->exec("CREATE TABLE IF NOT EXISTS `data_placement_manifests` (
  `id` varchar(40) COLLATE utf8mb4_unicode_ci NOT NULL,
  `dataset_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `form_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `storage_epoch` int NOT NULL,
  `manifest_hash` char(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `previous_manifest_hash` char(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `primary_replica_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `signed_bytes` mediumblob NOT NULL,
  `owner_signer_key_id` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL,
  `owner_signer_fingerprint` char(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_dataset_epoch` (`dataset_id`,`storage_epoch`),
  KEY `idx_placement_form` (`form_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$applied[] = 'data_placement_manifests table ensured';

$pdo->exec("CREATE TABLE IF NOT EXISTS `data_dataset_high_water` (
  `dataset_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `storage_epoch` int NOT NULL,
  `last_acknowledged_sequence` bigint NOT NULL DEFAULT '0',
  `last_operation_hash` char(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `checkpoint_hash` char(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `placement_manifest_hash` char(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `tombstone_ledger_coverage_sequence` bigint NOT NULL DEFAULT '0',
  `tombstone_ledger_root` char(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  PRIMARY KEY (`dataset_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$applied[] = 'data_dataset_high_water table ensured';

// 7. Immutable flow revisions (extensible-flows plan §14.2). Minted LAZILY at run-reserve
//    time (FlowService::ensureFlowVersion) — no backfill needed: an existing flow gets its
//    first revision row the next time it runs. definition_json is MEDIUMTEXT (never JSON —
//    a JSON column re-normalizes bytes and the digest is over the exact bytes stored).
$pdo->exec("CREATE TABLE IF NOT EXISTS `flow_definition_versions` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `flow_definition_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `version` int NOT NULL,
  `graph_version` int NOT NULL DEFAULT '1',
  `definition_json` mediumtext COLLATE utf8mb4_unicode_ci NOT NULL,
  `definition_digest` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_flow_def_version` (`flow_definition_id`,`version`),
  KEY `idx_fdv_flow` (`flow_definition_id`),
  CONSTRAINT `flow_definition_versions_ibfk_1` FOREIGN KEY (`flow_definition_id`) REFERENCES `flow_definitions` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$applied[] = 'flow_definition_versions table ensured';

$hasFlowVersionCol = $pdo->prepare(
    'SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?'
);
$hasFlowVersionCol->execute([$db, 'flow_run_logs', 'flow_version_id']);
if ((int) $hasFlowVersionCol->fetchColumn() === 0) {
    $pdo->exec("ALTER TABLE `flow_run_logs` ADD COLUMN `flow_version_id` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL AFTER `flow_definition_id`");
    $applied[] = 'flow_run_logs.flow_version_id added';
} else {
    $applied[] = 'flow_run_logs.flow_version_id already present';
}

// 8. Run lineage (extensible-flows plan §8.7/§14.1): parent/root/call-node/depth on
//    flow_run_logs, server-derived at reserve time. Roots keep NULL parent/root, depth 0.
$hasLineageCol = $pdo->prepare(
    'SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?'
);
foreach ([
    'parent_run_id' => "ALTER TABLE `flow_run_logs` ADD COLUMN `parent_run_id` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL AFTER `flow_version_id`",
    'root_run_id' => "ALTER TABLE `flow_run_logs` ADD COLUMN `root_run_id` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL AFTER `parent_run_id`",
    'call_node_id' => "ALTER TABLE `flow_run_logs` ADD COLUMN `call_node_id` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL AFTER `root_run_id`",
    'depth' => "ALTER TABLE `flow_run_logs` ADD COLUMN `depth` int NOT NULL DEFAULT '0' AFTER `call_node_id`",
] as $column => $ddl) {
    $hasLineageCol->execute([$db, 'flow_run_logs', $column]);
    if ((int) $hasLineageCol->fetchColumn() === 0) {
        $pdo->exec($ddl);
        $applied[] = "flow_run_logs.{$column} added";
    } else {
        $applied[] = "flow_run_logs.{$column} already present";
    }
}
$hasLineageIdx = $pdo->prepare(
    'SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?'
);
foreach (['idx_frl_root' => 'root_run_id', 'idx_frl_parent' => 'parent_run_id'] as $index => $column) {
    $hasLineageIdx->execute([$db, 'flow_run_logs', $index]);
    if ((int) $hasLineageIdx->fetchColumn() === 0) {
        $pdo->exec("ALTER TABLE `flow_run_logs` ADD INDEX `{$index}` (`{$column}`)");
        $applied[] = "flow_run_logs.{$index} added";
    } else {
        $applied[] = "flow_run_logs.{$index} already present";
    }
}

// 9. Canonical terminal outcome events (extensible-flows plan §9/§14.5): the outbox rows
//    behind flow.succeeded/failed/timed_out/cancelled triggers. UNIQUE run_id =
//    exactly-once emission; dispatch is inline post-commit + the recovery sweep.
$pdo->exec("CREATE TABLE IF NOT EXISTS `flow_outcome_events` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `run_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `app_id` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `owner_user_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `flow_definition_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `event_name` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `payload_json` json NOT NULL,
  `dispatch_status` varchar(12) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  `attempts` int NOT NULL DEFAULT '0',
  `dispatched_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_outcome_run` (`run_id`),
  KEY `idx_foe_pending` (`dispatch_status`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$applied[] = 'flow_outcome_events table ensured';

// 10. Blueprints (extensible-flows plan §11/§14, Phase 6 groundwork): identity + separate
//     semantic/layout revisions, elements (nodes AND relationship edges, tombstoned),
//     canvas-only layouts, and the §14.3 audited ID-addressed operation log.
$pdo->exec("CREATE TABLE IF NOT EXISTS `blueprints` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `owner_user_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `app_id` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `name` varchar(120) COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'draft',
  `semantic_revision` int NOT NULL DEFAULT '0',
  `layout_revision` int NOT NULL DEFAULT '0',
  `viewport_json` json DEFAULT NULL,
  `created_by` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `updated_by` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_bp_owner` (`owner_user_id`,`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$pdo->exec("CREATE TABLE IF NOT EXISTS `blueprint_elements` (
  `id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `blueprint_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `element_type` varchar(24) COLLATE utf8mb4_unicode_ci NOT NULL,
  `resource_ref_json` json DEFAULT NULL,
  `properties_json` json DEFAULT NULL,
  `semantic_revision` int NOT NULL DEFAULT '0',
  `deleted_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`blueprint_id`,`id`),
  KEY `idx_bpe_live` (`blueprint_id`,`deleted_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$pdo->exec("CREATE TABLE IF NOT EXISTS `blueprint_layouts` (
  `blueprint_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `element_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `layout_json` json NOT NULL,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`blueprint_id`,`element_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$pdo->exec("CREATE TABLE IF NOT EXISTS `blueprint_operations` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `operation_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `blueprint_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `change_set_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `seq` int NOT NULL DEFAULT '0',
  `op_type` varchar(48) COLLATE utf8mb4_unicode_ci NOT NULL,
  `target_id` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `payload_json` json DEFAULT NULL,
  `inverse_json` json DEFAULT NULL,
  `semantic_revision` int DEFAULT NULL,
  `layout_revision` int DEFAULT NULL,
  `actor_user_id` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `origin` varchar(24) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'manual',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_bpop_op` (`blueprint_id`,`operation_id`),
  KEY `idx_bpop_bp` (`blueprint_id`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$applied[] = 'blueprint tables ensured';

// 11. Blueprint↔resource association (§11A D4): pull-sync + reverse lookup.
$pdo->exec("CREATE TABLE IF NOT EXISTS `blueprint_resource_links` (
  `blueprint_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `element_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `resource_type` varchar(24) COLLATE utf8mb4_unicode_ci NOT NULL,
  `resource_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `last_observed_version` varchar(32) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `materialisation_status` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'materialised',
  `change_set_id` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`blueprint_id`,`element_id`),
  KEY `idx_bprl_resource` (`resource_type`,`resource_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$applied[] = 'blueprint_resource_links table ensured';

// 12. Copilot change sets (extensible-flows plan §12/§14.1): proposed batches awaiting
//     user approval, rendered as ghost previews on the diagram canvas.
$pdo->exec("CREATE TABLE IF NOT EXISTS `builder_change_sets` (
  `id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `blueprint_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `owner_user_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'proposed',
  `origin` varchar(24) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'copilot',
  `intent_summary` varchar(300) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `base_semantic_revision` int NOT NULL DEFAULT '0',
  `operations_json` json NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `resolved_at` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_bcs_bp` (`blueprint_id`,`status`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$applied[] = 'builder_change_sets table ensured';

// 13. Per-user default reasoning effort for the Codex/ChatGPT desktop connector.
if (!$columnExists($pdo, $db, 'user_ai_settings', 'desktop_reasoning')) {
    $pdo->exec('ALTER TABLE `user_ai_settings` ADD COLUMN `desktop_reasoning` varchar(16) NULL AFTER `chat_tool_mode`');
    $applied[] = 'user_ai_settings.desktop_reasoning added';
} else {
    $applied[] = 'user_ai_settings.desktop_reasoning already present';
}

// 14. Tenant-scoped idempotency keys (audit FL-08): the desktop relay/command lanes and the
//     flow-run reserve gate were globally UNIQUE on idempotency_key alone, letting one tenant
//     consume (or probe) another tenant's predictable key. Desktop lanes scope by owner; flow
//     runs scope by flow definition. Composite uniqueness is strictly weaker than the old
//     global one, so existing rows can never violate the new index — no data migration needed.
$idemIndexCols = $pdo->prepare(
    'SELECT COUNT(*) FROM information_schema.statistics
     WHERE table_schema = ? AND table_name = ? AND index_name = ?'
);
foreach ([
    ['desktop_ai_requests', 'uniq_desktop_ai_idem', 'owner_user_id'],
    ['desktop_commands', 'uniq_desktop_command_idem', 'owner_user_id'],
    ['desktop_flow_runs', 'uniq_desktop_flow_run_idem', 'owner_user_id'],
    ['flow_run_logs', 'uniq_flow_run_idem', 'flow_definition_id'],
] as [$idemTable, $idemIndex, $idemScopeCol]) {
    $idemIndexCols->execute([$db, $idemTable, $idemIndex]);
    if ((int) $idemIndexCols->fetchColumn() === 1) {
        $pdo->exec("ALTER TABLE `{$idemTable}` DROP INDEX `{$idemIndex}`, ADD UNIQUE KEY `{$idemIndex}` (`{$idemScopeCol}`, `idempotency_key`)");
        $applied[] = "{$idemTable}.{$idemIndex} rescoped to ({$idemScopeCol}, idempotency_key)";
    } else {
        $applied[] = "{$idemTable}.{$idemIndex} already scoped";
    }
}

// 15. Staged data-node artifact ownership (review FL-002): every staged snapshot /
//     sealed account backup gets an owner/node row; GET/DELETE require an exact
//     ownership match, and deletion is a crash-resumable active→deleting→gone
//     state machine. Artifact IDs alone (128 random bits) are no longer treated
//     as authorization.
$pdo->exec("CREATE TABLE IF NOT EXISTS `data_staged_artifacts` (
  `id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `kind` enum('snapshot','account_backup') COLLATE utf8mb4_unicode_ci NOT NULL,
  `owner_user_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `node_id` varchar(40) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `state` enum('active','deleting') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active',
  `created_at` datetime DEFAULT NULL,
  `expires_at` datetime NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_staged_artifact_owner` (`owner_user_id`),
  KEY `idx_staged_artifact_expiry` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$applied[] = 'data_staged_artifacts table ensured';

// 16. App Studio publish/version state: apps.published_version + apps.published_at,
//     and the app_versions publish-history table (one row per publish; version
//     copied from apps.published_version after the bump).
foreach ([
    'published_version' => 'ALTER TABLE `apps` ADD COLUMN `published_version` int NOT NULL DEFAULT 0 AFTER `custom_logic`',
    'published_at' => 'ALTER TABLE `apps` ADD COLUMN `published_at` timestamp NULL DEFAULT NULL AFTER `published_version`',
] as $column => $ddl) {
    if (!$columnExists($pdo, $db, 'apps', $column)) {
        $pdo->exec($ddl);
        $applied[] = "apps.{$column} added";
    } else {
        $applied[] = "apps.{$column} already present";
    }
}
$pdo->exec("CREATE TABLE IF NOT EXISTS `app_versions` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `app_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `version` int NOT NULL,
  `label` varchar(160) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `published_by` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_app_version` (`app_id`,`version`),
  KEY `idx_av_app` (`app_id`),
  CONSTRAINT `app_versions_ibfk_1` FOREIGN KEY (`app_id`) REFERENCES `apps` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$applied[] = 'app_versions table ensured';

// 17. Application Package v2 (ADR-010 / PKG-104 subset): the aggregate installation unit
//     (node-only extensions install WITHOUT creating forms/apps) plus the contributed
//     flow-node definition registry. One active version per package per owner; one active
//     contributed type per owner; definitions cascade with their installation.
$pdo->exec("CREATE TABLE IF NOT EXISTS `package_installations` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `user_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `package_id` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  `publisher_id` varchar(96) COLLATE utf8mb4_unicode_ci NOT NULL,
  `kind` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `version` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `display_name` varchar(120) COLLATE utf8mb4_unicode_ci NOT NULL,
  `state` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'ready',
  `source` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'json',
  `receipt_json` mediumtext COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_pkgi_active` (`user_id`,`package_id`),
  KEY `idx_pkgi_user` (`user_id`),
  CONSTRAINT `package_installations_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$applied[] = 'package_installations table ensured';
$pdo->exec("CREATE TABLE IF NOT EXISTS `flow_node_definitions` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `user_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `installation_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `node_type` varchar(160) COLLATE utf8mb4_unicode_ci NOT NULL,
  `version` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `digest` char(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `definition_json` mediumtext COLLATE utf8mb4_unicode_ci NOT NULL,
  `enabled` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_fnd_type` (`user_id`,`node_type`),
  KEY `idx_fnd_install` (`installation_id`),
  CONSTRAINT `flow_node_definitions_ibfk_1` FOREIGN KEY (`installation_id`) REFERENCES `package_installations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
$applied[] = 'flow_node_definitions table ensured';

echo "Migrations complete for database '{$db}':\n";
foreach ($applied as $step) {
    echo "  - {$step}\n";
}

-- FormLogic MySQL schema (structure only) — GENERATED from a fully-migrated database.
--
-- This file must always match what src/Database/MySQLConnection.php (initializeSchema +
-- runMigrations) produces: those are the single source of truth, and the app also runs them
-- on every boot / via api/bin/upgrade.php, so an install that imported a stale copy of this
-- file self-heals on first request. Regenerate after adding tables/migrations with:
--
--   mysqldump --no-data --skip-comments --skip-add-drop-table --routines=0 --triggers=0 \
--     -u <user> -p <database> | sed -E 's/ AUTO_INCREMENT=[0-9]+//' > database/schema.sql
--   (then re-add this header)
--


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `api_keys` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `user_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `key_prefix` varchar(12) COLLATE utf8mb4_unicode_ci NOT NULL,
  `key_hash` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `scopes` json NOT NULL,
  `form_ids` json DEFAULT NULL,
  `last_used_at` timestamp NULL DEFAULT NULL,
  `last_used_ip` varchar(45) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `expires_at` timestamp NULL DEFAULT NULL,
  `is_active` tinyint(1) DEFAULT '1',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `idx_api_keys_hash` (`key_hash`),
  KEY `idx_api_keys_user` (`user_id`),
  CONSTRAINT `api_keys_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `api_tokens` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `user_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `token_hash` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `last_used_at` timestamp NULL DEFAULT NULL,
  `expires_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_user_id` (`user_id`),
  KEY `idx_token_hash` (`token_hash`),
  CONSTRAINT `api_tokens_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `app_domains` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `app_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `owner_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `domain` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `normalized_domain` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `mode` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'launch_page',
  `status` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  `verification_method` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'dns_txt',
  `verification_token` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  `verified_at` datetime DEFAULT NULL,
  `tls_status` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  `landing_config` json DEFAULT NULL,
  `security_config` json DEFAULT NULL,
  `pwa_config` json DEFAULT NULL,
  `native_config` json DEFAULT NULL,
  `last_checked_at` datetime DEFAULT NULL,
  `last_error` text COLLATE utf8mb4_unicode_ci,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `idx_app_domains_norm` (`normalized_domain`),
  KEY `idx_app_domains_app` (`app_id`),
  KEY `idx_app_domains_owner` (`owner_id`),
  KEY `idx_app_domains_status` (`status`),
  CONSTRAINT `app_domains_ibfk_1` FOREIGN KEY (`app_id`) REFERENCES `apps` (`id`) ON DELETE CASCADE,
  CONSTRAINT `app_domains_ibfk_2` FOREIGN KEY (`owner_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `app_flow_bindings` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `app_id` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `form_id` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `connector_id` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `flow_definition_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `event_name` varchar(150) COLLATE utf8mb4_unicode_ci NOT NULL,
  `mode` enum('sync','async','background','manual') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'async',
  `condition_json` json DEFAULT NULL,
  `input_map_json` json DEFAULT NULL,
  `output_actions_json` json DEFAULT NULL,
  `timeout_ms` int NOT NULL DEFAULT '30000',
  `retry_policy_json` json DEFAULT NULL,
  `fallback_policy_json` json DEFAULT NULL,
  `enabled` tinyint(1) NOT NULL DEFAULT '1',
  `sort_order` int DEFAULT '0',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `form_id` (`form_id`),
  KEY `idx_afb_app` (`app_id`),
  KEY `idx_afb_flow` (`flow_definition_id`),
  KEY `idx_afb_event` (`app_id`,`event_name`),
  CONSTRAINT `app_flow_bindings_ibfk_1` FOREIGN KEY (`app_id`) REFERENCES `apps` (`id`) ON DELETE CASCADE,
  CONSTRAINT `app_flow_bindings_ibfk_2` FOREIGN KEY (`form_id`) REFERENCES `forms` (`id`) ON DELETE CASCADE,
  CONSTRAINT `app_flow_bindings_ibfk_3` FOREIGN KEY (`flow_definition_id`) REFERENCES `flow_definitions` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `app_forms` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `app_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `form_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `display_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `sort_order` int DEFAULT '0',
  `is_visible` tinyint(1) DEFAULT '1',
  `settings` json DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_app_form` (`app_id`,`form_id`),
  KEY `idx_app_id` (`app_id`),
  KEY `idx_sort_order` (`sort_order`),
  KEY `idx_form_id` (`form_id`),
  CONSTRAINT `app_forms_ibfk_1` FOREIGN KEY (`app_id`) REFERENCES `apps` (`id`) ON DELETE CASCADE,
  CONSTRAINT `app_forms_ibfk_2` FOREIGN KEY (`form_id`) REFERENCES `forms` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `app_invitations` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `app_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `email` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `role_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `token_hash` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `invited_by` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` enum('pending','accepted','expired','revoked') COLLATE utf8mb4_unicode_ci DEFAULT 'pending',
  `expires_at` timestamp NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `role_id` (`role_id`),
  KEY `invited_by` (`invited_by`),
  KEY `idx_app_id` (`app_id`),
  KEY `idx_email` (`email`),
  KEY `idx_token_hash` (`token_hash`),
  KEY `idx_status` (`status`),
  CONSTRAINT `app_invitations_ibfk_1` FOREIGN KEY (`app_id`) REFERENCES `apps` (`id`) ON DELETE CASCADE,
  CONSTRAINT `app_invitations_ibfk_2` FOREIGN KEY (`role_id`) REFERENCES `app_roles` (`id`) ON DELETE CASCADE,
  CONSTRAINT `app_invitations_ibfk_3` FOREIGN KEY (`invited_by`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `app_role_permissions` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `role_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `form_id` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `permission` varchar(191) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_role_perm` (`role_id`,`form_id`,`permission`),
  KEY `form_id` (`form_id`),
  KEY `idx_role_id` (`role_id`),
  CONSTRAINT `app_role_permissions_ibfk_1` FOREIGN KEY (`role_id`) REFERENCES `app_roles` (`id`) ON DELETE CASCADE,
  CONSTRAINT `app_role_permissions_ibfk_2` FOREIGN KEY (`form_id`) REFERENCES `forms` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `app_roles` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `app_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` text COLLATE utf8mb4_unicode_ci,
  `is_system` tinyint(1) DEFAULT '0',
  `sort_order` int DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_app_role` (`app_id`,`name`),
  KEY `idx_app_id` (`app_id`),
  CONSTRAINT `app_roles_ibfk_1` FOREIGN KEY (`app_id`) REFERENCES `apps` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `app_submission_idempotency` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `app_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `form_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `user_id` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `idempotency_key` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  `response_id` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `payload_hash` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'completed',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_app_form_key` (`app_id`,`form_id`,`idempotency_key`),
  KEY `idx_idem_app` (`app_id`),
  KEY `idx_idem_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `app_user_group_members` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `group_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `app_user_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_group_member` (`group_id`,`app_user_id`),
  KEY `app_user_id` (`app_user_id`),
  KEY `idx_group_id` (`group_id`),
  CONSTRAINT `app_user_group_members_ibfk_1` FOREIGN KEY (`group_id`) REFERENCES `app_user_groups` (`id`) ON DELETE CASCADE,
  CONSTRAINT `app_user_group_members_ibfk_2` FOREIGN KEY (`app_user_id`) REFERENCES `app_users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `app_user_groups` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `app_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` text COLLATE utf8mb4_unicode_ci,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_app_group` (`app_id`,`name`),
  KEY `idx_app_id` (`app_id`),
  CONSTRAINT `app_user_groups_ibfk_1` FOREIGN KEY (`app_id`) REFERENCES `apps` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `app_users` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `app_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `user_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `role_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` enum('pending','active','suspended') COLLATE utf8mb4_unicode_ci DEFAULT 'active',
  `invited_by` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `invited_at` timestamp NULL DEFAULT NULL,
  `joined_at` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_app_user` (`app_id`,`user_id`),
  KEY `role_id` (`role_id`),
  KEY `idx_app_id` (`app_id`),
  KEY `idx_user_id` (`user_id`),
  CONSTRAINT `app_users_ibfk_1` FOREIGN KEY (`app_id`) REFERENCES `apps` (`id`) ON DELETE CASCADE,
  CONSTRAINT `app_users_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `app_users_ibfk_3` FOREIGN KEY (`role_id`) REFERENCES `app_roles` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `apps` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `owner_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `slug` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` text COLLATE utf8mb4_unicode_ci,
  `logo_url` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `status` enum('draft','published','archived') COLLATE utf8mb4_unicode_ci DEFAULT 'draft',
  `settings` json DEFAULT NULL,
  `theme` json DEFAULT NULL,
  `nav_config` json DEFAULT NULL,
  `custom_screen` mediumtext COLLATE utf8mb4_unicode_ci,
  `custom_screen_trust` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'untrusted',
  `custom_screen_provenance` json DEFAULT NULL,
  `reports` json DEFAULT NULL,
  `custom_logic` mediumtext COLLATE utf8mb4_unicode_ci,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `slug` (`slug`),
  KEY `idx_owner_id` (`owner_id`),
  KEY `idx_slug` (`slug`),
  KEY `idx_status` (`status`),
  CONSTRAINT `apps_ibfk_1` FOREIGN KEY (`owner_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `audit_log` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `user_id` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `action` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `resource_type` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `resource_id` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `details` text COLLATE utf8mb4_unicode_ci,
  `ip_address` varchar(45) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `integrity_hash` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `sequence_number` bigint unsigned DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `idx_audit_sequence_number` (`sequence_number`),
  KEY `idx_audit_user_id` (`user_id`),
  KEY `idx_audit_action` (`action`),
  KEY `idx_audit_resource` (`resource_type`,`resource_id`),
  KEY `idx_audit_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `audit_sequence` (
  `id` int NOT NULL AUTO_INCREMENT,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `desktop_commands` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `owner_user_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `app_id` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `connector_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `command` varchar(96) COLLATE utf8mb4_unicode_ci NOT NULL,
  `payload_json` json DEFAULT NULL,
  `idempotency_key` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` enum('pending','claimed','done','failed','expired') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  `result_json` json DEFAULT NULL,
  `error_json` json DEFAULT NULL,
  `requested_by_user_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `target_instance_id` varchar(128) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `claimed_by` varchar(120) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `claimed_at` timestamp NULL DEFAULT NULL,
  `finished_at` timestamp NULL DEFAULT NULL,
  `expires_at` timestamp NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_desktop_command_idem` (`idempotency_key`),
  KEY `app_id` (`app_id`),
  KEY `idx_desktop_command_poll` (`owner_user_id`,`status`,`created_at`),
  CONSTRAINT `desktop_commands_ibfk_1` FOREIGN KEY (`owner_user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `desktop_commands_ibfk_2` FOREIGN KEY (`app_id`) REFERENCES `apps` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `desktop_connections` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `owner_user_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `device_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `desktop_instance_id` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  `api_key_id` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `last_seen_at` timestamp NULL DEFAULT NULL,
  `capabilities_json` json DEFAULT NULL,
  `trusted_origins_json` json DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_desktop_instance` (`owner_user_id`,`desktop_instance_id`),
  KEY `idx_desktop_owner` (`owner_user_id`),
  CONSTRAINT `desktop_connections_ibfk_1` FOREIGN KEY (`owner_user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `flow_definitions` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `owner_user_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `app_id` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `slug` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` text COLLATE utf8mb4_unicode_ci,
  `engine` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'f2i',
  `flow_json` json NOT NULL,
  `input_schema` json DEFAULT NULL,
  `output_schema` json DEFAULT NULL,
  `node_capabilities` json DEFAULT NULL,
  `version` int NOT NULL DEFAULT '1',
  `enabled` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_app_flow_slug` (`app_id`,`slug`),
  KEY `idx_flow_owner` (`owner_user_id`),
  KEY `idx_flow_app` (`app_id`),
  CONSTRAINT `flow_definitions_ibfk_1` FOREIGN KEY (`owner_user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `flow_definitions_ibfk_2` FOREIGN KEY (`app_id`) REFERENCES `apps` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `flow_kv` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `owner_user_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `app_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
  `scope` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `k` varchar(190) COLLATE utf8mb4_unicode_ci NOT NULL,
  `v` mediumtext COLLATE utf8mb4_unicode_ci,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_flow_kv` (`owner_user_id`,`app_id`,`scope`,`k`),
  KEY `idx_flow_kv_scope` (`owner_user_id`,`app_id`,`scope`),
  CONSTRAINT `flow_kv_ibfk_1` FOREIGN KEY (`owner_user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `flow_run_logs` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `app_id` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `form_id` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `response_id` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `binding_id` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `flow_definition_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `trigger_event` varchar(150) COLLATE utf8mb4_unicode_ci NOT NULL,
  `correlation_id` varchar(150) COLLATE utf8mb4_unicode_ci NOT NULL,
  `idempotency_key` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'running',
  `runtime` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `claimed_by` varchar(120) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `input_snapshot_json` json DEFAULT NULL,
  `result_json` json DEFAULT NULL,
  `output_actions_json` json DEFAULT NULL,
  `error_json` json DEFAULT NULL,
  `started_at` timestamp NULL DEFAULT NULL,
  `finished_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_flow_run_idem` (`idempotency_key`),
  KEY `idx_frl_app` (`app_id`),
  KEY `idx_frl_flow` (`flow_definition_id`),
  KEY `idx_frl_binding` (`binding_id`),
  KEY `idx_frl_status` (`app_id`,`status`),
  KEY `idx_frl_created` (`created_at`),
  CONSTRAINT `flow_run_logs_ibfk_1` FOREIGN KEY (`app_id`) REFERENCES `apps` (`id`) ON DELETE CASCADE,
  CONSTRAINT `flow_run_logs_ibfk_2` FOREIGN KEY (`flow_definition_id`) REFERENCES `flow_definitions` (`id`) ON DELETE CASCADE,
  CONSTRAINT `flow_run_logs_ibfk_3` FOREIGN KEY (`binding_id`) REFERENCES `app_flow_bindings` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `form_analytics` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `form_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `date` date NOT NULL,
  `views` int DEFAULT '0',
  `starts` int DEFAULT '0',
  `completions` int DEFAULT '0',
  `avg_completion_time` int DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_form_date` (`form_id`,`date`),
  KEY `idx_form_id` (`form_id`),
  KEY `idx_date` (`date`),
  CONSTRAINT `form_analytics_ibfk_1` FOREIGN KEY (`form_id`) REFERENCES `forms` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `form_versions` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `form_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `version` int NOT NULL,
  `data` json NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `created_by` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `changelog` text COLLATE utf8mb4_unicode_ci,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_form_version` (`form_id`,`version`),
  KEY `idx_form_id` (`form_id`),
  CONSTRAINT `form_versions_ibfk_1` FOREIGN KEY (`form_id`) REFERENCES `forms` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `forms` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `user_id` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `title` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` text COLLATE utf8mb4_unicode_ci,
  `status` enum('draft','published','archived') COLLATE utf8mb4_unicode_ci DEFAULT 'draft',
  `field_count` int unsigned DEFAULT '0',
  `response_count` int unsigned DEFAULT NULL,
  `settings` json DEFAULT NULL,
  `theme` json DEFAULT NULL,
  `logic_script` text COLLATE utf8mb4_unicode_ci,
  `logic_prompt` text COLLATE utf8mb4_unicode_ci,
  `custom_screen` mediumtext COLLATE utf8mb4_unicode_ci,
  `custom_screen_trust` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'untrusted',
  `custom_screen_provenance` json DEFAULT NULL,
  `custom_logic` mediumtext COLLATE utf8mb4_unicode_ci,
  `icon` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `published_at` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_user_id` (`user_id`),
  KEY `idx_status` (`status`),
  KEY `idx_created_at` (`created_at`),
  KEY `idx_user_updated` (`user_id`,`updated_at`,`id`),
  CONSTRAINT `forms_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `mcp_oauth_clients` (
  `client_id_hash` char(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `client_id` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL,
  `secret_hash` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `token_endpoint_auth_method` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'client_secret_post',
  `client_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `client_uri` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `redirect_uris` json NOT NULL,
  `is_cimd` tinyint(1) NOT NULL DEFAULT '0',
  `fetched_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`client_id_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `mcp_oauth_codes` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `code_hash` char(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `client_id` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL,
  `user_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `app_id` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `redirect_uri` varchar(1000) COLLATE utf8mb4_unicode_ci NOT NULL,
  `scopes` json NOT NULL,
  `code_challenge` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  `resource` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `device_label` varchar(120) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `expires_at` timestamp NOT NULL,
  `used_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `idx_oauth_code_hash` (`code_hash`),
  KEY `idx_oauth_code_user` (`user_id`),
  KEY `idx_oauth_code_expires` (`expires_at`),
  CONSTRAINT `mcp_oauth_codes_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `mcp_oauth_refresh_tokens` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `token_hash` char(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `family_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `client_id` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL,
  `user_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `app_id` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `scopes` json NOT NULL,
  `resource` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `device_id` varchar(200) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `expires_at` timestamp NOT NULL,
  `rotated_at` timestamp NULL DEFAULT NULL,
  `revoked_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `idx_oauth_rt_hash` (`token_hash`),
  KEY `idx_oauth_rt_family` (`family_id`),
  KEY `idx_oauth_rt_user` (`user_id`),
  KEY `idx_oauth_rt_expires` (`expires_at`),
  CONSTRAINT `mcp_oauth_refresh_tokens_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `mcp_sessions` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `user_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `app_id` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `token_hash` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `scopes` json DEFAULT NULL,
  `created_ids` json DEFAULT NULL,
  `resource` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `oauth_client_id` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `device_id` varchar(200) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `refresh_family_id` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `expires_at` timestamp NOT NULL,
  `idle_timeout_seconds` int NOT NULL DEFAULT '1800',
  `last_used_at` timestamp NULL DEFAULT NULL,
  `last_used_ip` varchar(45) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `revoked_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `idx_mcp_hash` (`token_hash`),
  KEY `idx_mcp_user` (`user_id`),
  KEY `idx_mcp_oauth_device` (`oauth_client_id`,`device_id`),
  KEY `idx_mcp_refresh_family` (`refresh_family_id`),
  CONSTRAINT `mcp_sessions_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `pack_catalog` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `slug` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `publisher_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` text COLLATE utf8mb4_unicode_ci,
  `icon` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `screenshot` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `screenshots` json DEFAULT NULL,
  `tags` json DEFAULT NULL,
  `category` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `item_type` enum('application_package','connector','theme','widget','quickjs_library','sdk_component','template') COLLATE utf8mb4_unicode_ci DEFAULT 'application_package',
  `trust_level` enum('official','verified','community','private') COLLATE utf8mb4_unicode_ci DEFAULT 'community',
  `visibility` enum('public','private','unlisted') COLLATE utf8mb4_unicode_ci DEFAULT 'public',
  `status` enum('draft','published','archived') COLLATE utf8mb4_unicode_ci DEFAULT 'draft',
  `download_count` int unsigned DEFAULT '0',
  `avg_rating` decimal(3,2) DEFAULT '0.00',
  `rating_count` int unsigned DEFAULT '0',
  `featured` tinyint(1) DEFAULT '0',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `slug` (`slug`),
  KEY `publisher_id` (`publisher_id`),
  KEY `idx_category` (`category`),
  KEY `idx_visibility_status` (`visibility`,`status`),
  KEY `idx_featured` (`featured`),
  KEY `idx_item_type` (`item_type`),
  KEY `idx_trust_level` (`trust_level`),
  CONSTRAINT `pack_catalog_ibfk_1` FOREIGN KEY (`publisher_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `pack_installations` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `user_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `pack_id` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `catalog_id` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `version_id` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `pack_name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `pack_version` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT '1.0.0',
  `pack_description` text COLLATE utf8mb4_unicode_ci,
  `form_ids` json NOT NULL,
  `app_ids` json NOT NULL,
  `installed_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_pack_user` (`user_id`),
  KEY `idx_pack_id` (`pack_id`),
  KEY `idx_catalog` (`catalog_id`),
  CONSTRAINT `pack_installations_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `pack_ratings` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `catalog_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `user_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `rating` tinyint unsigned NOT NULL,
  `review` text COLLATE utf8mb4_unicode_ci,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `idx_user_pack` (`catalog_id`,`user_id`),
  KEY `user_id` (`user_id`),
  CONSTRAINT `pack_ratings_ibfk_1` FOREIGN KEY (`catalog_id`) REFERENCES `pack_catalog` (`id`) ON DELETE CASCADE,
  CONSTRAINT `pack_ratings_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `pack_versions` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `catalog_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `version` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `changelog` text COLLATE utf8mb4_unicode_ci,
  `pack_data` json NOT NULL,
  `file_path` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `form_count` int unsigned DEFAULT '0',
  `app_count` int unsigned DEFAULT '0',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `idx_catalog_version` (`catalog_id`,`version`),
  KEY `idx_created` (`created_at`),
  CONSTRAINT `pack_versions_ibfk_1` FOREIGN KEY (`catalog_id`) REFERENCES `pack_catalog` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `password_resets` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `user_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `token_hash` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `expires_at` timestamp NOT NULL,
  `used_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_token_hash` (`token_hash`),
  KEY `idx_user_id` (`user_id`),
  CONSTRAINT `password_resets_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `payments` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `user_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `provider` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'paypal',
  `order_id` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `capture_id` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `amount_cents` int NOT NULL,
  `currency` char(3) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'USD',
  `months` int NOT NULL,
  `status` enum('pending','processing','completed','failed','reversed') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `idx_payments_order` (`order_id`),
  UNIQUE KEY `idx_payments_capture` (`capture_id`),
  KEY `idx_payments_user` (`user_id`),
  CONSTRAINT `payments_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `rate_limits` (
  `bucket` char(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `window_start` bigint NOT NULL,
  `hits` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`bucket`,`window_start`),
  KEY `idx_window_start` (`window_start`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `response_links` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `source_form_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `source_response_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `target_form_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `target_response_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `field_id` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_source` (`source_form_id`,`source_response_id`),
  KEY `idx_target` (`target_form_id`,`target_response_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `response_metadata` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `form_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` enum('draft','submitted','reviewed','approved','rejected','archived') COLLATE utf8mb4_unicode_ci DEFAULT 'submitted',
  `submitted_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `ip_address` varchar(45) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `user_agent` text COLLATE utf8mb4_unicode_ci,
  `completion_time` int DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_form_id` (`form_id`),
  KEY `idx_status` (`status`),
  KEY `idx_submitted_at` (`submitted_at`),
  CONSTRAINT `response_metadata_ibfk_1` FOREIGN KEY (`form_id`) REFERENCES `forms` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `schema_meta` (
  `meta_key` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `meta_value` text COLLATE utf8mb4_unicode_ci,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`meta_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `system_meta` (
  `meta_key` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `meta_value` text COLLATE utf8mb4_unicode_ci,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`meta_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `admin_notices` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `message` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `level` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'info',
  `audience` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'online',
  `created_by` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expires_at` datetime DEFAULT NULL,
  `revoked_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_notice_active` (`revoked_at`,`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `trash_items` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `user_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `kind` enum('form','app','flow') COLLATE utf8mb4_unicode_ci NOT NULL,
  `original_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `zip_path` varchar(500) COLLATE utf8mb4_unicode_ci NOT NULL,
  `size_bytes` bigint unsigned NOT NULL DEFAULT '0',
  `meta` json DEFAULT NULL,
  `status` enum('trashed','restoring') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'trashed',
  `deleted_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expires_at` timestamp NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_trash_user` (`user_id`,`deleted_at`),
  KEY `idx_trash_expires` (`expires_at`),
  CONSTRAINT `trash_items_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `aokie_companion_devices` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `user_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `app_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `subject_id` varchar(200) COLLATE utf8mb4_unicode_ci NOT NULL,
  `role` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL,
  `display_name` varchar(120) COLLATE utf8mb4_unicode_ci NOT NULL,
  `grants` json NOT NULL,
  `holder_key_thumbprint` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `endpoint_public_key` json DEFAULT NULL,
  `approved_peer_key_thumbprints` json DEFAULT NULL,
  `peer_roster_revision` bigint unsigned DEFAULT NULL,
  `peer_roster_hash` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `desktop_connection_id` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `approved_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_seen_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `revoked_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `idx_aokie_companion_endpoint` (`app_id`,`subject_id`,`role`),
  KEY `idx_aokie_companion_owner` (`user_id`,`app_id`),
  KEY `idx_aokie_companion_revoked` (`revoked_at`),
  KEY `idx_aokie_companion_desktop` (`desktop_connection_id`),
  CONSTRAINT `aokie_companion_devices_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `aokie_companion_devices_ibfk_2` FOREIGN KEY (`app_id`) REFERENCES `apps` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `aokie_companion_sessions` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `app_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `external_session_id` varchar(200) COLLATE utf8mb4_unicode_ci NOT NULL,
  `call_id` varchar(200) COLLATE utf8mb4_unicode_ci NOT NULL,
  `device_id` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `subject_id` varchar(200) COLLATE utf8mb4_unicode_ci NOT NULL,
  `mode` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL,
  `state` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL,
  `joined_at` timestamp NULL DEFAULT NULL,
  `ended_at` timestamp NULL DEFAULT NULL,
  `end_reason` varchar(120) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `last_event_id` varchar(200) COLLATE utf8mb4_unicode_ci NOT NULL,
  `last_event_at` timestamp NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `idx_aokie_session_external` (`app_id`,`external_session_id`),
  KEY `idx_aokie_session_call` (`app_id`,`call_id`,`created_at`),
  KEY `idx_aokie_session_state` (`app_id`,`state`,`updated_at`),
  CONSTRAINT `aokie_companion_sessions_ibfk_1` FOREIGN KEY (`app_id`) REFERENCES `apps` (`id`) ON DELETE CASCADE,
  CONSTRAINT `aokie_companion_sessions_ibfk_2` FOREIGN KEY (`device_id`) REFERENCES `aokie_companion_devices` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `aokie_companion_activity` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `app_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `idempotency_key` varchar(200) COLLATE utf8mb4_unicode_ci NOT NULL,
  `request_hash` char(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `session_id` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `call_id` varchar(200) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `device_id` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `actor_user_id` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `subject_id` varchar(200) COLLATE utf8mb4_unicode_ci NOT NULL,
  `event_type` varchar(40) COLLATE utf8mb4_unicode_ci NOT NULL,
  `mode` varchar(16) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `reason` varchar(120) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `owner_epoch` bigint unsigned DEFAULT NULL,
  `occurred_at` timestamp NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `idx_aokie_activity_idempotency` (`app_id`,`idempotency_key`),
  KEY `idx_aokie_activity_history` (`app_id`,`occurred_at`,`id`),
  KEY `idx_aokie_activity_call` (`app_id`,`call_id`,`occurred_at`),
  CONSTRAINT `aokie_companion_activity_ibfk_1` FOREIGN KEY (`app_id`) REFERENCES `apps` (`id`) ON DELETE CASCADE,
  CONSTRAINT `aokie_companion_activity_ibfk_2` FOREIGN KEY (`session_id`) REFERENCES `aokie_companion_sessions` (`id`) ON DELETE SET NULL,
  CONSTRAINT `aokie_companion_activity_ibfk_3` FOREIGN KEY (`device_id`) REFERENCES `aokie_companion_devices` (`id`) ON DELETE SET NULL,
  CONSTRAINT `aokie_companion_activity_ibfk_4` FOREIGN KEY (`actor_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `aokie_companion_routing_groups` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `app_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(120) COLLATE utf8mb4_unicode_ci NOT NULL,
  `policy` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `enabled` tinyint(1) NOT NULL DEFAULT '1',
  `round_robin_cursor` bigint unsigned NOT NULL DEFAULT '0',
  `created_by_user_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `idx_aokie_routing_name` (`app_id`,`name`),
  KEY `idx_aokie_routing_enabled` (`app_id`,`enabled`),
  CONSTRAINT `aokie_companion_routing_groups_ibfk_1` FOREIGN KEY (`app_id`) REFERENCES `apps` (`id`) ON DELETE CASCADE,
  CONSTRAINT `aokie_companion_routing_groups_ibfk_2` FOREIGN KEY (`created_by_user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `aokie_companion_routing_members` (
  `group_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `device_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `priority_value` int unsigned NOT NULL DEFAULT '100',
  `enabled` tinyint(1) NOT NULL DEFAULT '1',
  `availability` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'available',
  `availability_updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `availability_expires_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`group_id`,`device_id`),
  KEY `idx_aokie_routing_available` (`group_id`,`enabled`,`availability`,`priority_value`),
  KEY `idx_aokie_routing_device` (`device_id`),
  CONSTRAINT `aokie_companion_routing_members_ibfk_1` FOREIGN KEY (`group_id`) REFERENCES `aokie_companion_routing_groups` (`id`) ON DELETE CASCADE,
  CONSTRAINT `aokie_companion_routing_members_ibfk_2` FOREIGN KEY (`device_id`) REFERENCES `aokie_companion_devices` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `aokie_companion_push_endpoints` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `app_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `device_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `endpoint_kind` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `delivery_mode` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL,
  `provider` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `environment` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL,
  `topic` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `endpoint_ciphertext` text COLLATE utf8mb4_unicode_ci,
  `broker_handle` varchar(512) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `endpoint_fingerprint` char(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `invalidated_at` timestamp NULL DEFAULT NULL,
  `rotated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `idx_aokie_push_endpoint` (`app_id`,`device_id`,`endpoint_kind`),
  KEY `idx_aokie_push_active` (`app_id`,`invalidated_at`,`endpoint_kind`),
  KEY `idx_aokie_push_device` (`device_id`),
  CONSTRAINT `aokie_companion_push_endpoints_ibfk_1` FOREIGN KEY (`app_id`) REFERENCES `apps` (`id`) ON DELETE CASCADE,
  CONSTRAINT `aokie_companion_push_endpoints_ibfk_2` FOREIGN KEY (`device_id`) REFERENCES `aokie_companion_devices` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `aokie_companion_offers` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `app_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `routing_group_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `offer_kind` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `invitation_hash` char(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `request_hash` char(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `collapse_hash` char(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `expires_at` timestamp NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `idx_aokie_offer_invitation` (`app_id`,`invitation_hash`),
  KEY `idx_aokie_offer_expiry` (`app_id`,`expires_at`),
  KEY `idx_aokie_offer_group` (`routing_group_id`),
  CONSTRAINT `aokie_companion_offers_ibfk_1` FOREIGN KEY (`app_id`) REFERENCES `apps` (`id`) ON DELETE CASCADE,
  CONSTRAINT `aokie_companion_offers_ibfk_2` FOREIGN KEY (`routing_group_id`) REFERENCES `aokie_companion_routing_groups` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `aokie_companion_push_deliveries` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `app_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `offer_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `device_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `push_endpoint_id` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `status` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `payload_json` json NOT NULL,
  `attempt_count` int unsigned NOT NULL DEFAULT '0',
  `claimed_at` timestamp NULL DEFAULT NULL,
  `completed_at` timestamp NULL DEFAULT NULL,
  `provider_message_hash` char(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `expires_at` timestamp NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `idx_aokie_delivery_target` (`offer_id`,`device_id`),
  KEY `idx_aokie_delivery_queue` (`status`,`expires_at`,`created_at`),
  KEY `idx_aokie_delivery_app` (`app_id`),
  KEY `idx_aokie_delivery_device` (`device_id`),
  KEY `idx_aokie_delivery_endpoint` (`push_endpoint_id`),
  CONSTRAINT `aokie_companion_push_deliveries_ibfk_1` FOREIGN KEY (`app_id`) REFERENCES `apps` (`id`) ON DELETE CASCADE,
  CONSTRAINT `aokie_companion_push_deliveries_ibfk_2` FOREIGN KEY (`offer_id`) REFERENCES `aokie_companion_offers` (`id`) ON DELETE CASCADE,
  CONSTRAINT `aokie_companion_push_deliveries_ibfk_3` FOREIGN KEY (`device_id`) REFERENCES `aokie_companion_devices` (`id`) ON DELETE CASCADE,
  CONSTRAINT `aokie_companion_push_deliveries_ibfk_4` FOREIGN KEY (`push_endpoint_id`) REFERENCES `aokie_companion_push_endpoints` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `aokie_companion_relay_frames` (
  `seq` bigint unsigned NOT NULL AUTO_INCREMENT,
  `app_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `to_party` varchar(120) COLLATE utf8mb4_unicode_ci NOT NULL,
  `from_party` varchar(120) COLLATE utf8mb4_unicode_ci NOT NULL,
  `frame` mediumtext COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`seq`),
  KEY `idx_aokie_relay_inbox` (`app_id`,`to_party`,`seq`),
  KEY `idx_aokie_relay_expiry` (`created_at`),
  CONSTRAINT `aokie_companion_relay_frames_ibfk_1` FOREIGN KEY (`app_id`) REFERENCES `apps` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE `users` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `email` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `password_hash` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `timezone` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `token_version` int NOT NULL DEFAULT '0',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `cloud_until` datetime DEFAULT NULL,
  `plan` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'personal',
  `is_admin` tinyint(1) NOT NULL DEFAULT '0',
  `last_seen_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`),
  KEY `idx_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `webhook_deliveries` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `webhook_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `event` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `payload` json DEFAULT NULL,
  `response_status` int DEFAULT NULL,
  `response_body` text COLLATE utf8mb4_unicode_ci,
  `duration_ms` int DEFAULT NULL,
  `success` tinyint(1) DEFAULT '0',
  `error_message` text COLLATE utf8mb4_unicode_ci,
  `attempt` int DEFAULT '0',
  `next_retry_at` timestamp NULL DEFAULT NULL,
  `status` varchar(20) COLLATE utf8mb4_unicode_ci DEFAULT 'success',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_deliveries_webhook_id` (`webhook_id`),
  KEY `idx_deliveries_created_at` (`created_at`),
  KEY `idx_deliveries_retry` (`status`,`next_retry_at`),
  CONSTRAINT `webhook_deliveries_ibfk_1` FOREIGN KEY (`webhook_id`) REFERENCES `webhooks` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `webhooks` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `form_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `user_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `url` varchar(2000) COLLATE utf8mb4_unicode_ci NOT NULL,
  `secret` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `events` json NOT NULL,
  `is_active` tinyint(1) DEFAULT '1',
  `description` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `user_id` (`user_id`),
  KEY `idx_webhooks_form_id` (`form_id`),
  KEY `idx_webhooks_active` (`is_active`),
  CONSTRAINT `webhooks_ibfk_1` FOREIGN KEY (`form_id`) REFERENCES `forms` (`id`) ON DELETE CASCADE,
  CONSTRAINT `webhooks_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

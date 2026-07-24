<?php

declare(strict_types=1);

namespace FormLogic\Database;

use PDO;
use PDOException;

class MySQLConnection
{
    private static ?PDO $instance = null;
    private array $config;

    public function __construct(array $config)
    {
        $this->config = $config;
    }

    public function getConnection(): PDO
    {
        if (self::$instance === null) {
            $dsn = sprintf(
                'mysql:host=%s;port=%s;dbname=%s;charset=%s',
                $this->config['host'],
                $this->config['port'],
                $this->config['database'],
                $this->config['charset']
            );

            try {
                self::$instance = new PDO(
                    $dsn,
                    $this->config['username'],
                    $this->config['password'],
                    [
                        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                        PDO::ATTR_EMULATE_PREPARES => false,
                    ]
                );
                // Pin the session to UTC so MySQL NOW()/CURRENT_TIMESTAMP align
                // with PHP's UTC date() strings. Without this, on a server whose
                // system timezone isn't UTC, PHP-written timestamps (e.g.
                // password_resets.expires_at, webhook next_retry_at) compared
                // against NOW() are skewed by the offset — password-reset tokens
                // would appear expired immediately and webhook retries mis-time.
                self::$instance->exec("SET time_zone = '+00:00'");
            } catch (PDOException $e) {
                throw new PDOException('MySQL Connection failed');
            }
        }

        return self::$instance;
    }

    /**
     * Request-path schema check (audit FL-DB-001). The old bootstrap ran the
     * FULL initializeSchema + runMigrations (50+ CREATEs, dozens of SHOW
     * COLUMNS probes, DDL) in EVERY php-fpm process. Now:
     *
     *  - Fast path: ONE indexed SELECT compares schema_meta's stamp against a
     *    hash of this file — when the schema code hasn't changed, a request
     *    executes zero DDL and zero probes.
     *  - Miss (fresh install / after a deploy that touched this file): one
     *    worker migrates under a named MySQL lock; concurrent workers wait on
     *    the lock and re-check, so two deployers can never run the same
     *    migration at once. A worker that can't get the lock reports
     *    "migration in progress" instead of partially serving.
     *
     * The stamp is md5(this file): every schema/migration change lives here,
     * so a deploy that touches it re-migrates exactly once — no version
     * constant for a developer to forget to bump.
     */
    public function ensureSchemaCurrent(): void
    {
        $stamp = md5_file(__FILE__) ?: 'unknown';
        $pdo = $this->getConnection();
        if ($this->schemaStampMatches($pdo, $stamp)) {
            return; // one SELECT, no DDL — the normal request path
        }
        $got = $pdo->query("SELECT GET_LOCK('formlogic_schema_migration', 15)")->fetchColumn();
        if ((int) $got !== 1) {
            throw new \RuntimeException(
                'Database migration is in progress on another worker — retry shortly'
            );
        }
        try {
            // Re-check under the lock: a concurrent worker may have finished.
            if ($this->schemaStampMatches($pdo, $stamp)) {
                return;
            }
            $this->initializeSchema();
            $this->runMigrations();
            // schema_meta is the INSTALLER'S key/value store (install.php /
            // bin/upgrade.php own its shape) — the stamp is just one more key.
            $pdo->exec(
                "CREATE TABLE IF NOT EXISTS schema_meta (
                    meta_key VARCHAR(64) NOT NULL PRIMARY KEY,
                    meta_value TEXT NULL,
                    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
            );
            $stmt = $pdo->prepare(
                "INSERT INTO schema_meta (meta_key, meta_value) VALUES ('schema_code_stamp', :s)
                 ON DUPLICATE KEY UPDATE meta_value = :s2"
            );
            $stmt->execute(['s' => $stamp, 's2' => $stamp]);
        } finally {
            $pdo->query("SELECT RELEASE_LOCK('formlogic_schema_migration')");
        }
    }

    private function schemaStampMatches(\PDO $pdo, string $stamp): bool
    {
        try {
            $current = $pdo
                ->query("SELECT meta_value FROM schema_meta WHERE meta_key = 'schema_code_stamp'")
                ->fetchColumn();
            return $current === $stamp;
        } catch (\PDOException $e) {
            return false; // schema_meta missing — fresh install/upgrade path
        }
    }

    public function initializeSchema(): void
    {
        $pdo = $this->getConnection();

        // Users table
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS users (
                id VARCHAR(36) PRIMARY KEY,
                email VARCHAR(255) NOT NULL UNIQUE,
                password_hash VARCHAR(255) NOT NULL,
                name VARCHAR(255),
                timezone VARCHAR(64) DEFAULT NULL,
                token_version INT NOT NULL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_email (email)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Password reset tokens (single-use, expiring)
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS password_resets (
                id VARCHAR(36) PRIMARY KEY,
                user_id VARCHAR(36) NOT NULL,
                token_hash VARCHAR(255) NOT NULL,
                expires_at TIMESTAMP NOT NULL,
                used_at TIMESTAMP NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                INDEX idx_token_hash (token_hash),
                INDEX idx_user_id (user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Forms table (metadata only, actual form data in SQLite)
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS forms (
                id VARCHAR(36) PRIMARY KEY,
                user_id VARCHAR(36),
                title VARCHAR(255) NOT NULL,
                description TEXT,
                status ENUM('draft', 'published', 'archived') DEFAULT 'draft',
                settings JSON,
                theme JSON,
                logic_script TEXT DEFAULT NULL,
                logic_prompt TEXT DEFAULT NULL,
                custom_screen MEDIUMTEXT DEFAULT NULL,
                custom_screen_trust VARCHAR(16) NOT NULL DEFAULT 'untrusted',
                custom_screen_provenance JSON DEFAULT NULL,
                icon VARCHAR(255) DEFAULT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                published_at TIMESTAMP NULL,
                ever_published_at DATETIME NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
                INDEX idx_user_id (user_id),
                INDEX idx_status (status),
                INDEX idx_created_at (created_at),
                INDEX idx_user_updated (user_id, updated_at, id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Form versions for history
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS form_versions (
                id VARCHAR(36) PRIMARY KEY,
                form_id VARCHAR(36) NOT NULL,
                version INT NOT NULL,
                data JSON NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_by VARCHAR(36),
                changelog TEXT,
                FOREIGN KEY (form_id) REFERENCES forms(id) ON DELETE CASCADE,
                UNIQUE KEY unique_form_version (form_id, version),
                INDEX idx_form_id (form_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // API tokens for authentication
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS api_tokens (
                id VARCHAR(36) PRIMARY KEY,
                user_id VARCHAR(36) NOT NULL,
                token_hash VARCHAR(255) NOT NULL,
                name VARCHAR(255),
                last_used_at TIMESTAMP NULL,
                expires_at TIMESTAMP NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                INDEX idx_user_id (user_id),
                INDEX idx_token_hash (token_hash)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Response metadata (actual responses in SQLite per form)
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS response_metadata (
                id VARCHAR(36) PRIMARY KEY,
                form_id VARCHAR(36) NOT NULL,
                status ENUM('draft', 'submitted', 'reviewed', 'approved', 'rejected', 'archived') DEFAULT 'submitted',
                submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                ip_address VARCHAR(45),
                user_agent TEXT,
                completion_time INT,
                FOREIGN KEY (form_id) REFERENCES forms(id) ON DELETE CASCADE,
                INDEX idx_form_id (form_id),
                INDEX idx_status (status),
                INDEX idx_submitted_at (submitted_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Form analytics aggregates
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS form_analytics (
                id VARCHAR(36) PRIMARY KEY,
                form_id VARCHAR(36) NOT NULL,
                date DATE NOT NULL,
                views INT DEFAULT 0,
                starts INT DEFAULT 0,
                completions INT DEFAULT 0,
                avg_completion_time INT DEFAULT 0,
                FOREIGN KEY (form_id) REFERENCES forms(id) ON DELETE CASCADE,
                UNIQUE KEY unique_form_date (form_id, date),
                INDEX idx_form_id (form_id),
                INDEX idx_date (date)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Apps table
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS apps (
                id VARCHAR(36) PRIMARY KEY,
                owner_id VARCHAR(36) NOT NULL,
                name VARCHAR(255) NOT NULL,
                slug VARCHAR(255) NOT NULL UNIQUE,
                description TEXT,
                logo_url VARCHAR(500),
                status ENUM('draft', 'published', 'archived') DEFAULT 'draft',
                settings JSON,
                theme JSON,
                nav_config JSON,
                custom_screen MEDIUMTEXT DEFAULT NULL,
                custom_screen_trust VARCHAR(16) NOT NULL DEFAULT 'untrusted',
                custom_screen_provenance JSON DEFAULT NULL,
                reports JSON DEFAULT NULL,
                custom_logic MEDIUMTEXT DEFAULT NULL,
                published_version INT NOT NULL DEFAULT 0,
                published_at TIMESTAMP NULL DEFAULT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
                INDEX idx_owner_id (owner_id),
                INDEX idx_slug (slug),
                INDEX idx_status (status)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Publish history: one row per publish (App Studio version state). The version
        // number is copied from apps.published_version AFTER the bump so history rows
        // and the live pointer can never drift.
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS app_versions (
                id VARCHAR(36) PRIMARY KEY,
                app_id VARCHAR(36) NOT NULL,
                version INT NOT NULL,
                label VARCHAR(160) DEFAULT NULL,
                published_by VARCHAR(36) DEFAULT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
                UNIQUE KEY unique_app_version (app_id, version),
                INDEX idx_av_app (app_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // App-form join table
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS app_forms (
                id VARCHAR(36) PRIMARY KEY,
                app_id VARCHAR(36) NOT NULL,
                form_id VARCHAR(36) NOT NULL,
                display_name VARCHAR(255),
                sort_order INT DEFAULT 0,
                is_visible TINYINT(1) DEFAULT 1,
                settings JSON,
                FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
                FOREIGN KEY (form_id) REFERENCES forms(id) ON DELETE CASCADE,
                UNIQUE KEY unique_app_form (app_id, form_id),
                INDEX idx_app_id (app_id),
                INDEX idx_form_id (form_id),
                INDEX idx_sort_order (sort_order)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // App roles
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS app_roles (
                id VARCHAR(36) PRIMARY KEY,
                app_id VARCHAR(36) NOT NULL,
                name VARCHAR(100) NOT NULL,
                description TEXT,
                is_system TINYINT(1) DEFAULT 0,
                sort_order INT DEFAULT 0,
                FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
                UNIQUE KEY unique_app_role (app_id, name),
                INDEX idx_app_id (app_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // App role permissions
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS app_role_permissions (
                id VARCHAR(36) PRIMARY KEY,
                role_id VARCHAR(36) NOT NULL,
                form_id VARCHAR(36) DEFAULT NULL,
                permission VARCHAR(191) NOT NULL,
                FOREIGN KEY (role_id) REFERENCES app_roles(id) ON DELETE CASCADE,
                FOREIGN KEY (form_id) REFERENCES forms(id) ON DELETE CASCADE,
                UNIQUE KEY unique_role_perm (role_id, form_id, permission),
                INDEX idx_role_id (role_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // App users
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS app_users (
                id VARCHAR(36) PRIMARY KEY,
                app_id VARCHAR(36) NOT NULL,
                user_id VARCHAR(36) NOT NULL,
                role_id VARCHAR(36) NOT NULL,
                status ENUM('pending', 'active', 'suspended') DEFAULT 'active',
                invited_by VARCHAR(36),
                invited_at TIMESTAMP NULL,
                joined_at TIMESTAMP NULL,
                FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (role_id) REFERENCES app_roles(id) ON DELETE RESTRICT,
                UNIQUE KEY unique_app_user (app_id, user_id),
                INDEX idx_app_id (app_id),
                INDEX idx_user_id (user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // App user groups
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS app_user_groups (
                id VARCHAR(36) PRIMARY KEY,
                app_id VARCHAR(36) NOT NULL,
                name VARCHAR(100) NOT NULL,
                description TEXT,
                FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
                UNIQUE KEY unique_app_group (app_id, name),
                INDEX idx_app_id (app_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // App user group members
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS app_user_group_members (
                id VARCHAR(36) PRIMARY KEY,
                group_id VARCHAR(36) NOT NULL,
                app_user_id VARCHAR(36) NOT NULL,
                FOREIGN KEY (group_id) REFERENCES app_user_groups(id) ON DELETE CASCADE,
                FOREIGN KEY (app_user_id) REFERENCES app_users(id) ON DELETE CASCADE,
                UNIQUE KEY unique_group_member (group_id, app_user_id),
                INDEX idx_group_id (group_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Response links (denormalized linked record references for fast inverse lookups)
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS response_links (
                id VARCHAR(36) PRIMARY KEY,
                source_form_id VARCHAR(36) NOT NULL,
                source_response_id VARCHAR(36) NOT NULL,
                target_form_id VARCHAR(36) NOT NULL,
                target_response_id VARCHAR(36) NOT NULL,
                field_id VARCHAR(50) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_source (source_form_id, source_response_id),
                INDEX idx_target (target_form_id, target_response_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Webhooks
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS webhooks (
                id VARCHAR(36) PRIMARY KEY,
                form_id VARCHAR(36) NOT NULL,
                user_id VARCHAR(36) NOT NULL,
                url VARCHAR(2000) NOT NULL,
                secret VARCHAR(64) NOT NULL,
                events JSON NOT NULL,
                is_active TINYINT(1) DEFAULT 1,
                description VARCHAR(255) DEFAULT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (form_id) REFERENCES forms(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                INDEX idx_webhooks_form_id (form_id),
                INDEX idx_webhooks_active (is_active)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Webhook delivery logs
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS webhook_deliveries (
                id VARCHAR(36) PRIMARY KEY,
                webhook_id VARCHAR(36) NOT NULL,
                event VARCHAR(50) NOT NULL,
                payload JSON,
                response_status INT DEFAULT NULL,
                response_body TEXT DEFAULT NULL,
                duration_ms INT DEFAULT NULL,
                success TINYINT(1) DEFAULT 0,
                error_message TEXT DEFAULT NULL,
                attempt INT DEFAULT 0,
                next_retry_at TIMESTAMP NULL DEFAULT NULL,
                status VARCHAR(20) DEFAULT 'success',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE,
                INDEX idx_deliveries_webhook_id (webhook_id),
                INDEX idx_deliveries_created_at (created_at),
                INDEX idx_deliveries_retry (status, next_retry_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Audit log
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS audit_log (
                id VARCHAR(36) PRIMARY KEY,
                user_id VARCHAR(36) DEFAULT NULL,
                action VARCHAR(50) NOT NULL,
                resource_type VARCHAR(50) NOT NULL,
                resource_id VARCHAR(36) DEFAULT NULL,
                details TEXT DEFAULT NULL,
                ip_address VARCHAR(45) DEFAULT NULL,
                integrity_hash VARCHAR(64) DEFAULT NULL,
                sequence_number BIGINT UNSIGNED DEFAULT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_audit_user_id (user_id),
                INDEX idx_audit_action (action),
                INDEX idx_audit_resource (resource_type, resource_id),
                INDEX idx_audit_created_at (created_at),
                UNIQUE INDEX idx_audit_sequence_number (sequence_number)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Pack installations (tracks imported packs for management/uninstall)
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS pack_installations (
                id VARCHAR(36) PRIMARY KEY,
                user_id VARCHAR(36) NOT NULL,
                pack_id VARCHAR(100) NOT NULL,
                pack_name VARCHAR(255) NOT NULL,
                pack_version VARCHAR(50) DEFAULT '1.0.0',
                pack_description TEXT,
                form_ids JSON NOT NULL,
                app_ids JSON NOT NULL,
                installed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                INDEX idx_pack_user (user_id),
                INDEX idx_pack_id (pack_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Application Package v2 installations (ADR-010 / PKG-104 subset): the aggregate unit —
        // node-only extensions install here WITHOUT creating forms/apps. One active version per
        // package per owner (uniq_pkgi_active); receipt_json is the immutable install receipt.
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS package_installations (
                id VARCHAR(36) PRIMARY KEY,
                user_id VARCHAR(36) NOT NULL,
                package_id VARCHAR(128) NOT NULL,
                publisher_id VARCHAR(96) NOT NULL,
                kind VARCHAR(20) NOT NULL,
                version VARCHAR(64) NOT NULL,
                display_name VARCHAR(120) NOT NULL,
                state VARCHAR(20) NOT NULL DEFAULT 'ready',
                source VARCHAR(20) NOT NULL DEFAULT 'json',
                receipt_json MEDIUMTEXT NOT NULL,
                created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_pkgi_active (user_id, package_id),
                INDEX idx_pkgi_user (user_id),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Contributed flow-node definitions (ADR-010): portable, digest-tracked declarative
        // metadata a v2 package contributes. Unique active contributed TYPE per owner; rows
        // cascade with their installation. digest = sha256 over the stored definition_json bytes.
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS flow_node_definitions (
                id VARCHAR(36) PRIMARY KEY,
                user_id VARCHAR(36) NOT NULL,
                installation_id VARCHAR(36) NOT NULL,
                node_type VARCHAR(160) NOT NULL,
                version VARCHAR(64) NOT NULL,
                digest CHAR(64) NOT NULL,
                definition_json MEDIUMTEXT NOT NULL,
                enabled TINYINT(1) NOT NULL DEFAULT 1,
                created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_fnd_type (user_id, node_type),
                INDEX idx_fnd_install (installation_id),
                FOREIGN KEY (installation_id) REFERENCES package_installations(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Pack catalog — marketplace registry
        // item_type / trust_level (spec §30) model a multi-artifact marketplace: for now every listing is
        // an 'application_package' with server-derived trust; the other item types are reserved (no runtime
        // install target yet — see PackCatalogService).
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS pack_catalog (
                id VARCHAR(36) PRIMARY KEY,
                slug VARCHAR(100) NOT NULL UNIQUE,
                publisher_id VARCHAR(36) NOT NULL,
                name VARCHAR(255) NOT NULL,
                description TEXT,
                icon VARCHAR(50),
                screenshot VARCHAR(500),
                screenshots JSON,
                tags JSON,
                category VARCHAR(100),
                item_type ENUM('application_package','connector','theme','widget','quickjs_library','sdk_component','template') DEFAULT 'application_package',
                trust_level ENUM('official','verified','community','private') DEFAULT 'community',
                visibility ENUM('public','private','unlisted') DEFAULT 'public',
                status ENUM('draft','published','archived') DEFAULT 'draft',
                download_count INT UNSIGNED DEFAULT 0,
                avg_rating DECIMAL(3,2) DEFAULT 0,
                rating_count INT UNSIGNED DEFAULT 0,
                featured TINYINT(1) DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (publisher_id) REFERENCES users(id) ON DELETE CASCADE,
                INDEX idx_category (category),
                INDEX idx_item_type (item_type),
                INDEX idx_trust_level (trust_level),
                INDEX idx_visibility_status (visibility, status),
                INDEX idx_featured (featured)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Pack versions — versioned pack content
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS pack_versions (
                id VARCHAR(36) PRIMARY KEY,
                catalog_id VARCHAR(36) NOT NULL,
                version VARCHAR(50) NOT NULL,
                changelog TEXT,
                pack_data JSON NOT NULL,
                file_path VARCHAR(500),
                form_count INT UNSIGNED DEFAULT 0,
                app_count INT UNSIGNED DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (catalog_id) REFERENCES pack_catalog(id) ON DELETE CASCADE,
                UNIQUE KEY idx_catalog_version (catalog_id, version),
                INDEX idx_created (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Pack ratings — user reviews
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS pack_ratings (
                id VARCHAR(36) PRIMARY KEY,
                catalog_id VARCHAR(36) NOT NULL,
                user_id VARCHAR(36) NOT NULL,
                rating TINYINT UNSIGNED NOT NULL,
                review TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (catalog_id) REFERENCES pack_catalog(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE KEY idx_user_pack (catalog_id, user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // App invitations
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS app_invitations (
                id VARCHAR(36) PRIMARY KEY,
                app_id VARCHAR(36) NOT NULL,
                email VARCHAR(255) NOT NULL,
                role_id VARCHAR(36) NOT NULL,
                token_hash VARCHAR(255) NOT NULL,
                invited_by VARCHAR(36) NOT NULL,
                status ENUM('pending', 'accepted', 'expired', 'revoked') DEFAULT 'pending',
                expires_at TIMESTAMP NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
                FOREIGN KEY (role_id) REFERENCES app_roles(id) ON DELETE CASCADE,
                FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE CASCADE,
                INDEX idx_app_id (app_id),
                INDEX idx_email (email),
                INDEX idx_token_hash (token_hash),
                INDEX idx_status (status)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        $this->createFlowTables($pdo);
    }

    /**
     * FormLogic Flows (docs/FORMLOGIC_FLOWS.md §2): flow library, event bindings, the reserve-first
     * run log, and the paired-desktop registry. Shared by initializeSchema() (fresh installs) and
     * runMigrations() (existing installs) — every statement is CREATE TABLE IF NOT EXISTS. Key types
     * mirror the live apps/forms/users tables (VARCHAR(36) UUIDs).
     */
    private function createFlowTables(PDO $pdo): void
    {
        // Flow definitions: engine 'f2i', WorkflowGraph-compatible flow_json, UNIQUE(app_id, slug).
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS flow_definitions (
                id VARCHAR(36) PRIMARY KEY,
                owner_user_id VARCHAR(36) NOT NULL,
                app_id VARCHAR(36) NULL,
                name VARCHAR(255) NOT NULL,
                slug VARCHAR(128) NOT NULL,
                description TEXT,
                engine VARCHAR(20) NOT NULL DEFAULT 'f2i',
                flow_json JSON NOT NULL,
                input_schema JSON NULL,
                output_schema JSON NULL,
                node_capabilities JSON NULL,
                version INT NOT NULL DEFAULT 1,
                enabled TINYINT(1) NOT NULL DEFAULT 1,
                execution_location VARCHAR(8) NOT NULL DEFAULT 'auto',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
                UNIQUE KEY unique_app_flow_slug (app_id, slug),
                INDEX idx_flow_owner (owner_user_id),
                INDEX idx_flow_app (app_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Event bindings: app/form/connector event → flow, JSON columns per flow-binding.schema.json.
        // app_id is NULLable: a binding with app_id NULL + form_id set is a WORKSPACE binding on a
        // standalone form (owned via the bound flow's owner_user_id — see FlowService form bindings).
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS app_flow_bindings (
                id VARCHAR(36) PRIMARY KEY,
                app_id VARCHAR(36) NULL,
                form_id VARCHAR(36) NULL,
                connector_id VARCHAR(64) NULL,
                flow_definition_id VARCHAR(36) NOT NULL,
                event_name VARCHAR(150) NOT NULL,
                mode ENUM('sync','async','background','manual') NOT NULL DEFAULT 'async',
                condition_json JSON NULL,
                input_map_json JSON NULL,
                output_actions_json JSON NULL,
                timeout_ms INT NOT NULL DEFAULT 30000,
                retry_policy_json JSON NULL,
                fallback_policy_json JSON NULL,
                enabled TINYINT(1) NOT NULL DEFAULT 1,
                sort_order INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
                FOREIGN KEY (form_id) REFERENCES forms(id) ON DELETE CASCADE,
                FOREIGN KEY (flow_definition_id) REFERENCES flow_definitions(id) ON DELETE CASCADE,
                INDEX idx_afb_app (app_id),
                INDEX idx_afb_flow (flow_definition_id),
                INDEX idx_afb_event (app_id, event_name)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Run log: UNIQUE idempotency_key is the cross-tab/browser dedupe gate (reserve-first,
        // mirroring app_submission_idempotency). binding_id keeps history when a binding is deleted.
        // app_id is NULLable (workspace-flow runs); runtime/claimed_by record which runner
        // ('browser'|'desktop') claimed a 'queued' run (queued→running exactly once).
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS flow_run_logs (
                id VARCHAR(36) PRIMARY KEY,
                app_id VARCHAR(36) NULL,
                form_id VARCHAR(36) NULL,
                response_id VARCHAR(36) NULL,
                binding_id VARCHAR(36) NULL,
                flow_definition_id VARCHAR(36) NOT NULL,
                trigger_event VARCHAR(150) NOT NULL,
                flow_version_id VARCHAR(36) NULL,
                parent_run_id VARCHAR(36) NULL,
                root_run_id VARCHAR(36) NULL,
                call_node_id VARCHAR(128) NULL,
                depth INT NOT NULL DEFAULT 0,
                correlation_id VARCHAR(150) NOT NULL,
                idempotency_key VARCHAR(255) NOT NULL,
                status VARCHAR(20) NOT NULL DEFAULT 'running',
                runtime VARCHAR(20) NULL,
                execution_location VARCHAR(8) NULL,
                claimed_by VARCHAR(120) NULL,
                input_snapshot_json JSON NULL,
                result_json JSON NULL,
                output_actions_json JSON NULL,
                error_json JSON NULL,
                started_at TIMESTAMP NULL,
                finished_at TIMESTAMP NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
                FOREIGN KEY (flow_definition_id) REFERENCES flow_definitions(id) ON DELETE CASCADE,
                FOREIGN KEY (binding_id) REFERENCES app_flow_bindings(id) ON DELETE SET NULL,
                UNIQUE KEY uniq_flow_run_idem (flow_definition_id, idempotency_key),
                INDEX idx_frl_app (app_id),
                INDEX idx_frl_flow (flow_definition_id),
                INDEX idx_frl_binding (binding_id),
                INDEX idx_frl_status (app_id, status),
                INDEX idx_frl_created (created_at),
                INDEX idx_frl_root (root_run_id),
                INDEX idx_frl_parent (parent_run_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Immutable executable revisions (extensible-flows plan §14.2): minted LAZILY at
        // run-reserve time (FlowService::ensureFlowVersion) — draft edits keep mutating
        // flow_definitions; a revision row exists exactly for contract states that RAN.
        // definition_json is MEDIUMTEXT (NOT JSON): the digest is over the exact bytes and a
        // JSON column would re-normalize them. flow_run_logs.flow_version_id points here
        // (no FK — informational pin; both tables already cascade on flow delete).
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS flow_definition_versions (
                id VARCHAR(36) PRIMARY KEY,
                flow_definition_id VARCHAR(36) NOT NULL,
                version INT NOT NULL,
                graph_version INT NOT NULL DEFAULT 1,
                definition_json MEDIUMTEXT NOT NULL,
                definition_digest VARCHAR(64) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (flow_definition_id) REFERENCES flow_definitions(id) ON DELETE CASCADE,
                UNIQUE KEY uniq_flow_def_version (flow_definition_id, version),
                INDEX idx_fdv_flow (flow_definition_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Canonical terminal outcome events (extensible-flows plan §9/§14.5): ONE row per
        // terminal run THAT HAS SUBSCRIBERS (UNIQUE run_id = exactly-once emission; the
        // guarded terminal UPDATE is the transition gate, this is the outbox). Inserted in
        // the SAME transaction as the terminal transition where possible; dispatch runs
        // after commit (inline) with bin/flow-outcome-dispatch.php as the at-least-once
        // recovery sweep. payload_json is the redacted §9 event payload.
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS flow_outcome_events (
                id VARCHAR(36) PRIMARY KEY,
                run_id VARCHAR(36) NOT NULL,
                app_id VARCHAR(36) NULL,
                owner_user_id VARCHAR(36) NOT NULL,
                flow_definition_id VARCHAR(36) NOT NULL,
                event_name VARCHAR(32) NOT NULL,
                payload_json JSON NOT NULL,
                dispatch_status VARCHAR(12) NOT NULL DEFAULT 'pending',
                attempts INT NOT NULL DEFAULT 0,
                dispatched_at TIMESTAMP NULL DEFAULT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_outcome_run (run_id),
                INDEX idx_foe_pending (dispatch_status, created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Blueprints (extensible-flows plan §11/§14, Phase 6 groundwork): the persistent
        // high-level Diagram. SEPARATE semantic vs layout revisions (§11.2 — a node drag
        // never conflicts with a semantic edit); elements hold BOTH nodes and relationship
        // edges (element_type 'edge', endpoints in properties_json) with tombstones;
        // layouts are canvas-only; operations are the §14.3 ID-addressed audited edits
        // (payload + inverse per op, batch = change_set_id, UNIQUE operation_id per
        // blueprint makes replays idempotent). Never store credentials or runtime data.
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS blueprints (
                id VARCHAR(36) PRIMARY KEY,
                owner_user_id VARCHAR(36) NOT NULL,
                app_id VARCHAR(36) NULL,
                name VARCHAR(120) NOT NULL,
                status VARCHAR(16) NOT NULL DEFAULT 'draft',
                semantic_revision INT NOT NULL DEFAULT 0,
                layout_revision INT NOT NULL DEFAULT 0,
                viewport_json JSON NULL,
                created_by VARCHAR(36) NULL,
                updated_by VARCHAR(36) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_bp_owner (owner_user_id, updated_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS blueprint_elements (
                id VARCHAR(64) NOT NULL,
                blueprint_id VARCHAR(36) NOT NULL,
                element_type VARCHAR(24) NOT NULL,
                resource_ref_json JSON NULL,
                properties_json JSON NULL,
                semantic_revision INT NOT NULL DEFAULT 0,
                deleted_at TIMESTAMP NULL DEFAULT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (blueprint_id, id),
                INDEX idx_bpe_live (blueprint_id, deleted_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS blueprint_layouts (
                blueprint_id VARCHAR(36) NOT NULL,
                element_id VARCHAR(64) NOT NULL,
                layout_json JSON NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (blueprint_id, element_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");
        // §11A D4: the bidirectional association between a diagram element and the real
        // resource it materialised into/references. last_observed_version snapshots the
        // resource's updated_at at link time → pull sync reads compare live vs observed
        // (newer = 'stale' projection, gone = 'missing').
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS blueprint_resource_links (
                blueprint_id VARCHAR(36) NOT NULL,
                element_id VARCHAR(64) NOT NULL,
                resource_type VARCHAR(24) NOT NULL,
                resource_id VARCHAR(64) NOT NULL,
                last_observed_version VARCHAR(32) NULL,
                materialisation_status VARCHAR(16) NOT NULL DEFAULT 'materialised',
                change_set_id VARCHAR(64) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (blueprint_id, element_id),
                INDEX idx_bprl_resource (resource_type, resource_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");
        // §12 Copilot: PROPOSED change sets — a validated batch parked for user approval.
        // The canvas renders them as ghost previews; approve re-validates and commits
        // through the ordinary gateway, discard just marks them. Never auto-applied.
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS builder_change_sets (
                id VARCHAR(64) PRIMARY KEY,
                blueprint_id VARCHAR(36) NOT NULL,
                owner_user_id VARCHAR(36) NOT NULL,
                status VARCHAR(16) NOT NULL DEFAULT 'proposed',
                origin VARCHAR(24) NOT NULL DEFAULT 'copilot',
                intent_summary VARCHAR(300) NULL,
                base_semantic_revision INT NOT NULL DEFAULT 0,
                operations_json JSON NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                resolved_at TIMESTAMP NULL DEFAULT NULL,
                INDEX idx_bcs_bp (blueprint_id, status, created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS blueprint_operations (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                operation_id VARCHAR(64) NOT NULL,
                blueprint_id VARCHAR(36) NOT NULL,
                change_set_id VARCHAR(64) NOT NULL,
                seq INT NOT NULL DEFAULT 0,
                op_type VARCHAR(48) NOT NULL,
                target_id VARCHAR(64) NULL,
                payload_json JSON NULL,
                inverse_json JSON NULL,
                semantic_revision INT NULL,
                layout_revision INT NULL,
                actor_user_id VARCHAR(36) NULL,
                origin VARCHAR(24) NOT NULL DEFAULT 'manual',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_bpop_op (blueprint_id, operation_id),
                INDEX idx_bpop_bp (blueprint_id, id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Flow KV storage: small persistent key/value state for flows (owner + optional app +
        // scope like 'flow:<slug>' or 'app'). app_id uses '' (empty string) — NOT NULL — for the
        // workspace scope so the UNIQUE key actually dedupes (MySQL UNIQUE ignores NULLs); there is
        // deliberately no FK on app_id for that reason (FlowKvService validates app ownership).
        // Caps enforced in FlowKvService: value ≤ 64 KiB, ≤ 500 keys per (owner, app, scope).
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS flow_kv (
                id VARCHAR(36) PRIMARY KEY,
                owner_user_id VARCHAR(36) NOT NULL,
                app_id VARCHAR(36) NOT NULL DEFAULT '',
                scope VARCHAR(64) NOT NULL,
                k VARCHAR(190) NOT NULL,
                v MEDIUMTEXT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE KEY uniq_flow_kv (owner_user_id, app_id, scope, k),
                INDEX idx_flow_kv_scope (owner_user_id, app_id, scope)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Paired FormLogic Desktop installs; upserted on successful pairing (per user + instance).
        // api_key_id ties a connection minted via the OAuth device-link flow to the scoped flk_ key
        // it was issued (revoking the connection revokes that key). No FK: api_keys is created later
        // in runMigrations(), so a constraint here would fail during a fresh initializeSchema().
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS desktop_connections (
                id VARCHAR(36) PRIMARY KEY,
                owner_user_id VARCHAR(36) NOT NULL,
                device_name VARCHAR(255) NOT NULL,
                desktop_instance_id VARCHAR(128) NOT NULL,
                api_key_id VARCHAR(36) NULL,
                last_seen_at TIMESTAMP NULL,
                capabilities_json JSON NULL,
                trusted_origins_json JSON NULL,
                e2e_public_key VARCHAR(88) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE KEY uniq_desktop_instance (owner_user_id, desktop_instance_id),
                INDEX idx_desktop_owner (owner_user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Remote command relay (docs/API.md §connector:relay): a web member enqueues a connector
        // command for a paired desktop runtime; the desktop long-polls, claims (pending→claimed
        // exactly-once) and completes. Reserve-first on the UNIQUE idempotency_key. status lifecycle
        // pending → claimed → done|failed, or pending → expired past expires_at.
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS desktop_commands (
                id VARCHAR(36) PRIMARY KEY,
                owner_user_id VARCHAR(36) NOT NULL,
                app_id VARCHAR(36) NULL,
                connector_id VARCHAR(64) NOT NULL,
                command VARCHAR(96) NOT NULL,
                payload_json JSON NULL,
                idempotency_key VARCHAR(255) NOT NULL,
                status ENUM('pending','claimed','done','failed','expired') NOT NULL DEFAULT 'pending',
                result_json JSON NULL,
                error_json JSON NULL,
                requested_by_user_id VARCHAR(36) NOT NULL,
                target_instance_id VARCHAR(128) NULL,
                claimed_by VARCHAR(120) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                claimed_at TIMESTAMP NULL,
                finished_at TIMESTAMP NULL,
                expires_at TIMESTAMP NOT NULL,
                FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
                UNIQUE KEY uniq_desktop_command_idem (owner_user_id, idempotency_key),
                INDEX idx_desktop_command_poll (owner_user_id, status, created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");


        // E2E AI relay lane (docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md Phase 1): sealed AI
        // requests a web member enqueues for their linked desktop, served single-flight FIFO
        // per target instance. The envelope/frames are opaque NaCl-box bodies the backend
        // cannot read; DesktopAiRelayService purges them at completion and on expiry, so
        // only routing metadata (owner, requester, target, provider, kind, timing) persists.
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS desktop_ai_requests (
                id VARCHAR(36) PRIMARY KEY,
                owner_user_id VARCHAR(36) NOT NULL,
                requesting_user_id VARCHAR(36) NOT NULL,
                target_instance_id VARCHAR(128) NULL,
                provider_id VARCHAR(128) NOT NULL,
                kind VARCHAR(32) NOT NULL,
                eph_pub VARCHAR(64) NOT NULL,
                envelope MEDIUMBLOB NULL,
                status ENUM('pending','claimed','streaming','done','failed','expired') NOT NULL DEFAULT 'pending',
                idempotency_key VARCHAR(255) NOT NULL,
                claimed_by VARCHAR(128) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                claimed_at TIMESTAMP NULL,
                finished_at TIMESTAMP NULL,
                expires_at TIMESTAMP NOT NULL,
                FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (requesting_user_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE KEY uniq_desktop_ai_idem (owner_user_id, idempotency_key),
                INDEX idx_desktop_ai_poll (owner_user_id, status, created_at),
                INDEX idx_desktop_ai_target (owner_user_id, target_instance_id, status)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Sealed stream frames for the AI lane: AUTO_INCREMENT seq is the delivery cursor
        // (SSE/out = desktop reply deltas, in = browser confirm-mode input), purged with
        // the request. direction is out|in from the BROWSER's perspective (out = to browser).
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS desktop_ai_frames (
                seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                request_id VARCHAR(36) NOT NULL,
                direction ENUM('out','in') NOT NULL,
                envelope MEDIUMBLOB NOT NULL,
                created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
                FOREIGN KEY (request_id) REFERENCES desktop_ai_requests(id) ON DELETE CASCADE,
                INDEX idx_desktop_ai_frames_request (request_id, direction, seq)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // E2E flow-run relay lane (docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md Phase 5 section 5.7):
        // sealed flow runs a web member enqueues for their linked desktop ('desktop' execution
        // location), served single-flight FIFO per target instance. flow_id is routing metadata
        // (the desktop must know WHICH flow to run); inputs/context ride the sealed envelope.
        // The result envelope (sealed, <= 1 MiB) survives completion until the requester reads
        // it once (read-once, then purged — DesktopFlowRelayService).
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS desktop_flow_runs (
                id VARCHAR(36) PRIMARY KEY,
                owner_user_id VARCHAR(36) NOT NULL,
                requesting_user_id VARCHAR(36) NOT NULL,
                target_instance_id VARCHAR(128) NULL,
                flow_id VARCHAR(36) NOT NULL,
                eph_pub VARCHAR(64) NOT NULL,
                envelope MEDIUMBLOB NULL,
                result_envelope MEDIUMBLOB NULL,
                status ENUM('pending','claimed','streaming','done','failed','expired') NOT NULL DEFAULT 'pending',
                idempotency_key VARCHAR(255) NOT NULL,
                claimed_by VARCHAR(128) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                claimed_at TIMESTAMP NULL,
                finished_at TIMESTAMP NULL,
                expires_at TIMESTAMP NOT NULL,
                FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (requesting_user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (flow_id) REFERENCES flow_definitions(id) ON DELETE CASCADE,
                UNIQUE KEY uniq_desktop_flow_run_idem (owner_user_id, idempotency_key),
                INDEX idx_desktop_flow_runs_poll (owner_user_id, status, created_at),
                INDEX idx_desktop_flow_runs_target (owner_user_id, target_instance_id, status)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Sealed progress frames for the flow lane (desktop → browser only; there is no
        // inbound channel — flow runs take no mid-run input). Purged at completion/expiry.
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS desktop_flow_run_frames (
                seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                request_id VARCHAR(36) NOT NULL,
                envelope MEDIUMBLOB NOT NULL,
                created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
                FOREIGN KEY (request_id) REFERENCES desktop_flow_runs(id) ON DELETE CASCADE,
                INDEX idx_desktop_flow_run_frames_request (request_id, seq)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Short-lived connector capabilities (audit SEC-001/C-08): the server mints a
        // token from a member's role-derived connector grants; FormLogic Desktop
        // introspects it (owner-scoped, via its own API key) BEFORE serving that
        // member's local loopback connector commands — so the local path enforces
        // the same role model as the relay, instead of trusting origin pairing alone.
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS connector_capabilities (
                id VARCHAR(36) PRIMARY KEY,
                token_hash CHAR(64) NOT NULL,
                owner_user_id VARCHAR(36) NOT NULL,
                user_id VARCHAR(36) NOT NULL,
                app_id VARCHAR(36) NULL,
                connector_id VARCHAR(64) NOT NULL,
                grants_json JSON NOT NULL,
                expires_at TIMESTAMP NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_capability_token (token_hash),
                INDEX idx_capability_owner (owner_user_id, expires_at),
                FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Connector→app assignment (audit INT-004/C-13): which ONE app under an owner
        // receives a local connector's events (and, later, may issue its commands).
        // Without a row, runtimes fall back to "exactly one candidate app" — two
        // candidate apps with no assignment is ambiguous and must be REJECTED, never
        // double-processed.
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS connector_assignments (
                id VARCHAR(36) PRIMARY KEY,
                owner_user_id VARCHAR(36) NOT NULL,
                connector_id VARCHAR(64) NOT NULL,
                app_id VARCHAR(36) NOT NULL,
                desktop_connection_id VARCHAR(36) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
                FOREIGN KEY (desktop_connection_id) REFERENCES desktop_connections(id) ON DELETE SET NULL,
                UNIQUE KEY uniq_connector_assignment (owner_user_id, connector_id),
                INDEX idx_connector_assignment_owner (owner_user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Site AI + cloud-credit allowances (docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md Phase 2/5):
        // per-plan monthly caps keyed by metric ('ai_messages', 'cloud_flow_runs'). monthly_value
        // -1 = unlimited; enabled=0 = the metric is off for that plan. Admin-editable via
        // PUT /api/admin/allowances; enforcement rides the planEnforced config gate (PlanService).
        // Plan slugs match users.plan ('personal' = the standard paid plan, 'enterprise').
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS plan_allowances (
                plan VARCHAR(20) NOT NULL,
                metric VARCHAR(32) NOT NULL,
                monthly_value INT NOT NULL DEFAULT 0,
                enabled TINYINT(1) NOT NULL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (plan, metric)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Monthly usage metering: one row per (user, metric, UTC YYYY-MM period) -- a new month
        // simply starts a fresh row, so rollover needs no reset job. count = units consumed
        // (messages / flow runs); tokens_in/out track hosted-LLM token usage for visibility.
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS usage_meter (
                user_id VARCHAR(36) NOT NULL,
                metric VARCHAR(32) NOT NULL,
                period CHAR(7) NOT NULL,
                `count` INT NOT NULL DEFAULT 0,
                tokens_in INT NOT NULL DEFAULT 0,
                tokens_out INT NOT NULL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, metric, period),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Per-user AI preferences (plan section 5.5/5.6): which AI source answers chat + flow
        // 'Default' LLM nodes -- hosted 'site', the user's tunneled 'desktop' provider/model,
        // or a browser-local 'custom' provider. chat_tool_mode gates E2E tool execution.
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS user_ai_settings (
                user_id VARCHAR(36) PRIMARY KEY,
                ai_source VARCHAR(16) NOT NULL DEFAULT 'site',
                desktop_provider_id VARCHAR(128) NULL,
                desktop_model VARCHAR(128) NULL,
                custom_provider_id VARCHAR(128) NULL,
                chat_tool_mode VARCHAR(8) NOT NULL DEFAULT 'auto',
                desktop_reasoning VARCHAR(16) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Chat tool grants (plan Phase 6 sections 5.4/6): short-lived (10 min) tokens the
        // browser mints once per chat turn, bound to the minting user + ONE desktop instance
        // + the ai:chat-tools scope. Only the sha256 token hash is stored (the ApiKeyService
        // pattern); expired rows are reaped opportunistically during verification -- no cron.
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS chat_tool_grants (
                id VARCHAR(36) PRIMARY KEY,
                token_hash CHAR(64) NOT NULL,
                user_id VARCHAR(36) NOT NULL,
                desktop_instance_id VARCHAR(128) NOT NULL,
                scope VARCHAR(32) NOT NULL DEFAULT 'ai:chat-tools',
                expires_at TIMESTAMP NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_chat_tool_grant_token (token_hash),
                INDEX idx_chat_tool_grants_user (user_id, expires_at),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // ── E2EE Private Forms (docs/E2EE_PRIVATE_FORMS_PLAN.md §7) ──────────────────
        // All byte fields are RAW bytes in VARBINARY/MEDIUMBLOB (base64 exists only at
        // the API boundary); public keys are stored as canonical base64 VARCHAR.
        // Deliberately NO foreign keys to forms/users: these rows must SURVIVE a form's
        // trash → restore round trip (the form row itself is deleted while trashed) and
        // are lifecycle-managed by TrashService (state flips + purge).

        // Per-user vault: passphrase-wrapped User Master Key + sealed private-key bundle.
        // The server stores wrapped/sealed material only — it can never unwrap any of it.
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS user_vaults (
                user_id VARCHAR(36) PRIMARY KEY,
                version INT NOT NULL DEFAULT 1,
                kdf VARCHAR(32) NOT NULL,
                kdf_salt VARBINARY(16) NOT NULL,
                kdf_memlimit INT UNSIGNED NOT NULL,
                kdf_opslimit INT UNSIGNED NOT NULL,
                wrapped_umk VARBINARY(128) NOT NULL,
                wrapped_umk_recovery VARBINARY(128) NULL,
                enc_key_bundle VARBINARY(512) NOT NULL,
                x25519_pk VARCHAR(64) NOT NULL,
                ed25519_pk VARCHAR(64) NOT NULL,
                created_at DATETIME,
                updated_at DATETIME
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Which forms are private (end-to-end encrypted). NO disable path exists (plan
        // D8): no state value, no endpoint, no import flag can revert 'private'.
        // 'enabling' is the durable plaintext → private transition marker (enable
        // race fix): it is committed FIRST and every mutation surface fails closed
        // (409 encryption_enabling) while it is present.
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS form_encryption (
                form_id VARCHAR(36) PRIMARY KEY,
                mode ENUM('private') NOT NULL,
                current_ingest_epoch INT NOT NULL DEFAULT 1,
                current_fk_epoch INT NOT NULL DEFAULT 1,
                state ENUM('enabling','active','trashed') NOT NULL DEFAULT 'active',
                enabled_by VARCHAR(36) NOT NULL,
                enabled_at DATETIME
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Immutable schema snapshots: EXACT bytes (MEDIUMBLOB so charset/collation can
        // never mangle them), served verbatim, never re-encoded server-side.
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS form_schema_versions (
                id VARCHAR(40) PRIMARY KEY,
                form_id VARCHAR(36) NOT NULL,
                version INT NOT NULL,
                schema_json MEDIUMBLOB NOT NULL,
                schema_hash CHAR(64) NOT NULL,
                created_at DATETIME,
                UNIQUE KEY uq_form_version (form_id, version)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Per-form × ingest-epoch X25519 ingestion keypairs. The secret is stored ONLY
        // wrapped under the (epoched) Form Key. 'trashed' is additive to the plan's
        // active/retiring/retired set — it parks keys while their form sits in trash.
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS form_ingestion_keys (
                id VARCHAR(40) PRIMARY KEY,
                form_id VARCHAR(36) NOT NULL,
                epoch INT NOT NULL,
                public_key VARCHAR(64) NOT NULL,
                wrapped_secret VARBINARY(128) NOT NULL,
                fk_epoch INT NOT NULL,
                state ENUM('active','retiring','retired','trashed') NOT NULL DEFAULT 'active',
                accept_until DATETIME NULL,
                created_at DATETIME,
                UNIQUE KEY uq_form_epoch (form_id, epoch)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // APPEND-ONLY signed manifests: the exact signed bytes + signature + the signer's
        // verification key itself — the server can PROVE but never REGENERATE a manifest.
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS form_manifests (
                id VARCHAR(40) PRIMARY KEY,
                form_id VARCHAR(36) NOT NULL,
                manifest_seq INT NOT NULL,
                key_id VARCHAR(40) NOT NULL,
                ingest_epoch INT NOT NULL,
                schema_version INT NOT NULL,
                schema_hash CHAR(64) NOT NULL,
                content_suite VARCHAR(48) NOT NULL,
                wrap_suite VARCHAR(48) NOT NULL,
                signer_key_id VARCHAR(16) NOT NULL,
                signer_pk VARCHAR(64) NOT NULL,
                signed_bytes MEDIUMBLOB NOT NULL,
                signature VARBINARY(64) NOT NULL,
                created_at DATETIME NOT NULL,
                expires_at DATETIME NULL,
                superseded_at DATETIME NULL,
                UNIQUE KEY uq_form_seq (form_id, manifest_seq)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Form-Key grants (sealed box of FK[fk_epoch] to the grantee) with their FULL
        // verification context, so grant signatures verify against snapshotted state.
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS form_key_grants (
                id VARCHAR(40) PRIMARY KEY,
                form_id VARCHAR(36) NOT NULL,
                user_id VARCHAR(36) NOT NULL,
                fk_epoch INT NOT NULL,
                wrapped_key VARBINARY(128) NOT NULL,
                wrap_suite VARCHAR(48) NOT NULL,
                role VARCHAR(16) NOT NULL DEFAULT 'owner',
                grantor_user_id VARCHAR(36) NOT NULL,
                grantor_key_id VARCHAR(16) NOT NULL,
                grantee_pk VARCHAR(64) NOT NULL,
                sig_version SMALLINT NOT NULL DEFAULT 1,
                signature VARBINARY(64) NOT NULL,
                expires_at DATETIME NULL,
                state ENUM('active','revoked','trashed') NOT NULL DEFAULT 'active',
                created_at DATETIME,
                UNIQUE KEY uq_form_user_epoch (form_id, user_id, fk_epoch)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Encrypted data nodes — N0/N3a skeleton (docs/FORMLOGIC_DATA_NODES.md;
        // mirrored in schema.sql + database/migrate.php block 6). data_nodes has
        // no FK to desktop_connections on purpose: unlinking revokes (status),
        // it never silently deletes enrolment history.
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS data_nodes (
                id VARCHAR(40) PRIMARY KEY,
                desktop_connection_id VARCHAR(36) NOT NULL,
                owner_user_id VARCHAR(36) NOT NULL,
                workspace_id VARCHAR(36) NULL,
                display_name VARCHAR(120) NOT NULL,
                signing_public_key VARCHAR(64) NOT NULL,
                signing_key_id VARCHAR(16) NOT NULL,
                signing_key_generation INT NOT NULL DEFAULT 1,
                fingerprint CHAR(64) NOT NULL,
                transport_key_fingerprint CHAR(64) NULL,
                owner_signed_certificate MEDIUMBLOB NULL,
                certificate_expires_at DATETIME NULL,
                protocol_min INT NOT NULL DEFAULT 1,
                protocol_max INT NOT NULL DEFAULT 1,
                capabilities_json JSON NULL,
                roster_revision INT NOT NULL DEFAULT 1,
                last_seen_at DATETIME NULL,
                last_storage_heartbeat_at DATETIME NULL,
                status ENUM('pending','approved','revoked') NOT NULL DEFAULT 'pending',
                revoked_at DATETIME NULL,
                created_at DATETIME NULL,
                updated_at DATETIME NULL,
                UNIQUE KEY uq_data_node_connection (desktop_connection_id),
                KEY idx_data_node_owner (owner_user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");
        // Staged artifact ownership (review FL-002; mirrored in schema.sql +
        // database/migrate.php block 15): random IDs are not authorization —
        // every staged snapshot/account backup binds to its owner and node.
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS data_staged_artifacts (
                id VARCHAR(64) PRIMARY KEY,
                kind ENUM('snapshot','account_backup') NOT NULL,
                owner_user_id VARCHAR(36) NOT NULL,
                node_id VARCHAR(40) NULL,
                state ENUM('active','deleting') NOT NULL DEFAULT 'active',
                created_at DATETIME NULL,
                expires_at DATETIME NOT NULL,
                KEY idx_staged_artifact_owner (owner_user_id),
                KEY idx_staged_artifact_expiry (expires_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS data_placement_manifests (
                id VARCHAR(40) PRIMARY KEY,
                dataset_id VARCHAR(36) NOT NULL,
                form_id VARCHAR(36) NOT NULL,
                storage_epoch INT NOT NULL,
                manifest_hash CHAR(64) NOT NULL,
                previous_manifest_hash CHAR(64) NULL,
                primary_replica_id VARCHAR(64) NOT NULL,
                signed_bytes MEDIUMBLOB NOT NULL,
                owner_signer_key_id VARCHAR(16) NOT NULL,
                owner_signer_fingerprint CHAR(64) NOT NULL,
                created_at DATETIME NULL,
                UNIQUE KEY uq_dataset_epoch (dataset_id, storage_epoch),
                KEY idx_placement_form (form_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS data_dataset_high_water (
                dataset_id VARCHAR(36) PRIMARY KEY,
                storage_epoch INT NOT NULL,
                last_acknowledged_sequence BIGINT NOT NULL DEFAULT 0,
                last_operation_hash CHAR(64) NULL,
                checkpoint_hash CHAR(64) NULL,
                placement_manifest_hash CHAR(64) NULL,
                tombstone_ledger_coverage_sequence BIGINT NOT NULL DEFAULT 0,
                tombstone_ledger_root CHAR(64) NULL,
                updated_at DATETIME NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Seed the Site AI allowance (plan section 3 decision 2): the standard paid plan gets 500
        // hosted AI messages/month; enterprise is unlimited (-1). INSERT IGNORE so an
        // admin's later edits are never overwritten by a re-run migration.
        $pdo->exec("
            INSERT IGNORE INTO plan_allowances (plan, metric, monthly_value, enabled) VALUES
                ('personal', 'ai_messages', 500, 1),
                ('enterprise', 'ai_messages', -1, 1)
        ");

        // Seed the cloud flow-run credit (plan section 3 decision 9): the standard paid plan
        // gets 100 cloud flow runs/month; enterprise is unlimited (-1). INSERT IGNORE so an
        // admin's later edits are never overwritten by a re-run migration.
        $pdo->exec("
            INSERT IGNORE INTO plan_allowances (plan, metric, monthly_value, enabled) VALUES
                ('personal', 'cloud_flow_runs', 100, 1),
                ('enterprise', 'cloud_flow_runs', -1, 1)
        ");
    }

    /**
     * Run migrations for existing databases
     */
    public function runMigrations(): void
    {
        $pdo = $this->getConnection();

        // Add logic_script column to forms table if it doesn't exist
        $result = $pdo->query("SHOW COLUMNS FROM forms LIKE 'logic_script'");
        if ($result->rowCount() === 0) {
            $pdo->exec("ALTER TABLE forms ADD COLUMN logic_script TEXT DEFAULT NULL AFTER theme");
        }

        // Add logic_prompt column to forms table if it doesn't exist
        $result = $pdo->query("SHOW COLUMNS FROM forms LIKE 'logic_prompt'");
        if ($result->rowCount() === 0) {
            $pdo->exec("ALTER TABLE forms ADD COLUMN logic_prompt TEXT DEFAULT NULL AFTER logic_script");
        }

        // Add custom_screen column (sandboxed HTML/CSS/JS UI over the form's data) if it doesn't exist
        $result = $pdo->query("SHOW COLUMNS FROM forms LIKE 'custom_screen'");
        if ($result->rowCount() === 0) {
            $pdo->exec("ALTER TABLE forms ADD COLUMN custom_screen MEDIUMTEXT DEFAULT NULL AFTER logic_prompt");
        }
        foreach ([
            'custom_screen_trust' => "ALTER TABLE forms ADD COLUMN custom_screen_trust VARCHAR(16) NOT NULL DEFAULT 'untrusted' AFTER custom_screen",
            'custom_screen_provenance' => "ALTER TABLE forms ADD COLUMN custom_screen_provenance JSON DEFAULT NULL AFTER custom_screen_trust",
        ] as $column => $ddl) {
            if ($pdo->query("SHOW COLUMNS FROM forms LIKE '{$column}'")->rowCount() === 0) {
                $pdo->exec($ddl);
            }
        }

        // Add custom_logic column to forms (form-scoped sandboxed QuickJS app-logic) if it doesn't exist
        $result = $pdo->query("SHOW COLUMNS FROM forms LIKE 'custom_logic'");
        if ($result->rowCount() === 0) {
            $pdo->exec("ALTER TABLE forms ADD COLUMN custom_logic MEDIUMTEXT DEFAULT NULL AFTER custom_screen");
        }

        // Add custom_screen column to apps (the app's custom HOME screen) if it doesn't exist
        $result = $pdo->query("SHOW COLUMNS FROM apps LIKE 'custom_screen'");
        if ($result->rowCount() === 0) {
            $pdo->exec("ALTER TABLE apps ADD COLUMN custom_screen MEDIUMTEXT DEFAULT NULL AFTER nav_config");
        }
        foreach ([
            'custom_screen_trust' => "ALTER TABLE apps ADD COLUMN custom_screen_trust VARCHAR(16) NOT NULL DEFAULT 'untrusted' AFTER custom_screen",
            'custom_screen_provenance' => "ALTER TABLE apps ADD COLUMN custom_screen_provenance JSON DEFAULT NULL AFTER custom_screen_trust",
        ] as $column => $ddl) {
            if ($pdo->query("SHOW COLUMNS FROM apps LIKE '{$column}'")->rowCount() === 0) {
                $pdo->exec($ddl);
            }
        }

        // Add reports column to apps (saved chart reports + PDF documents) if it doesn't exist
        $result = $pdo->query("SHOW COLUMNS FROM apps LIKE 'reports'");
        if ($result->rowCount() === 0) {
            $pdo->exec("ALTER TABLE apps ADD COLUMN reports JSON DEFAULT NULL AFTER custom_screen");
        }

        // Add custom_logic column to apps (sandboxed QuickJS app-logic bundle) if it doesn't exist
        $result = $pdo->query("SHOW COLUMNS FROM apps LIKE 'custom_logic'");
        if ($result->rowCount() === 0) {
            $pdo->exec("ALTER TABLE apps ADD COLUMN custom_logic MEDIUMTEXT DEFAULT NULL AFTER reports");
        }

        // App Studio publish/version state (published_version bumps on every publish;
        // published_at anchors "unpublished changes since" comparisons). The
        // app_versions history table itself is created in initializeSchema (CREATE IF
        // NOT EXISTS runs on existing installs too).
        foreach ([
            'published_version' => "ALTER TABLE apps ADD COLUMN published_version INT NOT NULL DEFAULT 0 AFTER custom_logic",
            'published_at' => "ALTER TABLE apps ADD COLUMN published_at TIMESTAMP NULL DEFAULT NULL AFTER published_version",
        ] as $column => $ddl) {
            if ($pdo->query("SHOW COLUMNS FROM apps LIKE '{$column}'")->rowCount() === 0) {
                $pdo->exec($ddl);
            }
        }

        // Unique (app_id, form_id) on app_forms — present in the CREATE TABLE but
        // older installs predate it, allowing the same form to be attached to the
        // same app twice. Dedupe first (keep the lowest-sort_order row, id as
        // tie-break) so the ALTER cannot fail on existing duplicate attachments.
        $hasAppFormIdx = $pdo->query("SHOW INDEX FROM app_forms WHERE Key_name = 'unique_app_form'")->rowCount() > 0;
        if (!$hasAppFormIdx) {
            $pdo->exec("
                DELETE af FROM app_forms af
                JOIN app_forms keep
                  ON keep.app_id = af.app_id
                 AND keep.form_id = af.form_id
                 AND (
                     COALESCE(keep.sort_order, 0) < COALESCE(af.sort_order, 0)
                     OR (COALESCE(keep.sort_order, 0) = COALESCE(af.sort_order, 0) AND keep.id < af.id)
                 )
            ");
            $pdo->exec("ALTER TABLE app_forms ADD UNIQUE KEY unique_app_form (app_id, form_id)");
        }

        // form_id-first index on app_forms for the "which apps contain this form?"
        // lookups (app-contexts / form-usage / isFormInAnyApp / getAppsForForms).
        // Older installs had only the InnoDB auto-generated FK index (named
        // 'form_id'); add the explicit idx_form_id so migrated and fresh schemas
        // match, then drop the now-redundant auto index (the FK re-binds to
        // idx_form_id). A composite (form_id, app_id) is deliberately NOT added:
        // the standalone form_id index already serves every form_id-first lookup
        // and UNIQUE unique_app_form (app_id, form_id) serves the pair lookups.
        $hasFormIdIdx = $pdo->query("SHOW INDEX FROM app_forms WHERE Key_name = 'idx_form_id'")->rowCount() > 0;
        if (!$hasFormIdIdx) {
            $pdo->exec("ALTER TABLE app_forms ADD INDEX idx_form_id (form_id)");
            try {
                if ($pdo->query("SHOW INDEX FROM app_forms WHERE Key_name = 'form_id'")->rowCount() > 0) {
                    $pdo->exec("ALTER TABLE app_forms DROP INDEX form_id");
                }
            } catch (\Throwable $e) {
                // If the drop is refused (odd FK/index binding), the redundant
                // auto index is harmless — idx_form_id is what code relies on.
            }
        }

        // Per-domain config columns (native app / PWA / security) for existing installs. On a brand-new
        // DB app_domains may not exist yet (created further below WITH these columns), so guard + ignore.
        try {
            foreach (['native_config', 'pwa_config', 'security_config'] as $domainCol) {
                $res = $pdo->query("SHOW COLUMNS FROM app_domains LIKE '$domainCol'");
                if ($res && $res->rowCount() === 0) {
                    $pdo->exec("ALTER TABLE app_domains ADD COLUMN $domainCol JSON NULL AFTER landing_config");
                }
            }
        } catch (\Throwable $e) {
            // app_domains not created yet on a fresh DB — the CREATE TABLE below includes these columns.
        }

        // Add scopes column to mcp_sessions (per-token capability list) if it doesn't exist
        try {
            $result = $pdo->query("SHOW COLUMNS FROM mcp_sessions LIKE 'scopes'");
            if ($result->rowCount() === 0) {
                $pdo->exec("ALTER TABLE mcp_sessions ADD COLUMN scopes JSON DEFAULT NULL AFTER token_hash");
            }
        } catch (\Throwable $e) { /* table may not exist yet on a fresh install — CREATE handles it */ }

        // Add created_ids column to mcp_sessions — for "creator" tokens that can make a new app but are
        // confined to the apps/forms they themselves create ({apps:[],forms:[]}; NULL = not a creator token).
        try {
            $result = $pdo->query("SHOW COLUMNS FROM mcp_sessions LIKE 'created_ids'");
            if ($result->rowCount() === 0) {
                $pdo->exec("ALTER TABLE mcp_sessions ADD COLUMN created_ids JSON DEFAULT NULL AFTER scopes");
            }
        } catch (\Throwable $e) { /* table may not exist yet on a fresh install — CREATE handles it */ }

        // Convert audit_log details column from JSON to TEXT (prevents MySQL key reordering)
        $result = $pdo->query("SHOW COLUMNS FROM audit_log LIKE 'details'");
        $detailsCol = $result->fetch(PDO::FETCH_ASSOC);
        if ($detailsCol && stripos($detailsCol['Type'], 'json') !== false) {
            $pdo->exec("ALTER TABLE audit_log MODIFY COLUMN details TEXT DEFAULT NULL");
        }

        // Add integrity_hash column to audit_log if it doesn't exist
        $result = $pdo->query("SHOW COLUMNS FROM audit_log LIKE 'integrity_hash'");
        if ($result->rowCount() === 0) {
            $pdo->exec("ALTER TABLE audit_log ADD COLUMN integrity_hash VARCHAR(64) DEFAULT NULL");
        }

        // Add sequence_number column to audit_log if it doesn't exist
        $result = $pdo->query("SHOW COLUMNS FROM audit_log LIKE 'sequence_number'");
        if ($result->rowCount() === 0) {
            $pdo->exec("ALTER TABLE audit_log ADD COLUMN sequence_number BIGINT UNSIGNED DEFAULT NULL");
            $pdo->exec("ALTER TABLE audit_log ADD UNIQUE INDEX idx_audit_sequence_number (sequence_number)");
        }

        // Create audit_sequence table for generating sequential IDs
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS audit_sequence (
                id INT AUTO_INCREMENT PRIMARY KEY
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // E2EE enable race fix (plan §9.1): the durable 'enabling' state. Existing
        // databases predating it have state ENUM('active','trashed') — widen it so the
        // enable flow can commit its plaintext → enabling → private transition marker.
        if ($pdo->query("SHOW TABLES LIKE 'form_encryption'")->rowCount() > 0) {
            $stateCol = $pdo->query("SHOW COLUMNS FROM form_encryption LIKE 'state'")->fetch(\PDO::FETCH_ASSOC);
            if (is_array($stateCol) && !str_contains((string) ($stateCol['Type'] ?? ''), 'enabling')) {
                $pdo->exec("ALTER TABLE form_encryption MODIFY COLUMN state ENUM('enabling','active','trashed') NOT NULL DEFAULT 'active'");
            }
        }

        // E2EE Private Forms (plan §7): durable publication history. Backfilled NOW()
        // for EVERY pre-existing row (one-time — guarded by the column-existence check)
        // so v1 private forms are strictly post-feature creations: the enable preflight
        // requires ever_published_at IS NULL, and this column is set on first publish
        // and never cleared (FormService::updateForm / createForm).
        $result = $pdo->query("SHOW COLUMNS FROM forms LIKE 'ever_published_at'");
        if ($result->rowCount() === 0) {
            $pdo->exec("ALTER TABLE forms ADD COLUMN ever_published_at DATETIME NULL AFTER published_at");
            $pdo->exec("UPDATE forms SET ever_published_at = NOW()");
        }

        // Add icon column to forms table if it doesn't exist
        $result = $pdo->query("SHOW COLUMNS FROM forms LIKE 'icon'");
        if ($result->rowCount() === 0) {
            $pdo->exec("ALTER TABLE forms ADD COLUMN icon VARCHAR(255) DEFAULT NULL AFTER logic_prompt");
        }

        // Add field_count column to forms table for list view performance
        $result = $pdo->query("SHOW COLUMNS FROM forms LIKE 'field_count'");
        if ($result->rowCount() === 0) {
            $pdo->exec("ALTER TABLE forms ADD COLUMN field_count INT UNSIGNED DEFAULT 0 AFTER status");
        }

        // Add response_count for list views (cards + "Most Responses" sort). NULL =
        // not yet computed (distinguishes "unknown" from a genuine 0 responses);
        // backfilled lazily on first list read, then kept in sync on every
        // response create/delete. Responses live in per-form SQLite, so this is a
        // denormalized mirror — see ResponseService::syncResponseCount().
        $result = $pdo->query("SHOW COLUMNS FROM forms LIKE 'response_count'");
        if ($result->rowCount() === 0) {
            $pdo->exec("ALTER TABLE forms ADD COLUMN response_count INT UNSIGNED DEFAULT NULL AFTER field_count");
        }

        // Webhook delivery retry columns (durable retry queue)
        $hasWebhookDeliveries = $pdo->query("SHOW TABLES LIKE 'webhook_deliveries'")->rowCount() > 0;
        if ($hasWebhookDeliveries) {
            if ($pdo->query("SHOW COLUMNS FROM webhook_deliveries LIKE 'attempt'")->rowCount() === 0) {
                $pdo->exec("ALTER TABLE webhook_deliveries ADD COLUMN attempt INT DEFAULT 0");
            }
            if ($pdo->query("SHOW COLUMNS FROM webhook_deliveries LIKE 'next_retry_at'")->rowCount() === 0) {
                $pdo->exec("ALTER TABLE webhook_deliveries ADD COLUMN next_retry_at TIMESTAMP NULL DEFAULT NULL");
            }
            if ($pdo->query("SHOW COLUMNS FROM webhook_deliveries LIKE 'status'")->rowCount() === 0) {
                $pdo->exec("ALTER TABLE webhook_deliveries ADD COLUMN status VARCHAR(20) DEFAULT 'success'");
            }
            $hasIdx = $pdo->query("SHOW INDEX FROM webhook_deliveries WHERE Key_name = 'idx_deliveries_retry'")->rowCount() > 0;
            if (!$hasIdx) {
                $pdo->exec("ALTER TABLE webhook_deliveries ADD INDEX idx_deliveries_retry (status, next_retry_at)");
            }
        }

        // Create pack_installations table if it doesn't exist
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS pack_installations (
                id VARCHAR(36) PRIMARY KEY,
                user_id VARCHAR(36) NOT NULL,
                pack_id VARCHAR(100) NOT NULL,
                pack_name VARCHAR(255) NOT NULL,
                pack_version VARCHAR(50) DEFAULT '1.0.0',
                pack_description TEXT,
                form_ids JSON NOT NULL,
                app_ids JSON NOT NULL,
                installed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                INDEX idx_pack_user (user_id),
                INDEX idx_pack_id (pack_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Create pack_catalog table if it doesn't exist (marketplace)
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS pack_catalog (
                id VARCHAR(36) PRIMARY KEY,
                slug VARCHAR(100) NOT NULL UNIQUE,
                publisher_id VARCHAR(36) NOT NULL,
                name VARCHAR(255) NOT NULL,
                description TEXT,
                icon VARCHAR(50),
                screenshot VARCHAR(500),
                screenshots JSON,
                tags JSON,
                category VARCHAR(100),
                item_type ENUM('application_package','connector','theme','widget','quickjs_library','sdk_component','template') DEFAULT 'application_package',
                trust_level ENUM('official','verified','community','private') DEFAULT 'community',
                visibility ENUM('public','private','unlisted') DEFAULT 'public',
                status ENUM('draft','published','archived') DEFAULT 'draft',
                download_count INT UNSIGNED DEFAULT 0,
                avg_rating DECIMAL(3,2) DEFAULT 0,
                rating_count INT UNSIGNED DEFAULT 0,
                featured TINYINT(1) DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (publisher_id) REFERENCES users(id) ON DELETE CASCADE,
                INDEX idx_category (category),
                INDEX idx_item_type (item_type),
                INDEX idx_trust_level (trust_level),
                INDEX idx_visibility_status (visibility, status),
                INDEX idx_featured (featured)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Marketplace item_type + trust_level for existing pack_catalog installs (spec §30).
        $result = $pdo->query("SHOW COLUMNS FROM pack_catalog LIKE 'item_type'");
        if ($result->rowCount() === 0) {
            $pdo->exec("ALTER TABLE pack_catalog ADD COLUMN item_type ENUM('application_package','connector','theme','widget','quickjs_library','sdk_component','template') DEFAULT 'application_package' AFTER category");
            $pdo->exec("ALTER TABLE pack_catalog ADD INDEX idx_item_type (item_type)");
        }
        $result = $pdo->query("SHOW COLUMNS FROM pack_catalog LIKE 'trust_level'");
        if ($result->rowCount() === 0) {
            $pdo->exec("ALTER TABLE pack_catalog ADD COLUMN trust_level ENUM('official','verified','community','private') DEFAULT 'community' AFTER item_type");
            $pdo->exec("ALTER TABLE pack_catalog ADD INDEX idx_trust_level (trust_level)");
        }

        // Screenshot metadata is written by PackCatalogService during first-party
        // pack provisioning. Keep older databases compatible with that pipeline.
        $result = $pdo->query("SHOW COLUMNS FROM pack_catalog LIKE 'screenshot'");
        if ($result->rowCount() === 0) {
            $pdo->exec("ALTER TABLE pack_catalog ADD COLUMN screenshot VARCHAR(500) NULL AFTER icon");
        }
        $result = $pdo->query("SHOW COLUMNS FROM pack_catalog LIKE 'screenshots'");
        if ($result->rowCount() === 0) {
            $pdo->exec("ALTER TABLE pack_catalog ADD COLUMN screenshots JSON NULL AFTER screenshot");
        }

        $pdo->exec("
            CREATE TABLE IF NOT EXISTS pack_versions (
                id VARCHAR(36) PRIMARY KEY,
                catalog_id VARCHAR(36) NOT NULL,
                version VARCHAR(50) NOT NULL,
                changelog TEXT,
                pack_data JSON NOT NULL,
                file_path VARCHAR(500),
                form_count INT UNSIGNED DEFAULT 0,
                app_count INT UNSIGNED DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (catalog_id) REFERENCES pack_catalog(id) ON DELETE CASCADE,
                UNIQUE KEY idx_catalog_version (catalog_id, version),
                INDEX idx_created (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        $pdo->exec("
            CREATE TABLE IF NOT EXISTS pack_ratings (
                id VARCHAR(36) PRIMARY KEY,
                catalog_id VARCHAR(36) NOT NULL,
                user_id VARCHAR(36) NOT NULL,
                rating TINYINT UNSIGNED NOT NULL,
                review TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (catalog_id) REFERENCES pack_catalog(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE KEY idx_user_pack (catalog_id, user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Add catalog_id and version_id columns to pack_installations if they don't exist
        $result = $pdo->query("SHOW COLUMNS FROM pack_installations LIKE 'catalog_id'");
        if ($result->rowCount() === 0) {
            $pdo->exec("ALTER TABLE pack_installations ADD COLUMN catalog_id VARCHAR(36) DEFAULT NULL AFTER pack_id");
            $pdo->exec("ALTER TABLE pack_installations ADD INDEX idx_catalog (catalog_id)");
        }
        $result = $pdo->query("SHOW COLUMNS FROM pack_installations LIKE 'version_id'");
        if ($result->rowCount() === 0) {
            $pdo->exec("ALTER TABLE pack_installations ADD COLUMN version_id VARCHAR(36) DEFAULT NULL AFTER catalog_id");
        }

        // Create api_keys table
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS api_keys (
                id VARCHAR(36) PRIMARY KEY,
                user_id VARCHAR(36) NOT NULL,
                name VARCHAR(255) NOT NULL,
                key_prefix VARCHAR(12) NOT NULL,
                key_hash VARCHAR(64) NOT NULL,
                scopes JSON NOT NULL,
                form_ids JSON DEFAULT NULL,
                last_used_at TIMESTAMP NULL,
                last_used_ip VARCHAR(45) NULL,
                expires_at TIMESTAMP NULL,
                is_active TINYINT(1) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE INDEX idx_api_keys_hash (key_hash),
                INDEX idx_api_keys_user (user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Ephemeral MCP sessions: short-lived, scoped tokens that let an external AI (Claude/Cursor/…)
        // drive the API over the MCP server. TTL + idle timeout + revoke; one row per issued token.
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS mcp_sessions (
                id VARCHAR(36) PRIMARY KEY,
                user_id VARCHAR(36) NOT NULL,
                app_id VARCHAR(36) DEFAULT NULL,
                token_hash VARCHAR(64) NOT NULL,
                scopes JSON DEFAULT NULL,
                created_ids JSON DEFAULT NULL,
                resource VARCHAR(500) DEFAULT NULL,
                oauth_client_id VARCHAR(500) DEFAULT NULL,
                device_id VARCHAR(200) DEFAULT NULL,
                refresh_family_id VARCHAR(36) DEFAULT NULL,
                expires_at TIMESTAMP NOT NULL,
                idle_timeout_seconds INT NOT NULL DEFAULT 1800,
                last_used_at TIMESTAMP NULL,
                last_used_ip VARCHAR(45) NULL,
                revoked_at TIMESTAMP NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE INDEX idx_mcp_hash (token_hash),
                INDEX idx_mcp_user (user_id),
                INDEX idx_mcp_oauth_device (oauth_client_id, device_id),
                INDEX idx_mcp_refresh_family (refresh_family_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // OAuth audience binding for OAuth-minted MCP access tokens (RFC 8707): the resource
        // ('<origin>/api/mcp') the token was issued for; NULL for manual flm_ tokens. Guarded ALTER
        // for installs whose mcp_sessions predates the column (the CREATE above carries it fresh).
        $result = $pdo->query("SHOW COLUMNS FROM mcp_sessions LIKE 'resource'");
        if ($result->rowCount() === 0) {
            $pdo->exec("ALTER TABLE mcp_sessions ADD COLUMN resource VARCHAR(500) DEFAULT NULL AFTER created_ids");
        }

        // ── MCP OAuth 2.1 authorization server (Claude Connectors / ChatGPT / Claude Code) ──
        // Registered clients: RFC 7591 dynamic registrations (opaque mcpc_ ids, secret stored HASHED)
        // and cached CIMD documents (client_id = the metadata URL, is_cimd=1, fetched_at = cache time).
        // The PRIMARY KEY is sha256(client_id) so a long CIMD URL never hits index-length limits.
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
                client_id_hash CHAR(64) PRIMARY KEY,
                client_id VARCHAR(500) NOT NULL,
                secret_hash VARCHAR(64) NULL,
                token_endpoint_auth_method VARCHAR(32) NOT NULL DEFAULT 'client_secret_post',
                client_name VARCHAR(255) NULL,
                client_uri VARCHAR(500) NULL,
                redirect_uris JSON NOT NULL,
                is_cimd TINYINT(1) NOT NULL DEFAULT 0,
                fetched_at TIMESTAMP NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // One-time authorization codes (<=60s TTL, single use enforced via used_at + rowCount),
        // bound to client + redirect_uri + PKCE challenge + user + scopes + resource (+ optional app
        // narrowing). Stored HASHED; rows are purged opportunistically after a grace period.
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
                id VARCHAR(36) PRIMARY KEY,
                code_hash CHAR(64) NOT NULL,
                client_id VARCHAR(500) NOT NULL,
                user_id VARCHAR(36) NOT NULL,
                app_id VARCHAR(36) NULL,
                redirect_uri VARCHAR(1000) NOT NULL,
                scopes JSON NOT NULL,
                code_challenge VARCHAR(128) NOT NULL,
                resource VARCHAR(500) NULL,
                device_label VARCHAR(120) NULL,
                expires_at TIMESTAMP NOT NULL,
                used_at TIMESTAMP NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE INDEX idx_oauth_code_hash (code_hash),
                INDEX idx_oauth_code_user (user_id),
                INDEX idx_oauth_code_expires (expires_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Refresh tokens (HASHED, ~30d TTL). family_id chains rotations: public clients rotate on
        // every use (rotated_at marks the retired token) and REUSE of a rotated token revokes the
        // whole family (revoked_at) — the OAuth 2.1 stolen-refresh-token defense.
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS mcp_oauth_refresh_tokens (
                id VARCHAR(36) PRIMARY KEY,
                token_hash CHAR(64) NOT NULL,
                family_id VARCHAR(36) NOT NULL,
                client_id VARCHAR(500) NOT NULL,
                user_id VARCHAR(36) NOT NULL,
                app_id VARCHAR(36) NULL,
                scopes JSON NOT NULL,
                resource VARCHAR(500) NULL,
                device_id VARCHAR(200) NULL,
                expires_at TIMESTAMP NOT NULL,
                rotated_at TIMESTAMP NULL,
                revoked_at TIMESTAMP NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE INDEX idx_oauth_rt_hash (token_hash),
                INDEX idx_oauth_rt_family (family_id),
                INDEX idx_oauth_rt_user (user_id),
                INDEX idx_oauth_rt_expires (expires_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Durable native endpoint approval/revocation. Gateway admissions are
        // deliberately short lived; this table remains the FormLogic source of
        // truth checked on every admission exchange.
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS aokie_companion_devices (
                id VARCHAR(36) PRIMARY KEY,
                user_id VARCHAR(36) NOT NULL,
                app_id VARCHAR(36) NOT NULL,
                subject_id VARCHAR(200) NOT NULL,
                role VARCHAR(16) NOT NULL,
                display_name VARCHAR(120) NOT NULL,
                grants JSON NOT NULL,
                holder_key_thumbprint VARCHAR(64) NULL,
                endpoint_public_key JSON NULL,
                approved_peer_key_thumbprints JSON NULL,
                peer_roster_revision BIGINT UNSIGNED NULL,
                peer_roster_hash VARCHAR(64) NULL,
                desktop_connection_id VARCHAR(36) NULL,
                approved_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                revoked_at TIMESTAMP NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
                UNIQUE INDEX idx_aokie_companion_endpoint (app_id, subject_id, role),
                INDEX idx_aokie_companion_owner (user_id, app_id),
                INDEX idx_aokie_companion_revoked (revoked_at),
                INDEX idx_aokie_companion_desktop (desktop_connection_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");
        $this->createAokieCompanionOperationalTables($pdo);

        // Add token_version column to users for JWT revocation (R2). Without this
        // on the runtime path, revocation silently no-ops (getTokenVersion fails open).
        $result = $pdo->query("SHOW COLUMNS FROM users LIKE 'token_version'");
        if ($result->rowCount() === 0) {
            $pdo->exec("ALTER TABLE users ADD COLUMN token_version INT NOT NULL DEFAULT 0");
        }

        // Per-account display timezone (IANA name) — record times are shown in
        // this zone (falling back to the app's timezone, then UTC). Nullable;
        // existing rows default to unset.
        $result = $pdo->query("SHOW COLUMNS FROM users LIKE 'timezone'");
        if ($result->rowCount() === 0) {
            $pdo->exec("ALTER TABLE users ADD COLUMN timezone VARCHAR(64) DEFAULT NULL AFTER name");
        }

        // Optional TOTP multi-factor auth: the base32 secret (pending until a
        // code proves the authenticator), the enabled flag, and the hashed
        // single-use recovery codes (JSON array of sha256 hex).
        foreach ([
            'mfa_secret' => "ALTER TABLE users ADD COLUMN mfa_secret VARCHAR(64) DEFAULT NULL",
            'mfa_enabled' => "ALTER TABLE users ADD COLUMN mfa_enabled TINYINT(1) NOT NULL DEFAULT 0",
            'mfa_recovery_codes' => "ALTER TABLE users ADD COLUMN mfa_recovery_codes TEXT DEFAULT NULL",
        ] as $col => $ddl) {
            $result = $pdo->query("SHOW COLUMNS FROM users LIKE '{$col}'");
            if ($result->rowCount() === 0) {
                $pdo->exec($ddl);
            }
        }

        // Remembered browsers for MFA ("don't ask again on this device"): the
        // cookie holds a random token, only its sha256 lives here. last_used_at
        // tracks each password login that skipped the code on this browser.
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS mfa_trusted_browsers (
                id VARCHAR(36) PRIMARY KEY,
                user_id VARCHAR(36) NOT NULL,
                token_hash CHAR(64) NOT NULL,
                label VARCHAR(255) NOT NULL DEFAULT '',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                INDEX idx_mfa_trust_user (user_id),
                INDEX idx_mfa_trust_hash (token_hash)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // One-time MFA login challenges (audit MFA-001): every pending-MFA token
        // minted at the password step gets a server-side row keyed by the hash of
        // its jti claim. The code exchange atomically claims the row (consumed_at),
        // so one pending token can never mint more than one session, and per-token
        // attempts are counted independently of the IP rate limit.
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS mfa_challenges (
                jti_hash CHAR(64) NOT NULL PRIMARY KEY,
                user_id VARCHAR(36) NOT NULL,
                attempts INT NOT NULL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP NOT NULL,
                consumed_at TIMESTAMP NULL DEFAULT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                INDEX idx_mfa_chal_user (user_id),
                INDEX idx_mfa_chal_expires (expires_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Create rate_limits table for persistent rate limiting / login throttling (R1).
        // Without this on the runtime path, RateLimiter fails open and throttling is a no-op.
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS rate_limits (
                bucket CHAR(64) NOT NULL,
                window_start BIGINT NOT NULL,
                hits INT NOT NULL DEFAULT 0,
                PRIMARY KEY (bucket, window_start),
                INDEX idx_window_start (window_start)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Small key/value store for operational metadata (e.g. background-worker heartbeats).
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS system_meta (
                meta_key VARCHAR(64) NOT NULL PRIMARY KEY,
                meta_value TEXT NULL,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Pay-as-you-go cloud access: an expiry date on the user (NULL = free tier).
        // Each paid month extends it; there is no recurring subscription.
        $result = $pdo->query("SHOW COLUMNS FROM users LIKE 'cloud_until'");
        if ($result->rowCount() === 0) {
            $pdo->exec("ALTER TABLE users ADD COLUMN cloud_until DATETIME NULL DEFAULT NULL");
        }

        // Platform administrator flag (admin panel) — distinct from app-level RBAC.
        // The first flag is set by bin/bootstrap-admin.php; email is never authority.
        $result = $pdo->query("SHOW COLUMNS FROM users LIKE 'is_admin'");
        if ($result->rowCount() === 0) {
            $pdo->exec("ALTER TABLE users ADD COLUMN is_admin TINYINT(1) NOT NULL DEFAULT 0");
        }

        // Presence for the admin panel's "logged-in users" count: bumped (throttled
        // to once a minute) by AuthMiddleware on authenticated requests.
        $result = $pdo->query("SHOW COLUMNS FROM users LIKE 'last_seen_at'");
        if ($result->rowCount() === 0) {
            $pdo->exec("ALTER TABLE users ADD COLUMN last_seen_at DATETIME NULL DEFAULT NULL");
        }

        // Admin broadcast notices — toast messages pushed to signed-in dashboards
        // (audience 'online' = short expiry so only current sessions see it;
        // 'all' = persists until expiry/revoke so later logins see it too).
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS admin_notices (
                id VARCHAR(36) PRIMARY KEY,
                message TEXT NOT NULL,
                level VARCHAR(16) NOT NULL DEFAULT 'info',
                audience VARCHAR(16) NOT NULL DEFAULT 'online',
                created_by VARCHAR(36) NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                expires_at DATETIME NULL DEFAULT NULL,
                revoked_at DATETIME NULL DEFAULT NULL,
                INDEX idx_notice_active (revoked_at, expires_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Plan tier — 'personal' (default, subject to cloud limits) or 'enterprise'
        // (unlimited). Only meaningful when CLOUD_PLAN_ENFORCED=true (hosted SaaS).
        $result = $pdo->query("SHOW COLUMNS FROM users LIKE 'plan'");
        if ($result->rowCount() === 0) {
            $pdo->exec("ALTER TABLE users ADD COLUMN plan VARCHAR(20) NOT NULL DEFAULT 'personal'");
        }

        // Payments ledger — one row per PayPal order (pay-as-you-go cloud months).
        // order_id + capture_id are unique so an order/capture can only credit once.
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS payments (
                id VARCHAR(36) PRIMARY KEY,
                user_id VARCHAR(36) NOT NULL,
                provider VARCHAR(20) NOT NULL DEFAULT 'paypal',
                order_id VARCHAR(64) NOT NULL,
                capture_id VARCHAR(64) NULL,
                amount_cents INT NOT NULL,
                currency CHAR(3) NOT NULL DEFAULT 'USD',
                months INT NOT NULL,
                status ENUM('pending','processing','completed','failed') NOT NULL DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE INDEX idx_payments_order (order_id),
                UNIQUE INDEX idx_payments_capture (capture_id),
                INDEX idx_payments_user (user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Payment states beyond the original 3: 'processing' (eCheck/review holds that
        // settle async — never terminal 'failed') and 'reversed' (chargeback/clawback of a
        // previously-completed payment — distinct from a never-credited 'failed').
        $col = $pdo->query("SHOW COLUMNS FROM payments LIKE 'status'")->fetch(PDO::FETCH_ASSOC);
        if ($col && stripos($col['Type'], "'reversed'") === false) {
            $pdo->exec("ALTER TABLE payments MODIFY COLUMN status ENUM('pending','processing','completed','failed','reversed') NOT NULL DEFAULT 'pending'");
        }

        // Custom domains: an app can be launched on the owner's own domain (mine.management).
        // One app → many domains; normalized_domain is unique so a domain can't be double-claimed.
        // Verification is DNS-TXT (a per-domain token); landing_config holds the branded launch page.
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS app_domains (
                id VARCHAR(36) PRIMARY KEY,
                app_id VARCHAR(36) NOT NULL,
                owner_id VARCHAR(36) NOT NULL,
                domain VARCHAR(255) NOT NULL,
                normalized_domain VARCHAR(255) NOT NULL,
                mode VARCHAR(32) NOT NULL DEFAULT 'launch_page',
                status VARCHAR(32) NOT NULL DEFAULT 'pending',
                verification_method VARCHAR(32) NOT NULL DEFAULT 'dns_txt',
                verification_token VARCHAR(128) NOT NULL,
                verified_at DATETIME NULL,
                tls_status VARCHAR(32) NOT NULL DEFAULT 'pending',
                landing_config JSON NULL,
                native_config JSON NULL,
                pwa_config JSON NULL,
                security_config JSON NULL,
                last_checked_at DATETIME NULL,
                last_error TEXT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE INDEX idx_app_domains_norm (normalized_domain),
                INDEX idx_app_domains_app (app_id),
                INDEX idx_app_domains_owner (owner_id),
                INDEX idx_app_domains_status (status),
                FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
                FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Offline-sync idempotency ledger: one row per (app, form, idempotency_key). Makes a replayed
        // submission (Workbox background-sync / native queue flush / manual retry) return the SAME
        // response instead of creating a duplicate record.
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS app_submission_idempotency (
                id VARCHAR(36) PRIMARY KEY,
                app_id VARCHAR(36) NOT NULL,
                form_id VARCHAR(36) NOT NULL,
                user_id VARCHAR(36) NULL,
                idempotency_key VARCHAR(128) NOT NULL,
                response_id VARCHAR(36) NULL,
                payload_hash VARCHAR(128) NOT NULL,
                status VARCHAR(32) NOT NULL DEFAULT 'completed',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_app_form_key (app_id, form_id, idempotency_key),
                INDEX idx_idem_app (app_id),
                INDEX idx_idem_created (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Retention index for existing installs (the CREATE TABLE above already carries it on a fresh DB):
        // the idempotency ledger grows one row per submission and is pruned by created_at (bin/idempotency-cleanup.php),
        // so ensure the created_at index exists for a cheap range DELETE + the HealthController row-count check.
        try {
            $hasIdemIdx = $pdo->query("SHOW INDEX FROM app_submission_idempotency WHERE Key_name = 'idx_idem_created'")->rowCount() > 0;
            if (!$hasIdemIdx) {
                $pdo->exec("ALTER TABLE app_submission_idempotency ADD INDEX idx_idem_created (created_at)");
            }
        } catch (\Throwable $e) {
            // Table not present yet on some ordering — the CREATE TABLE above includes the index.
        }

        // Classic public-form submission idempotency ledger: one row per (form, idempotency_key).
        // Same purpose as app_submission_idempotency above (a replayed submission — Workbox
        // background-sync / manual retry — returns the SAME response instead of creating a
        // duplicate), but for the standalone POST /api/forms/{formId}/responses endpoint, which has
        // no app_id (a classic form is not necessarily part of an app). Deliberately a SEPARATE
        // table, not a shared one with a nullable app_id — see ResponseController's idempotency*
        // methods, which mirror AppPublicController's by hand.
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS form_submission_idempotency (
                id VARCHAR(36) PRIMARY KEY,
                form_id VARCHAR(36) NOT NULL,
                user_id VARCHAR(36) NULL,
                idempotency_key VARCHAR(128) NOT NULL,
                response_id VARCHAR(36) NULL,
                payload_hash VARCHAR(128) NOT NULL,
                status VARCHAR(32) NOT NULL DEFAULT 'completed',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_form_key (form_id, idempotency_key),
                INDEX idx_form_idem_created (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Durable cross-store operation ledger (audit FL-DATA-001): one row per MySQL↔SQLite↔
        // filesystem mutation in flight, written in the SAME transaction as the MySQL side and
        // deleted only after every store is verified in agreement. A surviving row is pending
        // work: reconcile reports/retries it, and account erasure refuses to drop a users row
        // while that user has pending ops (see StoreOpService).
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS store_ops (
                id VARCHAR(36) PRIMARY KEY,
                op_type VARCHAR(32) NOT NULL,
                entity_type VARCHAR(32) NOT NULL,
                entity_id VARCHAR(64) NOT NULL,
                user_id VARCHAR(36) NULL,
                detail TEXT NULL,
                last_error TEXT NULL,
                attempts INT NOT NULL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_store_ops_entity (entity_type, entity_id),
                INDEX idx_store_ops_user (user_id),
                INDEX idx_store_ops_created (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // Recycle bin: user-facing deletes of forms/apps/flows snapshot a restorable
        // zip (storage/trash/<userId>/<id>.zip) BEFORE the hard delete; rows expire
        // after trash.retentionDays and are purged by the nightly maintenance run.
        // status='restoring' is the atomic restore claim (double-restore guard).
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS trash_items (
                id VARCHAR(36) PRIMARY KEY,
                user_id VARCHAR(36) NOT NULL,
                kind ENUM('form','app','flow') NOT NULL,
                original_id VARCHAR(36) NOT NULL,
                name VARCHAR(255) NOT NULL,
                zip_path VARCHAR(500) NOT NULL,
                size_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
                meta JSON NULL,
                status ENUM('trashed','restoring') NOT NULL DEFAULT 'trashed',
                deleted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP NOT NULL,
                INDEX idx_trash_user (user_id, deleted_at),
                INDEX idx_trash_expires (expires_at),
                CONSTRAINT trash_items_ibfk_1 FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");

        // FormLogic Flows tables for existing installs (CREATE TABLE IF NOT EXISTS; shared with
        // initializeSchema so fresh and migrated schemas match byte-for-byte).
        $this->createFlowTables($pdo);

        // Flows v1 (workspace scope + queued/claim lifecycle) for installs whose flow tables
        // predate it. The CREATEs above already carry these on a fresh DB; each ALTER below is
        // guarded so it only fires on the old shape.
        // 1) app_flow_bindings.app_id NOT NULL → NULL (workspace bindings on standalone forms).
        $col = $pdo->query("SHOW COLUMNS FROM app_flow_bindings LIKE 'app_id'")->fetch(PDO::FETCH_ASSOC);
        if ($col && strtoupper((string) ($col['Null'] ?? '')) === 'NO') {
            $pdo->exec("ALTER TABLE app_flow_bindings MODIFY COLUMN app_id VARCHAR(36) NULL");
        }
        // 2) flow_run_logs.app_id NOT NULL → NULL (workspace-flow runs carry no app).
        $col = $pdo->query("SHOW COLUMNS FROM flow_run_logs LIKE 'app_id'")->fetch(PDO::FETCH_ASSOC);
        if ($col && strtoupper((string) ($col['Null'] ?? '')) === 'NO') {
            $pdo->exec("ALTER TABLE flow_run_logs MODIFY COLUMN app_id VARCHAR(36) NULL");
        }
        // 3) flow_run_logs.runtime + claimed_by (which runner claimed a queued run).
        if ($pdo->query("SHOW COLUMNS FROM flow_run_logs LIKE 'runtime'")->rowCount() === 0) {
            $pdo->exec("ALTER TABLE flow_run_logs ADD COLUMN runtime VARCHAR(20) NULL AFTER status");
        }
        if ($pdo->query("SHOW COLUMNS FROM flow_run_logs LIKE 'claimed_by'")->rowCount() === 0) {
            $pdo->exec("ALTER TABLE flow_run_logs ADD COLUMN claimed_by VARCHAR(120) NULL AFTER runtime");
        }
        // Flow execution location (plan Phase 5 section 5.7): the per-flow Auto/Desktop/Cloud
        // choice, and the as-executed location stamped on every run log row. Fresh installs
        // carry both via createFlowTables above.
        if ($pdo->query("SHOW COLUMNS FROM flow_definitions LIKE 'execution_location'")->rowCount() === 0) {
            $pdo->exec("ALTER TABLE flow_definitions ADD COLUMN execution_location VARCHAR(8) NOT NULL DEFAULT 'auto' AFTER enabled");
        }
        if ($pdo->query("SHOW COLUMNS FROM flow_run_logs LIKE 'execution_location'")->rowCount() === 0) {
            $pdo->exec("ALTER TABLE flow_run_logs ADD COLUMN execution_location VARCHAR(8) NULL AFTER runtime");
        }
        // flow_run_logs.flow_version_id: immutable-revision pin recorded at reserve time
        // (extensible-flows plan §14.2). The flow_definition_versions table itself comes
        // from createFlowTables above; pre-existing installs only lack this column.
        if ($pdo->query("SHOW COLUMNS FROM flow_run_logs LIKE 'flow_version_id'")->rowCount() === 0) {
            $pdo->exec("ALTER TABLE flow_run_logs ADD COLUMN flow_version_id VARCHAR(36) NULL AFTER flow_definition_id");
        }
        // Run lineage (extensible-flows plan §8.7/§14.1): parent/root/call-node/depth,
        // SERVER-derived from the parent row at reserve time (client lineage is never
        // trusted). Roots keep NULL parent/root and depth 0.
        foreach ([
            'parent_run_id' => "ALTER TABLE flow_run_logs ADD COLUMN parent_run_id VARCHAR(36) NULL AFTER flow_version_id",
            'root_run_id' => "ALTER TABLE flow_run_logs ADD COLUMN root_run_id VARCHAR(36) NULL AFTER parent_run_id",
            'call_node_id' => "ALTER TABLE flow_run_logs ADD COLUMN call_node_id VARCHAR(128) NULL AFTER root_run_id",
            'depth' => "ALTER TABLE flow_run_logs ADD COLUMN depth INT NOT NULL DEFAULT 0 AFTER call_node_id",
        ] as $column => $ddl) {
            if ($pdo->query("SHOW COLUMNS FROM flow_run_logs LIKE '{$column}'")->rowCount() === 0) {
                $pdo->exec($ddl);
            }
        }
        if ($pdo->query("SHOW INDEX FROM flow_run_logs WHERE Key_name = 'idx_frl_root'")->rowCount() === 0) {
            $pdo->exec("ALTER TABLE flow_run_logs ADD INDEX idx_frl_root (root_run_id)");
        }
        if ($pdo->query("SHOW INDEX FROM flow_run_logs WHERE Key_name = 'idx_frl_parent'")->rowCount() === 0) {
            $pdo->exec("ALTER TABLE flow_run_logs ADD INDEX idx_frl_parent (parent_run_id)");
        }
        // desktop_connections.api_key_id (OAuth device-link → minted flk_ key) for installs that
        // predate the OAuth linking flow. Fresh installs already carry it (createFlowTables above).
        if ($pdo->query("SHOW COLUMNS FROM desktop_connections LIKE 'api_key_id'")->rowCount() === 0) {
            $pdo->exec("ALTER TABLE desktop_connections ADD COLUMN api_key_id VARCHAR(36) NULL AFTER desktop_instance_id");
        }
        // E2E AI relay (plan Phase 1): the desktop publishes its long-term X25519 public
        // key here for browser TOFU pinning; NULL until POST /api/v1/desktop-ai/pubkey.
        if ($pdo->query("SHOW COLUMNS FROM desktop_connections LIKE 'e2e_public_key'")->rowCount() === 0) {
            $pdo->exec("ALTER TABLE desktop_connections ADD COLUMN e2e_public_key VARCHAR(88) NULL AFTER trusted_origins_json");
        }
        // ROUTE-001: a relay command may be TARGETED at one desktop instance — only that
        // instance sees/claims it; NULL keeps the legacy owner-wide first-to-claim fan-out.
        if ($pdo->query("SHOW COLUMNS FROM desktop_commands LIKE 'target_instance_id'")->rowCount() === 0) {
            $pdo->exec("ALTER TABLE desktop_commands ADD COLUMN target_instance_id VARCHAR(128) NULL AFTER requested_by_user_id");
        }
        // ROUTE-001: a connector assignment may also pin WHICH desktop connection runs the
        // connector's commands (SET NULL on unlink so a deleted connection falls back to
        // implicit-single / ambiguous resolution rather than dangling).
        if ($pdo->query("SHOW COLUMNS FROM connector_assignments LIKE 'desktop_connection_id'")->rowCount() === 0) {
            $pdo->exec("ALTER TABLE connector_assignments ADD COLUMN desktop_connection_id VARCHAR(36) NULL AFTER app_id");
            $pdo->exec("ALTER TABLE connector_assignments ADD CONSTRAINT fk_connector_assignment_desktop
                        FOREIGN KEY (desktop_connection_id) REFERENCES desktop_connections(id) ON DELETE SET NULL");
        }
        // Bind opaque OAuth sessions to the exact client profile and, for
        // Companion, to one stable native device. Existing MCP/manual rows stay
        // NULL and therefore cannot pass the Companion admission gate.
        if ($pdo->query("SHOW COLUMNS FROM mcp_sessions LIKE 'oauth_client_id'")->rowCount() === 0) {
            $pdo->exec("ALTER TABLE mcp_sessions ADD COLUMN oauth_client_id VARCHAR(500) NULL AFTER resource");
        }
        if ($pdo->query("SHOW COLUMNS FROM mcp_sessions LIKE 'device_id'")->rowCount() === 0) {
            $pdo->exec("ALTER TABLE mcp_sessions ADD COLUMN device_id VARCHAR(200) NULL AFTER oauth_client_id");
        }
        if ($pdo->query("SHOW COLUMNS FROM mcp_sessions LIKE 'refresh_family_id'")->rowCount() === 0) {
            $pdo->exec("ALTER TABLE mcp_sessions ADD COLUMN refresh_family_id VARCHAR(36) NULL AFTER device_id");
        }
        if ($pdo->query("SHOW INDEX FROM mcp_sessions WHERE Key_name = 'idx_mcp_oauth_device'")->rowCount() === 0) {
            $pdo->exec("ALTER TABLE mcp_sessions ADD INDEX idx_mcp_oauth_device (oauth_client_id, device_id)");
        }
        if ($pdo->query("SHOW INDEX FROM mcp_sessions WHERE Key_name = 'idx_mcp_refresh_family'")->rowCount() === 0) {
            $pdo->exec("ALTER TABLE mcp_sessions ADD INDEX idx_mcp_refresh_family (refresh_family_id)");
        }
        if ($pdo->query("SHOW COLUMNS FROM mcp_oauth_refresh_tokens LIKE 'device_id'")->rowCount() === 0) {
            $pdo->exec("ALTER TABLE mcp_oauth_refresh_tokens ADD COLUMN device_id VARCHAR(200) NULL AFTER resource");
        }
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS aokie_companion_devices (
                id VARCHAR(36) PRIMARY KEY,
                user_id VARCHAR(36) NOT NULL,
                app_id VARCHAR(36) NOT NULL,
                subject_id VARCHAR(200) NOT NULL,
                role VARCHAR(16) NOT NULL,
                display_name VARCHAR(120) NOT NULL,
                grants JSON NOT NULL,
                holder_key_thumbprint VARCHAR(64) NULL,
                endpoint_public_key JSON NULL,
                approved_peer_key_thumbprints JSON NULL,
                peer_roster_revision BIGINT UNSIGNED NULL,
                peer_roster_hash VARCHAR(64) NULL,
                desktop_connection_id VARCHAR(36) NULL,
                approved_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                revoked_at TIMESTAMP NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
                UNIQUE INDEX idx_aokie_companion_endpoint (app_id, subject_id, role),
                INDEX idx_aokie_companion_owner (user_id, app_id),
                INDEX idx_aokie_companion_revoked (revoked_at),
                INDEX idx_aokie_companion_desktop (desktop_connection_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");
        foreach ([
            'holder_key_thumbprint' => 'ALTER TABLE aokie_companion_devices ADD COLUMN holder_key_thumbprint VARCHAR(64) NULL AFTER grants',
            'endpoint_public_key' => 'ALTER TABLE aokie_companion_devices ADD COLUMN endpoint_public_key JSON NULL AFTER holder_key_thumbprint',
            'approved_peer_key_thumbprints' => 'ALTER TABLE aokie_companion_devices ADD COLUMN approved_peer_key_thumbprints JSON NULL AFTER endpoint_public_key',
            'peer_roster_revision' => 'ALTER TABLE aokie_companion_devices ADD COLUMN peer_roster_revision BIGINT UNSIGNED NULL AFTER approved_peer_key_thumbprints',
            'peer_roster_hash' => 'ALTER TABLE aokie_companion_devices ADD COLUMN peer_roster_hash VARCHAR(64) NULL AFTER peer_roster_revision',
            'desktop_connection_id' => 'ALTER TABLE aokie_companion_devices ADD COLUMN desktop_connection_id VARCHAR(36) NULL AFTER peer_roster_hash',
        ] as $column => $ddl) {
            if ($pdo->query("SHOW COLUMNS FROM aokie_companion_devices LIKE '{$column}'")->rowCount() === 0) {
                $pdo->exec($ddl);
            }
        }
        if ($pdo->query("SHOW INDEX FROM aokie_companion_devices WHERE Key_name = 'idx_aokie_companion_desktop'")->rowCount() === 0) {
            $pdo->exec('ALTER TABLE aokie_companion_devices ADD INDEX idx_aokie_companion_desktop (desktop_connection_id)');
        }
        $this->createAokieCompanionOperationalTables($pdo);
        if ($pdo->query("SHOW COLUMNS FROM aokie_companion_sessions LIKE 'last_event_at'")->rowCount() === 0) {
            $pdo->exec("ALTER TABLE aokie_companion_sessions ADD COLUMN last_event_at TIMESTAMP NULL AFTER last_event_id");
            $pdo->exec("UPDATE aokie_companion_sessions SET last_event_at = COALESCE(updated_at, created_at, NOW()) WHERE last_event_at IS NULL");
            $pdo->exec("ALTER TABLE aokie_companion_sessions MODIFY COLUMN last_event_at TIMESTAMP NOT NULL");
        }
        if ($pdo->query("SHOW COLUMNS FROM aokie_companion_activity LIKE 'request_hash'")->rowCount() === 0) {
            $pdo->exec("ALTER TABLE aokie_companion_activity ADD COLUMN request_hash CHAR(64) NULL AFTER idempotency_key");
            $pdo->exec("UPDATE aokie_companion_activity SET request_hash = SHA2(CONCAT(app_id, ':', idempotency_key), 256) WHERE request_hash IS NULL");
            $pdo->exec("ALTER TABLE aokie_companion_activity MODIFY COLUMN request_hash CHAR(64) NOT NULL");
        }
        if ($pdo->query("SHOW COLUMNS FROM aokie_companion_routing_members LIKE 'availability_expires_at'")->rowCount() === 0) {
            $pdo->exec("ALTER TABLE aokie_companion_routing_members ADD COLUMN availability_expires_at TIMESTAMP NULL AFTER availability_updated_at");
        }
        // mcp_oauth_codes.device_label carries the sanitized ?device= label from the desktop
        // OAuth device-link consent through to the token exchange (names the minted key/connection).
        if ($pdo->query("SHOW TABLES LIKE 'mcp_oauth_codes'")->rowCount() > 0
            && $pdo->query("SHOW COLUMNS FROM mcp_oauth_codes LIKE 'device_label'")->rowCount() === 0) {
            $pdo->exec("ALTER TABLE mcp_oauth_codes ADD COLUMN device_label VARCHAR(120) NULL AFTER resource");
        }

        // Widen app_role_permissions.permission (was VARCHAR(50)) so connector capability grants —
        // connector.<connectorId>.<command> (see ConnectorCommandController) — aren't silently
        // truncated on longer connector/command names, which would break the exact-match RBAC check
        // (fails closed). 191 is the canonical utf8mb4 index-safe width: the composite UNIQUE key
        // (role_id, form_id, permission) stays well within InnoDB's 3072-byte prefix limit. Guarded so
        // it runs once (skips once the column is already widened).
        $permCol = $pdo->query("SHOW COLUMNS FROM app_role_permissions LIKE 'permission'")->fetch();
        if ($permCol && stripos((string) ($permCol['Type'] ?? ''), 'varchar(50)') !== false) {
            $pdo->exec("ALTER TABLE app_role_permissions MODIFY COLUMN permission VARCHAR(191) COLLATE utf8mb4_unicode_ci NOT NULL");
        }

        // FL-AUTH-001: flow execution used to be implicit in app membership; the runtime flow
        // surface (definitions/reserve/claim/complete/flow-KV) now requires the explicit
        // execute_flows permission. Backfill it onto every EXISTING role exactly once so
        // deployed apps keep working, then let owners revoke it per role. Guarded by a
        // system_meta flag rather than the md5 stamp: a later re-migration (any schema edit
        // re-runs this method) must never silently re-grant what an owner revoked.
        $backfilled = $pdo->query("SELECT meta_value FROM system_meta WHERE meta_key = 'execute_flows_backfilled'")->fetchColumn();
        if ($backfilled === false) {
            $pdo->exec("
                INSERT INTO app_role_permissions (id, role_id, form_id, permission)
                SELECT UUID(), r.id, NULL, 'execute_flows'
                FROM app_roles r
                WHERE NOT EXISTS (
                    SELECT 1 FROM app_role_permissions p
                    WHERE p.role_id = r.id AND p.permission = 'execute_flows'
                )
            ");
            $pdo->exec("INSERT INTO system_meta (meta_key, meta_value) VALUES ('execute_flows_backfilled', '1')");
        }

        // Per-user default reasoning effort for the Codex/ChatGPT desktop connector.
        if ($pdo->query("SHOW COLUMNS FROM user_ai_settings LIKE 'desktop_reasoning'")->rowCount() === 0) {
            $pdo->exec('ALTER TABLE user_ai_settings ADD COLUMN desktop_reasoning VARCHAR(16) NULL AFTER chat_tool_mode');
        }

        // Tenant-scoped idempotency keys (audit FL-08): these gates were globally UNIQUE on
        // idempotency_key alone, so one tenant could consume (or probe) another tenant's key.
        // Desktop lanes scope by owner; flow runs scope by flow definition. The composite
        // index is strictly weaker than the old global one, so existing rows never violate it.
        foreach ([
            ['desktop_ai_requests', 'uniq_desktop_ai_idem', 'owner_user_id'],
            ['desktop_commands', 'uniq_desktop_command_idem', 'owner_user_id'],
            ['desktop_flow_runs', 'uniq_desktop_flow_run_idem', 'owner_user_id'],
            ['flow_run_logs', 'uniq_flow_run_idem', 'flow_definition_id'],
        ] as [$idemTable, $idemIndex, $idemScopeCol]) {
            $idemCols = $pdo->query("SHOW INDEX FROM {$idemTable} WHERE Key_name = '{$idemIndex}'")->rowCount();
            if ($idemCols === 1) {
                $pdo->exec("ALTER TABLE {$idemTable} DROP INDEX {$idemIndex}, ADD UNIQUE KEY {$idemIndex} ({$idemScopeCol}, idempotency_key)");
            }
        }

        // Seed the first-party OAuth clients (idempotent) now that mcp_oauth_clients exists.
        $this->seedFirstPartyOAuthClients($pdo);
    }

    /** Fresh installs and upgrades share the exact same durable Companion control-plane schema. */
    private function createAokieCompanionOperationalTables(PDO $pdo): void
    {
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS aokie_companion_sessions (
                id VARCHAR(36) PRIMARY KEY,
                app_id VARCHAR(36) NOT NULL,
                external_session_id VARCHAR(200) NOT NULL,
                call_id VARCHAR(200) NOT NULL,
                device_id VARCHAR(36) NULL,
                subject_id VARCHAR(200) NOT NULL,
                mode VARCHAR(16) NOT NULL,
                state VARCHAR(16) NOT NULL,
                joined_at TIMESTAMP NULL,
                ended_at TIMESTAMP NULL,
                end_reason VARCHAR(120) NULL,
                last_event_id VARCHAR(200) NOT NULL,
                last_event_at TIMESTAMP NOT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
                FOREIGN KEY (device_id) REFERENCES aokie_companion_devices(id) ON DELETE SET NULL,
                UNIQUE INDEX idx_aokie_session_external (app_id, external_session_id),
                INDEX idx_aokie_session_call (app_id, call_id, created_at),
                INDEX idx_aokie_session_state (app_id, state, updated_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS aokie_companion_activity (
                id VARCHAR(36) PRIMARY KEY,
                app_id VARCHAR(36) NOT NULL,
                idempotency_key VARCHAR(200) NOT NULL,
                request_hash CHAR(64) NOT NULL,
                session_id VARCHAR(36) NULL,
                call_id VARCHAR(200) NULL,
                device_id VARCHAR(36) NULL,
                actor_user_id VARCHAR(36) NULL,
                subject_id VARCHAR(200) NOT NULL,
                event_type VARCHAR(40) NOT NULL,
                mode VARCHAR(16) NULL,
                reason VARCHAR(120) NULL,
                owner_epoch BIGINT UNSIGNED NULL,
                occurred_at TIMESTAMP NOT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
                FOREIGN KEY (session_id) REFERENCES aokie_companion_sessions(id) ON DELETE SET NULL,
                FOREIGN KEY (device_id) REFERENCES aokie_companion_devices(id) ON DELETE SET NULL,
                FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL,
                UNIQUE INDEX idx_aokie_activity_idempotency (app_id, idempotency_key),
                INDEX idx_aokie_activity_history (app_id, occurred_at, id),
                INDEX idx_aokie_activity_call (app_id, call_id, occurred_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS aokie_companion_routing_groups (
                id VARCHAR(36) PRIMARY KEY,
                app_id VARCHAR(36) NOT NULL,
                name VARCHAR(120) NOT NULL,
                policy VARCHAR(20) NOT NULL,
                enabled TINYINT(1) NOT NULL DEFAULT 1,
                round_robin_cursor BIGINT UNSIGNED NOT NULL DEFAULT 0,
                created_by_user_id VARCHAR(36) NOT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
                FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE INDEX idx_aokie_routing_name (app_id, name),
                INDEX idx_aokie_routing_enabled (app_id, enabled)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS aokie_companion_routing_members (
                group_id VARCHAR(36) NOT NULL,
                device_id VARCHAR(36) NOT NULL,
                priority_value INT UNSIGNED NOT NULL DEFAULT 100,
                enabled TINYINT(1) NOT NULL DEFAULT 1,
                availability VARCHAR(20) NOT NULL DEFAULT 'available',
                availability_updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                availability_expires_at TIMESTAMP NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (group_id, device_id),
                FOREIGN KEY (group_id) REFERENCES aokie_companion_routing_groups(id) ON DELETE CASCADE,
                FOREIGN KEY (device_id) REFERENCES aokie_companion_devices(id) ON DELETE CASCADE,
                INDEX idx_aokie_routing_available (group_id, enabled, availability, priority_value)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS aokie_companion_push_endpoints (
                id VARCHAR(36) PRIMARY KEY,
                app_id VARCHAR(36) NOT NULL,
                device_id VARCHAR(36) NOT NULL,
                endpoint_kind VARCHAR(20) NOT NULL,
                delivery_mode VARCHAR(16) NOT NULL,
                provider VARCHAR(20) NOT NULL,
                environment VARCHAR(16) NOT NULL,
                topic VARCHAR(255) NULL,
                endpoint_ciphertext TEXT NULL,
                broker_handle VARCHAR(512) NULL,
                endpoint_fingerprint CHAR(64) NOT NULL,
                invalidated_at TIMESTAMP NULL,
                rotated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
                FOREIGN KEY (device_id) REFERENCES aokie_companion_devices(id) ON DELETE CASCADE,
                UNIQUE INDEX idx_aokie_push_endpoint (app_id, device_id, endpoint_kind),
                INDEX idx_aokie_push_active (app_id, invalidated_at, endpoint_kind)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS aokie_companion_offers (
                id VARCHAR(36) PRIMARY KEY,
                app_id VARCHAR(36) NOT NULL,
                routing_group_id VARCHAR(36) NOT NULL,
                offer_kind VARCHAR(32) NOT NULL,
                invitation_hash CHAR(64) NOT NULL,
                request_hash CHAR(64) NOT NULL,
                collapse_hash CHAR(64) NOT NULL,
                expires_at TIMESTAMP NOT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
                FOREIGN KEY (routing_group_id) REFERENCES aokie_companion_routing_groups(id) ON DELETE CASCADE,
                UNIQUE INDEX idx_aokie_offer_invitation (app_id, invitation_hash),
                INDEX idx_aokie_offer_expiry (app_id, expires_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS aokie_companion_push_deliveries (
                id VARCHAR(36) PRIMARY KEY,
                app_id VARCHAR(36) NOT NULL,
                offer_id VARCHAR(36) NOT NULL,
                device_id VARCHAR(36) NOT NULL,
                push_endpoint_id VARCHAR(36) NULL,
                status VARCHAR(20) NOT NULL,
                payload_json JSON NOT NULL,
                attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
                claimed_at TIMESTAMP NULL,
                completed_at TIMESTAMP NULL,
                provider_message_hash CHAR(64) NULL,
                expires_at TIMESTAMP NOT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
                FOREIGN KEY (offer_id) REFERENCES aokie_companion_offers(id) ON DELETE CASCADE,
                FOREIGN KEY (device_id) REFERENCES aokie_companion_devices(id) ON DELETE CASCADE,
                FOREIGN KEY (push_endpoint_id) REFERENCES aokie_companion_push_endpoints(id) ON DELETE SET NULL,
                UNIQUE INDEX idx_aokie_delivery_target (offer_id, device_id),
                INDEX idx_aokie_delivery_queue (status, expires_at, created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");
        // Pack services wave 2: the hosted Companion relay mailbox. Rows are
        // volatile v2 signalling frames stored as OPAQUE JSON (Ed25519-signed
        // by the endpoints; the relay never interprets them). The
        // AUTO_INCREMENT seq is the delivery cursor — insertion order is the
        // contract — and a 120s TTL is swept opportunistically on every POST
        // (AokieCompanionRelayService::TTL_SECONDS).
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS aokie_companion_relay_frames (
                seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                app_id VARCHAR(36) NOT NULL,
                to_party VARCHAR(120) NOT NULL,
                from_party VARCHAR(120) NOT NULL,
                admission_subject_id VARCHAR(200) NULL,
                admission_grants JSON NULL,
                frame MEDIUMTEXT NOT NULL,
                created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
                FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
                INDEX idx_aokie_relay_inbox (app_id, to_party, seq),
                INDEX idx_aokie_relay_expiry (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        ");
        if ($pdo->query("SHOW COLUMNS FROM aokie_companion_relay_frames LIKE 'admission_subject_id'")->rowCount() === 0) {
            // Legacy rows remain NULL and therefore fail closed to subjectId:null.
            $pdo->exec('ALTER TABLE aokie_companion_relay_frames ADD COLUMN admission_subject_id VARCHAR(200) NULL AFTER from_party');
        }
        if ($pdo->query("SHOW COLUMNS FROM aokie_companion_relay_frames LIKE 'admission_grants'")->rowCount() === 0) {
            // Legacy rows remain NULL and therefore fail closed to grants:[].
            $pdo->exec('ALTER TABLE aokie_companion_relay_frames ADD COLUMN admission_grants JSON NULL AFTER from_party');
        }
    }

    /**
     * Static, first-party OAuth clients seeded into mcp_oauth_clients (idempotent upsert on
     * the client_id_hash PK). Currently: the "formlogic-desktop" PUBLIC native client (no secret,
     * PKCE S256 required) whose token exchange mints a scoped flk_ API key rather than an MCP
     * session — see McpOAuthService::DESKTOP_CLIENT_ID. The registered loopback redirect URIs are
     * matched port-agnostically (RFC 8252 §7.3), so any ephemeral port the desktop binds is accepted.
     */
    public function seedFirstPartyOAuthClients(PDO $pdo): void
    {
        if ($pdo->query("SHOW TABLES LIKE 'mcp_oauth_clients'")->rowCount() === 0) {
            return; // table not created yet on this ordering — nothing to seed
        }
        $stmt = $pdo->prepare("
            INSERT INTO mcp_oauth_clients
                (client_id_hash, client_id, secret_hash, token_endpoint_auth_method, client_name, client_uri, redirect_uris, is_cimd, fetched_at, created_at)
            VALUES (:h, :cid, NULL, 'none', :name, NULL, :redirects, 0, NULL, NOW())
            ON DUPLICATE KEY UPDATE
                client_id = VALUES(client_id), secret_hash = NULL,
                token_endpoint_auth_method = 'none', client_name = VALUES(client_name),
                client_uri = NULL, redirect_uris = VALUES(redirect_uris),
                is_cimd = 0, fetched_at = NULL
        ");
        $clients = [
            [
                'id' => \FormLogic\Services\McpOAuthService::DESKTOP_CLIENT_ID,
                'name' => 'FormLogic Desktop',
                'redirects' => ['http://127.0.0.1/callback', 'http://localhost/callback'],
            ],
            [
                'id' => \FormLogic\Services\McpOAuthService::AOKIE_COMPANION_CLIENT_ID,
                'name' => 'Aokie Companion',
                'redirects' => [
                    'com.aokie.companion:/oauth/callback',
                    'http://127.0.0.1/oauth/callback',
                    'http://localhost/oauth/callback',
                ],
            ],
        ];
        foreach ($clients as $client) {
            $stmt->execute([
                'h' => hash('sha256', $client['id']),
                'cid' => $client['id'],
                'name' => $client['name'],
                'redirects' => json_encode(
                    $client['redirects'],
                    JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR,
                ),
            ]);
        }
    }
}

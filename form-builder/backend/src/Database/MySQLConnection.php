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
                icon VARCHAR(255) DEFAULT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                published_at TIMESTAMP NULL,
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
                reports JSON DEFAULT NULL,
                custom_logic MEDIUMTEXT DEFAULT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
                INDEX idx_owner_id (owner_id),
                INDEX idx_slug (slug),
                INDEX idx_status (status)
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
                permission VARCHAR(50) NOT NULL,
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
                expires_at TIMESTAMP NOT NULL,
                idle_timeout_seconds INT NOT NULL DEFAULT 1800,
                last_used_at TIMESTAMP NULL,
                last_used_ip VARCHAR(45) NULL,
                revoked_at TIMESTAMP NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE INDEX idx_mcp_hash (token_hash),
                INDEX idx_mcp_user (user_id)
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

        // Add token_version column to users for JWT revocation (R2). Without this
        // on the runtime path, revocation silently no-ops (getTokenVersion fails open).
        $result = $pdo->query("SHOW COLUMNS FROM users LIKE 'token_version'");
        if ($result->rowCount() === 0) {
            $pdo->exec("ALTER TABLE users ADD COLUMN token_version INT NOT NULL DEFAULT 0");
        }

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
    }
}

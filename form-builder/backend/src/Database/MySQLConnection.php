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
            } catch (PDOException $e) {
                throw new PDOException('MySQL Connection failed: ' . $e->getMessage());
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
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_email (email)
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
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                published_at TIMESTAMP NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
                INDEX idx_user_id (user_id),
                INDEX idx_status (status),
                INDEX idx_created_at (created_at)
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
    }
}

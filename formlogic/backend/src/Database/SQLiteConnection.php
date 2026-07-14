<?php

declare(strict_types=1);

namespace FormLogic\Database;

use PDO;
use PDOException;

class SQLiteConnection
{
    /**
     * Increment this when adding new migrations in applyMigrations().
     * v1 = base tables (form_data, fields, responses, field_groups)
     * v2 = computed, tags, script_logs tables
     * v3 = compound indexes for common query patterns
     */
    private const SCHEMA_VERSION = 4;

    private string $storagePath;
    private array $connections = [];

    public function __construct(string $storagePath)
    {
        $this->storagePath = $storagePath;

        if (!is_dir($storagePath)) {
            if (!mkdir($storagePath, 0700, true)) {
                throw new \RuntimeException("Failed to create SQLite storage directory: {$storagePath}");
            }
        }
    }

    /**
     * Get or create a SQLite database for a specific form
     */
    public function getFormDatabase(string $formId): PDO
    {
        if (isset($this->connections[$formId])) {
            return $this->connections[$formId];
        }

        $dbPath = $this->getFormDbPath($formId);
        $isNew = !file_exists($dbPath);

        try {
            $pdo = new PDO(
                "sqlite:$dbPath",
                null,
                null,
                [
                    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                ]
            );

            // Enable WAL mode for better concurrent read/write performance
            $pdo->exec('PRAGMA journal_mode = WAL');
            // Wait up to 5s for locks instead of failing immediately
            $pdo->exec('PRAGMA busy_timeout = 5000');
            // Enable foreign keys
            $pdo->exec('PRAGMA foreign_keys = ON');

            if ($isNew) {
                $this->initializeFormSchema($pdo);
            } else {
                $this->ensureSchemaUpToDate($pdo);
            }

            $this->connections[$formId] = $pdo;
            return $pdo;

        } catch (PDOException $e) {
            // A fault during first-time init would otherwise leave a half-built
            // .sqlite that never self-heals (later connects take the non-$isNew
            // path and skip base-table creation). Remove the partial DB so the
            // next request re-initializes cleanly, and preserve the real cause.
            if ($isNew) {
                if (isset($pdo)) {
                    $pdo = null; // close the handle so the file is removable (Windows)
                }
                @unlink($dbPath);
                @unlink($dbPath . '-wal');
                @unlink($dbPath . '-shm');
            }
            throw new PDOException('SQLite Connection failed', 0, $e);
        }
    }

    /**
     * Get the path to a form's SQLite database
     *
     * Uses a hash-based approach to prevent:
     * 1. Directory traversal attacks
     * 2. Filename collisions from ID normalization
     * 3. Issues with special characters in form IDs
     */
    public function getFormDbPath(string $formId): string
    {
        // For valid UUID format, use the sanitized version directly for readability
        // UUIDs are guaranteed unique and safe for filenames
        if (preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $formId)) {
            $safeFormId = strtolower($formId);
        } else {
            // For non-UUID IDs, use a deterministic hash to prevent collisions
            // The hash is prefixed with a sanitized version for debuggability
            $sanitized = preg_replace('/[^a-zA-Z0-9\-_]/', '', substr($formId, 0, 20));
            $hash = substr(hash('sha256', $formId), 0, 16);
            $safeFormId = ($sanitized ? $sanitized . '_' : '') . $hash;
        }

        return $this->storagePath . '/' . $safeFormId . '.sqlite';
    }

    /**
     * Check if a form database exists
     */
    public function formDatabaseExists(string $formId): bool
    {
        return file_exists($this->getFormDbPath($formId));
    }

    /**
     * Delete a form's SQLite database.
     *
     * Returns true only when the main file AND its WAL/SHM journals are VERIFIED gone
     * (the -wal file holds recent response content, so leaving it behind is the same
     * PII leak as leaving the database itself). Idempotent: true when nothing exists.
     */
    public function deleteFormDatabase(string $formId): bool
    {
        $dbPath = $this->getFormDbPath($formId);

        // Close connection if open
        if (isset($this->connections[$formId])) {
            unset($this->connections[$formId]);
        }

        // Journals first, main file last — a main file without journals is still a
        // valid database, while orphaned journals would be dangling response data.
        foreach ([$dbPath . '-wal', $dbPath . '-shm', $dbPath] as $path) {
            if (file_exists($path)) {
                @unlink($path);
            }
        }

        return $this->formDatabaseFullyRemoved($formId);
    }

    /**
     * True when no trace of the form's database remains on disk (main + WAL + SHM).
     */
    public function formDatabaseFullyRemoved(string $formId): bool
    {
        $dbPath = $this->getFormDbPath($formId);
        clearstatcache();
        return !file_exists($dbPath)
            && !file_exists($dbPath . '-wal')
            && !file_exists($dbPath . '-shm');
    }

    /**
     * Initialize the schema for a form database
     */
    private function initializeFormSchema(PDO $pdo): void
    {
        // Form structure (fields, groups, etc.)
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS form_data (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                key TEXT NOT NULL UNIQUE,
                value TEXT NOT NULL,
                updated_at TEXT DEFAULT (datetime('now'))
            )
        ");

        // Fields table
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS fields (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                label TEXT,
                description TEXT,
                placeholder TEXT,
                required INTEGER DEFAULT 0,
                field_order INTEGER NOT NULL,
                properties TEXT,
                validation TEXT,
                conditional_logic TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            )
        ");

        // Create index on field order
        $pdo->exec("CREATE INDEX IF NOT EXISTS idx_field_order ON fields(field_order)");

        // Responses table
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS responses (
                id TEXT PRIMARY KEY,
                answers TEXT NOT NULL,
                metadata TEXT,
                status TEXT DEFAULT 'submitted',
                submitted_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            )
        ");

        // Create index on submitted_at
        $pdo->exec("CREATE INDEX IF NOT EXISTS idx_submitted_at ON responses(submitted_at)");
        $pdo->exec("CREATE INDEX IF NOT EXISTS idx_status ON responses(status)");

        // Field groups
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS field_groups (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                description TEXT,
                collapsible INTEGER DEFAULT 0,
                default_expanded INTEGER DEFAULT 1,
                field_ids TEXT,
                conditional_logic TEXT,
                group_order INTEGER NOT NULL,
                created_at TEXT DEFAULT (datetime('now'))
            )
        ");

        // Computed fields (from script execution)
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS computed (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                response_id TEXT NOT NULL,
                field_name TEXT NOT NULL,
                field_value TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                FOREIGN KEY (response_id) REFERENCES responses(id) ON DELETE CASCADE,
                UNIQUE(response_id, field_name)
            )
        ");
        $pdo->exec("CREATE INDEX IF NOT EXISTS idx_computed_response ON computed(response_id)");

        // Tags (from script execution)
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                response_id TEXT NOT NULL,
                tag TEXT NOT NULL,
                created_at TEXT DEFAULT (datetime('now')),
                FOREIGN KEY (response_id) REFERENCES responses(id) ON DELETE CASCADE,
                UNIQUE(response_id, tag)
            )
        ");
        $pdo->exec("CREATE INDEX IF NOT EXISTS idx_tags_response ON tags(response_id)");
        $pdo->exec("CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag)");

        // Script execution logs
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS script_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                response_id TEXT NOT NULL,
                success INTEGER DEFAULT 1,
                error_message TEXT,
                execution_time_ms INTEGER,
                instruction_count INTEGER,
                created_at TEXT DEFAULT (datetime('now')),
                FOREIGN KEY (response_id) REFERENCES responses(id) ON DELETE CASCADE
            )
        ");
        $pdo->exec("CREATE INDEX IF NOT EXISTS idx_script_logs_response ON script_logs(response_id)");

        // Compound indexes for common query patterns
        $pdo->exec("CREATE INDEX IF NOT EXISTS idx_responses_status_submitted ON responses(status, submitted_at)");
        $pdo->exec("CREATE INDEX IF NOT EXISTS idx_computed_response_field ON computed(response_id, field_name)");
        $pdo->exec("CREATE INDEX IF NOT EXISTS idx_tags_response_tag ON tags(response_id, tag)");
        // Expression index for the "own responses" scope (app members) — the submitter id
        // lives in the metadata JSON, so without this the list+count full-scan every row.
        $pdo->exec("CREATE INDEX IF NOT EXISTS idx_responses_submitted_by ON responses(json_extract(metadata, '$.submittedByUserId'))");

        // Record schema version
        $this->setSchemaVersion($pdo, self::SCHEMA_VERSION);
    }

    /**
     * Run migrations on an existing form database.
     * Kept for backward compatibility — delegates to version-based migration.
     */
    public function migrateFormDatabase(PDO $pdo): void
    {
        $this->ensureSchemaUpToDate($pdo);
    }

    /**
     * Check schema version and apply any pending migrations.
     */
    private function ensureSchemaUpToDate(PDO $pdo): void
    {
        $version = $this->getSchemaVersion($pdo);
        if ($version >= self::SCHEMA_VERSION) {
            return;
        }
        $this->applyMigrations($pdo, $version);
    }

    /**
     * Get the current schema version from form_data table.
     * Returns 0 for pre-versioning databases.
     */
    private function getSchemaVersion(PDO $pdo): int
    {
        try {
            $stmt = $pdo->prepare("SELECT value FROM form_data WHERE key = 'schema_version'");
            $stmt->execute();
            $row = $stmt->fetch();
            return $row ? (int)$row['value'] : 0;
        } catch (PDOException $e) {
            // form_data table might not exist in very old databases
            return 0;
        }
    }

    /**
     * Set the schema version in form_data table.
     */
    private function setSchemaVersion(PDO $pdo, int $version): void
    {
        $stmt = $pdo->prepare(
            "INSERT OR REPLACE INTO form_data (key, value, updated_at) "
            . "VALUES ('schema_version', :version, datetime('now'))"
        );
        $stmt->execute(['version' => (string)$version]);
    }

    /**
     * Apply incremental migrations from $fromVersion to SCHEMA_VERSION.
     * All migrations are idempotent (IF NOT EXISTS).
     */
    private function applyMigrations(PDO $pdo, int $fromVersion): void
    {
        // v0→v2: Add computed, tags, script_logs tables
        if ($fromVersion < 2) {
            $pdo->exec("
                CREATE TABLE IF NOT EXISTS computed (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    response_id TEXT NOT NULL,
                    field_name TEXT NOT NULL,
                    field_value TEXT,
                    created_at TEXT DEFAULT (datetime('now')),
                    FOREIGN KEY (response_id) REFERENCES responses(id) ON DELETE CASCADE,
                    UNIQUE(response_id, field_name)
                )
            ");
            $pdo->exec("CREATE INDEX IF NOT EXISTS idx_computed_response ON computed(response_id)");

            $pdo->exec("
                CREATE TABLE IF NOT EXISTS tags (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    response_id TEXT NOT NULL,
                    tag TEXT NOT NULL,
                    created_at TEXT DEFAULT (datetime('now')),
                    FOREIGN KEY (response_id) REFERENCES responses(id) ON DELETE CASCADE,
                    UNIQUE(response_id, tag)
                )
            ");
            $pdo->exec("CREATE INDEX IF NOT EXISTS idx_tags_response ON tags(response_id)");
            $pdo->exec("CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag)");

            $pdo->exec("
                CREATE TABLE IF NOT EXISTS script_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    response_id TEXT NOT NULL,
                    success INTEGER DEFAULT 1,
                    error_message TEXT,
                    execution_time_ms INTEGER,
                    instruction_count INTEGER,
                    created_at TEXT DEFAULT (datetime('now')),
                    FOREIGN KEY (response_id) REFERENCES responses(id) ON DELETE CASCADE
                )
            ");
            $pdo->exec("CREATE INDEX IF NOT EXISTS idx_script_logs_response ON script_logs(response_id)");
        }

        // v2→v3: Compound indexes for common query patterns
        if ($fromVersion < 3) {
            $pdo->exec("CREATE INDEX IF NOT EXISTS idx_responses_status_submitted ON responses(status, submitted_at)");
            $pdo->exec("CREATE INDEX IF NOT EXISTS idx_computed_response_field ON computed(response_id, field_name)");
            $pdo->exec("CREATE INDEX IF NOT EXISTS idx_tags_response_tag ON tags(response_id, tag)");
        }

        // v3→v4: expression index for the "own responses" (per-submitter) scope
        if ($fromVersion < 4) {
            $pdo->exec("CREATE INDEX IF NOT EXISTS idx_responses_submitted_by ON responses(json_extract(metadata, '$.submittedByUserId'))");
        }

        $this->setSchemaVersion($pdo, self::SCHEMA_VERSION);
    }

    /**
     * Close all connections
     */
    public function closeAll(): void
    {
        $this->connections = [];
    }
}

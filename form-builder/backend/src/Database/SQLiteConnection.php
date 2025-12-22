<?php

declare(strict_types=1);

namespace FormLogic\Database;

use PDO;
use PDOException;

class SQLiteConnection
{
    private string $storagePath;
    private array $connections = [];

    public function __construct(string $storagePath)
    {
        $this->storagePath = $storagePath;

        if (!is_dir($storagePath)) {
            mkdir($storagePath, 0755, true);
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

            // Enable foreign keys
            $pdo->exec('PRAGMA foreign_keys = ON');

            if ($isNew) {
                $this->initializeFormSchema($pdo);
            }

            $this->connections[$formId] = $pdo;
            return $pdo;

        } catch (PDOException $e) {
            throw new PDOException('SQLite Connection failed: ' . $e->getMessage());
        }
    }

    /**
     * Get the path to a form's SQLite database
     */
    public function getFormDbPath(string $formId): string
    {
        // Sanitize form ID to prevent directory traversal
        $safeFormId = preg_replace('/[^a-zA-Z0-9\-_]/', '', $formId);
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
     * Delete a form's SQLite database
     */
    public function deleteFormDatabase(string $formId): bool
    {
        $dbPath = $this->getFormDbPath($formId);

        // Close connection if open
        if (isset($this->connections[$formId])) {
            unset($this->connections[$formId]);
        }

        if (file_exists($dbPath)) {
            return unlink($dbPath);
        }

        return true;
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
    }

    /**
     * Close all connections
     */
    public function closeAll(): void
    {
        $this->connections = [];
    }
}

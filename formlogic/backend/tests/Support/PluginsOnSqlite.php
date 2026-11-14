<?php

declare(strict_types=1);

namespace FormLogic\Tests\Support;

use FormLogic\Database\MySQLConnection;

/**
 * The installed plugins PluginService reads (and the users and system_meta rows its installs write),
 * held in SQLite in memory, for tests that run without MySQL. Its queries are SQLite's too.
 */
final class PluginsOnSqlite extends MySQLConnection
{
    private \PDO $pdo;

    public function __construct()
    {
        parent::__construct([]);
        $this->pdo = new \PDO('sqlite::memory:', null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION, \PDO::ATTR_DEFAULT_FETCH_MODE => \PDO::FETCH_ASSOC]);
        $this->pdo->exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT, name TEXT)');
        $this->pdo->exec('CREATE TABLE system_meta (meta_key TEXT PRIMARY KEY, meta_value TEXT)');
        $this->pdo->exec('CREATE TABLE passes (id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL, revoked_at TEXT)');
        $this->pdo->exec("CREATE TABLE plugins (id TEXT PRIMARY KEY, manifest_id TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'site', source TEXT NOT NULL DEFAULT 'builtin',
            app_id TEXT NOT NULL, name TEXT NOT NULL, version TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, grants TEXT NOT NULL, uses TEXT NOT NULL,
            settings_schema TEXT NOT NULL, settings TEXT NOT NULL, installed_by TEXT, installed_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (manifest_id, scope))");
    }

    public function getConnection(): \PDO
    {
        return $this->pdo;
    }

    /** A plugin as an install records it: its project is the app $appId's, whose manifest the test's NativeAppService gives. */
    public function plugin(string $manifestId, string $appId, bool $enabled = true, string $installedAt = '2026-11-01 00:00:00', array $settings = []): void
    {
        $this->pdo->prepare("INSERT INTO plugins (id, manifest_id, scope, source, app_id, name, version, enabled, grants, uses, settings_schema, settings, installed_by, installed_at, updated_at)
            VALUES (?, ?, 'site', 'builtin', ?, ?, '1.0.0', ?, '[]', '[]', '[]', ?, 'admin', ?, ?)")
            ->execute([bin2hex(random_bytes(16)), $manifestId, $appId, 'Plugin ' . $manifestId, $enabled ? 1 : 0, json_encode((object) $settings), $installedAt, $installedAt]);
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Tests\Support;

use FormLogic\Database\MySQLConnection;

/**
 * The users and linked computers SiteAiDesktopSettings reads, held in SQLite in memory, for tests
 * that run without MySQL. Its few queries are SQLite's too, but for "heard from in the last 90
 * seconds", which is said here in SQLite's words.
 */
final class LinkedComputers extends MySQLConnection
{
    private \PDO $pdo;

    public function __construct()
    {
        parent::__construct([]);
        $this->pdo = new class ('sqlite::memory:') extends \PDO {
            public function prepare(string $query, array $options = []): \PDOStatement|false
            {
                return parent::prepare(str_replace('(NOW() - INTERVAL 90 SECOND)', "datetime('now', '-90 seconds')", $query), $options);
            }
        };
        $this->pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $this->pdo->setAttribute(\PDO::ATTR_DEFAULT_FETCH_MODE, \PDO::FETCH_ASSOC);
        $this->pdo->exec('CREATE TABLE users (id TEXT PRIMARY KEY, is_admin INTEGER NOT NULL DEFAULT 0)');
        $this->pdo->exec('CREATE TABLE desktop_connections (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, desktop_instance_id TEXT NOT NULL, device_name TEXT, e2e_public_key TEXT, last_seen_at TEXT, ai_polled_at TEXT)');
    }

    public function getConnection(): \PDO
    {
        return $this->pdo;
    }

    public function user(string $id, bool $admin = false): string
    {
        $this->pdo->prepare('INSERT INTO users (id, is_admin) VALUES (?, ?)')->execute([$id, $admin ? 1 : 0]);
        return $id;
    }

    /**
     * Link a computer to $owner with $publicKey (base64), heard from (its heartbeat and its AI lane) just now or ten
     * minutes ago. Answers its connection id.
     */
    public function link(string $owner, string $instance, string $publicKey, bool $online = true): string
    {
        $id = bin2hex(random_bytes(16));
        $at = gmdate('Y-m-d H:i:s', $online ? time() : time() - 600);
        $this->pdo->prepare('INSERT INTO desktop_connections (id, owner_user_id, desktop_instance_id, device_name, e2e_public_key, last_seen_at, ai_polled_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            ->execute([$id, $owner, $instance, 'Test PC', $publicKey, $at, $at]);
        return $id;
    }

    public function goOffline(string $connectionId): void
    {
        $at = gmdate('Y-m-d H:i:s', time() - 600);
        $this->pdo->prepare('UPDATE desktop_connections SET last_seen_at = ?, ai_polled_at = ? WHERE id = ?')->execute([$at, $at, $connectionId]);
    }

    /** Still linked (its heartbeat is fresh) but its AI lane unasked for ten minutes: OAIY closed there, or too old for the lane. */
    public function laneQuiet(string $connectionId): void
    {
        $this->pdo->prepare('UPDATE desktop_connections SET last_seen_at = ?, ai_polled_at = ? WHERE id = ?')->execute([gmdate('Y-m-d H:i:s'), gmdate('Y-m-d H:i:s', time() - 600), $connectionId]);
    }
}

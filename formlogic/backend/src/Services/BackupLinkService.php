<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;

/**
 * Setting up the FormLogic Backups plugin from the website, through a computer's existing link.
 *
 * A plugin has no share of OAIY's link, and OAIY's key stays with OAIY. But the link can carry a
 * message the other way: the owner, signed in here, sends the plugin a one-time code through the
 * command relay, the plugin asks the person at that computer, and swaps the code for a backup-only
 * key of its own (ApiKeyService::createBackupClient), as the OAuth sign-in would give it. So nobody
 * types an address or signs in a second time, and the link's key is never involved.
 *
 * The code lives ten minutes and works once. Only its hash is kept here, though the raw code sits
 * in the queued command until that is swept: it is the same database, and useless once spent.
 *
 * `used_at` says a code has been swapped and nothing else. A code that has ended without being
 * swapped has run out, or has had its time cut short by a password reset. A swap that went wrong
 * says why in `failure`.
 */
final class BackupLinkService
{
    public const CODE_SECONDS = 600;
    public const NO_ROOM = 'This account has as many API keys as it can hold. Revoke one, then start again from FormLogic.';

    public function __construct(
        private MySQLConnection $mysql,
        private DesktopCommandService $commands,
        private ApiKeyService $apiKeys,
    ) {
    }

    /**
     * Sends a new code to one of the owner's online computers. A code sent earlier stays good: a
     * window may still be open on it, and a second computer may be being set up beside the first.
     *
     * @return array{id: string, deviceName: string}
     * @throws \RuntimeException `backup_link_offline` for a computer that isn't theirs or isn't online,
     *                           `backup_link_not_ready` for one that has only just been linked,
     *                           `backup_link_no_room` for an account with no room for another key
     */
    public function start(string $userId, string $connectionId, string $server): array
    {
        $pdo = $this->mysql->getConnection();
        $fresh = DesktopCommandService::DESKTOP_FRESH_SECONDS;
        $stmt = $pdo->prepare(
            "SELECT device_name, desktop_instance_id FROM desktop_connections
             WHERE id = ? AND owner_user_id = ? AND last_seen_at > (NOW() - INTERVAL {$fresh} SECOND)"
        );
        $stmt->execute([$connectionId, $userId]);
        $connection = $stmt->fetch(\PDO::FETCH_ASSOC);
        if (!is_array($connection)) {
            throw new \RuntimeException('backup_link_offline');
        }
        // Until its first heartbeat a connection has a placeholder for an instance id, and a
        // command aimed at that would reach nobody.
        if (str_starts_with((string) $connection['desktop_instance_id'], 'oauth-')) {
            throw new \RuntimeException('backup_link_not_ready');
        }
        if (!$this->apiKeys->hasRoom($userId)) {
            throw new \RuntimeException('backup_link_no_room');
        }

        $id = bin2hex(random_bytes(16));
        $code = bin2hex(random_bytes(32));
        $now = gmdate('Y-m-d H:i:s');
        $pdo->prepare('DELETE FROM backup_link_codes WHERE owner_user_id = ? AND expires_at < ?')->execute([$userId, gmdate('Y-m-d H:i:s', time() - 86400)]);
        $pdo->prepare(
            'INSERT INTO backup_link_codes (id, owner_user_id, code_hash, device_name, expires_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?)'
        )->execute([$id, $userId, hash('sha256', $code), mb_substr((string) $connection['device_name'], 0, 100), gmdate('Y-m-d H:i:s', time() + self::CODE_SECONDS), $now]);

        $email = $pdo->prepare('SELECT email FROM users WHERE id = ?');
        $email->execute([$userId]);
        // The window on that computer names the account, and the plugin holds the swap to it: a
        // flow on the computer can send a code of someone else's under any name it likes.
        $queued = $this->commands->enqueueBackupLink($userId, (string) $connection['desktop_instance_id'], [
            'server' => $server,
            'code' => $code,
            'account' => (string) $email->fetchColumn(),
        ]);
        $pdo->prepare('UPDATE backup_link_codes SET command_id = ? WHERE id = ?')->execute([$queued['command']['commandId'], $id]);
        return ['id' => $id, 'deviceName' => (string) $connection['device_name']];
    }

    /**
     * How a code is getting on, for the page that sent it. `waiting` covers the person looking at
     * the window on that computer: the plugin answers the relay at once, and only the code coming
     * back says they agreed.
     *
     * @return array{state: string, message: ?string, nodeId: ?string}|null
     */
    public function status(string $userId, string $id): ?array
    {
        $pdo = $this->mysql->getConnection();
        $stmt = $pdo->prepare('SELECT * FROM backup_link_codes WHERE id = ? AND owner_user_id = ?');
        $stmt->execute([$id, $userId]);
        $row = $stmt->fetch(\PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            return null;
        }
        if ($row['backup_client_id'] !== null) {
            $node = $pdo->prepare('SELECT id FROM data_nodes WHERE backup_client_id = ? AND owner_user_id = ?');
            $node->execute([$row['backup_client_id'], $userId]);
            $nodeId = $node->fetchColumn();
            return ['state' => 'linked', 'message' => null, 'nodeId' => is_string($nodeId) ? $nodeId : null];
        }
        if ($row['failure'] !== null) {
            return ['state' => 'failed', 'message' => (string) $row['failure'], 'nodeId' => null];
        }
        if ((string) $row['expires_at'] <= gmdate('Y-m-d H:i:s')) {
            return ['state' => 'expired', 'message' => 'That request has ended. Try again.', 'nodeId' => null];
        }
        // Spent with nothing to show for it yet: the key is being made this moment.
        if ($row['used_at'] !== null) {
            return ['state' => 'waiting', 'message' => null, 'nodeId' => null];
        }
        // A computer that has gone can't poll, and polling is what marks a command as out of time.
        $this->commands->expireStale($userId);
        $command = $row['command_id'] !== null ? $this->commands->get((string) $row['command_id'], $userId) : null;
        $refused = $this->refusalOf($command);
        return $refused !== null
            ? ['state' => 'failed', 'message' => $refused, 'nodeId' => null]
            : ['state' => 'waiting', 'message' => null, 'nodeId' => null];
    }

    /** What the computer said if it said no, in its own words. @param array<string,mixed>|null $command */
    private function refusalOf(?array $command): ?string
    {
        if ($command === null) {
            return null;
        }
        if (($command['status'] ?? null) === 'expired') {
            return 'That computer did not answer. Check that OAIY is running there.';
        }
        // A refusal by OAIY comes back as a failed command, and one by the plugin as a finished
        // command whose answer says no.
        $said = ($command['status'] ?? null) === 'failed' ? ($command['error'] ?? null) : ($command['result']['error'] ?? null);
        if ($said === null) {
            return ($command['status'] ?? null) === 'failed' ? 'That computer could not do it.' : null;
        }
        return is_array($said) && is_string($said['message'] ?? null) ? mb_substr($said['message'], 0, 300) : 'That computer could not do it.';
    }

    /**
     * Swaps a code for a backup-only key, once.
     *
     * @return array{id: string, apiKeyId: string, key: string, accountEmail: string, accountId: string}
     * @throws \RuntimeException `backup_link_invalid` for a code that is wrong, spent or out of time,
     *                           `backup_link_no_room` for an account that has since run out of room
     */
    public function redeem(string $code): array
    {
        $pdo = $this->mysql->getConnection();
        $hash = hash('sha256', $code);
        $now = gmdate('Y-m-d H:i:s');
        $spent = $pdo->prepare('UPDATE backup_link_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?');
        $spent->execute([$now, $hash, $now]);
        if ($spent->rowCount() !== 1) {
            throw new \RuntimeException('backup_link_invalid');
        }
        $stmt = $pdo->prepare('SELECT id, owner_user_id, device_name FROM backup_link_codes WHERE code_hash = ?');
        $stmt->execute([$hash]);
        $row = $stmt->fetch(\PDO::FETCH_ASSOC);
        try {
            $client = $this->apiKeys->createBackupClient((string) $row['owner_user_id'], $row['device_name']);
        } catch (\Throwable $e) {
            $full = str_starts_with($e->getMessage(), 'Maximum number of API keys');
            $pdo->prepare('UPDATE backup_link_codes SET failure = ? WHERE id = ?')->execute([$full ? self::NO_ROOM : 'FormLogic could not finish that. Try again.', $row['id']]);
            throw $full ? new \RuntimeException('backup_link_no_room', 0, $e) : $e;
        }
        $pdo->prepare('UPDATE backup_link_codes SET backup_client_id = ? WHERE id = ?')->execute([$client['id'], $row['id']]);
        return $client + ['accountId' => (string) $row['owner_user_id']];
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;

/**
 * Linking an always-on OAIY server with a one-time code (App AI contract §2), for a computer that
 * cannot do the browser link: that approval redirects to 127.0.0.1 on the same machine, and a server
 * has no browser there.
 *
 * 1. A signed-in person chooses **Connect an OAIY server** and gets a code: twelve characters from an
 *    alphabet without look-alikes (about 59 bits), shown once, good for ten minutes and one use. Only
 *    its keyed hash is kept.
 * 2. On the server: `oaiy-server link --code <code> --base-url <this site> [--name <device>]`.
 * 3. OAIY redeems it at POST /api/oauth/oaiy-link, which answers exactly what the browser link's
 *    token exchange answers (DesktopLinkIssuer), so OAIY writes the same link/account.json; from
 *    then on it is an ordinary linked computer.
 *
 * What it may do is chosen when the code is made: **AI only** (`connector:relay`, which carries the
 * AI lane and the computer's check-ins) by default, or everything a linked desktop can do
 * (McpOAuthService::DESKTOP_SCOPES). An unknown, expired or spent code answers as one.
 */
final class DesktopLinkCodeService
{
    public const CODE_SECONDS = 600;
    /** Codes an account may have waiting at once. */
    public const MAX_OPEN = 3;
    public const SCOPES = ['ai' => ['connector:relay'], 'all' => McpOAuthService::DESKTOP_SCOPES];
    /** What the key and the connection are named for: "OAIY server on <device>". */
    public const RUNTIME = 'OAIY server';
    public const NO_ROOM = 'This account has as many API keys as it can hold. Revoke one, then start again from FormLogic.';
    private const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    private const LENGTH = 12;

    /** @param string $secret the server's key for the codes' hashes (derived from JWT_SECRET by the container) */
    public function __construct(
        private MySQLConnection $mysql,
        private DesktopLinkIssuer $issuer,
        private ApiKeyService $apiKeys,
        private string $secret,
    ) {
        if (strlen($this->secret) < 16) throw new \InvalidArgumentException('The link codes need a server secret');
    }

    /**
     * A new code for $userId's server. Answers {id, code (XXXX-XXXX-XXXX, shown this once), expiresAt, scope}.
     *
     * @throws \InvalidArgumentException for a scope or device name that is not one
     * @throws \RuntimeException `desktop_link_no_room` (no room for another key), `desktop_link_too_many` (MAX_OPEN waiting)
     */
    public function start(string $userId, string $scope = 'ai', ?string $deviceName = null): array
    {
        if (!isset(self::SCOPES[$scope])) throw new \InvalidArgumentException('Choose what the server may do: ai or all.');
        $device = self::deviceName($deviceName);
        if (!$this->apiKeys->hasRoom($userId)) throw new \RuntimeException('desktop_link_no_room');
        $pdo = $this->mysql->getConnection();
        $now = gmdate('Y-m-d H:i:s');
        $pdo->prepare('DELETE FROM desktop_link_codes WHERE user_id = ? AND expires_at < ?')->execute([$userId, gmdate('Y-m-d H:i:s', time() - 86400)]);
        $open = $pdo->prepare('SELECT COUNT(*) FROM desktop_link_codes WHERE user_id = ? AND redeemed_at IS NULL AND expires_at > ?');
        $open->execute([$userId, $now]);
        if ((int) $open->fetchColumn() >= self::MAX_OPEN) throw new \RuntimeException('desktop_link_too_many');
        $code = '';
        for ($i = 0; $i < self::LENGTH; $i++) $code .= self::ALPHABET[random_int(0, strlen(self::ALPHABET) - 1)];
        $id = bin2hex(random_bytes(16));
        $expires = gmdate('Y-m-d H:i:s', time() + self::CODE_SECONDS);
        $pdo->prepare('INSERT INTO desktop_link_codes (id, user_id, code_hash, scope, device_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            ->execute([$id, $userId, $this->hash($code), $scope, $device, $now, $expires]);
        return ['id' => $id, 'code' => implode('-', str_split($code, 4)), 'expiresAt' => gmdate('Y-m-d\TH:i:s\Z', strtotime($expires . ' UTC')), 'scope' => $scope];
    }

    /**
     * How a code is getting on, for the page that made it: waiting, linked (with the connection),
     * expired, or failed (with why). Null for a code that is not $userId's.
     */
    public function status(string $userId, string $id): ?array
    {
        $statement = $this->mysql->getConnection()->prepare('SELECT * FROM desktop_link_codes WHERE id = ? AND user_id = ?');
        $statement->execute([$id, $userId]);
        $row = $statement->fetch(\PDO::FETCH_ASSOC);
        if (!is_array($row)) return null;
        $base = ['id' => $row['id'], 'scope' => $row['scope'], 'expiresAt' => gmdate('Y-m-d\TH:i:s\Z', strtotime($row['expires_at'] . ' UTC'))];
        if ($row['connection_id'] !== null) {
            $connection = $this->mysql->getConnection()->prepare('SELECT id, device_name FROM desktop_connections WHERE id = ? AND owner_user_id = ?');
            $connection->execute([$row['connection_id'], $userId]);
            $linked = $connection->fetch(\PDO::FETCH_ASSOC);
            // Linked once, and unlinked since: the code's computer is gone from the account.
            if (!is_array($linked)) return $base + ['status' => 'unlinked', 'connectionId' => $row['connection_id'], 'message' => 'This server was linked with this code and has been unlinked since. Make a new code to link it again.'];
            return $base + ['status' => 'linked', 'connectionId' => $row['connection_id'], 'deviceName' => (string) $linked['device_name']];
        }
        if ($row['failure'] !== null) return $base + ['status' => 'failed', 'message' => (string) $row['failure']];
        // Spent, and the key being made this moment.
        if ($row['redeemed_at'] !== null) return $base + ['status' => 'waiting'];
        if ((string) $row['expires_at'] <= gmdate('Y-m-d H:i:s')) return $base + ['status' => 'expired', 'message' => 'That code has run out. Make a new one.'];
        return $base + ['status' => 'waiting'];
    }

    /**
     * Swap a code for the computer's key and connection, once. $deviceName is what the server calls
     * itself (`--name`), else the name given when the code was made.
     *
     * @return array{key: array, connection: array, scopes: list<string>, userId: string, codeId: string}
     * @throws \RuntimeException `desktop_link_invalid` for a code that is unknown, spent or out of time
     *                           (all alike), `desktop_link_no_room` for an account with no room for a key
     */
    public function redeem(string $code, ?string $deviceName = null): array
    {
        $normalised = strtoupper((string) preg_replace('/[^A-Za-z0-9]/', '', $code));
        if (strlen($normalised) !== self::LENGTH || strspn($normalised, self::ALPHABET) !== self::LENGTH) throw new \RuntimeException('desktop_link_invalid');
        try { $device = self::deviceName($deviceName); } catch (\InvalidArgumentException) { $device = null; }
        $pdo = $this->mysql->getConnection();
        $hash = $this->hash($normalised);
        $now = gmdate('Y-m-d H:i:s');
        // One use: whoever changes the row first has it; a second redeem, at once or later, finds it spent.
        $spend = $pdo->prepare('UPDATE desktop_link_codes SET redeemed_at = ? WHERE code_hash = ? AND redeemed_at IS NULL AND expires_at > ?');
        $spend->execute([$now, $hash, $now]);
        if ($spend->rowCount() !== 1) throw new \RuntimeException('desktop_link_invalid');
        $statement = $pdo->prepare('SELECT * FROM desktop_link_codes WHERE code_hash = ?');
        $statement->execute([$hash]);
        $row = $statement->fetch(\PDO::FETCH_ASSOC);
        $scopes = self::SCOPES[$row['scope']] ?? self::SCOPES['ai'];
        try {
            $issued = $this->issuer->issue((string) $row['user_id'], $device ?? $row['device_name'], $scopes, self::RUNTIME, null, $row['scope'] !== 'all');
        } catch (\Throwable $e) {
            $full = str_starts_with($e->getMessage(), 'Maximum number of API keys');
            $pdo->prepare('UPDATE desktop_link_codes SET failure = ? WHERE id = ?')->execute([$full ? self::NO_ROOM : 'FormLogic could not finish linking that server. Make a new code and try again.', $row['id']]);
            throw $full ? new \RuntimeException('desktop_link_no_room', 0, $e) : $e;
        }
        $pdo->prepare('UPDATE desktop_link_codes SET connection_id = ? WHERE id = ?')->execute([$issued['connection']['id'], $row['id']]);
        return $issued + ['scopes' => $scopes, 'userId' => (string) $row['user_id'], 'codeId' => (string) $row['id']];
    }

    /** A device's name as a person or `--name` gives it: up to 100 characters of text, or null. */
    private static function deviceName(?string $name): ?string
    {
        if ($name === null) return null;
        $name = trim((string) preg_replace('/\s+/u', ' ', $name));
        if ($name === '') return null;
        if (mb_strlen($name) > 100 || preg_match('/[\x00-\x1f\x7f]/u', $name)) throw new \InvalidArgumentException('Give the server a name of up to 100 characters.');
        return $name;
    }

    private function hash(string $normalised): string
    {
        return hash_hmac('sha256', 'desktop-link-v1|' . $normalised, $this->secret);
    }
}

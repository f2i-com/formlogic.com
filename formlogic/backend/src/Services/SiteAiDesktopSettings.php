<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use PDO;

/**
 * Which of the administrator's linked OAIY computers serves the site's AI (SiteDesktopAi), with
 * the key it is pinned to. Kept in storage/site-ai-desktop.json beside platform-plans.json; the
 * key is the one the computer had published when it was chosen, so a computer whose key changes
 * stops being answered until it is chosen again, rather than being trusted with a new one.
 */
final class SiteAiDesktopSettings
{
    private PDO $pdo;

    public function __construct(MySQLConnection $mysql, private ?string $path = null)
    {
        $this->pdo = $mysql->getConnection();
        $this->path ??= dirname(__DIR__, 2) . '/storage/site-ai-desktop.json';
    }

    /** {ownerUserId, connectionId, instanceId, publicKey, providerId, model, deviceName, chosenAt}, or null. */
    public function current(): ?array
    {
        $raw = @file_get_contents($this->path);
        if ($raw === false) {
            return null;
        }
        $data = json_decode($raw, true);
        if (!is_array($data)) {
            return null;
        }
        foreach (['ownerUserId', 'connectionId', 'instanceId', 'publicKey', 'providerId'] as $key) {
            if (!is_string($data[$key] ?? null) || $data[$key] === '') {
                return null;
            }
        }
        $data['model'] = is_string($data['model'] ?? null) && $data['model'] !== '' && $data['providerId'] !== SiteDesktopAi::PROVIDER ? $data['model'] : null;
        return $this->ownerIsAdmin($data['ownerUserId']) ? $data : null;
    }

    /**
     * Whether the account a computer was chosen under is an administrator still. One whose rights
     * were taken away no longer serves the site, and its computer is no longer sent members' chats
     * or camera pictures: the choice reads as unmade until an administrator makes it again. Asked
     * at every read, so it holds however the rights went.
     */
    public function ownerIsAdmin(string $userId): bool
    {
        $stmt = $this->pdo->prepare('SELECT 1 FROM users WHERE id = ? AND is_admin = 1');
        $stmt->execute([$userId]);
        return $stmt->fetchColumn() !== false;
    }

    /** Whether the chosen computer has checked in within the last 90 seconds, as a desktop counts as fresh. */
    public function online(array $site): bool
    {
        $stmt = $this->pdo->prepare(
            'SELECT 1 FROM desktop_connections WHERE id = ? AND owner_user_id = ? AND last_seen_at > (NOW() - INTERVAL 90 SECOND)'
        );
        $stmt->execute([$site['connectionId'], $site['ownerUserId']]);
        return $stmt->fetchColumn() !== false;
    }

    /** A short, readable fingerprint of a public key, to tell two computers' keys apart. */
    public static function fingerprint(string $publicKey): string
    {
        $hex = substr(hash('sha256', (string) base64_decode($publicKey, true)), 0, 20);
        return implode(' ', str_split(strtoupper($hex), 4));
    }

    /**
     * The administrator's linked computers that could serve: each with a published chat key, and
     * whether it has been heard from in the last 90 seconds.
     */
    public function candidates(string $adminUserId): array
    {
        $stmt = $this->pdo->prepare(
            "SELECT id, desktop_instance_id, device_name, e2e_public_key, last_seen_at,
                    last_seen_at > (NOW() - INTERVAL 90 SECOND) AS fresh
             FROM desktop_connections WHERE owner_user_id = ? AND e2e_public_key IS NOT NULL ORDER BY last_seen_at DESC"
        );
        $stmt->execute([$adminUserId]);
        return array_map(static fn(array $row) => [
            'connectionId' => (string) $row['id'],
            'instanceId' => (string) $row['desktop_instance_id'],
            'deviceName' => (string) ($row['device_name'] ?? ''),
            'fingerprint' => self::fingerprint((string) $row['e2e_public_key']),
            'online' => (bool) $row['fresh'],
            'lastSeenAt' => $row['last_seen_at'],
        ], $stmt->fetchAll(PDO::FETCH_ASSOC));
    }

    /**
     * Pin one of the administrator's computers, with the key it has published now, and the
     * provider on it that answers: OAIY's own engine (the model chosen in OAIY), or a provider
     * stored in OAIY with $model, which every turn then names.
     */
    public function choose(string $adminUserId, string $connectionId, string $providerId = SiteDesktopAi::PROVIDER, ?string $model = null): array
    {
        $chosen = ['providerId' => self::provider($providerId), 'model' => self::model($providerId, $model)] + $this->pin($adminUserId, $connectionId);
        $this->write($chosen);
        return $chosen;
    }

    /** A computer as a target for its listings: `providers` (every provider on it) or one provider's `models`. */
    public function listingTarget(string $adminUserId, string $connectionId, ?string $providerId): array
    {
        return ['providerId' => $providerId === null ? 'all' : self::provider($providerId)] + $this->pin($adminUserId, $connectionId);
    }

    /** A provider id as OAIY lists them; never `all`, which names no provider. */
    public static function provider(string $providerId): string
    {
        if ($providerId === '' || strlen($providerId) > 128 || !preg_match('/^[A-Za-z0-9._:-]+$/D', $providerId) || $providerId === 'all') {
            throw new \InvalidArgumentException('Choose a provider on that computer.');
        }
        return $providerId;
    }

    /** The model a stored provider is asked for; none for OAIY's own engine, which uses the one chosen in OAIY. */
    public static function model(string $providerId, ?string $model): ?string
    {
        if ($providerId === SiteDesktopAi::PROVIDER) {
            return null;
        }
        if (!is_string($model) || $model === '' || strlen($model) > 256 || preg_match('/[\x00-\x1f\x7f]/', $model)) {
            throw new \InvalidArgumentException('Choose the model on that provider.');
        }
        return $model;
    }

    /**
     * One of the administrator's linked computers as a target to seal to, with the key it has
     * published now: {ownerUserId, connectionId, instanceId, publicKey, providerId, deviceName,
     * chosenAt}. Saved nowhere; the camera check keeps its own (CameraCheckSettings).
     */
    public function pin(string $adminUserId, string $connectionId): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT id, desktop_instance_id, device_name, e2e_public_key FROM desktop_connections WHERE id = ? AND owner_user_id = ?'
        );
        $stmt->execute([$connectionId, $adminUserId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            throw new \InvalidArgumentException('That computer is not linked to your account.');
        }
        $key = (string) ($row['e2e_public_key'] ?? '');
        $raw = base64_decode($key, true);
        if ($raw === false || strlen($raw) !== SODIUM_CRYPTO_BOX_PUBLICKEYBYTES) {
            throw new \InvalidArgumentException('That computer has not published its chat key yet. Open OAIY on it and try again.');
        }
        if (str_starts_with((string) $row['desktop_instance_id'], 'oauth-')) {
            throw new \InvalidArgumentException('That computer has not checked in yet. Open OAIY on it and try again.');
        }
        return [
            'ownerUserId' => $adminUserId,
            'connectionId' => (string) $row['id'],
            'instanceId' => (string) $row['desktop_instance_id'],
            'publicKey' => $key,
            'providerId' => SiteDesktopAi::PROVIDER,
            'deviceName' => (string) ($row['device_name'] ?? ''),
            'chosenAt' => gmdate('c'),
        ];
    }

    public function clear(): void
    {
        if (is_file($this->path) && !@unlink($this->path)) {
            throw new \RuntimeException('Cannot turn the site\'s OAIY off: storage/site-ai-desktop.json could not be removed.');
        }
    }

    private function write(array $data): void
    {
        $dir = dirname($this->path);
        if (!is_dir($dir) && !@mkdir($dir, 0750, true) && !is_dir($dir)) {
            throw new \RuntimeException('Settings storage is unavailable.');
        }
        $tmp = tempnam($dir, '.site-ai-');
        if ($tmp === false) {
            throw new \RuntimeException('Cannot save the site\'s AI settings.');
        }
        try {
            if (file_put_contents($tmp, json_encode($data, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR), LOCK_EX) === false || !rename($tmp, $this->path)) {
                throw new \RuntimeException('Cannot save the site\'s AI settings.');
            }
        } finally {
            if (is_file($tmp)) {
                @unlink($tmp);
            }
        }
    }
}

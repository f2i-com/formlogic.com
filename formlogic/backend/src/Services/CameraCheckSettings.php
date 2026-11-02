<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * Which AI reads the pictures of a plugin's camera check (CameraCheckService): one of the
 * administrator's linked OAIY computers, pinned to the key it had published when chosen, and the
 * provider on it: OAIY's own engine, whose model is the one chosen in OAIY, or a provider stored in
 * OAIY with a model picked here. Nothing about what a plugin checks: that is the plugin's.
 * Kept in storage/camera-check.json beside site-ai-desktop.json.
 */
final class CameraCheckSettings
{
    public function __construct(private SiteAiDesktopSettings $computers, private ?string $path = null)
    {
        $this->path ??= dirname(__DIR__, 2) . '/storage/camera-check.json';
    }

    /** The saved choice, or null when camera checks are not set up. */
    public function current(): ?array
    {
        $raw = @file_get_contents($this->path);
        $data = $raw === false ? null : json_decode($raw, true);
        if (!is_array($data)) {
            return null;
        }
        foreach (['ownerUserId', 'connectionId', 'instanceId', 'publicKey', 'providerId'] as $key) {
            if (!is_string($data[$key] ?? null) || $data[$key] === '') {
                return null;
            }
        }
        $data['model'] = is_string($data['model'] ?? null) && $data['model'] !== '' ? $data['model'] : null;
        return $data;
    }

    public function online(array $target): bool
    {
        return $this->computers->online($target);
    }

    public function candidates(string $adminUserId): array
    {
        return $this->computers->candidates($adminUserId);
    }

    /** A computer as a target for its listings: `providers` (every provider on it) or one provider's `models`. */
    public function listingTarget(string $adminUserId, string $connectionId, ?string $providerId): array
    {
        if ($providerId !== null) {
            self::assertProvider($providerId);
        }
        return ['providerId' => $providerId ?? 'all'] + $this->computers->pin($adminUserId, $connectionId);
    }

    /**
     * Save the choice. $model is required for a provider stored in OAIY and ignored for OAIY's own
     * engine, which always answers with the model chosen in OAIY.
     */
    public function choose(string $adminUserId, string $connectionId, string $providerId, ?string $model): array
    {
        self::assertProvider($providerId);
        $target = ['providerId' => $providerId] + $this->computers->pin($adminUserId, $connectionId);
        if ($providerId === SiteDesktopAi::PROVIDER) {
            $model = null;
        } elseif (!is_string($model) || $model === '' || strlen($model) > 256 || preg_match('/[\x00-\x1f\x7f]/', $model)) {
            throw new \InvalidArgumentException('Choose the model that reads the pictures.');
        }
        $chosen = $target + ['model' => $model];
        $this->write($chosen);
        return $chosen;
    }

    public function clear(): void
    {
        if (is_file($this->path) && !@unlink($this->path)) {
            throw new \RuntimeException('Cannot turn camera checks off: storage/camera-check.json could not be removed.');
        }
    }

    private static function assertProvider(string $providerId): void
    {
        if ($providerId === '' || strlen($providerId) > 128 || !preg_match('/^[A-Za-z0-9._:-]+$/D', $providerId) || $providerId === 'all') {
            throw new \InvalidArgumentException('Choose a provider on that computer.');
        }
    }

    private function write(array $data): void
    {
        $dir = dirname($this->path);
        if (!is_dir($dir) && !@mkdir($dir, 0750, true) && !is_dir($dir)) {
            throw new \RuntimeException('Settings storage is unavailable.');
        }
        $tmp = tempnam($dir, '.camera-check-');
        if ($tmp === false) {
            throw new \RuntimeException('Cannot save the camera check settings.');
        }
        try {
            if (file_put_contents($tmp, json_encode($data, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR), LOCK_EX) === false || !rename($tmp, $this->path)) {
                throw new \RuntimeException('Cannot save the camera check settings.');
            }
        } finally {
            if (is_file($tmp)) {
                @unlink($tmp);
            }
        }
    }
}

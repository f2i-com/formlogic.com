<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * Maintenance mode — deliberately FILE-based (storage/maintenance.json), not a
 * DB row: the flag must stay readable while the database is being migrated or
 * restored mid-upgrade, and the pre-auth /api/health closure (which the SPA and
 * embedded forms consult) must not gain a MySQL dependency. The admin panel
 * toggles it; MaintenanceMiddleware enforces it; the upgrade flow turns it on
 * automatically around an apply.
 */
class MaintenanceService
{
    public const DEFAULT_MESSAGE = 'We are briefly down for maintenance. Please check back in a few minutes.';
    private const MAX_MESSAGE_LENGTH = 500;

    public function __construct(private string $flagPath)
    {
    }

    public static function defaultPath(): string
    {
        return dirname(__DIR__, 2) . '/storage/maintenance.json';
    }

    /** @return array{enabled: bool, message: string, updatedAt: ?string, updatedBy: ?string} */
    public function status(): array
    {
        $raw = @file_get_contents($this->flagPath);
        if ($raw === false) {
            return ['enabled' => false, 'message' => self::DEFAULT_MESSAGE, 'updatedAt' => null, 'updatedBy' => null];
        }
        $data = json_decode($raw, true);
        if (!is_array($data)) {
            return ['enabled' => false, 'message' => self::DEFAULT_MESSAGE, 'updatedAt' => null, 'updatedBy' => null];
        }
        $message = trim((string) ($data['message'] ?? ''));
        return [
            'enabled' => (bool) ($data['enabled'] ?? false),
            'message' => $message !== '' ? $message : self::DEFAULT_MESSAGE,
            'updatedAt' => is_string($data['updatedAt'] ?? null) ? $data['updatedAt'] : null,
            'updatedBy' => is_string($data['updatedBy'] ?? null) ? $data['updatedBy'] : null,
        ];
    }

    public function enabled(): bool
    {
        return $this->status()['enabled'];
    }

    /** Turn maintenance on with a visitor-facing message (admin-customizable). */
    public function enable(string $message = '', ?string $byUserId = null): array
    {
        return $this->write(true, $message, $byUserId);
    }

    public function disable(?string $byUserId = null): array
    {
        // Keep the last message so re-enabling offers it back as the default.
        return $this->write(false, $this->status()['message'], $byUserId);
    }

    private function write(bool $enabled, string $message, ?string $byUserId): array
    {
        $message = mb_substr(trim($message), 0, self::MAX_MESSAGE_LENGTH);
        if ($message === '') {
            $message = self::DEFAULT_MESSAGE;
        }
        $data = [
            'enabled' => $enabled,
            'message' => $message,
            'updatedAt' => gmdate('c'),
            'updatedBy' => $byUserId,
        ];
        $dir = dirname($this->flagPath);
        if (!is_dir($dir)) {
            @mkdir($dir, 0750, true);
        }
        // Atomic-ish replace so a concurrent reader never sees a half-written flag.
        $tmp = $this->flagPath . '.tmp';
        if (@file_put_contents($tmp, json_encode($data, JSON_PRETTY_PRINT)) === false) {
            throw new \RuntimeException('Cannot write the maintenance flag file (storage not writable?)');
        }
        if (!@rename($tmp, $this->flagPath)) {
            @unlink($tmp);
            throw new \RuntimeException('Cannot replace the maintenance flag file');
        }
        return $this->status();
    }
}

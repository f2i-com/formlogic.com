<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;

/**
 * Hosted-cloud plan limits (form count + account storage) and cloud-access status.
 *
 * Enforcement is OFF unless config['planEnforced'] is true (hosted SaaS). Self-hosted
 * installs leave it off and have no limits whatsoever. Users on the 'enterprise' plan
 * (users.plan) are always treated as unlimited and active.
 */
class PlanService
{
    private bool $enforced;
    private int $maxForms;
    private int $maxStorageBytes;
    /** @var array<string, array<string,mixed>|null> per-request memo of user rows */
    private array $userCache = [];

    public function __construct(
        private MySQLConnection $mysql,
        private FileStorageService $fileStorage,
        array $config
    ) {
        $this->enforced = (bool) ($config['planEnforced'] ?? false);
        $this->maxForms = (int) ($config['maxForms'] ?? 100);
        $this->maxStorageBytes = (int) ($config['maxStorageBytes'] ?? 1024 * 1024 * 1024);
    }

    public function isEnforced(): bool
    {
        return $this->enforced;
    }

    /** True if the user currently has cloud access (always true when enforcement is off). */
    public function isCloudActive(string $userId): bool
    {
        if (!$this->enforced) {
            return true;
        }
        $row = $this->userRow($userId);
        if (!$row) {
            return false;
        }
        if (($row['plan'] ?? 'personal') === 'enterprise') {
            return true;
        }
        return !empty($row['cloud_until']) && strtotime((string) $row['cloud_until']) > time();
    }

    public function planFor(string $userId): string
    {
        $row = $this->userRow($userId);
        $plan = $row['plan'] ?? 'personal';
        return is_string($plan) && $plan !== '' ? $plan : 'personal';
    }

    public function getFormCount(string $userId): int
    {
        $stmt = $this->mysql->getConnection()->prepare('SELECT COUNT(*) FROM forms WHERE user_id = ?');
        $stmt->execute([$userId]);
        return (int) $stmt->fetchColumn();
    }

    public function getStorageBytes(string $userId): int
    {
        $stmt = $this->mysql->getConnection()->prepare('SELECT id FROM forms WHERE user_id = ?');
        $stmt->execute([$userId]);
        $ids = $stmt->fetchAll(\PDO::FETCH_COLUMN) ?: [];
        return $this->fileStorage->bytesForForms(array_map('strval', $ids));
    }

    /** Form-count limit for this user; null = unlimited. */
    public function formLimit(string $userId): ?int
    {
        if (!$this->enforced || $this->planFor($userId) === 'enterprise') {
            return null;
        }
        return $this->maxForms;
    }

    /** Storage limit in bytes for this user; null = unlimited. */
    public function storageLimitBytes(string $userId): ?int
    {
        if (!$this->enforced || $this->planFor($userId) === 'enterprise') {
            return null;
        }
        return $this->maxStorageBytes;
    }

    /** True if the user may create $n more forms within their plan. */
    public function canCreateForms(string $userId, int $n = 1): bool
    {
        $limit = $this->formLimit($userId);
        if ($limit === null) {
            return true;
        }
        return $this->getFormCount($userId) + $n <= $limit;
    }

    /** True if the user may upload $bytes more within their storage quota. */
    public function canUpload(string $userId, int $bytes): bool
    {
        $limit = $this->storageLimitBytes($userId);
        if ($limit === null) {
            return true;
        }
        return $this->getStorageBytes($userId) + max(0, $bytes) <= $limit;
    }

    /** Resolve the owner (user id) of a form — used to gate public submissions/uploads. */
    public function ownerOfForm(string $formId): ?string
    {
        $stmt = $this->mysql->getConnection()->prepare('SELECT user_id FROM forms WHERE id = ?');
        $stmt->execute([$formId]);
        $owner = $stmt->fetchColumn();
        return is_string($owner) && $owner !== '' ? $owner : null;
    }

    /** Usage snapshot for the billing UI. */
    public function usage(string $userId): array
    {
        // Storage usage requires crawling the upload filesystem, and the figure is only
        // meaningful when enforcement is on — so skip the disk walk entirely otherwise
        // (self-hosted billing-page loads no longer stat every uploaded file).
        return [
            'enforced' => $this->enforced,
            'plan' => $this->planFor($userId),
            'forms' => ['used' => $this->getFormCount($userId), 'limit' => $this->formLimit($userId)],
            'storage' => ['usedBytes' => $this->enforced ? $this->getStorageBytes($userId) : null, 'limitBytes' => $this->storageLimitBytes($userId)],
        ];
    }

    /** @return array<string,mixed>|null */
    private function userRow(string $userId): ?array
    {
        if (!array_key_exists($userId, $this->userCache)) {
            $stmt = $this->mysql->getConnection()->prepare('SELECT plan, cloud_until FROM users WHERE id = ?');
            $stmt->execute([$userId]);
            $this->userCache[$userId] = $stmt->fetch(\PDO::FETCH_ASSOC) ?: null;
        }
        return $this->userCache[$userId];
    }
}

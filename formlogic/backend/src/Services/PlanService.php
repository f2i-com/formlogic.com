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

    // ── Plan allowances + usage metering (Site AI / cloud credits) ─────────────

    /**
     * The monthly allowance a plan grants for one metric ('ai_messages',
     * 'cloud_flow_runs'). A missing row means the metric is OFF for that plan.
     *
     * @return array{enabled: bool, monthlyValue: int} monthlyValue -1 = unlimited.
     */
    public function allowance(string $plan, string $metric): array
    {
        $stmt = $this->mysql->getConnection()->prepare(
            'SELECT monthly_value, enabled FROM plan_allowances WHERE plan = ? AND metric = ?'
        );
        $stmt->execute([$plan, $metric]);
        $row = $stmt->fetch(\PDO::FETCH_ASSOC);
        if (!$row) {
            return ['enabled' => false, 'monthlyValue' => 0];
        }
        return ['enabled' => !empty($row['enabled']), 'monthlyValue' => (int) $row['monthly_value']];
    }

    /** @return array<int, array{plan: string, metric: string, monthlyValue: int, enabled: bool}> */
    public function listAllowances(): array
    {
        $rows = $this->mysql->getConnection()
            ->query('SELECT plan, metric, monthly_value, enabled FROM plan_allowances ORDER BY plan, metric')
            ->fetchAll(\PDO::FETCH_ASSOC) ?: [];
        return array_map(static fn (array $r) => [
            'plan' => (string) $r['plan'],
            'metric' => (string) $r['metric'],
            'monthlyValue' => (int) $r['monthly_value'],
            'enabled' => !empty($r['enabled']),
        ], $rows);
    }

    /** Upsert one allowance row (admin surface; audited by the caller). */
    public function setAllowance(string $plan, string $metric, int $monthlyValue, bool $enabled): void
    {
        if (!preg_match('/^[a-z0-9_-]{1,20}$/', $plan)) {
            throw new \InvalidArgumentException('plan must be a lowercase slug (max 20 chars)');
        }
        if (!preg_match('/^[a-z0-9_]{1,32}$/', $metric)) {
            throw new \InvalidArgumentException('metric must be a lowercase slug (max 32 chars)');
        }
        if ($monthlyValue < -1 || $monthlyValue > 10000000) {
            throw new \InvalidArgumentException('monthlyValue must be -1 (unlimited) or 0..10000000');
        }
        $stmt = $this->mysql->getConnection()->prepare(
            'INSERT INTO plan_allowances (plan, metric, monthly_value, enabled)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE monthly_value = VALUES(monthly_value), enabled = VALUES(enabled)'
        );
        $stmt->execute([$plan, $metric, $monthlyValue, $enabled ? 1 : 0]);
    }

    /**
     * Record $amount units of $metric against the current UTC month, refusing first when the
     * user's plan allowance would be exceeded. Usage is ALWAYS recorded (even when plan
     * enforcement is off — self-hosted installs get visibility, never a refusal).
     *
     * Period rollover is implicit: the period key is the UTC YYYY-MM, so a new month starts a
     * fresh row with no reset job.
     *
     * @throws \RuntimeException 'ai_allowance_exceeded' | 'flow_credits_exceeded' when over.
     */
    public function checkAndIncrement(string $userId, string $metric, int $amount = 1, int $tokensIn = 0, int $tokensOut = 0): void
    {
        if ($amount < 0) {
            throw new \InvalidArgumentException('amount must be >= 0');
        }
        $period = gmdate('Y-m');
        if (!$this->enforced) {
            $this->incrementMeter($userId, $metric, $period, $amount, $tokensIn, $tokensOut);
            return;
        }
        // Enterprise is unlimited by product invariant (same as the form/storage limits).
        if ($this->planFor($userId) === 'enterprise') {
            $this->incrementMeter($userId, $metric, $period, $amount, $tokensIn, $tokensOut);
            return;
        }
        $code = self::allowanceErrorCode($metric);
        // A lapsed personal plan has no hosted AI / cloud credits at all (the plan doc's
        // "free = disabled" state — free-vs-paid within 'personal' is cloud activity).
        if (!$this->isCloudActive($userId)) {
            throw new \RuntimeException($code);
        }
        $allowance = $this->allowance($this->planFor($userId), $metric);
        if (!$allowance['enabled']) {
            throw new \RuntimeException($code);
        }
        if ($allowance['monthlyValue'] >= 0) {
            $current = $this->meterCount($userId, $metric, $period);
            if ($current + $amount > $allowance['monthlyValue']) {
                throw new \RuntimeException($code);
            }
        }
        $this->incrementMeter($userId, $metric, $period, $amount, $tokensIn, $tokensOut);
    }

    /** Record usage without any allowance check (post-hoc token metering, explicit-provider calls). */
    public function recordUsage(string $userId, string $metric, int $amount = 0, int $tokensIn = 0, int $tokensOut = 0): void
    {
        if ($amount < 0 || $tokensIn < 0 || $tokensOut < 0) {
            throw new \InvalidArgumentException('usage figures must be >= 0');
        }
        $this->incrementMeter($userId, $metric, gmdate('Y-m'), $amount, $tokensIn, $tokensOut);
    }

    /**
     * The user's meter rows for one period (default: current UTC month), keyed by metric —
     * feeds the settings/billing usage readouts.
     *
     * @return array{period: string, metrics: array<string, array{count: int, tokensIn: int, tokensOut: int}>}
     */
    public function usageMeter(string $userId, ?string $period = null): array
    {
        $period = $period ?? gmdate('Y-m');
        $stmt = $this->mysql->getConnection()->prepare(
            'SELECT metric, `count`, tokens_in, tokens_out FROM usage_meter WHERE user_id = ? AND period = ?'
        );
        $stmt->execute([$userId, $period]);
        $metrics = [];
        foreach ($stmt->fetchAll(\PDO::FETCH_ASSOC) ?: [] as $row) {
            $metrics[(string) $row['metric']] = [
                'count' => (int) $row['count'],
                'tokensIn' => (int) $row['tokens_in'],
                'tokensOut' => (int) $row['tokens_out'],
            ];
        }
        return ['period' => $period, 'metrics' => $metrics];
    }

    /** The typed error code for an exhausted metric (plan §5.8 error taxonomy). */
    public static function allowanceErrorCode(string $metric): string
    {
        return $metric === 'cloud_flow_runs' ? 'flow_credits_exceeded' : 'ai_allowance_exceeded';
    }

    /** Current month's consumed units for (user, metric). */
    private function meterCount(string $userId, string $metric, string $period): int
    {
        $stmt = $this->mysql->getConnection()->prepare(
            'SELECT `count` FROM usage_meter WHERE user_id = ? AND metric = ? AND period = ?'
        );
        $stmt->execute([$userId, $metric, $period]);
        return (int) $stmt->fetchColumn();
    }

    /** Atomic upsert increment of the (user, metric, period) meter row. */
    private function incrementMeter(string $userId, string $metric, string $period, int $amount, int $tokensIn, int $tokensOut): void
    {
        $stmt = $this->mysql->getConnection()->prepare(
            'INSERT INTO usage_meter (user_id, metric, period, `count`, tokens_in, tokens_out)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                `count` = `count` + VALUES(`count`),
                tokens_in = tokens_in + VALUES(tokens_in),
                tokens_out = tokens_out + VALUES(tokens_out)'
        );
        $stmt->execute([$userId, $metric, $period, $amount, $tokensIn, $tokensOut]);
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

<?php

declare(strict_types=1);

namespace FormLogic\Services\Packages;

use FormLogic\Database\MySQLConnection;
use PDO;

/**
 * DESK-502: the durable coordinator for install work that happens on a DEVICE.
 *
 * Installing a service distribution is not a request/response — it is fetch, verify, stage,
 * install, health-check, activate, on a machine that may disconnect halfway. The job row is
 * what makes that survivable: it outlives the connection, so a Desktop that drops mid-install
 * can come back and carry on instead of the work being lost or silently repeated.
 *
 * Three rules make it safe to resume:
 *
 *   - **One device owns a job.** Claiming is a guarded state flip, so two Desktops racing for
 *     the same job produce exactly one winner. The loser is told, not left half-running.
 *   - **A claim token proves ownership.** Every progress and completion call carries it, so a
 *     stale or hostile client cannot drive someone else's install — and a device that lost
 *     the race cannot report progress on work it never claimed.
 *   - **Terminal is terminal.** Once a job succeeds, fails or is cancelled, further calls are
 *     refused rather than reopening it. Replaying a completed install is how you get a second
 *     copy of something that was only meant to happen once.
 *
 * Resuming is idempotent: the owning device re-reads its own job and continues; it never
 * creates a second one.
 */
class InstallJobService
{
    /** How long a job stays claimable/resumable before it is considered abandoned. */
    public const TTL_SECONDS = 3600;

    public const STATE_QUEUED = 'queued';
    public const STATE_RUNNING = 'running';
    public const STATE_SUCCEEDED = 'succeeded';
    public const STATE_FAILED = 'failed';
    public const STATE_CANCELLED = 'cancelled';

    private const TERMINAL = [self::STATE_SUCCEEDED, self::STATE_FAILED, self::STATE_CANCELLED];

    private PDO $mysql;

    public function __construct(MySQLConnection $mysql)
    {
        $this->mysql = $mysql->getConnection();
    }

    /**
     * Queue work for a device to pick up.
     *
     * @param array{planId?:string,installationId?:string,distributionId?:string} $refs
     */
    public function enqueue(string $userId, string $kind, array $refs = []): array
    {
        $id = $this->uuid();
        $this->mysql->prepare('
            INSERT INTO package_install_jobs (id, user_id, kind, state, plan_id, installation_id, distribution_id, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ' . self::TTL_SECONDS . ' SECOND))
        ')->execute([
            $id, $userId, $kind, self::STATE_QUEUED,
            $refs['planId'] ?? null, $refs['installationId'] ?? null, $refs['distributionId'] ?? null,
        ]);
        \FormLogic\Support\PackageTelemetry::emit('package.job', ['outcome' => 'queued', 'kind' => $kind, 'planId' => $refs['planId'] ?? null]);
        return $this->get($id, $userId) ?? [];
    }

    /**
     * Claim a queued job for `$deviceId`. Returns the claim token, or null when the job is
     * gone, expired, or already claimed by someone else — a guarded flip, so exactly one
     * device wins a race.
     */
    public function claim(string $jobId, string $userId, string $deviceId): ?string
    {
        $token = bin2hex(random_bytes(32));
        $stmt = $this->mysql->prepare("
            UPDATE package_install_jobs
            SET state = '" . self::STATE_RUNNING . "', device_id = ?, claim_token = ?, progress = 0
            WHERE id = ? AND user_id = ? AND state = '" . self::STATE_QUEUED . "' AND expires_at > NOW()
        ");
        $stmt->execute([$deviceId, $token, $jobId, $userId]);
        if ($stmt->rowCount() === 0) {
            return null;
        }
        return $token;
    }

    /**
     * Resume a job this device already owns (reconnect after a drop). Idempotent: it returns
     * the same job, never a new one, and never hands ownership to a different device.
     */
    public function resume(string $jobId, string $userId, string $deviceId, string $claimToken): ?array
    {
        $job = $this->get($jobId, $userId);
        if ($job === null || $job['deviceId'] !== $deviceId || !hash_equals((string) $job['claimToken'], $claimToken)) {
            return null;
        }
        if (in_array($job['state'], self::TERMINAL, true)) {
            return $job; // already finished — the caller sees the outcome, not a resumption
        }
        return $job;
    }

    /**
     * Report progress. Refused for a foreign device, a wrong token, or a terminal job — the
     * three ways a stale client could otherwise talk over live work.
     */
    public function progress(string $jobId, string $deviceId, string $claimToken, int $percent, string $step): bool
    {
        $stmt = $this->mysql->prepare("
            UPDATE package_install_jobs SET progress = ?, step = ?
            WHERE id = ? AND device_id = ? AND claim_token = ? AND state = '" . self::STATE_RUNNING . "'
        ");
        $stmt->execute([max(0, min(100, $percent)), substr($step, 0, 190), $jobId, $deviceId, $claimToken]);
        return $stmt->rowCount() > 0;
    }

    /**
     * Finish a job. Terminal states never reopen, so a replayed completion is refused rather
     * than turning a failure back into a success (or running an install twice).
     */
    public function complete(string $jobId, string $deviceId, string $claimToken, bool $ok, ?string $errorCode = null, ?string $errorText = null): bool
    {
        $stmt = $this->mysql->prepare("
            UPDATE package_install_jobs
            SET state = ?, progress = ?, error_code = ?, error_text = ?
            WHERE id = ? AND device_id = ? AND claim_token = ? AND state = '" . self::STATE_RUNNING . "'
        ");
        $stmt->execute([
            $ok ? self::STATE_SUCCEEDED : self::STATE_FAILED,
            $ok ? 100 : null,
            $ok ? null : ($errorCode ?? 'install_failed'),
            $ok ? null : ($errorText === null ? null : substr($errorText, 0, 2000)),
            $jobId, $deviceId, $claimToken,
        ]);
        if ($stmt->rowCount() === 0) {
            return false;
        }
        \FormLogic\Support\PackageTelemetry::emit('package.job', [
            'outcome' => $ok ? 'succeeded' : 'failed',
            'code' => $ok ? null : ($errorCode ?? 'install_failed'),
        ]);
        return true;
    }

    /** Owner-initiated cancel. A job already finished stays as it finished. */
    public function cancel(string $jobId, string $userId): bool
    {
        $stmt = $this->mysql->prepare("
            UPDATE package_install_jobs SET state = '" . self::STATE_CANCELLED . "'
            WHERE id = ? AND user_id = ? AND state IN ('" . self::STATE_QUEUED . "','" . self::STATE_RUNNING . "')
        ");
        $stmt->execute([$jobId, $userId]);
        return $stmt->rowCount() > 0;
    }

    /** @return array<string,mixed>|null Owner-scoped; null for missing/foreign (identical 404s). */
    public function get(string $jobId, string $userId): ?array
    {
        $stmt = $this->mysql->prepare('SELECT * FROM package_install_jobs WHERE id = ? AND user_id = ?');
        $stmt->execute([$jobId, $userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row === false ? null : $this->project($row);
    }

    /** @return list<array<string,mixed>> */
    public function listForOwner(string $userId, int $limit = 50): array
    {
        $stmt = $this->mysql->prepare('SELECT * FROM package_install_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ' . max(1, min(100, $limit)));
        $stmt->execute([$userId]);
        return array_map(fn (array $row): array => $this->project($row), $stmt->fetchAll(PDO::FETCH_ASSOC));
    }

    /**
     * Expire jobs no device ever finished. Without this an abandoned job stays "running"
     * forever and its UI never resolves.
     */
    public function expireStale(): int
    {
        $stmt = $this->mysql->prepare("
            UPDATE package_install_jobs
            SET state = '" . self::STATE_FAILED . "', error_code = 'job_expired',
                error_text = 'no device completed this job before it expired'
            WHERE state IN ('" . self::STATE_QUEUED . "','" . self::STATE_RUNNING . "') AND expires_at <= NOW()
        ");
        $stmt->execute();
        return $stmt->rowCount();
    }

    /**
     * @param array<string,mixed> $row
     * @return array<string,mixed>
     */
    private function project(array $row): array
    {
        return [
            'id' => (string) $row['id'],
            'kind' => (string) $row['kind'],
            'state' => (string) $row['state'],
            'progress' => (int) $row['progress'],
            'step' => $row['step'] !== null ? (string) $row['step'] : null,
            'planId' => $row['plan_id'] !== null ? (string) $row['plan_id'] : null,
            'installationId' => $row['installation_id'] !== null ? (string) $row['installation_id'] : null,
            'distributionId' => $row['distribution_id'] !== null ? (string) $row['distribution_id'] : null,
            'deviceId' => $row['device_id'] !== null ? (string) $row['device_id'] : null,
            // Internal: never projected to a browser (see the controller).
            'claimToken' => $row['claim_token'] !== null ? (string) $row['claim_token'] : null,
            'errorCode' => $row['error_code'] !== null ? (string) $row['error_code'] : null,
            'error' => $row['error_text'] !== null ? (string) $row['error_text'] : null,
            'createdAt' => (string) $row['created_at'],
            'updatedAt' => (string) $row['updated_at'],
            'expiresAt' => (string) $row['expires_at'],
        ];
    }

    private function uuid(): string
    {
        $b = random_bytes(16);
        $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
        $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
    }
}

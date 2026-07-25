<?php

declare(strict_types=1);

namespace FormLogic\Services\Packages;

use FormLogic\Database\MySQLConnection;
use PDO;

/**
 * PKG-107: provisional commit, joint activation, and safe compensation.
 *
 * A package is not one thing. It can contribute flow-node definitions that live in the cloud,
 * web content, and (later) a signed distribution that has to be staged on a DEVICE. Committing
 * those one at a time and calling it done is how you get a half-installed package: the nodes
 * appear in the editor, the service they need is still staging, and the first run fails in a way
 * the user cannot act on.
 *
 * So an install COMMITS its components provisionally and activates them TOGETHER, and only once
 * every required component has passed a health check. Until then the installation exists but is
 * not active, and nothing it contributes is visible to the editor or the compiler.
 *
 * The states are deliberately few, and each means one thing:
 *
 *   provisional — written, not yet proven. Never visible to consumers.
 *   pending     — a device component whose device has not reported. Not a failure: an offline
 *                 laptop is a normal condition, and the install waits rather than failing.
 *   active      — proven healthy and visible.
 *   failed      — health refused. A REQUIRED failure means the whole activation is refused and
 *                 compensated; an OPTIONAL one is recorded and the rest proceed.
 *
 * Compensation is the part worth being careful about: when a required component fails, nothing
 * is left half-on. Activation is one transaction, so either every component flips to active or
 * none does — there is no window in which a consumer sees an inconsistent set. And because the
 * flip is guarded on the current state, retrying an activation that already succeeded is a
 * no-op rather than a second install.
 *
 * Backwards compatible by construction: an installation with NO component rows (everything
 * installed before this existed) reads as active. A record that was never written must not be
 * read as a refusal.
 */
class PackageActivationService
{
    public const STATE_PROVISIONAL = 'provisional';
    public const STATE_PENDING = 'pending';
    public const STATE_ACTIVE = 'active';
    public const STATE_FAILED = 'failed';

    private PDO $mysql;

    public function __construct(MySQLConnection $mysql)
    {
        $this->mysql = $mysql->getConnection();
    }

    /**
     * Record an installation's components as PROVISIONAL (cloud) or PENDING (device).
     *
     * Called inside the install transaction: the components and the rows they describe commit
     * or roll back together, so there can never be definitions with no component describing them.
     *
     * @param list<array{key:string,kind:string,target:string,required?:bool,deviceId?:string|null}> $components
     */
    public function recordComponents(string $installationId, string $userId, array $components): void
    {
        // Re-recording replaces: an update re-declares its components, and a stale row from the
        // previous version must not survive to gate (or falsely satisfy) the new one.
        $this->mysql->prepare('DELETE FROM package_components WHERE installation_id = ?')->execute([$installationId]);

        $insert = $this->mysql->prepare('
            INSERT INTO package_components (id, user_id, installation_id, component_key, kind, target, required, state, device_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ');
        foreach ($components as $component) {
            $target = ($component['target'] ?? 'cloud') === 'device' ? 'device' : 'cloud';
            $insert->execute([
                $this->uuid(),
                $userId,
                $installationId,
                substr((string) $component['key'], 0, 64),
                substr((string) $component['kind'], 0, 32),
                $target,
                ($component['required'] ?? true) !== false ? 1 : 0,
                // A device component starts PENDING, not provisional: nothing is wrong, the
                // device simply has not reported yet, and the two states get different UI.
                $target === 'device' ? self::STATE_PENDING : self::STATE_PROVISIONAL,
                isset($component['deviceId']) && is_string($component['deviceId']) ? $component['deviceId'] : null,
            ]);
        }
    }

    /**
     * Try to activate an installation. Idempotent: an already-active installation returns the
     * same success without rewriting anything.
     *
     * @param callable(array<string,mixed>):array{healthy:bool,detail?:string}|null $healthCheck
     *        Per-component health. Defaults to {@see defaultHealth()}.
     * @return array{
     *   state:string,
     *   activated:list<string>,
     *   failed:list<array{key:string,detail:string}>,
     *   pending:list<string>
     * }
     */
    public function activate(string $installationId, string $userId, ?callable $healthCheck = null): array
    {
        $components = $this->components($installationId, $userId);
        if ($components === []) {
            // Nothing declared — an installation from before components existed, or one with no
            // gateable parts. Treat as active: an absent record is not a refusal.
            return ['state' => self::STATE_ACTIVE, 'activated' => [], 'failed' => [], 'pending' => []];
        }
        if ($this->allRequiredActive($components)) {
            return [
                'state' => self::STATE_ACTIVE,
                'activated' => array_map(static fn ($c) => (string) $c['component_key'], $components),
                'failed' => [],
                'pending' => [],
            ];
        }

        $healthCheck ??= fn (array $component): array => $this->defaultHealth($component);

        $healthy = [];
        $failed = [];
        $pending = [];
        foreach ($components as $component) {
            $key = (string) $component['component_key'];
            if ($component['state'] === self::STATE_PENDING) {
                // A device component cannot be health-checked from here — the device reports.
                $pending[] = $key;
                continue;
            }
            $result = $healthCheck($component);
            if (($result['healthy'] ?? false) === true) {
                $healthy[] = $component;
                continue;
            }
            $failed[] = ['key' => $key, 'detail' => (string) ($result['detail'] ?? 'health check failed')];
        }

        // A REQUIRED component that failed health, or one still waiting on a device, means the
        // package is not usable. Nothing activates — a partially-active install is exactly the
        // state nobody can reason about.
        $blockedByRequired = false;
        foreach ($components as $component) {
            if ((int) $component['required'] !== 1) {
                continue;
            }
            $key = (string) $component['component_key'];
            $failedKeys = array_column($failed, 'key');
            if (in_array($key, $failedKeys, true) || in_array($key, $pending, true)) {
                $blockedByRequired = true;
            }
        }

        $this->mysql->beginTransaction();
        try {
            foreach ($failed as $failure) {
                $this->mysql->prepare('
                    UPDATE package_components SET state = ?, health_detail = ?
                    WHERE installation_id = ? AND component_key = ?
                ')->execute([self::STATE_FAILED, substr($failure['detail'], 0, 500), $installationId, $failure['key']]);
            }
            if (!$blockedByRequired) {
                // Activate TOGETHER, guarded on the state we read — a concurrent activation
                // wins once and the loser rewrites nothing.
                foreach ($healthy as $component) {
                    $this->mysql->prepare('
                        UPDATE package_components SET state = ?, activated_at = NOW()
                        WHERE installation_id = ? AND component_key = ? AND state = ?
                    ')->execute([self::STATE_ACTIVE, $installationId, (string) $component['component_key'], self::STATE_PROVISIONAL]);
                }
            }
            $this->mysql->commit();
        } catch (\Throwable $e) {
            // Compensation: the whole flip is undone, so the installation stays exactly as
            // inactive as it was. Retrying is then a clean retry, not a partial repeat.
            $this->mysql->rollBack();
            throw $e;
        }

        $state = $blockedByRequired
            ? ($pending !== [] && $failed === [] ? self::STATE_PENDING : self::STATE_FAILED)
            : self::STATE_ACTIVE;

        \FormLogic\Support\PackageTelemetry::emit('package.activate', [
            'installationId' => $installationId,
            'outcome' => $state,
            'count' => count($components),
        ]);

        return [
            'state' => $state,
            'activated' => $blockedByRequired ? [] : array_map(static fn ($c) => (string) $c['component_key'], $healthy),
            'failed' => $failed,
            'pending' => $pending,
        ];
    }

    /**
     * A device reporting the outcome of its own component (DESK-505's seam). The device is the
     * only thing that can know whether a staged distribution is healthy there.
     */
    public function reportDeviceComponent(
        string $installationId,
        string $userId,
        string $componentKey,
        string $deviceId,
        bool $healthy,
        string $detail = ''
    ): bool {
        $stmt = $this->mysql->prepare('
            UPDATE package_components
            SET state = ?, health_detail = ?, device_id = ?, activated_at = IF(? = 1, NOW(), activated_at)
            WHERE installation_id = ? AND user_id = ? AND component_key = ? AND target = ?
        ');
        $stmt->execute([
            $healthy ? self::STATE_ACTIVE : self::STATE_FAILED,
            substr($detail, 0, 500),
            $deviceId,
            $healthy ? 1 : 0,
            $installationId,
            $userId,
            $componentKey,
            'device',
        ]);
        return $stmt->rowCount() > 0;
    }

    /**
     * Is this installation usable? An installation with no components reads as active (nothing
     * was ever gated); otherwise every REQUIRED component must be active.
     */
    public function isActive(string $installationId): bool
    {
        $stmt = $this->mysql->prepare('
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN required = 1 AND state <> ? THEN 1 ELSE 0 END) AS blocking
            FROM package_components WHERE installation_id = ?
        ');
        $stmt->execute([self::STATE_ACTIVE, $installationId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC) ?: ['total' => 0, 'blocking' => 0];
        return (int) $row['total'] === 0 || (int) $row['blocking'] === 0;
    }

    /**
     * Every installation id of this owner that is NOT usable. One query, so consumers can gate a
     * whole list without a query per row.
     *
     * @return list<string>
     */
    public function inactiveInstallationIds(string $userId): array
    {
        $stmt = $this->mysql->prepare('
            SELECT DISTINCT installation_id FROM package_components
            WHERE user_id = ? AND required = 1 AND state <> ?
        ');
        $stmt->execute([$userId, self::STATE_ACTIVE]);
        return array_map('strval', $stmt->fetchAll(PDO::FETCH_COLUMN));
    }

    /** @return list<array<string,mixed>> */
    public function components(string $installationId, string $userId): array
    {
        $stmt = $this->mysql->prepare('
            SELECT installation_id, component_key, kind, target, required, state, device_id, health_detail, activated_at
            FROM package_components
            WHERE installation_id = ? AND user_id = ?
            ORDER BY component_key ASC
        ');
        $stmt->execute([$installationId, $userId]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    /**
     * Default health for a cloud component: the definitions this installation wrote must decode
     * and agree with their own stored type.
     *
     * This is a real check rather than a formality — it catches a truncated or mangled write
     * before the editor offers a node that would fail at compile.
     *
     * @param array<string,mixed> $component
     * @return array{healthy:bool,detail?:string}
     */
    private function defaultHealth(array $component): array
    {
        if (($component['kind'] ?? '') !== 'cloud-nodes') {
            return ['healthy' => true]; // nothing gateable declared for this kind yet
        }
        $stmt = $this->mysql->prepare('SELECT node_type, definition_json FROM flow_node_definitions WHERE installation_id = ?');
        $stmt->execute([(string) ($component['installation_id'] ?? '')]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        if ($rows === []) {
            return ['healthy' => false, 'detail' => 'no contributed node definitions were stored'];
        }
        foreach ($rows as $row) {
            $definition = json_decode((string) $row['definition_json'], true);
            if (!is_array($definition)) {
                return ['healthy' => false, 'detail' => 'a stored definition could not be decoded'];
            }
            if (($definition['type'] ?? null) !== $row['node_type']) {
                return ['healthy' => false, 'detail' => 'a stored definition does not match its own node type'];
            }
        }
        return ['healthy' => true];
    }

    private function uuid(): string
    {
        $b = random_bytes(16);
        $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
        $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
    }

    /** @param list<array<string,mixed>> $components */
    private function allRequiredActive(array $components): bool
    {
        foreach ($components as $component) {
            if ((int) $component['required'] === 1 && $component['state'] !== self::STATE_ACTIVE) {
                return false;
            }
        }
        return true;
    }
}

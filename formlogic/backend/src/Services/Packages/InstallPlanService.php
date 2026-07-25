<?php

declare(strict_types=1);

namespace FormLogic\Services\Packages;

use FormLogic\Database\MySQLConnection;
use PDO;

/**
 * Package install plans (ADR-010 / PKG-106, first slice: the Application Package v2 lane).
 *
 * The plan is the OWNER-BOUND, EXPIRING, SINGLE-USE review unit the plan document requires:
 *   - propose  → validate + preflight + snapshot the dependency resolution, store the EXACT
 *                reviewed aggregate bytes and their sha256 digest; NO mutations.
 *   - confirm  → require the reviewed plan digest back (proof the caller reviewed THIS plan),
 *                CLAIM the plan with a guarded state flip (single-use even under races),
 *                then install the STORED bytes — install() re-validates and RE-RESOLVES
 *                against current installed state (plan §7.3.10), so a stale plan fails
 *                cleanly instead of committing against a changed world.
 *   - cancel   → owner-explicit discard.
 * A failed confirm marks the plan 'failed' with the error retained — stale plans never
 * become retriable; the client re-proposes and re-reviews.
 */
class InstallPlanService
{
    public const TTL_SECONDS = 900; // 15 minutes — long enough to review, short enough to go stale

    private PDO $mysql;
    private MySQLConnection $connection;
    private ?DependencyChainResolver $chainResolver = null;

    public function __construct(
        MySQLConnection $mysql,
        private PackageV2InstallService $installer,
    ) {
        $this->mysql = $mysql->getConnection();
        $this->connection = $mysql;
    }

    /**
     * @param array<string,mixed> $aggregate The v2 aggregate exactly as reviewed.
     * @param array<string,mixed> $capabilities The controller's capability summary (stored verbatim).
     * @return array<string,mixed> {planId, planDigest, expiresAt, trust, capabilities, resolution}
     */
    /** Built lazily so every existing construction site keeps its signature. */
    private function chain(): DependencyChainResolver
    {
        return $this->chainResolver ??= new DependencyChainResolver($this->connection);
    }

    public function propose(array $aggregate, string $userId, string $trust, string $source, array $capabilities): array
    {
        // Same preflight the install commits under — a proposed plan can never accept what
        // confirm would refuse (typed RuntimeExceptions propagate to the caller).
        $this->installer->assertNodeOnlyInstallable($aggregate);
        $resolution = $this->installer->resolveDependencies($aggregate, $userId);

        // Auto-install: work out what else has to be installed for this to install, from the
        // catalog, in order. The chain is REVIEWED here rather than installed here — a
        // dependency carries its own connector grants and node types, and pulling those in
        // without showing them would defeat the point of reviewing an install.
        $chain = $this->chain()->resolveChain($aggregate, $userId);
        if (!$resolution['ok'] && $chain['ok']) {
            // Everything the plain resolver called missing is satisfiable from the catalog, so
            // the plan is viable after all — it just has more than one step.
            $resolution = ['ok' => true, 'resolved' => $resolution['resolved'], 'missingOptional' => $resolution['missingOptional'], 'problems' => []];
        } elseif (!$chain['ok']) {
            // Surface the chain's reasons (cycle, unavailable, incompatible) rather than the
            // plain resolver's "install it first", which is not actionable when the thing to
            // install cannot be found either.
            $resolution = ['ok' => false, 'resolved' => $resolution['resolved'], 'missingOptional' => $resolution['missingOptional'], 'problems' => $chain['problems']];
        }

        // PKG-108: the same package id installed at a DIFFERENT version proposes an UPDATE
        // (confirm routes to update(), which enforces publisher identity and dependents'
        // ranges); the SAME version refuses here exactly like the install would.
        $meta = is_array($aggregate['package'] ?? null) ? $aggregate['package'] : [];
        $stmt = $this->mysql->prepare('SELECT version FROM package_installations WHERE user_id = ? AND package_id = ?');
        $stmt->execute([$userId, (string) ($meta['id'] ?? '')]);
        $installedVersion = $stmt->fetchColumn();
        $action = 'install';
        if (is_string($installedVersion) && $installedVersion !== '') {
            if ($installedVersion === (string) ($meta['version'] ?? '')) {
                throw new \RuntimeException('This package is already installed at v' . $installedVersion);
            }
            $action = 'update';
        } else {
            $installedVersion = null;
        }

        // Housekeeping: expired proposals are worthless — drop the owner's stale rows.
        $this->mysql->prepare("DELETE FROM package_install_plans WHERE user_id = ? AND state = 'proposed' AND expires_at < NOW()")
            ->execute([$userId]);

        $aggregateJson = (string) json_encode($aggregate, JSON_UNESCAPED_SLASHES);
        $planDigest = hash('sha256', $aggregateJson);
        // RUN-306: an update review shows what it would do to flows already using this
        // package — a node type going away turns stored nodes into read-only placeholders,
        // and that is worth knowing before committing rather than after.
        $migration = $action === 'update' ? $this->installer->previewUpdate($aggregate, $userId) : null;
        $summary = [
            'action' => $action,
            'installedVersion' => $installedVersion,
            'capabilities' => $capabilities,
            'resolution' => $resolution,
            'migration' => $migration,
            // What ELSE this install brings, in the order it will be installed. Empty when the
            // package stands alone or its dependencies are already satisfied.
            'plannedInstalls' => array_map(
                static fn (array $step): array => [
                    'packageId' => $step['packageId'],
                    'version' => $step['version'],
                    'displayName' => $step['displayName'],
                    'nodeCount' => $step['nodeCount'],
                ],
                $chain['chain']
            ),
        ];
        $planId = $this->uuid();
        $stmt = $this->mysql->prepare('
            INSERT INTO package_install_plans
                (id, user_id, state, trust, source, aggregate_json, plan_digest, summary_json, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ' . self::TTL_SECONDS . ' SECOND))
        ');
        $stmt->execute([$planId, $userId, 'proposed', $trust, $source, $aggregateJson, $planDigest, (string) json_encode($summary, JSON_UNESCAPED_SLASHES)]);

        return [
            'planId' => $planId,
            'planDigest' => $planDigest,
            'expiresInSeconds' => self::TTL_SECONDS,
            'trust' => $trust,
            'action' => $action,
            'installedVersion' => $installedVersion,
            'migration' => $migration,
            'capabilities' => $capabilities,
            'resolution' => $resolution,
            // What else this install brings, in install order. The reviewer sees it BEFORE
            // confirming — an install that quietly adds three packages is not something anyone
            // should have to discover from a list screen afterwards.
            'plannedInstalls' => $summary['plannedInstalls'],
        ];
    }

    /** @return array<string,mixed>|null Owner-scoped plan view; null when missing/foreign. */
    public function get(string $planId, string $userId): ?array
    {
        $stmt = $this->mysql->prepare('SELECT * FROM package_install_plans WHERE id = ? AND user_id = ?');
        $stmt->execute([$planId, $userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            return null;
        }
        $summary = json_decode((string) $row['summary_json'], true);
        return [
            'planId' => (string) $row['id'],
            'state' => (string) $row['state'],
            'trust' => (string) $row['trust'],
            'planDigest' => (string) $row['plan_digest'],
            'expiresAt' => (string) $row['expires_at'],
            'action' => is_array($summary) ? (string) ($summary['action'] ?? 'install') : 'install',
            'installedVersion' => is_array($summary) && is_string($summary['installedVersion'] ?? null) ? $summary['installedVersion'] : null,
            'migration' => is_array($summary) ? ($summary['migration'] ?? null) : null,
            'capabilities' => is_array($summary) ? ($summary['capabilities'] ?? null) : null,
            'resolution' => is_array($summary) ? ($summary['resolution'] ?? null) : null,
            'installationId' => $row['installation_id'] !== null ? (string) $row['installation_id'] : null,
            'error' => $row['error_text'] !== null ? (string) $row['error_text'] : null,
        ];
    }

    /**
     * Confirm (commit) a proposed plan. SAFE-001: the reviewed connector-grant array is the
     * caller's explicit approval set; the digest is proof they reviewed THIS plan's bytes.
     *
     * @param list<string> $approvedConnectorGrants
     * @return array<string,mixed> The install() result plus planId.
     * @throws \RuntimeException typed: plan_not_confirmable | plan_digest_mismatch | install failures
     */
    public function confirm(string $planId, string $userId, string $planDigest, array $approvedConnectorGrants): array
    {
        $stmt = $this->mysql->prepare('SELECT plan_digest, trust, source, aggregate_json, summary_json FROM package_install_plans WHERE id = ? AND user_id = ?');
        $stmt->execute([$planId, $userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            throw new \RuntimeException('plan_not_confirmable: the install plan does not exist');
        }
        if (!hash_equals((string) $row['plan_digest'], $planDigest)) {
            throw new \RuntimeException('plan_digest_mismatch: the reviewed plan digest does not match — re-review the package');
        }

        // Single-use claim (guarded flip): only ONE confirm can move proposed → confirming,
        // and only while unexpired. Losing the race (or a cancelled/expired/used plan) is the
        // same typed refusal.
        $claim = $this->mysql->prepare("
            UPDATE package_install_plans SET state = 'confirming'
            WHERE id = ? AND user_id = ? AND state = 'proposed' AND expires_at > NOW()
        ");
        $claim->execute([$planId, $userId]);
        if ($claim->rowCount() === 0) {
            throw new \RuntimeException('plan_not_confirmable: the install plan expired, was cancelled, or was already used — propose it again');
        }

        $aggregate = json_decode((string) $row['aggregate_json'], true);
        $summary = json_decode((string) $row['summary_json'], true);
        $action = is_array($summary) ? (string) ($summary['action'] ?? 'install') : 'install';
        try {
            if (!is_array($aggregate)) {
                throw new \RuntimeException('plan_not_confirmable: the stored plan payload is unreadable');
            }
            // install()/update() re-validate AND re-resolve against CURRENT installed state
            // (plan §7.3.10) — the stored bytes are what commits, the world is re-checked.
            // An update plan whose target was uninstalled meanwhile fails typed (not_installed);
            // an install plan whose package appeared meanwhile fails typed (already installed).
            // Dependencies first, in the order the plan reviewed them. Re-resolved against
            // CURRENT state rather than replayed from the plan: something in the chain may have
            // been installed by hand since, and installing it twice would fail the second time.
            $chainInstalled = [];
            foreach ($this->chain()->resolveChain($aggregate, $userId)['chain'] as $step) {
                $installedStep = $this->installer->install(
                    $step['aggregate'],
                    $userId,
                    // A dependency's own grants are not approved by approving the package that
                    // asked for it. Nothing is auto-granted; the owner reviews the dependency's
                    // own grants when they choose to give it any.
                    [],
                    $row['source'] . ':dependency',
                    (string) $row['trust']
                );
                $chainInstalled[] = [
                    'packageId' => $step['packageId'],
                    'version' => $step['version'],
                    'displayName' => $step['displayName'],
                    'installationId' => $installedStep['installationId'],
                ];
            }

            $result = $action === 'update'
                ? $this->installer->update($aggregate, $userId, $approvedConnectorGrants, $row['source'] . ':plan', (string) $row['trust'])
                : $this->installer->install($aggregate, $userId, $approvedConnectorGrants, $row['source'] . ':plan', (string) $row['trust']);
            if ($chainInstalled !== []) {
                // Name what else landed. An install that quietly added three packages is not a
                // thing anyone should have to discover from a list screen afterwards.
                $result['dependenciesInstalled'] = $chainInstalled;
            }
        } catch (\Exception $e) {
            // A failed confirm is terminal for the plan — stale plans never become retriable.
            $this->mysql->prepare("UPDATE package_install_plans SET state = 'failed', error_text = ? WHERE id = ?")
                ->execute([substr($e->getMessage(), 0, 2000), $planId]);
            throw $e;
        }

        $this->mysql->prepare("UPDATE package_install_plans SET state = 'confirmed', confirmed_at = NOW(), installation_id = ? WHERE id = ?")
            ->execute([$result['installationId'], $planId]);
        $result['planId'] = $planId;
        return $result;
    }

    /** Owner-explicit discard. Returns false when the plan is missing/foreign/not proposed. */
    public function cancel(string $planId, string $userId): bool
    {
        $stmt = $this->mysql->prepare("UPDATE package_install_plans SET state = 'cancelled' WHERE id = ? AND user_id = ? AND state = 'proposed'");
        $stmt->execute([$planId, $userId]);
        return $stmt->rowCount() > 0;
    }

    private function uuid(): string
    {
        $b = random_bytes(16);
        $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
        $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
    }
}

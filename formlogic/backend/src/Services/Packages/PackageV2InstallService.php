<?php

declare(strict_types=1);

namespace FormLogic\Services\Packages;

use FormLogic\Database\MySQLConnection;
use FormLogic\Helpers\ApplicationPackageV2Validator;
use PDO;

/**
 * Application Package v2 installation (ADR-010 / PKG-103 first slice: NODE-ONLY packages).
 *
 * Installs an aggregate whose payload is inline flow-node contributions (+ recorded
 * service requirements) WITHOUT creating forms or apps — an installed extension, not a
 * fake launcher. Everything this slice cannot yet honor is REFUSED with a typed message
 * rather than silently ignored (plan rule: never drop declared content):
 *   - content.pack            → the v2 app-content lane lands with the install-plan APIs;
 *   - dependencies.packages   → needs the deterministic resolver (PKG-105);
 *   - serviceDistributions    → needs the signed-distribution pipeline (Phase 5);
 *   - entry-path contributions → need the archive lane (JSON delivery must inline them).
 *
 * Persistence (PKG-104 subset): package_installations (one active version per package per
 * owner) + flow_node_definitions (one active contributed type per owner; digest = sha256
 * over the stored definition_json bytes; rows cascade with their installation).
 * receipt_json is the immutable install receipt: package meta + contribution digests +
 * recorded requirements + the reviewed grant array.
 */
class PackageV2InstallService
{
    private PDO $mysql;
    private MySQLConnection $connection;

    public function __construct(MySQLConnection $mysql)
    {
        $this->mysql = $mysql->getConnection();
        $this->connection = $mysql;
    }

    /**
     * @param array<string,mixed> $aggregate The validated-or-refused v2 aggregate.
     * @param list<string> $approvedConnectorGrants SAFE-001 reviewed grant array (recorded in the receipt).
     * @return array{installationId:string,packageId:string,version:string,kind:string,displayName:string,nodeTypes:list<string>}
     */
    public function install(array $aggregate, string $userId, array $approvedConnectorGrants, string $source = 'json', string $trust = 'community'): array
    {
        // REL-705: the kill switch refuses NEW installs; existing content stays managed.
        if (!PackagesFeature::v2Enabled()) {
            throw new \RuntimeException('feature_disabled: Application Package v2 installs are disabled on this deployment');
        }
        // Shared preflight (PKG-106: the install-plan propose step runs the SAME checks, so a
        // reviewable plan and a committable install can never diverge on what is acceptable).
        $contributions = $this->assertNodeOnlyInstallable($aggregate);

        $meta = $aggregate['package'];
        $packageId = (string) $meta['id'];

        // One active version per package per owner (also enforced by uniq_pkgi_active).
        $stmt = $this->mysql->prepare('SELECT id FROM package_installations WHERE user_id = ? AND package_id = ?');
        $stmt->execute([$userId, $packageId]);
        if ($stmt->fetchColumn() !== false) {
            throw new \RuntimeException('This package is already installed');
        }

        // PKG-105: resolve declared dependencies against the owner's INSTALLED graph. There is no
        // catalog fetch in this slice, so a missing/incompatible REQUIRED dependency is a typed
        // refusal naming exactly what to install first — never a silent skip. Satisfied edges are
        // recorded so the depended-upon package cannot be uninstalled out from under this one.
        $resolution = $this->resolveDependencies($aggregate, $userId);
        if (!$resolution['ok']) {
            $lines = array_map(static fn (array $p): string => $p['message'], $resolution['problems']);
            throw new \RuntimeException('unresolved_dependencies: ' . implode('; ', $lines));
        }
        $resolvedDeps = $resolution['resolved'];
        $missingOptional = $resolution['missingOptional'];

        // A contributed type is owned by exactly one installed package (plan §8.2: a duplicate
        // type is an install error, never silent first-provider-wins).
        $types = array_map(static fn (array $c): string => (string) $c['type'], $contributions);
        $placeholders = implode(',', array_fill(0, count($types), '?'));
        $stmt = $this->mysql->prepare("SELECT node_type FROM flow_node_definitions WHERE user_id = ? AND node_type IN ($placeholders)");
        $stmt->execute(array_merge([$userId], $types));
        $taken = $stmt->fetchAll(PDO::FETCH_COLUMN);
        if (!empty($taken)) {
            throw new \RuntimeException('Contributed node type is already installed by another package: ' . implode(', ', $taken));
        }

        $installationId = $this->uuid();
        $definitionRows = [];
        foreach ($contributions as $def) {
            $json = (string) json_encode($def, JSON_UNESCAPED_SLASHES);
            $definitionRows[] = [
                'id' => $this->uuid(),
                'type' => (string) $def['type'],
                'version' => (string) $def['version'],
                'digest' => hash('sha256', $json),
                'json' => $json,
            ];
        }

        $receipt = [
            'formatVersion' => 2,
            'package' => $meta,
            'contributions' => array_map(static fn (array $r): array => [
                'type' => $r['type'],
                'version' => $r['version'],
                'digest' => $r['digest'],
            ], $definitionRows),
            'requirements' => $aggregate['requirements'] ?? new \stdClass(),
            // Exact dependency locks (PKG-105): what each declared range resolved to at install.
            'dependencies' => array_map(static fn (array $d): array => [
                'id' => $d['id'],
                'range' => $d['range'],
                'resolvedVersion' => $d['resolvedVersion'],
                'required' => $d['required'],
            ], $resolvedDeps),
            'missingOptionalDependencies' => $missingOptional,
            'approvedConnectorGrants' => array_values($approvedConnectorGrants),
            'source' => $source,
            'trust' => $trust,
            'installedAt' => gmdate('c'),
        ];

        $this->mysql->beginTransaction();
        try {
            $stmt = $this->mysql->prepare('
                INSERT INTO package_installations (id, user_id, package_id, publisher_id, kind, version, display_name, state, source, receipt_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ');
            $stmt->execute([
                $installationId,
                $userId,
                $packageId,
                (string) $meta['publisherId'],
                (string) $meta['kind'],
                (string) $meta['version'],
                (string) $meta['displayName'],
                'ready',
                $source,
                (string) json_encode($receipt, JSON_UNESCAPED_SLASHES),
            ]);
            $ins = $this->mysql->prepare('
                INSERT INTO flow_node_definitions (id, user_id, installation_id, node_type, version, digest, definition_json)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            ');
            foreach ($definitionRows as $row) {
                $ins->execute([$row['id'], $userId, $installationId, $row['type'], $row['version'], $row['digest'], $row['json']]);
            }
            $edge = $this->mysql->prepare('
                INSERT INTO package_dependency_edges (id, parent_installation_id, child_installation_id, child_package_id, requested_range, resolved_version, required)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            ');
            foreach ($resolvedDeps as $dep) {
                $edge->execute([$this->uuid(), $installationId, $dep['installationId'], $dep['id'], $dep['range'], $dep['resolvedVersion'], $dep['required'] ? 1 : 0]);
            }
            $this->mysql->commit();
        } catch (\Exception $e) {
            $this->mysql->rollBack();
            throw $e;
        }

        // OBS-702: one durable line per install — which package, at what version, from where,
        // with how much contributed surface. Identifiers and counts only.
        \FormLogic\Support\PackageTelemetry::emit('package.install', [
            'packageId' => $packageId,
            'publisherId' => (string) $meta['publisherId'],
            'version' => (string) $meta['version'],
            'installationId' => $installationId,
            'kind' => (string) $meta['kind'],
            'source' => $source,
            'trust' => $trust,
            'nodeCount' => count($definitionRows),
            'grantCount' => count($approvedConnectorGrants),
            'dependencyCount' => count($resolvedDeps),
            'outcome' => 'installed',
        ]);

        return [
            'installationId' => $installationId,
            'packageId' => $packageId,
            'version' => (string) $meta['version'],
            'kind' => (string) $meta['kind'],
            'displayName' => (string) $meta['displayName'],
            'nodeTypes' => array_map(static fn (array $r): string => $r['type'], $definitionRows),
        ];
    }

    /**
     * PKG-108: update an installed package to a different version of the SAME package id —
     * atomically, in one transaction, so a failed update always leaves the prior active
     * version fully intact (plan §7.3 / §9.4). Rules:
     *   - the publisher cannot change (a different publisher adopting an installed id is a
     *     hijack, not an update);
     *   - every DEPENDENT's declared range must still be satisfied by the new version, or
     *     the update refuses naming them (update_blocked) — dependents keep what they pinned;
     *   - contributed definitions are REPLACED (removed types leave stored flow nodes as
     *     placeholders; added types must not collide with another package's);
     *   - the package's own dependencies re-resolve freshly; inbound edges keep their
     *     installation id (consumers never dangle) with resolved_version bumped;
     *   - old flow revisions are untouched — their compiled IR and locks are pinned.
     *
     * @param list<string> $approvedConnectorGrants
     * @return array{installationId:string,packageId:string,version:string,previousVersion:string,kind:string,displayName:string,nodeTypes:list<string>}
     */
    public function update(array $aggregate, string $userId, array $approvedConnectorGrants, string $source = 'json', string $trust = 'community'): array
    {
        if (!PackagesFeature::v2Enabled()) {
            throw new \RuntimeException('feature_disabled: Application Package v2 installs are disabled on this deployment');
        }
        $contributions = $this->assertNodeOnlyInstallable($aggregate);
        $meta = $aggregate['package'];
        $packageId = (string) $meta['id'];
        $newVersion = (string) $meta['version'];

        $stmt = $this->mysql->prepare('SELECT id, publisher_id, version FROM package_installations WHERE user_id = ? AND package_id = ?');
        $stmt->execute([$userId, $packageId]);
        $existing = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$existing) {
            throw new \RuntimeException('not_installed: nothing to update — install the package instead');
        }
        $installationId = (string) $existing['id'];
        $previousVersion = (string) $existing['version'];
        if ((string) $existing['publisher_id'] !== (string) $meta['publisherId']) {
            throw new \RuntimeException('publisher_mismatch: the update is signed by a different publisher than the installed package — refusing');
        }
        if ($previousVersion === $newVersion) {
            throw new \RuntimeException('This package is already installed at v' . $newVersion);
        }

        // Dependents pinned this package: the NEW version must still satisfy every inbound range.
        $deps = $this->mysql->prepare('
            SELECT e.id, e.requested_range, pi.display_name
            FROM package_dependency_edges e
            JOIN package_installations pi ON pi.id = e.parent_installation_id
            WHERE e.child_installation_id = ?
        ');
        $deps->execute([$installationId]);
        $inbound = $deps->fetchAll(PDO::FETCH_ASSOC);
        $blocked = [];
        foreach ($inbound as $edge) {
            if (!DependencyResolver::satisfies($newVersion, (string) $edge['requested_range'])) {
                $blocked[] = '"' . $edge['display_name'] . '" requires ' . $edge['requested_range'];
            }
        }
        if ($blocked !== []) {
            throw new \RuntimeException('update_blocked: v' . $newVersion . ' no longer satisfies ' . implode(', ', $blocked) . ' — update or remove those first');
        }

        // The package's own dependencies re-resolve against the CURRENT installed graph.
        $resolution = $this->resolveDependencies($aggregate, $userId);
        if (!$resolution['ok']) {
            $lines = array_map(static fn (array $p): string => $p['message'], $resolution['problems']);
            throw new \RuntimeException('unresolved_dependencies: ' . implode('; ', $lines));
        }

        // Added/changed types must not belong to ANOTHER package (this installation's own rows
        // are being replaced, so they are excluded from the collision check).
        $types = array_map(static fn (array $c): string => (string) $c['type'], $contributions);
        $placeholders = implode(',', array_fill(0, count($types), '?'));
        $stmt = $this->mysql->prepare("SELECT node_type FROM flow_node_definitions WHERE user_id = ? AND installation_id != ? AND node_type IN ($placeholders)");
        $stmt->execute(array_merge([$userId, $installationId], $types));
        $taken = $stmt->fetchAll(PDO::FETCH_COLUMN);
        if (!empty($taken)) {
            throw new \RuntimeException('Contributed node type is already installed by another package: ' . implode(', ', $taken));
        }

        $definitionRows = [];
        foreach ($contributions as $def) {
            $json = (string) json_encode($def, JSON_UNESCAPED_SLASHES);
            $definitionRows[] = [
                'id' => $this->uuid(),
                'type' => (string) $def['type'],
                'version' => (string) $def['version'],
                'digest' => hash('sha256', $json),
                'json' => $json,
            ];
        }
        $receipt = [
            'formatVersion' => 2,
            'package' => $meta,
            'updatedFrom' => $previousVersion,
            'contributions' => array_map(static fn (array $r): array => [
                'type' => $r['type'],
                'version' => $r['version'],
                'digest' => $r['digest'],
            ], $definitionRows),
            'requirements' => $aggregate['requirements'] ?? new \stdClass(),
            'dependencies' => array_map(static fn (array $d): array => [
                'id' => $d['id'],
                'range' => $d['range'],
                'resolvedVersion' => $d['resolvedVersion'],
                'required' => $d['required'],
            ], $resolution['resolved']),
            'missingOptionalDependencies' => $resolution['missingOptional'],
            'approvedConnectorGrants' => array_values($approvedConnectorGrants),
            'source' => $source,
            'trust' => $trust,
            'installedAt' => gmdate('c'),
        ];

        $this->mysql->beginTransaction();
        try {
            $this->mysql->prepare('
                UPDATE package_installations SET kind = ?, version = ?, display_name = ?, source = ?, receipt_json = ? WHERE id = ?
            ')->execute([(string) $meta['kind'], $newVersion, (string) $meta['displayName'], $source, (string) json_encode($receipt, JSON_UNESCAPED_SLASHES), $installationId]);

            // Replace the contributed definitions wholesale (removed types → placeholders).
            $this->mysql->prepare('DELETE FROM flow_node_definitions WHERE installation_id = ?')->execute([$installationId]);
            $ins = $this->mysql->prepare('
                INSERT INTO flow_node_definitions (id, user_id, installation_id, node_type, version, digest, definition_json)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            ');
            foreach ($definitionRows as $row) {
                $ins->execute([$row['id'], $userId, $installationId, $row['type'], $row['version'], $row['digest'], $row['json']]);
            }

            // The package's own OUTBOUND edges re-record per the fresh resolution…
            $this->mysql->prepare('DELETE FROM package_dependency_edges WHERE parent_installation_id = ?')->execute([$installationId]);
            $edge = $this->mysql->prepare('
                INSERT INTO package_dependency_edges (id, parent_installation_id, child_installation_id, child_package_id, requested_range, resolved_version, required)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            ');
            foreach ($resolution['resolved'] as $dep) {
                $edge->execute([$this->uuid(), $installationId, $dep['installationId'], $dep['id'], $dep['range'], $dep['resolvedVersion'], $dep['required'] ? 1 : 0]);
            }
            // …and INBOUND edges (dependents) keep their rows — only the resolved version bumps.
            $this->mysql->prepare('UPDATE package_dependency_edges SET resolved_version = ? WHERE child_installation_id = ?')
                ->execute([$newVersion, $installationId]);

            // SRV-405: bindings for slots the new version NO LONGER DECLARES must go. Keeping
            // them would leave rows the owner cannot see (listSlots shows declared slots only)
            // and cannot remove — and a later version re-declaring the same slot name would
            // silently reactivate a binding that was never re-reviewed. Bindings for slots
            // that survive the update are deliberately KEPT: the installation is the same, so
            // re-choosing the same service after every patch release would be busywork.
            $declaredSlots = [];
            foreach ((is_array($aggregate['requirements']['services'] ?? null) ? $aggregate['requirements']['services'] : []) as $service) {
                if (is_array($service) && is_string($service['slot'] ?? null) && $service['slot'] !== '') {
                    $declaredSlots[] = $service['slot'];
                }
            }
            if ($declaredSlots === []) {
                $this->mysql->prepare('DELETE FROM package_service_bindings WHERE installation_id = ?')->execute([$installationId]);
            } else {
                $placeholders = implode(',', array_fill(0, count($declaredSlots), '?'));
                $this->mysql->prepare("DELETE FROM package_service_bindings WHERE installation_id = ? AND slot NOT IN ($placeholders)")
                    ->execute(array_merge([$installationId], $declaredSlots));
            }

            $this->mysql->commit();
        } catch (\Exception $e) {
            $this->mysql->rollBack();
            throw $e;
        }

        \FormLogic\Support\PackageTelemetry::emit('package.update', [
            'packageId' => $packageId,
            'publisherId' => (string) $meta['publisherId'],
            'version' => $newVersion,
            'previousVersion' => $previousVersion,
            'installationId' => $installationId,
            'source' => $source,
            'trust' => $trust,
            'nodeCount' => count($definitionRows),
            'grantCount' => count($approvedConnectorGrants),
            'outcome' => 'updated',
        ]);

        return [
            'installationId' => $installationId,
            'packageId' => $packageId,
            'version' => $newVersion,
            'previousVersion' => $previousVersion,
            'kind' => (string) $meta['kind'],
            'displayName' => (string) $meta['displayName'],
            'nodeTypes' => array_map(static fn (array $r): string => $r['type'], $definitionRows),
        ];
    }

    /**
     * RUN-306: what an update would DO to flows that already use this package, computed
     * without changing anything.
     *
     * An update replaces a package's contributed definitions wholesale, so a version that
     * stops shipping a node type silently turns every stored node of that type into a
     * read-only placeholder — the flow keeps its data but stops compiling. Today the owner
     * discovers that after committing. This answers it beforehand.
     *
     * "Affected" is derived from the definition LOCKS pinned into each flow's current
     * revision, which is the same record the compiler wrote — so it reflects what flows
     * actually compiled against, not a guess from scanning graph JSON.
     *
     * @param array<string,mixed> $aggregate The candidate new version.
     * @return array{
     *   removedTypes: list<string>,
     *   addedTypes: list<string>,
     *   affectedFlows: list<array{flowId:string,name:string,types:list<string>}>,
     *   breakingFlows: list<string>
     * }
     */
    public function previewUpdate(array $aggregate, string $userId): array
    {
        $meta = is_array($aggregate['package'] ?? null) ? $aggregate['package'] : [];
        $packageId = (string) ($meta['id'] ?? '');

        $stmt = $this->mysql->prepare('SELECT id FROM package_installations WHERE user_id = ? AND package_id = ?');
        $stmt->execute([$userId, $packageId]);
        $installationId = $stmt->fetchColumn();
        if ($installationId === false) {
            return ['removedTypes' => [], 'addedTypes' => [], 'affectedFlows' => [], 'breakingFlows' => []];
        }

        $current = $this->mysql->prepare('SELECT node_type FROM flow_node_definitions WHERE installation_id = ?');
        $current->execute([$installationId]);
        $currentTypes = array_map('strval', $current->fetchAll(PDO::FETCH_COLUMN));

        $nextTypes = [];
        foreach (($aggregate['contributions']['flowNodes'] ?? []) as $node) {
            if (is_array($node) && is_string($node['type'] ?? null)) {
                $nextTypes[] = $node['type'];
            }
        }
        $removedTypes = array_values(array_diff($currentTypes, $nextTypes));
        $addedTypes = array_values(array_diff($nextTypes, $currentTypes));

        // Which flows compiled against this package, and against which of its types.
        $rows = $this->mysql->prepare('
            SELECT fd.id AS flow_id, fd.name, v.definition_locks_json
            FROM flow_definition_versions v
            JOIN flow_definitions fd ON fd.id = v.flow_definition_id
            WHERE v.definition_locks_json IS NOT NULL
              AND (fd.owner_user_id = ? OR fd.app_id IN (SELECT id FROM apps WHERE owner_id = ?))
        ');
        $rows->execute([$userId, $userId]);

        $affected = [];
        foreach ($rows->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $locks = json_decode((string) $row['definition_locks_json'], true);
            if (!is_array($locks)) {
                continue;
            }
            $types = [];
            foreach ($locks as $lock) {
                if (is_array($lock) && ($lock['packageId'] ?? null) === $packageId && is_string($lock['type'] ?? null)) {
                    $types[] = $lock['type'];
                }
            }
            if ($types === []) {
                continue;
            }
            $types = array_values(array_unique($types));
            sort($types);
            $flowId = (string) $row['flow_id'];
            // A flow already listed (an older revision) keeps its first entry — the current
            // revision is what matters and rows arrive newest-relevant per flow id.
            if (!isset($affected[$flowId])) {
                $affected[$flowId] = ['flowId' => $flowId, 'name' => (string) $row['name'], 'types' => $types];
            }
        }

        // A flow BREAKS if any type it compiled against is going away.
        $breaking = [];
        foreach ($affected as $flow) {
            if (array_intersect($flow['types'], $removedTypes) !== []) {
                $breaking[] = $flow['flowId'];
            }
        }

        sort($removedTypes);
        sort($addedTypes);
        return [
            'removedTypes' => $removedTypes,
            'addedTypes' => $addedTypes,
            'affectedFlows' => array_values($affected),
            'breakingFlows' => $breaking,
        ];
    }

    /**
     * PKG-106 shared preflight: validate the aggregate and refuse (typed) everything this
     * slice cannot install — the SAME checks the install commits under, so a proposed plan
     * can never accept what confirm would refuse. Returns the inline contributions.
     *
     * @param array<string,mixed> $aggregate
     * @return list<array<string,mixed>>
     */
    public function assertNodeOnlyInstallable(array $aggregate): array
    {
        $issues = ApplicationPackageV2Validator::validatePackage($aggregate);
        if ($issues !== []) {
            $first = $issues[0];
            throw new \RuntimeException('Invalid application package: ' . $first['message'] . ' [' . $first['code'] . ' at ' . $first['path'] . ']');
        }
        if (isset($aggregate['content']['pack'])) {
            throw new \RuntimeException('unsupported_content: v2 packages carrying Pack content are not installable yet — this lane installs node-only extensions (deliver app content as a Pack v1 for now)');
        }
        if (!empty($aggregate['serviceDistributions'])) {
            // DESK-501: the descriptors are VERIFIED even though the staging pipeline
            // (DESK-504) is not built yet. A package whose distribution is malformed, targets
            // another platform, oversized, or path-escaping should be told THAT — a blanket
            // "not enabled yet" hides a defect the author could fix now, and would let a bad
            // descriptor sit in a published package until the day staging arrives.
            $host = [
                'platform' => PHP_OS_FAMILY === 'Windows' ? 'windows' : strtolower(PHP_OS_FAMILY),
                'arch' => php_uname('m'),
                'requireSigned' => false, // policy is applied by the caller's trust gate
            ];
            foreach ($aggregate['serviceDistributions'] as $index => $distribution) {
                if (!is_array($distribution)) {
                    throw new \RuntimeException("invalid_distribution: serviceDistributions[$index] is not an object");
                }
                $verdict = DistributionVerifier::verify($distribution, $host);
                // A platform mismatch is not a package defect — this host simply is not a
                // target — so it must not masquerade as one.
                if (!$verdict['ok'] && ($verdict['code'] ?? '') !== 'platform_unsupported') {
                    throw new \RuntimeException("invalid_distribution: serviceDistributions[$index] {$verdict['message']} [{$verdict['code']}]");
                }
            }
            throw new \RuntimeException('unsupported_distributions: the distribution descriptors verify, but installing them needs the desktop staging pipeline, which is not enabled yet');
        }
        $contributions = [];
        foreach (($aggregate['contributions']['flowNodes'] ?? []) as $node) {
            if (is_string($node)) {
                // The archive lane resolves entry paths into inline definitions before install
                // (PackService::resolveV2EntryPathContributions), so a string here means the
                // aggregate arrived as JSON, which carries no archive to read from.
                throw new \RuntimeException('unsupported_entry_path: a JSON-delivered package must inline its flow-node definitions — deliver it as a .formlogic archive to use entry paths');
            }
            $contributions[] = $node;
        }
        if ($contributions === []) {
            throw new \RuntimeException('nothing_installable: this lane installs node-only extensions — the package declares no inline flow-node contributions');
        }
        return $contributions;
    }

    /**
     * PKG-105/106: the dependency resolution snapshot against the owner's CURRENT installed
     * graph (report shape from DependencyResolver::resolve). Used by install (refuses on
     * problems) and by install-plan propose (shows the resolution without mutating).
     *
     * @param array<string,mixed> $aggregate
     * @return array{ok:bool,resolved:list<array<string,mixed>>,missingOptional:list<array<string,mixed>>,problems:list<array<string,mixed>>}
     */
    public function resolveDependencies(array $aggregate, string $userId): array
    {
        $declaredDeps = $aggregate['dependencies']['packages'] ?? [];
        if (empty($declaredDeps)) {
            return ['ok' => true, 'resolved' => [], 'missingOptional' => [], 'problems' => []];
        }
        $stmt = $this->mysql->prepare('SELECT id, package_id, version FROM package_installations WHERE user_id = ?');
        $stmt->execute([$userId]);
        $installedMap = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $installedMap[(string) $row['package_id']] = [
                'version' => (string) $row['version'],
                'installationId' => (string) $row['id'],
            ];
        }
        return DependencyResolver::resolve($declaredDeps, $installedMap, (string) ($aggregate['package']['id'] ?? ''));
    }

    /**
     * Uninstall a v2 installation. Contributed definitions carry no user data, so removal is a
     * hard delete (the FK cascades the definition rows). Returns null when the id is not a v2
     * installation for this user (so the controller can fall through to the Pack v1 path).
     *
     * @return array{packageId:string,displayName:string,nodesRemoved:int}|null
     */
    public function uninstall(string $installationId, string $userId): ?array
    {
        $stmt = $this->mysql->prepare('SELECT package_id, display_name FROM package_installations WHERE id = ? AND user_id = ?');
        $stmt->execute([$installationId, $userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            return null;
        }

        // PKG-105 reference counting: a package another installed package REQUIRES cannot be
        // removed out from under it — refuse and NAME the dependents (uninstall those first).
        $deps = $this->mysql->prepare('
            SELECT pi.display_name
            FROM package_dependency_edges e
            JOIN package_installations pi ON pi.id = e.parent_installation_id
            WHERE e.child_installation_id = ? AND e.required = 1
        ');
        $deps->execute([$installationId]);
        $dependents = $deps->fetchAll(PDO::FETCH_COLUMN);
        if (!empty($dependents)) {
            throw new \RuntimeException(
                'uninstall_blocked: "' . $row['display_name'] . '" is required by ' . implode(', ', array_map(static fn ($d) => '"' . $d . '"', $dependents)) . ' — uninstall those first'
            );
        }

        $count = $this->mysql->prepare('SELECT COUNT(*) FROM flow_node_definitions WHERE installation_id = ?');
        $count->execute([$installationId]);
        $nodes = (int) $count->fetchColumn();

        // SRV-403: capture the bound services BEFORE the cascade removes the rows — a live
        // capability whose install is gone must stop working now, not when its TTL lapses.
        $boundStmt = $this->mysql->prepare('SELECT DISTINCT definition_id FROM package_service_bindings WHERE installation_id = ?');
        $boundStmt->execute([$installationId]);
        $bound = $boundStmt->fetchAll(PDO::FETCH_COLUMN);

        $del = $this->mysql->prepare('DELETE FROM package_installations WHERE id = ? AND user_id = ?');
        $del->execute([$installationId, $userId]);

        $authorization = new ServiceAuthorizationService($this->connection);
        foreach ($bound as $definitionId) {
            if (is_string($definitionId) && $definitionId !== '') {
                $authorization->revoke($userId, $definitionId);
            }
        }

        \FormLogic\Support\PackageTelemetry::emit('package.uninstall', [
            'packageId' => (string) $row['package_id'],
            'installationId' => $installationId,
            'nodeCount' => $nodes,
            'outcome' => 'uninstalled',
        ]);

        return [
            'packageId' => (string) $row['package_id'],
            'displayName' => (string) $row['display_name'],
            'nodesRemoved' => $nodes,
        ];
    }

    /**
     * v2 installations shaped for the merged "Installed" list (a superset of the Pack v1 row
     * shape the UI reads: packName/packVersion/installedAt/… with zero forms/apps).
     *
     * @return list<array<string,mixed>>
     */
    public function listInstalled(string $userId): array
    {
        $stmt = $this->mysql->prepare('
            SELECT pi.id, pi.package_id, pi.publisher_id, pi.kind, pi.version, pi.display_name, pi.state, pi.created_at,
                   (SELECT COUNT(*) FROM flow_node_definitions fnd WHERE fnd.installation_id = pi.id) AS node_count
            FROM package_installations pi
            WHERE pi.user_id = ?
            ORDER BY pi.created_at DESC
        ');
        $stmt->execute([$userId]);
        $out = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $out[] = [
                'id' => (string) $row['id'],
                'packId' => (string) $row['package_id'],
                'catalogId' => null,
                'versionId' => null,
                'packName' => (string) $row['display_name'],
                'packVersion' => (string) $row['version'],
                'packDescription' => null,
                'formCount' => 0,
                'appCount' => 0,
                'existingFormCount' => 0,
                'existingAppCount' => 0,
                'formIds' => [],
                'appIds' => [],
                'installedAt' => (string) $row['created_at'],
                'updateAvailable' => null,
                // v2 marker fields (absent from Pack v1 rows).
                'formatVersion' => 2,
                'packageKind' => (string) $row['kind'],
                'publisherId' => (string) $row['publisher_id'],
                'state' => (string) $row['state'],
                'nodesInstalled' => (int) $row['node_count'],
            ];
        }
        return $out;
    }

    /**
     * The owner's installed flow-node definitions (FLOW-204: the editor's installed-package
     * provider source). Decoded definitions plus their provenance — the editor renders from
     * this; execution stays refused until the compiler phase lands.
     *
     * @return list<array<string,mixed>>
     */
    public function listDefinitions(string $userId): array
    {
        // REL-705: with the plane disabled, definitions go dark — the editor degrades to
        // missing-node placeholders and new version mints compile no IR. Rows stay intact.
        if (!PackagesFeature::v2Enabled()) {
            return [];
        }
        $stmt = $this->mysql->prepare('
            SELECT fnd.node_type, fnd.version, fnd.digest, fnd.definition_json, fnd.enabled,
                   fnd.installation_id, pi.package_id, pi.display_name
            FROM flow_node_definitions fnd
            JOIN package_installations pi ON pi.id = fnd.installation_id
            WHERE fnd.user_id = ?
            ORDER BY fnd.node_type ASC
        ');
        $stmt->execute([$userId]);
        $out = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $definition = json_decode((string) $row['definition_json'], true);
            if (!is_array($definition)) {
                continue; // corrupt row — never ship an unparseable definition to the editor
            }
            $out[] = [
                'type' => (string) $row['node_type'],
                'version' => (string) $row['version'],
                'digest' => (string) $row['digest'],
                'enabled' => (bool) $row['enabled'],
                'installationId' => (string) $row['installation_id'],
                'packageId' => (string) $row['package_id'],
                'packageName' => (string) $row['display_name'],
                'definition' => $definition,
            ];
        }
        return $out;
    }

    /**
     * One installation with its immutable receipt, contributed definitions, and dependency
     * edges (plan §13.1 / §14.4 "View receipt/dependencies"). MANAGEMENT surface — available
     * even while the REL-705 kill switch is off. null = missing/foreign (identical 404s).
     *
     * @return array<string,mixed>|null
     */
    public function getInstallation(string $installationId, string $userId): ?array
    {
        $stmt = $this->mysql->prepare('SELECT * FROM package_installations WHERE id = ? AND user_id = ?');
        $stmt->execute([$installationId, $userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            return null;
        }
        $defs = $this->mysql->prepare('SELECT node_type, version, digest, enabled FROM flow_node_definitions WHERE installation_id = ? ORDER BY node_type ASC');
        $defs->execute([$installationId]);
        $edges = $this->mysql->prepare('SELECT child_package_id, requested_range, resolved_version, required FROM package_dependency_edges WHERE parent_installation_id = ? ORDER BY child_package_id ASC');
        $edges->execute([$installationId]);
        // Inbound edges: what DEPENDS ON this installation. These are what block an uninstall
        // (required only) and what constrain an update's version range — the management UI
        // shows them up front instead of only after a 409/update_blocked.
        $dependents = $this->mysql->prepare('
            SELECT pi.package_id, pi.display_name, pi.version, e.requested_range, e.required
            FROM package_dependency_edges e
            JOIN package_installations pi ON pi.id = e.parent_installation_id
            WHERE e.child_installation_id = ?
            ORDER BY pi.display_name ASC
        ');
        $dependents->execute([$installationId]);
        $receipt = json_decode((string) $row['receipt_json'], true);
        return [
            'id' => (string) $row['id'],
            'packageId' => (string) $row['package_id'],
            'publisherId' => (string) $row['publisher_id'],
            'kind' => (string) $row['kind'],
            'version' => (string) $row['version'],
            'displayName' => (string) $row['display_name'],
            'state' => (string) $row['state'],
            'source' => (string) $row['source'],
            'installedAt' => (string) $row['created_at'],
            'receipt' => is_array($receipt) ? $receipt : null,
            'nodes' => array_map(static fn (array $d): array => [
                'type' => (string) $d['node_type'],
                'version' => (string) $d['version'],
                'digest' => (string) $d['digest'],
                'enabled' => (bool) $d['enabled'],
            ], $defs->fetchAll(PDO::FETCH_ASSOC)),
            'dependencies' => array_map(static fn (array $e): array => [
                'packageId' => (string) $e['child_package_id'],
                'range' => (string) $e['requested_range'],
                'resolvedVersion' => (string) $e['resolved_version'],
                'required' => (bool) $e['required'],
            ], $edges->fetchAll(PDO::FETCH_ASSOC)),
            'dependents' => array_map(static fn (array $e): array => [
                'packageId' => (string) $e['package_id'],
                'displayName' => (string) $e['display_name'],
                'version' => (string) $e['version'],
                'range' => (string) $e['requested_range'],
                'required' => (bool) $e['required'],
            ], $dependents->fetchAll(PDO::FETCH_ASSOC)),
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

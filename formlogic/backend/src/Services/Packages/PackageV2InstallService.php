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

    public function __construct(MySQLConnection $mysql)
    {
        $this->mysql = $mysql->getConnection();
    }

    /**
     * @param array<string,mixed> $aggregate The validated-or-refused v2 aggregate.
     * @param list<string> $approvedConnectorGrants SAFE-001 reviewed grant array (recorded in the receipt).
     * @return array{installationId:string,packageId:string,version:string,kind:string,displayName:string,nodeTypes:list<string>}
     */
    public function install(array $aggregate, string $userId, array $approvedConnectorGrants, string $source = 'json', string $trust = 'community'): array
    {
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
            throw new \RuntimeException('unsupported_distributions: signed service distributions need the desktop distribution pipeline, which is not enabled yet');
        }
        $contributions = [];
        foreach (($aggregate['contributions']['flowNodes'] ?? []) as $node) {
            if (is_string($node)) {
                throw new \RuntimeException('unsupported_entry_path: JSON-delivered packages must inline their flow-node definitions (archive entry paths need the archive lane)');
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

        $del = $this->mysql->prepare('DELETE FROM package_installations WHERE id = ? AND user_id = ?');
        $del->execute([$installationId, $userId]);

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

    private function uuid(): string
    {
        $b = random_bytes(16);
        $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
        $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
    }
}

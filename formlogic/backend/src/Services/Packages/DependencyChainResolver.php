<?php

declare(strict_types=1);

namespace FormLogic\Services\Packages;

use FormLogic\Database\MySQLConnection;
use FormLogic\Helpers\ApplicationPackageV2Validator;
use PDO;

/**
 * Auto-install for declared dependencies: work out everything that has to be installed, in
 * order, so that installing one package brings what it needs.
 *
 * Until now a missing required dependency was a typed refusal naming what to install first. That
 * was the honest answer while there was nowhere to fetch a dependency FROM — the resolver only
 * ever saw the owner's installed graph. Now that the marketplace catalog carries v2 aggregates,
 * there is a source, and "install these three things in this order" is an answer a person can
 * act on where "go find com.formlogic.ai-toolkit yourself" is not.
 *
 * Three things this deliberately does NOT do:
 *
 * - **It does not install anything.** It returns a plan. The dependencies get installed by the
 *   ordinary confirm step, so they go through the same grant review as the package that asked
 *   for them — a dependency carries its own connector grants and its own contributed node types,
 *   and pulling those in silently would defeat the point of reviewing an install at all.
 * - **It does not resolve optional dependencies.** An optional dependency that is absent is a
 *   choice the owner gets to make, not a gap to fill on their behalf.
 * - **It does not upgrade what is already installed.** An installed-but-incompatible dependency
 *   stays a refusal: replacing a version another package may be relying on is an update, and
 *   updates are reviewed on their own terms.
 */
class DependencyChainResolver
{
    /**
     * How deep a dependency chain may go. Deep enough for any real package graph, shallow enough
     * that a pathological one refuses quickly instead of walking the whole catalog.
     */
    public const MAX_DEPTH = 8;

    private PDO $mysql;

    public function __construct(MySQLConnection $mysql)
    {
        $this->mysql = $mysql->getConnection();
    }

    /**
     * Everything that must be installed for `$aggregate` to install, dependencies FIRST.
     *
     * @return array{
     *   ok: bool,
     *   chain: list<array{packageId:string,version:string,displayName:string,aggregate:array<string,mixed>,nodeCount:int,required:bool}>,
     *   problems: list<array{code:string,id:string,message:string}>
     * }
     */
    public function resolveChain(array $aggregate, string $userId): array
    {
        $installed = $this->installedVersions($userId);
        $chain = [];
        $problems = [];
        // Packages already in the chain, so a diamond (two packages needing the same dependency)
        // contributes it once rather than twice.
        $planned = [];
        $this->walk($aggregate, $userId, $installed, $planned, $chain, $problems, 0, []);

        return ['ok' => $problems === [], 'chain' => $chain, 'problems' => $problems];
    }

    /**
     * @param array<string,string> $installed packageId => version
     * @param array<string,true> $planned
     * @param list<array<string,mixed>> $chain
     * @param list<array<string,mixed>> $problems
     * @param list<string> $ancestry package ids currently being resolved (cycle detection)
     */
    private function walk(
        array $aggregate,
        string $userId,
        array $installed,
        array &$planned,
        array &$chain,
        array &$problems,
        int $depth,
        array $ancestry
    ): void {
        $selfId = (string) ($aggregate['package']['id'] ?? '');
        if ($depth > self::MAX_DEPTH) {
            $problems[] = [
                'code' => 'dependency_chain_too_deep',
                'id' => $selfId,
                'message' => 'the dependency chain is more than ' . self::MAX_DEPTH . ' packages deep',
            ];
            return;
        }
        if (in_array($selfId, $ancestry, true)) {
            // A cycle can never be satisfied, and following it would not terminate. Name the ring
            // rather than reporting a generic failure — it is the author's bug to fix.
            $problems[] = [
                'code' => 'dependency_cycle',
                'id' => $selfId,
                'message' => 'dependency cycle: ' . implode(' → ', array_merge($ancestry, [$selfId])),
            ];
            return;
        }

        $declared = is_array($aggregate['dependencies']['packages'] ?? null)
            ? $aggregate['dependencies']['packages']
            : [];

        foreach ($declared as $dependency) {
            if (!is_array($dependency)) {
                continue;
            }
            $id = (string) ($dependency['id'] ?? '');
            $range = (string) ($dependency['version'] ?? '');
            $optional = ($dependency['optional'] ?? false) === true;
            if ($id === '' || $range === '') {
                continue; // malformed declarations are caught by the package validator
            }

            // Already installed and compatible: nothing to plan. Already installed and NOT
            // compatible stays a refusal — see the class docblock.
            if (isset($installed[$id])) {
                if (!DependencyResolver::satisfies($installed[$id], $range)) {
                    $problems[] = [
                        'code' => 'dependency_incompatible',
                        'id' => $id,
                        'message' => sprintf(
                            '"%s" requires %s %s, but v%s is installed — update it first',
                            $selfId,
                            $id,
                            $range,
                            $installed[$id]
                        ),
                    ];
                }
                continue;
            }
            if (isset($planned[$id])) {
                continue; // another package in this chain already brings it
            }
            if ($optional) {
                // Absent optional dependencies are the owner's choice, not a gap to fill.
                continue;
            }

            $candidate = $this->findInCatalog($id, $range);
            if ($candidate === null) {
                $problems[] = [
                    'code' => 'dependency_unavailable',
                    'id' => $id,
                    'message' => sprintf(
                        '"%s" requires %s %s, which is not installed and not available in the marketplace',
                        $selfId,
                        $id,
                        $range
                    ),
                ];
                continue;
            }

            // Depth-first: the dependency's OWN dependencies are planned before it, so the chain
            // is already in install order when it comes back.
            $planned[$id] = true;
            $this->walk(
                $candidate,
                $userId,
                $installed,
                $planned,
                $chain,
                $problems,
                $depth + 1,
                array_merge($ancestry, [$selfId])
            );

            $meta = is_array($candidate['package'] ?? null) ? $candidate['package'] : [];
            $nodes = is_array($candidate['contributions']['flowNodes'] ?? null)
                ? $candidate['contributions']['flowNodes']
                : [];
            $chain[] = [
                'packageId' => $id,
                'version' => (string) ($meta['version'] ?? ''),
                'displayName' => (string) ($meta['displayName'] ?? $id),
                'aggregate' => $candidate,
                'nodeCount' => count($nodes),
                'required' => true,
            ];
        }
    }

    /** @return array<string,string> packageId => installed version */
    private function installedVersions(string $userId): array
    {
        $stmt = $this->mysql->prepare('SELECT package_id, version FROM package_installations WHERE user_id = ?');
        $stmt->execute([$userId]);
        $out = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $out[(string) $row['package_id']] = (string) $row['version'];
        }
        return $out;
    }

    /**
     * The newest catalog version of `$packageId` satisfying `$range`, or null.
     *
     * Only PUBLISHED, PUBLIC, format-2 listings are considered: a dependency is resolved on the
     * owner's behalf, so it must come from something they could have found and installed
     * themselves. Every candidate is re-validated — a listing that cannot install is not a
     * solution to anything, and finding that out here beats finding it out mid-chain.
     *
     * @return array<string,mixed>|null
     */
    private function findInCatalog(string $packageId, string $range): ?array
    {
        $stmt = $this->mysql->prepare("
            SELECT pv.pack_data
            FROM pack_versions pv
            JOIN pack_catalog pc ON pc.id = pv.catalog_id
            WHERE pv.format_version = 2
              AND pc.status = 'published'
              AND pc.visibility = 'public'
            ORDER BY pv.created_at DESC, pv.id DESC
            LIMIT 200
        ");
        $stmt->execute();
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $json) {
            $aggregate = json_decode((string) $json, true);
            if (!is_array($aggregate)) {
                continue;
            }
            $meta = is_array($aggregate['package'] ?? null) ? $aggregate['package'] : [];
            if ((string) ($meta['id'] ?? '') !== $packageId) {
                continue;
            }
            if (!DependencyResolver::satisfies((string) ($meta['version'] ?? ''), $range)) {
                continue;
            }
            if (ApplicationPackageV2Validator::validatePackage($aggregate) !== []) {
                continue;
            }
            return $aggregate; // newest first, so the first match is the best one
        }
        return null;
    }
}

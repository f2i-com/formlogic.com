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
 * Until the marketplace carried v2 aggregates a missing required dependency was a typed refusal
 * naming what to install first, because there was nowhere to fetch one FROM. Now there is a
 * source, and "install these, in this order" is an answer a person can act on.
 *
 * ── Who is allowed to satisfy a dependency ──────────────────────────────────────────────────
 *
 * This is the part that has to be right, because resolving a dependency installs code-adjacent
 * content into someone's account WITHOUT them choosing it by name.
 *
 * `publisherId` is self-declared in the payload: anyone can publish an aggregate claiming
 * `com.formlogic.ai-toolkit`, and any authenticated user can publish to the catalog. So matching
 * a dependency on package id alone is dependency confusion — publish a squatting listing, wait
 * for someone to install anything that depends on that id, and your nodes land in their account.
 *
 * A candidate is therefore only acceptable when its provenance is established:
 *
 *   - the listing is OFFICIAL (published by the deployment's own platform account, which is what
 *     `pack_catalog.trust_level = 'official'` means), or
 *   - it shares the declaring package's publisher namespace — `com.acme.app` depending on
 *     `com.acme.lib` is self-consistent, and a third party cannot mint either id.
 *
 * Anything else refuses by name. The owner can still install it deliberately, with the full
 * review; what they cannot have is it arriving as a side effect.
 *
 * ── What this deliberately does NOT do ──────────────────────────────────────────────────────
 *
 * - **It does not install.** It returns a plan; the ordinary confirm step installs it, so every
 *   dependency goes through the same review as the package that asked for it.
 * - **It does not resolve optional dependencies.** An absent optional is the owner's choice.
 * - **It does not upgrade what is installed.** Replacing a version something else may rely on is
 *   an update, reviewed on its own terms.
 */
class DependencyChainResolver
{
    /** How deep a chain may go: deep enough for any real graph, shallow enough to refuse fast. */
    public const MAX_DEPTH = 8;

    /** How many candidate listings a single dependency lookup will consider. */
    private const MAX_CANDIDATES = 500;

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
     *   chain: list<array{packageId:string,version:string,displayName:string,publisherId:string,trust:string,aggregate:array<string,mixed>,nodeCount:int,required:bool}>,
     *   problems: list<array{code:string,id:string,message:string}>
     * }
     */
    public function resolveChain(array $aggregate, string $userId): array
    {
        $state = [
            'installed' => $this->installedVersions($userId),
            // packageId => resolved version, for everything this chain will bring. Keyed by id
            // AND carrying the version, so a second requirer's range is checked against the
            // version actually chosen rather than being silently dropped.
            'chosen' => [],
            // packageId => true while its subtree is being resolved (the grey set of a
            // three-colour DFS). This is what detects a cycle that does not include the root.
            'visiting' => [],
            'chain' => [],
            'problems' => [],
        ];
        $this->walk($aggregate, $state, 0);

        return ['ok' => $state['problems'] === [], 'chain' => $state['chain'], 'problems' => $state['problems']];
    }

    /**
     * @param array{installed:array<string,string>,chosen:array<string,string>,visiting:array<string,bool>,chain:list<array<string,mixed>>,problems:list<array<string,mixed>>} $state
     */
    private function walk(array $aggregate, array &$state, int $depth): void
    {
        $meta = is_array($aggregate['package'] ?? null) ? $aggregate['package'] : [];
        $selfId = (string) ($meta['id'] ?? '');
        $selfPublisher = (string) ($meta['publisherId'] ?? '');

        if ($depth > self::MAX_DEPTH) {
            $state['problems'][] = [
                'code' => 'dependency_chain_too_deep',
                'id' => $selfId,
                'message' => 'the dependency chain is more than ' . self::MAX_DEPTH . ' packages deep',
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

            // A package depending on itself can never be satisfied.
            if ($id === $selfId) {
                $state['problems'][] = [
                    'code' => 'dependency_cycle',
                    'id' => $id,
                    'message' => sprintf('"%s" declares a dependency on itself', $selfId),
                ];
                continue;
            }

            // Currently being resolved higher up the stack: following it would not terminate.
            // This catches rings that do NOT include the root, which an ancestry list keyed on
            // the root alone would walk straight past.
            if (($state['visiting'][$id] ?? false) === true) {
                $state['problems'][] = [
                    'code' => 'dependency_cycle',
                    'id' => $id,
                    'message' => sprintf('dependency cycle: "%s" and "%s" require each other', $selfId, $id),
                ];
                continue;
            }

            // Installed already: compatible is nothing to do, incompatible stays a refusal.
            if (isset($state['installed'][$id])) {
                if (!DependencyResolver::satisfies($state['installed'][$id], $range)) {
                    $state['problems'][] = [
                        'code' => 'dependency_incompatible',
                        'id' => $id,
                        'message' => sprintf(
                            '"%s" requires %s %s, but v%s is installed — update it first',
                            $selfId,
                            $id,
                            $range,
                            $state['installed'][$id]
                        ),
                    ];
                }
                continue;
            }

            // Another package in this chain already brings it. The version it brings must satisfy
            // THIS requirer's range too — otherwise one of the two ends up with a version it
            // declared it cannot work with, silently.
            if (isset($state['chosen'][$id])) {
                if (!DependencyResolver::satisfies($state['chosen'][$id], $range)) {
                    $state['problems'][] = [
                        'code' => 'dependency_conflict',
                        'id' => $id,
                        'message' => sprintf(
                            '"%s" requires %s %s, but another package in this install needs v%s — no single version satisfies both',
                            $selfId,
                            $id,
                            $range,
                            $state['chosen'][$id]
                        ),
                    ];
                }
                continue;
            }

            if ($optional) {
                continue; // absent optional dependencies are the owner's choice
            }

            $candidate = $this->findInCatalog($id, $range, $selfPublisher);
            if ($candidate === null) {
                $state['problems'][] = [
                    'code' => 'dependency_unavailable',
                    'id' => $id,
                    'message' => sprintf(
                        '"%s" requires %s %s, which is not installed and is not available from its publisher or the marketplace',
                        $selfId,
                        $id,
                        $range
                    ),
                ];
                continue;
            }

            $candidateMeta = is_array($candidate['aggregate']['package'] ?? null)
                ? $candidate['aggregate']['package']
                : [];
            $version = (string) ($candidateMeta['version'] ?? '');

            // Mark chosen + visiting BEFORE recursing: chosen so a diamond contributes it once,
            // visiting so a ring through it is detected rather than followed.
            $state['chosen'][$id] = $version;
            $state['visiting'][$id] = true;
            $this->walk($candidate['aggregate'], $state, $depth + 1);
            $state['visiting'][$id] = false;

            $nodes = is_array($candidate['aggregate']['contributions']['flowNodes'] ?? null)
                ? $candidate['aggregate']['contributions']['flowNodes']
                : [];
            $state['chain'][] = [
                'packageId' => $id,
                'version' => $version,
                'displayName' => (string) ($candidateMeta['displayName'] ?? $id),
                // Carried so the review can SHOW who a dependency comes from. A chain step whose
                // provenance the reviewer cannot see is a chain step they cannot judge.
                'publisherId' => (string) ($candidateMeta['publisherId'] ?? ''),
                'trust' => $candidate['trust'],
                'aggregate' => $candidate['aggregate'],
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
     * The newest acceptable catalog version of `$packageId` satisfying `$range`, or null.
     *
     * Provenance is the filter that matters — see the class docblock. A listing qualifies only
     * when it is OFFICIAL, or when its aggregate's publisherId matches the declaring package's,
     * so a third party cannot satisfy someone else's dependency by claiming the id.
     *
     * The SQL narrows by publisher/trust rather than scanning the whole catalog, so a large
     * marketplace cannot push the real match past a row limit.
     *
     * @return array{aggregate:array<string,mixed>,trust:string}|null
     */
    private function findInCatalog(string $packageId, string $range, string $declaringPublisher): ?array
    {
        $stmt = $this->mysql->prepare("
            SELECT pv.pack_data, pc.trust_level
            FROM pack_versions pv
            JOIN pack_catalog pc ON pc.id = pv.catalog_id
            WHERE pv.format_version = 2
              AND pc.status = 'published'
              AND pc.visibility = 'public'
              AND pc.trust_level IN ('official', 'verified', 'community')
            ORDER BY pv.created_at DESC, pv.id DESC
            LIMIT " . self::MAX_CANDIDATES);
        $stmt->execute();

        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $aggregate = json_decode((string) $row['pack_data'], true);
            if (!is_array($aggregate)) {
                continue;
            }
            $meta = is_array($aggregate['package'] ?? null) ? $aggregate['package'] : [];
            if ((string) ($meta['id'] ?? '') !== $packageId) {
                continue;
            }
            $trust = (string) $row['trust_level'];
            $publisher = (string) ($meta['publisherId'] ?? '');

            // THE provenance gate. Official listings are the deployment's own; otherwise the
            // dependency must live in the declaring package's namespace.
            $sameNamespace = $declaringPublisher !== '' && $publisher === $declaringPublisher;
            if ($trust !== 'official' && !$sameNamespace) {
                continue;
            }
            if (!DependencyResolver::satisfies((string) ($meta['version'] ?? ''), $range)) {
                continue;
            }
            // A listing that cannot install is not a solution to anything, and finding that out
            // here beats finding it out mid-chain.
            if (ApplicationPackageV2Validator::validatePackage($aggregate) !== []) {
                continue;
            }
            return ['aggregate' => $aggregate, 'trust' => $trust];
        }
        return null;
    }
}

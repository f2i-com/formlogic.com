<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Helpers\ApplicationPackageV2Validator;
use FormLogic\Services\Flows\FlowCompiler;
use FormLogic\Services\Packages\DependencyResolver;
use PHPUnit\Framework\TestCase;

/**
 * PERF-703: budgets for the hot paths this initiative added, protected by representative tests.
 *
 * These run on EVERY request that installs a package or mints a flow revision, and each grew
 * organically — the validator walks every contributed definition, the compiler walks every
 * node, the resolver walks every declared dependency. A quadratic slip in any of them would
 * not fail a test, it would just make installs and saves gradually worse until someone
 * noticed. A budget turns that into a failing test on the commit that causes it.
 *
 * The budgets are deliberately LOOSE — several times the observed cost on a slow dev machine —
 * because the purpose is to catch a change in COMPLEXITY, not to police normal variance. A
 * test that fails when a laptop is busy teaches people to ignore it.
 */
class PackagePerformanceTest extends TestCase
{
    /** Contributed node definitions in one package (the v2 schema caps flowNodes at 64). */
    private const MAX_CONTRIBUTIONS = 64;
    /** Nodes in a large authored flow. */
    private const LARGE_GRAPH_NODES = 500;

    // Budgets (milliseconds). Generous multiples of observed cost; complexity guards, not stopwatches.
    private const BUDGET_VALIDATE_MAX_PACKAGE_MS = 1500;
    private const BUDGET_COMPILE_LARGE_GRAPH_MS = 1500;
    private const BUDGET_RESOLVE_DEPENDENCIES_MS = 500;

    private function elapsedMs(callable $fn): float
    {
        $start = microtime(true);
        $fn();
        return (microtime(true) - $start) * 1000;
    }

    private function definition(int $i): array
    {
        return [
            'schemaVersion' => 1,
            'type' => "com.acme.perf.node{$i}",
            'version' => '1.0.0',
            'display' => ['label' => "Node {$i}", 'description' => str_repeat('d', 120)],
            'configurationSchema' => [
                'type' => 'object',
                'properties' => [
                    'a' => ['type' => 'string', 'maxLength' => 200],
                    'b' => ['type' => 'integer', 'minimum' => 0],
                    'c' => ['type' => 'string', 'enum' => ['x', 'y', 'z']],
                ],
                'required' => ['a'],
            ],
            'ports' => [
                ['id' => 'in1', 'direction' => 'input', 'kind' => 'data', 'schema' => ['type' => 'string']],
                ['id' => 'out1', 'direction' => 'output', 'kind' => 'data', 'schema' => ['type' => 'string']],
            ],
            'handler' => ['kind' => 'core-preset', 'coreType' => 'template', 'defaults' => ['template' => 'hi']],
            'sideEffects' => 'none',
        ];
    }

    public function testValidatingAMaximumSizePackageStaysWithinBudget(): void
    {
        $aggregate = [
            'formatVersion' => 2,
            'package' => ['id' => 'com.acme.perf', 'kind' => 'extension', 'version' => '1.0.0', 'publisherId' => 'com.acme', 'displayName' => 'Perf'],
            'contributions' => ['flowNodes' => array_map(fn (int $i): array => $this->definition($i), range(1, self::MAX_CONTRIBUTIONS))],
        ];

        $issues = null;
        $ms = $this->elapsedMs(function () use ($aggregate, &$issues): void {
            $issues = ApplicationPackageV2Validator::validatePackage($aggregate);
        });

        $this->assertSame([], $issues, 'the fixture is a VALID max-size package');
        $this->assertLessThan(
            self::BUDGET_VALIDATE_MAX_PACKAGE_MS,
            $ms,
            sprintf('validating %d contributions took %.0fms (budget %dms) — check for a complexity regression', self::MAX_CONTRIBUTIONS, $ms, self::BUDGET_VALIDATE_MAX_PACKAGE_MS)
        );
    }

    public function testCompilingALargeGraphStaysWithinBudget(): void
    {
        // Half core, half contributed: the compiler does its most work per contributed node.
        $installed = [];
        $nodes = [];
        $edges = [];
        for ($i = 0; $i < self::LARGE_GRAPH_NODES; $i++) {
            if ($i % 2 === 0) {
                $nodes[] = ['id' => "n{$i}", 'type' => 'template', 'data' => ['template' => 'x']];
            } else {
                $type = "com.acme.perf.node{$i}";
                $installed[$type] = [
                    'definition' => $this->definition($i),
                    'digest' => str_repeat('ab', 32),
                    'version' => '1.0.0',
                    'packageId' => 'com.acme.perf',
                    'installationId' => 'inst-1',
                ];
                $installed[$type]['definition']['type'] = $type;
                $nodes[] = ['id' => "n{$i}", 'type' => $type, 'data' => ['a' => 'set']];
            }
            if ($i > 0) {
                $edges[] = ['id' => "e{$i}", 'source' => 'n' . ($i - 1), 'target' => "n{$i}"];
            }
        }

        $result = null;
        $ms = $this->elapsedMs(function () use ($nodes, $edges, $installed, &$result): void {
            $result = FlowCompiler::compile(['nodes' => $nodes, 'edges' => $edges], $installed);
        });

        $this->assertTrue($result['ok'], 'the large graph compiles: ' . json_encode(array_slice($result['diagnostics'], 0, 2)));
        $this->assertCount(self::LARGE_GRAPH_NODES, $result['ir']['nodes']);
        $this->assertLessThan(
            self::BUDGET_COMPILE_LARGE_GRAPH_MS,
            $ms,
            sprintf('compiling %d nodes took %.0fms (budget %dms)', self::LARGE_GRAPH_NODES, $ms, self::BUDGET_COMPILE_LARGE_GRAPH_MS)
        );
    }

    public function testCompilationIsLinearInGraphSize(): void
    {
        // The shape test the budget cannot express: doubling the graph must not quadruple the
        // work. Catches an accidental nested scan over nodes far more reliably than wall time.
        $build = static function (int $count): array {
            $nodes = [];
            for ($i = 0; $i < $count; $i++) {
                $nodes[] = ['id' => "n{$i}", 'type' => 'template', 'data' => ['template' => 'x']];
            }
            return ['nodes' => $nodes, 'edges' => []];
        };
        $small = $build(400);
        $large = $build(1600); // 4x the nodes

        // Warm any first-call cost so it is not attributed to the small run.
        FlowCompiler::compile($small, []);

        $smallMs = max(0.5, $this->elapsedMs(static fn () => FlowCompiler::compile($small, [])));
        $largeMs = $this->elapsedMs(static fn () => FlowCompiler::compile($large, []));

        // Linear would be ~4x. Allow a generous 12x before calling it a complexity change;
        // quadratic would be ~16x and climbing.
        $this->assertLessThan(
            $smallMs * 12,
            $largeMs,
            sprintf('4x the nodes cost %.1fx the time (%.1fms → %.1fms) — compilation may no longer be linear', $largeMs / $smallMs, $smallMs, $largeMs)
        );
    }

    public function testResolvingManyDependenciesStaysWithinBudget(): void
    {
        $declared = [];
        $installed = [];
        for ($i = 0; $i < 200; $i++) {
            $declared[] = ['id' => "com.acme.dep{$i}", 'version' => '^1.0.0'];
            $installed["com.acme.dep{$i}"] = ['version' => '1.4.0', 'installationId' => "inst-{$i}"];
        }

        $report = null;
        $ms = $this->elapsedMs(function () use ($declared, $installed, &$report): void {
            $report = DependencyResolver::resolve($declared, $installed, 'com.acme.root');
        });

        $this->assertTrue($report['ok']);
        $this->assertCount(200, $report['resolved']);
        $this->assertLessThan(
            self::BUDGET_RESOLVE_DEPENDENCIES_MS,
            $ms,
            sprintf('resolving 200 dependencies took %.0fms (budget %dms)', $ms, self::BUDGET_RESOLVE_DEPENDENCIES_MS)
        );
    }
}

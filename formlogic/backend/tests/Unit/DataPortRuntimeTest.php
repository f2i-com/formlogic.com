<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\Flows\DataPortRuntime;
use PHPUnit\Framework\TestCase;

/**
 * RUN-302/RUN-303 conformance: the PHP leg asserts the SHARED corpus that the TypeScript
 * resolver asserts (ui/src/client-runtime/flows/dataPorts.test.ts). If the two implementations
 * ever diverge, one of these suites fails — which is why the cases live in docs/contracts
 * rather than in either language's tests.
 */
class DataPortRuntimeTest extends TestCase
{
    /** @return array<string,array{0:array<string,mixed>}> */
    public static function corpusProvider(): array
    {
        $path = dirname(__DIR__, 4) . '/docs/contracts/fixtures/flow-data-port-cases.json';
        $corpus = json_decode((string) file_get_contents($path), true);
        $out = [];
        foreach ($corpus['cases'] as $case) {
            $out[$case['name']] = [$case];
        }
        return $out;
    }

    /**
     * @dataProvider corpusProvider
     * @param array<string,mixed> $case
     */
    public function testSharedCorpusCase(array $case): void
    {
        $result = DataPortRuntime::readiness($case['plan'], $case['outcomes'], $case['node']);
        $expected = $case['expect'];

        $this->assertSame($expected['verdict'], $result['verdict'], $case['why']);

        if (array_key_exists('inputs', $expected)) {
            // assertEquals, not assertSame: JSON objects decode to arrays and key order is not
            // part of the contract — the VALUES are.
            $this->assertEquals($expected['inputs'], $result['inputs'], $case['name'] . ': resolved inputs');
        }
        if (array_key_exists('artifactInputs', $expected)) {
            $this->assertSame($expected['artifactInputs'], $result['artifactInputs']);
        }
        if (array_key_exists('waitingOn', $expected)) {
            $this->assertSame($expected['waitingOn'], $result['waitingOn']);
        }
        if (array_key_exists('unsatisfied', $expected)) {
            $this->assertSame($expected['unsatisfied'], $result['unsatisfied']);
        }
        if (array_key_exists('reason', $expected)) {
            $this->assertSame($expected['reason'], $result['reason']);
        }
    }

    public function testTheCorpusIsNotEmpty(): void
    {
        // A corpus that silently fails to load would make every conformance test vacuous.
        $this->assertGreaterThan(10, count(self::corpusProvider()));
    }

    public function testPlanFromReadsOnlyCompleteDataEdges(): void
    {
        $plan = DataPortRuntime::planFrom(['edges' => [
            ['kind' => 'control', 'source' => 'a', 'target' => 'b', 'sourceHandle' => 'out', 'targetHandle' => 'in'],
            ['kind' => 'data', 'source' => 'a', 'target' => 'b', 'sourceHandle' => 'out', 'targetHandle' => 'text'],
            ['kind' => 'data', 'source' => 'a', 'target' => 'c', 'sourceHandle' => 'out'],
        ]]);
        $this->assertSame(['b' => ['text' => ['node' => 'a', 'port' => 'out']]], $plan);
    }

    public function testPlanFromIsDeterministicOnCorruptDoubleWiring(): void
    {
        // Ambiguous fan-in is refused at compile; if one reaches here anyway, every runtime must
        // pick the same producer rather than depending on iteration order.
        $plan = DataPortRuntime::planFrom(['edges' => [
            ['kind' => 'data', 'source' => 'first', 'target' => 'z', 'sourceHandle' => 'out', 'targetHandle' => 'in'],
            ['kind' => 'data', 'source' => 'second', 'target' => 'z', 'sourceHandle' => 'out', 'targetHandle' => 'in'],
        ]]);
        $this->assertSame(['z' => ['in' => ['node' => 'first', 'port' => 'out']]], $plan);
    }

    public function testLegacyGraphsProduceAnEmptyPlan(): void
    {
        $this->assertSame([], DataPortRuntime::planFrom(['edges' => [['source' => 'a', 'target' => 'b']]]));
        $this->assertSame([], DataPortRuntime::planFrom([]));
    }
}

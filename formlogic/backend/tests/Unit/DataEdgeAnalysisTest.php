<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\Flows\DataEdgeAnalysis;
use FormLogic\Services\Flows\FlowCompiler;
use PHPUnit\Framework\TestCase;

/**
 * FLOW-206: every failure here is decidable without running anything, and each produces a bad
 * run if it is left to a runtime — a flow that waits forever, or one whose result depends on
 * which value arrived last. Deciding them at compile time puts the problem in the editor.
 */
class DataEdgeAnalysisTest extends TestCase
{
    /** A contributed definition with one REQUIRED data input and one data output. */
    private function installed(string $type = 'com.acme.tools.transform'): array
    {
        return [$type => [
            'definition' => [
                'schemaVersion' => 1,
                'type' => $type,
                'version' => '1.0.0',
                'display' => ['label' => 'Transform'],
                'ports' => [
                    ['id' => 'value', 'direction' => 'input', 'kind' => 'data', 'required' => true, 'schema' => ['type' => 'string']],
                    ['id' => 'result', 'direction' => 'output', 'kind' => 'data', 'schema' => ['type' => 'string']],
                ],
                'handler' => ['kind' => 'core-preset', 'coreType' => 'template', 'defaults' => ['template' => 'x']],
                'sideEffects' => 'none',
            ],
            'digest' => str_repeat('ab', 32),
            'version' => '1.0.0',
            'packageId' => 'com.acme.tools',
            'installationId' => 'inst-1',
        ]];
    }

    /** @return list<string> the diagnostic codes */
    private function codes(array $diagnostics): array
    {
        return array_map(static fn (array $d): string => $d['code'], $diagnostics);
    }

    public function testControlOnlyGraphsAreUntouched(): void
    {
        // Legacy/v2 graphs have no data edges — the analysis must have nothing to say about
        // them, or every existing flow would start reporting problems it does not have.
        $graph = [
            'nodes' => [['id' => 'a', 'type' => 'input', 'data' => []], ['id' => 'b', 'type' => 'template', 'data' => []]],
            'edges' => [['id' => 'e1', 'source' => 'a', 'target' => 'b']],
        ];
        $this->assertSame([], DataEdgeAnalysis::analyse($graph, []));
    }

    public function testARequiredInputWithNoProducerIsRefused(): void
    {
        $graph = [
            'nodes' => [
                ['id' => 'a', 'type' => 'input', 'data' => []],
                ['id' => 't', 'type' => 'com.acme.tools.transform', 'data' => []],
            ],
            // A CONTROL edge reaches the node, but nothing produces its required input.
            'edges' => [['id' => 'e1', 'source' => 'a', 'target' => 't', 'kind' => 'data', 'targetHandle' => 'other']],
        ];
        $diagnostics = DataEdgeAnalysis::analyse($graph, $this->installed());
        $this->assertContains('data_input_unsatisfied', $this->codes($diagnostics));

        // An inline configured value satisfies it just as a producer would.
        $graph['nodes'][1]['data'] = ['value' => 'literal'];
        $this->assertNotContains('data_input_unsatisfied', $this->codes(DataEdgeAnalysis::analyse($graph, $this->installed())));
    }

    public function testTwoProducersOnOneInputAreRefusedAsAmbiguous(): void
    {
        $graph = [
            'nodes' => [
                ['id' => 'p1', 'type' => 'template', 'data' => []],
                ['id' => 'p2', 'type' => 'template', 'data' => []],
                ['id' => 't', 'type' => 'com.acme.tools.transform', 'data' => []],
            ],
            'edges' => [
                ['id' => 'e1', 'source' => 'p1', 'target' => 't', 'kind' => 'data', 'sourceHandle' => 'out', 'targetHandle' => 'value'],
                ['id' => 'e2', 'source' => 'p2', 'target' => 't', 'kind' => 'data', 'sourceHandle' => 'out', 'targetHandle' => 'value'],
            ],
        ];
        $diagnostics = DataEdgeAnalysis::analyse($graph, $this->installed());
        $this->assertContains('data_fan_in_ambiguous', $this->codes($diagnostics));
        // The message names both producers — otherwise the author has to hunt for them.
        $fanIn = array_values(array_filter($diagnostics, static fn (array $d): bool => $d['code'] === 'data_fan_in_ambiguous'))[0];
        $this->assertStringContainsString('p1', $fanIn['message']);
        $this->assertStringContainsString('p2', $fanIn['message']);
    }

    public function testADataCycleIsRefusedAsADeadlock(): void
    {
        $graph = [
            'nodes' => [
                ['id' => 'a', 'type' => 'template', 'data' => []],
                ['id' => 'b', 'type' => 'template', 'data' => []],
                ['id' => 'c', 'type' => 'template', 'data' => []],
            ],
            'edges' => [
                ['id' => 'e1', 'source' => 'a', 'target' => 'b', 'kind' => 'data', 'targetHandle' => 'in'],
                ['id' => 'e2', 'source' => 'b', 'target' => 'c', 'kind' => 'data', 'targetHandle' => 'in'],
                ['id' => 'e3', 'source' => 'c', 'target' => 'a', 'kind' => 'data', 'targetHandle' => 'in'],
            ],
        ];
        $diagnostics = DataEdgeAnalysis::analyse($graph, []);
        $this->assertContains('data_cycle', $this->codes($diagnostics));
        $cycle = array_values(array_filter($diagnostics, static fn (array $d): bool => $d['code'] === 'data_cycle'))[0];
        // The ring is spelled out; "there is a cycle somewhere" is not actionable.
        foreach (['a', 'b', 'c'] as $node) {
            $this->assertStringContainsString($node, $cycle['message']);
        }
        // One report per graph, not one per rotation of the same ring.
        $this->assertCount(1, array_filter($diagnostics, static fn (array $d): bool => $d['code'] === 'data_cycle'));
    }

    public function testADiamondIsNotACycle(): void
    {
        // a → b → d and a → c → d: converging, not circular. A naive visited-check would
        // report this, and it is a perfectly ordinary shape.
        $graph = [
            'nodes' => array_map(static fn (string $id): array => ['id' => $id, 'type' => 'template', 'data' => []], ['a', 'b', 'c', 'd']),
            'edges' => [
                ['id' => 'e1', 'source' => 'a', 'target' => 'b', 'kind' => 'data', 'targetHandle' => 'in'],
                ['id' => 'e2', 'source' => 'a', 'target' => 'c', 'kind' => 'data', 'targetHandle' => 'in'],
                ['id' => 'e3', 'source' => 'b', 'target' => 'd', 'kind' => 'data', 'targetHandle' => 'left'],
                ['id' => 'e4', 'source' => 'c', 'target' => 'd', 'kind' => 'data', 'targetHandle' => 'right'],
            ],
        ];
        $this->assertSame([], $this->codes(DataEdgeAnalysis::analyse($graph, [])));
    }

    public function testTheCompilerBlocksOnADataDefect(): void
    {
        $graph = [
            'nodes' => [
                ['id' => 'a', 'type' => 'template', 'data' => ['template' => 'x']],
                ['id' => 'b', 'type' => 'template', 'data' => ['template' => 'y']],
            ],
            'edges' => [
                ['id' => 'e1', 'source' => 'a', 'target' => 'b', 'kind' => 'data', 'targetHandle' => 'in'],
                ['id' => 'e2', 'source' => 'b', 'target' => 'a', 'kind' => 'data', 'targetHandle' => 'in'],
            ],
        ];
        $result = FlowCompiler::compile($graph, []);
        $this->assertFalse($result['ok'], 'a deadlocked graph must not produce IR');
        $this->assertContains('data_cycle', $this->codes($result['diagnostics']));
        $this->assertNull($result['ir']);
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\Flows\FlowCompiler;
use PHPUnit\Framework\TestCase;

/**
 * RUN-301 first slice: deterministic server-side lowering — core nodes pass through
 * verbatim, core-preset contributions lower with defaults merged UNDER node data,
 * service-action contributions fail closed at compile (binding_unresolved), and every
 * lowered node carries a definition lock. Same input → byte-identical IR digest.
 */
class FlowCompilerTest extends TestCase
{
    /** @return array<string,array{definition:array<string,mixed>,digest:string,version:string,packageId:string}> */
    private function installed(): array
    {
        return [
            'com.acme.flow.notify-team' => [
                'definition' => [
                    'schemaVersion' => 1,
                    'type' => 'com.acme.flow.notify-team',
                    'version' => '1.0.0',
                    'display' => ['label' => 'Notify team'],
                    'configurationSchema' => [
                        'type' => 'object',
                        'properties' => ['channel' => ['type' => 'string'], 'note' => ['type' => 'string']],
                        'required' => ['channel'],
                    ],
                    'handler' => ['kind' => 'core-preset', 'coreType' => 'condition', 'defaults' => ['channel' => 'general', 'note' => 'preset']],
                    'sideEffects' => 'none',
                ],
                'digest' => str_repeat('ab', 32),
                'version' => '1.0.0',
                'packageId' => 'com.acme.flow-tools',
            ],
            'com.acme.media.generate-image' => [
                'definition' => [
                    'schemaVersion' => 1,
                    'type' => 'com.acme.media.generate-image',
                    'version' => '1.2.0',
                    'display' => ['label' => 'Generate image'],
                    'handler' => ['kind' => 'service-action', 'bindingSlot' => 'imageGenerator', 'requiredAction' => 'generate-image'],
                    'sideEffects' => 'external-write',
                ],
                'digest' => str_repeat('cd', 32),
                'version' => '1.2.0',
                'packageId' => 'com.acme.media-tools',
            ],
        ];
    }

    public function testCoreOnlyGraphPassesThroughWithDeterministicDigest(): void
    {
        $graph = [
            'nodes' => [
                ['id' => 'n1', 'type' => 'input', 'data' => ['event' => 'form.submitted'], 'position' => ['x' => 0, 'y' => 0]],
                ['id' => 'n2', 'type' => 'condition', 'data' => ['expr' => 'true'], 'position' => ['x' => 200, 'y' => 0]],
            ],
            'edges' => [['id' => 'e1', 'source' => 'n1', 'target' => 'n2']],
        ];
        $a = FlowCompiler::compile($graph, []);
        $b = FlowCompiler::compile($graph, $this->installed());
        $this->assertTrue($a['ok']);
        $this->assertSame($graph['nodes'], $a['ir']['nodes'], 'core nodes are the canonical set — verbatim');
        $this->assertSame([], $a['locks']);
        $this->assertSame($a['irDigest'], $b['irDigest'], 'unrelated installed definitions never perturb the digest');
        $this->assertNotNull($a['irDigest']);
    }

    public function testCorePresetLowersWithNodeDataWinningOverDefaults(): void
    {
        $graph = [
            'nodes' => [
                ['id' => 'n1', 'type' => 'com.acme.flow.notify-team', 'data' => ['note' => 'authored'], 'position' => ['x' => 0, 'y' => 0]],
            ],
            'edges' => [],
        ];
        $result = FlowCompiler::compile($graph, $this->installed());
        $this->assertTrue($result['ok'], json_encode($result['diagnostics']));
        $node = $result['ir']['nodes'][0];
        $this->assertSame('condition', $node['type'], 'lowered to the preset core type');
        $this->assertSame(['channel' => 'general', 'note' => 'authored'], $node['data'], 'defaults merge UNDER the node data');
        $this->assertSame('n1', $node['id'], 'identity and position survive lowering');
        $this->assertEquals([
            [
                'nodeId' => 'n1',
                'type' => 'com.acme.flow.notify-team',
                'packageId' => 'com.acme.flow-tools',
                'definitionVersion' => '1.0.0',
                'definitionDigest' => str_repeat('ab', 32),
                'handlerKind' => 'core-preset',
                'loweredTo' => 'condition',
            ],
        ], $result['locks']);
    }

    public function testMissingDefinitionBlocksCompilation(): void
    {
        $graph = ['nodes' => [['id' => 'n1', 'type' => 'com.gone.pkg.node', 'data' => []]], 'edges' => []];
        $result = FlowCompiler::compile($graph, $this->installed());
        $this->assertFalse($result['ok']);
        $this->assertNull($result['ir']);
        $this->assertNull($result['irDigest']);
        $this->assertSame('missing_definition', $result['diagnostics'][0]['code']);
        $this->assertSame('n1', $result['diagnostics'][0]['nodeId']);
    }

    public function testServiceActionFailsClosedAtCompile(): void
    {
        $graph = ['nodes' => [['id' => 'n1', 'type' => 'com.acme.media.generate-image', 'data' => ['prompt' => 'x']]], 'edges' => []];
        $result = FlowCompiler::compile($graph, $this->installed());
        $this->assertFalse($result['ok']);
        $this->assertSame('binding_unresolved', $result['diagnostics'][0]['code']);
        $this->assertStringContainsString('service bindings are not available yet', $result['diagnostics'][0]['message']);
    }

    public function testMissingRequiredConfigBlocksAfterDefaultsMerge(): void
    {
        $installed = $this->installed();
        // Drop the default that satisfied the required 'channel' key.
        unset($installed['com.acme.flow.notify-team']['definition']['handler']['defaults']['channel']);
        $graph = ['nodes' => [['id' => 'n1', 'type' => 'com.acme.flow.notify-team', 'data' => []]], 'edges' => []];
        $result = FlowCompiler::compile($graph, $installed);
        $this->assertFalse($result['ok']);
        $this->assertSame('missing_config', $result['diagnostics'][0]['code']);
        $this->assertStringContainsString('channel', $result['diagnostics'][0]['message']);

        // Authoring the value directly satisfies the requirement.
        $graph['nodes'][0]['data'] = ['channel' => 'ops'];
        $this->assertTrue(FlowCompiler::compile($graph, $installed)['ok']);
    }

    public function testUnknownHandlerKindIsRefusedDefensively(): void
    {
        $installed = $this->installed();
        $installed['com.acme.flow.notify-team']['definition']['handler'] = ['kind' => 'quickjs'];
        $graph = ['nodes' => [['id' => 'n1', 'type' => 'com.acme.flow.notify-team', 'data' => []]], 'edges' => []];
        $result = FlowCompiler::compile($graph, $installed);
        $this->assertFalse($result['ok']);
        $this->assertSame('handler_not_supported', $result['diagnostics'][0]['code']);
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\CloudFlowRunner;
use FormLogic\Services\Flows\FlowCompiler;
use FormLogic\Services\Flows\RuntimeSupport;
use PHPUnit\Framework\TestCase;

/**
 * RUN-304: availability is derived from what a node LOWERS TO, by the host, from the actual
 * handler sets — never from anything a package declares about itself.
 *
 * The behaviour worth protecting: a contributed node whose preset lowers to a type Cloud has
 * no handler for is a perfectly valid flow that simply cannot run on Cloud, and the author
 * should learn that while building rather than from a refused run.
 */
class RuntimeSupportTest extends TestCase
{
    public function testSurfacesAreReadFromTheRealHandlerSets(): void
    {
        // 'template' runs everywhere; 'condition' has no cloud handler; 'storage_get' is
        // client-only; an unknown type belongs to no surface at all.
        $this->assertSame(['cloud', 'browser', 'desktop'], RuntimeSupport::surfacesFor('template'));
        $this->assertSame(['browser', 'desktop'], RuntimeSupport::surfacesFor('condition'));
        $this->assertSame(['browser', 'desktop'], RuntimeSupport::surfacesFor('storage_get'));
        $this->assertSame([], RuntimeSupport::surfacesFor('com.acme.not.a.core.type'));

        $this->assertTrue(RuntimeSupport::supports('cloud', 'llm_chat'));
        $this->assertFalse(RuntimeSupport::supports('cloud', 'condition'));
    }

    public function testCloudSurfaceTracksCloudFlowRunnerExactly(): void
    {
        // Drift between this matrix and the runner would make the editor promise a surface
        // the runner refuses, so the matrix READS the runner rather than copying it.
        foreach (CloudFlowRunner::SUPPORTED_TYPES as $type) {
            $this->assertTrue(
                RuntimeSupport::supports('cloud', $type),
                "cloud runner executes {$type} but the matrix does not list it"
            );
        }
    }

    /** @param array<string,mixed> $handler */
    private function installed(string $type, array $handler): array
    {
        return [$type => [
            'definition' => [
                'schemaVersion' => 1, 'type' => $type, 'version' => '1.0.0',
                'display' => ['label' => $type], 'handler' => $handler, 'sideEffects' => 'none',
            ],
            'digest' => str_repeat('ab', 32),
            'version' => '1.0.0',
            'packageId' => 'com.acme.tools',
            'installationId' => 'inst-1',
        ]];
    }

    public function testCompileReportsWhichSurfacesCanRunTheFlow(): void
    {
        $graph = ['nodes' => [
            ['id' => 'n1', 'type' => 'input', 'data' => []],
            ['id' => 'n2', 'type' => 'template', 'data' => ['template' => 'hi']],
        ], 'edges' => []];
        $result = FlowCompiler::compile($graph, []);

        $this->assertTrue($result['ok']);
        $this->assertSame(['cloud', 'browser', 'desktop'], $result['availability']['surfaces']);
        $this->assertSame([], $result['availability']['unsupported']);
    }

    public function testAContributedNodeCannotClaimASurfaceItsLoweringCannotReach(): void
    {
        // The definition asks for everything; what decides is that it lowers to 'condition',
        // which Cloud has no handler for.
        $installed = $this->installed('com.acme.tools.branch', [
            'kind' => 'core-preset', 'coreType' => 'condition', 'defaults' => ['expr' => 'true'],
        ]);
        $installed['com.acme.tools.branch']['definition']['availability'] = ['cloud', 'browser', 'desktop'];

        $graph = ['nodes' => [
            ['id' => 'n1', 'type' => 'input', 'data' => []],
            ['id' => 'n2', 'type' => 'com.acme.tools.branch', 'data' => []],
        ], 'edges' => []];
        $result = FlowCompiler::compile($graph, $installed);

        $this->assertTrue($result['ok'], 'the flow is valid — it just cannot run everywhere');
        $this->assertSame(['browser', 'desktop'], $result['availability']['surfaces']);
        $this->assertSame(['n2'], $result['availability']['unsupported']['cloud']);

        // The author is TOLD, without being blocked.
        $info = array_values(array_filter($result['diagnostics'], static fn (array $d): bool => $d['code'] === 'surface_unsupported'));
        $this->assertCount(1, $info);
        $this->assertSame('info', $info[0]['severity']);
        $this->assertStringContainsString('cloud', $info[0]['message']);
    }

    public function testAFailedCompileClaimsNoSurfaces(): void
    {
        $graph = ['nodes' => [['id' => 'n1', 'type' => 'com.gone.pkg.node', 'data' => []]], 'edges' => []];
        $result = FlowCompiler::compile($graph, []);
        $this->assertFalse($result['ok']);
        $this->assertSame([], $result['availability']['surfaces'], 'a flow that does not compile runs nowhere');
    }
}

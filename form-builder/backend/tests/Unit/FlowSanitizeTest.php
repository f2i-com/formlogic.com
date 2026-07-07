<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\FlowService;
use PHPUnit\Framework\TestCase;

/**
 * FlowService's STATIC sanitizers enforce the flow-binding.schema.json caps server-side (slug
 * pattern, graph shape + 256KB cap, event pattern, mode enum, outputAction whitelist, timeout
 * bounds, 16KB per-column caps). Pure — no DB. The same helpers gate the pack import path.
 */
class FlowSanitizeTest extends TestCase
{
    // ── Slug ─────────────────────────────────────────────────────────────────────────────────

    public function testValidSlugPasses(): void
    {
        $this->assertSame('call-triage', FlowService::sanitizeSlug('call-triage'));
        $this->assertSame('a1', FlowService::sanitizeSlug('a1'));
    }

    /** @dataProvider badSlugs */
    public function testBadSlugRejected(mixed $slug): void
    {
        $this->expectException(\InvalidArgumentException::class);
        FlowService::sanitizeSlug($slug);
    }

    public static function badSlugs(): array
    {
        return [
            'uppercase' => ['Call-Triage'],
            'starts with digit' => ['1flow'],
            'starts with hyphen' => ['-flow'],
            'single char' => ['a'],
            'underscore' => ['my_flow'],
            'too long (129)' => ['a' . str_repeat('b', 128)],
            'empty' => [''],
            'not a string' => [42],
            'null' => [null],
        ];
    }

    // ── Flow graph ───────────────────────────────────────────────────────────────────────────

    public function testValidGraphNormalizes(): void
    {
        $graph = FlowService::sanitizeFlowJson([
            'nodes' => [
                ['id' => 'in', 'type' => 'input', 'data' => ['x' => 1]],
                ['id' => 'out', 'type' => 'output'],
            ],
            'edges' => [['source' => 'in', 'target' => 'out', 'sourceHandle' => 'a']],
        ]);
        $this->assertCount(2, $graph['nodes']);
        $this->assertCount(1, $graph['edges']);
        $this->assertSame(['x' => 1], $graph['nodes'][0]['data']);
    }

    public function testEmptyGraphIsValid(): void
    {
        $graph = FlowService::sanitizeFlowJson(['nodes' => [], 'edges' => []]);
        $this->assertSame(['nodes' => [], 'edges' => []], $graph);
    }

    public function testGraphMissingShapeRejected(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('nodes');
        FlowService::sanitizeFlowJson(['nodes' => []]); // no edges key
    }

    public function testDuplicateNodeIdsRejected(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('Duplicate flow node id');
        FlowService::sanitizeFlowJson([
            'nodes' => [['id' => 'n1', 'type' => 'input'], ['id' => 'n1', 'type' => 'output']],
            'edges' => [],
        ]);
    }

    public function testEdgeToMissingNodeRejected(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('references a missing node');
        FlowService::sanitizeFlowJson([
            'nodes' => [['id' => 'n1', 'type' => 'input']],
            'edges' => [['source' => 'n1', 'target' => 'ghost']],
        ]);
    }

    public function testNodeWithoutTypeRejected(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('missing a type');
        FlowService::sanitizeFlowJson(['nodes' => [['id' => 'n1']], 'edges' => []]);
    }

    public function testOversizeGraphRejected(): void
    {
        // A single node whose data blob pushes the encoded graph past 256 KiB.
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('256KB');
        FlowService::sanitizeFlowJson([
            'nodes' => [['id' => 'n1', 'type' => 'template', 'data' => ['blob' => str_repeat('x', FlowService::MAX_FLOW_JSON_BYTES)]]],
            'edges' => [],
        ]);
    }

    // ── Binding ──────────────────────────────────────────────────────────────────────────────

    private function baseBinding(): array
    {
        return ['event' => 'aokie.call.ended', 'flow' => 'call-triage', 'mode' => 'async'];
    }

    public function testMinimalBindingNormalizes(): void
    {
        $b = FlowService::sanitizeBinding($this->baseBinding());
        $this->assertSame('aokie.call.ended', $b['event']);
        $this->assertSame('call-triage', $b['flow']);
        $this->assertSame('async', $b['mode']);
        $this->assertSame(30000, $b['timeoutMs'], 'default timeout');
        $this->assertTrue($b['enabled']);
        $this->assertNull($b['condition']);
        $this->assertNull($b['outputActions']);
    }

    public function testBadEventPatternRejected(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('event');
        FlowService::sanitizeBinding(['event' => 'Bad Event!', 'flow' => 'call-triage', 'mode' => 'async']);
    }

    public function testBadModeRejected(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('mode');
        FlowService::sanitizeBinding(['event' => 'form.submitted', 'flow' => 'call-triage', 'mode' => 'parallel']);
    }

    public function testUnknownOutputActionTypeRejected(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('unknown type');
        FlowService::sanitizeBinding($this->baseBinding() + [
            'outputActions' => [['type' => 'shell.exec', 'payload' => 'rm -rf /']],
        ]);
    }

    public function testWhitelistedOutputActionsSurviveAndUnknownKeysStripped(): void
    {
        $b = FlowService::sanitizeBinding($this->baseBinding() + [
            'outputActions' => [
                ['type' => 'formlogic.submitResponse', 'form' => 'orders', 'answers' => '$result.answers', 'evil' => 'x'],
                ['type' => 'call.speak', 'message' => 'Thanks, noted.'],
                ['type' => 'connector.request', 'connectorId' => 'aokie', 'command' => 'call.speak', 'payload' => ['text' => 'hi']],
            ],
        ]);
        $this->assertCount(3, $b['outputActions']);
        $this->assertArrayNotHasKey('evil', $b['outputActions'][0], 'unknown keys are stripped');
        $this->assertSame('$result.answers', $b['outputActions'][0]['answers']);
        $this->assertSame('aokie', $b['outputActions'][2]['connectorId']);
    }

    public function testTimeoutBoundsEnforced(): void
    {
        $b = FlowService::sanitizeBinding($this->baseBinding() + ['timeoutMs' => 250]);
        $this->assertSame(250, $b['timeoutMs']);
        $b = FlowService::sanitizeBinding($this->baseBinding() + ['timeoutMs' => 300000]);
        $this->assertSame(300000, $b['timeoutMs']);

        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('timeoutMs');
        FlowService::sanitizeBinding($this->baseBinding() + ['timeoutMs' => 249]);
    }

    public function testTimeoutAboveMaxRejected(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        FlowService::sanitizeBinding($this->baseBinding() + ['timeoutMs' => 300001]);
    }

    public function testConditionShapeEnforced(): void
    {
        $b = FlowService::sanitizeBinding($this->baseBinding() + [
            'condition' => ['type' => 'expression', 'expr' => 'event.data.callerPhone !== ""'],
        ]);
        $this->assertSame('expression', $b['condition']['type']);

        $this->expectException(\InvalidArgumentException::class);
        FlowService::sanitizeBinding($this->baseBinding() + ['condition' => ['type' => 'script', 'expr' => 'x']]);
    }

    public function testOversizeBindingColumnRejected(): void
    {
        // inputMap over the 16KB per-column cap (few keys, huge values → passes the 32-key cap).
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('16KB');
        FlowService::sanitizeBinding($this->baseBinding() + [
            'inputMap' => ['blob' => str_repeat('x', FlowService::MAX_BINDING_JSON_BYTES + 1)],
        ]);
    }

    public function testInputMapEntryCapEnforced(): void
    {
        $map = [];
        for ($i = 0; $i < 33; $i++) {
            $map['k' . $i] = '$event.data.x';
        }
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('32');
        FlowService::sanitizeBinding($this->baseBinding() + ['inputMap' => $map]);
    }

    public function testRetryAndFallbackPoliciesValidated(): void
    {
        $b = FlowService::sanitizeBinding($this->baseBinding() + [
            'retryPolicy' => ['maxAttempts' => 3, 'backoff' => 'exponential'],
            'fallbackPolicy' => ['onError' => 'surface_error', 'fallbackReply' => 'Sorry, please hold.'],
        ]);
        $this->assertSame(3, $b['retryPolicy']['maxAttempts']);
        $this->assertSame('surface_error', $b['fallbackPolicy']['onError']);

        $this->expectException(\InvalidArgumentException::class);
        FlowService::sanitizeBinding($this->baseBinding() + ['retryPolicy' => ['maxAttempts' => 6]]);
    }

    public function testTooManyOutputActionsRejected(): void
    {
        $actions = array_fill(0, 17, ['type' => 'formlogic.toast', 'message' => 'hi']);
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('16');
        FlowService::sanitizeBinding($this->baseBinding() + ['outputActions' => $actions]);
    }
}

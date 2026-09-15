<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\Flows\FlowLogicLanguages;
use PHPUnit\Framework\TestCase;

/**
 * formlogic-python/1: what a graph's code needs, what a caller declares, and the gap between
 * them. Pure — the reserve/claim/listing wiring is FlowLogicLanguageGateTest.
 */
class FlowLogicLanguagesTest extends TestCase
{
    public function testOnlyCodeNodesHaveALanguageAndAbsentIsJavaScript(): void
    {
        $this->assertNull(FlowLogicLanguages::ofNode(['id' => 't', 'type' => 'template', 'data' => ['language' => 'python']]));
        $this->assertNull(FlowLogicLanguages::ofNode('not a node'));
        foreach ([[], ['language' => null], ['language' => ''], ['language' => 'javascript']] as $data) {
            $this->assertSame('javascript', FlowLogicLanguages::ofNode(['id' => 'l', 'type' => 'logic_block', 'data' => $data]));
        }
        $this->assertSame('javascript', FlowLogicLanguages::ofNode(['id' => 'l', 'type' => 'condition']));
        $this->assertSame('python', FlowLogicLanguages::ofNode(['id' => 'c', 'type' => 'condition', 'data' => ['language' => 'python']]));
        // Unsupported values come back as written, a non-string as its JSON text.
        $this->assertSame('Python', FlowLogicLanguages::ofNode(['id' => 'c', 'type' => 'condition', 'data' => ['language' => 'Python']]));
        $this->assertSame('5', FlowLogicLanguages::ofNode(['id' => 'c', 'type' => 'condition', 'data' => ['language' => 5]]));
    }

    public function testOfListsEveryLanguageOnceSorted(): void
    {
        $this->assertSame([], FlowLogicLanguages::of(['nodes' => [['id' => 'in', 'type' => 'input']], 'edges' => []]));
        $this->assertSame([], FlowLogicLanguages::of(null));
        $this->assertSame(['javascript', 'python'], FlowLogicLanguages::of(['nodes' => [
            ['id' => 'a', 'type' => 'logic_block', 'data' => ['language' => 'python']],
            ['id' => 'b', 'type' => 'condition'],
            ['id' => 'c', 'type' => 'condition', 'data' => ['language' => 'python']],
            ['id' => 'd', 'type' => 'tts_speak', 'data' => ['language' => 'en-AU']],
        ]]));
        $this->assertSame(['5'], FlowLogicLanguages::of(['nodes' => [['id' => 'a', 'type' => 'logic_block', 'data' => ['language' => 5]]]]));
        $this->assertSame(
            ['nodeId' => 'x', 'language' => 'ruby'],
            FlowLogicLanguages::firstUnsupported(['nodes' => [
                ['id' => 'ok', 'type' => 'condition', 'data' => ['language' => 'python']],
                ['id' => 'x', 'type' => 'logic_block', 'data' => ['language' => 'ruby']],
            ]])
        );
        $this->assertNull(FlowLogicLanguages::firstUnsupported(['nodes' => [['id' => 'ok', 'type' => 'logic_block']]]));
    }

    public function testCallerDeclarations(): void
    {
        $this->assertNull(FlowLogicLanguages::fromCaller(null), 'absent: a runtime from before Python');
        $this->assertSame(['javascript'], FlowLogicLanguages::fromCaller([]));
        $this->assertSame(['javascript'], FlowLogicLanguages::fromCaller(''));
        $this->assertSame(['javascript', 'python'], FlowLogicLanguages::fromCaller(['python']));
        $this->assertSame(['javascript', 'python'], FlowLogicLanguages::fromCaller('python, javascript'));
        $this->assertSame(['javascript'], FlowLogicLanguages::fromCaller(['javascript', 'lua']), 'unknown ids are dropped');
        foreach ([42, ['a' => 'python'], [null], [''], ['python', ''], [str_repeat('p', 33)], array_fill(0, 17, 'python'), 'python,,javascript'] as $bad) {
            try {
                FlowLogicLanguages::fromCaller($bad);
                $this->fail('malformed: ' . json_encode($bad));
            } catch (\InvalidArgumentException $e) {
                $this->assertStringContainsString('logicLanguages', $e->getMessage());
            }
        }
    }

    public function testMissingIsWhatTheCallerCannotRun(): void
    {
        $this->assertSame([], FlowLogicLanguages::missing([], null));
        $this->assertSame([], FlowLogicLanguages::missing(['javascript'], null));
        $this->assertSame(['python'], FlowLogicLanguages::missing(['javascript', 'python'], null));
        $this->assertSame(['python'], FlowLogicLanguages::missing(['python'], ['javascript']));
        $this->assertSame([], FlowLogicLanguages::missing(['javascript', 'python'], ['javascript', 'python']));
        // An unknown language: a legacy caller would misread it; a declaring caller refuses it itself.
        $this->assertSame(['ruby'], FlowLogicLanguages::missing(['ruby'], null));
        $this->assertSame([], FlowLogicLanguages::missing(['ruby'], ['javascript']));

        $this->assertTrue(FlowLogicLanguages::runsAll(['javascript', 'python']));
        $this->assertFalse(FlowLogicLanguages::runsAll(['javascript']));
        $this->assertFalse(FlowLogicLanguages::runsAll(null));
    }

    /**
     * A Desktop says which languages it runs in its heartbeat capabilities
     * ('logic-language:<id>'). One that names none is a runtime from before Python, exactly
     * like a reserve or claim that sends no logicLanguages.
     */
    public function testDesktopCapabilities(): void
    {
        $this->assertNull(FlowLogicLanguages::fromCapabilities([]));
        $this->assertNull(FlowLogicLanguages::fromCapabilities(['relay.flows', 'ai.chat', 5, null]));
        $this->assertSame(['javascript', 'python'], FlowLogicLanguages::fromCapabilities(['relay.flows', 'logic-language:python']));
        $this->assertSame(['javascript'], FlowLogicLanguages::fromCapabilities(['logic-language:javascript']));
        // Ids this server does not know add nothing, but the Desktop still declared its languages.
        $this->assertSame(['javascript'], FlowLogicLanguages::fromCapabilities(['logic-language:lua']));
        $this->assertSame('logic-language:python', FlowLogicLanguages::capability('python'));
    }

    /**
     * formlogic-python/1 x packages: a contributed node that lowers to a core code node through a
     * core preset carries the language its merged data names. The stored graph alone would say
     * "no code" (dotted types are not code nodes), which is what let preset Python past the gate.
     */
    public function testContributedPresetsLowerToTheirLanguage(): void
    {
        $installed = [
            'com.acme.py.halve' => ['definition' => ['handler' => ['kind' => 'core-preset', 'coreType' => 'logic_block', 'defaults' => ['language' => 'python', 'expr' => 'inputs["n"] // 2']]]],
            'com.acme.py.check' => ['definition' => ['handler' => ['kind' => 'core-preset', 'coreType' => 'condition', 'defaults' => ['expr' => 'true']]]],
            'com.acme.py.greet' => ['definition' => ['handler' => ['kind' => 'core-preset', 'coreType' => 'template', 'defaults' => ['language' => 'python']]]],
            'com.acme.py.say' => ['definition' => ['handler' => ['kind' => 'service-action', 'bindingSlot' => 's', 'requiredAction' => 'a']]],
        ];
        $graph = static fn (array ...$nodes): array => ['nodes' => $nodes, 'edges' => []];

        $this->assertSame([], FlowLogicLanguages::of($graph(['id' => 'h', 'type' => 'com.acme.py.halve'])), 'the stored graph alone sees no code');
        $this->assertTrue(FlowLogicLanguages::hasContributedNodes($graph(['id' => 'h', 'type' => 'com.acme.py.halve'])));
        $this->assertFalse(FlowLogicLanguages::hasContributedNodes($graph(['id' => 'l', 'type' => 'logic_block'])));

        $this->assertSame(['python'], FlowLogicLanguages::ofLowered($graph(['id' => 'h', 'type' => 'com.acme.py.halve']), $installed));
        // The node's own data wins over the preset default, as in FlowCompiler.
        $this->assertSame(['javascript'], FlowLogicLanguages::ofLowered($graph(['id' => 'h', 'type' => 'com.acme.py.halve', 'data' => ['language' => 'javascript']]), $installed));
        $this->assertSame(['python'], FlowLogicLanguages::ofLowered($graph(['id' => 'c', 'type' => 'com.acme.py.check', 'data' => ['language' => 'python']]), $installed));
        $this->assertSame(['javascript'], FlowLogicLanguages::ofLowered($graph(['id' => 'c', 'type' => 'com.acme.py.check']), $installed));
        // Presets that run no code, service actions and uninstalled types need no language.
        $this->assertSame([], FlowLogicLanguages::ofLowered($graph(
            ['id' => 'g', 'type' => 'com.acme.py.greet'],
            ['id' => 's', 'type' => 'com.acme.py.say'],
            ['id' => 'x', 'type' => 'com.acme.py.missing', 'data' => ['language' => 'python']],
        ), $installed));
        // Core nodes still count.
        $this->assertSame(['javascript', 'python'], FlowLogicLanguages::ofLowered($graph(
            ['id' => 'l', 'type' => 'logic_block'],
            ['id' => 'h', 'type' => 'com.acme.py.halve'],
        ), $installed));
    }

    /** The lowering the gate reads is the compiler's own: same merge, same language. */
    public function testLoweredLanguagesMatchTheCompiledGraph(): void
    {
        $definition = [
            'handler' => ['kind' => 'core-preset', 'coreType' => 'logic_block', 'defaults' => ['language' => 'python', 'expr' => '1']],
        ];
        $installed = ['com.acme.py.one' => ['definition' => $definition, 'digest' => str_repeat('a', 64), 'version' => '1.0.0', 'packageId' => 'com.acme.py']];
        $graph = ['nodes' => [['id' => 'in', 'type' => 'input'], ['id' => 'o', 'type' => 'com.acme.py.one', 'data' => []]], 'edges' => [['source' => 'in', 'target' => 'o']]];
        $compiled = \FormLogic\Services\Flows\FlowCompiler::compile($graph, $installed);
        $this->assertTrue($compiled['ok']);
        $this->assertSame(FlowLogicLanguages::of($compiled['ir']), FlowLogicLanguages::ofLowered($graph, $installed));
        $this->assertSame(['python'], FlowLogicLanguages::of($compiled['ir']));
    }
}

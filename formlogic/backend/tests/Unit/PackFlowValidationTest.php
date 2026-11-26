<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\PackService;
use PHPUnit\Framework\TestCase;

/**
 * PackService::validatePack's FormLogic Flows rules: caps (≤ 20 flows / ≤ 40 bindings per pack),
 * FlowService sanitization applied to every flow + binding, slug/flow/formId cross-references.
 * Exercises the private validator by reflection (it is pure over arrays) — no DB.
 */
class PackFlowValidationTest extends TestCase
{
    private function validate(array $packData): void
    {
        $svc = (new \ReflectionClass(PackService::class))->newInstanceWithoutConstructor();
        $m = new \ReflectionMethod(PackService::class, 'validatePack');
        $m->setAccessible(true);
        $m->invoke($svc, $packData);
    }

    private function basePack(): array
    {
        return [
            'formatVersion' => 1,
            'packMeta' => ['name' => 'Flows Pack', 'version' => '1.0.0'],
            'forms' => [
                ['packFormId' => 'calls', 'title' => 'Calls', 'fields' => []],
            ],
            'apps' => [
                ['packAppId' => 'receptionist', 'name' => 'Receptionist'],
            ],
        ];
    }

    private function flow(string $slug = 'call-triage'): array
    {
        return [
            'slug' => $slug,
            'name' => 'Call triage',
            'flowJson' => [
                'nodes' => [['id' => 'in', 'type' => 'input'], ['id' => 'out', 'type' => 'output']],
                'edges' => [['source' => 'in', 'target' => 'out']],
            ],
        ];
    }

    public function testValidFlowsAndBindingsPass(): void
    {
        $pack = $this->basePack();
        $pack['flows'] = [$this->flow()];
        $pack['flowBindings'] = [[
            'flow' => 'call-triage',
            'event' => 'aokie.call.ended',
            'mode' => 'async',
            'formId' => '@pack:calls',
            'outputActions' => [['type' => 'formlogic.submitResponse', 'form' => '@pack:calls', 'answers' => '$result.answers']],
        ]];
        $this->validate($pack);
        $this->addToAssertionCount(1); // no exception
    }

    public function testFlowCountCapEnforced(): void
    {
        $pack = $this->basePack();
        $pack['flows'] = [];
        for ($i = 0; $i < 21; $i++) {
            $pack['flows'][] = $this->flow('flow-' . $i);
        }
        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('more than 20 flows');
        $this->validate($pack);
    }

    public function testBindingCountCapEnforced(): void
    {
        $pack = $this->basePack();
        $pack['flows'] = [$this->flow()];
        $pack['flowBindings'] = array_fill(0, 41, ['flow' => 'call-triage', 'event' => 'form.submitted', 'mode' => 'async']);
        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('more than 40 flow bindings');
        $this->validate($pack);
    }

    public function testBadFlowSlugRejected(): void
    {
        $pack = $this->basePack();
        $pack['flows'] = [$this->flow('Bad Slug!')];
        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('slug');
        $this->validate($pack);
    }

    public function testEdgeToMissingNodeRejected(): void
    {
        $pack = $this->basePack();
        $flow = $this->flow();
        $flow['flowJson']['edges'][] = ['source' => 'in', 'target' => 'ghost'];
        $pack['flows'] = [$flow];
        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('missing node');
        $this->validate($pack);
    }

    public function testUnknownOutputActionTypeRejected(): void
    {
        $pack = $this->basePack();
        $pack['flows'] = [$this->flow()];
        $pack['flowBindings'] = [[
            'flow' => 'call-triage', 'event' => 'form.submitted', 'mode' => 'async',
            'outputActions' => [['type' => 'shell.exec']],
        ]];
        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('unknown type');
        $this->validate($pack);
    }

    public function testBindingToUnknownFlowRejected(): void
    {
        $pack = $this->basePack();
        $pack['flows'] = [$this->flow()];
        $pack['flowBindings'] = [['flow' => 'ghost-flow', 'event' => 'form.submitted', 'mode' => 'async']];
        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage("unknown flow 'ghost-flow'");
        $this->validate($pack);
    }

    public function testBindingToUnknownPackFormRejected(): void
    {
        $pack = $this->basePack();
        $pack['flows'] = [$this->flow()];
        $pack['flowBindings'] = [['flow' => 'call-triage', 'event' => 'form.submitted', 'mode' => 'async', 'formId' => '@pack:ghost']];
        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage("unknown packFormId 'ghost'");
        $this->validate($pack);
    }

    public function testFlowsRequireAnApp(): void
    {
        $pack = $this->basePack();
        unset($pack['apps']);
        $pack['flows'] = [$this->flow()];
        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('require at least one app');
        $this->validate($pack);
    }

    /**
     * importPackFlows over a database double that keeps each flow's stored capabilities, by slug.
     *
     * @param list<string>|null $approved the reviewed grants (null: no review ran)
     * @return array{0: array<string, ?list<string>>, 1: list<string>} [capabilities by flow slug, withheld grants]
     */
    private function importFlows(array $flows, ?array $approved, array $bindings = []): array
    {
        $stored = [];
        $actions = [];
        $statement = $this->createMock(\PDOStatement::class);
        $statement->method('execute')->willReturnCallback(static function (?array $params = null) use (&$stored, &$actions): bool {
            if (isset($params['slug'])) $stored[$params['slug']] = $params['node_caps'] !== null ? json_decode($params['node_caps'], true) : null;
            if (isset($params['event'])) $actions[] = $params['actions'] !== null ? json_decode($params['actions'], true) : null;
            return true;
        });
        $pdo = $this->createMock(\PDO::class);
        $pdo->method('prepare')->willReturn($statement);
        $svc = (new \ReflectionClass(PackService::class))->newInstanceWithoutConstructor();
        (new \ReflectionProperty(PackService::class, 'mysql'))->setValue($svc, $pdo);
        $withheld = [];
        $args = [['flows' => $flows, 'flowBindings' => $bindings], ['receptionist' => 'app-1'], [], 'user-1', $approved === null ? null : array_fill_keys($approved, true), &$withheld];
        (new \ReflectionMethod(PackService::class, 'importPackFlows'))->invokeArgs($svc, $args);
        $withheld = array_keys($withheld);
        sort($withheld, SORT_STRING);
        return [$stored + ['actions' => $actions], $withheld];
    }

    /**
     * A grant a node asks for by being there is one of the review's lines. Declined, the node
     * must not run: the flow keeps no capability that covers it, a wildcard included, and the
     * import says what it withheld. Approved, the flow keeps what it declared.
     */
    public function testADeclinedNodeGrantLeavesTheFlowNoCapabilityThatCoversIt(): void
    {
        $speak = 'connector.aokie.call.operatorSpeak';
        $flows = [
            ['slug' => 'exact', 'nodeCapabilities' => [$speak, 'model.llm.local'], 'flowJson' => ['nodes' => [['id' => 'say', 'type' => 'aokie_speak', 'data' => ['text' => 'Hi']]], 'edges' => []]],
            ['slug' => 'wild', 'nodeCapabilities' => ['connector.aokie.*', 'connector.printer.print', 'model.llm.local'], 'flowJson' => ['nodes' => [['id' => 'say', 'type' => 'aokie_speak', 'data' => ['text' => 'Hi']]], 'edges' => []]],
            ['slug' => 'texts', 'nodeCapabilities' => ['connector.aokie.sms.send'], 'flowJson' => ['nodes' => [['id' => 'text', 'type' => 'connector_request', 'data' => ['connectorId' => 'aokie', 'command' => 'sms.send']]], 'edges' => []]],
        ];
        $listed = [$speak, 'connector.aokie.*', 'connector.aokie.sms.send', 'connector.printer.print'];

        // Everything the review lists approved, or no review at all: each flow as it was packed.
        foreach ([$listed, null] as $approved) {
            [$stored, $withheld] = $this->importFlows($flows, $approved);
            $this->assertSame([$speak, 'model.llm.local'], $stored['exact']);
            $this->assertSame(['connector.aokie.*', 'connector.printer.print', 'model.llm.local'], $stored['wild']);
            $this->assertSame(['connector.aokie.sms.send'], $stored['texts']);
            $this->assertSame([], $withheld);
        }

        // Speaking declined, the wildcard still ticked: no flow is left able to speak.
        [$stored, $withheld] = $this->importFlows($flows, array_values(array_diff($listed, [$speak])));
        $this->assertSame(['model.llm.local'], $stored['exact']);
        $this->assertSame(['connector.printer.print', 'model.llm.local'], $stored['wild'], 'a wildcard left in place would grant what was declined');
        $this->assertSame(['connector.aokie.sms.send'], $stored['texts'], 'a flow that does not speak keeps what was approved');
        $this->assertSame(['connector.aokie.*', $speak], $withheld);

        // The name the review once listed for a speak node approves nothing.
        [$stored, $withheld] = $this->importFlows([$flows[0]], ['connector.aokie.speak']);
        $this->assertSame(['model.llm.local'], $stored['exact']);
        $this->assertSame([$speak], $withheld);
    }

    /** A call.speak action is kept or dropped by the same grant a speak node asks for. */
    public function testASpeakActionIsReviewedAsTheGrantTheRunnerChecks(): void
    {
        $flows = [['slug' => 'call-triage', 'flowJson' => ['nodes' => [], 'edges' => []]]];
        $bindings = [['flow' => 'call-triage', 'event' => 'call.ended', 'mode' => 'async', 'outputActions' => [['type' => 'call.speak', 'message' => 'Thanks.'], ['type' => 'formlogic.toast', 'message' => 'Done']]]];
        [$stored, $withheld] = $this->importFlows($flows, ['connector.aokie.call.operatorSpeak'], $bindings);
        $this->assertSame(['call.speak', 'formlogic.toast'], array_column($stored['actions'][0], 'type'));
        $this->assertSame([], $withheld);
        [$stored, $withheld] = $this->importFlows($flows, ['connector.aokie.speak'], $bindings);
        $this->assertSame(['formlogic.toast'], array_column($stored['actions'][0], 'type'));
        $this->assertSame(['connector.aokie.call.operatorSpeak'], $withheld);
    }

    public function testBadBindingModeRejected(): void
    {
        $pack = $this->basePack();
        $pack['flows'] = [$this->flow()];
        $pack['flowBindings'] = [['flow' => 'call-triage', 'event' => 'form.submitted', 'mode' => 'parallel']];
        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('mode');
        $this->validate($pack);
    }
}

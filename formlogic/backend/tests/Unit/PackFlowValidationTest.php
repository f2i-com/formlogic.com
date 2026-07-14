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

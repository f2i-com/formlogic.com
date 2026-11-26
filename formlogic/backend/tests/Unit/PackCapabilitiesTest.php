<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Helpers\PackCapabilities;
use PHPUnit\Framework\TestCase;

/**
 * PackCapabilities::describe surfaces what a pack can do (connectors, permissions, logic, screens)
 * for the pre-install capability review. Pure — no DB.
 */
class PackCapabilitiesTest extends TestCase
{
    private function pack(): array
    {
        return [
            'forms' => [
                ['title' => 'Pre-starts', 'customScreen' => ['enabled' => true], 'customLogic' => [
                    'permissions' => ['ui.toast'],
                    'scripts' => [['hook' => 'onBeforeSubmit', 'source' => 'x', 'permissions' => ['ui.reject']]],
                ]],
                ['title' => 'Vehicles'],
            ],
            'apps' => [
                ['name' => 'MineCab', 'customLogic' => [
                    'permissions' => ['ui.setValues', 'connector.vehicle.status.read', 'connector.barcode.scan'],
                    'scripts' => [
                        ['hook' => 'onScreenEnter', 'source' => 'a'],
                        ['hook' => 'onConnectorEvent', 'source' => 'b'],
                    ],
                ]],
            ],
        ];
    }

    public function testDescribeSurfacesConnectorsAndPermissions(): void
    {
        $d = PackCapabilities::describe($this->pack());
        $this->assertSame(2, $d['forms']);
        $this->assertSame(1, $d['apps']);
        $this->assertTrue($d['hasScreens']);
        $this->assertTrue($d['hasCustomLogic']);
        $this->assertSame(3, $d['logicScripts']); // 1 form + 2 app
        sort($d['connectors']);
        $this->assertSame(['barcode', 'vehicle'], $d['connectors']);
        $this->assertContains('connector.vehicle.status.read', $d['permissions']);
        $this->assertContains('ui.reject', $d['permissions']); // script-level perms included
        $this->assertContains('ui.setValues', $d['permissions']);
    }

    public function testDescribeEmptyPack(): void
    {
        $d = PackCapabilities::describe([]);
        $this->assertSame(0, $d['forms']);
        $this->assertSame(0, $d['apps']);
        $this->assertFalse($d['hasCustomLogic']);
        $this->assertSame([], $d['connectors']);
        $this->assertSame([], $d['permissions']);
        $this->assertSame([], $d['connectorGrants']);
    }

    public function testConnectorGrantsCoverCustomLogicRolesAndFlows(): void
    {
        // APP-502: connectorGrants covers EVERY reviewable/strippable carrier —
        // customLogic (bundle + scripts), app roles, flow nodeCapabilities, and
        // flowBinding connector outputActions.
        $pack = [
            'apps' => [[
                'name' => 'A',
                'customLogic' => [
                    'permissions' => ['ui.toast', 'connector.aokie.call.answer'],
                    'scripts' => [['hook' => 'x', 'source' => 's', 'permissions' => ['connector.aokie.call.hangup']]],
                ],
                'roles' => [[
                    'name' => 'Op',
                    'permissions' => [
                        ['formId' => null, 'permission' => 'view_responses'],
                        ['formId' => null, 'permission' => 'connector.aokie.sms.send'],
                    ],
                ]],
            ]],
            'flows' => [['nodeCapabilities' => ['connector.aokie.call.dial']]],
            'flowBindings' => [[
                'connectorId' => 'aokie',
                'outputActions' => [['type' => 'connector.request', 'connectorId' => 'aokie', 'command' => 'settings.set']],
            ]],
        ];
        $d = PackCapabilities::describe($pack);
        $this->assertSame(
            [
                'connector.aokie.call.answer',
                'connector.aokie.call.dial',
                'connector.aokie.call.hangup',
                'connector.aokie.settings.set',
                'connector.aokie.sms.send',
            ],
            $d['connectorGrants']
        );
        $this->assertContains('connector.aokie.call.dial', $d['permissions']);
        $this->assertContains('connector.aokie.settings.set', $d['permissions']);
        $this->assertContains('aokie', $d['connectors']);
    }

    public function testDescribeSurfacesDeclaredPackServices(): void
    {
        // Pack services (wave 1): included-service declarations show on the
        // install review (informational — toggled post-install, never approved here).
        $pack = $this->pack();
        $pack['apps'][0]['services'] = [
            ['id' => 'companion-relay', 'title' => 'Companion app relay', 'description' => 'Relay.'],
            ['id' => 'other-svc', 'title' => 'Other', 'description' => '', 'defaultEnabled' => false],
        ];
        $d = PackCapabilities::describe($pack);
        $this->assertSame([
            ['id' => 'companion-relay', 'title' => 'Companion app relay', 'description' => 'Relay.', 'defaultEnabled' => true],
            ['id' => 'other-svc', 'title' => 'Other', 'description' => '', 'defaultEnabled' => false],
        ], $d['services']);
        $this->assertSame([], PackCapabilities::describe($this->pack())['services']);
    }

    public function testConnectorGrantsIncludeWildcards(): void
    {
        // A wildcard connector grant is reviewable (the runtime gate honors it).
        $d = PackCapabilities::describe([
            'apps' => [['name' => 'A', 'customLogic' => ['permissions' => ['connector.aokie.*', 'connector.*']]]],
        ]);
        $this->assertContains('connector.aokie.*', $d['connectorGrants']);
        $this->assertContains('connector.*', $d['connectorGrants']);
    }

    /**
     * Speaking into a call is listed as the grant the runner checks before it does: an
     * aokie_speak node and a call.speak action are the aokie connector's call.operatorSpeak. A
     * name of the review's own would be one that declining does not stop and approving does not grant.
     */
    public function testSpeakingIntoACallIsListedAsTheGrantTheRunnerChecks(): void
    {
        $d = PackCapabilities::describe([
            'flows' => [['slug' => 'reply', 'flowJson' => ['nodes' => [
                ['id' => 'say', 'type' => 'aokie_speak', 'data' => ['text' => 'One moment.']],
                ['id' => 'text', 'type' => 'connector_request', 'data' => ['connector' => 'aokie', 'command' => 'sms.send']],
                ['id' => 'any', 'type' => 'connector_request', 'data' => ['connectorId' => 'printer']],
                ['id' => 'ask', 'type' => 'llm_chat', 'data' => []],
            ]]]],
            'flowBindings' => [['flow' => 'reply', 'outputActions' => [['type' => 'call.speak', 'message' => 'Thanks.']]]],
        ]);
        $this->assertSame(['connector.aokie.call.operatorSpeak', 'connector.aokie.sms.send', 'connector.printer.*'], $d['connectorGrants']);
        $this->assertNotContains('connector.aokie.speak', $d['permissions']);
        $this->assertSame(['aokie', 'printer'], $d['connectors']);

        $this->assertSame('connector.aokie.call.operatorSpeak', PackCapabilities::AOKIE_SPEAK_GRANT);
        $this->assertSame([], PackCapabilities::flowNodeGrants(null));
        $this->assertSame([], PackCapabilities::flowNodeGrants(['nodes' => 'none']));
        // A speak action alone names the same grant.
        $action = PackCapabilities::describe(['flowBindings' => [['flow' => 'reply', 'outputActions' => [['type' => 'call.speak', 'message' => 'Thanks.']]]]]);
        $this->assertSame(['connector.aokie.call.operatorSpeak'], $action['connectorGrants']);
    }

    /** The receptionist that ships with FormLogic: every grant its review lists is one its flows declare or a role holds. */
    public function testTheBundledReceptionistsReviewListsNoGrantOfItsOwnInvention(): void
    {
        $path = dirname(__DIR__, 2) . '/resources/packs/aokie-receptionist/install.json';
        if (!is_file($path)) {
            $this->markTestSkipped('The bundled receptionist pack is not in this checkout.');
        }
        $install = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
        $pack = is_array($install['pack'] ?? null) ? $install['pack'] : $install;
        $d = PackCapabilities::describe($pack, is_array($install['customLogic'] ?? null) ? $install['customLogic'] : null);
        $this->assertContains('connector.aokie.call.operatorSpeak', $d['connectorGrants']);
        $this->assertNotContains('connector.aokie.speak', $d['connectorGrants']);
        // Each speak node sits in a flow that declares what it asks for, so approving the list lets it run.
        foreach ($pack['flows'] ?? [] as $flow) {
            $declared = is_array($flow['nodeCapabilities'] ?? null) ? $flow['nodeCapabilities'] : [];
            foreach (PackCapabilities::flowNodeGrants($flow['flowJson'] ?? null) as $grant) {
                $connector = implode('.', array_slice(explode('.', $grant), 0, 2));
                $this->assertTrue(in_array($grant, $declared, true) || in_array($connector . '.*', $declared, true), ($flow['slug'] ?? '?') . ' asks for ' . $grant);
            }
        }
    }
}

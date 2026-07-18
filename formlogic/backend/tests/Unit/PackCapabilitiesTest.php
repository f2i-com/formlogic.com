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

    public function testConnectorGrantsCoverCustomLogicAndRolesButNotFlows(): void
    {
        // APP-502: connectorGrants is the REVIEWABLE subset — customLogic
        // (bundle + scripts) + app roles — NOT flow-declared connector access.
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
        // Reviewable = customLogic (bundle + script) + role connector grants.
        $this->assertSame(
            ['connector.aokie.call.answer', 'connector.aokie.call.hangup', 'connector.aokie.sms.send'],
            $d['connectorGrants']
        );
        // Flow-declared connector access is surfaced in permissions/connectors
        // (informational) but is NOT declinable → not in connectorGrants.
        $this->assertContains('connector.aokie.call.dial', $d['permissions']);
        $this->assertContains('connector.aokie.settings.set', $d['permissions']);
        $this->assertNotContains('connector.aokie.call.dial', $d['connectorGrants']);
        $this->assertNotContains('connector.aokie.settings.set', $d['connectorGrants']);
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
}

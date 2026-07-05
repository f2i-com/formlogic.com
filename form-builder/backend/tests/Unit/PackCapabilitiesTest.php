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
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\SoftnDirectoryService;
use PHPUnit\Framework\TestCase;

/**
 * The capabilities a bundle's permission.json may name when a publication is drafted
 * (SoftnDirectoryService::checkDeclaration). The list is SoftN's own, in the order it writes it
 * (CAPABILITIES in @softn/bundle-format's capabilities.ts, schema 4; Bundle::CAPABILITIES in its
 * softn-api): a name missing here refuses a bundle the directory itself would take. Pinned, so a
 * name SoftN adds is added here on purpose and one dropped here is noticed.
 */
final class SoftnDirectoryCapabilitiesTest extends TestCase
{
    private const SOFTN_CAPABILITIES = ['net', 'camera', 'mic', 'files', 'qr', 'ai', 'gpu', 'sync', 'storage', 'accel', 'bluetooth', 'location', 'haptics', 'notifications'];

    private static function check(string $permissionJson): ?string
    {
        try {
            (new \ReflectionMethod(SoftnDirectoryService::class, 'checkDeclaration'))->invoke(null, $permissionJson);
            return null;
        } catch (\InvalidArgumentException $refused) {
            return $refused->getMessage();
        }
    }

    public function testTheListIsSoftNsFourteenNames(): void
    {
        $this->assertSame(self::SOFTN_CAPABILITIES, (new \ReflectionClassConstant(SoftnDirectoryService::class, 'CAPABILITIES'))->getValue());
    }

    public function testABundleMayDeclareAnyOfThemAndTheDevicesOwnAmongThem(): void
    {
        foreach (self::SOFTN_CAPABILITIES as $name) {
            $this->assertNull(self::check(json_encode(['schema' => 4, 'permissions' => [$name => ['enabled' => true]]], JSON_THROW_ON_ERROR)), $name);
        }
        $this->assertNull(self::check('{"permissions":{"location":{"enabled":true},"bluetooth":{"enabled":false},"haptics":{},"notifications":{"enabled":true}}}'));
    }

    public function testANameSoftNDoesNotHaveIsRefusedWithTheOnesItHas(): void
    {
        $said = self::check('{"permissions":{"network":{"enabled":true},"geolocation":{"enabled":true},"location":{"enabled":true}}}');
        $this->assertNotNull($said);
        $this->assertStringContainsString('unsupported capabilities: network, geolocation.', $said);
        $this->assertStringContainsString('They are ' . implode(', ', self::SOFTN_CAPABILITIES) . ' (', $said);
    }
}

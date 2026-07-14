<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Helpers\CustomLogicSanitizer;
use PHPUnit\Framework\TestCase;

/**
 * The custom app-logic sanitizer normalizes an untrusted bundle to a known-safe shape before it is
 * stored. Pure — no DB.
 */
class CustomLogicSanitizerTest extends TestCase
{
    public function testKeepsValidScriptAndForcesRuntime(): void
    {
        $out = CustomLogicSanitizer::sanitize([
            'version' => 99,
            'runtime' => 'evil',
            'scripts' => [
                ['id' => 's1', 'hook' => 'onBeforeSubmit', 'runtime' => 'evil', 'source' => 'function run(c){return {ok:true};}'],
            ],
        ]);
        $this->assertSame(1, $out['version']);
        $this->assertSame('quickjs', $out['runtime']);
        $this->assertCount(1, $out['scripts']);
        $this->assertSame('quickjs', $out['scripts'][0]['runtime']);
        $this->assertSame('onBeforeSubmit', $out['scripts'][0]['hook']);
    }

    public function testDropsUnknownHookAndEmptySource(): void
    {
        $out = CustomLogicSanitizer::sanitize(['scripts' => [
            ['hook' => 'onHackTheMainframe', 'source' => 'x'],   // invalid hook
            ['hook' => 'onAppStart', 'source' => ''],            // empty source
            ['hook' => 'onAppStart'],                             // missing source
            ['hook' => 'onAppStart', 'source' => 'valid()'],     // kept
        ]]);
        $this->assertCount(1, $out['scripts']);
        $this->assertSame('valid()', $out['scripts'][0]['source']);
    }

    public function testDropsOversizedSource(): void
    {
        $big = str_repeat('a', CustomLogicSanitizer::MAX_SOURCE_BYTES + 1);
        $out = CustomLogicSanitizer::sanitize(['scripts' => [
            ['hook' => 'onAppStart', 'source' => $big],
            ['hook' => 'onAppStart', 'source' => 'ok()'],
        ]]);
        $this->assertCount(1, $out['scripts']);
        $this->assertSame('ok()', $out['scripts'][0]['source']);
    }

    public function testCapsScriptCount(): void
    {
        $scripts = [];
        for ($i = 0; $i < 80; $i++) {
            $scripts[] = ['hook' => 'onAppStart', 'source' => "run$i()"];
        }
        $out = CustomLogicSanitizer::sanitize(['scripts' => $scripts]);
        $this->assertLessThanOrEqual(CustomLogicSanitizer::MAX_SCRIPTS, count($out['scripts']));
    }

    public function testFiltersPermissionsToStrings(): void
    {
        $out = CustomLogicSanitizer::sanitize([
            'permissions' => ['ui.toast', 123, null, 'connector.vehicle.status.read'],
            'strictPermissions' => 1,
            'scripts' => [],
        ]);
        $this->assertSame(['ui.toast', 'connector.vehicle.status.read'], $out['permissions']);
        $this->assertTrue($out['strictPermissions']);
    }

    public function testSizeCap(): void
    {
        $this->assertTrue(CustomLogicSanitizer::withinSizeCap(['scripts' => []]));
        $huge = ['scripts' => [['hook' => 'onAppStart', 'runtime' => 'quickjs', 'source' => str_repeat('a', 50000)]]];
        // Two ~50KB scripts blow the 100KB bundle cap.
        $huge['scripts'][] = ['hook' => 'onAppStart', 'runtime' => 'quickjs', 'source' => str_repeat('b', 60000)];
        $this->assertFalse(CustomLogicSanitizer::withinSizeCap($huge));
    }

    public function testSizeCapRejectsUnencodableBundle(): void
    {
        // Invalid UTF-8 makes json_encode() return false; that must be treated as over cap,
        // never as "within" — an unencodable bundle can't be stored or round-tripped.
        $bad = ['scripts' => [['hook' => 'onAppStart', 'runtime' => 'quickjs', 'source' => "\xB1\x31\xff"]]];
        $this->assertFalse(json_encode($bad) !== false, 'test precondition: bundle should be unencodable');
        $this->assertFalse(CustomLogicSanitizer::withinSizeCap($bad));
    }
}

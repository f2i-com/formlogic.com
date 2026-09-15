<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\UpgradeService;
use PHPUnit\Framework\TestCase;

/**
 * An upgrade restores the execute bit on the sandbox launchers it copies (zip
 * extraction and copy() drop it) and on nothing else under bin/runtime: the
 * SOURCE.json provenance shipped beside them is data. The chmod itself only
 * runs off Windows, so the choice of files is checked here, on every platform.
 */
class UpgradeSandboxLauncherTest extends TestCase
{
    public function testTheLaunchersAreMadeExecutable(): void
    {
        self::assertTrue(UpgradeService::isSandboxLauncher('/var/www/site/api/bin/runtime/formlogic-runtime-linux-x86_64'));
        self::assertTrue(UpgradeService::isSandboxLauncher('C:\\sites\\app\\api\\bin\\runtime\\formlogic-runtime-windows-x86_64.exe'));
    }

    public function testTheirProvenanceAndEverythingElseStayAsCopied(): void
    {
        self::assertFalse(UpgradeService::isSandboxLauncher('/var/www/site/api/bin/runtime/SOURCE.json'));
        self::assertFalse(UpgradeService::isSandboxLauncher('/var/www/site/api/bin/upgrade.php'));
        self::assertFalse(UpgradeService::isSandboxLauncher('/var/www/site/api/resources/formlogic-runtime-linux-x86_64'));
        self::assertFalse(UpgradeService::isSandboxLauncher('/var/www/site/api/bin/runtime/formlogic-runtime-linux-x86_64/stray'));
    }
}

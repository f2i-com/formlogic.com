<?php

declare(strict_types=1);
namespace FormLogic\Tests\Unit;
use PHPUnit\Framework\TestCase;

final class InstallerReliabilityTest extends TestCase
{
    public static function setUpBeforeClass(): void
    {
        if (!defined('FORMLOGIC_INSTALL_NO_RUN')) define('FORMLOGIC_INSTALL_NO_RUN', true);
        require_once dirname(__DIR__, 3) . '/install.php';
    }
    public function testProvisioningPreservesOutputAndExitCode(): void
    {
        $result = \flRunInstallerCommand([PHP_BINARY, '-r', 'fwrite(STDERR, "catalog failed"); exit(3);'], sys_get_temp_dir());
        self::assertSame(3, $result['exitCode']);
        self::assertSame('catalog failed', $result['output']);
        self::assertFalse($result['timedOut']);
    }
    public function testLongRunningProvisioningIsStoppedBeforeTheWebRequestTimesOut(): void
    {
        $start = microtime(true);
        $result = \flRunInstallerCommand([PHP_BINARY, '-r', 'echo "started"; sleep(10);'], sys_get_temp_dir(), 0.2);
        self::assertTrue($result['timedOut']);
        self::assertSame(-1, $result['exitCode']);
        self::assertLessThan(3, microtime(true) - $start);
    }
    public function testCommandOutputIsBounded(): void
    {
        $result = \flRunInstallerCommand([PHP_BINARY, '-r', 'echo str_repeat("x", 20000);'], sys_get_temp_dir());
        self::assertSame(0, $result['exitCode']);
        self::assertSame(8192, strlen($result['output']));
    }
    public function testUnexpectedActionFailureReturnsAnActionableReference(): void
    {
        $result = \flInstallerAction('test_database', ['db_host' => new \stdClass()]);
        self::assertFalse($result['success']);
        self::assertStringStartsWith('install-', $result['errorId']);
        self::assertStringContainsString('hosting PHP error log', $result['message']);
        self::assertStringNotContainsString('TypeError', $result['message']);
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Support\CronLock;
use PHPUnit\Framework\TestCase;

final class CronLockTest extends TestCase
{
    private string $dir;

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/fl-cron-lock-' . bin2hex(random_bytes(4));
    }

    protected function tearDown(): void
    {
        foreach (glob($this->dir . '/*') ?: [] as $file) {
            is_dir($file) ? rmdir($file) : @unlink($file);
        }
        @rmdir($this->dir);
    }

    public function testOneRunHoldsItAtATimeAndAnotherJobIsItsOwn(): void
    {
        $held = CronLock::take('job', $this->dir);
        $this->assertIsResource($held);
        $this->assertNull(CronLock::take('job', $this->dir));
        $this->assertIsResource(CronLock::take('another', $this->dir));
        fclose($held);
        $this->assertIsResource(CronLock::take('job', $this->dir));
    }

    public function testALockItCannotOpenHereIsTakenInTheTempFolderUnderANameOfItsOwn(): void
    {
        mkdir($this->dir . '/job.lock', 0700, true);
        $name = 'formlogic-' . substr(hash('sha256', $this->dir), 0, 16) . '-job.lock';
        try {
            $held = CronLock::take('job', $this->dir);
            $this->assertIsResource($held);
            $this->assertFileExists(sys_get_temp_dir() . '/' . $name);
            $this->assertNull(CronLock::take('job', $this->dir), 'and it still holds one run at a time');
            fclose($held);
        } finally {
            @unlink(sys_get_temp_dir() . '/' . $name);
        }
    }

    public function testEveryScheduledScriptTakesItsLockFromThisInstall(): void
    {
        foreach (['webhook-worker', 'privacy-sweep', 'idempotency-cleanup', 'flow-runs-reclaim', 'flow-outcome-dispatch', 'desktop-commands-cleanup'] as $job) {
            $source = (string) file_get_contents(dirname(__DIR__, 2) . "/bin/{$job}.php");
            $this->assertStringContainsString("CronLock::take('{$job}')", $source);
            $this->assertStringNotContainsString('sys_get_temp_dir', $source);
        }
    }
}

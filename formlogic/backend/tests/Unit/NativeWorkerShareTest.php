<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\NativeAppService;
use PHPUnit\Framework\TestCase;
use RuntimeException;

/**
 * One app's requests cannot take every native worker. A worker is held for a whole request, and a
 * slow query lasts about twenty seconds, so four of them used to turn every other app away.
 */
final class NativeWorkerShareTest extends TestCase
{
    private string $storage = '';

    protected function setUp(): void
    {
        $this->storage = sys_get_temp_dir() . '/fl-worker-share-' . bin2hex(random_bytes(4));
        mkdir($this->storage . '/.runtime-slots', 0700, true);
    }

    protected function tearDown(): void
    {
        $this->remove($this->storage);
    }

    private function remove(string $dir): void
    {
        foreach (scandir($dir) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            $path = $dir . '/' . $entry;
            is_dir($path) ? $this->remove($path) : @unlink($path);
        }
        @rmdir($dir);
    }

    /** @return list<resource> */
    private function hold(string ...$names): array
    {
        $held = [];
        foreach ($names as $name) {
            $lock = fopen($this->storage . '/.runtime-slots/' . $name . '.lock', 'c');
            self::assertTrue(flock($lock, LOCK_EX | LOCK_NB));
            $held[] = $lock;
        }
        return $held;
    }

    /** A request as far as the workers: it has none, or it goes on and fails on the fake runtime. */
    private function refusedAsBusy(string $appRoot): bool
    {
        $runtime = $this->storage . '/runtime';
        @mkdir($runtime);
        file_put_contents($runtime . '/host-protocol.json', '{}');
        @mkdir($this->storage . '/' . $appRoot . '/private', 0700, true);
        $service = new NativeAppService($this->storage, $runtime, PHP_BINARY);
        $invoke = new \ReflectionMethod($service, 'invoke');
        try {
            $invoke->invoke($service, $this->storage . '/' . $appRoot, ['method' => 'GET', 'path' => '/api/x']);
        } catch (RuntimeException $e) {
            return $e->getCode() === 429;
        }
        return false;
    }

    public function testAnAppHoldingItsShareWaitsWhileOthersRun(): void
    {
        $held = $this->hold('app-a-0', 'app-a-1', '0', '1');
        self::assertTrue($this->refusedAsBusy('app-a'), 'A third request of app A has to wait its turn');
        self::assertFalse($this->refusedAsBusy('app-b'), 'and app B still gets one of the two left');
        unset($held);
    }

    public function testEveryWorkerBusyTurnsAnAppAway(): void
    {
        $held = $this->hold('0', '1', '2', '3');
        self::assertTrue($this->refusedAsBusy('app-a'));
        unset($held);
    }

    public function testAFailedTurnGivesItsAppShareBack(): void
    {
        $held = $this->hold('0', '1', '2', '3');
        self::assertTrue($this->refusedAsBusy('app-a'));
        $free = fopen($this->storage . '/.runtime-slots/app-a-0.lock', 'c');
        self::assertTrue(flock($free, LOCK_EX | LOCK_NB), 'The share must not stay taken after a refusal');
        unset($held);
    }
}

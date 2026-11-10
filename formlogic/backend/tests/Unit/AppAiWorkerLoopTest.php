<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\AppAiWorkerLoop;
use PHPUnit\Framework\TestCase;

/**
 * How bin/app-ai-worker.php runs the worker: for its budget or until stopped, and never on code that
 * was replaced under it. A worker left running after an update failed a job it did not know
 * ("AI is turned off for this app", for a test that is no app's).
 */
final class AppAiWorkerLoopTest extends TestCase
{
    /** The clock, moved only by the loop's own rests. */
    private float $clock = 1000.0;
    /** @var list<array{at: float, takeNew: bool}> every pass made */
    private array $passes = [];
    /** @var list<string> */
    private array $said = [];
    /** @var list<string> */
    private array $complained = [];
    /** What the code on disk reads as, by the clock. */
    private \Closure $onDisk;
    private int $reads = 0;
    /** Whether work is in flight in this process, by the clock. */
    private \Closure $busy;
    /** What a pass does, by its number (from 1). */
    private \Closure $pass;

    protected function setUp(): void
    {
        $this->clock = 1000.0;
        $this->passes = $this->said = $this->complained = [];
        $this->reads = 0;
        $this->onDisk = fn(): string => 'code-1';
        $this->busy = fn(): bool => false;
        $this->pass = fn(int $number): array => ['sent' => 0, 'collected' => 0];
    }

    private function loop(): AppAiWorkerLoop
    {
        return new AppAiWorkerLoop(
            function (bool $takeNew): array {
                $this->passes[] = ['at' => $this->clock, 'takeNew' => $takeNew];
                return ($this->pass)(count($this->passes));
            },
            fn(): bool => ($this->busy)(),
            function (): string {
                $this->reads++;
                return ($this->onDisk)();
            },
            'code-1',
            function (string $line): void {
                $this->said[] = $line;
            },
            function (string $line): void {
                $this->complained[] = $line;
            },
            fn(): float => $this->clock,
            function (float $seconds): void {
                $this->clock += $seconds;
            },
        );
    }

    public function testACronRunWorksForItsBudgetAndEndsWell(): void
    {
        $status = $this->loop()->run(false, 12);
        $this->assertSame(0, $status);
        $this->assertCount(12, $this->passes, 'about a pass a second');
        $this->assertNotContains(false, array_column($this->passes, 'takeNew'));
        $this->assertSame([], $this->said, 'a pass that did nothing says nothing');
        $this->assertSame(12, $this->reads, 'the code on disk is read again before every pass');
    }

    public function testAPassThatDidSomethingIsLogged(): void
    {
        $this->pass = fn(int $number): array => $number === 2 ? ['expired' => 0, 'sent' => 2, 'delivered' => 1] : ['sent' => 0];
        $this->loop()->run(false, 3);
        $this->assertSame(['{"sent":2,"delivered":1}'], $this->said);
    }

    public function testARunPastItsBudgetFinishesWhatItHasInHandAndTakesNothingNew(): void
    {
        $this->busy = fn(): bool => $this->clock < 1004.5;
        $this->loop()->run(false, 2);
        $this->assertSame([true, true, false, false, false], array_column($this->passes, 'takeNew'));
    }

    public function testAWatchingWorkerStopsWhenFormLogicIsUpdatedUnderIt(): void
    {
        // Updated twelve seconds in; a picture on the server's own provider is still being drawn until 1020.
        $this->onDisk = fn(): string => $this->clock >= 1012.0 ? 'code-2' : 'code-1';
        $this->busy = fn(): bool => $this->clock < 1020.0;
        $status = $this->loop()->run(true, 55);
        $this->assertSame(AppAiWorkerLoop::UPDATED, $status);
        $this->assertSame(75, $status, 'a status of its own, for whatever supervises it');
        $this->assertSame(['FormLogic was updated; stopping so a fresh worker starts'], $this->said, 'said once');
        // It noticed before its next pass, took nothing new from then on, and finished what it had
        // in hand before it ended.
        $noticed = array_values(array_filter($this->passes, static fn(array $pass): bool => !$pass['takeNew']));
        $this->assertSame(1012.0, $noticed[0]['at']);
        $this->assertSame(1019.0, end($this->passes)['at']);
        foreach ($this->passes as $pass) $this->assertSame($pass['at'] < 1012.0, $pass['takeNew']);
        $this->assertSame(13, $this->reads, 'once it knows, it does not read the code again');
    }

    public function testAWatchingWorkerWithNothingInHandStopsAtOnce(): void
    {
        $this->onDisk = fn(): string => $this->clock >= 1003.0 ? 'code-2' : 'code-1';
        $this->assertSame(AppAiWorkerLoop::UPDATED, $this->loop()->run(true, 55));
        $this->assertSame(1003.0, end($this->passes)['at']);
        $this->assertFalse(end($this->passes)['takeNew'], 'its last pass only finishes: it expires, collects and delivers, and sends nothing');
    }

    public function testACronRunStopsToo(): void
    {
        $this->onDisk = fn(): string => $this->clock >= 1001.0 ? 'code-2' : 'code-1';
        $this->assertSame(AppAiWorkerLoop::UPDATED, $this->loop()->run(false, 55));
        $this->assertSame(1001.0, end($this->passes)['at'], 'the rest of its minute is left to the next, fresh run');
    }

    /** A worker started while an update was still being written never takes a job with the code it loaded. */
    public function testAWorkerWhoseCodeIsAlreadyReplacedTakesNothing(): void
    {
        $this->onDisk = fn(): string => 'code-2';
        $this->assertSame(AppAiWorkerLoop::UPDATED, $this->loop()->run(true, 55));
        $this->assertSame([['at' => 1000.0, 'takeNew' => false]], $this->passes);
    }

    public function testAWatchingWorkerNeverStopsWhileTheCodeIsTheSame(): void
    {
        // Stopped from outside after two minutes (here: a pass that throws, which ends --watch).
        $this->pass = function (int $number): array {
            if ($number === 120) throw new \RuntimeException('stopped by the test');
            return [];
        };
        $this->assertSame(AppAiWorkerLoop::FAILED, $this->loop()->run(true, 1));
        $this->assertCount(120, $this->passes, 'long past its budget, which is a cron run\'s');
        $this->assertNotContains(false, array_column($this->passes, 'takeNew'));
        $this->assertSame([], $this->said);
    }

    public function testAFailedPassEndsAWatchingWorkerAndIsOnlyNotedByACronRun(): void
    {
        $this->pass = function (int $number): array {
            if ($number === 2) throw new \PDOException('MySQL server has gone away');
            return [];
        };
        $this->assertSame(AppAiWorkerLoop::FAILED, $this->loop()->run(true, 55));
        $this->assertCount(2, $this->passes, 'its supervisor starts it again with a fresh connection');
        $this->assertSame(['App AI worker pass failed: PDOException: MySQL server has gone away'], $this->complained);

        $this->setUp();
        $this->pass = function (int $number): array {
            if ($number === 2) throw new \PDOException('MySQL server has gone away');
            return [];
        };
        $this->assertSame(AppAiWorkerLoop::FAILED, $this->loop()->run(false, 5));
        $this->assertCount(5, $this->passes, 'a cron run carries on for its budget');
    }

    public function testCodeThatCannotBeReadIsNotAnUpdate(): void
    {
        $this->onDisk = function (): string {
            throw new \RuntimeException('the folder could not be read');
        };
        $this->assertSame(0, $this->loop()->run(false, 12));
        $this->assertSame([], $this->said);
    }
}

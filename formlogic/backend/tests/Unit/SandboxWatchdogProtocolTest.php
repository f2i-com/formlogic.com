<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Tests\Support\SandboxWatchdogFixture\SandboxRunner;
use FormLogic\Tests\Support\SandboxWatchdogFixture\State;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../Support/SandboxWatchdogFixture.php';

/** Real PHP control flow with memory-stream process substitutes; no native/helper execution. */
final class SandboxWatchdogProtocolTest extends TestCase
{
    protected function setUp(): void
    {
        State::load();
        State::reset();
    }

    protected function tearDown(): void
    {
        State::release();
    }

    private function runFixture(?callable $host = null, int $budget = 2500): array
    {
        return (new SandboxRunner('C:/inert/runtime.exe'))->runScript('fixture', [], $host ?? static function (): int {
            State::$events[] = 'dispatch';
            return 7;
        }, $budget);
    }

    private function before(string $first, string $second): void
    {
        $a = array_search($first, State::$events, true);
        $b = array_search($second, State::$events, true);
        self::assertNotFalse($a, 'Missing event: ' . $first);
        self::assertNotFalse($b, 'Missing event: ' . $second);
        self::assertLessThan($b, $a, $first . ' must precede ' . $second);
    }

    private function failed(array $result): void
    {
        self::assertArrayHasKey('error', $result);
        self::assertArrayNotHasKey('result', $result);
        self::assertStringNotContainsString('PRIVATE-CANARY', json_encode($result));
    }

    public function testAcknowledgedLiveWatchdogPrecedesPayloadAndFinalCancelPrecedesRelease(): void
    {
        self::assertSame(42, $this->runFixture()['result']);
        $this->before('mkdir:448', 'control:HELLO ' . State::NONCE);
        $this->before('control:HELLO ' . State::NONCE, 'ack:0 READY 31337');
        $this->before('ack:0 READY 31337', 'control:1 ARM 3');
        $this->before('ack:1 ARMED 31337', 'runtime-write:0');
        $this->before('control:2 CANCEL', 'cancel:target-exited');
        $this->before('status:helper:exited', 'close:helper');
        $this->before('close:helper', 'close:runtime');
        self::assertCount(2, State::$commands);
        foreach (State::$commands as $command) {
            self::assertTrue($command['options']['bypass_shell']);
            self::assertIsArray($command['argv']);
            self::assertStringNotContainsString('ExecutionPolicy', implode(' ', $command['argv']));
            self::assertStringNotContainsString('taskkill', implode(' ', $command['argv']));
            self::assertStringNotContainsString(State::NONCE, implode(' ', $command['argv']));
        }
    }

    public static function startupFailures(): array
    {
        return array_combine($cases = ['runtime-open', 'system-root', 'helper-missing', 'marker-failed', 'directory-failed', 'entropy-failed', 'helper-open',
            'hello-partial', 'hello-flush', 'ready-missing', 'ready-malformed', 'ready-wrong-pid', 'ready-partial',
            'ready-forged-fixed', 'ready-wrong-nonce', 'helper-exited'],
            array_map(static fn (string $case): array => [$case], $cases));
    }

    #[DataProvider('startupFailures')]
    public function testStartupFailureNeverSendsPayload(string $fault): void
    {
        State::$startupFault = $fault;
        $this->failed($this->runFixture());
        self::assertSame([], State::$runtimeWrites);
        self::assertNotContains('dispatch', State::$events);
        self::assertLessThanOrEqual(10_000_000_000, State::$nanoseconds);
    }

    public static function controlFailures(): array
    {
        $cases = [];
        foreach ([1 => 'initial ARM', 2 => 'PAUSE', 3 => 'reARM'] as $sequence => $stage) {
            foreach (['write-zero', 'write-partial', 'flush-failed', 'ack-missing', 'ack-stale', 'ack-wrong-pid',
                'ack-malformed', 'ack-partial', 'ack-forged-fixed', 'ack-wrong-nonce', 'exit-before-ack', 'exit-after-ack'] as $fault) {
                $cases[$stage . ': ' . $fault] = [$sequence, $fault];
            }
        }
        return $cases;
    }

    #[DataProvider('controlFailures')]
    public function testFailedControlCannotReleaseUnprotectedGuestWork(int $sequence, string $fault): void
    {
        State::reset(1);
        State::$controlFaults[$sequence] = $fault;
        $this->failed($this->runFixture());
        self::assertCount($sequence === 1 ? 0 : 1, State::$runtimeWrites, 'A failed rearm must not deliver its reply');
        self::assertSame($sequence === 3 ? 1 : 0, count(array_keys(State::$events, 'dispatch', true)));
        self::assertCount(2, State::$commands, 'One persistent helper, with no replacement process');
        self::assertLessThanOrEqual(4_000_000_000, State::$nanoseconds);
    }

    public function testHelperExitBetweenArmAcknowledgmentAndInitialPayloadFailsClosed(): void
    {
        State::$controlFaults[1] = 'exit-before-payload';
        $this->failed($this->runFixture());
        self::assertSame([], State::$runtimeWrites);
        self::assertContains('ack:1 ARMED 31337', State::$events);
    }

    public function testPausePrecedesCallbackAndRearmPrecedesReplyOnTheSameHelper(): void
    {
        State::reset(1);
        $result = $this->runFixture(static function (): int {
            State::$events[] = 'dispatch';
            State::advance(10_000); // Trusted host time must not consume the guest budget.
            return 7;
        });
        self::assertSame(42, $result['result']);
        $this->before('ack:2 PAUSED 31337', 'dispatch');
        $this->before('dispatch', 'control:3 ARM 3');
        $this->before('ack:3 ARMED 31337', 'runtime-write:1');
        $this->before('runtime-write:1', 'control:4 CANCEL');
        self::assertCount(2, State::$commands);
        self::assertSame(['value' => 7], json_decode(State::$runtimeWrites[1], true));
    }

    public function testHostExceptionBecomesAReplyOnlyAfterRearm(): void
    {
        State::reset(1);
        self::assertSame(42, $this->runFixture(static function (): never {
            State::$events[] = 'dispatch';
            throw new \RuntimeException('fixture refusal');
        })['result']);
        self::assertSame(['error' => 'fixture refusal'], json_decode(State::$runtimeWrites[1], true));
        $this->before('ack:3 ARMED 31337', 'runtime-write:1');
    }

    public static function serializationExceptions(): array
    {
        return ['exception' => [\RuntimeException::class], 'error' => [\Error::class]];
    }

    private function throwingSerializer(string $exceptionClass): \JsonSerializable
    {
        return new class($exceptionClass) implements \JsonSerializable {
            public function __construct(private string $exceptionClass) {}
            public function jsonSerialize(): mixed
            {
                State::$events[] = 'serialize';
                throw new ($this->exceptionClass)('PRIVATE-CANARY serializer failure');
            }
        };
    }

    #[DataProvider('serializationExceptions')]
    public function testThrowingInputSerializationAcquiresNoResources(string $exceptionClass): void
    {
        $runner = new SandboxRunner('C:/inert/runtime.exe');
        $result = $runner->runScript('fixture', ['answers' => ['value' => $this->throwingSerializer($exceptionClass)]], static fn () => null);
        self::assertSame(['error' => 'FormLogic runtime input could not be encoded'], $result);
        self::assertSame([], State::$commands);
        self::assertSame(['serialize'], State::$events);
        self::assertSame([], State::$runtimeWrites);
    }

    #[DataProvider('serializationExceptions')]
    public function testThrowingBatchSerializationReturnsNoResultsOrPrivateLogText(string $exceptionClass): void
    {
        $result = (new SandboxRunner('C:/inert/runtime.exe'))->evaluateBatch(
            [['id' => '0', 'expression' => '42']], ['value' => $this->throwingSerializer($exceptionClass)]
        );
        self::assertSame([], $result);
        self::assertSame([], State::$commands);
        self::assertSame(['serialize'], State::$events);
        self::assertCount(1, State::$logs);
        self::assertStringContainsString('input could not be encoded', State::$logs[0]);
        self::assertStringNotContainsString('PRIVATE-CANARY', State::$logs[0]);
    }

    #[DataProvider('serializationExceptions')]
    public function testThrowingReplySerializationCancelsWhilePausedAndJoinsBeforeRelease(string $exceptionClass): void
    {
        State::reset(1);
        $result = $this->runFixture(fn () => $this->throwingSerializer($exceptionClass));
        self::assertSame(['error' => 'FormLogic runtime host reply could not be encoded'], $result);
        self::assertCount(1, State::$runtimeWrites, 'No reply is released after serialization fails');
        $this->before('ack:2 PAUSED 31337', 'serialize');
        $this->before('serialize', 'control:3 CANCEL');
        $this->before('status:helper:exited', 'close:helper');
        $this->before('close:helper', 'close:runtime');
        $this->before('close:runtime', 'unlink:flsbx');
        self::assertNotContains('control:3 ARM 3', State::$events);
        self::assertSame([], State::$logs);
    }

    public function testReplySerializationTimeStaysInsidePausedHostWindow(): void
    {
        State::reset(1);
        $result = $this->runFixture(static fn () => new class implements \JsonSerializable {
            public function jsonSerialize(): int
            {
                State::$events[] = 'serialize';
                self::assertPaused();
                State::advance(10_000);
                return 7;
            }
            private static function assertPaused(): void
            {
                TestCase::assertFalse(State::$computing);
                TestCase::assertTrue(State::$authorized);
            }
        });
        self::assertSame(42, $result['result']);
        self::assertSame(['value' => 7], json_decode(State::$runtimeWrites[1], true));
        $this->before('ack:2 PAUSED 31337', 'serialize');
        $this->before('serialize', 'control:3 ARM 3');
        $this->before('ack:3 ARMED 31337', 'runtime-write:1');
    }

    public function testUnexpectedProtocolExceptionStillCancelsAndCleansUp(): void
    {
        State::$readThrows = true;
        self::assertSame(['error' => 'FormLogic runtime communication failed'], $this->runFixture());
        $this->before('read:exception', 'control:2 CANCEL');
        $this->before('status:helper:exited', 'close:helper');
        $this->before('close:helper', 'close:runtime');
        $this->before('close:runtime', 'unlink:flsbx');
        self::assertSame([], State::$logs);
    }

    public function testRuntimeExitAfterPausePreventsDispatch(): void
    {
        State::reset(1);
        State::$runtimeExitsWhenPaused = true;
        $this->failed($this->runFixture());
        self::assertNotContains('dispatch', State::$events);
        self::assertCount(1, State::$runtimeWrites);
        self::assertNotContains('control:3 ARM 3', State::$events);
    }

    public function testRuntimeExitDuringCallbackPreventsRearmAndReply(): void
    {
        State::reset(1);
        $this->failed($this->runFixture(static function (): int {
            State::$events[] = 'dispatch';
            State::$running['runtime'] = false;
            return 7;
        }));
        self::assertCount(1, State::$runtimeWrites);
        self::assertNotContains('control:3 ARM 3', State::$events);
        self::assertContains('control:3 CANCEL', State::$events);
    }

    public function testRearmUsesRemainingCumulativeBudget(): void
    {
        State::reset(2);
        State::$computeMilliseconds = [1200, 1400];
        $this->failed($this->runFixture());
        self::assertContains('control:3 ARM 2', State::$events);
        self::assertSame(1, count(array_keys(State::$events, 'dispatch', true)));
        self::assertCount(2, State::$runtimeWrites);
    }

    public static function budgetBoundaries(): array
    {
        return ['below' => [2499, true], 'exact' => [2500, false], 'above' => [2501, false]];
    }

    #[DataProvider('budgetBoundaries')]
    public function testComputeBudgetBoundaryPrecedesHostDispatch(int $milliseconds, bool $allowed): void
    {
        State::reset(1);
        State::$computeMilliseconds = [$milliseconds];
        $result = $this->runFixture();
        self::assertSame($allowed ? 1 : 0, count(array_keys(State::$events, 'dispatch', true)));
        if ($allowed) {
            self::assertSame(42, $result['result']);
            self::assertContains('control:3 ARM 1', State::$events);
        } else { $this->failed($result); }
    }

    public static function callBoundaries(): array { return ['256 allowed' => [256, true], '257 refused' => [257, false]]; }

    #[DataProvider('callBoundaries')]
    public function testHostCallCountCannotResetTheBudget(int $calls, bool $allowed): void
    {
        State::reset($calls);
        $result = $this->runFixture();
        self::assertSame(256, count(array_keys(State::$events, 'dispatch', true)));
        self::assertCount(257, State::$runtimeWrites);
        self::assertCount(2, State::$commands);
        if ($allowed) { self::assertSame(42, $result['result']); } else { $this->failed($result); }
    }

    public function testFailedCancelWaitsThenStopsRuntimeBeforeForcingHelperAndSuppressesResult(): void
    {
        State::$cancelIgnored = true;
        $this->failed($this->runFixture());
        $this->before('control:2 CANCEL', 'terminate:runtime');
        $this->before('status:runtime:exited', 'terminate:helper');
        $this->before('close:runtime', 'terminate:helper');
        $this->before('status:helper:exited', 'close:helper');
        $this->before('close:helper', 'unlink:ack');
        self::assertSame(2_000_000_000, State::$nanoseconds);
    }

    public function testUnconfirmedRuntimeExitKeepsHelperGuardAndNeverExplicitlyClosesLiveResources(): void
    {
        State::$cancelIgnored = State::$runtimeTerminationFails = true;
        self::assertSame(['error' => 'FormLogic runtime cleanup could not be confirmed'], $this->runFixture());
        self::assertContains('terminate:runtime', State::$events);
        foreach (['terminate:helper', 'close:helper', 'close:runtime'] as $forbidden) {
            self::assertNotContains($forbidden, State::$events);
        }
        self::assertNotContains('unlink:ack', State::$events);
        self::assertSame(4_000_000_000, State::$nanoseconds);
    }

    public function testUnconfirmedHelperExitHasBoundedFallbackAndNoExplicitClose(): void
    {
        State::$cancelIgnored = State::$helperTerminationFails = true;
        $this->failed($this->runFixture());
        $this->before('status:runtime:exited', 'terminate:helper');
        self::assertNotContains('close:helper', State::$events);
        self::assertNotContains('unlink:ack', State::$events);
        self::assertSame(2_250_000_000, State::$nanoseconds);
    }

    public function testBatchCannotExposeSuccessAfterUnconfirmedCleanup(): void
    {
        State::$cancelIgnored = State::$runtimeTerminationFails = true;
        self::assertSame([], (new SandboxRunner('C:/inert/runtime.exe'))->evaluateBatch([['id' => '0', 'expression' => '42']], []));
        self::assertCount(1, State::$logs);
        self::assertStringContainsString('cleanup could not be confirmed', State::$logs[0]);
    }

    public static function failedCancelWrites(): array { return ['zero' => ['write-zero'], 'partial' => ['write-partial']]; }

    #[DataProvider('failedCancelWrites')]
    public function testUnacknowledgedCancelCannotBecomeSuccess(string $fault): void
    {
        State::$controlFaults[2] = $fault;
        $this->failed($this->runFixture());
        $this->before('status:runtime:exited', 'terminate:helper');
        self::assertSame(2_000_000_000, State::$nanoseconds);
    }

    public function testWindowsShellWrappersAreRejectedWithoutOpeningAnyProcess(): void
    {
        foreach (['fixture.bat', 'fixture.cmd', 'fixture.BaT', 'fixture.CMD'] as $name) {
            State::reset();
            $runner = new SandboxRunner('C:/inert/' . $name);
            self::assertFalse($runner->isAvailable());
            self::assertSame(['error' => 'FormLogic runtime is not available'], $runner->runScript('fixture', [], static fn () => null));
            self::assertSame([], State::$commands);
        }
    }

    public static function unavailableWatchdogs(): array
    {
        return ['helper absent' => ['helper-missing'], 'PowerShell absent' => ['powershell-missing'],
            'SystemRoot absent' => ['system-root'], 'SystemRoot relative' => ['system-root-relative']];
    }

    #[DataProvider('unavailableWatchdogs')]
    public function testUnavailableWatchdogIsReportedWithoutSideEffects(string $fault): void
    {
        State::$startupFault = $fault;
        $runner = new SandboxRunner('C:/inert/runtime.exe');
        self::assertFalse($runner->isAvailable());
        self::assertSame(['error' => 'FormLogic runtime is not available'], $runner->runScript('fixture', [], static fn () => null));
        self::assertSame([], State::$commands);
        self::assertSame([], State::$events);
    }

    public function testEntropyFailureRemovesOwnedFilesAndTerminatesOnlyTheRuntime(): void
    {
        State::$startupFault = 'entropy-failed';
        $this->failed($this->runFixture());
        $this->before('rmdir', 'terminate:runtime');
        $this->before('unlink:flwd', 'terminate:runtime');
        self::assertNotContains('open:helper', State::$events);
        self::assertSame([], State::$runtimeWrites);
    }

    public function testPreviouslySupportedLongComputeBudgetIsNotCappedAtOneHour(): void
    {
        self::assertSame(42, $this->runFixture(null, 3_601_000)['result']);
        self::assertContains('control:1 ARM 3601', State::$events);
    }

    public static function runtimeAliases(): array
    {
        return ['current override' => ['FORMLOGIC_RUNTIME_BIN'], 'legacy override' => ['FORMLOGIC_QJS_BIN']];
    }

    #[DataProvider('runtimeAliases')]
    public function testDirectNativeRuntimeOverrideRemainsSupported(string $key): void
    {
        $saved = array_intersect_key($_ENV, array_flip(['FORMLOGIC_RUNTIME_BIN', 'FORMLOGIC_QJS_BIN']));
        unset($_ENV['FORMLOGIC_RUNTIME_BIN'], $_ENV['FORMLOGIC_QJS_BIN']);
        try {
            $_ENV[$key] = 'C:/inert/override.exe';
            $runner = new SandboxRunner();
            self::assertTrue($runner->isAvailable());
            self::assertSame(42, $runner->runScript('fixture', [], static fn () => null)['result']);
            self::assertSame('C:/inert/override.exe', State::$commands[0]['argv'][0]);
        } finally {
            unset($_ENV['FORMLOGIC_RUNTIME_BIN'], $_ENV['FORMLOGIC_QJS_BIN']);
            $_ENV = array_replace($_ENV, $saved);
        }
    }

    public static function processStatuses(): array
    {
        return ['false confirms exit' => [false, true], 'true is live' => [true, false],
            'missing' => ['missing', false], 'null' => [null, false], 'zero' => [0, false],
            'empty string' => ['', false], 'string false' => ['false', false]];
    }

    #[DataProvider('processStatuses')]
    public function testOnlyBooleanFalseConfirmsProcessExit(mixed $status, bool $exited): void
    {
        $process = State::memory('runtime');
        State::$statusValues['runtime'] = $status;
        $wait = new \ReflectionMethod(SandboxRunner::class, 'waitForExit');
        self::assertSame($exited, $wait->invoke(new SandboxRunner('C:/inert/runtime.exe'), $process, 100));
        self::assertSame($exited ? 0 : 100_000_000, State::$nanoseconds);
        self::assertSame([], array_values(array_filter(State::$events, static fn (string $event): bool =>
            str_starts_with($event, 'terminate:') || str_starts_with($event, 'close:'))));
    }
}

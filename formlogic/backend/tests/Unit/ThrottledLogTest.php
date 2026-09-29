<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\ThrottledLog;
use PHPUnit\Framework\TestCase;

/**
 * A warning that would repeat on every request while a fault lasts is written once a window, however
 * many requests there are. PHP keeps nothing from one request to the next, so what remembers is a
 * marker file per message, and the clock and the folder are injected here so no test has to wait.
 */
final class ThrottledLogTest extends TestCase
{
    private const NOW = 1_784_160_000;

    private string $directory = '';
    private int $now = self::NOW;
    /** @var list<string> */
    private array $written = [];

    protected function setUp(): void
    {
        $this->directory = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'throttled-log-test-' . bin2hex(random_bytes(6));
        mkdir($this->directory);
        $this->now = self::NOW;
        $this->written = [];
    }

    protected function tearDown(): void
    {
        foreach (glob($this->directory . DIRECTORY_SEPARATOR . '*') ?: [] as $file) {
            @unlink($file);
        }
        @rmdir($this->directory);
    }

    private function log(int $windowSeconds = 60, ?string $directory = null): ThrottledLog
    {
        return new ThrottledLog(
            $directory ?? $this->directory,
            $windowSeconds,
            function (string $message): void {
                $this->written[] = $message;
            },
            fn (): int => $this->now,
        );
    }

    public function testTheFirstOccurrenceIsWrittenAndTheRepeatsWithinTheWindowAreNot(): void
    {
        $log = $this->log();

        $log('the credential lapsed');
        $this->now += 1;
        $log('the credential lapsed');
        $this->now += 58;
        $log('the credential lapsed');

        $this->assertSame(['the credential lapsed'], $this->written);
    }

    public function testItIsWrittenAgainOnceTheWindowHasPassed(): void
    {
        $log = $this->log();
        $log('the credential lapsed');

        $this->now += 59;
        $log('the credential lapsed');
        $this->assertCount(1, $this->written, 'one second short of the window');

        $this->now += 1;
        $log('the credential lapsed');
        $this->assertCount(2, $this->written, 'exactly one window later');

        $this->now += 30;
        $log('the credential lapsed');
        $this->assertCount(2, $this->written, 'and the window starts over from that write, not from the first');
    }

    public function testAnotherMessageIsNotHeldBackByThisOne(): void
    {
        $log = $this->log();

        $log('the credential lapsed');
        $log('the configuration was refused');
        $log('the credential lapsed');
        $log('the configuration was refused');

        $this->assertSame(['the credential lapsed', 'the configuration was refused'], $this->written, 'a change of state is written at once');
    }

    public function testEveryWorkerSharesTheMemoryOfIt(): void
    {
        // Two objects stand for two requests, which in PHP share nothing but the folder.
        $this->log()('the credential lapsed');
        $this->log()('the credential lapsed');

        $this->assertSame(['the credential lapsed'], $this->written);
    }

    public function testAClockThatWentBackwardsNeverSilencesAMessageForLong(): void
    {
        $this->log()('the credential lapsed');
        $this->now -= 3600;
        $this->log()('the credential lapsed');

        $this->assertCount(2, $this->written, 'a marker from the future does not count');
    }

    public function testWhenItCannotRememberItWritesEveryTime(): void
    {
        // Losing a warning is worse than repeating one, so a folder it cannot write to means no throttling.
        $log = $this->log(60, $this->directory . DIRECTORY_SEPARATOR . 'does-not-exist');

        $log('the credential lapsed');
        $log('the credential lapsed');

        $this->assertCount(2, $this->written);
    }

    public function testTheMarkersHoldNoPartOfTheMessage(): void
    {
        $this->log()('Aokie Companion ICE: 1 TURN entry lapsed (entry 1, turn:turn.example.test:3478)');

        $markers = array_map('basename', glob($this->directory . DIRECTORY_SEPARATOR . '*') ?: []);
        $this->assertCount(1, $markers);
        $this->assertStringStartsWith(ThrottledLog::MARKER_PREFIX, $markers[0]);
        $this->assertStringNotContainsString('turn', substr($markers[0], strlen(ThrottledLog::MARKER_PREFIX)));
    }

    public function testTheWindowIsWhateverItIsGiven(): void
    {
        $log = $this->log(5);

        $log('a');
        $this->now += 4;
        $log('a');
        $this->now += 1;
        $log('a');

        $this->assertSame(['a', 'a'], $this->written);
    }
}

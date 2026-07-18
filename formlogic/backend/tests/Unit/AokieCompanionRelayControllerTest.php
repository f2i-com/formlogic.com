<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\AokieCompanionRelayController;
use FormLogic\Services\AokieCompanionAdmissionSigner;
use PHPUnit\Framework\TestCase;

final class AokieCompanionRelayControllerTest extends TestCase
{
    public function testStreamDeadlineIsBoundedByTheVerifiedAdmissionWindowAndWorkerCap(): void
    {
        $now = 1_000.25;

        $this->assertSame(
            1_120.0,
            AokieCompanionRelayController::streamDeadline(1_090, $now),
            'a 90-second admission plus verifier skew must not become a 300-second stream',
        );
        $this->assertSame(
            1_300.25,
            AokieCompanionRelayController::streamDeadline(2_000, $now),
            'the independent worker-occupancy cap still bounds a longer admission',
        );
        $this->assertSame(
            $now,
            AokieCompanionRelayController::streamDeadline(
                970,
                $now,
            ),
            'an admission at the verifier skew boundary has no mailbox-delivery window left',
        );
        $this->assertSame(30, AokieCompanionAdmissionSigner::CLOCK_SKEW_SECONDS);
    }

    public function testRowsFetchedAcrossTheAdmissionDeadlineAreNotEmittedOrConsumed(): void
    {
        $now = 10.0;
        $emitted = [];
        $secretFrame = '{"kind":"plugin_snapshot","callerPhone":"private"}';

        $result = AokieCompanionRelayController::fetchAndEmitStreamBatch(
            41,
            11.0,
            static function (int $cursor) use (&$now, $secretFrame): array {
                self::assertSame(41, $cursor);
                // The query began while authorized but completed after the
                // admission window. Its result must wait for re-admission.
                $now = 11.0;
                return [[
                    'seq' => 42,
                    'from' => 'plugin',
                    'subjectId' => 'aokie',
                    'grants' => ['state_read'],
                    'frame' => $secretFrame,
                ]];
            },
            static fn (array $row): string => 'serialized:' . $row['frame'],
            static function (string $event) use (&$emitted): void {
                $emitted[] = $event;
            },
            static function () use (&$now): float {
                return $now;
            },
        );

        $this->assertSame([], $emitted);
        $this->assertSame(
            ['cursor' => 41, 'emitted' => false, 'expired' => true],
            $result,
            'the un-emitted row remains behind the old cursor for the next admitted stream',
        );
    }

    public function testSseSerializationThatCrossesTheDeadlineCannotEmitTheFrame(): void
    {
        $now = 20.0;
        $emitted = [];
        $row = [
            'seq' => 52,
            'from' => 'plugin',
            'subjectId' => 'aokie',
            'grants' => ['state_read'],
            'frame' => '{"kind":"plugin_snapshot","callerPhone":"private"}',
        ];

        $result = AokieCompanionRelayController::fetchAndEmitStreamBatch(
            51,
            21.0,
            static fn (int $cursor): array => [$row],
            static function (array $fetched) use (&$now): string {
                $now = 21.0;
                return 'serialized:' . $fetched['frame'];
            },
            static function (string $event) use (&$emitted): void {
                $emitted[] = $event;
            },
            static function () use (&$now): float {
                return $now;
            },
        );

        $this->assertSame([], $emitted);
        $this->assertSame(['cursor' => 51, 'emitted' => false, 'expired' => true], $result);
    }

    public function testLongPollIsCappedAndDiscardsRowsFetchedAcrossTheDeadline(): void
    {
        $now = 30.0;
        $observedWait = null;
        $row = [
            'seq' => 62,
            'from' => 'plugin',
            'subjectId' => 'aokie',
            'grants' => ['state_read'],
            'frame' => '{"kind":"plugin_snapshot"}',
        ];

        $result = AokieCompanionRelayController::pollStreamBatch(
            61,
            25_000,
            30.125,
            static function (int $waitMs) use (&$now, &$observedWait, $row): array {
                $observedWait = $waitMs;
                $now = 30.125;
                return [$row];
            },
            static function () use (&$now): float {
                return $now;
            },
        );

        $this->assertSame(125, $observedWait, 'the DB poll may wait only inside the auth window');
        $this->assertSame(
            ['rows' => [], 'lastSeq' => 61, 'expired' => true],
            $result,
            'a row completed at expiry is neither exposed nor consumed',
        );
    }

    public function testLongPollAtTheSkewBoundaryDoesNotTouchTheMailbox(): void
    {
        $polled = false;
        $result = AokieCompanionRelayController::pollStreamBatch(
            71,
            25_000,
            40.0,
            static function (int $waitMs) use (&$polled): array {
                $polled = true;
                return [];
            },
            static fn (): float => 40.0,
        );

        $this->assertFalse($polled);
        $this->assertSame(['rows' => [], 'lastSeq' => 71, 'expired' => true], $result);
    }
}

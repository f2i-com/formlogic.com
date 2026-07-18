<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\AokieCompanionRelayService;
use PHPUnit\Framework\TestCase;

/** Pure relay helpers: party identity, SSE frame formatting, resume cursor. */
final class AokieCompanionRelayServiceTest extends TestCase
{
    private const MOBILE_THUMBPRINT = 'kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k';

    public function testPartyForClaimsMapsRolesAndFailsClosed(): void
    {
        $this->assertSame('plugin', AokieCompanionRelayService::partyForClaims([
            'role' => 'plugin',
            'holderKeyThumbprint' => self::MOBILE_THUMBPRINT,
        ]));
        $this->assertSame(
            'mobile:' . self::MOBILE_THUMBPRINT,
            AokieCompanionRelayService::partyForClaims([
                'role' => 'mobile',
                'holderKeyThumbprint' => self::MOBILE_THUMBPRINT,
            ]),
        );
        $this->assertNull(AokieCompanionRelayService::partyForClaims([
            'role' => 'mobile',
            'holderKeyThumbprint' => 'not-a-thumbprint',
        ]));
        $this->assertNull(AokieCompanionRelayService::partyForClaims(['role' => 'operator']));
    }

    public function testValidPartyAcceptsExactlyPluginAndThumbprintedMobiles(): void
    {
        $this->assertTrue(AokieCompanionRelayService::validParty('plugin'));
        $this->assertTrue(AokieCompanionRelayService::validParty('mobile:' . self::MOBILE_THUMBPRINT));
        $this->assertFalse(AokieCompanionRelayService::validParty('mobile:'));
        $this->assertFalse(AokieCompanionRelayService::validParty('mobile:short'));
        $this->assertFalse(AokieCompanionRelayService::validParty('plugin:x'));
        $this->assertFalse(AokieCompanionRelayService::validParty(''));
        $this->assertFalse(AokieCompanionRelayService::validParty(null));
        $this->assertFalse(AokieCompanionRelayService::validParty(42));
    }

    public function testSseEventCarriesCursorIdAndPreservesOpaqueJsonShapes(): void
    {
        $event = AokieCompanionRelayService::sseEvent([
            'seq' => 42,
            'from' => 'mobile:' . self::MOBILE_THUMBPRINT,
            'subjectId' => 'device_a',
            'grants' => ['state_read', 'monitor', 'rtc_signal'],
            'frame' => '{"v":2,"kind":"hello","empty":{},"list":[]}',
        ]);
        $this->assertSame(
            "id: 42\n"
            . "event: frame\n"
            . 'data: {"seq":42,"from":"mobile:' . self::MOBILE_THUMBPRINT . '",'
            . '"subjectId":"device_a",'
            . '"grants":["state_read","monitor","rtc_signal"],'
            . '"frame":{"v":2,"kind":"hello","empty":{},"list":[]}}'
            . "\n\n",
            $event,
        );
        // The opaque-frame invariant: an empty JSON object must survive the
        // round trip as {} (PHP's assoc decoding would corrupt it into []).
        $this->assertStringContainsString('"empty":{}', $event);
        $this->assertStringContainsString('"list":[]', $event);
    }

    public function testSseAdmissionMetadataFailsClosedWhenMissingOrMalformed(): void
    {
        $base = [
            'seq' => 7,
            'from' => 'mobile:' . self::MOBILE_THUMBPRINT,
            'frame' => '{"kind":"mobile_hello"}',
        ];
        $this->assertStringContainsString(
            '"subjectId":null',
            AokieCompanionRelayService::sseEvent($base),
            'pre-migration rows carry no authenticated subject',
        );
        $this->assertStringContainsString(
            '"grants":[]',
            AokieCompanionRelayService::sseEvent($base),
            'pre-migration rows carry no authority',
        );
        $this->assertStringContainsString(
            '"grants":[]',
            AokieCompanionRelayService::sseEvent($base + [
                'grants' => array_fill(0, AokieCompanionRelayService::MAX_GRANTS_PER_FRAME + 1, 'takeover'),
            ]),
            'oversized metadata is not partially interpreted',
        );
        $this->assertStringContainsString(
            '"grants":[]',
            AokieCompanionRelayService::sseEvent($base + ['grants' => ['state_read', 7]]),
            'mixed-type metadata is not partially interpreted',
        );
        $this->assertStringContainsString(
            '"grants":[]',
            AokieCompanionRelayService::sseEvent($base + ['grants' => ['state_read', 'state_read']]),
            'duplicate grant metadata is not partially interpreted',
        );
        foreach ([7, '', 'contains spaces', str_repeat('x', 201)] as $subjectId) {
            $this->assertStringContainsString(
                '"subjectId":null',
                AokieCompanionRelayService::sseEvent($base + ['subjectId' => $subjectId]),
                'malformed subject metadata is not trusted',
            );
        }
    }

    public function testResumeCursorPrefersLastEventIdOverSinceAndFailsToZero(): void
    {
        $this->assertSame(7, AokieCompanionRelayService::resumeCursor('7', '3'));
        $this->assertSame(3, AokieCompanionRelayService::resumeCursor('', '3'));
        $this->assertSame(3, AokieCompanionRelayService::resumeCursor('', 3));
        $this->assertSame(0, AokieCompanionRelayService::resumeCursor('', null));
        $this->assertSame(0, AokieCompanionRelayService::resumeCursor('junk', 'junk'));
        $this->assertSame(0, AokieCompanionRelayService::resumeCursor('-2', -2));
        $this->assertSame(9, AokieCompanionRelayService::resumeCursor(' 9 ', null));
        $this->assertSame(0, AokieCompanionRelayService::resumeCursor('9999999999999999', null));
    }
}

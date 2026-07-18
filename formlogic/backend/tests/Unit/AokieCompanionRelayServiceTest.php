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
            'frame' => '{"v":2,"kind":"hello","empty":{},"list":[]}',
        ]);
        $this->assertSame(
            "id: 42\n"
            . "event: frame\n"
            . 'data: {"seq":42,"from":"mobile:' . self::MOBILE_THUMBPRINT . '",'
            . '"frame":{"v":2,"kind":"hello","empty":{},"list":[]}}'
            . "\n\n",
            $event,
        );
        // The opaque-frame invariant: an empty JSON object must survive the
        // round trip as {} (PHP's assoc decoding would corrupt it into []).
        $this->assertStringContainsString('"empty":{}', $event);
        $this->assertStringContainsString('"list":[]', $event);
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

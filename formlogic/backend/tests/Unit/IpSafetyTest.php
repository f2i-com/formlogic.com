<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Helpers\IpSafety;
use PHPUnit\Framework\TestCase;

/**
 * SSRF-safety guard. Pure — the tests use IP literals and blocked hostnames only, so no live DNS is
 * required (a resolving hostname would make the test network-dependent + flaky).
 */
class IpSafetyTest extends TestCase
{
    public function testIsPublicIpAcceptsRoutableAddresses(): void
    {
        $this->assertTrue(IpSafety::isPublicIp('8.8.8.8'));
        $this->assertTrue(IpSafety::isPublicIp('1.1.1.1'));
    }

    public function testIsPublicIpRejectsPrivateReservedAndLoopback(): void
    {
        $this->assertFalse(IpSafety::isPublicIp('10.0.0.5'));
        $this->assertFalse(IpSafety::isPublicIp('192.168.1.10'));
        $this->assertFalse(IpSafety::isPublicIp('172.16.0.1'));
        $this->assertFalse(IpSafety::isPublicIp('127.0.0.1'));
        $this->assertFalse(IpSafety::isPublicIp('169.254.0.1'));       // link-local
        $this->assertFalse(IpSafety::isPublicIp('::ffff:127.0.0.1'));   // IPv4-mapped loopback
    }

    public function testResolvesToPublicHostRejectsPrivateLiteralsAndBlockedHosts(): void
    {
        $err = null;
        $this->assertFalse(IpSafety::resolvesToPublicHost('127.0.0.1', $err));
        $this->assertFalse(IpSafety::resolvesToPublicHost('10.0.0.5', $err));
        $this->assertFalse(IpSafety::resolvesToPublicHost('localhost', $err));
        $this->assertFalse(IpSafety::resolvesToPublicHost('169.254.169.254', $err));   // cloud metadata
        $this->assertFalse(IpSafety::resolvesToPublicHost('', $err));
    }

    public function testResolvesToPublicHostAcceptsPublicLiteral(): void
    {
        $err = null;
        // A public IP literal needs no DNS resolution.
        $this->assertTrue(IpSafety::resolvesToPublicHost('8.8.8.8', $err));
        $this->assertNull($err);
    }
}

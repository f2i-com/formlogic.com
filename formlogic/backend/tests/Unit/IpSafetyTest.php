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

    public function testPinNamesThePortCurlConnectsTo(): void
    {
        // URL schemes are case-insensitive: "HTTPS://" passes FILTER_VALIDATE_URL and the
        // webhook check, and curl connects to it on 443.
        $this->assertSame('hooks.example.com:443:8.8.8.8', IpSafety::curlResolveEntry('https://hooks.example.com/x', '8.8.8.8'));
        $this->assertSame('hooks.example.com:443:8.8.8.8', IpSafety::curlResolveEntry('HTTPS://hooks.example.com/x', '8.8.8.8'));
        $this->assertSame('hooks.example.com:443:8.8.8.8', IpSafety::curlResolveEntry('HtTpS://hooks.example.com/x', '8.8.8.8'));
        $this->assertSame('hooks.example.com:80:8.8.8.8', IpSafety::curlResolveEntry('HTTP://hooks.example.com/x', '8.8.8.8'));
        $this->assertSame('hooks.example.com:8443:8.8.8.8', IpSafety::curlResolveEntry('HTTPS://hooks.example.com:8443/x', '8.8.8.8'));
        $this->assertNull(IpSafety::curlResolveEntry('not a url', '8.8.8.8'));
    }

    /**
     * What the pin is for, checked against curl itself: a name that resolves nowhere is
     * reached only through the pin. With the pin keyed on another port, curl looks the
     * name up on its own (and fails to resolve it here; against a rebinding name, that
     * second lookup is the one an attacker answers).
     */
    public function testCurlReachesAnUppercaseHttpsUrlOnlyThroughItsPin(): void
    {
        if (!function_exists('curl_init')) {
            $this->markTestSkipped('curl is not available');
        }
        $url = 'HTTPS://pin-probe.invalid/';
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 3,
            CURLOPT_TIMEOUT => 3,
            CURLOPT_PROXY => '',
            CURLOPT_RESOLVE => [IpSafety::curlResolveEntry($url, '127.0.0.1')],
        ]);
        curl_exec($ch);
        $errno = curl_errno($ch);
        curl_close($ch);
        $this->assertNotSame(CURLE_COULDNT_RESOLVE_HOST, $errno, 'curl ignored the pin and resolved the name itself');
    }

    public function testResolvesToPublicHostAcceptsPublicLiteral(): void
    {
        $err = null;
        // A public IP literal needs no DNS resolution.
        $this->assertTrue(IpSafety::resolvesToPublicHost('8.8.8.8', $err));
        $this->assertNull($err);
    }
}

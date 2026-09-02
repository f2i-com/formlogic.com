<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\FormLogicRuntime;
use PHPUnit\Framework\TestCase;

/**
 * The address classifier behind `ctx.http`'s SSRF guard — every spelling of a
 * private destination that DNS can hand back.
 *
 * The bug this pins: the IPv4-mapped IPv6 range was recognised only in its
 * dotted spelling, `::ffff:169.254.169.254`. dns_get_record() reports AAAA
 * answers as hex groups — `::ffff:a9fe:a9fe` — which missed the check, was
 * classified public, pinned, and connected to the metadata service. Addresses
 * are classified by their bytes now, so the spelling cannot matter.
 */
class SandboxHttpAddressClassificationTest extends TestCase
{
    private function isPrivate(string $ip): bool
    {
        $rt = (new \ReflectionClass(FormLogicRuntime::class))->newInstanceWithoutConstructor();
        $m = new \ReflectionMethod(FormLogicRuntime::class, 'isPrivateIp');
        return (bool) $m->invoke($rt, $ip);
    }

    /** @return iterable<string, array{string}> */
    public static function privateSpellings(): iterable
    {
        yield 'metadata, dotted mapped' => ['::ffff:169.254.169.254'];
        yield 'metadata, HEX mapped (what dns_get_record returns)' => ['::ffff:a9fe:a9fe'];
        yield 'loopback, hex mapped' => ['::ffff:7f00:1'];
        yield 'rfc1918 10/8, hex mapped' => ['::ffff:a00:1'];
        yield 'mapped, fully expanded' => ['0000:0000:0000:0000:0000:ffff:a9fe:a9fe'];
        yield 'loopback ::1' => ['::1'];
        yield 'unspecified ::' => ['::'];
        yield 'ipv4-compatible ::a.b.c.d' => ['::169.254.169.254'];
        yield 'NAT64 64:ff9b::/96 wrapping metadata' => ['64:ff9b::a9fe:a9fe'];
        yield '6to4 embedding metadata' => ['2002:a9fe:a9fe::1'];
        yield 'teredo' => ['2001:0:1:2:3:4:5:6'];
        yield 'documentation 2001:db8::' => ['2001:db8::1'];
        yield 'link-local fe80::' => ['fe80::1'];
        yield 'unique local fd00::' => ['fd12::1'];
        yield 'unique local fc00::' => ['fc00::1'];
        yield 'site-local fec0::' => ['fec0::1'];
        yield 'multicast ff02::' => ['ff02::1'];
        yield 'ipv4 loopback' => ['127.0.0.1'];
        yield 'ipv4 metadata' => ['169.254.169.254'];
        yield 'ipv4 rfc1918' => ['192.168.1.1'];
        yield 'carrier-grade NAT (100.64/10, Alibaba metadata lives here)' => ['100.100.100.200'];
        yield 'CGNAT upper edge' => ['100.127.255.255'];
        yield 'protocol assignments 192.0.0/24' => ['192.0.0.8'];
        yield 'benchmarking 198.18/15' => ['198.19.0.1'];
        yield 'garbage' => ['not an address'];
    }

    /** @dataProvider privateSpellings */
    public function testEverySpellingOfAPrivateDestinationIsRefused(string $ip): void
    {
        self::assertTrue($this->isPrivate($ip), "$ip must be classified private");
    }

    /** @return iterable<string, array{string}> */
    public static function publicAddresses(): iterable
    {
        yield 'google dns v4' => ['8.8.8.8'];
        yield 'cloudflare v4' => ['1.1.1.1'];
        yield 'just past CGNAT' => ['100.128.0.1'];
        yield 'just past 192.0.0/24' => ['192.0.1.1'];
        yield 'google dns v6' => ['2001:4860:4860::8888'];
        yield 'cloudflare v6' => ['2606:4700:4700::1111'];
        yield 'public v4 in mapped form' => ['::ffff:8.8.8.8'];
        yield 'public v4 in mapped HEX form' => ['::ffff:808:808'];
        yield 'NAT64 wrapping a public v4' => ['64:ff9b::808:808'];
    }

    /** @dataProvider publicAddresses */
    public function testRoutableAddressesStayReachable(string $ip): void
    {
        self::assertFalse($this->isPrivate($ip), "$ip must be classified public");
    }
}

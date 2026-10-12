<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\AIService;
use PHPUnit\Framework\TestCase;

/**
 * An image URL handed to the AI provider is fetched by that provider, which may sit on the same
 * network as this server (a self-hosted model). It is held to IpSafety's rules, the ones every
 * other outbound path uses: PHP's private/reserved filter alone let carrier-grade NAT (where some
 * cloud metadata services live), benchmarking addresses and IPv6 spellings of internal addresses
 * through. Literal addresses only, so no DNS is needed.
 */
class AiImageUrlSafetyTest extends TestCase
{
    private function check(string $url): ?string
    {
        $service = (new \ReflectionClass(AIService::class))->newInstanceWithoutConstructor();
        return (new \ReflectionMethod(AIService::class, 'validateImageUrl'))->invoke($service, $url);
    }

    /** @return iterable<string, array{string}> */
    public static function internalUrls(): iterable
    {
        yield 'alibaba metadata in CGNAT' => ['https://100.100.100.200/latest/meta-data'];
        yield 'benchmarking range' => ['https://198.18.0.1/x.png'];
        yield 'metadata, IPv4-mapped hex' => ['https://[::ffff:a9fe:a9fe]/x.png'];
        yield 'metadata through NAT64' => ['https://[64:ff9b::a9fe:a9fe]/x.png'];
        yield 'loopback, IPv4-translated' => ['https://[::ffff:0:7f00:1]/x.png'];
        yield 'unique local IPv6' => ['https://[fd12::1]/x.png'];
        yield 'loopback' => ['https://127.0.0.1/x.png'];
    }

    /** @dataProvider internalUrls */
    public function testAnInternalAddressIsRefused(string $url): void
    {
        $this->assertNull($this->check($url));
    }

    public function testAPublicAddressPasses(): void
    {
        $this->assertSame('https://8.8.8.8/x.png', $this->check('https://8.8.8.8/x.png'));
    }
}

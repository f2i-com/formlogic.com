<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Helpers\IpResolver;
use PHPUnit\Framework\TestCase;

/** Whether a peer is one of Cloudflare's edges: asked only to warn the administrator, never to trust it. */
final class IpResolverCloudflareTest extends TestCase
{
    public function testCloudflaresEdgesAreKnownAndNothingElseIs(): void
    {
        foreach (['104.16.1.1', '172.64.0.1', '162.159.200.1', '2606:4700::1111', '2a06:98c1::1', '::ffff:104.16.1.1', ' 104.16.1.1 '] as $edge) {
            $this->assertTrue(IpResolver::inCloudflare($edge), $edge);
        }
        foreach (['8.8.8.8', '203.0.113.5', '127.0.0.1', '::1', '2001:db8::1', '', 'garbage', '104.16.1.1/13'] as $other) {
            $this->assertFalse(IpResolver::inCloudflare($other), $other);
        }
    }

    public function testKnowingTheEdgesTrustsNoneOfThem(): void
    {
        $request = (new \Slim\Psr7\Factory\ServerRequestFactory())->createServerRequest('GET', 'http://example.test/', [
            'REMOTE_ADDR' => '104.16.1.1', 'HTTP_X_FORWARDED_FOR' => '198.51.100.9',
        ]);
        $this->assertSame('104.16.1.1', (new IpResolver([]))->getClientIp($request), 'no forwarded header is read without TRUSTED_PROXIES');
    }
}

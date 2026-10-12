<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Helpers\IpResolver;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * Which address a request comes from, as rate limits and the audit log see it.
 *
 * Forwarding headers are read only from a configured trusted proxy, and then only the header
 * that proxy writes: every client can send all of them, and a proxy passes on the ones it does
 * not set. A proxy that sets X-Real-IP and leaves X-Forwarded-For alone hands on whatever
 * X-Forwarded-For the client wrote, so behind it X-Forwarded-For must not be read at all
 * (TRUSTED_PROXY_HEADER=x-real-ip).
 */
class IpResolverTest extends TestCase
{
    /** @param array<string, string> $server */
    private function ip(IpResolver $resolver, array $server): string
    {
        $request = (new ServerRequestFactory())->createServerRequest('GET', 'http://formlogic.local/api/health', $server);
        return $resolver->getClientIp($request);
    }

    public function testWithoutATrustedProxyOnlyThePeerCounts(): void
    {
        $this->assertSame('198.51.100.9', $this->ip(new IpResolver(), [
            'REMOTE_ADDR' => '198.51.100.9', 'HTTP_X_FORWARDED_FOR' => '203.0.113.1', 'HTTP_X_REAL_IP' => '203.0.113.2',
        ]));
        $this->assertSame('198.51.100.9', $this->ip(new IpResolver(['10.0.0.0/8']), [
            'REMOTE_ADDR' => '198.51.100.9', 'HTTP_X_FORWARDED_FOR' => '203.0.113.1',
        ]), 'a peer outside the trusted proxies is the client, whatever it sends');
    }

    public function testBehindAnXForwardedForProxyTheRightmostUntrustedHopCounts(): void
    {
        $resolver = new IpResolver(['10.0.0.0/8']);
        $this->assertSame('198.51.100.7', $this->ip($resolver, [
            'REMOTE_ADDR' => '10.0.0.2', 'HTTP_X_FORWARDED_FOR' => '6.6.6.6, 198.51.100.7, 10.0.0.5',
        ]), 'what the client prepended is ignored');
    }

    public function testBehindAnXRealIpProxyAClientSentXForwardedForIsIgnored(): void
    {
        $resolver = new IpResolver(['10.0.0.0/8'], 'x-real-ip');
        $this->assertSame('198.51.100.7', $this->ip($resolver, [
            'REMOTE_ADDR' => '10.0.0.2', 'HTTP_X_REAL_IP' => '198.51.100.7', 'HTTP_X_FORWARDED_FOR' => '6.6.6.6',
        ]));
        // With nothing from the proxy, the peer itself, never the client's X-Forwarded-For.
        $this->assertSame('10.0.0.2', $this->ip($resolver, ['REMOTE_ADDR' => '10.0.0.2', 'HTTP_X_FORWARDED_FOR' => '6.6.6.6']));
    }

    public function testTheHeaderIsReadFromTheEnvironment(): void
    {
        $previous = [getenv('TRUSTED_PROXIES'), getenv('TRUSTED_PROXY_HEADER')];
        putenv('TRUSTED_PROXIES=10.0.0.0/8');
        putenv('TRUSTED_PROXY_HEADER=X-Real-IP');
        try {
            $this->assertSame('198.51.100.7', $this->ip(IpResolver::fromEnvironment(), [
                'REMOTE_ADDR' => '10.0.0.2', 'HTTP_X_REAL_IP' => '198.51.100.7', 'HTTP_X_FORWARDED_FOR' => '6.6.6.6',
            ]));
        } finally {
            putenv($previous[0] === false ? 'TRUSTED_PROXIES' : 'TRUSTED_PROXIES=' . $previous[0]);
            putenv($previous[1] === false ? 'TRUSTED_PROXY_HEADER' : 'TRUSTED_PROXY_HEADER=' . $previous[1]);
        }
    }

    public function testAnUnknownHeaderNameTrustsNoHeader(): void
    {
        $this->assertSame('10.0.0.2', $this->ip(new IpResolver(['10.0.0.0/8'], 'x-forwarded-four'), [
            'REMOTE_ADDR' => '10.0.0.2', 'HTTP_X_FORWARDED_FOR' => '198.51.100.7',
        ]));
    }

    public function testRateLimitSubjects(): void
    {
        $this->assertSame('203.0.113.10', IpResolver::rateLimitSubject('203.0.113.10'));
        $this->assertSame('2001:db8:1:2::/64', IpResolver::rateLimitSubject('2001:db8:1:2:ffff:ffff:ffff:1'));
        $this->assertSame('2001:db8:1:2::/64', IpResolver::rateLimitSubject('2001:DB8:1:2::10'));
        $this->assertSame('198.51.100.7', IpResolver::rateLimitSubject('::ffff:198.51.100.7'));
        $this->assertSame('not an address', IpResolver::rateLimitSubject('not an address'));
    }
}

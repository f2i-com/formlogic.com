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

    /**
     * A name that is none of the three is a typo, and a typo must not cost the site its logins:
     * read as "trust no header" it made every client the proxy's own address, so all of them
     * shared one rate-limit budget and a handful of requests locked everyone out. It is read as
     * if unset (the default header order) and reported to the operator instead.
     */
    public function testAMisspeltHeaderNameIsReadAsUnsetNotAsOneSharedAddress(): void
    {
        $resolver = new IpResolver(['10.0.0.0/8'], 'x-forwarded-four');
        $first = $this->ip($resolver, ['REMOTE_ADDR' => '10.0.0.2', 'HTTP_X_FORWARDED_FOR' => '198.51.100.7']);
        $second = $this->ip($resolver, ['REMOTE_ADDR' => '10.0.0.2', 'HTTP_X_FORWARDED_FOR' => '198.51.100.8']);
        $this->assertSame('198.51.100.7', $first);
        $this->assertSame('198.51.100.8', $second, 'two clients behind the proxy stay two addresses');
        $this->assertSame('198.51.100.9', $this->ip($resolver, ['REMOTE_ADDR' => '10.0.0.2', 'HTTP_X_REAL_IP' => '198.51.100.9']), 'the default order, as when unset');
    }

    public function testAMisspeltHeaderNameIsReportedToTheOperator(): void
    {
        $problem = IpResolver::forwardedHeaderProblem('x-forwarded-four');
        $this->assertIsString($problem);
        $this->assertStringContainsString('x-forwarded-four', $problem);
        foreach (['x-forwarded-for', 'x-real-ip', 'client-ip'] as $supported) {
            $this->assertStringContainsString($supported, $problem, 'the message names what may be set');
        }
        // "Forwarded" (RFC 7239) is a real header this resolver does not read.
        $this->assertIsString(IpResolver::forwardedHeaderProblem('Forwarded'));

        foreach ([null, '', '  ', 'x-real-ip', 'X-Forwarded-For', 'Client-IP'] as $fine) {
            $this->assertNull(IpResolver::forwardedHeaderProblem($fine), var_export($fine, true) . ' is no problem');
        }
    }

    /** The name is a header name however an operator writes it: PHP's own spelling included. */
    public function testTheHeaderNameIsReadAsCommonlyWritten(): void
    {
        foreach (['X_Real_IP', 'HTTP_X_REAL_IP', 'x-real-ip:', ' X-REAL-IP '] as $spelling) {
            $this->assertNull(IpResolver::forwardedHeaderProblem($spelling), $spelling);
            $resolver = new IpResolver(['10.0.0.0/8'], $spelling);
            $this->assertSame('198.51.100.7', $this->ip($resolver, [
                'REMOTE_ADDR' => '10.0.0.2', 'HTTP_X_REAL_IP' => '198.51.100.7', 'HTTP_X_FORWARDED_FOR' => '6.6.6.6',
            ]), $spelling);
            $this->assertSame('10.0.0.2', $this->ip($resolver, ['REMOTE_ADDR' => '10.0.0.2', 'HTTP_X_FORWARDED_FOR' => '6.6.6.6']), "$spelling names X-Real-IP alone");
        }
    }

    /**
     * What the health report shows (GET /api/health/deep, the admin Doctor page): ok while the
     * settings can be used, a warning naming each problem while they cannot.
     */
    public function testTheHealthCheckNamesWhatIsWrongWithTheEnvironment(): void
    {
        $previous = [getenv('TRUSTED_PROXIES'), getenv('TRUSTED_PROXY_HEADER')];
        $previousEnv = [$_ENV['TRUSTED_PROXIES'] ?? null, $_ENV['TRUSTED_PROXY_HEADER'] ?? null];
        unset($_ENV['TRUSTED_PROXIES'], $_ENV['TRUSTED_PROXY_HEADER']);
        try {
            putenv('TRUSTED_PROXIES');
            putenv('TRUSTED_PROXY_HEADER');
            $check = IpResolver::healthCheck();
            $this->assertTrue($check['ok']);
            $this->assertFalse($check['critical']);
            $this->assertArrayNotHasKey('warning', $check);

            putenv('TRUSTED_PROXIES=10.0.0.0/8, 2001:db8::/32, 172.16.0.1');
            putenv('TRUSTED_PROXY_HEADER=x-real-ip');
            $check = IpResolver::healthCheck();
            $this->assertTrue($check['ok'], json_encode($check));
            $this->assertStringContainsString('x-real-ip', $check['detail']);

            putenv('TRUSTED_PROXY_HEADER=x-forwarded-four');
            $check = IpResolver::healthCheck();
            $this->assertFalse($check['ok'], 'an unrecognised header name is not ok');
            $this->assertFalse($check['critical'], 'the site still serves: it is read as unset');
            $this->assertStringContainsString('TRUSTED_PROXY_HEADER', $check['warning'] ?? '');
            $this->assertStringContainsString('x-forwarded-four', $check['warning'] ?? '');

            // An entry that can match no address leaves the proxy untrusted, which is the same
            // lockout: every client is then the proxy's address.
            putenv('TRUSTED_PROXY_HEADER');
            foreach (['proxy.internal', '10.0.0.0/33', '10.0.0.0/8/2', '2001:db8::/129', '10.0.0.0/x'] as $bad) {
                putenv('TRUSTED_PROXIES=10.0.0.0/8,' . $bad);
                $check = IpResolver::healthCheck();
                $this->assertFalse($check['ok'], $bad);
                $this->assertStringContainsString('TRUSTED_PROXIES', $check['warning'] ?? '', $bad);
                $this->assertStringContainsString($bad, $check['warning'] ?? '', $bad);
            }

            // A header named with no proxy to read it from does nothing, which is worth saying.
            putenv('TRUSTED_PROXIES');
            putenv('TRUSTED_PROXY_HEADER=x-real-ip');
            $check = IpResolver::healthCheck();
            $this->assertFalse($check['ok']);
            $this->assertStringContainsString('TRUSTED_PROXIES', $check['warning'] ?? '');
        } finally {
            putenv($previous[0] === false ? 'TRUSTED_PROXIES' : 'TRUSTED_PROXIES=' . $previous[0]);
            putenv($previous[1] === false ? 'TRUSTED_PROXY_HEADER' : 'TRUSTED_PROXY_HEADER=' . $previous[1]);
            foreach (['TRUSTED_PROXIES', 'TRUSTED_PROXY_HEADER'] as $i => $name) {
                if ($previousEnv[$i] !== null) {
                    $_ENV[$name] = $previousEnv[$i];
                }
            }
        }
    }

    /**
     * An operator who never opens the Doctor page still has PHP's error log. The resolver is
     * built on every request, so the same problem is written there at most once an hour, and a
     * usable configuration writes nothing.
     */
    public function testAProblemIsWrittenToTheErrorLogOnceAnHour(): void
    {
        $typo = 'x-forwarded-' . bin2hex(random_bytes(4)); // unique: no marker from an earlier run
        $log = (string) tempnam(sys_get_temp_dir(), 'fli');
        $previous = [getenv('TRUSTED_PROXIES'), getenv('TRUSTED_PROXY_HEADER')];
        $previousEnv = [$_ENV['TRUSTED_PROXIES'] ?? null, $_ENV['TRUSTED_PROXY_HEADER'] ?? null];
        unset($_ENV['TRUSTED_PROXIES'], $_ENV['TRUSTED_PROXY_HEADER']);
        $previousLog = ini_set('error_log', $log);
        $problems = new \ReflectionMethod(IpResolver::class, 'problems');
        $marker = new \ReflectionMethod(IpResolver::class, 'problemMarker');
        $markerPath = (string) $marker->invoke(null, $problems->invoke(null, ['10.0.0.0/8'], $typo));
        try {
            putenv('TRUSTED_PROXIES=10.0.0.0/8');
            putenv('TRUSTED_PROXY_HEADER=x-real-ip');
            IpResolver::fromEnvironment();
            $this->assertSame('', (string) file_get_contents($log), 'nothing to say about a usable configuration');

            putenv('TRUSTED_PROXY_HEADER=' . $typo);
            $resolver = IpResolver::fromEnvironment();
            IpResolver::fromEnvironment();
            IpResolver::fromEnvironment();
            $written = (string) file_get_contents($log);
            $this->assertSame(1, substr_count($written, $typo), 'one line for three requests');
            $this->assertStringContainsString('TRUSTED_PROXY_HEADER', $written);
            $this->assertSame('198.51.100.7', $this->ip($resolver, ['REMOTE_ADDR' => '10.0.0.2', 'HTTP_X_FORWARDED_FOR' => '198.51.100.7']), 'and the resolver it built reads as unset');

            // An hour on, it is said again.
            touch($markerPath, time() - 3700);
            IpResolver::fromEnvironment();
            $this->assertSame(2, substr_count((string) file_get_contents($log), $typo));
        } finally {
            ini_set('error_log', $previousLog === false ? '' : $previousLog);
            putenv($previous[0] === false ? 'TRUSTED_PROXIES' : 'TRUSTED_PROXIES=' . $previous[0]);
            putenv($previous[1] === false ? 'TRUSTED_PROXY_HEADER' : 'TRUSTED_PROXY_HEADER=' . $previous[1]);
            foreach (['TRUSTED_PROXIES', 'TRUSTED_PROXY_HEADER'] as $i => $name) {
                if ($previousEnv[$i] !== null) {
                    $_ENV[$name] = $previousEnv[$i];
                }
            }
            @unlink($log);
            @unlink($markerPath);
        }
    }

    /**
     * The check is only worth having where the operator looks: the deep health route in
     * public/index.php adds it to the report the admin Doctor page draws (it shows any check it
     * is sent). The front controller is not loaded by this suite, so its wiring is read.
     */
    public function testTheDeepHealthRouteCarriesTheCheck(): void
    {
        $index = (string) file_get_contents(dirname(__DIR__, 2) . '/public/index.php');
        $route = substr($index, (int) strpos($index, "\$app->get('/api/health/deep'"), 1200);
        $this->assertStringContainsString("['checks']['client_addresses'] = \\FormLogic\\Helpers\\IpResolver::healthCheck()", $route);
    }

    /**
     * A dual-stack listener reports an IPv4 peer as ::ffff:a.b.c.d. That is the IPv4 address:
     * the proxy listed as 10.0.0.0/8 is still the trusted proxy, or again every client behind
     * it is counted as the proxy.
     */
    public function testAProxySeenAsAnIpv4MappedAddressIsStillTheTrustedProxy(): void
    {
        $resolver = new IpResolver(['10.0.0.0/8']);
        $this->assertSame('198.51.100.7', $this->ip($resolver, [
            'REMOTE_ADDR' => '::ffff:10.0.0.2', 'HTTP_X_FORWARDED_FOR' => '198.51.100.7',
        ]));
        $this->assertSame('198.51.100.7', $this->ip($resolver, [
            'REMOTE_ADDR' => '::ffff:10.0.0.2', 'HTTP_X_FORWARDED_FOR' => '198.51.100.7, ::ffff:10.0.0.5',
        ]), 'a mapped proxy hop in the chain is skipped like the proxy it is');
        $this->assertSame('198.51.100.7', $this->ip(new IpResolver(['10.0.0.2']), [
            'REMOTE_ADDR' => '::ffff:10.0.0.2', 'HTTP_X_FORWARDED_FOR' => '198.51.100.7',
        ]), 'an exact entry too');
        // A mapped peer outside the trusted set is still just a client.
        $this->assertSame('::ffff:198.51.100.9', $this->ip($resolver, [
            'REMOTE_ADDR' => '::ffff:198.51.100.9', 'HTTP_X_FORWARDED_FOR' => '203.0.113.1',
        ]));
    }

    /**
     * A TRUSTED_PROXIES entry that is not an address or address/bits matches no peer. Read
     * loosely, "10.0.0.0/" was a /0, which trusted every peer (any client then names its own
     * address in X-Forwarded-For), and "10.0.0.0/33" was a negative bit shift, an error on
     * every request from an IPv4 peer. The usable entries beside it still apply.
     */
    public function testAnEntryThatIsNotARangeMatchesNoPeer(): void
    {
        foreach (['10.0.0.0/', '10.0.0.0/x', '0.0.0.0/-1', 'proxy.internal/8'] as $bad) {
            $this->assertSame('198.51.100.9', $this->ip(new IpResolver([$bad]), [
                'REMOTE_ADDR' => '198.51.100.9', 'HTTP_X_FORWARDED_FOR' => '6.6.6.6',
            ]), "$bad must not make an arbitrary peer a trusted proxy");
        }
        // What used to match by accident keeps matching (and is reported): making it match
        // nothing would turn a working site into one where every client is the proxy.
        $this->assertSame('198.51.100.7', $this->ip(new IpResolver(['10.0.0.0/8/2']), [
            'REMOTE_ADDR' => '10.0.0.2', 'HTTP_X_FORWARDED_FOR' => '198.51.100.7',
        ]));
        $this->assertSame('10.0.0.2', $this->ip(new IpResolver(['10.0.0.0/33']), [
            'REMOTE_ADDR' => '10.0.0.2', 'HTTP_X_FORWARDED_FOR' => '6.6.6.6',
        ]));
        $this->assertSame('198.51.100.7', $this->ip(new IpResolver(['10.0.0.0/33', '10.0.0.0/8']), [
            'REMOTE_ADDR' => '10.0.0.2', 'HTTP_X_FORWARDED_FOR' => '198.51.100.7',
        ]));
        // /0 written as such is the operator's own choice and still means every peer.
        $this->assertSame('198.51.100.7', $this->ip(new IpResolver(['0.0.0.0/0']), [
            'REMOTE_ADDR' => '203.0.113.5', 'HTTP_X_FORWARDED_FOR' => '198.51.100.7',
        ]));
    }

    /** An exact IPv6 entry is an address, not a string: any spelling of it is that proxy. */
    public function testAnExactIpv6ProxyMatchesHoweverItIsSpelt(): void
    {
        foreach (['2001:DB8::1', '2001:0db8:0:0:0:0:0:1', '2001:db8::1'] as $spelling) {
            $this->assertSame('198.51.100.7', $this->ip(new IpResolver([$spelling]), [
                'REMOTE_ADDR' => '2001:db8::1', 'HTTP_X_FORWARDED_FOR' => '198.51.100.7',
            ]), $spelling);
        }
        $this->assertSame('2001:db8::2', $this->ip(new IpResolver(['2001:db8::1']), [
            'REMOTE_ADDR' => '2001:db8::2', 'HTTP_X_FORWARDED_FOR' => '198.51.100.7',
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

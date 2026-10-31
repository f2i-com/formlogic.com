<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Middleware\CsrfMiddleware;
use FormLogic\Support\AppDomainSession;
use FormLogic\Support\SessionOriginPolicy;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * What an app's connected domain may do about sessions, being on no configured list: spend a code
 * from the platform, and nothing else. The list itself must not change: SessionOriginPolicyTest
 * pins it.
 */
final class AppDomainSignInOriginTest extends TestCase
{
    private const SECRET = 'inert-csrf-unit-context';
    private const PLATFORM = 'https://formlogic.example';
    private const DOMAIN = 'https://shop.acme.com';
    private const EXCHANGE = '/api/auth/app-domain/exchange';
    /** Connected, then unpublished or taken offline: proven, but not live. */
    private const DARK = 'https://dark.acme.com';

    /** @return array{int, mixed} status, and the sign-in attribute the handler saw */
    private function guard(ServerRequestInterface $request, bool $httpsOnly = true, array $listed = [self::PLATFORM]): array
    {
        $handler = new class implements RequestHandlerInterface {
            public ?ServerRequestInterface $request = null;
            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                $this->request = $request;
                return new Response(204);
            }
        };
        $connected = static fn (string $host): ?array => $host === 'shop.acme.com' ? ['appId' => 'app-1', 'host' => $host] : null;
        $proven = static fn (string $host): bool => in_array($host, ['shop.acme.com', 'dark.acme.com'], true);
        $middleware = new CsrfMiddleware('formlogic_csrf', 'X-CSRF-Token', 'formlogic_auth', self::SECRET, $listed, $connected, $httpsOnly, $proven);
        $response = $middleware->process($request, $handler);
        return [$response->getStatusCode(), $handler->request?->getAttribute(AppDomainSession::SIGN_IN_ATTRIBUTE)];
    }

    private function signIn(string $origin, string $host = 'shop.acme.com', string $path = self::EXCHANGE, ?string $site = 'same-origin'): ServerRequestInterface
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', 'https://' . $host . $path)
            ->withHeader('Host', $host)
            ->withHeader('Content-Type', 'application/json')
            ->withHeader('Origin', $origin);
        return $site === null ? $request : $request->withHeader('Sec-Fetch-Site', $site);
    }

    public function testAConnectedDomainSpendsItsCodeForItsAppAlone(): void
    {
        self::assertSame([204, ['appId' => 'app-1', 'host' => 'shop.acme.com']], $this->guard($this->signIn(self::DOMAIN)));
    }

    public function testNoPasswordIsTakenOnAConnectedDomain(): void
    {
        foreach (['/api/auth/login', '/api/auth/register', '/api/auth/mfa/verify', '/api/demo/start'] as $path) {
            self::assertSame([403, null], $this->guard($this->signIn(self::DOMAIN, path: $path)), $path);
        }
    }

    public function testTheConfiguredOriginStaysAPlatformSignIn(): void
    {
        self::assertSame([204, null], $this->guard($this->signIn(self::PLATFORM, 'formlogic.example', '/api/auth/login')));
    }

    public function testThePlatformSpendsNoCodes(): void
    {
        self::assertSame([403, null], $this->guard($this->signIn(self::PLATFORM, 'formlogic.example')));
    }

    public function testListingADomainGivesItNoPlatformSession(): void
    {
        // Listing one was the only way to sign in on it before: such a server must not go on, live
        // or not. Unpublishing the app must not turn the listing back into a platform sign-in.
        $listed = [self::PLATFORM, self::DOMAIN, self::DARK];
        foreach ([self::DOMAIN, self::DARK] as $origin) {
            $host = (string) parse_url($origin, PHP_URL_HOST);
            foreach (['/api/auth/login', '/api/auth/register', '/api/auth/mfa/verify', '/api/demo/start'] as $path) {
                self::assertSame([403, null], $this->guard($this->signIn($origin, $host, $path), true, $listed), $origin . $path);
                // A page there, posting across to the platform's own name.
                self::assertSame([403, null], $this->guard($this->signIn($origin, 'formlogic.example', $path, 'cross-site'), true, $listed), $origin . $path);
            }
        }
        // A listed origin no owner has proven is still the operator's to trust.
        self::assertSame([204, null], $this->guard($this->signIn('https://staff.acme.com', 'staff.acme.com', '/api/auth/login'), true, [self::PLATFORM, 'https://staff.acme.com']));
    }

    public function testAHostThatIsNotConnectedIsRefused(): void
    {
        self::assertSame(403, $this->guard($this->signIn('https://other.acme.com', 'other.acme.com'))[0]);
        self::assertSame(403, $this->guard($this->signIn(self::DARK, 'dark.acme.com'))[0], 'proven, but not live');
    }

    public function testTheOriginMustBeTheHostTheRequestReached(): void
    {
        // The domain's owner has repointed the name, and their page posts to this server.
        self::assertSame(403, $this->guard($this->signIn(self::DOMAIN, 'formlogic.example'))[0]);
        self::assertSame(403, $this->guard($this->signIn(self::DOMAIN, 'formlogic.example', site: null))[0]);
        self::assertSame(403, $this->guard($this->signIn(self::DOMAIN, 'shop.acme.com.evil.net'))[0]);
    }

    public function testAnotherPortIsAFetchMetadataMatter(): void
    {
        // Slim drops the port from Host and a TLS proxy changes it, so only the browser can say.
        self::assertSame(204, $this->guard($this->signIn('https://shop.acme.com:8443', 'shop.acme.com'))[0]);
        self::assertSame(403, $this->guard($this->signIn('https://shop.acme.com:8443', 'shop.acme.com', site: 'same-site'))[0]);
    }

    public function testFetchMetadataMustAgree(): void
    {
        foreach (['cross-site', 'same-site', 'none'] as $site) {
            self::assertSame(403, $this->guard($this->signIn(self::DOMAIN, site: $site))[0], $site);
        }
    }

    public function testPlainHttpIsRefusedWhereHttpsIsRequired(): void
    {
        self::assertSame(403, $this->guard($this->signIn('http://shop.acme.com', site: null))[0]);
        self::assertSame(204, $this->guard($this->signIn('http://shop.acme.com', site: null), false)[0], 'a local test server has no TLS');
    }

    public function testNoOriginIsRefused(): void
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', self::DOMAIN . self::EXCHANGE)
            ->withHeader('Host', 'shop.acme.com')->withHeader('Content-Type', 'application/json');
        self::assertSame(403, $this->guard($request)[0]);
    }

    public function testAnEncodedRouteIsJudgedAsTheRouterMatchesIt(): void
    {
        self::assertSame(403, $this->guard($this->signIn(self::DOMAIN, path: '/api/auth/logi%6E'))[0]);
        self::assertSame([204, ['appId' => 'app-1', 'host' => 'shop.acme.com']], $this->guard($this->signIn(self::DOMAIN, path: '/api/auth/app-domain/exchang%65')));
    }

    public function testADefaultPortIsTheSameHost(): void
    {
        self::assertSame('shop.acme.com', SessionOriginPolicy::sameHostOrigin($this->signIn('https://shop.acme.com:443'), true));
        self::assertSame('shop.acme.com', SessionOriginPolicy::sameHostOrigin($this->signIn(self::DOMAIN, 'SHOP.acme.com:443'), true));
    }

    public function testAMalformedOriginIsRefused(): void
    {
        foreach (['null', '*', 'https://shop.acme.com/path', 'https://user@shop.acme.com'] as $origin) {
            self::assertNull(SessionOriginPolicy::sameHostOrigin($this->signIn($origin), true), $origin);
        }
    }
}

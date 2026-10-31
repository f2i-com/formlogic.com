<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Middleware\AuthMiddleware;
use FormLogic\Models\User;
use FormLogic\Services\AuthService;
use FormLogic\Support\AppDomainSession;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * A session from a sign-in on an app's connected domain, which that domain's owner could be
 * holding: it opens that app on that host, while the domain is still connected to it, and
 * nothing else. The refusals are the point of these tests.
 */
final class AppDomainSessionScopeTest extends TestCase
{
    private const HOST = 'shop.acme.com';
    private const SESSION = ['appId' => 'app-1', 'host' => self::HOST];

    /** @var array{id: string, slug: string}|null */
    private ?array $connected = ['id' => 'app-1', 'slug' => 'shop'];

    private function auth(): AuthService
    {
        $auth = $this->createMock(AuthService::class);
        // validateToken refuses it, as it does for real (AppDomainTokenTest): another audience.
        $auth->method('validateToken')->willReturn(null);
        $auth->method('validateAppDomainToken')->willReturn(self::SESSION + ['user' => new User('member-1', 'member@example.invalid')]);
        return $auth;
    }

    /** @return array{int, ?ServerRequestInterface, ?array<string, mixed>} */
    private function visit(string $path, bool $optional = false, string $host = self::HOST): array
    {
        $handler = new class implements RequestHandlerInterface {
            public ?ServerRequestInterface $request = null;
            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                $this->request = $request;
                return new Response(204);
            }
        };
        $request = (new ServerRequestFactory())->createServerRequest('GET', 'https://' . $host . $path)
            ->withHeader('Host', $host)
            ->withHeader('Authorization', 'Bearer scoped-sentinel');
        $sessions = new AppDomainSession(fn (string $seen): ?array => $seen === self::HOST ? $this->connected : null);
        $response = (new AuthMiddleware($this->auth(), $optional, 'formlogic_auth', $sessions))->process($request, $handler);
        return [$response->getStatusCode(), $handler->request, json_decode((string) $response->getBody(), true)];
    }

    public function testOpensItsOwnAppsRoutes(): void
    {
        foreach (['/api/app/shop', '/api/app/shop/native', '/api/app/shop/native/request', '/api/app/SHOP/entry', '/api/app/sh%6Fp/native'] as $path) {
            [$status, $request] = $this->visit($path);
            self::assertSame(204, $status, $path);
            self::assertSame('member-1', $request?->getAttribute('userId'), $path);
            self::assertNotNull($request?->getAttribute(AppDomainSession::ATTRIBUTE), $path);
        }
    }

    public function testKeepsTheSignedInStateOfTheApp(): void
    {
        foreach (['/api/auth/me', '/api/auth/logout'] as $path) {
            self::assertSame(204, $this->visit($path)[0], $path);
        }
    }

    public function testNoPlatformRouteOpens(): void
    {
        $platform = ['/api/forms', '/api/apps', '/api/apps/app-1/domains', '/api/auth/mfa', '/api/auth/me/', '/api/user/api-keys',
            '/api/account/backup', '/api/admin/users', '/api/flows', '/api/desktop/connections', '/api/%61pps', '/api/application'];
        foreach ($platform as $path) {
            [$status, $request, $body] = $this->visit($path);
            self::assertSame(403, $status, $path);
            self::assertNull($request, $path . ' reached its handler');
            self::assertSame(AppDomainSession::OUT_OF_SCOPE, $body['code'] ?? null, $path);
        }
    }

    public function testAnotherAppStaysClosed(): void
    {
        foreach (['/api/app/other', '/api/app/other/native', '/api/app/shop2/native', '/api/app/sho/native'] as $path) {
            [$status, $request] = $this->visit($path);
            self::assertSame(403, $status, $path);
            self::assertNull($request, $path);
        }
    }

    public function testAnotherHostStaysClosed(): void
    {
        foreach (['formlogic.com', 'shop.acme.com.evil.net', 'acme.com'] as $host) {
            [$status, $request] = $this->visit('/api/app/shop/native', false, $host);
            self::assertSame(403, $status, $host);
            self::assertNull($request, $host);
        }
        self::assertSame(204, $this->visit('/api/app/shop/native', false, self::HOST . ':8443')[0], 'a port is not another host');
    }

    public function testEndsWhenTheDomainIsDisconnected(): void
    {
        $this->connected = null;
        foreach (['/api/app/shop/native', '/api/auth/me'] as $path) {
            self::assertSame(403, $this->visit($path)[0], $path);
        }
    }

    public function testEndsWhenTheDomainMovesToAnotherApp(): void
    {
        $this->connected = ['id' => 'app-2', 'slug' => 'shop'];
        self::assertSame(403, $this->visit('/api/app/shop/native')[0]);
    }

    public function testFollowsARenamedApp(): void
    {
        $this->connected = ['id' => 'app-1', 'slug' => 'store'];
        self::assertSame(204, $this->visit('/api/app/store/native')[0]);
        self::assertSame(403, $this->visit('/api/app/shop/native')[0]);
    }

    public function testAnOptionalRouteTreatsItAsAnonymousOutsideItsScope(): void
    {
        [$status, $request] = $this->visit('/api/public/config', true);
        self::assertSame(204, $status);
        self::assertNull($request?->getAttribute('user'));
        self::assertNull($request?->getAttribute('userId'));
        self::assertNull($request?->getAttribute(AppDomainSession::ATTRIBUTE));
    }

    public function testARefusalIsNeverA401(): void
    {
        // A 401 is what the client reads as an expired session: one stray platform call from
        // inside the app would sign the visitor out of it.
        self::assertNotSame(401, $this->visit('/api/forms')[0]);
    }

    public function testASessionLeftOnAReusedRequestIsCleared(): void
    {
        $auth = $this->createMock(AuthService::class);
        $auth->method('validateToken')->willReturn(new User('platform-1', 'platform@example.invalid'));
        $handler = new class implements RequestHandlerInterface {
            public ?ServerRequestInterface $request = null;
            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                $this->request = $request;
                return new Response(204);
            }
        };
        $request = (new ServerRequestFactory())->createServerRequest('GET', 'https://formlogic.com/api/forms')
            ->withHeader('Authorization', 'Bearer platform-sentinel')
            ->withAttribute(AppDomainSession::ATTRIBUTE, self::SESSION);
        (new AuthMiddleware($auth))->process($request, $handler);
        self::assertNull($handler->request?->getAttribute(AppDomainSession::ATTRIBUTE));
    }
}

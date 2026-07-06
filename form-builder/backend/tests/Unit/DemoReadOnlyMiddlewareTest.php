<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Middleware\DemoReadOnlyMiddleware;
use FormLogic\Models\User;
use FormLogic\Services\AuthService;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response as SlimResponse;

/**
 * The demo read-only gate must never trap a visitor INSIDE the demo: the public auth routes
 * (register/login/forgot/reset + logout) are the escape hatches from the shared demo session,
 * so they stay allowed even while the browser still carries the demo auth cookie. Regression
 * for the "submitting the signup form from inside the demo 403s until you refresh" bug.
 */
class DemoReadOnlyMiddlewareTest extends TestCase
{
    private const DEMO_EMAIL = 'demo@formlogic.test';

    private function middleware(): DemoReadOnlyMiddleware
    {
        $auth = $this->createMock(AuthService::class);
        $auth->method('validateToken')->willReturnCallback(function (string $token): ?User {
            if ($token === 'demo-token') {
                return new User(id: 'demo-id', email: self::DEMO_EMAIL);
            }
            if ($token === 'real-token') {
                return new User(id: 'real-id', email: 'someone@example.com');
            }
            return null;
        });
        return new DemoReadOnlyMiddleware($auth, self::DEMO_EMAIL);
    }

    /** @return array{response: ResponseInterface, handled: bool} */
    private function dispatch(string $method, string $path, ?string $cookieToken): array
    {
        $request = (new ServerRequestFactory())->createServerRequest($method, 'http://formlogic.local' . $path);
        if ($cookieToken !== null) {
            $request = $request->withCookieParams(['formlogic_auth' => $cookieToken]);
        }
        $handled = false;
        $handler = new class($handled) implements RequestHandlerInterface {
            public function __construct(private bool &$handled) {}
            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                $this->handled = true;
                return (new SlimResponse())->withStatus(200);
            }
        };
        $response = $this->middleware()->process($request, $handler);
        return ['response' => $response, 'handled' => $handled];
    }

    public function testDemoSessionCanEscapeViaEveryPublicAuthRoute(): void
    {
        // The regression: a browser still carrying the demo cookie must be able to sign up,
        // sign in as another account, and run the password-reset flow.
        foreach ([
            '/api/auth/register',
            '/api/auth/login',
            '/api/auth/forgot-password',
            '/api/auth/reset-password',
            '/api/auth/logout',
            '/api/demo/start',
        ] as $path) {
            $r = $this->dispatch('POST', $path, 'demo-token');
            $this->assertTrue($r['handled'], "$path must pass through for the demo session");
            $this->assertSame(200, $r['response']->getStatusCode(), "$path must not be demo-blocked");
        }
    }

    public function testDemoSessionIsStillBlockedFromRealWrites(): void
    {
        $r = $this->dispatch('POST', '/api/apps', 'demo-token');
        $this->assertFalse($r['handled'], 'a demo mutation must not reach the handler');
        $this->assertSame(403, $r['response']->getStatusCode());
        $body = (string) $r['response']->getBody();
        $this->assertStringContainsString('demo_readonly', $body);
    }

    public function testNonDemoUserWritesPassThrough(): void
    {
        $r = $this->dispatch('POST', '/api/apps', 'real-token');
        $this->assertTrue($r['handled']);
        $this->assertSame(200, $r['response']->getStatusCode());
    }

    public function testReadsAlwaysPassEvenForDemo(): void
    {
        $r = $this->dispatch('GET', '/api/apps', 'demo-token');
        $this->assertTrue($r['handled']);
    }

    public function testAnonymousWritesPassThroughToNormalAuthHandling(): void
    {
        // No cookie at all: the gate is not an auth layer — downstream auth decides.
        $r = $this->dispatch('POST', '/api/apps', null);
        $this->assertTrue($r['handled']);
    }
}

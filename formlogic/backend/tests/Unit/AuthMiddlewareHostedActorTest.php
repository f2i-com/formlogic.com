<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Middleware\AuthMiddleware;
use FormLogic\Models\User;
use FormLogic\Services\AuthService;
use FormLogic\Support\HostedActorContext;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

final class AuthMiddlewareHostedActorTest extends TestCase
{
    public function testOnlyValidatedCredentialGetsDomainSeparatedContext(): void
    {
        // These are sentinel text accepted only by a mocked AuthService. No JWT,
        // account, login, key, session cookie or authentic credential is created.
        $marker = 'synthetic-validation-marker';
        $auth = $this->createMock(AuthService::class);
        $auth->expects(self::once())->method('validateToken')->with($marker)->willReturn(new User('member-a', 'synthetic@example.invalid'));
        $auth->expects(self::once())->method('touchLastSeen');
        $handler = new class implements RequestHandlerInterface {
            public ?ServerRequestInterface $request = null;
            public function handle(ServerRequestInterface $request): ResponseInterface { $this->request = $request; return new Response(204); }
        };
        $request = (new ServerRequestFactory())->createServerRequest('GET', '/')
            ->withHeader('Authorization', 'Bearer ' . $marker)
            ->withAttribute(HostedActorContext::SESSION_ATTRIBUTE, str_repeat('b', 64));
        self::assertSame(204, (new AuthMiddleware($auth))->process($request, $handler)->getStatusCode());
        $fingerprint = $handler->request?->getAttribute(HostedActorContext::SESSION_ATTRIBUTE);
        self::assertSame(hash('sha256', "formlogic.hosted-actor.session.v1\0" . $marker), $fingerprint);
        self::assertNotSame(hash('sha256', $marker), $fingerprint);
        self::assertSame('member-a', $handler->request?->getAttribute('userId'));
    }

    public function testInvalidCredentialNeverReachesHostedHandler(): void
    {
        $auth = $this->createMock(AuthService::class);
        $auth->expects(self::once())->method('validateToken')->willReturn(null);
        $auth->expects(self::never())->method('touchLastSeen');
        $handler = $this->createMock(RequestHandlerInterface::class);
        $handler->expects(self::never())->method('handle');
        $request = (new ServerRequestFactory())->createServerRequest('GET', '/')->withHeader('Authorization', 'Bearer invalid-sentinel');
        self::assertSame(401, (new AuthMiddleware($auth))->process($request, $handler)->getStatusCode());
    }

    public function testAnonymousOptionalRequestHasNoActorContext(): void
    {
        $auth = $this->createMock(AuthService::class);
        $auth->expects(self::never())->method('validateToken');
        $handler = new class implements RequestHandlerInterface {
            public ?ServerRequestInterface $request = null;
            public function handle(ServerRequestInterface $request): ResponseInterface { $this->request = $request; return new Response(204); }
        };
        $request = (new ServerRequestFactory())->createServerRequest('GET', '/')
            ->withAttribute('user', new User('stale', 'synthetic@example.invalid'))->withAttribute('userId', 'stale')
            ->withAttribute(HostedActorContext::SESSION_ATTRIBUTE, str_repeat('a', 64));
        (new AuthMiddleware($auth, true))->process($request, $handler);
        self::assertNull($handler->request?->getAttribute(HostedActorContext::SESSION_ATTRIBUTE));
        self::assertNull($handler->request?->getAttribute('user'));
        self::assertNull($handler->request?->getAttribute('userId'));
    }

    public function testOptionalInvalidCredentialClearsInheritedAuthority(): void
    {
        $auth = $this->createMock(AuthService::class);
        $auth->method('validateToken')->willReturn(null);
        $auth->expects(self::never())->method('touchLastSeen');
        $handler = new class implements RequestHandlerInterface {
            public ?ServerRequestInterface $request = null;
            public function handle(ServerRequestInterface $request): ResponseInterface { $this->request = $request; return new Response(204); }
        };
        $request = (new ServerRequestFactory())->createServerRequest('GET', '/')
            ->withHeader('Authorization', 'Bearer invalid-sentinel')
            ->withAttribute('user', new User('stale', 'synthetic@example.invalid'))->withAttribute('userId', 'stale')
            ->withAttribute(HostedActorContext::SESSION_ATTRIBUTE, str_repeat('a', 64));
        (new AuthMiddleware($auth, true))->process($request, $handler);
        self::assertNull($handler->request?->getAttribute(HostedActorContext::SESSION_ATTRIBUTE));
        self::assertNull($handler->request?->getAttribute('user'));
        self::assertNull($handler->request?->getAttribute('userId'));
    }
}

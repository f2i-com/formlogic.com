<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Middleware\BodySizeLimitMiddleware;
use FormLogic\Models\User;
use FormLogic\Services\AuthService;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

class BodySizeLimitMiddlewareTest extends TestCase
{
    private function handler(bool &$called): RequestHandlerInterface
    {
        return new class($called) implements RequestHandlerInterface {
            public function __construct(private bool &$called) {}
            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                $this->called = true;
                return new Response(204);
            }
        };
    }

    private function request(string $path, string $contentType, int $length, ?string $token = null): ServerRequestInterface
    {
        $request = (new ServerRequestFactory())
            ->createServerRequest('POST', 'https://formlogic.test' . $path)
            ->withHeader('Content-Type', $contentType)
            ->withHeader('Content-Length', (string) $length);
        return $token === null ? $request : $request->withHeader('Authorization', 'Bearer ' . $token);
    }

    public function testLargePolicyRequiresAuthenticationBeforeReadingBody(): void
    {
        $middleware = new BodySizeLimitMiddleware(100, [[
            'path' => '#^/api/import$#',
            'maxBytes' => 1000,
            'contentTypes' => ['multipart/form-data'],
            'auth' => true,
        ]]);
        $called = false;
        $response = $middleware->process(
            $this->request('/api/import', 'multipart/form-data; boundary=x', 900),
            $this->handler($called)
        );
        $this->assertSame(401, $response->getStatusCode());
        $this->assertFalse($called);
    }

    public function testWrongContentTypeCannotBorrowALargeRouteCap(): void
    {
        $middleware = new BodySizeLimitMiddleware(100, [[
            'path' => '#^/api/import$#',
            'maxBytes' => 1000,
            'contentTypes' => ['multipart/form-data'],
            'auth' => false,
        ]]);
        $called = false;
        $response = $middleware->process(
            $this->request('/api/import', 'application/json', 900),
            $this->handler($called)
        );
        $this->assertSame(413, $response->getStatusCode());
        $this->assertFalse($called);
    }

    public function testValidBearerMayUseOnlyTheExactLargePolicy(): void
    {
        $auth = $this->createMock(AuthService::class);
        $auth->method('validateToken')->with('valid-token')->willReturn(new User(id: 'u1', email: 'u@example.test'));
        $middleware = new BodySizeLimitMiddleware(100, [[
            'path' => '#^/api/import$#',
            'maxBytes' => 1000,
            'contentTypes' => ['multipart/form-data'],
            'auth' => true,
        ]], $auth);
        $called = false;
        $response = $middleware->process(
            $this->request('/api/import', 'multipart/form-data; boundary=x', 900, 'valid-token'),
            $this->handler($called)
        );
        $this->assertSame(204, $response->getStatusCode());
        $this->assertTrue($called);
    }
}

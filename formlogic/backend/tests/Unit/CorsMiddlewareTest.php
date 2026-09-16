<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Middleware\CorsMiddleware;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response as SlimResponse;

class CorsMiddlewareTest extends TestCase
{
    private function handle(CorsMiddleware $mw, ?string $origin): ResponseInterface
    {
        $request = (new ServerRequestFactory())->createServerRequest('GET', 'http://api.test/x');
        if ($origin !== null) {
            $request = $request->withHeader('Origin', $origin);
        }
        $handler = new class implements RequestHandlerInterface {
            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                return new SlimResponse(200);
            }
        };
        return $mw->process($request, $handler);
    }

    public function testAllowedOriginIsReflected(): void
    {
        $mw = new CorsMiddleware('https://app.example.com');
        $res = $this->handle($mw, 'https://app.example.com');
        $this->assertSame('https://app.example.com', $res->getHeaderLine('Access-Control-Allow-Origin'));
        $this->assertSame('true', $res->getHeaderLine('Access-Control-Allow-Credentials'));
    }

    public function testDisallowedOriginGetsNoCorsHeader(): void
    {
        $mw = new CorsMiddleware('https://app.example.com');
        $res = $this->handle($mw, 'https://evil.example.com');
        $this->assertFalse($res->hasHeader('Access-Control-Allow-Origin'));
    }

    public function testDisallowedOriginInMultiOriginModeGetsNoHeader(): void
    {
        $mw = new CorsMiddleware('https://app.example.com', ['https://app.example.com', 'https://staging.example.com']);
        $res = $this->handle($mw, 'https://evil.example.com');
        $this->assertFalse($res->hasHeader('Access-Control-Allow-Origin'));
    }

    public function testWildcardSubdomainRejectsNonDefaultPort(): void
    {
        $mw = new CorsMiddleware('https://app.example.com', ['*.example.com']);
        $ok = $this->handle($mw, 'https://team.example.com');
        $this->assertSame('https://team.example.com', $ok->getHeaderLine('Access-Control-Allow-Origin'));
        // A non-default port is a distinct origin and must not match the wildcard.
        $bad = $this->handle($mw, 'https://team.example.com:8443');
        $this->assertFalse($bad->hasHeader('Access-Control-Allow-Origin'));
    }

    public function testWildcardModeNeverSendsCredentials(): void
    {
        $mw = new CorsMiddleware('*');
        $res = $this->handle($mw, 'https://anything.example.com');
        $this->assertSame('*', $res->getHeaderLine('Access-Control-Allow-Origin'));
        $this->assertFalse($res->hasHeader('Access-Control-Allow-Credentials'));
    }

    public function testPreflightAllowsTheHostedFrameEngineHeader(): void
    {
        // HostedAppFrame sends X-FormLogic-Client-Engine on every action; on a split-origin
        // deployment the browser preflights it, and a preflight that does not list it fails every
        // action a frame makes.
        $mw = new CorsMiddleware('https://app.example.com');
        $request = (new ServerRequestFactory())->createServerRequest('OPTIONS', 'http://api.test/api/app/notes/actions/save')
            ->withHeader('Origin', 'https://app.example.com')
            ->withHeader('Access-Control-Request-Method', 'POST')
            ->withHeader('Access-Control-Request-Headers', 'content-type, x-formlogic-client-engine');
        $handler = new class implements RequestHandlerInterface {
            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                throw new \LogicException('a preflight must be answered by the middleware, not the route');
            }
        };
        $res = $mw->process($request, $handler);
        $allowed = array_map('trim', explode(',', $res->getHeaderLine('Access-Control-Allow-Headers')));
        $this->assertContains('X-FormLogic-Client-Engine', $allowed, $res->getHeaderLine('Access-Control-Allow-Headers'));
        $this->assertContains('Authorization', $allowed, 'the headers every request already needed are still listed');
        $this->assertSame('https://app.example.com', $res->getHeaderLine('Access-Control-Allow-Origin'));
    }
}

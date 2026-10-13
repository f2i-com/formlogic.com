<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Middleware\CsrfMiddleware;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response as SlimResponse;

class CsrfMiddlewareTest extends TestCase
{
    private const SECRET = 'csrf-test-secret';

    private function process(ServerRequestInterface $request): ResponseInterface
    {
        $mw = new CsrfMiddleware('formlogic_csrf', 'X-CSRF-Token', 'formlogic_auth', self::SECRET, ['http://api.test']);
        $handler = new class implements RequestHandlerInterface {
            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                return new SlimResponse(200);
            }
        };
        return $mw->process($request, $handler);
    }

    private function request(string $method, string $path): ServerRequestInterface
    {
        return (new ServerRequestFactory())->createServerRequest($method, 'http://api.test' . $path)
            ->withHeader('Origin', 'http://api.test');
    }

    public function testCookieSettingRoutesAcceptJson(): void
    {
        foreach (['/api/auth/login', '/api/auth/register', '/api/auth/mfa/verify', '/api/demo/start'] as $path) {
            foreach (['application/json', 'application/json; charset=utf-8', 'Application/JSON'] as $type) {
                $res = $this->process($this->request('POST', $path)->withHeader('Content-Type', $type));
                $this->assertSame(200, $res->getStatusCode(), "$path with $type");
            }
        }
    }

    /**
     * The guard exists because a request another site can send without a CORS preflight
     * must not reach these routes. A no-cors fetch may send any Content-Type whose
     * media type is form-urlencoded, multipart or text/plain, parameters included, and
     * Slim parses the body by that media type alone; so "application/json" appearing
     * anywhere else in the header must not count.
     */
    public function testCookieSettingRoutesRefuseSimpleMediaTypesThatMentionJson(): void
    {
        $types = [
            '',
            'application/x-www-form-urlencoded',
            'application/x-www-form-urlencoded; application/json',
            'multipart/form-data; boundary=x; application/json',
            'text/plain; application/json',
            'text/plain;charset=application/json',
        ];
        foreach (['/api/auth/login', '/api/demo/start'] as $path) {
            foreach ($types as $type) {
                $req = $this->request('POST', $path);
                if ($type !== '') {
                    $req = $req->withHeader('Content-Type', $type);
                }
                $this->assertSame(403, $this->process($req)->getStatusCode(), "$path with '$type'");
            }
        }
    }

    /**
     * Slim's router matches the percent-DECODED path (RouteResolver::computeRoutingResults), so
     * /api/auth/logi%6E runs the login route. Judged on the raw path it was not "a cookie-setting
     * route", carried no auth cookie, and so passed with no check at all: a cross-site
     * <form action=".../api/auth/logi%6E"> signed a visitor in to the attacker's account. The
     * path judged is the one the router will run. Through a real Slim app, body parsing included.
     */
    public function testAPercentEncodedPathIsJudgedAsTheRouteItRuns(): void
    {
        $reached = [];
        $app = \Slim\Factory\AppFactory::create();
        foreach (['/api/auth/login', '/api/auth/register', '/api/auth/mfa/verify', '/api/demo/start'] as $route) {
            $app->post($route, function (ServerRequestInterface $request, ResponseInterface $response) use (&$reached, $route) {
                $reached[] = [$route, (array) $request->getParsedBody()];
                return $response;
            });
        }
        $app->addBodyParsingMiddleware();
        $app->add(new CsrfMiddleware('formlogic_csrf', 'X-CSRF-Token', 'formlogic_auth', self::SECRET, ['http://api.test']));
        $app->addRoutingMiddleware();

        $form = static function (string $path): ServerRequestInterface {
            $request = (new ServerRequestFactory())->createServerRequest('POST', 'http://api.test' . $path)
                ->withHeader('Origin', 'http://api.test')
                ->withHeader('Content-Type', 'application/x-www-form-urlencoded');
            $request->getBody()->write('fixture=inert');
            $request->getBody()->rewind();
            return $request;
        };

        foreach (['/api/auth/logi%6E', '/api/auth/%6cogin', '/api%2Fauth%2Flogin', '/api/auth/regi%73ter', '/api/auth/mfa/verif%79', '/api/demo/st%61rt'] as $path) {
            $reached = [];
            $response = $app->handle($form($path));
            $this->assertSame([], $reached, "a cross-site form posted to $path must not reach the route");
            $this->assertSame(403, $response->getStatusCode(), $path);
        }

        // The same spelling with a JSON body is the SPA's own request, and still served.
        $json = (new ServerRequestFactory())->createServerRequest('POST', 'http://api.test/api/auth/logi%6E')
            ->withHeader('Origin', 'http://api.test')
            ->withHeader('Content-Type', 'application/json');
        $json->getBody()->write('{"fixture":"inert"}');
        $json->getBody()->rewind();
        $reached = [];
        $this->assertSame(200, $app->handle($json)->getStatusCode());
        $this->assertSame('/api/auth/login', $reached[0][0] ?? null);
    }

    public function testStateChangeWithAuthCookieNeedsTheTokenBoundToThatSession(): void
    {
        $auth = 'header.payload.signature';
        $base = $this->request('PUT', '/api/forms/f1')->withCookieParams(['formlogic_auth' => $auth]);

        $this->assertSame(403, $this->process($base)->getStatusCode(), 'no token');
        $this->assertSame(403, $this->process(
            $base->withHeader('X-CSRF-Token', CsrfMiddleware::tokenForAuth('another.session.token', self::SECRET))
        )->getStatusCode(), 'token of another session');
        $this->assertSame(200, $this->process(
            $base->withHeader('X-CSRF-Token', CsrfMiddleware::tokenForAuth($auth, self::SECRET))
        )->getStatusCode(), 'token of this session');
    }

    public function testReadsAndCookielessRequestsPass(): void
    {
        $this->assertSame(200, $this->process(
            $this->request('GET', '/api/forms')->withCookieParams(['formlogic_auth' => 'a.b.c'])
        )->getStatusCode());
        $this->assertSame(200, $this->process($this->request('POST', '/api/forms'))->getStatusCode());
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Middleware\CorsMiddleware;
use FormLogic\Middleware\CsrfMiddleware;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/** In-process PSR requests only: no auth controller, session, storage, or network. */
final class SessionOriginPolicyTest extends TestCase
{
    private const FRONTEND = 'https://studio.example.test';
    private const FIXTURE_SIGNING_CONTEXT = 'inert-csrf-unit-context';
    private const ROUTES = ['/api/auth/login', '/api/auth/register', '/api/auth/mfa/verify', '/api/demo/start'];

    private function request(string $path = '/api/auth/login', string $uriOrigin = 'https://api.example.test'): ServerRequestInterface
    {
        return (new ServerRequestFactory())->createServerRequest('POST', $uriOrigin . $path)
            ->withHeader('Content-Type', 'application/json');
    }

    private function runGuard(ServerRequestInterface $request, array $origins = [self::FRONTEND], string $signingContext = self::FIXTURE_SIGNING_CONTEXT): array
    {
        $handler = new class implements RequestHandlerInterface {
            public int $calls = 0;
            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                $this->calls++;
                return new Response(204);
            }
        };
        $middleware = new CsrfMiddleware('formlogic_csrf', 'X-CSRF-Token', 'formlogic_auth', $signingContext, $origins);
        $response = $middleware->process($request, $handler);
        return [$response->getStatusCode(), $handler->calls];
    }

    public function testEverySessionRouteRequiresExplicitOriginBeforeHandler(): void
    {
        foreach (self::ROUTES as $route) {
            $base = $this->request($route);
            $this->assertSame([403, 0], $this->runGuard($base), $route . ': no Origin');
            $this->assertSame([403, 0], $this->runGuard($base->withHeader('Sec-Fetch-Site', 'same-origin')), $route . ': metadata is not authority');
            $this->assertSame([403, 0], $this->runGuard($base->withHeader('Origin', 'https://untrusted.example.test')->withHeader('Sec-Fetch-Site', 'same-origin')), $route . ': misleading metadata');
            foreach (['same-origin', 'same-site', 'cross-site'] as $site) {
                $this->assertSame([204, 1], $this->runGuard($base->withHeader('Origin', self::FRONTEND)->withHeader('Sec-Fetch-Site', $site)), $route . ': configured frontend ' . $site);
            }
            $this->assertSame([204, 1], $this->runGuard($base->withHeader('Origin', self::FRONTEND)), $route . ': older client still sends trusted Origin');
        }
    }

    public function testMalformedMultipleAndOpaqueOriginsFailBeforeHandler(): void
    {
        foreach ([
            'null', '*', '', self::FRONTEND . ':', self::FRONTEND . '/', self::FRONTEND . '/path',
            self::FRONTEND . '?q=1', self::FRONTEND . '#fragment',
            'https://user@studio.example.test', 'https://studio.example.test:8443',
            'http://studio.example.test', 'https://studio.example.test.evil.test',
            'https://studio.example.test%2Fevil.test', 'https://studio.example.test\\evil.test',
            self::FRONTEND . ',https://other.example.test', self::FRONTEND . ' https://other.example.test',
        ] as $origin) {
            $this->assertSame([403, 0], $this->runGuard($this->request()->withHeader('Origin', $origin)), $origin);
        }
        foreach ([[self::FRONTEND, self::FRONTEND], [self::FRONTEND, 'https://other.example.test']] as $origins) {
            $this->assertSame([403, 0], $this->runGuard($this->request()->withHeader('Origin', $origins)), 'multiple Origin fields');
        }
    }

    public function testInvalidFetchMetadataCannotRelaxOriginAdmission(): void
    {
        $request = $this->request()->withHeader('Origin', self::FRONTEND);
        foreach (['none', '', 'unknown', 'Same-Origin', 'same-origin, cross-site'] as $site) {
            $this->assertSame([403, 0], $this->runGuard($request->withHeader('Sec-Fetch-Site', $site)), $site);
        }
        $this->assertSame([403, 0], $this->runGuard($request->withHeader('Sec-Fetch-Site', ['same-origin', 'cross-site'])));
    }

    public function testMissingMalformedAndWildcardConfigurationFailsClosed(): void
    {
        $request = $this->request()->withHeader('Origin', self::FRONTEND);
        foreach ([[], ['*'], ['*.example.test'], [self::FRONTEND, '*'], [''], [null], [42], [self::FRONTEND . '/'], ['https://user@studio.example.test'], [self::FRONTEND . ',https://other.example.test']] as $origins) {
            $this->assertSame([403, 0], $this->runGuard($request, $origins), json_encode($origins));
        }
        $sameUri = $this->request('/api/auth/login', self::FRONTEND)->withHeader('Origin', self::FRONTEND);
        $this->assertSame([403, 0], $this->runGuard($sameUri, []), 'request URI is not fallback configuration');
    }

    public function testExactOriginCanonicalizationKeepsSchemeAndPortBoundaries(): void
    {
        foreach ([
            [['https://STUDIO.example.test:443'], self::FRONTEND],
            [[self::FRONTEND], 'HTTPS://STUDIO.EXAMPLE.TEST:443'],
            [['http://localhost:80'], 'http://localhost'],
            [['https://[::1]:443'], 'https://[::1]'],
            [['https://studio.example.test:8443'], 'https://studio.example.test:8443'],
        ] as [$origins, $origin]) {
            $this->assertSame([204, 1], $this->runGuard($this->request()->withHeader('Origin', $origin), $origins), $origin);
        }
        $this->assertSame([403, 0], $this->runGuard($this->request()->withHeader('Origin', self::FRONTEND), ['https://studio.example.test:8443']));
    }

    public function testProxyHeadersCannotSupplyAuthorityAndExplicitFrontendSurvivesInternalUri(): void
    {
        $request = $this->request('/api/auth/login', 'http://internal-proxy.test:8080')
            ->withHeader('Forwarded', 'host=studio.example.test;proto=https')
            ->withHeader('X-Forwarded-Host', 'studio.example.test')
            ->withHeader('X-Forwarded-Proto', 'https')
            ->withHeader('Referer', self::FRONTEND . '/')
            ->withHeader('Sec-Fetch-Site', 'same-origin');
        $this->assertSame([403, 0], $this->runGuard($request), 'proxy headers cannot replace Origin');
        $this->assertSame([403, 0], $this->runGuard($request->withHeader('Origin', 'http://internal-proxy.test:8080')), 'internal URI cannot expand configured origins');
        $this->assertSame([204, 1], $this->runGuard($request->withHeader('Origin', self::FRONTEND)), 'explicit frontend works through TLS termination');
    }

    public function testJsonMediaTypeMustBeUnambiguousAndSimpleFormsStayDenied(): void
    {
        $request = $this->request()->withHeader('Origin', self::FRONTEND);
        foreach (['application/json', 'Application/JSON', 'application/json; charset=utf-8'] as $type) {
            $this->assertSame([204, 1], $this->runGuard($request->withHeader('Content-Type', $type)), $type);
        }
        foreach ([
            '', 'text/plain', 'application/x-www-form-urlencoded; application/json',
            'multipart/form-data; boundary=x; application/json', 'application/json, text/plain',
            'application/json; charset=utf-8, text/plain',
        ] as $type) {
            $this->assertSame([403, 0], $this->runGuard($request->withHeader('Content-Type', $type)), $type);
        }
        $this->assertSame([403, 0], $this->runGuard($request->withoutHeader('Content-Type')));
        $this->assertSame([403, 0], $this->runGuard($request->withHeader('Content-Type', ['application/json', 'application/json'])));
    }

    public function testRealSlimRoutingAppliesAdmissionToOnceEncodedAliases(): void
    {
        $calls = [];
        $app = \Slim\Factory\AppFactory::create();
        foreach (self::ROUTES as $route) {
            $app->post($route, function (ServerRequestInterface $request, ResponseInterface $response) use (&$calls, $route): ResponseInterface {
                $calls[] = $route;
                return $response->withStatus(204);
            });
        }
        $app->add(new CsrfMiddleware('formlogic_csrf', 'X-CSRF-Token', 'formlogic_auth', self::FIXTURE_SIGNING_CONTEXT, [self::FRONTEND]));
        $app->addRoutingMiddleware();
        foreach (['/api/auth/logi%6E', '/api/auth/%6cogin', '/api%2Fauth%2Flogin', '/api/auth/regi%73ter', '/api/auth/mfa/verif%79', '/api/demo/st%61rt'] as $alias) {
            foreach ([null, 'https://untrusted.example.test', self::FRONTEND] as $origin) {
                $calls = [];
                $request = $this->request($alias);
                if ($origin !== null) $request = $request->withHeader('Origin', $origin);
                $allowed = $origin === self::FRONTEND;
                $this->assertSame($allowed ? 204 : 403, $app->handle($request)->getStatusCode(), $alias);
                $this->assertCount($allowed ? 1 : 0, $calls, $alias . ': sentinel invocation');
            }
        }
    }

    public function testRoutingPolicyDoesNotDecodeTwiceOrCollapseDistinctPaths(): void
    {
        $calls = 0;
        $app = \Slim\Factory\AppFactory::create();
        $app->post('/api/auth/login', function (ServerRequestInterface $request, ResponseInterface $response) use (&$calls): ResponseInterface {
            $calls++;
            return $response;
        });
        $app->add(new CsrfMiddleware('formlogic_csrf', 'X-CSRF-Token', 'formlogic_auth', self::FIXTURE_SIGNING_CONTEXT, [self::FRONTEND]));
        $app->addRoutingMiddleware();
        $app->addErrorMiddleware(false, false, false);
        // These distinct paths must not become cookie-setting routes through a
        // second decode or normalization at a later point in the real router.
        foreach (['/api/auth/logi%256E', '/api//auth/login', '/api/auth/./login', '/api/auth/login/'] as $path) {
            $this->assertSame(404, $app->handle($this->request($path))->getStatusCode(), $path);
        }
        $this->assertSame(0, $calls, 'no session route ran');
    }

    public function testCorsAndCsrfTogetherRefuseDisallowedPostBeforeHandler(): void
    {
        $calls = 0;
        $app = \Slim\Factory\AppFactory::create();
        $app->post('/api/auth/login', function (ServerRequestInterface $request, ResponseInterface $response) use (&$calls): ResponseInterface {
            $calls++;
            return $response->withStatus(204);
        });
        $app->add(new CsrfMiddleware('formlogic_csrf', 'X-CSRF-Token', 'formlogic_auth', self::FIXTURE_SIGNING_CONTEXT, [self::FRONTEND]));
        $app->add(new CorsMiddleware(self::FRONTEND));
        foreach (['https://untrusted.example.test', self::FRONTEND] as $origin) {
            $calls = 0;
            $response = $app->handle($this->request()->withHeader('Origin', $origin));
            $allowed = $origin === self::FRONTEND;
            $this->assertSame($allowed ? 204 : 403, $response->getStatusCode());
            $this->assertSame($allowed ? 1 : 0, $calls);
            $this->assertSame($allowed ? self::FRONTEND : '', $response->getHeaderLine('Access-Control-Allow-Origin'));
        }
    }

    public function testCorsAndCsrfAgreeOnNormalizedExactOriginsAndExplicitListPrecedence(): void
    {
        foreach ([
            ['https://STUDIO.example.test:443', null, ['https://STUDIO.example.test:443']],
            ['*', ['https://STUDIO.example.test:443'], ['https://STUDIO.example.test:443']],
        ] as [$corsDefault, $corsList, $sessionOrigins]) {
            $calls = 0;
            $app = \Slim\Factory\AppFactory::create();
            $app->post('/api/auth/login', function (ServerRequestInterface $request, ResponseInterface $response) use (&$calls): ResponseInterface {
                $calls++;
                return $response->withStatus(204);
            });
            $app->add(new CsrfMiddleware('formlogic_csrf', 'X-CSRF-Token', 'formlogic_auth', self::FIXTURE_SIGNING_CONTEXT, $sessionOrigins));
            $app->add(new CorsMiddleware($corsDefault, $corsList));
            foreach ([self::FRONTEND, 'https://untrusted.example.test'] as $origin) {
                $calls = 0;
                $request = $this->request()->withHeader('Origin', $origin)->withHeader('Sec-Fetch-Site', 'cross-site');
                $allowed = $origin === self::FRONTEND;
                $preflight = $app->handle($request->withMethod('OPTIONS'));
                $this->assertSame($allowed ? $origin : '', $preflight->getHeaderLine('Access-Control-Allow-Origin'));
                $this->assertSame($allowed ? 'true' : '', $preflight->getHeaderLine('Access-Control-Allow-Credentials'));
                $this->assertSame(0, $calls, 'preflight does not invoke session handler');
                $response = $app->handle($request);
                $this->assertSame($allowed ? 204 : 403, $response->getStatusCode());
                $this->assertSame($allowed ? 1 : 0, $calls);
                $this->assertSame($allowed ? $origin : '', $response->getHeaderLine('Access-Control-Allow-Origin'));
                $this->assertSame($allowed ? 'true' : '', $response->getHeaderLine('Access-Control-Allow-Credentials'));
            }
        }
    }

    public function testMissingSignerFailsClosedAndDerivationRetainsExistingContract(): void
    {
        $this->assertSame('', CsrfMiddleware::secretForJwt(''));
        $this->assertSame(hash('sha256', 'formlogic-csrf:' . self::FIXTURE_SIGNING_CONTEXT), CsrfMiddleware::secretForJwt(self::FIXTURE_SIGNING_CONTEXT));
        $this->assertSame([403, 0], $this->runGuard($this->request()->withHeader('Origin', self::FRONTEND), [self::FRONTEND], ''));
        $request = $this->request('/api/private/action')->withCookieParams(['formlogic_auth' => 'inert-cookie-value']);
        $this->assertSame([403, 0], $this->runGuard($request, [], ''));
    }

    public function testOrdinaryBearerCookielessReadAndPublicSubmissionSemanticsRemain(): void
    {
        $request = $this->request('/api/private/action');
        $this->assertSame([204, 1], $this->runGuard($request, [], ''));
        $this->assertSame([204, 1], $this->runGuard($request->withHeader('Authorization', 'Bearer inert-non-authenticating-fixture'), [], ''));
        $this->assertSame([204, 1], $this->runGuard($request->withMethod('GET')->withCookieParams(['formlogic_auth' => 'inert-cookie-value']), [], ''));
        $this->assertSame([204, 1], $this->runGuard($this->request('/api/forms/form-fixture/responses')->withCookieParams(['formlogic_auth' => 'inert-cookie-value']), [], ''));
    }
}

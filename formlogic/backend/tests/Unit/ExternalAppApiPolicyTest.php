<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\ExternalAppApiController;
use FormLogic\Services\{AppService, CloudFlowRunner, FlowService, NativeAppService, NativeRecordEventRouter, PlanService};
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response as SlimResponse;

final class ExternalAppApiPolicyTest extends TestCase
{
    public function testSanitizeExternalApiRejectsUnsafeHeadersAndOrigins(): void
    {
        $clean = AppService::sanitizeExternalApi([
            'enabled' => true,
            'authMode' => 'both',
            'allowedMethods' => ['get', 'POST', 'TRACE', 'delete'],
            'allowedPaths' => ['api/products', '/api/orders', '/api/site/internal', '/api/../secret'],
            'blockedPaths' => ['/api/admin', 'bad path'],
            'defaultPrefix' => 'api/',
            'corsOrigins' => ['https://Shop.Example.com:443/', '*', 'javascript:alert(1)', 'not-an-origin'],
            'rateLimitPerMinute' => 99999,
            'customHeaders' => [
                'Cache-Control' => 'public, max-age=60',
                'X-API-Version' => '2.1',
                'Set-Cookie' => 'evil=1',
                'Access-Control-Allow-Origin' => 'https://evil.test',
                'X-FormLogic-User' => 'spoof',
                'X-Bad-CRLF' => "ok\r\nX-Injected: yes",
            ],
        ]);

        $this->assertNotNull($clean);
        $this->assertTrue($clean['enabled']);
        $this->assertSame('both', $clean['authMode']);
        $this->assertSame(['GET', 'POST', 'DELETE'], $clean['allowedMethods']);
        $this->assertSame(['/api/products', '/api/orders'], $clean['allowedPaths']);
        $this->assertSame(['/api/admin'], $clean['blockedPaths']);
        $this->assertSame('/api', $clean['defaultPrefix']);
        $this->assertSame(['https://shop.example.com', '*'], $clean['corsOrigins']);
        $this->assertSame(600, $clean['rateLimitPerMinute']);
        $this->assertSame([
            'Cache-Control' => 'public, max-age=60',
            'X-API-Version' => '2.1',
        ], $clean['customHeaders']);
    }

    public function testCustomHeadersKeepOnlyNamesThatSpeakForTheOneResponse(): void
    {
        $kept = ['Cache-Control' => 'public, max-age=60', 'Expires' => '0', 'Content-Language' => 'en', 'Sunset' => 'Sat, 31 Dec 2027 23:59:59 GMT', 'X-API-Version' => '2.1', 'X-Robots-Tag' => 'noindex'];
        // Each of these is an instruction for the whole origin, the connection, or the server in
        // front of PHP — not for the answer it is written on.
        $refused = [
            'Clear-Site-Data' => '"*"', 'NEL' => '{"report_to":"t","max_age":86400}', 'Report-To' => '{"group":"t","max_age":86400,"endpoints":[{"url":"https://tenant.example/r"}]}',
            'Reporting-Endpoints' => 't="https://tenant.example/r"', 'Link' => '</sw.js>; rel="serviceworker"', 'Alt-Svc' => 'h3="tenant.example:443"',
            'Service-Worker-Allowed' => '/', 'Refresh' => '0;url=https://tenant.example', 'Location' => 'https://tenant.example',
            'Content-Security-Policy' => 'default-src *', 'Content-Security-Policy-Report-Only' => 'default-src *', 'Strict-Transport-Security' => 'max-age=0',
            'Permissions-Policy' => 'camera=*', 'Cross-Origin-Opener-Policy' => 'unsafe-none', 'Origin-Agent-Cluster' => '?0', 'Accept-CH' => 'Sec-CH-UA-Model',
            'Critical-CH' => 'Sec-CH-UA-Model', 'Vary' => 'Accept', 'Retry-After' => '0', 'Keep-Alive' => 'timeout=600', 'Trailer' => 'X-A', 'TE' => 'trailers',
            'Speculation-Rules' => '"/r.json"', 'SourceMap' => 'https://tenant.example/m', 'Server' => 'x', 'Set-Login' => 'logged-out',
            'X-Frame-Options' => 'ALLOWALL', 'X-Accel-Redirect' => '/internal/secret', 'X-Sendfile' => '/etc/passwd', 'X-LiteSpeed-Location' => '/internal',
            'X-Forwarded-Host' => 'tenant.example', 'X-RateLimit-Remaining' => '9999', 'X-Content-Security-Policy' => 'default-src *', 'X-' => 'empty',
        ];
        $clean = AppService::sanitizeExternalApi(['enabled' => true, 'authMode' => 'public', 'customHeaders' => $refused + $kept]);
        $this->assertNotNull($clean);
        $this->assertSame($kept, $clean['customHeaders']);
        // A stored policy is cleaned again on every request, so one saved before a name was refused sends nothing.
        $policy = ExternalAppApiController::externalApiPolicy(['settings' => ['externalApi' => ['authMode' => 'public', 'customHeaders' => ['clear-site-data' => '"cookies"', 'X-API-Version' => '1']]]]);
        $this->assertSame(['X-API-Version' => '1'], $policy['customHeaders']);
    }

    public function testControllerEnforcesDisabledMethodAllowlistBlockedPathsAndPublicMode(): void
    {
        $app = [
            'id' => 'app-ext-1',
            'ownerId' => 'owner-1',
            'name' => 'Storefront API',
            'slug' => 'storefront',
            'status' => 'published',
            'settings' => [
                'softnApp' => true,
                'externalApi' => [
                    'enabled' => true,
                    'authMode' => 'both',
                    'allowedMethods' => ['GET'],
                    'allowedPaths' => ['/api/products'],
                    'blockedPaths' => ['/api/products/internal'],
                    'defaultPrefix' => '/api',
                    'corsOrigins' => ['https://frontend.example'],
                    'rateLimitPerMinute' => 60,
                    'customHeaders' => ['X-API-Version' => '1.0', 'Clear-Site-Data' => '"*"', 'Reporting-Endpoints' => 't="https://tenant.example/r"'],
                ],
            ],
        ];

        $apps = $this->createMock(AppService::class);
        $apps->method('getApp')->willReturnCallback(function (string $id) use (&$app) { return $id === 'app-ext-1' ? $app : null; });
        $apps->method('getAppBySlug')->willReturnCallback(function (string $s) use (&$app) { return $s === 'storefront' ? $app : null; });
        $apps->method('sharedDatabaseGroupAppIds')->willReturn(['app-ext-1']);

        $native = $this->createMock(NativeAppService::class);
        $native->method('project')->willReturn([
            'version' => 1,
            'files' => [
                'manifest.json' => json_encode([
                    'name' => 'Storefront API',
                    'backend' => ['runtime' => 'php', 'entry' => 'server/index.php', 'routes' => ['/api']],
                ]),
            ],
        ]);
        $native->method('containerRequest')->willReturnCallback(function (string $appId, array $req, array $identity) {
            return [
                'status' => 200,
                'headers' => [['content-type', 'application/json']],
                'bodyBase64' => base64_encode(json_encode([
                    'path' => $req['path'],
                    'method' => $req['method'],
                    'via' => $identity['via'] ?? null,
                    'authenticated' => $identity['authenticated'] ?? null,
                    'forwardedAuth' => ((array) ($req['headers'] ?? []))['authorization'] ?? null,
                    'host' => $req['host'] ?? null,
                    'https' => $req['https'] ?? null,
                ])),
            ];
        });

        $flows = $this->createMock(FlowService::class);
        $flows->method('nativeRecordSubscriptionsForApps')->willReturn([]);
        $cloud = $this->createMock(CloudFlowRunner::class);
        $plans = $this->createMock(PlanService::class);
        $plans->method('isEnforced')->willReturn(false);
        $records = $this->createMock(NativeRecordEventRouter::class);

        $controller = new ExternalAppApiController($apps, $native, $flows, $cloud, $plans, $records);
        $rf = new ServerRequestFactory();

        // 1. Allowed public GET with defaultPrefix (`/products` -> `/api/products`) + CORS + custom header
        $reqOk = $rf->createServerRequest('GET', '/api/public/apps/storefront/routes/products')
            ->withHeader('Origin', 'https://frontend.example')
            ->withHeader('X-App-Authorization', 'Bearer custom-app-token');
        $resOk = $controller->publicRouteApp($reqOk, new SlimResponse(), ['appId' => 'storefront', 'path' => 'products']);
        $this->assertSame(200, $resOk->getStatusCode());
        $this->assertSame('https://frontend.example', $resOk->getHeaderLine('Access-Control-Allow-Origin'));
        $this->assertSame('', $resOk->getHeaderLine('Access-Control-Allow-Credentials'), 'per-app CORS never sets credentials');
        $this->assertSame('1.0', $resOk->getHeaderLine('X-API-Version'));
        $this->assertFalse($resOk->hasHeader('Clear-Site-Data'), 'an origin-wide header kept in settings is never sent');
        $this->assertFalse($resOk->hasHeader('Reporting-Endpoints'));
        $bodyOk = json_decode((string) $resOk->getBody(), true);
        $this->assertSame('/api/products', $bodyOk['path']);
        $this->assertSame('public_api', $bodyOk['via']);
        $this->assertFalse($bodyOk['authenticated']);
        $this->assertSame('Bearer custom-app-token', $bodyOk['forwardedAuth']);
        // The backend is told the address the site was reached by, never a caller's own Host header.
        $reqNamed = $rf->createServerRequest('GET', 'https://forms.example.test/api/public/apps/storefront/routes/products')
            ->withHeader('X-Forwarded-Proto', 'https')->withHeader('X-Forwarded-Host', 'elsewhere.example');
        $bodyNamed = json_decode((string) $controller->publicRouteApp($reqNamed, new SlimResponse(), ['appId' => 'storefront', 'path' => 'products'])->getBody(), true);
        $this->assertSame(['forms.example.test', true], [$bodyNamed['host'], $bodyNamed['https']]);

        // 2. Method not allowed -> 405 with Allow header
        $reqPost = $rf->createServerRequest('POST', '/api/public/apps/storefront/routes/api/products');
        $resPost = $controller->publicRouteApp($reqPost, new SlimResponse(), ['appId' => 'storefront', 'path' => 'api/products']);
        $this->assertSame(405, $resPost->getStatusCode());
        $this->assertSame('GET', $resPost->getHeaderLine('Allow'));

        // 3. Blocked sub-path -> 403
        $reqBlocked = $rf->createServerRequest('GET', '/api/public/apps/storefront/routes/api/products/internal');
        $resBlocked = $controller->publicRouteApp($reqBlocked, new SlimResponse(), ['appId' => 'storefront', 'path' => 'api/products/internal']);
        $this->assertSame(403, $resBlocked->getStatusCode());
        $this->assertSame('1.0', $resBlocked->getHeaderLine('X-API-Version'));
        $this->assertFalse($resBlocked->hasHeader('Clear-Site-Data'), 'nor on a refusal');

        // 4. Outside allowlist -> 403
        $reqOutside = $rf->createServerRequest('GET', '/api/public/apps/storefront/routes/api/orders');
        $resOutside = $controller->publicRouteApp($reqOutside, new SlimResponse(), ['appId' => 'storefront', 'path' => 'api/orders']);
        $this->assertSame(403, $resOutside->getStatusCode());

        // 5. Preflight OPTIONS reflects allowed origin without credentials and rejects unknown origin
        $reqPreOk = $rf->createServerRequest('OPTIONS', '/api/public/apps/storefront/routes/products')
            ->withHeader('Origin', 'https://frontend.example');
        $resPreOk = $controller->preflight($reqPreOk, new SlimResponse(), ['appId' => 'storefront', 'path' => 'products']);
        $this->assertSame(204, $resPreOk->getStatusCode());
        $this->assertSame('https://frontend.example', $resPreOk->getHeaderLine('Access-Control-Allow-Origin'));
        $this->assertSame('', $resPreOk->getHeaderLine('Access-Control-Allow-Credentials'));

        $reqPreBad = $rf->createServerRequest('OPTIONS', '/api/public/apps/storefront/routes/products')
            ->withHeader('Origin', 'https://evil.example');
        $resPreBad = $controller->preflight($reqPreBad, new SlimResponse(), ['appId' => 'storefront', 'path' => 'products']);
        $this->assertSame(204, $resPreBad->getStatusCode());
        $this->assertSame('', $resPreBad->getHeaderLine('Access-Control-Allow-Origin'));

        // 6. Disabling externalApi blocks API-key calls too
        $app['settings']['externalApi']['enabled'] = false;
        $reqDisabled = $rf->createServerRequest('POST', '/api/v1/apps/storefront/invoke')
            ->withAttribute('userId', 'owner-1')
            ->withParsedBody(['method' => 'GET', 'path' => '/api/products']);
        $resDisabled = $controller->invokeApp($reqDisabled, new SlimResponse(), ['appId' => 'storefront']);
        $this->assertSame(403, $resDisabled->getStatusCode());
    }

    public function testPublicRouteRefusesDraftAppsAndApiKeyOnlyMode(): void
    {
        $draftApp = [
            'id' => 'app-draft',
            'ownerId' => 'owner-1',
            'name' => 'Draft API',
            'slug' => 'draft-api',
            'status' => 'draft',
            'settings' => [
                'softnApp' => true,
                'externalApi' => ['enabled' => true, 'authMode' => 'public'],
            ],
        ];
        $keyOnlyApp = [
            'id' => 'app-key',
            'ownerId' => 'owner-1',
            'name' => 'Key Only API',
            'slug' => 'key-only',
            'status' => 'published',
            'settings' => [
                'softnApp' => true,
                'externalApi' => ['enabled' => true, 'authMode' => 'api_key'],
            ],
        ];
        $apps = $this->createMock(AppService::class);
        $apps->method('getApp')->willReturn(null);
        $apps->method('getAppBySlug')->willReturnMap([
            ['draft-api', $draftApp],
            ['key-only', $keyOnlyApp],
        ]);
        $controller = new ExternalAppApiController(
            $apps,
            $this->createMock(NativeAppService::class),
            $this->createMock(FlowService::class),
            $this->createMock(CloudFlowRunner::class),
            $this->createMock(PlanService::class),
            $this->createMock(NativeRecordEventRouter::class),
        );
        $rf = new ServerRequestFactory();

        $resDraft = $controller->publicRouteApp($rf->createServerRequest('GET', '/api/public/apps/draft-api/routes/api/items'), new SlimResponse(), ['appId' => 'draft-api', 'path' => 'api/items']);
        $this->assertSame(404, $resDraft->getStatusCode(), 'draft apps must never be exposed publicly');

        $resKeyOnly = $controller->publicRouteApp($rf->createServerRequest('GET', '/api/public/apps/key-only/routes/api/items'), new SlimResponse(), ['appId' => 'key-only', 'path' => 'api/items']);
        $this->assertSame(403, $resKeyOnly->getStatusCode(), 'api_key-only apps must refuse public calls');
    }
}

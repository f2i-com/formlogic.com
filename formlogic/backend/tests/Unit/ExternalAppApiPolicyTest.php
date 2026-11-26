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

    /**
     * A `.logic` handler reads the same headers whether its app's page called it or the app's API
     * did: `authorization` and `idempotency-key` always, and the request's others by the page's
     * rule (AppRequestHeaders). Over HTTP the headers are this site's own request's, so what the
     * caller says to the site alone (its key, its cookie, its CSRF token) is never among them.
     */
    public function testALogicHandlerIsGivenTheApiRequestsHeadersAndNoneOfTheSitesOwn(): void
    {
        $app = [
            'id' => 'app-logic-1', 'ownerId' => 'owner-1', 'name' => 'Notes API', 'slug' => 'notes', 'status' => 'published',
            'settings' => ['softnApp' => true, 'externalApi' => ['enabled' => true, 'authMode' => 'both']],
        ];
        $apps = $this->createMock(AppService::class);
        $apps->method('getApp')->willReturn(null);
        $apps->method('getAppBySlug')->willReturn($app);
        $apps->method('sharedDatabaseGroupAppIds')->willReturn(['app-logic-1']);
        $native = $this->createMock(NativeAppService::class);
        $native->method('project')->willReturn(['version' => 1, 'files' => ['manifest.json' => json_encode(['name' => 'Notes API', 'server' => ['routes' => 'server/routes.logic']])]]);
        $given = [];
        $native->method('request')->willReturnCallback(static function (string $appId, array $input) use (&$given): array {
            $given[] = (array) $input['headers'];
            return ['status' => 200, 'body' => ['ok' => true]];
        });
        $native->expects($this->never())->method('containerRequest');
        // Each call asks for a worker, and says first whose app it is (the account's share of them).
        $native->expects($this->exactly(3))->method('ownedBy')->with('app-logic-1', 'owner-1');
        $flows = $this->createMock(FlowService::class);
        $flows->method('nativeRecordSubscriptionsForApps')->willReturn([]);
        $plans = $this->createMock(PlanService::class);
        $plans->method('isEnforced')->willReturn(false);
        $controller = new ExternalAppApiController($apps, $native, $flows, $this->createMock(CloudFlowRunner::class), $plans, $this->createMock(NativeRecordEventRouter::class));
        $rf = new ServerRequestFactory();

        // Over HTTP, as a visitor: the request's own headers.
        $direct = $rf->createServerRequest('POST', 'https://forms.example.test/api/public/apps/notes/routes/api/notes')
            ->withHeader('Content-Type', 'application/json')->withHeader('Accept-Language', 'fr-CA')->withHeader('X-Device-Id', 'tablet-7')
            ->withHeader('Idempotency-Key', 'save-1')->withHeader('X-App-Authorization', 'Bearer app-session')
            ->withHeader('Authorization', 'Bearer flk_the_callers_key')->withHeader('Cookie', 'formlogic_session=theirs')
            ->withHeader('X-CSRF-Token', 'their-csrf-token')->withHeader('X-Admin-Confirmation', 'their-confirmation')
            ->withHeader('X-Demo-Sandbox-Token', 'their-sandbox')->withHeader('Mcp-Session-Id', 'their-mcp-session')
            ->withHeader('X-FormLogic-Visitor', 'v1')->withHeader('Host', 'elsewhere.example')->withHeader('Origin', 'https://frontend.example')
            ->withHeader('Referer', 'https://frontend.example/page')->withHeader('Forwarded', 'for=198.51.100.9')
            ->withHeader('X-Forwarded-For', '198.51.100.9')->withHeader('X-Real-IP', '198.51.100.9')->withHeader('Proxy-Authorization', 'Basic eA==')
            ->withHeader('Sec-Fetch-Site', 'cross-site')->withHeader('Connection', 'keep-alive')->withHeader('Content-Length', '18');
        $direct->getBody()->write('{"title":"A note"}');
        $this->assertSame(200, $controller->publicRouteApp($direct, new SlimResponse(), ['appId' => 'notes', 'path' => 'api/notes'])->getStatusCode());
        $this->assertSame([
            'authorization' => 'Bearer app-session', 'idempotency-key' => 'save-1',
            'content-type' => 'application/json', 'accept-language' => 'fr-CA', 'x-device-id' => 'tablet-7',
        ], $given[0]);

        // Sent none, a handler still reads the two it always could.
        $controller->publicRouteApp($rf->createServerRequest('GET', '/api/public/apps/notes/routes/api/notes'), new SlimResponse(), ['appId' => 'notes', 'path' => 'api/notes']);
        $this->assertSame(['authorization' => '', 'idempotency-key' => ''], $given[1]);

        // In an envelope, with a key: the headers the caller listed for the app, by the same rule.
        $envelope = $rf->createServerRequest('POST', '/api/v1/apps/notes/invoke')->withAttribute('userId', 'owner-1')
            ->withHeader('Authorization', 'Bearer flk_the_callers_key')->withHeader('Cookie', 'formlogic_session=theirs')->withHeader('X-CSRF-Token', 'their-csrf-token')
            ->withParsedBody(['method' => 'POST', 'path' => '/api/notes', 'body' => ['title' => 'A note'], 'headers' => [
                'Authorization' => 'Bearer app-session', 'X-Device-Id' => 'tablet-7', 'Content-Type' => 'application/json',
                'Cookie' => 'sid=1', 'Forwarded' => 'for=198.51.100.9', 'X-FormLogic-User' => 'owner', 'Sec-Fetch-Site' => 'same-origin', 'Connection' => 'close',
            ]]);
        $this->assertSame(200, $controller->invokeApp($envelope, new SlimResponse(), ['appId' => 'notes'])->getStatusCode());
        $this->assertSame([
            'authorization' => 'Bearer app-session', 'idempotency-key' => '',
            'x-device-id' => 'tablet-7', 'content-type' => 'application/json',
        ], $given[2]);
    }

    /** A container backend called over HTTP is not handed the site's own headers either. */
    public function testAContainerBackendIsNotGivenTheSitesOwnHeadersOverHttp(): void
    {
        $app = [
            'id' => 'app-ext-2', 'ownerId' => 'owner-1', 'name' => 'Shop API', 'slug' => 'shop', 'status' => 'published',
            'settings' => ['softnApp' => true, 'externalApi' => ['enabled' => true, 'authMode' => 'public']],
        ];
        $apps = $this->createMock(AppService::class);
        $apps->method('getApp')->willReturn(null);
        $apps->method('getAppBySlug')->willReturn($app);
        $apps->method('sharedDatabaseGroupAppIds')->willReturn(['app-ext-2']);
        $native = $this->createMock(NativeAppService::class);
        $native->method('project')->willReturn(['version' => 1, 'files' => ['manifest.json' => json_encode(['name' => 'Shop API', 'backend' => ['runtime' => 'php', 'entry' => 'server/index.php']])]]);
        $given = [];
        $native->method('containerRequest')->willReturnCallback(static function (string $appId, array $req) use (&$given): array {
            $given = (array) $req['headers'];
            return ['status' => 200, 'headers' => [['content-type', 'application/json']], 'bodyBase64' => base64_encode('{}')];
        });
        $flows = $this->createMock(FlowService::class);
        $flows->method('nativeRecordSubscriptionsForApps')->willReturn([]);
        $plans = $this->createMock(PlanService::class);
        $plans->method('isEnforced')->willReturn(false);
        $controller = new ExternalAppApiController($apps, $native, $flows, $this->createMock(CloudFlowRunner::class), $plans, $this->createMock(NativeRecordEventRouter::class));

        $request = (new ServerRequestFactory())->createServerRequest('GET', '/api/public/apps/shop/routes/api/products')
            ->withHeader('X-Device-Id', 'tablet-7')->withHeader('X-App-Authorization', 'Bearer app-session')
            ->withHeader('Authorization', 'Bearer flk_the_callers_key')->withHeader('Cookie', 'formlogic_session=theirs')
            ->withHeader('X-CSRF-Token', 'their-csrf-token')->withHeader('X-Admin-Confirmation', 'their-confirmation')
            ->withHeader('X-Demo-Sandbox-Token', 'their-sandbox')->withHeader('Mcp-Session-Id', 'their-mcp-session');
        $this->assertSame(200, $controller->publicRouteApp($request, new SlimResponse(), ['appId' => 'shop', 'path' => 'api/products'])->getStatusCode());
        $this->assertSame(['x-device-id' => 'tablet-7', 'authorization' => 'Bearer app-session'], $given);
    }

    /**
     * A container backend reads the same headers whichever way it was called: through the app's
     * API, by the rule its page is held to (AppRequestHeaders). The API had a filter of its own,
     * which passed on what the page's never did (the connection's own headers, a browser's `sec-*`,
     * a name that only begins `x-formlogic`) and cut a value past 8 KB short instead of leaving it
     * out. Neither lets a caller say where it is, or override the method the API allows.
     */
    public function testAContainerBackendIsGivenTheApisHeadersByThePagesRule(): void
    {
        $app = [
            'id' => 'app-ext-3', 'ownerId' => 'owner-1', 'name' => 'Shop API', 'slug' => 'shop', 'status' => 'published',
            'settings' => ['softnApp' => true, 'externalApi' => ['enabled' => true, 'authMode' => 'both']],
        ];
        $apps = $this->createMock(AppService::class);
        $apps->method('getApp')->willReturn(null);
        $apps->method('getAppBySlug')->willReturn($app);
        $apps->method('sharedDatabaseGroupAppIds')->willReturn(['app-ext-3']);
        $native = $this->createMock(NativeAppService::class);
        $native->method('project')->willReturn(['version' => 1, 'files' => ['manifest.json' => json_encode(['name' => 'Shop API', 'backend' => ['runtime' => 'php', 'entry' => 'server/index.php']])]]);
        $given = [];
        $native->method('containerRequest')->willReturnCallback(static function (string $appId, array $req) use (&$given): array {
            $given[] = (array) $req['headers'];
            return ['status' => 200, 'headers' => [['content-type', 'application/json']], 'bodyBase64' => base64_encode('{}')];
        });
        $flows = $this->createMock(FlowService::class);
        $flows->method('nativeRecordSubscriptionsForApps')->willReturn([]);
        $plans = $this->createMock(PlanService::class);
        $plans->method('isEnforced')->willReturn(false);
        $controller = new ExternalAppApiController($apps, $native, $flows, $this->createMock(CloudFlowRunner::class), $plans, $this->createMock(NativeRecordEventRouter::class));
        $rf = new ServerRequestFactory();
        $kept = ['X-Device-Id' => 'tablet-7', 'Accept-Language' => 'fr-CA'];
        $withheld = [
            'Connection' => 'close', 'Keep-Alive' => 'timeout=5', 'TE' => 'trailers', 'Upgrade' => 'websocket', 'Transfer-Encoding' => 'chunked',
            'Content-Length' => '3', 'Sec-Fetch-Site' => 'cross-site', 'X-FormLogicUser' => 'owner', 'X-Long' => str_repeat('a', 8193),
            'Forwarded' => 'for=198.51.100.9', 'X-Forwarded-For' => '198.51.100.9', 'X-Real-IP' => '198.51.100.9',
            'X-HTTP-Method-Override' => 'DELETE', 'X-Method-Override' => 'DELETE', 'Host' => 'elsewhere.example', 'Origin' => 'https://frontend.example',
        ];

        // In an envelope, with a key: the headers the caller listed for the app.
        $listed = ['Authorization' => 'Bearer app-session', 'Cookie' => 'sid=1'] + $kept + $withheld;
        $envelope = $rf->createServerRequest('POST', '/api/v1/apps/shop/invoke')->withAttribute('userId', 'owner-1')
            ->withParsedBody(['method' => 'GET', 'path' => '/api/products', 'headers' => $listed]);
        $this->assertSame(200, $controller->invokeApp($envelope, new SlimResponse(), ['appId' => 'shop'])->getStatusCode());
        $this->assertSame(['authorization' => 'Bearer app-session', 'cookie' => 'sid=1', 'x-device-id' => 'tablet-7', 'accept-language' => 'fr-CA'], $given[0]);
        $this->assertSame(\FormLogic\Helpers\AppRequestHeaders::fromApp($listed), $given[0], 'the page\'s rule, exactly');

        // Over HTTP, as a visitor: the request's own headers, but for what it says to this site alone.
        $direct = $rf->createServerRequest('GET', 'https://forms.example.test/api/public/apps/shop/routes/api/products')
            ->withHeader('X-App-Authorization', 'Bearer app-session');
        foreach ($kept + $withheld as $name => $value) {
            $direct = $direct->withHeader($name, $value);
        }
        $this->assertSame(200, $controller->publicRouteApp($direct, new SlimResponse(), ['appId' => 'shop', 'path' => 'api/products'])->getStatusCode());
        $this->assertEqualsCanonicalizing(['authorization' => 'Bearer app-session', 'x-device-id' => 'tablet-7', 'accept-language' => 'fr-CA'], $given[1]);
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

<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\AppManifestController;
use FormLogic\Services\AppDomainService;
use FormLogic\Services\AppService;
use FormLogic\Services\SigningService;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Message\UriInterface;
use ReflectionMethod;

/**
 * Custom-domain hardening #5 + #6 (+ the production default-https hardening #4).
 *
 * #5 — customDomainBase() must honor a TLS-terminating proxy: the scheme in the SIGNED custom-domain
 *      client manifest is derived from a trusted X-Forwarded-Proto header first (only http/https), then
 *      the request URI scheme, then default https. So a proxy that forwards http on the wire still yields
 *      https links (mirrors AppPublicController::sameOriginBase).
 *
 * #4 — in PRODUCTION (safe-by-default: anything but an explicit APP_ENV=development) the scheme is ALWAYS
 *      https, even when the backend sees plain http and NO X-Forwarded-Proto (a TLS-terminating proxy
 *      that doesn't set the header). The http fallback via the request URI scheme is development-only,
 *      so http://formlogic.local keeps working. Tests that exercise that fallback set
 *      APP_ENV=development explicitly.
 *
 * #6 — a custom-domain manifest's install.pwa.manifestUrl points at the dedicated same-origin ROOT PWA
 *      manifest {customBase}/manifest.json (so the installing document stays in scope), while the platform
 *      slug route keeps {base}/api/app/{slug}/manifest.json.
 *
 * Private methods are exercised directly via reflection with a mocked AppService (no DB / crypto needed).
 */
class AppManifestSchemeTest extends TestCase
{
    /** @var array<string,mixed> */
    private array $app;
    private ?string $savedAppUrl = null;
    private ?string $savedAppEnv = null;

    protected function setUp(): void
    {
        $this->app = [
            'id' => 'app-1',
            'slug' => 'demo',
            'name' => 'Demo App',
            'description' => 'A demo',
            'settings' => [],
            'theme' => [],
            'customLogic' => [],
        ];
        $get = getenv('APP_URL');
        $this->savedAppUrl = $get === false ? null : $get;
        $env = $_ENV['APP_ENV'] ?? (getenv('APP_ENV') !== false ? getenv('APP_ENV') : null);
        $this->savedAppEnv = is_string($env) ? $env : null;
    }

    protected function tearDown(): void
    {
        if ($this->savedAppUrl === null) {
            putenv('APP_URL');
            unset($_ENV['APP_URL']);
        } else {
            putenv('APP_URL=' . $this->savedAppUrl);
            $_ENV['APP_URL'] = $this->savedAppUrl;
        }
        $this->setAppEnv($this->savedAppEnv);
    }

    private function setAppEnv(?string $value): void
    {
        if ($value === null) {
            putenv('APP_ENV');
            unset($_ENV['APP_ENV']);
        } else {
            putenv('APP_ENV=' . $value);
            $_ENV['APP_ENV'] = $value;
        }
    }

    private function controller(): AppManifestController
    {
        $appService = $this->createMock(AppService::class);
        $appService->method('getAppFormsWithLogic')->willReturn([]);
        // buildManifest / customDomainBase never touch signing/domains — mocks satisfy the ctor only.
        $signing = $this->createMock(SigningService::class);
        $domains = $this->createMock(AppDomainService::class);
        return new AppManifestController($appService, $signing, $domains);
    }

    /**
     * Build a request mock with a given X-Forwarded-Proto header value and URI scheme, so the scheme
     * resolution order (forwarded proto → URI scheme → https) can be exercised deterministically.
     */
    private function req(string $forwardedProto, string $uriScheme): ServerRequestInterface
    {
        $uri = $this->createMock(UriInterface::class);
        $uri->method('getScheme')->willReturn($uriScheme);
        $req = $this->createMock(ServerRequestInterface::class);
        $req->method('getUri')->willReturn($uri);
        $req->method('getHeaderLine')->willReturnCallback(
            static fn(string $name): string =>
                strtolower($name) === 'x-forwarded-proto' ? $forwardedProto : ''
        );
        return $req;
    }

    private function customDomainBase(ServerRequestInterface $req, string $domain): string
    {
        $m = new ReflectionMethod(AppManifestController::class, 'customDomainBase');
        $m->setAccessible(true);
        return (string) $m->invoke($this->controller(), $req, $domain);
    }

    // ---- #5: scheme derivation --------------------------------------------------------------------

    public function testForwardedProtoHttpsOverridesHttpRequestUri(): void
    {
        // Behind a TLS-terminating proxy the wire request is http but X-Forwarded-Proto says https.
        $base = $this->customDomainBase($this->req('https', 'http'), 'mine.example.com');
        $this->assertSame('https://mine.example.com', $base);
    }

    public function testNoForwardedProtoDefaultsToHttps(): void
    {
        // No proxy header and no URI scheme available → default to https (custom domains are TLS).
        $base = $this->customDomainBase($this->req('', ''), 'mine.example.com');
        $this->assertSame('https://mine.example.com', $base);
    }

    public function testUnsupportedForwardedProtoIsIgnoredAndNeverNonHttp(): void
    {
        // Upgrade-only honors ONLY X-Forwarded-Proto: https; a junk proto is ignored and the scheme falls
        // back to the real connection scheme — always http or https, never ftp/javascript/etc. The http
        // fallback is DEVELOPMENT-only (hardening #4), so pin the env here.
        $this->setAppEnv('development');
        // ftp over an http connection → the connection's http (not a forced https, and never ftp).
        $base = $this->customDomainBase($this->req('ftp', 'http'), 'mine.example.com');
        $this->assertSame('http://mine.example.com', $base);
        // junk proto with no connection scheme → default https.
        $base2 = $this->customDomainBase($this->req('javascript', ''), 'mine.example.com');
        $this->assertSame('https://mine.example.com', $base2);
    }

    public function testForwardedProtoHttpDoesNotDowngradeHttps(): void
    {
        // A (possibly spoofed) X-Forwarded-Proto: http must NOT downgrade a genuine https connection to
        // cleartext in the signed manifest — upgrade-only ignores it and keeps the real https scheme.
        $base = $this->customDomainBase($this->req('http', 'https'), 'mine.example.com');
        $this->assertSame('https://mine.example.com', $base);
    }

    public function testFallsBackToRequestUriSchemeWhenNoForwardedProtoInDevelopment(): void
    {
        // Development only: no forwarded proto → use the request URI scheme (http here) rather than
        // defaulting to https, so http://formlogic.local dev domains keep working.
        $this->setAppEnv('development');
        $base = $this->customDomainBase($this->req('', 'http'), 'mine.example.com');
        $this->assertSame('http://mine.example.com', $base);
    }

    // ---- #4: production always emits https ---------------------------------------------------------

    public function testProductionHttpWithoutForwardedProtoYieldsHttps(): void
    {
        // A TLS-terminating proxy that does NOT set X-Forwarded-Proto: the backend sees plain http and
        // no header, but a live production custom domain is always TLS — the SIGNED manifest must carry
        // https links.
        $this->setAppEnv('production');
        $base = $this->customDomainBase($this->req('', 'http'), 'mine.example.com');
        $this->assertSame('https://mine.example.com', $base);
    }

    public function testProductionForwardedProtoHttpStillYieldsHttps(): void
    {
        // Even an explicit (spoofed or misconfigured) X-Forwarded-Proto: http never downgrades production.
        $this->setAppEnv('production');
        $base = $this->customDomainBase($this->req('http', 'http'), 'mine.example.com');
        $this->assertSame('https://mine.example.com', $base);
    }

    public function testUnsetAppEnvIsTreatedAsProduction(): void
    {
        // Safe-by-default (mirrors config/settings.php): a missing APP_ENV counts as production, so a
        // deployment that forgot to set it can never emit cleartext manifest links.
        $this->setAppEnv(null);
        $base = $this->customDomainBase($this->req('', 'http'), 'mine.example.com');
        $this->assertSame('https://mine.example.com', $base);
    }

    // ---- #6: custom-domain vs platform manifestUrl ------------------------------------------------

    /** @return array<string,mixed> */
    private function build(?string $baseOverride, ?string $customDomain): array
    {
        $m = new ReflectionMethod(AppManifestController::class, 'buildManifest');
        $m->setAccessible(true);
        $req = $this->createMock(ServerRequestInterface::class);
        return (array) $m->invoke($this->controller(), $this->app, $req, $baseOverride, $customDomain);
    }

    public function testCustomDomainManifestUrlIsSameOriginRootManifest(): void
    {
        $manifest = $this->build('https://mine.example.com', 'mine.example.com');
        $url = $manifest['install']['pwa']['manifestUrl'];
        $this->assertStringEndsWith('/manifest.json', $url);
        $this->assertSame('https://mine.example.com/manifest.json', $url);
        // Must NOT be the API-origin per-slug manifest on a custom domain.
        $this->assertStringNotContainsString('/api/app/', $url);
    }

    public function testPlatformSlugManifestUrlUsesApiSlugManifest(): void
    {
        putenv('APP_URL=https://platform.example');
        $_ENV['APP_URL'] = 'https://platform.example';

        $manifest = $this->build(null, null);
        $this->assertSame(
            'https://platform.example/api/app/demo/manifest.json',
            $manifest['install']['pwa']['manifestUrl']
        );
    }
}

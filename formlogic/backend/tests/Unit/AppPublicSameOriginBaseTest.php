<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\AppPublicController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppDomainService;
use FormLogic\Services\AppResponseService;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FormService;
use FormLogic\Services\ResponseService;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Message\UriInterface;
use ReflectionMethod;

/**
 * Hardening #4 for the custom-domain root PWA manifest: AppPublicController::sameOriginBase() must be
 * UPGRADE-ONLY on X-Forwarded-Proto and PRODUCTION-DEFAULT-HTTPS — a TLS-terminating proxy that forwards
 * plain http WITHOUT setting X-Forwarded-Proto still yields https links in production (safe-by-default:
 * anything but an explicit APP_ENV=development counts as production, mirroring config/settings.php).
 * Only development may emit http, so http://formlogic.local keeps working locally.
 *
 * Mirrors AppManifestController::requestScheme() (covered by AppManifestSchemeTest) so the two
 * same-origin base builders cannot drift apart. Exercised via reflection with fully mocked services —
 * no DB needed.
 */
class AppPublicSameOriginBaseTest extends TestCase
{
    private ?string $savedAppEnv = null;

    protected function setUp(): void
    {
        $env = $_ENV['APP_ENV'] ?? (getenv('APP_ENV') !== false ? getenv('APP_ENV') : null);
        $this->savedAppEnv = is_string($env) ? $env : null;
    }

    protected function tearDown(): void
    {
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

    private function controller(): AppPublicController
    {
        // sameOriginBase never touches any service — mocks satisfy the constructor only.
        return new AppPublicController(
            $this->createMock(AppService::class),
            $this->createMock(AppUserService::class),
            $this->createMock(AppResponseService::class),
            $this->createMock(FormService::class),
            $this->createMock(ResponseService::class),
            $this->createMock(MySQLConnection::class),
            $this->createMock(SQLiteConnection::class),
            $this->createMock(AppDomainService::class)
        );
    }

    /** Request mock with a given X-Forwarded-Proto value and URI scheme. */
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

    private function base(ServerRequestInterface $req, string $host): string
    {
        $m = new ReflectionMethod(AppPublicController::class, 'sameOriginBase');
        $m->setAccessible(true);
        return (string) $m->invoke($this->controller(), $req, $host);
    }

    public function testProductionHttpWithoutForwardedProtoYieldsHttps(): void
    {
        // TLS-terminating proxy that doesn't set X-Forwarded-Proto: backend sees plain http, but a live
        // production custom domain is always TLS — the root PWA manifest must carry https URLs.
        $this->setAppEnv('production');
        $this->assertSame('https://mine.example.com', $this->base($this->req('', 'http'), 'mine.example.com'));
    }

    public function testUnsetAppEnvIsTreatedAsProduction(): void
    {
        $this->setAppEnv(null);
        $this->assertSame('https://mine.example.com', $this->base($this->req('', 'http'), 'mine.example.com'));
    }

    public function testForwardedProtoHttpNeverDowngrades(): void
    {
        // Upgrade-only: a spoofed X-Forwarded-Proto: http downgrades nothing — not in production…
        $this->setAppEnv('production');
        $this->assertSame('https://mine.example.com', $this->base($this->req('http', 'http'), 'mine.example.com'));
        // …and not over a genuine https connection in development either.
        $this->setAppEnv('development');
        $this->assertSame('https://mine.example.com', $this->base($this->req('http', 'https'), 'mine.example.com'));
    }

    public function testForwardedProtoHttpsUpgradesInDevelopmentToo(): void
    {
        $this->setAppEnv('development');
        $this->assertSame('https://mine.example.com', $this->base($this->req('https', 'http'), 'mine.example.com'));
    }

    public function testDevelopmentKeepsHttpFallbackForLocalDomains(): void
    {
        // Dev keeps the request-URI http fallback so http://formlogic.local works.
        $this->setAppEnv('development');
        $this->assertSame('http://formlogic.local', $this->base($this->req('', 'http'), 'formlogic.local'));
        // No scheme at all → default https even in dev.
        $this->assertSame('https://formlogic.local', $this->base($this->req('', ''), 'formlogic.local'));
    }
}

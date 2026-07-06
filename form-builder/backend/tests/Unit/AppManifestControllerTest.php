<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\AppManifestController;
use FormLogic\Services\AppDomainService;
use FormLogic\Services\AppService;
use FormLogic\Services\SigningService;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ServerRequestInterface;
use ReflectionMethod;

/**
 * Custom-domain hardening #4: the client manifest must be SAME-ORIGIN on a custom domain.
 *
 * buildManifest() defaults to the platform frontend base (AppUrl::frontendBase, which deliberately
 * ignores the request Host) for the slug route, but accepts a base override so the
 * /.well-known/formlogic-app.json route can emit links that point at the pre-verified custom domain,
 * plus a top-level `domain` field. These assertions drive buildManifest directly with a mocked
 * AppService (getAppFormsWithLogic → []) so no DB is needed; the crypto/DB signing path is covered
 * elsewhere.
 */
class AppManifestControllerTest extends TestCase
{
    /** @var array<string,mixed> */
    private array $app;
    private ?string $savedAppUrl = null;

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
    }

    private function controller(): AppManifestController
    {
        $appService = $this->createMock(AppService::class);
        $appService->method('getAppFormsWithLogic')->willReturn([]);
        // buildManifest never touches signing/domains — mocks satisfy the constructor only.
        $signing = $this->createMock(SigningService::class);
        $domains = $this->createMock(AppDomainService::class);
        return new AppManifestController($appService, $signing, $domains);
    }

    /** @return array<string,mixed> */
    private function build(?string $baseOverride, ?string $customDomain): array
    {
        $m = new ReflectionMethod(AppManifestController::class, 'buildManifest');
        $m->setAccessible(true);
        $req = $this->createMock(ServerRequestInterface::class);
        return $m->invoke($this->controller(), $this->app, $req, $baseOverride, $customDomain);
    }

    public function testCustomDomainManifestIsSameOriginAndCarriesDomain(): void
    {
        $manifest = $this->build('https://mine.example.com', 'mine.example.com');

        $this->assertSame('https://mine.example.com/app/demo', $manifest['source']['url']);
        $this->assertSame('https://mine.example.com/api/app/demo/manifest.json', $manifest['install']['pwa']['manifestUrl']);
        $this->assertSame('https://mine.example.com/.well-known/assetlinks.json', $manifest['install']['android']['assetLinks']);
        $this->assertSame('https://mine.example.com/app/demo', $manifest['install']['android']['openUrl']);
        $this->assertSame('mine.example.com', $manifest['domain']);
    }

    public function testTrailingSlashOnOverrideIsNormalized(): void
    {
        $manifest = $this->build('https://mine.example.com/', 'mine.example.com');
        $this->assertSame('https://mine.example.com/app/demo', $manifest['source']['url']);
    }

    public function testPlatformSlugManifestUsesPlatformBaseAndOmitsDomain(): void
    {
        putenv('APP_URL=https://platform.example');
        $_ENV['APP_URL'] = 'https://platform.example';

        $manifest = $this->build(null, null);

        $this->assertSame('https://platform.example/app/demo', $manifest['source']['url']);
        $this->assertSame('https://platform.example/api/app/demo/manifest.json', $manifest['install']['pwa']['manifestUrl']);
        $this->assertArrayNotHasKey('domain', $manifest, 'platform manifest must not name a custom domain');
    }
}

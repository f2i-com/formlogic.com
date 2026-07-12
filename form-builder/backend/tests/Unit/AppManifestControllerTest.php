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
            'ownerId' => 'owner-uuid-1',
            'updatedAt' => '2026-07-12 10:00:00',
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
    private function build(?string $baseOverride, ?string $customDomain, ?array $nativeConfig = null): array
    {
        $m = new ReflectionMethod(AppManifestController::class, 'buildManifest');
        $m->setAccessible(true);
        $req = $this->createMock(ServerRequestInterface::class);
        return $m->invoke($this->controller(), $this->app, $req, $baseOverride, $customDomain, $nativeConfig);
    }

    public function testCustomDomainManifestIsSameOriginAndCarriesDomain(): void
    {
        $manifest = $this->build('https://mine.example.com', 'mine.example.com');

        $this->assertSame('https://mine.example.com/app/demo', $manifest['source']['url']);
        // Custom-domain PWA manifestUrl points at the same-origin root manifest (hardening #6), NOT the
        // API-origin per-slug manifest — so the installing document stays in scope on the custom domain.
        $this->assertSame('https://mine.example.com/manifest.json', $manifest['install']['pwa']['manifestUrl']);
        $this->assertSame('https://mine.example.com/.well-known/assetlinks.json', $manifest['install']['android']['assetLinks']);
        $this->assertSame('https://mine.example.com/app/demo', $manifest['install']['android']['openUrl']);
        $this->assertSame('mine.example.com', $manifest['domain']);
    }

    public function testTrailingSlashOnOverrideIsNormalized(): void
    {
        $manifest = $this->build('https://mine.example.com/', 'mine.example.com');
        $this->assertSame('https://mine.example.com/app/demo', $manifest['source']['url']);
    }

    /**
     * NATIVE-SEC-001: the SIGNED manifest carries the app identity the native runtime
     * partitions verified state + offline queues by — appId, an OPAQUE account hash
     * (never the raw owner UUID), and a manifest version.
     */
    public function testManifestCarriesSignedAppIdentityForPartitioning(): void
    {
        $manifest = $this->build(null, null);

        $this->assertSame('app-1', $manifest['appId']);
        $this->assertSame('2026-07-12 10:00:00', $manifest['manifestVersion']);
        // accountId is a one-way hash of the owner id: stable, opaque, and the raw
        // UUID must never appear in this public document.
        $this->assertSame(substr(hash('sha256', 'fl-account:owner-uuid-1'), 0, 16), $manifest['accountId']);
        $this->assertStringNotContainsString(
            'owner-uuid-1',
            json_encode($manifest, JSON_THROW_ON_ERROR),
            'raw owner id must not leak into the public manifest'
        );
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

    // ---- hardening #7: per-domain white-label nativeConfig in the SIGNED manifest ------------------

    public function testCustomDomainManifestUsesWhiteLabelNativeConfig(): void
    {
        $manifest = $this->build('https://mine.example.com', 'mine.example.com', [
            'packageName' => 'com.acme.minecab',
            'minRuntimeVersion' => '1.2.3',
            'installUrl' => 'https://play.google.com/store/apps/details?id=com.acme.minecab',
        ]);

        $android = $manifest['install']['android'];
        $this->assertSame('com.acme.minecab', $android['packageName']);
        $this->assertSame('1.2.3', $android['minVersion']);
        $this->assertSame('https://play.google.com/store/apps/details?id=com.acme.minecab', $android['installUrl']);
        // Same-origin links are unaffected by the white-label identity.
        $this->assertSame('https://mine.example.com/.well-known/assetlinks.json', $android['assetLinks']);
        $this->assertSame('https://mine.example.com/app/demo', $android['openUrl']);
    }

    public function testPlatformManifestKeepsGenericRuntimeIdentity(): void
    {
        putenv('APP_URL=https://platform.example');
        $_ENV['APP_URL'] = 'https://platform.example';

        // The platform slug route passes NO nativeConfig — generic runtime identity, no installUrl.
        $manifest = $this->build(null, null);
        $android = $manifest['install']['android'];
        $this->assertSame('com.formlogic.runtime', $android['packageName']);
        $this->assertSame('0.1.0', $android['minVersion']);
        $this->assertArrayNotHasKey('installUrl', $android);
    }

    public function testPartialOrInvalidNativeConfigFallsBackPerField(): void
    {
        // Invalid package + missing version + hostile install URL → every field falls back / is dropped,
        // even if a caller somehow skipped sanitizeNativeConfig (belt and braces in buildManifest).
        $manifest = $this->build('https://mine.example.com', 'mine.example.com', [
            'packageName' => 'not a package!',
            'installUrl' => 'javascript:alert(1)',
        ]);
        $android = $manifest['install']['android'];
        $this->assertSame('com.formlogic.runtime', $android['packageName']);
        $this->assertSame('0.1.0', $android['minVersion']);
        $this->assertArrayNotHasKey('installUrl', $android);
    }

    public function testManifestNeverEmitsFingerprintsOrSecurityConfig(): void
    {
        // Even a hostile/legacy native_config row carrying fingerprints or security material must not
        // surface anywhere in the SIGNED manifest — assetlinks.json is the only fingerprint channel.
        $fp = str_repeat('AB:', 31) . 'CD';
        $manifest = $this->build('https://mine.example.com', 'mine.example.com', [
            'packageName' => 'com.acme.minecab',
            'sha256CertFingerprints' => [$fp],
            'securityConfig' => ['secret' => 'TOPSECRET-nope'],
        ]);

        $json = json_encode($manifest) ?: '';
        $this->assertStringNotContainsString('sha256CertFingerprints', $json);
        $this->assertStringNotContainsString($fp, $json);
        $this->assertStringNotContainsString('securityConfig', $json);
        $this->assertStringNotContainsString('TOPSECRET-nope', $json);
        // …while the whitelisted identity still flows through.
        $this->assertSame('com.acme.minecab', $manifest['install']['android']['packageName']);
    }
}

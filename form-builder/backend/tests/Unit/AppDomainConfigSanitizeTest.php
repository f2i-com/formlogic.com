<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\AppDomainService;
use PHPUnit\Framework\TestCase;

/**
 * Custom-domain config sanitization (#8) + the public native projection (#7).
 *
 * Pure — the sanitizers / projection never touch the DB, so the service is instantiated WITHOUT its
 * constructor (which would open a MySQL connection). This class runs even without a test database.
 */
class AppDomainConfigSanitizeTest extends TestCase
{
    private AppDomainService $svc;

    protected function setUp(): void
    {
        $this->svc = (new \ReflectionClass(AppDomainService::class))->newInstanceWithoutConstructor();
    }

    // ---- landing config -------------------------------------------------------------

    public function testLandingRejectsJavascriptPrivacyUrl(): void
    {
        $out = $this->svc->sanitizeLandingConfig([
            'privacyUrl' => 'javascript:alert(1)',
            'termsUrl' => 'https://acme.com/terms',
        ]);
        $this->assertArrayNotHasKey('privacyUrl', $out); // dropped, not stored
        $this->assertSame('https://acme.com/terms', $out['termsUrl']);
    }

    public function testLandingRejectsNonHttpSchemes(): void
    {
        $out = $this->svc->sanitizeLandingConfig([
            'privacyUrl' => 'ftp://acme.com/p',
            'termsUrl' => 'data:text/html,<script>1</script>',
        ]);
        $this->assertArrayNotHasKey('privacyUrl', $out);
        $this->assertArrayNotHasKey('termsUrl', $out);
    }

    public function testLandingCapsOverLongHeadline(): void
    {
        $out = $this->svc->sanitizeLandingConfig(['headline' => str_repeat('x', 500)]);
        $this->assertSame(120, mb_strlen($out['headline']));
    }

    public function testLandingLogoAllowsHttpsAndDataImageButRejectsJavascript(): void
    {
        $https = $this->svc->sanitizeLandingConfig(['logoUrl' => 'https://cdn.acme.com/logo.png']);
        $this->assertSame('https://cdn.acme.com/logo.png', $https['logoUrl']);

        $dataImg = $this->svc->sanitizeLandingConfig(['logoUrl' => 'data:image/png;base64,AAAA']);
        $this->assertSame('data:image/png;base64,AAAA', $dataImg['logoUrl']);

        $bad = $this->svc->sanitizeLandingConfig(['logoUrl' => 'javascript:alert(1)']);
        $this->assertArrayNotHasKey('logoUrl', $bad);
    }

    public function testLandingSupportEmailValidation(): void
    {
        $ok = $this->svc->sanitizeLandingConfig(['supportEmail' => 'help@acme.com']);
        $this->assertSame('help@acme.com', $ok['supportEmail']);

        $bad = $this->svc->sanitizeLandingConfig(['supportEmail' => 'javascript:alert(1)']);
        $this->assertArrayNotHasKey('supportEmail', $bad);
    }

    public function testLandingNormalizesBooleans(): void
    {
        $out = $this->svc->sanitizeLandingConfig([
            'showOpenWebApp' => 'true',
            'showInstallPwa' => 0,
            'showInstallNative' => true,
            'showPoweredBy' => 'off',
        ]);
        $this->assertTrue($out['showOpenWebApp']);
        $this->assertFalse($out['showInstallPwa']);
        $this->assertTrue($out['showInstallNative']);
        $this->assertFalse($out['showPoweredBy']);
    }

    public function testLandingRoundTripsAValidConfig(): void
    {
        $in = [
            'headline' => 'MineCab',
            'subheadline' => 'Dispatch, simplified',
            'description' => 'Run your fleet.',
            'logoUrl' => 'https://cdn.acme.com/logo.png',
            'privacyUrl' => 'https://acme.com/privacy',
            'termsUrl' => 'https://acme.com/terms',
            'supportEmail' => 'help@acme.com',
            'showOpenWebApp' => true,
            'showInstallPwa' => false,
        ];
        $out = $this->svc->sanitizeLandingConfig($in);
        $this->assertSame('MineCab', $out['headline']);
        $this->assertSame('Dispatch, simplified', $out['subheadline']);
        $this->assertSame('https://cdn.acme.com/logo.png', $out['logoUrl']);
        $this->assertSame('https://acme.com/privacy', $out['privacyUrl']);
        $this->assertSame('help@acme.com', $out['supportEmail']);
        $this->assertTrue($out['showOpenWebApp']);
        $this->assertFalse($out['showInstallPwa']);
    }

    // ---- native config --------------------------------------------------------------

    public function testNativeValidatesPackageName(): void
    {
        $ok = $this->svc->sanitizeNativeConfig(['packageName' => 'com.acme.app']);
        $this->assertSame('com.acme.app', $ok['packageName']);

        // Single-segment / trailing-dot / illegal-char names are dropped.
        $this->assertArrayNotHasKey('packageName', $this->svc->sanitizeNativeConfig(['packageName' => 'nodots']));
        $this->assertArrayNotHasKey('packageName', $this->svc->sanitizeNativeConfig(['packageName' => 'com.acme.']));
        $this->assertArrayNotHasKey('packageName', $this->svc->sanitizeNativeConfig(['packageName' => '1com.acme.app']));
    }

    public function testNativeDropsBadFingerprintKeepsGood(): void
    {
        $good = str_repeat('AB:', 31) . 'CD'; // 32 colon-separated hex byte-pairs
        $out = $this->svc->sanitizeNativeConfig([
            'sha256CertFingerprints' => [$good, 'not-a-fingerprint', 'AB:CD'],
        ]);
        $this->assertSame([$good], $out['sha256CertFingerprints']);
    }

    public function testNativeInstallUrlMustBeHttp(): void
    {
        $ok = $this->svc->sanitizeNativeConfig(['installUrl' => 'https://play.google.com/store/apps/details?id=com.acme.app']);
        $this->assertSame('https://play.google.com/store/apps/details?id=com.acme.app', $ok['installUrl']);

        $this->assertArrayNotHasKey('installUrl', $this->svc->sanitizeNativeConfig(['installUrl' => 'javascript:alert(1)']));
        $this->assertArrayNotHasKey('installUrl', $this->svc->sanitizeNativeConfig(['installUrl' => 'market://details?id=x']));
    }

    public function testNativeCapsVersionAndNormalizesBooleans(): void
    {
        $out = $this->svc->sanitizeNativeConfig([
            'minRuntimeVersion' => str_repeat('9', 100),
            'requireNativeRuntime' => 'yes',
            'showNativeCta' => 0,
        ]);
        $this->assertSame(32, strlen($out['minRuntimeVersion']));
        $this->assertTrue($out['requireNativeRuntime']);
        $this->assertFalse($out['showNativeCta']);
    }

    // ---- public native projection ---------------------------------------------------

    public function testPublicNativeSectionExposesWhitelistNeverFingerprintsOrSecrets(): void
    {
        $native = $this->svc->publicNativeSection([
            'packageName' => 'com.acme.app',
            'sha256CertFingerprints' => [str_repeat('AB:', 31) . 'CD'],
            'minRuntimeVersion' => '0.1.0',
            'installUrl' => 'https://play.google.com/store/apps/details?id=com.acme.app',
            'requireNativeRuntime' => true,
            'showNativeCta' => true,
            // A hostile/legacy row could carry these — they must never surface publicly.
            'security_config' => ['secret' => 'nope'],
            'signingKey' => 'nope',
        ]);

        $this->assertSame(
            ['enabled', 'packageName', 'minRuntimeVersion', 'installUrl', 'requireNativeRuntime', 'showNativeCta'],
            array_keys($native)
        );
        $this->assertTrue($native['enabled']);
        $this->assertSame('com.acme.app', $native['packageName']);
        $this->assertSame('https://play.google.com/store/apps/details?id=com.acme.app', $native['installUrl']);
        // Fingerprints + any security material are intentionally absent.
        $this->assertArrayNotHasKey('sha256CertFingerprints', $native);
        $this->assertStringNotContainsStringIgnoringCase('secret', json_encode($native) ?: '');
    }

    public function testPublicNativeSectionReValidatesLegacyBadInstallUrl(): void
    {
        // Defense in depth: even if an old row stored a non-http install URL, the public projection nulls it.
        $native = $this->svc->publicNativeSection(['installUrl' => 'javascript:alert(1)']);
        $this->assertNull($native['installUrl']);
    }

    public function testPublicNativeSectionEnabledFalseWhenEmpty(): void
    {
        $native = $this->svc->publicNativeSection([]);
        $this->assertFalse($native['enabled']);
        $this->assertNull($native['packageName']);
        $this->assertNull($native['installUrl']);
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\Packages\DistributionVerifier;
use PHPUnit\Framework\TestCase;

/**
 * DESK-501: every one of these refusals happens BEFORE anything is staged. Verifying after
 * staging would leave a window where a tampered artifact already exists on disk, and closing
 * that window then depends on cleanup being perfect.
 */
class DistributionVerifierTest extends TestCase
{
    /** @param array<string,mixed> $overrides */
    private function distribution(array $overrides = [], array $artifactOverrides = []): array
    {
        return array_replace([
            'id' => 'com.acme.image-service',
            'runtimeKind' => 'managed-service',
            'satisfiesSlots' => ['imageGenerator'],
            'definition' => ['schemaVersion' => 3, 'id' => 'com.acme.images'],
            'installPolicy' => 'prompt',
            'artifact' => array_replace([
                'artifactId' => 'acme-image-service',
                'version' => '1.0.0',
                'sha256' => str_repeat('a', 64),
                'sizeBytes' => 1024,
                'platforms' => ['windows-x86_64'],
            ], $artifactOverrides),
        ], $overrides);
    }

    /** @return array{platform:string,arch:string,requireSigned?:bool,signatureVerified?:bool} */
    private function host(array $overrides = []): array
    {
        return array_replace(['platform' => 'windows', 'arch' => 'x86_64'], $overrides);
    }

    public function testRuntimeKindSelectsTheInstaller(): void
    {
        // The field is not advisory: it decides which trusted installer runs, and the two
        // grant different privileges.
        $managed = DistributionVerifier::verify($this->distribution(), $this->host());
        $this->assertTrue($managed['ok'], json_encode($managed));
        $this->assertSame('managed-service-installer', $managed['installer']);

        $plugin = DistributionVerifier::verify($this->distribution(['runtimeKind' => 'desktop-plugin']), $this->host());
        $this->assertSame('desktop-plugin-installer', $plugin['installer']);

        $unknown = DistributionVerifier::verify($this->distribution(['runtimeKind' => 'sneaky-native']), $this->host());
        $this->assertFalse($unknown['ok']);
        $this->assertSame('unsupported_runtime_kind', $unknown['code']);
    }

    public function testAnArtifactForAnotherPlatformIsRefused(): void
    {
        $result = DistributionVerifier::verify(
            $this->distribution([], ['platforms' => ['linux-x86_64', 'darwin-aarch64']]),
            $this->host()
        );
        $this->assertFalse($result['ok']);
        $this->assertSame('platform_unsupported', $result['code']);

        // No platform list = portable.
        $portable = $this->distribution();
        unset($portable['artifact']['platforms']);
        $this->assertTrue(DistributionVerifier::verify($portable, $this->host())['ok']);
    }

    public function testAnOversizedArtifactIsRefusedBeforeTheDownload(): void
    {
        $result = DistributionVerifier::verify(
            $this->distribution([], ['sizeBytes' => DistributionVerifier::MAX_ARTIFACT_BYTES + 1]),
            $this->host()
        );
        $this->assertFalse($result['ok']);
        $this->assertSame('artifact_too_large', $result['code']);
    }

    public function testAMalformedDigestIsRefused(): void
    {
        foreach (['', 'nope', str_repeat('A', 64), str_repeat('a', 63)] as $bad) {
            $result = DistributionVerifier::verify($this->distribution([], ['sha256' => $bad]), $this->host());
            $this->assertFalse($result['ok'], "digest {$bad} must refuse");
            $this->assertSame('invalid_artifact', $result['code']);
        }
    }

    public function testPathsThatEscapeStagingAreRefused(): void
    {
        foreach ([
            '../../windows/system32/evil.exe',
            '/etc/cron.d/evil',
            'C:/Windows/System32/evil.exe',
            '\\\\server\\share\\evil.exe',
            'nested/../../out.exe',
        ] as $path) {
            $result = DistributionVerifier::verify($this->distribution([], ['entryPath' => $path]), $this->host());
            $this->assertFalse($result['ok'], "path {$path} must refuse");
            $this->assertSame('path_escape', $result['code']);
        }

        // A plain nested path is fine.
        $this->assertTrue(
            DistributionVerifier::verify($this->distribution([], ['entryPath' => 'bin/service.exe']), $this->host())['ok']
        );
    }

    public function testAnUnsignedDistributionIsRefusedUnderVerifiedOnlyPolicy(): void
    {
        $host = $this->host(['requireSigned' => true, 'signatureVerified' => false]);
        $result = DistributionVerifier::verify($this->distribution(), $host);
        $this->assertFalse($result['ok']);
        $this->assertSame('unsigned_distribution', $result['code']);

        $signed = $this->host(['requireSigned' => true, 'signatureVerified' => true]);
        $this->assertTrue(DistributionVerifier::verify($this->distribution(), $signed)['ok']);
    }

    public function testFetchedBytesMustMatchTheSignedDigest(): void
    {
        $bytes = 'the real artifact bytes';
        $artifact = ['sha256' => hash('sha256', $bytes), 'sizeBytes' => strlen($bytes)];
        $this->assertTrue(DistributionVerifier::verifyFetched($artifact, $bytes)['ok']);

        // One flipped byte is a TAMPER, not a retry.
        $tampered = DistributionVerifier::verifyFetched($artifact, 'the reaI artifact bytes');
        $this->assertFalse($tampered['ok']);
        $this->assertContains($tampered['code'], ['artifact_digest_mismatch', 'artifact_size_mismatch']);

        // A truncated download is caught by size before the digest even runs.
        $short = DistributionVerifier::verifyFetched($artifact, 'the real');
        $this->assertFalse($short['ok']);
        $this->assertSame('artifact_size_mismatch', $short['code']);
    }
}

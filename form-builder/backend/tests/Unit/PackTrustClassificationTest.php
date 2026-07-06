<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\PackService;
use PHPUnit\Framework\TestCase;

/**
 * PackService::classifyTrust is the single, algorithm-aware source of truth shared by
 * PackController::describe(), the JSON application-package import path, and the ZIP import path
 * (review #6). Pure — no DB. Proves a verifying signature is NOT blanket-'official': only Ed25519
 * (publicly / native-verifiable) is; the symmetric HS256 fallback is 'local-only'.
 */
class PackTrustClassificationTest extends TestCase
{
    public function testEd25519VerifiedIsOfficial(): void
    {
        $this->assertSame('official', PackService::classifyTrust(true, true, 'Ed25519'));
    }

    public function testHs256VerifiedIsLocalOnly(): void
    {
        // A verifying HS256 signature only re-checks on THIS server — never treat it as external trust.
        $this->assertSame('local-only', PackService::classifyTrust(true, true, 'HS256'));
    }

    public function testPresentButFailingSignatureIsUnverified(): void
    {
        // Tampered payload / wrong key: signature present, verification failed — regardless of alg.
        $this->assertSame('unverified', PackService::classifyTrust(true, false, 'Ed25519'));
        $this->assertSame('unverified', PackService::classifyTrust(true, false, 'HS256'));
    }

    public function testNoSignatureIsCommunity(): void
    {
        $this->assertSame('community', PackService::classifyTrust(false, false, ''));
        // An alg string with no signature is still community (verified/alg are irrelevant when unsigned).
        $this->assertSame('community', PackService::classifyTrust(false, true, 'Ed25519'));
    }

    public function testUnknownAlgorithmThatVerifiesIsLocalOnly(): void
    {
        // Any non-Ed25519 algorithm that verifies is treated as local-only (never over-trusted).
        $this->assertSame('local-only', PackService::classifyTrust(true, true, 'weird-hmac'));
        $this->assertSame('local-only', PackService::classifyTrust(true, true, ''));
    }
}

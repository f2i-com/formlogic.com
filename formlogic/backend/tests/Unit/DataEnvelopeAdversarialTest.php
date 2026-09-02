<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\EnvelopeValidator;
use PHPUnit\Framework\TestCase;

/**
 * Shared __flenc:1 adversarial corpus (data-nodes plan §12.2): the PHP
 * EnvelopeValidator and the Rust desktop validator
 * (formerly desktop/src-tauri/src/data/envelope_validator.rs, now maintained with OAIY) must agree case-for-case
 * on docs/contracts/data-envelope-adversarial.json, so a Desktop primary can
 * never be talked into storing what the Cloud would have rejected (or vice
 * versa).
 */
final class DataEnvelopeAdversarialTest extends TestCase
{
    private const CONTRACTS = __DIR__ . '/../../../../docs/contracts';

    public function testCorpusAgreesWithRustValidator(): void
    {
        $path = self::CONTRACTS . '/data-envelope-adversarial.json';
        self::assertFileExists($path);
        $decoded = json_decode((string) file_get_contents($path), true);
        self::assertIsArray($decoded);
        $cases = $decoded['cases'] ?? [];
        self::assertGreaterThanOrEqual(10, count($cases), 'corpus should stay meaningful');

        $validator = new EnvelopeValidator();
        foreach ($cases as $case) {
            $name = $case['name'];
            $expectedRev = $case['expectedRev'] ?? null;
            [$body, $errCode] = $validator->parseRequestBody($case['body']);
            if ($body === null) {
                self::assertFalse($case['ok'], "fixture {$name}: parse rejected but expected ok");
                if (isset($case['code'])) {
                    self::assertSame($case['code'], $errCode, "fixture {$name}: wrong parse error code");
                }
                continue;
            }
            $result = $validator->validateEnvelope(
                $body['envelope'] ?? null,
                'form-e2ee-fixture',
                $case['manifests'],
                $expectedRev === null ? null : (int) $expectedRev,
            );
            if ($case['ok']) {
                self::assertTrue($result['ok'], "fixture {$name}: expected ok, got " . ($result['code'] ?? ''));
            } else {
                self::assertFalse($result['ok'], "fixture {$name}: expected rejection, got ok");
                if (isset($case['code'])) {
                    self::assertSame($case['code'], $result['code'], "fixture {$name}: wrong error code");
                }
            }
        }
    }
}

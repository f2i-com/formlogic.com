<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\EnvelopeValidator;
use PHPUnit\Framework\TestCase;

/**
 * Locks the fail-closed structural rules of docs/E2EE_PRIVATE_FORMS_PLAN.md §6:
 * duplicate-key detection on the RAW body (json_decode hides dupes), single frozen
 * suite pair, exact byte lengths, rev CAS rules, sorted/unique attachments, and
 * manifest-tuple acceptance.
 */
final class EnvelopeValidatorTest extends TestCase
{
    private EnvelopeValidator $validator;

    /** @var list<array{key_id:string, ingest_epoch:int, schema_version:int, schema_hash:string}> */
    private array $manifests;

    protected function setUp(): void
    {
        $this->validator = new EnvelopeValidator();
        $this->manifests = [[
            'key_id' => 'fik_test01',
            'ingest_epoch' => 1,
            'schema_version' => 1,
            'schema_hash' => str_repeat('a', 64),
        ]];
    }

    /** @return array<string,mixed> */
    private function envelope(array $overrides = []): array
    {
        return array_merge([
            '__flenc' => 1,
            'recordId' => '7d444840-9dc0-41a2-8da8-ff8cb9fca735',
            'rev' => 1,
            'keyId' => 'fik_test01',
            'epoch' => 1,
            'content' => 'xchacha20p1305.1',
            'wrap' => 'sealedbox-x25519xsalsa20p1305.1',
            'schemaVersion' => 1,
            'schemaHash' => str_repeat('a', 64),
            'wrappedDek' => base64_encode(str_repeat("\x01", 80)),
            'nonce' => base64_encode(str_repeat("\x02", 24)),
            'ct' => base64_encode(str_repeat("\x03", 64)),
        ], $overrides);
    }

    public function testValidCreateEnvelopePasses(): void
    {
        $result = $this->validator->validateEnvelope($this->envelope(), 'form-1', $this->manifests, null);
        self::assertTrue($result['ok']);
    }

    public function testDuplicateKeysAreRejectedAtRootAndEnvelopeLevel(): void
    {
        // json_decode would silently keep the LAST value of each duplicate — prove the
        // raw-body parser catches what json_decode cannot.
        $dupRoot = '{"envelope":{"__flenc":1},"idempotencyKey":"a","idempotencyKey":"b"}';
        [$decoded, $code] = $this->validator->parseRequestBody($dupRoot);
        self::assertNull($decoded);
        self::assertSame('envelope_invalid', $code);

        $dupEnvelope = '{"envelope":{"__flenc":1,"rev":1,"rev":2},"idempotencyKey":"a"}';
        [$decoded2, $code2] = $this->validator->parseRequestBody($dupEnvelope);
        self::assertNull($decoded2);
        self::assertSame('envelope_invalid', $code2);
        self::assertIsArray(json_decode($dupEnvelope, true), 'sanity: json_decode itself accepts the dup silently');

        [$ok] = $this->validator->parseRequestBody('{"envelope":{"__flenc":1},"idempotencyKey":"a"}');
        self::assertIsArray($ok);
    }

    public function testMalformedJsonAndNonObjectBodiesAreRejected(): void
    {
        foreach (['not json', '[1,2,3]', '"string"', ''] as $raw) {
            [$decoded, $code] = $this->validator->parseRequestBody($raw);
            self::assertNull($decoded, "should reject: {$raw}");
            self::assertNotNull($code);
        }
    }

    public function testUnknownKeysAndPlaintextSmugglingAreRejected(): void
    {
        $r1 = $this->validator->validateEnvelope($this->envelope(['extra' => 1]), 'form-1', $this->manifests);
        self::assertFalse($r1['ok']);
        $r2 = $this->validator->validateEnvelope($this->envelope(['answers' => ['q' => 'smuggled']]), 'form-1', $this->manifests);
        self::assertFalse($r2['ok']);
    }

    public function testVersionAndSuitesAreFrozen(): void
    {
        foreach ([
            ['__flenc' => 2],
            ['content' => 'aes-gcm.1'],
            ['wrap' => 'fk-xchacha20p1305.1'], // deferred suite must NOT be accepted in v1
            ['wrap' => 'hpke-x25519.1'],
        ] as $override) {
            $r = $this->validator->validateEnvelope($this->envelope($override), 'form-1', $this->manifests);
            self::assertFalse($r['ok'], json_encode($override) . ' must be rejected');
            self::assertSame('envelope_invalid', $r['code']);
        }
    }

    public function testByteLengthsAreExact(): void
    {
        // 72-byte blob = the FK-wrap shape that was cut from v1 — must be refused.
        $r1 = $this->validator->validateEnvelope(
            $this->envelope(['wrappedDek' => base64_encode(str_repeat("\x01", 72))]), 'form-1', $this->manifests,
        );
        self::assertFalse($r1['ok']);
        $r2 = $this->validator->validateEnvelope(
            $this->envelope(['nonce' => base64_encode(str_repeat("\x02", 12))]), 'form-1', $this->manifests,
        );
        self::assertFalse($r2['ok']);
        // Non-canonical base64 (unpadded) is refused even though base64_decode accepts it.
        // 80 bytes -> "...=" padded; 24 bytes pads to nothing, so use wrappedDek here.
        $unpadded = rtrim(base64_encode(str_repeat("\x01", 80)), '=');
        self::assertStringNotContainsString('=', $unpadded);
        $r3 = $this->validator->validateEnvelope(
            $this->envelope(['wrappedDek' => $unpadded]), 'form-1', $this->manifests,
        );
        self::assertFalse($r3['ok']);
    }

    public function testRevCasRules(): void
    {
        // Create: rev must be exactly 1.
        $r1 = $this->validator->validateEnvelope($this->envelope(['rev' => 2]), 'form-1', $this->manifests, null);
        self::assertFalse($r1['ok']);
        // Update: rev must equal expectedRev + 1.
        $r2 = $this->validator->validateEnvelope($this->envelope(['rev' => 3]), 'form-1', $this->manifests, 2);
        self::assertTrue($r2['ok']);
        $r3 = $this->validator->validateEnvelope($this->envelope(['rev' => 3]), 'form-1', $this->manifests, 3);
        self::assertFalse($r3['ok']);
        self::assertSame('revision_conflict', $r3['code']);
    }

    public function testAttachmentRules(): void
    {
        $ok = $this->validator->validateEnvelope(
            $this->envelope(['attachments' => ['fil_a1', 'fil_b2']]), 'form-1', $this->manifests,
        );
        self::assertTrue($ok['ok']);
        foreach ([
            [['fil_b2', 'fil_a1']],   // unsorted
            [['fil_a1', 'fil_a1']],   // duplicate
            [['no-prefix']],          // malformed id
            [[]],                     // empty list must be omitted instead
        ] as [$atts]) {
            $r = $this->validator->validateEnvelope(
                $this->envelope(['attachments' => $atts]), 'form-1', $this->manifests,
            );
            self::assertFalse($r['ok'], json_encode($atts) . ' must be rejected');
        }
    }

    public function testManifestTupleAcceptance(): void
    {
        foreach ([
            ['keyId' => 'fik_other'],
            ['epoch' => 2],
            ['schemaVersion' => 2],
            ['schemaHash' => str_repeat('b', 64)],
        ] as $override) {
            $r = $this->validator->validateEnvelope($this->envelope($override), 'form-1', $this->manifests);
            self::assertFalse($r['ok'], json_encode($override) . ' must miss the manifest tuple');
            self::assertSame('key_epoch_retired', $r['code']);
        }
        // A second acceptable manifest (retiring epoch in grace) admits its own tuple.
        $manifests = array_merge($this->manifests, [[
            'key_id' => 'fik_old',
            'ingest_epoch' => 1,
            'schema_version' => 1,
            'schema_hash' => str_repeat('a', 64),
        ]]);
        $r2 = $this->validator->validateEnvelope($this->envelope(['keyId' => 'fik_old']), 'form-1', $manifests);
        self::assertTrue($r2['ok']);
    }

    public function testFieldTypeConfusionIsRejected(): void
    {
        foreach ([
            ['rev' => '1'],
            ['epoch' => '1'],
            ['schemaVersion' => 1.5],
            ['recordId' => 'not-a-uuid'],
            ['recordId' => strtoupper('7d444840-9dc0-41a2-8da8-ff8cb9fca735')],
            ['keyId' => 'pipe|injection'],
            ['schemaHash' => strtoupper(str_repeat('a', 64))],
            ['ct' => ''],
        ] as $override) {
            $r = $this->validator->validateEnvelope($this->envelope($override), 'form-1', $this->manifests);
            self::assertFalse($r['ok'], json_encode($override) . ' must be rejected');
        }
    }

    public function testOversizedRequestAndCtAreRejected(): void
    {
        [$decoded, $code] = $this->validator->parseRequestBody(str_repeat('x', EnvelopeValidator::MAX_REQUEST_BYTES + 1));
        self::assertNull($decoded);
        self::assertSame('payload_too_large', $code);

        $bigCt = base64_encode(random_bytes(1_500_000)); // > MAX_CT_B64_CHARS once encoded
        $r = $this->validator->validateEnvelope($this->envelope(['ct' => $bigCt]), 'form-1', $this->manifests);
        self::assertFalse($r['ok']);
    }
}

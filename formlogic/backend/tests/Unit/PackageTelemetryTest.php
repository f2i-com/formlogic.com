<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Support\PackageTelemetry;
use PHPUnit\Framework\TestCase;

/**
 * OBS-702: telemetry that is safe to leave on everywhere, because redaction is structural.
 *
 * The point of these tests is the NEGATIVE space: a caller must not be able to log an
 * aggregate, an input payload, a credential or a free-text user string even by mistake,
 * because there is no allowed field name for those and every value is coerced to a bounded
 * scalar. Telemetry that must be used carefully gets turned off, and then it is not there
 * when someone needs it.
 */
class PackageTelemetryTest extends TestCase
{
    /** @var list<string> */
    private array $lines = [];

    protected function setUp(): void
    {
        $this->lines = [];
        PackageTelemetry::setSink(function (string $line): void {
            $this->lines[] = $line;
        });
    }

    protected function tearDown(): void
    {
        PackageTelemetry::setSink(null);
    }

    /** @return array<string,mixed> */
    private function decodeLast(): array
    {
        $this->assertNotEmpty($this->lines, 'an event was emitted');
        $line = $this->lines[count($this->lines) - 1];
        $this->assertStringStartsWith('formlogic.telemetry ', $line);
        $decoded = json_decode(substr($line, strlen('formlogic.telemetry ')), true);
        $this->assertIsArray($decoded);
        return $decoded;
    }

    public function testEmitsTheAllowedIdentifiersAndCounts(): void
    {
        PackageTelemetry::emit('package.install', [
            'packageId' => 'com.acme.tools',
            'version' => '1.2.0',
            'trust' => 'official',
            'nodeCount' => 3,
            'outcome' => 'installed',
        ]);
        $this->assertSame([
            'event' => 'package.install',
            'packageId' => 'com.acme.tools',
            'version' => '1.2.0',
            'trust' => 'official',
            'nodeCount' => 3,
            'outcome' => 'installed',
        ], $this->decodeLast());
    }

    public function testFieldsOutsideTheAllowListAreDroppedEntirely(): void
    {
        PackageTelemetry::emit('package.install', [
            'packageId' => 'com.acme.tools',
            // Everything a caller might reach for in a hurry — none of it has a field name.
            'apiKey' => 'sk-live-secret',
            'authorization' => 'Bearer abc',
            'aggregate' => ['contributions' => ['flowNodes' => [['type' => 'x']]]],
            'input' => ['prompt' => 'a private user prompt'],
            'email' => 'someone@example.com',
            'message' => 'free text that could contain anything',
        ]);
        $decoded = $this->decodeLast();

        $this->assertSame(['event', 'packageId'], array_keys($decoded));
        $encoded = json_encode($decoded);
        foreach (['sk-live-secret', 'Bearer', 'private user prompt', 'someone@example.com', 'free text'] as $secret) {
            $this->assertStringNotContainsString($secret, (string) $encoded);
        }
    }

    public function testArrayValuesBecomeCountsSoContentsCannotLeak(): void
    {
        // grantCount IS allowed — but if a caller passes the grant LIST, only its size lands.
        PackageTelemetry::emit('package.install', [
            'grantCount' => ['connector.acme.secretThing', 'connector.acme.other'],
        ]);
        $decoded = $this->decodeLast();
        $this->assertSame(2, $decoded['grantCount']);
        $this->assertStringNotContainsString('secretThing', (string) json_encode($decoded));
    }

    public function testLongValuesAreTruncated(): void
    {
        PackageTelemetry::emit('flow.compile', ['code' => str_repeat('x', 500)]);
        $decoded = $this->decodeLast();
        $this->assertLessThan(500, strlen((string) $decoded['code']));
        $this->assertStringEndsWith('…', (string) $decoded['code']);
    }

    public function testNullsAreOmittedRatherThanEmittedAsNull(): void
    {
        PackageTelemetry::emit('package.update', ['packageId' => 'com.acme.tools', 'previousVersion' => null]);
        $this->assertArrayNotHasKey('previousVersion', $this->decodeLast());
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\SigningService;
use PHPUnit\Framework\TestCase;
use ReflectionClass;
use ReflectionMethod;

/**
 * Tests the pure crypto helpers of SigningService — the canonicalization that lets a signature survive
 * a JSON round-trip (empty {} vs [] must collapse identically), and base64url. The keypair-backed
 * sign()/verify() path needs the DB and is covered by the E2E suite; here we instantiate without the
 * constructor so no DB is required.
 */
class SigningServiceTest extends TestCase
{
    private SigningService $s;

    protected function setUp(): void
    {
        $this->s = (new ReflectionClass(SigningService::class))->newInstanceWithoutConstructor();
    }

    private function call(string $method, array $args)
    {
        $m = new ReflectionMethod(SigningService::class, $method);
        $m->setAccessible(true);
        return $m->invoke($this->s, ...$args);
    }

    public function testCanonicalNormalizesEmptyObjectVsArray(): void
    {
        // An empty object {} (e.g. a PHP stdClass) and an empty array [] must canonicalize identically,
        // otherwise a signature computed on the server would fail after the payload crosses the wire.
        $withObject = ['settings' => new \stdClass(), 'theme' => new \stdClass()];
        $withArray = ['settings' => [], 'theme' => []];
        $this->assertSame($this->call('canonical', [$withObject]), $this->call('canonical', [$withArray]));
    }

    public function testCanonicalIsStableAcrossRoundTrip(): void
    {
        $payload = ['b' => 2, 'a' => 1, 'nested' => ['x' => [], 'y' => 'z']];
        $once = $this->call('canonical', [$payload]);
        // Simulate the payload crossing a JSON boundary (assoc decode), then canonicalize again.
        $roundTripped = json_decode($once, true);
        $twice = $this->call('canonical', [$roundTripped]);
        $this->assertSame($once, $twice);
    }

    public function testBase64UrlRoundTrip(): void
    {
        $bin = random_bytes(64);
        $encoded = $this->call('b64url', [$bin]);
        $this->assertDoesNotMatchRegularExpression('/[+\/=]/', $encoded, 'base64url must not contain + / =');
        $this->assertSame($bin, $this->call('b64urlDecode', [$encoded]));
    }

    public function testKeyId(): void
    {
        $kid = $this->s->keyId();
        $this->assertMatchesRegularExpression('/^formlogic-(ed25519|hs256)-1$/', $kid);
    }
}

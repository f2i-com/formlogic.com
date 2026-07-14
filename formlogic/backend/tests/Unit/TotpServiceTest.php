<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\TotpService;
use PHPUnit\Framework\TestCase;

/**
 * TOTP correctness, locked to RFC 6238 Appendix B (SHA-1 rows, truncated to
 * 6 digits — what Google Authenticator produces) plus drift-window and
 * input-hygiene behavior.
 */
final class TotpServiceTest extends TestCase
{
    /** The RFC 6238 test secret "12345678901234567890" in base32. */
    private const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

    public function testRfc6238Sha1Vectors(): void
    {
        $totp = new TotpService();
        // RFC 6238 Appendix B lists 8-digit codes; the 6-digit code is the same
        // dynamic truncation mod 10^6 (i.e. the last 6 digits).
        $vectors = [
            59 => '94287082',
            1111111109 => '07081804',
            1111111111 => '14050471',
            1234567890 => '89005924',
            2000000000 => '69279037',
            20000000000 => '65353130',
        ];
        foreach ($vectors as $time => $eightDigit) {
            $expected = substr($eightDigit, -6);
            $this->assertSame($expected, $totp->code(self::RFC_SECRET, intdiv($time, TotpService::PERIOD)), "T={$time}");
        }
    }

    public function testVerifyAcceptsCurrentAndAdjacentWindows(): void
    {
        $totp = new TotpService();
        $now = 1111111109;
        $counter = intdiv($now, TotpService::PERIOD);
        $this->assertTrue($totp->verify(self::RFC_SECRET, $totp->code(self::RFC_SECRET, $counter), 1, $now));
        $this->assertTrue($totp->verify(self::RFC_SECRET, $totp->code(self::RFC_SECRET, $counter - 1), 1, $now), 'one step behind (clock drift)');
        $this->assertTrue($totp->verify(self::RFC_SECRET, $totp->code(self::RFC_SECRET, $counter + 1), 1, $now), 'one step ahead');
        $this->assertFalse($totp->verify(self::RFC_SECRET, $totp->code(self::RFC_SECRET, $counter + 2), 1, $now), 'outside the window');
    }

    public function testVerifyToleratesWhitespaceAndRejectsGarbage(): void
    {
        $totp = new TotpService();
        $now = 59;
        $code = $totp->code(self::RFC_SECRET, intdiv($now, TotpService::PERIOD));
        $spaced = substr($code, 0, 3) . ' ' . substr($code, 3);
        $this->assertTrue($totp->verify(self::RFC_SECRET, $spaced, 1, $now), 'authenticator-style "123 456" input');
        $this->assertFalse($totp->verify(self::RFC_SECRET, '12345', 1, $now), 'too short');
        $this->assertFalse($totp->verify(self::RFC_SECRET, 'abcdef', 1, $now), 'not digits');
        $this->assertFalse($totp->verify(self::RFC_SECRET, '', 1, $now));
    }

    public function testGeneratedSecretRoundTrips(): void
    {
        $totp = new TotpService();
        $secret = $totp->generateSecret();
        $this->assertMatchesRegularExpression('/^[A-Z2-7]{32}$/', $secret, '160-bit base32');
        $now = time();
        $code = $totp->code($secret, intdiv($now, TotpService::PERIOD));
        $this->assertTrue($totp->verify($secret, $code, 1, $now));
        $uri = $totp->otpauthUri($secret, 'user@example.com');
        $this->assertStringStartsWith('otpauth://totp/FormLogic:user%40example.com?secret=' . $secret, $uri);
    }
}

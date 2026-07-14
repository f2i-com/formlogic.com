<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * RFC 6238 TOTP (the algorithm Google Authenticator / Authy / 1Password speak):
 * HMAC-SHA1 over a 30-second time counter, 6 digits, base32 secrets. No
 * external dependency — the whole algorithm is ~40 lines and test-locked
 * against the RFC's published vectors (TotpServiceTest).
 */
class TotpService
{
    public const PERIOD = 30;
    public const DIGITS = 6;
    private const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

    /** A fresh 160-bit secret, base32-encoded (the strength RFC 4226 recommends). */
    public function generateSecret(): string
    {
        return $this->base32Encode(random_bytes(20));
    }

    /** The otpauth:// URI an authenticator app enrolls from (rendered as a QR client-side). */
    public function otpauthUri(string $secret, string $accountName, string $issuer = 'FormLogic'): string
    {
        return 'otpauth://totp/' . rawurlencode($issuer) . ':' . rawurlencode($accountName)
            . '?secret=' . $secret
            . '&issuer=' . rawurlencode($issuer)
            . '&algorithm=SHA1&digits=' . self::DIGITS . '&period=' . self::PERIOD;
    }

    /**
     * Verify a submitted code against the secret, accepting ±$window periods of
     * clock drift (default one 30s step each way). Constant-time comparison.
     */
    public function verify(string $secret, string $code, int $window = 1, ?int $now = null): bool
    {
        $code = preg_replace('/\s+/', '', $code) ?? '';
        if (preg_match('/^\d{' . self::DIGITS . '}$/', $code) !== 1) {
            return false;
        }
        $now ??= time();
        $counter = intdiv($now, self::PERIOD);
        for ($i = -$window; $i <= $window; $i++) {
            if (hash_equals($this->code($secret, $counter + $i), $code)) {
                return true;
            }
        }
        return false;
    }

    /** The 6-digit code for one specific time counter (exposed for tests + verify). */
    public function code(string $secret, int $counter): string
    {
        $key = $this->base32Decode($secret);
        $binCounter = pack('N2', ($counter >> 32) & 0xffffffff, $counter & 0xffffffff);
        $hash = hash_hmac('sha1', $binCounter, $key, true);
        $offset = ord($hash[19]) & 0x0f;
        $value = ((ord($hash[$offset]) & 0x7f) << 24)
            | (ord($hash[$offset + 1]) << 16)
            | (ord($hash[$offset + 2]) << 8)
            | ord($hash[$offset + 3]);
        return str_pad((string) ($value % (10 ** self::DIGITS)), self::DIGITS, '0', STR_PAD_LEFT);
    }

    private function base32Encode(string $bytes): string
    {
        $out = '';
        $bits = 0;
        $value = 0;
        foreach (str_split($bytes) as $byte) {
            $value = ($value << 8) | ord($byte);
            $bits += 8;
            while ($bits >= 5) {
                $out .= self::BASE32_ALPHABET[($value >> ($bits - 5)) & 31];
                $bits -= 5;
            }
        }
        if ($bits > 0) {
            $out .= self::BASE32_ALPHABET[($value << (5 - $bits)) & 31];
        }
        return $out;
    }

    private function base32Decode(string $b32): string
    {
        $b32 = strtoupper(str_replace(['=', ' '], '', $b32));
        $out = '';
        $bits = 0;
        $value = 0;
        foreach (str_split($b32) as $chr) {
            $pos = strpos(self::BASE32_ALPHABET, $chr);
            if ($pos === false) {
                continue; // ignore any stray character rather than corrupting the key
            }
            $value = ($value << 5) | $pos;
            $bits += 5;
            if ($bits >= 8) {
                $out .= chr(($value >> ($bits - 8)) & 0xff);
                $bits -= 8;
            }
        }
        return $out;
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Helpers;

use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Resolves the TRUSTED frontend base URL used to build links emailed to users
 * (password reset, invitations). The link host must never be attacker-controlled
 * (e.g. via a request body field or a spoofed Origin) — that enables
 * reset-token / invite-token exfiltration and account takeover.
 *
 * Resolution order (all server-controlled):
 *   1. APP_URL env var (the canonical, explicit choice).
 *   2. The request Origin — only if it exactly matches the CORS allowlist
 *      (CORS_ORIGIN / CORS_ALLOWED_ORIGINS).
 *   3. CORS_ORIGIN (the configured primary frontend origin).
 *   4. The first configured CORS_ALLOWED_ORIGINS entry.
 *   5. None of the above → throw (fail CLOSED). The request Host header is NEVER
 *      used as a fallback: it is attacker-controllable and would let a spoofed
 *      Host funnel a victim's reset/invite token to an attacker domain.
 */
final class AppUrl
{
    public static function frontendBase(Request $request): string
    {
        $appUrl = self::env('APP_URL');
        if ($appUrl !== '') {
            return rtrim($appUrl, '/');
        }

        $origin = $request->getHeaderLine('Origin');
        if ($origin !== '' && in_array($origin, self::allowedOrigins(), true)) {
            return rtrim($origin, '/');
        }

        $corsOrigin = self::env('CORS_ORIGIN');
        if ($corsOrigin !== '') {
            return rtrim($corsOrigin, '/');
        }

        // Last server-trusted source: the first configured CORS allowlist entry.
        $allowed = self::allowedOrigins();
        if (!empty($allowed)) {
            return rtrim($allowed[0], '/');
        }

        // No server-trusted base configured. Fail CLOSED rather than derive the host
        // from the (attacker-controllable) request Host header. Both callers wrap
        // this in try/catch (best-effort email), so a reset/invite link is simply
        // not sent until APP_URL (or CORS_ORIGIN / CORS_ALLOWED_ORIGINS) is set.
        throw new \RuntimeException(
            'No trusted frontend base URL configured; set APP_URL (or CORS_ORIGIN / CORS_ALLOWED_ORIGINS) to enable emailed links.'
        );
    }

    /** @return string[] */
    private static function allowedOrigins(): array
    {
        $list = array_filter(array_map('trim', explode(',', self::env('CORS_ALLOWED_ORIGINS'))));
        $single = self::env('CORS_ORIGIN');
        if ($single !== '') {
            $list[] = $single;
        }
        return array_values(array_unique($list));
    }

    private static function env(string $key): string
    {
        $val = getenv($key);
        if ($val === false || $val === '') {
            $val = $_ENV[$key] ?? '';
        }
        return is_string($val) ? trim($val) : '';
    }
}

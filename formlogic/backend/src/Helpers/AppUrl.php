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

    /**
     * This site's own address when there's no request to go on: only ever what the server was told.
     * A loopback CORS origin is the .env.example default, not an address, and outside development
     * nobody could reach it: better no sign-in address for a domain than a dead one.
     */
    public static function configuredBase(): ?string
    {
        $appUrl = self::env('APP_URL');
        if ($appUrl !== '') {
            return rtrim($appUrl, '/');
        }
        $development = self::env('APP_ENV') === 'development';
        foreach ([self::env('CORS_ORIGIN'), self::allowedOrigins()[0] ?? ''] as $base) {
            if ($base !== '' && ($development || !self::isLoopback($base))) {
                return rtrim($base, '/');
            }
        }
        return null;
    }

    private static function isLoopback(string $origin): bool
    {
        $host = strtolower((string) parse_url($origin, PHP_URL_HOST));
        return $host === 'localhost' || str_ends_with($host, '.localhost') || $host === '[::1]' || preg_match('/^127(\.\d{1,3}){3}$/D', $host) === 1;
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

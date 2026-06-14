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
 *   3. CORS_ORIGIN (the configured primary frontend origin; defaults to the dev
 *      origin in config).
 *   4. The request's own scheme+host as a last resort.
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

        $uri = $request->getUri();
        $port = $uri->getPort();
        $authority = $uri->getHost() . ($port && !in_array($port, [80, 443], true) ? ':' . $port : '');
        return $uri->getScheme() . '://' . $authority;
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

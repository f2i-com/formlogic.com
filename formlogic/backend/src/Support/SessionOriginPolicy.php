<?php

declare(strict_types=1);

namespace FormLogic\Support;

use Psr\Http\Message\ServerRequestInterface as Request;

/** Explicit browser origins allowed to create cookie-authenticated sessions. */
final class SessionOriginPolicy
{
    /** @var array<string, true> */
    private array $origins = [];

    /**
     * Every entry must be an exact HTTP(S) origin. An absent or malformed policy
     * fails closed; CORS wildcards do not confer permission to mint sessions.
     * @param array<mixed> $origins
     */
    public function __construct(array $origins)
    {
        foreach ($origins as $origin) {
            $normalized = is_string($origin) ? self::normalizeOrigin($origin) : null;
            if ($normalized === null) {
                $this->origins = [];
                return;
            }
            $this->origins[$normalized] = true;
        }
    }

    public function allows(Request $request): bool
    {
        $origins = $request->getHeader('Origin');
        if ($this->origins === [] || count($origins) !== 1) {
            return false;
        }
        $origin = self::normalizeOrigin($origins[0]);
        if ($origin === null || !isset($this->origins[$origin])) {
            return false;
        }

        $sites = $request->getHeader('Sec-Fetch-Site');
        if ($sites === []) {
            // Older clients still need an explicit allowed Origin. No separate
            // CLI, request Host, Referer, or forwarded-header bypass exists.
            return true;
        }
        // Fetch Metadata is a consistency signal, never an authority source.
        // "none" describes directly user-initiated navigation, not these JSON
        // session-creation calls. A split-origin SPA may legitimately be cross-site.
        // Do not infer public origin relationships from a proxy's internal URI.
        return count($sites) === 1
            && in_array($sites[0], ['same-origin', 'same-site', 'cross-site'], true);
    }

    /**
     * The host of a sign-in posted from the page's own origin, or null. This alone admits
     * nothing: the caller also needs that host's connected-domain row, and what it grants is
     * limited to that app (AppDomainSession). Origin must name the host the request reached and
     * Fetch Metadata, where a browser sends it, must agree, so a page anywhere else cannot post
     * here as that domain, the domain's own owner included once the name points away. Hostnames
     * are compared, not ports: Slim drops the port from Host, a TLS proxy changes it, and Fetch
     * Metadata already holds a browser to the exact origin.
     */
    public static function sameHostOrigin(Request $request, bool $httpsOnly): ?string
    {
        $origins = $request->getHeader('Origin');
        $hosts = $request->getHeader('Host');
        if (count($origins) !== 1 || count($hosts) !== 1) {
            return null;
        }
        $origin = self::normalizeOrigin($origins[0]);
        $parts = $origin !== null ? parse_url($origin) : false;
        if ($parts === false || ($httpsOnly && ($parts['scheme'] ?? '') !== 'https')) {
            return null;
        }
        $reached = strtolower(rtrim((string) preg_replace('/:\d+$/D', '', trim($hosts[0])), '.'));
        if (($parts['host'] ?? '') !== $reached) {
            return null;
        }
        $sites = $request->getHeader('Sec-Fetch-Site');
        if ($sites !== [] && $sites !== ['same-origin']) {
            return null;
        }
        return $parts['host'] ?? null;
    }

    /** Shared exact-origin comparison with CORS; never accepts wildcard patterns. */
    public static function normalizeOrigin(string $origin): ?string
    {
        if (!preg_match('~^https?://(?:\[[a-f0-9:.]+\]|[a-z0-9.-]+)(?::[0-9]{1,5})?$~iD', $origin)) {
            return null;
        }
        $parts = parse_url($origin);
        if ($parts === false || !isset($parts['scheme'], $parts['host'])
            || array_diff(array_keys($parts), ['scheme', 'host', 'port']) !== []) {
            return null;
        }
        $scheme = strtolower($parts['scheme']);
        $host = strtolower($parts['host']);
        if (!in_array($scheme, ['http', 'https'], true)) {
            return null;
        }
        if (str_starts_with($host, '[')) {
            if (!str_ends_with($host, ']') || filter_var(substr($host, 1, -1), FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) === false) {
                return null;
            }
        } elseif (strlen($host) > 253 || !preg_match('/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/D', $host)) {
            return null;
        }
        $defaultPort = $scheme === 'https' ? 443 : 80;
        $port = $parts['port'] ?? $defaultPort;
        if ($port < 1 || $port > 65535) {
            return null;
        }
        return $scheme . '://' . $host . ($port === $defaultPort ? '' : ':' . $port);
    }
}

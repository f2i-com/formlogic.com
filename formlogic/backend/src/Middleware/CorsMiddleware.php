<?php

declare(strict_types=1);

namespace FormLogic\Middleware;

use FormLogic\Support\SessionOriginPolicy;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface as RequestHandler;
use Slim\Psr7\Response as SlimResponse;

class CorsMiddleware implements MiddlewareInterface
{
    private string $defaultOrigin;
    private ?array $allowedOrigins;
    private bool $isWildcardMode = false;

    /** The app-configured instance, for callers that bypass the PSR pipeline (SSE takeover). */
    private static ?CorsMiddleware $active = null;

    public static function setActive(?CorsMiddleware $instance): void
    {
        self::$active = $instance;
    }

    public static function active(): ?CorsMiddleware
    {
        return self::$active;
    }

    /**
     * @param string $defaultOrigin Default allowed origin (for single-origin mode)
     * @param array|null $allowedOrigins Array of allowed origins (for multi-origin mode), or null for single-origin
     */
    public function __construct(string $defaultOrigin = 'http://localhost:5173', ?array $allowedOrigins = null)
    {
        $this->defaultOrigin = $defaultOrigin;
        $this->allowedOrigins = $allowedOrigins;
        // An explicit allowlist takes precedence over the single-origin default.
        $this->isWildcardMode = ($allowedOrigins === null && $defaultOrigin === '*');
    }

    public function process(Request $request, RequestHandler $handler): Response
    {
        $requestOrigin = $this->getRequestOrigin($request);
        $allowedOrigin = $this->validateOrigin($requestOrigin);

        // Handle preflight requests
        if ($request->getMethod() === 'OPTIONS') {
            $response = new SlimResponse();
            return $this->addCorsHeaders($response, $allowedOrigin);
        }

        $response = $handler->handle($request);
        return $this->addCorsHeaders($response, $allowedOrigin);
    }

    /** The headers this adds, for an answer made outside it (SqlErrorGuardMiddleware). */
    public function withCorsHeaders(Request $request, Response $response): Response
    {
        return $this->addCorsHeaders($response, $this->validateOrigin($this->getRequestOrigin($request)));
    }

    /**
     * Get the Origin header from the request
     */
    private function getRequestOrigin(Request $request): ?string
    {
        $origins = $request->getHeader('Origin');
        return !empty($origins) ? $origins[0] : null;
    }

    /**
     * Validate the request origin against allowed origins
     * Returns the allowed origin to use in the response, or null if not allowed
     */
    private function validateOrigin(?string $requestOrigin): ?string
    {
        // No origin header (e.g., same-origin request or non-browser client)
        if ($requestOrigin === null) {
            return $this->defaultOrigin;
        }

        // Never allow wildcard origins when credentials are enabled
        // This is a security requirement per CORS spec
        if ($this->isWildcardMode) {
            // In wildcard mode, return literal '*' — don't reflect the origin
            // as reflection could allow targeted cross-origin reads
            return '*';
        }

        // Multi-origin mode: check against allowlist
        if ($this->allowedOrigins !== null) {
            foreach ($this->allowedOrigins as $allowed) {
                if ($this->originMatches($requestOrigin, $allowed)) {
                    return $requestOrigin;
                }
            }
            // Origin not in the allowlist: send NO Access-Control-Allow-Origin header
            // at all (cleaner + smaller surface than returning a mismatched default).
            return null;
        }

        // Single-origin mode: strict match only
        if ($this->originMatches($requestOrigin, $this->defaultOrigin)) {
            return $requestOrigin;
        }

        // Origin doesn't match: omit the CORS header entirely.
        return null;
    }

    /**
     * The origin value a response to $requestOrigin may carry, or null for none —
     * the public face of validateOrigin() for callers outside the PSR pipeline.
     */
    public function allowedOriginFor(?string $requestOrigin): ?string
    {
        return $this->validateOrigin($requestOrigin === '' ? null : $requestOrigin);
    }

    /**
     * Emit the CORS headers via raw header() for SSE routes that take over the
     * connection (echo + exit): the PSR response this middleware decorates never
     * reaches the client there, so without this a cross-origin stream reader is
     * blocked even though the allowlist would have admitted the origin.
     */
    public function emitRawSseHeaders(?string $requestOrigin = null): void
    {
        $origin = $requestOrigin;
        if ($origin === null && is_string($_SERVER['HTTP_ORIGIN'] ?? null)) {
            $origin = $_SERVER['HTTP_ORIGIN'];
        }
        $allowed = $this->allowedOriginFor($origin);
        if ($allowed === null) {
            return;
        }
        header('Access-Control-Allow-Origin: ' . $allowed);
        if ($allowed !== '*' && !$this->isWildcardMode) {
            header('Access-Control-Allow-Credentials: true');
        }
        header('Vary: Origin');
    }

    /**
     * Check if origin matches allowed pattern
     * Supports exact match and wildcard subdomains (*.example.com)
     */
    private function originMatches(string $origin, string $pattern): bool
    {
        // CORS and session creation must agree on exact HTTP(S) origins, including
        // case and explicit default ports, or split-origin login succeeds server-
        // side while the browser is denied access to its response.
        $normalizedOrigin = SessionOriginPolicy::normalizeOrigin($origin);
        $normalizedPattern = SessionOriginPolicy::normalizeOrigin($pattern);
        if ($normalizedOrigin !== null && $normalizedOrigin === $normalizedPattern) {
            return true;
        }

        // Wildcard subdomain match (e.g., *.example.com)
        if ($normalizedOrigin !== null && str_starts_with($pattern, '*.')) {
            $domain = strtolower(substr($pattern, 2));
            $parsed = parse_url($normalizedOrigin);
            if ($parsed && isset($parsed['host'])) {
                $host = $parsed['host'];
                // Check if host ends with .domain or is exactly domain
                if ($host === $domain || str_ends_with($host, '.' . $domain)) {
                    $patternScheme = parse_url($pattern, PHP_URL_SCHEME) ?? 'https';
                    $originScheme = $parsed['scheme'] ?? 'https';
                    if ($originScheme !== $patternScheme) {
                        return false;
                    }
                    // The browser treats a non-default port as a distinct origin, so
                    // a wildcard match must NOT silently accept arbitrary ports on an
                    // allowed subdomain (e.g. https://app.example.com:1337). Only the
                    // scheme's default port qualifies for credentialed access.
                    $defaultPort = $originScheme === 'https' ? 443 : ($originScheme === 'http' ? 80 : null);
                    $originPort = $parsed['port'] ?? $defaultPort;
                    return $originPort === $defaultPort;
                }
            }
        }

        return false;
    }

    private function addCorsHeaders(Response $response, ?string $allowedOrigin): Response
    {
        if ($allowedOrigin === null) {
            // No valid origin - don't add CORS headers
            return $response;
        }

        $response = $response
            ->withHeader('Access-Control-Allow-Origin', $allowedOrigin)
            // X-FormLogic-Client-Engine: what a hosted app frame's actions claim (HostedAppFrame); on
            // a split-origin deployment every such action preflights, and the preflight must list it.
            ->withHeader('Access-Control-Allow-Headers', 'X-Requested-With, Content-Type, Accept, Origin, Authorization, X-CSRF-Token, X-Admin-Confirmation, X-FormLogic-Client-Engine, X-FormLogic-Hosted-Actor')
            ->withHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
            // A page can read only the headers named here on a reply from another origin, so on a
            // split-domain site it would never learn that the release changed.
            ->withHeader('Access-Control-Expose-Headers', ReleaseHeaderMiddleware::HEADER)
            ->withHeader('Access-Control-Max-Age', '3600');

        // Only allow credentials for non-wildcard origins
        // In wildcard mode, the origin is reflected but credentials must NOT be allowed
        if ($allowedOrigin !== '*' && !$this->isWildcardMode) {
            $response = $response->withHeader('Access-Control-Allow-Credentials', 'true');
        }

        // Add Vary header to ensure proper caching
        $response = $response->withHeader('Vary', 'Origin');

        return $response;
    }
}

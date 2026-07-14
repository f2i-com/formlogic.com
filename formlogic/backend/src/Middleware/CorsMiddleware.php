<?php

declare(strict_types=1);

namespace FormLogic\Middleware;

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

    /**
     * @param string $defaultOrigin Default allowed origin (for single-origin mode)
     * @param array|null $allowedOrigins Array of allowed origins (for multi-origin mode), or null for single-origin
     */
    public function __construct(string $defaultOrigin = 'http://localhost:5173', ?array $allowedOrigins = null)
    {
        $this->defaultOrigin = $defaultOrigin;
        $this->allowedOrigins = $allowedOrigins;
        $this->isWildcardMode = ($defaultOrigin === '*');
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
        if ($this->defaultOrigin === '*') {
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
     * Check if origin matches allowed pattern
     * Supports exact match and wildcard subdomains (*.example.com)
     */
    private function originMatches(string $origin, string $pattern): bool
    {
        // Exact match
        if ($origin === $pattern) {
            return true;
        }

        // Wildcard subdomain match (e.g., *.example.com)
        if (str_starts_with($pattern, '*.')) {
            $domain = substr($pattern, 2);
            $parsed = parse_url($origin);
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
            ->withHeader('Access-Control-Allow-Headers', 'X-Requested-With, Content-Type, Accept, Origin, Authorization, X-CSRF-Token')
            ->withHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
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

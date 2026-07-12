<?php

declare(strict_types=1);

namespace FormLogic\Middleware;

use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface as RequestHandler;

class SecurityHeadersMiddleware implements MiddlewareInterface
{
    private bool $isProduction;

    public function __construct(bool $isProduction = false)
    {
        $this->isProduction = $isProduction;
    }

    public function process(Request $request, RequestHandler $handler): Response
    {
        $response = $handler->handle($request);

        // Prevent clickjacking
        $response = $response->withHeader('X-Frame-Options', 'DENY');

        // Prevent MIME type sniffing
        $response = $response->withHeader('X-Content-Type-Options', 'nosniff');

        // XSS Protection (legacy but still useful for older browsers)
        $response = $response->withHeader('X-XSS-Protection', '1; mode=block');

        // Prevent proxy/browser caching of API responses (may contain sensitive
        // data). Don't clobber a handler that set its own policy — e.g. the file
        // endpoint marks immutable uploaded assets cacheable; unconditionally
        // overwriting that with no-store made its caching contract dead code.
        if (!$response->hasHeader('Cache-Control')) {
            $response = $response->withHeader('Cache-Control', 'no-store');
        }

        // Referrer Policy - don't leak referrer to other origins
        $response = $response->withHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

        // Permissions Policy - disable potentially dangerous browser features.
        // geolocation/camera stay SELF-only (not denied) to match the SPA
        // .htaccess: the form runtime's Location + Camera fields need them.
        $response = $response->withHeader(
            'Permissions-Policy',
            'geolocation=(self), microphone=(), camera=(self), payment=()'
        );

        // HSTS - only in production and over HTTPS
        if ($this->isProduction) {
            $response = $response->withHeader(
                'Strict-Transport-Security',
                'max-age=31536000; includeSubDomains'
            );
        }

        // Content Security Policy - restrictive by default for API
        // This is a basic CSP for an API; frontend would have different needs
        $csp = implode('; ', [
            "default-src 'none'",
            "frame-ancestors 'none'",
            "base-uri 'none'",
            "form-action 'none'",
        ]);
        $response = $response->withHeader('Content-Security-Policy', $csp);

        return $response;
    }
}

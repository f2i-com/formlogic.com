<?php

declare(strict_types=1);

namespace FormLogic\Middleware;

use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface as RequestHandler;
use Slim\Psr7\Response as SlimResponse;

/**
 * CSRF protection using the Double Submit Cookie pattern.
 *
 * How it works:
 * - On login/register, a random CSRF token is set as a non-HttpOnly cookie
 *   (so the frontend JS can read it).
 * - On every state-changing request (POST/PUT/DELETE), this middleware
 *   checks that the X-CSRF-Token header matches the csrf cookie value.
 * - An attacker on a different origin cannot read the cookie (same-origin policy)
 *   and therefore cannot forge the header.
 */
class CsrfMiddleware implements MiddlewareInterface
{
    private string $cookieName;
    private string $headerName;

    public function __construct(
        string $cookieName = 'formlogic_csrf',
        string $headerName = 'X-CSRF-Token'
    ) {
        $this->cookieName = $cookieName;
        $this->headerName = $headerName;
    }

    public function process(Request $request, RequestHandler $handler): Response
    {
        $method = strtoupper($request->getMethod());

        // Only validate on state-changing methods
        if (!in_array($method, ['POST', 'PUT', 'PATCH', 'DELETE'], true)) {
            return $handler->handle($request);
        }

        // Skip validation for public endpoints that don't use cookie auth
        // (e.g. public form submissions that may come from embedded forms)
        $path = $request->getUri()->getPath();
        if ($this->isExempt($path, $method)) {
            return $handler->handle($request);
        }

        // If there's no auth cookie, skip CSRF check (the request will fail
        // at the auth middleware anyway, or it's a public endpoint)
        $cookies = $request->getCookieParams();
        if (empty($cookies['formlogic_auth'])) {
            return $handler->handle($request);
        }

        $csrfCookie = $cookies[$this->cookieName] ?? '';
        $csrfHeader = $request->getHeaderLine($this->headerName);

        if (empty($csrfCookie) || empty($csrfHeader) || !hash_equals($csrfCookie, $csrfHeader)) {
            return $this->forbidden('CSRF token validation failed');
        }

        return $handler->handle($request);
    }

    /**
     * Check if a route is exempt from CSRF validation.
     */
    private function isExempt(string $path, string $method): bool
    {
        // Login/register/logout - these set/clear the CSRF token
        if (str_starts_with($path, '/api/auth/')) {
            return true;
        }

        // Public form submission endpoint (no cookie auth, uses rate limiting instead)
        if ($method === 'POST' && preg_match('#^/api/forms/[^/]+/responses$#', $path)) {
            return true;
        }

        return false;
    }

    /**
     * Generate a cryptographically secure CSRF token.
     */
    public static function generateToken(): string
    {
        return bin2hex(random_bytes(32));
    }

    private function forbidden(string $message): Response
    {
        $response = new SlimResponse();
        $response->getBody()->write(json_encode([
            'error' => true,
            'message' => $message,
        ]));

        return $response
            ->withStatus(403)
            ->withHeader('Content-Type', 'application/json');
    }
}

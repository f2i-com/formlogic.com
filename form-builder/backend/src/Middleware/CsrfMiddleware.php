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
    private string $authCookieName;
    private string $secret;

    public function __construct(
        string $cookieName = 'formlogic_csrf',
        string $headerName = 'X-CSRF-Token',
        string $authCookieName = 'formlogic_auth',
        string $secret = ''
    ) {
        $this->cookieName = $cookieName;
        $this->headerName = $headerName;
        $this->authCookieName = $authCookieName;
        $this->secret = $secret;
    }

    public function process(Request $request, RequestHandler $handler): Response
    {
        $method = strtoupper($request->getMethod());

        // Only validate on state-changing methods
        if (!in_array($method, ['POST', 'PUT', 'PATCH', 'DELETE'], true)) {
            return $handler->handle($request);
        }

        $path = $request->getUri()->getPath();

        // Cookie-SETTING auth routes (login/register) can't use the double-submit
        // token because they MINT it — but a blanket exemption made them a login-CSRF
        // hole. Guard them by requiring a JSON content-type: a cross-site
        // auto-submitting <form> can only send simple content-types
        // (form-urlencoded / multipart / text-plain) without a CORS preflight, so
        // this blocks the form vector; a JSON fetch from another origin triggers a
        // preflight the CORS allowlist rejects. The SPA already sends JSON.
        if ($this->isAuthCookieSettingRoute($path)) {
            $contentType = strtolower($request->getHeaderLine('Content-Type'));
            if (strpos($contentType, 'application/json') === false) {
                return $this->forbidden('Login and registration require a JSON request');
            }
            return $handler->handle($request);
        }

        // Skip validation for public endpoints that don't use cookie auth
        // (e.g. public form submissions that may come from embedded forms)
        if ($this->isExempt($path, $method)) {
            return $handler->handle($request);
        }

        // If there's no auth cookie, skip CSRF check (the request will fail
        // at the auth middleware anyway, or it's a public endpoint)
        $cookies = $request->getCookieParams();
        if (empty($cookies[$this->authCookieName])) {
            return $handler->handle($request);
        }

        $csrfHeader = $request->getHeaderLine($this->headerName);
        $authToken = (string) ($cookies[$this->authCookieName] ?? '');

        // Misconfiguration must fail CLOSED and loudly (audit FL-AUTH-001):
        // without the HMAC secret there is no forgery-proof token to check,
        // and silently degrading to plain double-submit is exactly the
        // weakness this middleware exists to prevent.
        if ($this->secret === '') {
            return $this->forbidden('CSRF protection is misconfigured (no signing secret) — set JWT_SECRET');
        }

        // The CSRF token must be the HMAC of THIS session's auth token, so a
        // token minted for another session/user — or an attacker-set
        // cookie/header pair — can never be replayed. The transitional plain
        // double-submit fallback (audit FL-AUTH-001) is retired: sessions
        // predating the bound token have long expired, and double-submit is
        // forgeable by anyone who can set a cookie (a subdomain, or a
        // non-HTTPS sibling origin).
        $boundOk = $authToken !== ''
            && hash_equals(self::tokenForAuth($authToken, $this->secret), $csrfHeader ?: '');
        if (!$boundOk) {
            return $this->forbidden('CSRF token validation failed');
        }

        return $handler->handle($request);
    }

    /**
     * Check if a route is exempt from CSRF validation.
     */
    private function isExempt(string $path, string $method): bool
    {
        // Public form submission endpoint (no cookie auth, uses rate limiting instead)
        if ($method === 'POST' && preg_match('#^/api/forms/[^/]+/responses$#', $path)) {
            return true;
        }

        return false;
    }

    /**
     * Cookie-setting auth routes that mint the CSRF token (so they can't validate
     * it). Handled with a JSON-content-type guard instead of a blanket exemption.
     */
    private function isAuthCookieSettingRoute(string $path): bool
    {
        // Note: /api/auth/me and /api/auth/logout are NOT here — they require CSRF.
        // /api/auth/mfa/verify completes a two-step login (it mints the auth cookie
        // pre-session), so it gets the same JSON-content-type guard.
        return in_array($path, ['/api/auth/login', '/api/auth/register', '/api/auth/mfa/verify'], true);
    }

    /**
     * Generate a cryptographically secure random CSRF token.
     */
    public static function generateToken(): string
    {
        return bin2hex(random_bytes(32));
    }

    /**
     * Derive a CSRF token bound to a specific auth token (HMAC). The issuing side
     * (AuthController::setCsrfCookie) and this validating side compute it the same
     * way, so the token is only valid for the session it was minted for.
     */
    public static function tokenForAuth(string $authToken, string $secret): string
    {
        return hash_hmac('sha256', $authToken, $secret);
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

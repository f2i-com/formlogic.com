<?php

declare(strict_types=1);

namespace FormLogic\Middleware;

use FormLogic\Support\SessionOriginPolicy;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface as RequestHandler;
use Slim\Psr7\Response as SlimResponse;

/**
 * CSRF protection bound to the authenticated session.
 *
 * How it works:
 * - Cookie-setting routes require JSON and an explicitly trusted request origin.
 * - On login/register, the host sets a readable CSRF cookie derived by HMAC from
 *   that session's auth token and the configured signing context.
 * - Authenticated state-changing requests must send that derived value in the
 *   X-CSRF-Token header. A caller-controlled cookie/header pair is not sufficient,
 *   and a CSRF value from another session cannot authorize the current one.
 */
class CsrfMiddleware implements MiddlewareInterface
{
    private string $cookieName;
    private string $headerName;
    private string $authCookieName;
    private string $secret;
    private SessionOriginPolicy $sessionOriginPolicy;

    public function __construct(
        string $cookieName = 'formlogic_csrf',
        string $headerName = 'X-CSRF-Token',
        string $authCookieName = 'formlogic_auth',
        string $secret = '',
        array $trustedSessionOrigins = []
    ) {
        $this->cookieName = $cookieName;
        $this->headerName = $headerName;
        $this->authCookieName = $authCookieName;
        $this->secret = $secret;
        $this->sessionOriginPolicy = new SessionOriginPolicy($trustedSessionOrigins);
    }

    public function process(Request $request, RequestHandler $handler): Response
    {
        $method = strtoupper($request->getMethod());

        // Only validate on state-changing methods
        if (!in_array($method, ['POST', 'PUT', 'PATCH', 'DELETE'], true)) {
            return $handler->handle($request);
        }

        // The path is judged as the router will match it: percent-decoded
        // (Slim\Routing\RouteResolver::computeRoutingResults). On the raw path,
        // /api/auth/logi%6E was not one of the cookie-setting routes below, though it
        // runs the login route, and a signed-out visitor carries no auth cookie, so a
        // cross-site form posted there passed with no check at all.
        $path = rawurldecode($request->getUri()->getPath());
        if ($path === '' || $path[0] !== '/') {
            $path = '/' . $path;
        }

        // Cookie-setting routes mint the session and cannot validate its token yet.
        // Require one JSON content type and an explicitly configured browser origin
        // before invoking them. CORS alone only controls response readability: it
        // does not reject non-OPTIONS requests before the handler's effects.
        if ($this->isAuthCookieSettingRoute($path)) {
            $contentTypes = $request->getHeader('Content-Type');
            $contentType = $contentTypes[0] ?? '';
            $mediaType = strtolower(trim(explode(';', $contentType, 2)[0]));
            if (count($contentTypes) !== 1 || str_contains($contentType, ',') || $mediaType !== 'application/json') {
                return $this->forbidden('Login and registration require a JSON request');
            }
            if ($this->secret === '') {
                return $this->forbidden('CSRF protection is misconfigured (no signing secret) - set JWT_SECRET');
            }
            if (!$this->sessionOriginPolicy->allows($request)) {
                return $this->forbidden('Session creation requires an explicitly trusted request origin');
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
     * it). Require JSON and explicit origin admission instead of an exemption.
     */
    private function isAuthCookieSettingRoute(string $path): bool
    {
        // Note: /api/auth/me and /api/auth/logout are NOT here — they require CSRF.
        // /api/auth/mfa/verify completes a two-step login (it mints the auth cookie
        // pre-session), so it gets the same JSON-content-type guard.
        // /api/demo/start mints a session too; without the guard any cross-site
        // <form> POST logs a signed-out visitor into the shared demo account.
        return in_array($path, ['/api/auth/login', '/api/auth/register', '/api/auth/mfa/verify', '/api/demo/start'], true);
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

    /** Keep missing signing configuration missing, rather than hashing an empty fallback. */
    public static function secretForJwt(string $jwtSecret): string
    {
        return $jwtSecret === '' ? '' : hash('sha256', 'formlogic-csrf:' . $jwtSecret);
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

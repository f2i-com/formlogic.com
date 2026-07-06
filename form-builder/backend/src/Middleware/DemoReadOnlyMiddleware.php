<?php

declare(strict_types=1);

namespace FormLogic\Middleware;

use FormLogic\Services\AuthService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface as RequestHandler;
use Slim\Psr7\Response as SlimResponse;

/**
 * Makes the shared public "Demo" account read-only on the server: any mutating request (POST/PUT/PATCH/
 * DELETE) authenticated as the Demo account is rejected, except a tiny whitelist (entering/leaving the
 * demo). Visitors' own data lives in their browser (IndexedDB, client-side overlay) — nothing they do can
 * change the shared demo for anyone else, so it can't be polluted or vandalised.
 *
 * Self-contained (validates the JWT itself) so it can run as global middleware regardless of where the
 * per-route auth middleware sits in the stack.
 */
class DemoReadOnlyMiddleware implements MiddlewareInterface
{
    private const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

    private AuthService $authService;
    private string $demoEmail;
    private string $cookieName;
    /** @var string[] exact paths that stay allowed for the demo account */
    private array $allow;

    public function __construct(AuthService $authService, string $demoEmail, string $cookieName = 'formlogic_auth', array $allow = [])
    {
        $this->authService = $authService;
        $this->demoEmail = $demoEmail;
        $this->cookieName = $cookieName;
        // Entries ending in '*' match by path prefix; entries starting with '*' match by suffix.
        // The MCP token endpoints are allowed so the demo can mint/revoke a read-only "Connect an AI"
        // link; '*/reports/run' is a read-only SELECT that just happens to POST its query spec.
        // The four public auth routes are the ESCAPE HATCHES from a demo session: a visitor still
        // carrying the shared demo cookie must be able to sign up / sign in / reset a password —
        // none of these mutate demo data (register creates a NEW account, login switches accounts).
        // Without them, submitting the signup form from inside the demo 403s with "demo is read-only".
        $this->allow = $allow ?: [
            '/api/demo/start',
            '/api/auth/logout',
            '/api/auth/register',
            '/api/auth/login',
            '/api/auth/forgot-password',
            '/api/auth/reset-password',
            '/api/mcp/tokens*',
            '*/reports/run',
            '*/reports/run-batch',
        ];
    }

    public function process(Request $request, RequestHandler $handler): Response
    {
        // Reads are always fine; only guard mutations.
        if (in_array(strtoupper($request->getMethod()), self::SAFE_METHODS, true)) {
            return $handler->handle($request);
        }

        $path = $request->getUri()->getPath();
        foreach ($this->allow as $allowed) {
            if (str_ends_with($allowed, '*')) {
                if (str_starts_with($path, substr($allowed, 0, -1))) {
                    return $handler->handle($request);
                }
            } elseif (str_starts_with($allowed, '*')) {
                if (str_ends_with($path, substr($allowed, 1))) {
                    return $handler->handle($request);
                }
            } elseif ($path === $allowed) {
                return $handler->handle($request);
            }
        }

        $token = $this->extractToken($request);
        if ($token !== null) {
            $user = $this->authService->validateToken($token);
            if ($user && $user->email === $this->demoEmail) {
                $response = new SlimResponse();
                $response->getBody()->write((string) json_encode([
                    'error' => true,
                    'code' => 'demo_readonly',
                    'message' => 'This is a shared live demo — your changes stay in your browser and aren\'t saved to the server.',
                ]));
                return $response->withStatus(403)->withHeader('Content-Type', 'application/json');
            }
        }

        return $handler->handle($request);
    }

    private function extractToken(Request $request): ?string
    {
        $authHeader = $request->getHeaderLine('Authorization');
        if (!empty($authHeader) && preg_match('/^Bearer\s+([a-zA-Z0-9._\-]+)$/i', $authHeader, $matches)) {
            return $matches[1];
        }
        $cookies = $request->getCookieParams();
        if (!empty($cookies[$this->cookieName])) {
            return $cookies[$this->cookieName];
        }
        return null;
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Middleware;

use FormLogic\Services\AuthService;
use FormLogic\Services\MaintenanceService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface as RequestHandler;
use Slim\Psr7\Response as SlimResponse;

/**
 * Site-wide maintenance gate (admin panel): while the flag is on, every API
 * request answers 503 with the admin's message — EXCEPT
 *   - the pre-auth config/health surface (the SPA + embedded forms read the
 *     maintenance message from it),
 *   - the auth endpoints an administrator needs to sign in, and
 *   - /api/admin/* (the panel itself, so maintenance can be turned off) —
 * and except any request bearing a valid PLATFORM ADMIN token, so admins can
 * browse the whole app normally while it is closed to everyone else.
 *
 * The flag is a FILE (storage/maintenance.json), so this keeps working while
 * the database is being migrated/restored mid-upgrade.
 */
class MaintenanceMiddleware implements MiddlewareInterface
{
    /** Path prefixes that stay reachable for everyone during maintenance. */
    private const ALLOWED_PREFIXES = [
        '/api/health',
        '/api/auth/login',
        '/api/auth/logout',
        '/api/auth/me',
        '/api/admin/',
    ];

    public function __construct(
        private MaintenanceService $maintenance,
        private AuthService $authService,
        private string $cookieName = 'formlogic_auth',
    ) {
    }

    public function process(Request $request, RequestHandler $handler): Response
    {
        $status = $this->maintenance->status();
        if (!$status['enabled']) {
            return $handler->handle($request);
        }

        $path = $request->getUri()->getPath();
        foreach (self::ALLOWED_PREFIXES as $prefix) {
            if ($path === rtrim($prefix, '/') || str_starts_with($path, $prefix)) {
                return $handler->handle($request);
            }
        }

        // Platform admins pass through everywhere (they're managing the window).
        $token = $this->extractToken($request);
        if ($token !== null) {
            $user = $this->authService->validateToken($token);
            if ($user !== null && $this->authService->isPlatformAdmin($user)) {
                return $handler->handle($request);
            }
        }

        $response = new SlimResponse();
        $response->getBody()->write(json_encode([
            'error' => true,
            'maintenance' => true,
            'message' => $status['message'],
        ]));
        return $response
            ->withStatus(503)
            ->withHeader('Retry-After', '300')
            ->withHeader('Content-Type', 'application/json');
    }

    /** Same extraction order as AuthMiddleware: Bearer header, then cookie. */
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

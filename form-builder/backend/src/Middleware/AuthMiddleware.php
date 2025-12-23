<?php

declare(strict_types=1);

namespace FormLogic\Middleware;

use FormLogic\Services\AuthService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface as RequestHandler;
use Slim\Psr7\Response as SlimResponse;

class AuthMiddleware implements MiddlewareInterface
{
    private AuthService $authService;
    private bool $optional;
    private string $cookieName;

    public function __construct(AuthService $authService, bool $optional = false, string $cookieName = 'formlogic_auth')
    {
        $this->authService = $authService;
        $this->optional = $optional;
        $this->cookieName = $cookieName;
    }

    public function process(Request $request, RequestHandler $handler): Response
    {
        $token = $this->extractToken($request);

        if ($token === null) {
            if ($this->optional) {
                return $handler->handle($request);
            }
            return $this->unauthorized('No authentication token provided');
        }

        $user = $this->authService->validateToken($token);

        if (!$user) {
            if ($this->optional) {
                return $handler->handle($request);
            }
            return $this->unauthorized('Invalid or expired token');
        }

        // Add user to request attributes
        $request = $request->withAttribute('user', $user);
        $request = $request->withAttribute('userId', $user->id);

        return $handler->handle($request);
    }

    /**
     * Extract token from request.
     * Priority: 1. Authorization header (for API clients), 2. HttpOnly cookie (for browser)
     */
    private function extractToken(Request $request): ?string
    {
        // First, check Authorization header (for API clients and backwards compatibility)
        $authHeader = $request->getHeaderLine('Authorization');
        if (!empty($authHeader) && preg_match('/^Bearer\s+(.+)$/i', $authHeader, $matches)) {
            return $matches[1];
        }

        // Second, check HttpOnly cookie (for browser clients)
        $cookies = $request->getCookieParams();
        if (isset($cookies[$this->cookieName]) && !empty($cookies[$this->cookieName])) {
            return $cookies[$this->cookieName];
        }

        return null;
    }

    private function unauthorized(string $message): Response
    {
        $response = new SlimResponse();
        $response->getBody()->write(json_encode([
            'error' => true,
            'message' => $message,
        ]));

        return $response
            ->withStatus(401)
            ->withHeader('Content-Type', 'application/json');
    }
}

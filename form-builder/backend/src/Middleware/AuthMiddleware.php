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

    public function __construct(AuthService $authService, bool $optional = false)
    {
        $this->authService = $authService;
        $this->optional = $optional;
    }

    public function process(Request $request, RequestHandler $handler): Response
    {
        $authHeader = $request->getHeaderLine('Authorization');

        if (empty($authHeader)) {
            if ($this->optional) {
                return $handler->handle($request);
            }
            return $this->unauthorized('No authorization header');
        }

        // Extract token from "Bearer <token>"
        if (!preg_match('/^Bearer\s+(.+)$/i', $authHeader, $matches)) {
            if ($this->optional) {
                return $handler->handle($request);
            }
            return $this->unauthorized('Invalid authorization format');
        }

        $token = $matches[1];
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

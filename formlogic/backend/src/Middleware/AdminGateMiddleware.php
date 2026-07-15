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
 * Platform-administrator gate for /api/admin/* — runs INSIDE AuthMiddleware
 * (which sets the 'user' attribute) and refuses anyone who isn't a platform
 * admin (the durable users.is_admin flag). The shared
 * demo account is never an admin.
 */
class AdminGateMiddleware implements MiddlewareInterface
{
    public function __construct(private AuthService $authService)
    {
    }

    public function process(Request $request, RequestHandler $handler): Response
    {
        $user = $request->getAttribute('user');
        if ($user === null || !$this->authService->isPlatformAdmin($user)) {
            $response = new SlimResponse();
            $response->getBody()->write(json_encode([
                'error' => true,
                'message' => 'Administrator access required',
            ]));
            return $response->withStatus(403)->withHeader('Content-Type', 'application/json');
        }
        return $handler->handle($request);
    }
}

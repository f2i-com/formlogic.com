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
    public const NEEDS_MFA = 'admin_mfa_required';

    public function __construct(private AuthService $authService, private bool $requireMfa = false)
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
        // A password alone is not enough to reach every account on the server. Turning it on is in
        // Settings, which this gate doesn't cover, so nobody is locked out by it.
        if ($this->requireMfa && !$this->authService->isMfaEnabled($user->id)) {
            $response = new SlimResponse();
            $response->getBody()->write((string) json_encode([
                'error' => true,
                'code' => self::NEEDS_MFA,
                'message' => 'Turn on two-factor authentication in Settings to use the admin tools',
            ]));
            return $response->withStatus(403)->withHeader('Content-Type', 'application/json');
        }
        return $handler->handle($request);
    }
}

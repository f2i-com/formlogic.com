<?php

declare(strict_types=1);

namespace FormLogic\Middleware;

use FormLogic\Services\AuthService;
use FormLogic\Support\HostedActorContext;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface as RequestHandler;
use Slim\Psr7\Response as SlimResponse;

/**
 * What takes over or opens someone else's account asks the administrator to confirm who they are:
 * a stolen admin session alone gets as far as this and no further. POST /api/admin/confirm answers
 * with a short-lived proof for this session, which the client sends in a header.
 */
class AdminConfirmationMiddleware implements MiddlewareInterface
{
    public const HEADER = 'X-Admin-Confirmation';
    public const CODE = 'admin_confirmation_required';

    public function __construct(private AuthService $authService)
    {
    }

    public function process(Request $request, RequestHandler $handler): Response
    {
        $session = $request->getAttribute(HostedActorContext::SESSION_ATTRIBUTE);
        $userId = $request->getAttribute('userId');
        if (is_string($session) && is_string($userId)
            && $this->authService->adminConfirmed($request->getHeaderLine(self::HEADER), $userId, $session)) {
            return $handler->handle($request);
        }
        $response = new SlimResponse();
        $response->getBody()->write((string) json_encode([
            'error' => true,
            'code' => self::CODE,
            'message' => 'Confirm your password to continue',
        ]));
        return $response->withStatus(403)->withHeader('Content-Type', 'application/json');
    }
}

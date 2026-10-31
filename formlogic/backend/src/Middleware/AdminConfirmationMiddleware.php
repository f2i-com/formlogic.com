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
 * The admin tools ask an administrator to confirm who they are: a stolen admin session alone gets
 * as far as this and no further. POST /api/admin/confirm answers with a short-lived proof for this
 * session, which the client sends in a header. Every write asks, because the routes that can undo
 * all of this are writes too (an older release applied, a database restored). Acting for an
 * account asks for reads as well.
 */
class AdminConfirmationMiddleware implements MiddlewareInterface
{
    public const HEADER = 'X-Admin-Confirmation';
    public const CODE = 'admin_confirmation_required';
    private const CONFIRM_ROUTE = '/api/admin/confirm';

    public function __construct(private AuthService $authService, private bool $writesOnly = false)
    {
    }

    public function process(Request $request, RequestHandler $handler): Response
    {
        $reading = in_array(strtoupper($request->getMethod()), ['GET', 'HEAD', 'OPTIONS'], true);
        // Percent-decoded, as the router matches it (see CsrfMiddleware::process).
        if (($this->writesOnly && $reading) || rawurldecode($request->getUri()->getPath()) === self::CONFIRM_ROUTE) {
            return $handler->handle($request);
        }
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

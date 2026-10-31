<?php

declare(strict_types=1);

namespace FormLogic\Middleware;

use FormLogic\Services\AuditService;
use FormLogic\Services\AuthService;
use FormLogic\Support\AdminActingLimits;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface as RequestHandler;
use Slim\Psr7\Response as SlimResponse;
use Slim\Routing\RouteContext;

/**
 * Acting-as bridge for the /api/admin/users/{ownerId}/... mirror routes.
 *
 * Runs INSIDE AuthMiddleware + AdminGateMiddleware (the caller is a verified
 * platform admin) and swaps the request's effective user to the resource
 * OWNER before the owner controllers run. Every downstream ownership check,
 * validator, sanitizer and quota then behaves exactly as it does for the
 * owner — no duplicated authorization logic, and an ownership mismatch
 * (ownerId in the URL vs the resource's real owner) 404s naturally.
 *
 * The true actor is preserved in 'adminActorId'/'adminActor' attributes so
 * audit trails name the admin, and every mutating request is additionally
 * journaled as 'admin.on_behalf' (body KEYS only — never values, which could
 * carry user content).
 *
 * The shared demo account's resources are READ-ONLY through this bridge:
 * demo data is public and provisioning-managed; support edits belong on the
 * provisioning path, not here.
 */
class AdminActAsMiddleware implements MiddlewareInterface
{
    public function __construct(
        private AuthService $authService,
        private ?AuditService $auditService = null,
        private ?\FormLogic\Services\AdminSupportActivity $activity = null
    ) {
    }

    public function process(Request $request, RequestHandler $handler): Response
    {
        $route = RouteContext::fromRequest($request)->getRoute();
        $ownerId = (string) ($route?->getArgument('ownerId') ?? '');
        $owner = $ownerId !== '' ? $this->authService->getUserById($ownerId) : null;
        if ($owner === null) {
            return $this->json(['error' => true, 'message' => 'User not found'], 404);
        }

        $method = strtoupper($request->getMethod());
        $mutating = in_array($method, ['POST', 'PUT', 'PATCH', 'DELETE'], true);

        $demoEmail = strtolower((string) ($_ENV['DEMO_EMAIL'] ?? 'demo@formlogic.local'));
        if ($mutating && strtolower($owner->email) === $demoEmail) {
            return $this->json([
                'error' => true,
                'code' => 'demo_readonly',
                'message' => 'The shared demo account is read-only for administrators.',
            ], 403);
        }

        $adminId = $request->getAttribute('userId');
        try {
            $this->activity?->opened($owner, (string) $adminId, \FormLogic\Helpers\IpResolver::fromEnvironment()->getClientIp($request));
        } catch (\Throwable) {
            // telling the owner is best-effort, as the audit below is
        }
        $response = $handler->handle(
            $request
                ->withAttribute('adminActorId', $adminId)
                ->withAttribute('adminActor', $request->getAttribute('user'))
                ->withAttribute(AdminActingLimits::CODE_EDITS_ATTRIBUTE, $this->authService->supportAccessUntil($owner->id) !== null)
                ->withAttribute('userId', $owner->id)
                ->withAttribute('user', $owner)
        );

        if ($mutating) {
            try {
                $sp = $request->getServerParams();
                // The owner sees admin.on_behalf, which must mean something changed.
                $action = $response->getStatusCode() < 400 ? 'admin.on_behalf' : 'admin.on_behalf_refused';
                $this->auditService?->log($action, 'admin', $ownerId, is_string($adminId) ? $adminId : null, \FormLogic\Helpers\IpResolver::fromEnvironment()->getClientIp($request), [
                    'method' => $method,
                    'route' => $route?->getPattern(),
                    'path' => $request->getUri()->getPath(),
                    'status' => $response->getStatusCode(),
                    'bodyKeys' => array_keys((array) ($request->getParsedBody() ?? [])),
                ]);
            } catch (\Throwable) {
                // audit is best-effort
            }
        }

        return $response;
    }

    private function json(array $payload, int $status): Response
    {
        $response = new SlimResponse();
        $response->getBody()->write((string) json_encode($payload));
        return $response->withStatus($status)->withHeader('Content-Type', 'application/json');
    }
}

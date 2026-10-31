<?php

declare(strict_types=1);

namespace FormLogic\Middleware;

use FormLogic\Services\PlanService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface as RequestHandler;
use Slim\Psr7\Response as SlimResponse;
use Slim\Routing\RouteContext;

/**
 * Blocks content-creating writes (POST/PUT/PATCH) when the owning account's hosted-cloud
 * access has expired. Reads, exports, and DELETEs are always allowed so users keep full
 * access to their data and can clean up. No-op unless plan enforcement is enabled.
 *
 * Owner resolution: a route that names a form or an app bills that form's or app's owner, whoever
 * is acting; any other route is the request user's own.
 */
class CloudWriteGateMiddleware implements MiddlewareInterface
{
    public function __construct(private PlanService $planService)
    {
    }

    public function process(Request $request, RequestHandler $handler): Response
    {
        if (!$this->planService->isEnforced()) {
            return $handler->handle($request);
        }

        // Only gate content-creating writes; reads/exports/deletes pass through.
        $method = strtoupper($request->getMethod());
        if (!in_array($method, ['POST', 'PUT', 'PATCH'], true)) {
            return $handler->handle($request);
        }

        $route = RouteContext::fromRequest($request)->getRoute();
        // Joining someone's app costs the one who joins nothing, so it isn't theirs to pay for.
        if ($route !== null && str_ends_with($route->getPattern(), '/invitations/accept')) {
            return $handler->handle($request);
        }

        // Attribute the write to the account that OWNS the resource. When the route targets
        // a specific form (public submission/upload, or an app-runtime write by a member),
        // the FORM OWNER's cloud is what's billed — not the acting member's — and an app route
        // with no form (an action, a sync batch) is the app owner's. Fall back to the request
        // user only for owner-scoped routes (e.g. creating a form).
        $ownerId = null;
        $formId = $this->routeArgument($request, 'formId');
        if ($formId !== null) {
            $ownerId = $this->planService->ownerOfForm($formId);
        }
        $slug = $this->routeArgument($request, 'slug');
        if (!$ownerId && $slug !== null) {
            $ownerId = $this->planService->ownerOfAppSlug($slug);
        }
        if (!$ownerId) {
            $ownerId = $request->getAttribute('userId');
        }

        // If we can't attribute the write to an owner, let it through (other layers
        // still authorize it); only block when we know the owner has lapsed.
        if ($ownerId && !$this->planService->isCloudActive((string) $ownerId)) {
            return $this->paymentRequired();
        }

        return $handler->handle($request);
    }

    private function routeArgument(Request $request, string $name): ?string
    {
        $route = RouteContext::fromRequest($request)->getRoute();
        if ($route === null) {
            return null;
        }
        $value = $route->getArgument($name);
        return is_string($value) && $value !== '' ? $value : null;
    }

    private function paymentRequired(): Response
    {
        $response = new SlimResponse();
        $response->getBody()->write(json_encode([
            'error' => true,
            'code' => 'cloud_expired',
            'message' => 'Cloud access has expired. Your data is safe and still exportable — add cloud time to publish, accept responses, and upload again.',
        ]));
        return $response->withStatus(402)->withHeader('Content-Type', 'application/json');
    }
}

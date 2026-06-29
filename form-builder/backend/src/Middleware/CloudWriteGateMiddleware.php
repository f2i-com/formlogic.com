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
 * Owner resolution: authenticated routes use the request's userId; public routes
 * (form submission / upload) resolve the form owner from the {formId} route argument.
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

        $ownerId = $request->getAttribute('userId');
        if (!$ownerId) {
            $formId = $this->routeFormId($request);
            if ($formId !== null) {
                $ownerId = $this->planService->ownerOfForm($formId);
            }
        }

        // If we can't attribute the write to an owner, let it through (other layers
        // still authorize it); only block when we know the owner has lapsed.
        if ($ownerId && !$this->planService->isCloudActive((string) $ownerId)) {
            return $this->paymentRequired();
        }

        return $handler->handle($request);
    }

    private function routeFormId(Request $request): ?string
    {
        $route = RouteContext::fromRequest($request)->getRoute();
        if ($route === null) {
            return null;
        }
        $formId = $route->getArgument('formId');
        return is_string($formId) && $formId !== '' ? $formId : null;
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

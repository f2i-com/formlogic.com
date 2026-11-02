<?php

declare(strict_types=1);

namespace FormLogic\Middleware;

use FormLogic\Services\AccessGateService;
use FormLogic\Services\AppService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface as RequestHandler;
use Slim\Psr7\Response as SlimResponse;
use Slim\Routing\RouteContext;

/**
 * An app's age gate, on every route that names the app by slug (AccessGateService).
 *
 * One place, so that no route can forget it: it rides the /api/app/{slug} group and each such route
 * outside it, and RouteGateWiringTest holds index.php to that. It finds out who is asking as the
 * route's own authentication will, because a group's middleware runs before its routes', and that
 * authentication runs again after it as before.
 *
 * Left open: what a page needs before the member can pass the gate — the app's manifests, whether
 * they are a member, joining, and the native entry metadata. Everything else that names a gated
 * app refuses a member without a receipt.
 */
final class AppAccessGateMiddleware implements MiddlewareInterface
{
    /** Route patterns, by their ending, that stay open on a gated app. */
    public const OPEN = ['/manifest.json', '/client-manifest', '/membership', '/join', '/entry'];

    public function __construct(
        private AppService $apps,
        private AccessGateService $gate,
        private AuthMiddleware $optionalAuth,
    ) {
    }

    public function process(Request $request, RequestHandler $handler): Response
    {
        $route = RouteContext::fromRequest($request)->getRoute();
        $slug = $route?->getArgument('slug');
        if ($route === null || !is_string($slug) || $slug === '' || self::isOpen($route->getPattern())) {
            return $handler->handle($request);
        }
        $app = $this->apps->getAppBySlug($slug);
        if ($app === null || $this->gate->requirementOf($app) === null) {
            return $handler->handle($request);
        }

        $refusal = $this->gate->decide($app, $this->caller($request));
        if ($refusal === null) {
            return $handler->handle($request);
        }
        [$status, $body] = $refusal;
        $response = new SlimResponse();
        $response->getBody()->write((string) json_encode($body));
        return $response->withStatus($status)->withHeader('Content-Type', 'application/json')->withHeader('Cache-Control', 'no-store');
    }

    public static function isOpen(string $pattern): bool
    {
        foreach (self::OPEN as $ending) {
            if (str_ends_with($pattern, $ending)) {
                return true;
            }
        }
        return false;
    }

    /** The signed-in caller, as AuthMiddleware decides it, or null. */
    private function caller(Request $request): ?string
    {
        $seen = null;
        $note = function (mixed $id) use (&$seen): void {
            $seen = is_string($id) && $id !== '' ? $id : null;
        };
        $this->optionalAuth->process($request, new class ($note) implements RequestHandler {
            public function __construct(private \Closure $note)
            {
            }

            public function handle(Request $request): Response
            {
                ($this->note)($request->getAttribute('userId'));
                return new SlimResponse();
            }
        });
        return $seen;
    }
}

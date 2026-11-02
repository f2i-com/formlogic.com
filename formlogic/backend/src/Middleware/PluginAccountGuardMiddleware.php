<?php

declare(strict_types=1);

namespace FormLogic\Middleware;

use FormLogic\Services\AppService;
use FormLogic\Services\PluginService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface as RequestHandler;
use Slim\Psr7\Response as SlimResponse;
use Slim\Routing\RouteContext;

/**
 * Keeps the administrator's account tools off the Plugins account and its apps (PluginService).
 * That account holds the plugins' projects. A password, email, admin flag or deletion set on it,
 * or an edit to one of its apps, would change a plugin outside Admin → Plugins, so on the admin
 * routes the account is not found and its apps can be read but not changed.
 */
final class PluginAccountGuardMiddleware implements MiddlewareInterface
{
    public function __construct(private AppService $apps)
    {
    }

    public function process(Request $request, RequestHandler $handler): Response
    {
        $route = RouteContext::fromRequest($request)->getRoute();
        $pattern = $route?->getPattern() ?? '';
        $id = (string) ($route?->getArgument('id') ?? '');
        if ($id === PluginService::SYSTEM_USER_ID && str_starts_with($pattern, '/api/admin/users/{id}')) {
            return self::refuse(404, 'User not found');
        }
        if ($id !== '' && str_starts_with($pattern, '/api/admin/apps/{id}') && strtoupper($request->getMethod()) !== 'GET') {
            $app = $this->apps->getApp($id);
            if ($app !== null && ($app['ownerId'] ?? null) === PluginService::SYSTEM_USER_ID) {
                return self::refuse(403, 'This app is a plugin. Manage it under Admin → Plugins.');
            }
        }
        return $handler->handle($request);
    }

    private static function refuse(int $status, string $message): Response
    {
        $response = new SlimResponse();
        $response->getBody()->write((string) json_encode(['error' => true, 'message' => $message]));
        return $response->withStatus($status)->withHeader('Content-Type', 'application/json');
    }
}

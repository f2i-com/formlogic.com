<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\{AppService, AppUserService, HostedAppService};
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

class HostedAppController
{
    use JsonResponseTrait;

    public function __construct(private AppService $apps, private AppUserService $users, private HostedAppService $hosting) {}

    public function manage(Request $request, Response $response, array $args): Response
    {
        $app = $this->apps->getApp((string) $args['id']);
        $userId = $request->getAttribute('userId');
        if (!$userId || !$app || $app['ownerId'] !== $userId) return $this->jsonError($response, 'App not found or access denied', 404);
        if ($blocked = $this->blockIfDemo($request, $response, 'App hosting is unavailable in the shared demo.')) return $blocked;
        if (($args['download'] ?? '') === 'database') {
            try {
                $path = $this->hosting->snapshot($app['id']);
                $stream = fopen($path, 'rb');
                if ($stream === false) { @unlink($path); throw new \RuntimeException('Download unavailable'); }
                register_shutdown_function(static function () use ($stream, $path): void {
                    if (is_resource($stream)) fclose($stream);
                    @unlink($path);
                });
                return $response->withBody(new \Slim\Psr7\Stream($stream))
                    ->withHeader('Content-Type', 'application/vnd.sqlite3')
                    ->withHeader('Content-Disposition', 'attachment; filename="app-database.sqlite"')
                    ->withHeader('Cache-Control', 'no-store')->withHeader('X-Content-Type-Options', 'nosniff');
            } catch (\Throwable $e) {
                error_log('Hosted database download failed: ' . $e->getMessage());
                return $this->jsonError($response, 'Database download is unavailable', 503);
            }
        }
        return $this->respond($response, function () use ($request, $app) {
            if ($request->getMethod() === 'GET') return ['deployment' => $this->hosting->get($app['id'], true)];
            $body = $request->getParsedBody();
            if (!is_array($body) || !is_array($body['package'] ?? null) || !is_int($body['expectedVersion'] ?? null) || $body['expectedVersion'] < 0) {
                throw new \InvalidArgumentException('Provide a package and expectedVersion');
            }
            return ['deployment' => $this->hosting->publish($app['id'], $body['package'], $body['expectedVersion'])];
        });
    }

    public function runtime(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        $app = $this->apps->getAppBySlug((string) $args['slug']);
        if (!$userId || !$app || !$this->apps->isRuntimeVisible($app, $userId)) return $this->jsonError($response, 'App not found or access denied', 404);
        $owner = $app['ownerId'] === $userId;
        if (!$owner && ($this->users->getAppUser($app['id'], $userId)['status'] ?? null) !== 'active') return $this->jsonError($response, 'Active app membership required', 403);
        if ($blocked = $this->blockIfDemo($request, $response, 'App hosting is unavailable in the shared demo.')) return $blocked;
        return $this->respond($response, function () use ($request, $app, $args, $userId, $owner) {
            if ($request->getMethod() === 'GET') {
                $deployment = $this->hosting->get($app['id']);
                if (!$deployment) throw new \RuntimeException('This app has no hosted project', 404);
                return ['deployment' => $deployment, 'name' => $app['name']];
            }
            $input = $request->getParsedBody();
            if (!is_array($input) || (array_is_list($input) && $input !== [])) throw new \InvalidArgumentException('Action input must be a JSON object');
            return ['result' => $this->hosting->run($app['id'], (string) $args['action'], $input, $userId, $owner)];
        });
    }

    private function respond(Response $response, callable $operation): Response
    {
        $response = $response->withHeader('Cache-Control', 'no-store')->withHeader('X-Content-Type-Options', 'nosniff');
        try { return $this->jsonResponse($response, $operation()); }
        catch (\InvalidArgumentException $e) { return $this->jsonError($response, $e->getMessage(), 400); }
        catch (\RuntimeException $e) {
            if (in_array($e->getCode(), [404, 409, 422], true)) return $this->jsonError($response, $e->getMessage(), $e->getCode());
            error_log('Hosted app failure: ' . $e->getMessage());
            return $this->jsonError($response, 'App hosting is temporarily unavailable', 503);
        }
        catch (\Throwable $e) {
            error_log('Hosted app failure: ' . $e->getMessage());
            return $this->jsonError($response, 'App hosting is temporarily unavailable', 503);
        }
    }
}

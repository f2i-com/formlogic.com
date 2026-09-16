<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\{AppService, AppUserService, AuditService, HostedAppService, RuntimeEngineService};
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

class HostedAppController
{
    use JsonResponseTrait;

    // Required, not optional-with-a-default: this controller is autowired, and PHP-DI's reflection
    // autowiring SKIPS optional parameters (ReflectionBasedAutowiring::getParametersDefinition),
    // so an `= null` here would silently hand production a controller with no engine service.
    public function __construct(
        private AppService $apps,
        private AppUserService $users,
        private HostedAppService $hosting,
        private RuntimeEngineService $engines,
        private AuditService $audit,
    ) {}

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
            // The owner's settings view: what they asked for, what members actually get and why,
            // plus the engines this site allows them to choose between.
            if ($request->getMethod() === 'GET') return ['deployment' => $this->hosting->get($app['id'], true)] + $this->engineForOwner($app['id']);
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
        // The page was loaded on one engine; the server may have decided otherwise since (a
        // revocation, a policy edit). Checked before respond() so the answer carries the
        // engine_changed code the parent remounts on, not a bare 409.
        if ($stale = $this->refuseStaleEngine($request, $response, $app['id'])) return $stale;
        return $this->respond($response, function () use ($request, $app, $args, $userId, $owner) {
            if ($request->getMethod() === 'GET') {
                $deployment = $this->hosting->get($app['id']);
                if (!$deployment) throw new \RuntimeException('This app has no hosted project', 404);
                return ['deployment' => $deployment, 'name' => $app['name']] + $this->engineForRuntime($app['id']);
            }
            $input = $request->getParsedBody();
            if (!is_array($input) || (array_is_list($input) && $input !== [])) throw new \InvalidArgumentException('Action input must be a JSON object');
            return ['result' => $this->hosting->run($app['id'], (string) $args['action'], $input, $userId, $owner)];
        });
    }

    /**
     * PUT /api/apps/{id}/engine { engine: 'zipp-web-python'|'zipp-web'|'host-js'|null }
     *
     * The owner's choice, in its own column. One column covers this app's hosted deployment, its
     * native client and its hosted dashboard home, because all three key on apps.id. Owner-only by
     * design: an admin acting as the owner may edit their app, but may not hand it an engine.
     *
     * 422 means the choice would NEVER take effect (this site does not allow that engine, or
     * host-js without a verified owner). A choice this install cannot serve YET is stored: the
     * install changes without the owner doing anything, and the settings UI shows the effective
     * engine and its reason meanwhile.
     */
    public function engine(Request $request, Response $response, array $args): Response
    {
        $app = $this->apps->getApp((string) $args['id']);
        $userId = $request->getAttribute('userId');
        if (!$userId || !$app || $app['ownerId'] !== $userId) return $this->jsonError($response, 'App not found or access denied', 404);
        if ($blocked = $this->blockIfDemo($request, $response, 'App hosting is unavailable in the shared demo.')) return $blocked;
        $body = $request->getParsedBody();
        if (!is_array($body) || !array_key_exists('engine', $body)) return $this->jsonError($response, 'Provide an engine, or null for the site default', 400);
        $engine = $body['engine'];
        if ($engine !== null && !is_string($engine)) return $this->jsonError($response, 'Provide an engine, or null for the site default', 400);
        $response = $response->withHeader('Cache-Control', 'no-store')->withHeader('X-Content-Type-Options', 'nosniff');
        try {
            $sp = $request->getServerParams();
            $effective = $this->engines->storeChoice($app['id'], $engine, $this->audit, (string) $userId, $sp['REMOTE_ADDR'] ?? null);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonError($response, $e->getMessage(), 422, 'engine_not_available');
        } catch (\Throwable $e) {
            // The audit row is part of the change: if it could not be written, nothing committed.
            error_log('App engine change failed: ' . $e->getMessage());
            return $this->jsonError($response, 'The engine change could not be recorded, so nothing was changed', 503);
        }
        return $this->jsonResponse($response, ['engine' => $effective, 'policy' => $this->engines->ownerPolicy()]);
    }

    /** The settings view of the engine: the choice, the outcome, and what may be chosen. */
    private function engineForOwner(string $appId): array
    {
        return ['engine' => $this->engines->effective($appId), 'enginePolicy' => $this->engines->ownerPolicy()];
    }

    /** What a runtime mount needs: the id to run and the revision it must send back on actions. */
    private function engineForRuntime(string $appId): array
    {
        $effective = $this->engines->effective($appId);
        return ['engine' => ['id' => $effective['id'], 'revision' => $effective['revision']]];
    }

    /**
     * 409 engine_changed when the parent's X-FormLogic-Client-Engine no longer matches what the
     * server decides now. The header grants nothing — a request without it is answered as before,
     * and costs nothing: the resolver is only asked when there is a header to check.
     */
    private function refuseStaleEngine(Request $request, Response $response, string $appId): ?Response
    {
        $header = $request->getMethod() === 'GET' ? '' : $request->getHeaderLine('X-FormLogic-Client-Engine');
        if ($header === '') return null;
        if (RuntimeEngineService::headerMatches($header, $this->engines->effective($appId))) return null;
        return $this->jsonError(
            $response->withHeader('Cache-Control', 'no-store'),
            'This app is now set to run on a different engine. Reload to continue.',
            409,
            'engine_changed'
        );
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

<?php

declare(strict_types=1);
namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\{AppService, AppUserService, NativeAppService, PlanService, FlowService};
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

class NativeAppController
{
    use JsonResponseTrait;
    public function __construct(private AppService $apps, private AppUserService $users, private NativeAppService $native, private PlanService $plans, private FlowService $flows) {}

    public function manage(Request $request, Response $response, array $args): Response
    {
        $app = $this->apps->getApp((string) $args['id']);
        $user = $request->getAttribute('userId');
        if (!$app || !$user || $app['ownerId'] !== $user) return $this->jsonError($response, 'App not found or access denied', 404);
        if ($blocked = $this->blockIfDemo($request, $response, 'Native hosting is unavailable in the shared demo.')) return $blocked;
        return $this->respond($response, function () use ($request, $app, $args) {
            if (($args['operation'] ?? '') === 'records') {
                $query = $request->getQueryParams();
                if (!$this->native->get($app['id']) && !isset($query['table'])) return ['installed' => false, 'tables' => []];
                return $this->native->records($app['id'], isset($query['table']) && is_string($query['table']) ? $query['table'] : null, (int) ($query['offset'] ?? 0));
            }
            if ($request->getMethod() === 'GET') return ['available' => $this->native->available(), 'project' => $this->native->get($app['id'])];
            $body = $request->getParsedBody();
            if (!is_array($body) || !is_array($body['project'] ?? null) || !is_int($body['expectedVersion'] ?? null) || $body['expectedVersion'] < 0) throw new \InvalidArgumentException('Provide a project and expectedVersion');
            return ['project' => $this->native->install($app['id'], $body['project'], $body['expectedVersion'])];
        });
    }

    /** Public entry metadata only; application source remains behind runtime access checks. */
    public function entry(Request $request, Response $response, array $args): Response
    {
        $app = $this->apps->getAppBySlug((string) $args['slug']);
        if (!$app || !$this->apps->isRuntimeVisible($app, $request->getAttribute('userId'))) return $this->jsonResponse($response->withHeader('Cache-Control', 'no-store'), ['home' => false]);
        return $this->respond($response, function () use ($app) {
            $project = $this->native->get($app['id']);
            return ['home' => (bool) ($project['home'] ?? false), 'access' => $project['access'] ?? 'members'];
        });
    }

    public function runtime(Request $request, Response $response, array $args): Response
    {
        $app = $this->apps->getAppBySlug((string) $args['slug']);
        $user = $request->getAttribute('userId');
        $owner = $app && $user && $app['ownerId'] === $user;
        if (!$app || (!$owner && !$this->apps->isRuntimeVisible($app, (string) ($user ?? '')))) return $this->jsonError($response, 'App not found or access denied', 404);
        if ($blocked = $this->blockIfDemo($request, $response, 'Native hosting is unavailable in the shared demo.')) return $blocked;
        return $this->respond($response, function () use ($request, $app, $user, $owner) {
            $project = $this->native->get($app['id']);
            if (!$project) throw new \RuntimeException('Native app not found', 404);
            $membership = $user && !$owner && $project['access'] === 'members' ? $this->users->getAppUser($app['id'], $user) : null;
            if ($project['access'] === 'members' && !$owner && (!$user || ($membership['status'] ?? '') !== 'active')) throw new \RuntimeException('Sign in with an active app membership to continue', 403);
            $identity = $project['access'] === 'members' ? ['formlogic' => ['appId' => $app['id'], 'userId' => $user, 'roleId' => $owner ? 'owner' : ($membership['roleId'] ?? null)]] : [];
            if ($request->getMethod() === 'GET') {
                $client = array_filter($project['files'], static fn($path) => !preg_match('~^(server|backend|private)/~i', $path) && !str_ends_with($path, '.sql'), ARRAY_FILTER_USE_KEY);
                $manifest = json_decode($client['manifest.json'], true);
                $origins = $manifest['config']['server']['allowedOrigins'] ?? [];
                unset($manifest['server'], $manifest['config']['server']);
                $client['manifest.json'] = json_encode($manifest, JSON_THROW_ON_ERROR);
                $client['permission.json'] = '{"permissions":{}}';
                return ['name' => $app['name'], 'project' => ['version' => $project['version'], 'client' => $client, 'assets' => $project['assets'], 'access' => $project['access'], 'origins' => $origins]];
            }
            $input = $request->getParsedBody();
            if (!is_array($input) || !is_string($input['path'] ?? null) || !preg_match('~^/api/[a-zA-Z0-9/_-]+$~D', $input['path']) || !in_array($input['method'] ?? null, ['GET','POST','PUT','DELETE'], true)) throw new \InvalidArgumentException('Provide an app API path and method');
            if (in_array($input['method'], ['POST', 'PUT'], true) && $this->plans->isEnforced() && !$this->plans->isCloudActive($app['ownerId'])) throw new \RuntimeException('The app owner’s cloud access has expired. Records remain available to read and export.', 402);
            $headers = is_array($input['headers'] ?? null) ? array_change_key_case($input['headers'], CASE_LOWER) : [];
            $authorization = is_string($headers['authorization'] ?? null) ? $headers['authorization'] : '';
            if (strlen($authorization) > 4096) throw new \InvalidArgumentException('Invalid application authorization');
            $body = $input['body'] ?? (object) [];
            if (is_string($body)) $body = json_decode($body, false, 64, JSON_THROW_ON_ERROR);
            if (!is_array($body) && !is_object($body)) throw new \InvalidArgumentException('App request body must be JSON');
            $result = $this->native->request($app['id'], [
                'method' => $input['method'], 'path' => $input['path'], 'query' => (object) ($input['query'] ?? []), 'body' => $body,
                'headers' => (object) ['authorization' => $authorization],
                'client_ip' => $request->getServerParams()['REMOTE_ADDR'] ?? 'unknown', 'photos' => false,
            ], $identity, $this->flows->nativeRecordSubscriptions($app['id']));
            try {
                $this->native->dispatchRecordEvents($app['id'], fn($id, $event, $data, $bindings) => $this->flows->enqueueNativeRecordEvent($app['id'], $id, $event, $data, $bindings));
            } catch (\Throwable $error) {
                // The app write already committed. Returning an error here could make the
                // caller repeat it; retain the durable event for the recovery dispatcher.
                error_log('Native record automation delivery pending for app ' . $app['id']);
            }
            return ['result' => $result];
        });
    }

    private function respond(Response $response, callable $operation): Response
    {
        $response = $response->withHeader('Cache-Control', 'no-store')->withHeader('X-Content-Type-Options', 'nosniff');
        try { return $this->jsonResponse($response, $operation()); }
        catch (\InvalidArgumentException|\JsonException $e) { return $this->jsonError($response, $e->getMessage(), 400); }
        catch (\RuntimeException $e) {
            if (in_array($e->getCode(), [402,403,404,409,422,429], true)) return $this->jsonError($response, $e->getMessage(), $e->getCode());
            error_log('Native app error: ' . $e->getMessage());
            return $this->jsonError($response, 'The native app host is unavailable. Check its runtime configuration.', 503);
        }
    }
}

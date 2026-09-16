<?php

declare(strict_types=1);
namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\{AppService, AppUserService, NativeAppService, PlanService, FlowService, RuntimeEngineService};
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

class NativeAppController
{
    use JsonResponseTrait;

    private const DEMO_READ_ONLY = 'The shared demo is read-only: you can browse this app’s backend and database, but not change them.';
    /** NativeAppService's recovery-required refusals (resolveJournal, assertNotRecoveryRequired). */
    private const RECOVERY_REQUIRED = '/^(?:The app (?:database )?needs operator recovery|Restore the app database before installing another update)/';

    // $engines is required, not optional-with-a-default: this controller is autowired, and PHP-DI's
    // reflection autowiring SKIPS optional parameters (ReflectionBasedAutowiring), so an `= null`
    // here would silently hand production a controller that decides no app's engine.
    public function __construct(private AppService $apps, private AppUserService $users, private NativeAppService $native, private PlanService $plans, private FlowService $flows, private RuntimeEngineService $engines) {}

    public function manage(Request $request, Response $response, array $args): Response
    {
        $app = $this->apps->getApp((string) $args['id']);
        $user = $request->getAttribute('userId');
        if (!$app || !$user || $app['ownerId'] !== $user) return $this->jsonError($response, 'App not found or access denied', 404);
        // The shared demo browses its apps' backends and databases read-only: the install PUT and
        // every records POST (whatever its action) are refused. DemoReadOnlyMiddleware refuses them
        // first, with its own demo_readonly text; this is the second guard, should that ever change.
        $readOnly = $this->isDemoRequest($request);
        if ($request->getMethod() !== 'GET' && ($blocked = $this->blockIfDemo($request, $response, self::DEMO_READ_ONLY))) return $blocked;
        return $this->respond($response, function () use ($request, $app, $args, $readOnly) {
            if (($args['operation'] ?? '') === 'records') {
                if ($request->getMethod() === 'POST') {
                    $input = $request->getParsedBody();
                    if (!is_array($input)) throw new \InvalidArgumentException('Provide a record action');
                    if (($input['action'] ?? '') !== 'read' && $this->plans->isEnforced() && !$this->plans->isCloudActive($app['ownerId'])) throw new \RuntimeException('Cloud access has expired. Records remain available to read.', 402);
                    $result = $this->native->manageRecord($app['id'], $input, $this->flows->nativeRecordSubscriptions($app['id']));
                    if (($input['action'] ?? '') !== 'read') {
                        try { $this->native->dispatchRecordEvents($app['id'], fn($id, $event, $data, $bindings) => $this->flows->enqueueNativeRecordEvent($app['id'], $id, $event, $data, $bindings)); }
                        catch (\Throwable $error) { error_log('Native record automation delivery pending for app ' . $app['id']); }
                    }
                    return $result;
                }
                $query = $request->getQueryParams();
                $notInstalled = ['installed' => false, 'tables' => [], 'readOnly' => $readOnly];
                if (!$this->native->get($app['id']) && !isset($query['table'])) return $notInstalled;
                try {
                    return $this->native->records($app['id'], isset($query['table']) && is_string($query['table']) ? $query['table'] : null, (int) ($query['offset'] ?? 0)) + ['readOnly' => $readOnly];
                } catch (\RuntimeException $missing) {
                    // The unlocked get() saw the project.json of a first install a terminated process
                    // left unfinished; records() settled it under the lock, which removed it.
                    if ($missing->getCode() === 404 && !isset($query['table']) && !$this->native->get($app['id'])) return $notInstalled;
                    throw $missing;
                }
            }
            if ($request->getMethod() === 'GET') {
                // available = artifacts prepared; preflight = the runtime actually starts here
                // (audit FL-03). Owner-only endpoint; preflight messages carry no paths or secrets.
                // The demo is public traffic that cannot install anything: it never forks the preflight.
                $preflight = !$readOnly && $this->native->available() ? $this->native->preflight() : null;
                // Read under the management lock, so an update left unfinished is settled before it is shown.
                // The engine block is the owner's settings view: choice, outcome, reason, and what
                // this site allows them to choose between.
                return ['available' => $this->native->available(), 'ready' => $preflight !== null && $preflight['ok'], 'preflight' => $preflight, 'project' => $this->native->project($app['id']), 'readOnly' => $readOnly,
                    'engine' => $this->engines->effective($app['id']), 'enginePolicy' => $this->engines->ownerPolicy()];
            }
            $body = $request->getParsedBody();
            if (!is_array($body) || !is_array($body['project'] ?? null) || !is_int($body['expectedVersion'] ?? null) || $body['expectedVersion'] < 0) throw new \InvalidArgumentException('Provide a project and expectedVersion');
            return ['project' => $this->native->install($app['id'], $body['project'], $body['expectedVersion'])];
        }, !$readOnly);
    }

    /**
     * Public entry metadata only; application source remains behind runtime access checks.
     * Read without the management lock on purpose: this runs on every visit, and the locked
     * read would answer 409 to every visitor for the length of each install (and hold the lock
     * against the installer). An unsettled update affects only home/access here; the runtime
     * reads that follow settle it.
     */
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
        // The page was loaded on one engine; the server may have decided otherwise since (a
        // revocation, a policy edit). Checked before respond() so the answer carries the
        // engine_changed code the parent remounts on, not a bare 409.
        if ($stale = $this->refuseStaleEngine($request, $response, $app['id'])) return $stale;
        return $this->respond($response, function () use ($request, $app, $user, $owner) {
            // Access is decided against the settled project (FL-S04), never an update's leftover project.json.
            $project = $this->native->project($app['id']);
            if (!$project) throw new \RuntimeException('Native app not found', 404);
            $membership = $user && !$owner && $project['access'] === 'members' ? $this->users->getAppUser($app['id'], $user) : null;
            if ($project['access'] === 'members' && !$owner && (!$user || ($membership['status'] ?? '') !== 'active')) throw new \RuntimeException('Sign in with an active app membership to continue', 403);
            $identity = $project['access'] === 'members' ? ['formlogic' => ['appId' => $app['id'], 'userId' => $user, 'roleId' => $owner ? 'owner' : ($membership['roleId'] ?? null)]] : [];
            if ($request->getMethod() === 'GET') {
                $client = array_filter($project['files'], static fn($path) => !preg_match('~^(server|backend|private)/~i', $path) && !str_ends_with($path, '.sql'), ARRAY_FILTER_USE_KEY);
                $manifest = json_decode($client['manifest.json'], true);
                $origins = $manifest['config']['server']['allowedOrigins'] ?? [];
                unset($manifest['server'], $manifest['config']['server']);
                // The engine is the server's decision, never the project's: a manifest that names
                // one is stripped here, the way the server block above is, so a published project
                // can never talk its own shell into another engine.
                unset($manifest['engine'], $manifest['logicEngine'], $manifest['config']['engine']);
                $client['manifest.json'] = json_encode($manifest, JSON_THROW_ON_ERROR);
                $client['permission.json'] = '{"permissions":{}}';
                return ['name' => $app['name'], 'project' => ['version' => $project['version'], 'client' => $client, 'assets' => $project['assets'], 'access' => $project['access'], 'origins' => $origins]]
                    + $this->engineForRuntime($app['id']);
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
            ], $identity, $this->flows->nativeRecordSubscriptions($app['id']), (int) ($project['version'] ?? 0));
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

    /**
     * $owner: the caller administers this app. Only then is an installation that needs operator
     * recovery named as such; its message lists the unfinished steps and folders relative to the
     * installation (the service replaces absolute locations; no keys or record values). Visitors
     * and the shared demo keep the generic 503.
     */
    /** What a runtime mount needs: the id to run and the revision it must send back on requests. */
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

    private function respond(Response $response, callable $operation, bool $owner = false): Response
    {
        $response = $response->withHeader('Cache-Control', 'no-store')->withHeader('X-Content-Type-Options', 'nosniff');
        try { return $this->jsonResponse($response, $operation()); }
        catch (\InvalidArgumentException|\JsonException $e) { return $this->jsonError($response, $e->getMessage(), 400); }
        catch (\RuntimeException $e) {
            if (in_array($e->getCode(), [402,403,404,409,422,429], true)) return $this->jsonError($response, $e->getMessage(), $e->getCode());
            error_log('Native app error: ' . $e->getMessage());
            if ($owner && $e->getCode() === 0 && preg_match(self::RECOVERY_REQUIRED, $e->getMessage())) return $this->jsonError($response, $e->getMessage(), 503, 'recovery_required');
            return $this->jsonError($response, 'The native app host is unavailable. Check its runtime configuration.', 503);
        }
    }
}

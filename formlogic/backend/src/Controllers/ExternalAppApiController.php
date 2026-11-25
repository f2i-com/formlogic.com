<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Helpers\IpResolver;
use FormLogic\Services\{AccessGateService, AppService, CloudFlowRunner, FlowService, NativeAppCalls, NativeAppService, NativeRecordEventRouter, PlanService, PluginService, RateLimiter};
use FormLogic\Support\SessionOriginPolicy;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * External API-key (`flk_...`), customizable public REST API, & cross-app invocation controller:
 *  - GET  /api/v1/apps                           (`apps:invoke`)  list owner's invokable apps & routes
 *  - POST /api/v1/apps/{appId}/invoke            (`apps:invoke`)  invoke `.logic` or container backend route
 *  - ANY  /api/v1/apps/{appId}/routes/{path:.*}  (`apps:invoke`)  direct REST passthrough to app backend
 *  - ANY  /api/public/apps/{appId}/routes/{p:.*} (public policy)  public REST API when owner enables `public`/`both`
 *  - POST /api/v1/flows/{flowId}/run             (`flows:run`)    programmatically run or enqueue a flow
 *  - POST /api/v1/apps/{appId}/flows/{slug}/run  (`flows:run`)    programmatically run a flow by app + slug
 *  - POST /api/flows/internal/native-app-request     (session)    browser flow runner proxy (owner-only)
 *  - POST /api/flows/internal/native-record-action   (session)    browser flow runner proxy (owner-only)
 */
class ExternalAppApiController
{
    use JsonResponseTrait;

    public function __construct(
        private AppService $apps,
        private NativeAppService $native,
        private FlowService $flows,
        private CloudFlowRunner $cloudRunner,
        private PlanService $plans,
        private NativeRecordEventRouter $records,
        private ?NativeAppCalls $calls = null,
        private ?RateLimiter $rateLimiter = null,
    ) {}

    /**
     * Effective external API policy for an app (`settings.externalApi` merged with safe defaults).
     *
     * @param array<string, mixed> $app
     * @return array{
     *   enabled: bool,
     *   authMode: 'api_key'|'both'|'public',
     *   allowedMethods: list<string>,
     *   allowedPaths: list<string>,
     *   blockedPaths: list<string>,
     *   defaultPrefix: string,
     *   corsOrigins: list<string>,
     *   rateLimitPerMinute: int,
     *   customHeaders: array<string, string>
     * }
     */
    public static function externalApiPolicy(array $app): array
    {
        $settings = is_array($app['settings'] ?? null) ? $app['settings'] : [];
        $raw = is_array($settings['externalApi'] ?? null) ? $settings['externalApi'] : [];
        $sanitized = AppService::sanitizeExternalApi($raw);
        if ($sanitized !== null) {
            /** @var array{enabled:bool,authMode:'api_key'|'both'|'public',allowedMethods:list<string>,allowedPaths:list<string>,blockedPaths:list<string>,defaultPrefix:string,corsOrigins:list<string>,rateLimitPerMinute:int,customHeaders:array<string,string>} $sanitized */
            return $sanitized;
        }
        return [
            'enabled' => true,
            'authMode' => 'api_key',
            'allowedMethods' => ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'],
            'allowedPaths' => [],
            'blockedPaths' => [],
            'defaultPrefix' => '',
            'corsOrigins' => [],
            'rateLimitPerMinute' => 120,
            'customHeaders' => [],
        ];
    }

    /** GET /api/v1/apps — list the API key owner's apps that expose a hosted SoftN or container backend. */
    public function listApps(Request $request, Response $response): Response
    {
        $userId = (string) ($request->getAttribute('userId') ?? '');
        if ($userId === '') {
            return $this->jsonError($response, 'Authentication required', 401);
        }
        $owned = $this->apps->getAllApps($userId);
        $result = [];
        foreach ($owned as $app) {
            if (($app['ownerId'] ?? null) !== $userId) continue;
            $policy = self::externalApiPolicy($app);
            if (!$policy['enabled']) continue;
            $appId = (string) $app['id'];
            $summary = $this->native->summary($appId);
            if ($summary === null || !NativeAppService::hasBackend($summary)) continue;
            $manifest = json_decode((string) ($summary['files']['manifest.json'] ?? ''), true);
            $manifest = is_array($manifest) ? $manifest : [];
            $isContainer = NativeAppService::hasContainerBackend($summary);
            $routes = [];
            if ($isContainer) {
                $rawRoutes = is_array($manifest['backend']['routes'] ?? null) ? $manifest['backend']['routes'] : ['/api'];
                foreach ($rawRoutes as $r) {
                    if (is_string($r)) $routes[] = ['method' => 'ANY', 'path' => $r];
                }
            } else {
                foreach (is_array($manifest['server']['routes'] ?? null) ? $manifest['server']['routes'] : [] as $r) {
                    if (is_array($r) && is_string($r['method'] ?? null) && is_string($r['path'] ?? null)) {
                        $routes[] = ['method' => $r['method'], 'path' => $r['path']];
                    }
                }
            }
            $slug = (string) ($app['slug'] ?? $appId);
            $result[] = [
                'id' => $appId,
                'name' => $app['name'],
                'slug' => $slug,
                'status' => $app['status'],
                'backendType' => $isContainer ? (string) ($manifest['backend']['runtime'] ?? 'container') : 'softn-logic',
                'sharedDatabaseAppId' => $app['settings']['sharedDatabaseAppId'] ?? null,
                'databaseAppId' => $this->native->databaseAppId($appId),
                'routes' => $routes,
                'externalApi' => [
                    'authMode' => $policy['authMode'],
                    'allowedMethods' => $policy['allowedMethods'],
                    'allowedPaths' => $policy['allowedPaths'],
                    'blockedPaths' => $policy['blockedPaths'],
                    'defaultPrefix' => $policy['defaultPrefix'],
                    'rateLimitPerMinute' => $policy['rateLimitPerMinute'],
                    'corsOrigins' => $policy['corsOrigins'],
                    'invokePath' => '/api/v1/apps/' . $slug . '/invoke',
                    'routesPath' => '/api/v1/apps/' . $slug . '/routes/',
                    'publicRoutesPath' => ($app['status'] ?? '') === 'published'
                        && in_array($policy['authMode'], ['public', 'both'], true)
                        && AccessGateService::normalizeRequirements($app['settings']['requires'] ?? null) === []
                        ? '/api/public/apps/' . $slug . '/routes/'
                        : null,
                ],
            ];
        }
        return $this->jsonResponse($response, ['apps' => $result]);
    }

    /** OPTIONS preflight for per-app CORS on `/api/v1/apps/{appId}/...` and `/api/public/apps/{appId}/...`. */
    public function preflight(Request $request, Response $response, array $args): Response
    {
        $appRef = (string) ($args['appId'] ?? '');
        $app = $appRef !== '' ? ($this->apps->getApp($appRef) ?? $this->apps->getAppBySlug($appRef)) : null;
        $resp = $response->withStatus(204);
        if (!$app) {
            return $resp;
        }
        $policy = self::externalApiPolicy($app);
        if (!$policy['enabled']) {
            return $resp;
        }
        return $this->applyAppCors($request, $resp, $policy);
    }

    /** POST /api/v1/apps/{appId}/invoke — invoke any route on an owned SoftN or container backend. */
    public function invokeApp(Request $request, Response $response, array $args): Response
    {
        $userId = (string) ($request->getAttribute('userId') ?? '');
        $appRef = (string) ($args['appId'] ?? '');
        $app = $this->resolveOwnedApp($userId, $appRef);
        if ($app === null) {
            return $this->jsonError($response, 'App not found or access denied', 404);
        }
        $input = $request->getParsedBody();
        if (!is_array($input)) {
            return $this->jsonError($response, 'Provide a JSON request payload with method and path.', 400);
        }
        $method = strtoupper(trim((string) ($input['method'] ?? 'GET')));
        $path = trim((string) ($input['path'] ?? ''));
        $query = $input['query'] ?? [];
        $body = $input['body'] ?? null;
        $headers = is_array($input['headers'] ?? null) ? $input['headers'] : [];
        return $this->dispatchBackendCall($request, $response, $app, $userId, $method, $path, $query, $body, $headers, 'api_key');
    }

    /** ANY /api/v1/apps/{appId}/routes/{path:.*} — direct HTTP passthrough to an owned app backend. */
    public function routeApp(Request $request, Response $response, array $args): Response
    {
        $userId = (string) ($request->getAttribute('userId') ?? '');
        $appRef = (string) ($args['appId'] ?? '');
        $app = $this->resolveOwnedApp($userId, $appRef);
        if ($app === null) {
            return $this->jsonError($response, 'App not found or access denied', 404);
        }
        return $this->dispatchDirectHttpRoute($request, $response, $app, $userId, (string) ($args['path'] ?? ''), 'api_key');
    }

    /**
     * ANY /api/public/apps/{appId}/routes/{path:.*} — public REST API passthrough for published SoftN
     * apps whose owner enabled `settings.externalApi.authMode` = `public` or `both`.
     */
    public function publicRouteApp(Request $request, Response $response, array $args): Response
    {
        $appRef = (string) ($args['appId'] ?? '');
        $app = $appRef !== '' ? ($this->apps->getApp($appRef) ?? $this->apps->getAppBySlug($appRef)) : null;
        if (!$app || ($app['status'] ?? '') !== 'published') {
            return $this->jsonError($response, 'Public API not found', 404);
        }
        $policy = self::externalApiPolicy($app);
        if (!$policy['enabled'] || !in_array($policy['authMode'], ['public', 'both'], true)) {
            return $this->applyAppCors($request, $this->jsonError($response, 'Public API access is not enabled for this app.', 403, 'public_api_disabled'), $policy);
        }
        if (AccessGateService::normalizeRequirements($app['settings']['requires'] ?? null) !== []) {
            return $this->applyAppCors($request, $this->jsonError($response, 'Public API access is unavailable for apps with access-gate requirements.', 403, 'access_gate_required'), $policy);
        }
        $ownerId = (string) ($app['ownerId'] ?? '');
        return $this->dispatchDirectHttpRoute($request, $response, $app, $ownerId, (string) ($args['path'] ?? ''), 'public_api');
    }

    /**
     * Shared direct HTTP route extraction (method, path, query, JSON/raw body, sanitized headers).
     * Forwards `X-App-Authorization` as `authorization` to the app backend without ever leaking FormLogic `flk_` keys.
     *
     * @param array<string, mixed> $app
     */
    private function dispatchDirectHttpRoute(
        Request $request,
        Response $response,
        array $app,
        string $ownerUserId,
        string $rawRouteArg,
        string $via,
    ): Response {
        $method = strtoupper($request->getMethod());
        $rawPath = '/' . ltrim($rawRouteArg, '/');
        $query = $request->getQueryParams();
        $rawBodyText = (string) $request->getBody();
        $body = null;
        if ($rawBodyText !== '' && !in_array($method, ['GET', 'HEAD'], true)) {
            $decoded = json_decode($rawBodyText, true);
            $body = json_last_error() === JSON_ERROR_NONE ? $decoded : $rawBodyText;
        }
        $headers = [];
        foreach ($request->getHeaders() as $name => $values) {
            $ln = strtolower($name);
            if ($ln === 'x-app-authorization') {
                $headers['authorization'] = implode(', ', $values);
                continue;
            }
            if (in_array($ln, ['authorization', 'host', 'cookie', 'content-length'], true) || str_starts_with($ln, 'x-formlogic-')) {
                continue;
            }
            $headers[$ln] = implode(', ', $values);
        }
        return $this->dispatchBackendCall($request, $response, $app, $ownerUserId, $method, $rawPath, $query, $body, $headers, $via, true);
    }

    /** POST /api/v1/flows/{flowId}/run — programmatically run or enqueue an owned flow via API key. */
    public function runFlow(Request $request, Response $response, array $args): Response
    {
        $userId = (string) ($request->getAttribute('userId') ?? '');
        $flowId = (string) ($args['flowId'] ?? '');
        if ($userId === '' || $flowId === '') {
            return $this->jsonError($response, 'Flow not found', 404);
        }
        $flow = $this->flows->getOwnedFlow($userId, $flowId);
        if ($flow === null) {
            return $this->jsonError($response, 'Flow not found', 404);
        }
        return $this->executeFlowRequest($request, $response, $flow, $userId);
    }

    /** POST /api/v1/apps/{appId}/flows/{slug}/run — programmatically run an app flow by slug via API key. */
    public function runAppFlow(Request $request, Response $response, array $args): Response
    {
        $userId = (string) ($request->getAttribute('userId') ?? '');
        $app = $this->resolveOwnedApp($userId, (string) ($args['appId'] ?? ''));
        if ($app === null) {
            return $this->jsonError($response, 'App not found or access denied', 404);
        }
        $slug = trim((string) ($args['slug'] ?? ''));
        $flow = $slug !== '' ? $this->flows->findEnabledFlowBySlug((string) $app['id'], $slug) : null;
        if ($flow === null || ($flow['ownerUserId'] ?? null) !== $userId) {
            return $this->jsonError($response, 'Flow not found or disabled', 404);
        }
        return $this->executeFlowRequest($request, $response, $flow, $userId);
    }

    /**
     * Session-authenticated owner proxy for the browser flow runner (`native_app_request` node).
     * POST /api/flows/internal/native-app-request
     */
    public function browserFlowNativeAppRequest(Request $request, Response $response): Response
    {
        $userId = (string) ($request->getAttribute('userId') ?? '');
        if ($userId === '') {
            return $this->jsonError($response, 'Authentication required', 401);
        }
        if ($blocked = $this->blockIfDemo($request, $response, 'Cross-app invocations are disabled in the shared demo.')) {
            return $blocked;
        }
        $input = $request->getParsedBody();
        if (!is_array($input)) {
            return $this->jsonError($response, 'Provide appId, method, and path.', 400);
        }
        $app = $this->resolveOwnedApp($userId, (string) ($input['appId'] ?? ''));
        if ($app === null) {
            return $this->jsonError($response, 'Target app not found or access denied', 404);
        }
        $method = strtoupper(trim((string) ($input['method'] ?? 'GET')));
        $path = trim((string) ($input['path'] ?? ''));
        $query = $input['query'] ?? [];
        $body = $input['body'] ?? null;
        $headers = is_array($input['headers'] ?? null) ? $input['headers'] : [];
        return $this->dispatchBackendCall($request, $response, $app, $userId, $method, $path, $query, $body, $headers, 'flow');
    }

    /**
     * Session-authenticated owner proxy for the browser flow runner (`native_record_action` node).
     * POST /api/flows/internal/native-record-action
     */
    public function browserFlowNativeRecordAction(Request $request, Response $response): Response
    {
        $userId = (string) ($request->getAttribute('userId') ?? '');
        if ($userId === '') {
            return $this->jsonError($response, 'Authentication required', 401);
        }
        if ($blocked = $this->blockIfDemo($request, $response, 'Database actions are disabled in the shared demo.')) {
            return $blocked;
        }
        $input = $request->getParsedBody();
        if (!is_array($input)) {
            return $this->jsonError($response, 'Provide appId, table, and operation.', 400);
        }
        $app = $this->resolveOwnedApp($userId, (string) ($input['appId'] ?? ''));
        if ($app === null) {
            return $this->jsonError($response, 'Target app not found or access denied', 404);
        }
        $appId = (string) $app['id'];
        $table = trim((string) ($input['table'] ?? ''));
        $operation = strtolower(trim((string) ($input['operation'] ?? 'list')));
        if ($table === '') {
            return $this->jsonError($response, 'Select a table.', 400);
        }
        try {
            if ($operation === 'list') {
                $opts = [];
                if (isset($input['q']) && is_string($input['q']) && $input['q'] !== '') $opts['q'] = $input['q'];
                if (isset($input['limit']) && is_numeric($input['limit'])) $opts['limit'] = max(1, min((int) $input['limit'], 250));
                if (isset($input['filter'])) $opts['filter'] = $input['filter'];
                $offset = isset($input['offset']) && is_numeric($input['offset']) ? max(0, (int) $input['offset']) : 0;
                $res = $this->native->records($appId, $table, $offset, null, $opts);
                $rows = is_array($res['rows'] ?? null) ? $res['rows'] : [];
                return $this->jsonResponse($response, [
                    'table' => $table,
                    'rows' => $rows,
                    'count' => count($rows),
                    'total' => (int) ($res['total'] ?? count($rows)),
                    'first' => $rows[0] ?? null,
                    'found' => count($rows) > 0,
                    'appId' => $appId,
                ]);
            }
            if (!in_array($operation, ['read', 'create', 'update', 'delete'], true)) {
                return $this->jsonError($response, 'Unsupported operation (use list, read, create, update, or delete).', 400);
            }
            if ($operation !== 'read' && $this->plans->isEnforced() && !$this->plans->isCloudActive($userId)) {
                return $this->jsonError($response, 'Cloud access has expired. Records remain available to read.', 402);
            }
            $opInput = ['table' => $table, 'action' => $operation];
            if (array_key_exists('key', $input)) $opInput['key'] = $input['key'];
            if (array_key_exists('values', $input)) $opInput['values'] = $input['values'];
            if (in_array($operation, ['update', 'delete'], true)) {
                if (empty($input['revision']) && isset($opInput['key'])) {
                    $current = $this->native->manageRecord($appId, ['table' => $table, 'action' => 'read', 'key' => $opInput['key']]);
                    $opInput['revision'] = $current['record']['revision'] ?? null;
                } elseif (isset($input['revision'])) {
                    $opInput['revision'] = $input['revision'];
                }
            }
            $groupAppIds = $this->apps->sharedDatabaseGroupAppIds($appId);
            $subscriptions = $operation === 'read' ? [] : $this->flows->nativeRecordSubscriptionsForApps($groupAppIds);
            $res = $this->native->manageRecord($appId, $opInput, $subscriptions);
            if ($operation !== 'read') {
                try { $this->native->dispatchRecordEvents($appId, $this->records->for($appId)); } catch (\Throwable) {}
            }
            return $this->jsonResponse($response, $res + ['table' => $table, 'appId' => $appId]);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonError($response, $e->getMessage(), 400);
        } catch (\RuntimeException $e) {
            $code = $e->getCode();
            $status = ($code >= 400 && $code < 600) ? $code : 422;
            return $this->jsonError($response, $e->getMessage(), $status);
        }
    }

    /** @return array<string, mixed>|null */
    private function resolveOwnedApp(string $userId, string $ref): ?array
    {
        if ($userId === '' || $ref === '') return null;
        $app = $this->apps->getApp($ref) ?? $this->apps->getAppBySlug($ref);
        if (!$app || ($app['ownerId'] ?? null) !== $userId) return null;
        return $app;
    }

    private function executeFlowRequest(Request $request, Response $response, array $flow, string $userId): Response
    {
        if (empty($flow['enabled'])) {
            return $this->jsonError($response, 'This flow is disabled.', 409, 'flow_disabled');
        }
        $body = $request->getParsedBody() ?? [];
        if (!is_array($body)) $body = [];
        $inputs = $body['inputs'] ?? [];
        if (!is_array($inputs)) {
            return $this->jsonError($response, 'inputs must be an object', 400);
        }
        $async = ($body['async'] ?? false) === true;
        $location = (string) ($flow['executionLocation'] ?? 'auto');
        $effective = $this->cloudRunner->effectiveGraph($flow);
        $offenders = CloudFlowRunner::validateCloudEligible($effective);
        $runInCloud = !$async && in_array($location, ['cloud', 'auto'], true) && $offenders === [];

        if ($runInCloud) {
            try {
                $outcome = $this->cloudRunner->run($flow, $userId, $inputs);
            } catch (\InvalidArgumentException $e) {
                return $this->jsonError($response, $e->getMessage(), 400);
            } catch (\RuntimeException $e) {
                if ($e->getMessage() === 'flow_credits_exceeded') {
                    return $this->jsonError($response, 'Monthly cloud flow-run credits exceeded.', 402, 'flow_credits_exceeded');
                }
                throw $e;
            }
            if (($outcome['ok'] ?? false) !== true) {
                return $this->jsonError($response, 'This flow contains nodes that cannot run in FormLogic Cloud.', 422, 'cloud_unsupported_node', ['nodes' => $outcome['nodes'] ?? []]);
            }
            return $this->jsonResponse($response, [
                'runId' => $outcome['runId'],
                'status' => $outcome['status'],
                'result' => $outcome['result'] ?? null,
                'error' => $outcome['error'] ?? null,
                'executionLocation' => 'cloud',
            ]);
        }

        // Enqueue for desktop / browser / async execution.
        try {
            $queued = $this->flows->enqueueRun($flow, [
                'triggerEvent' => 'api.trigger',
                'correlationId' => 'api-run-' . bin2hex(random_bytes(8)),
                'idempotencyKey' => is_string($body['idempotencyKey'] ?? null) && $body['idempotencyKey'] !== ''
                    ? 'api:' . $flow['id'] . ':' . substr($body['idempotencyKey'], 0, 120)
                    : 'api:' . $flow['id'] . ':' . bin2hex(random_bytes(12)),
                'inputSnapshot' => $inputs,
                'runByUserId' => $userId,
            ]);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonError($response, $e->getMessage(), 400);
        }
        return $this->jsonResponse($response, [
            'runId' => $queued['run']['runId'] ?? ($queued['run']['id'] ?? null),
            'status' => $queued['run']['status'] ?? 'queued',
            'executionLocation' => $location,
            'queued' => true,
        ], 202);
    }

    /**
     * @param array<string, mixed> $app
     * @param array<string, mixed> $headersIn
     */
    private function dispatchBackendCall(
        Request $request,
        Response $response,
        array $app,
        string $userId,
        string $method,
        string $path,
        mixed $query,
        mixed $body,
        array $headersIn,
        string $via,
        bool $rawPassthrough = false,
    ): Response {
        $started = hrtime(true);
        $arrived = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        $isExternal = ($via === 'api_key' || $via === 'public_api');
        $policy = self::externalApiPolicy($app);
        $appId = (string) $app['id'];
        $clientIp = IpResolver::fromEnvironment()->getClientIp($request);

        $decorate = function (Response $resp, ?int $rateRemaining = null) use ($request, $isExternal, $policy): Response {
            if (!$isExternal) {
                return $resp;
            }
            $resp = $this->applyAppCors($request, $resp, $policy);
            foreach ($policy['customHeaders'] as $hk => $hv) {
                $resp = $resp->withHeader($hk, $hv);
            }
            if ($rateRemaining !== null) {
                $resp = $resp
                    ->withHeader('X-RateLimit-Limit', (string) $policy['rateLimitPerMinute'])
                    ->withHeader('X-RateLimit-Remaining', (string) max(0, $rateRemaining));
            }
            return $resp;
        };

        // 1. Enforce per-app External API exposure policy (`settings.externalApi`) for API-key & public calls.
        if ($isExternal) {
            if (!$policy['enabled']) {
                return $decorate($this->jsonError($response, 'External API access is disabled for this app.', 403, 'external_api_disabled'));
            }
            if ($via === 'api_key' && $policy['authMode'] === 'public') {
                return $decorate($this->jsonError($response, 'This app is configured for public API routes only (/api/public/apps/...). Switch Auth Mode to "API Key" or "Public + API Key" to allow API-key calls.', 403, 'api_key_disabled'));
            }
            if ($via === 'public_api' && !in_array($policy['authMode'], ['public', 'both'], true)) {
                return $decorate($this->jsonError($response, 'Public API access is not enabled for this app.', 403, 'public_api_disabled'));
            }
            if (!in_array($method, $policy['allowedMethods'], true)) {
                $err = $this->jsonError($response, "HTTP method {$method} is not allowed by this app's external API settings.", 405, 'method_not_allowed')
                    ->withHeader('Allow', implode(', ', $policy['allowedMethods']));
                return $decorate($err);
            }
        }

        // 2. Apply optional custom default path prefix (e.g. `/api` so `/routes/items` → `/api/items`).
        if ($isExternal && $policy['defaultPrefix'] !== '' && $path !== '') {
            $prefix = $policy['defaultPrefix'];
            $normalizedPath = str_starts_with($path, '/') ? $path : '/' . $path;
            if ($normalizedPath !== $prefix && !str_starts_with($normalizedPath, $prefix . '/') && !str_starts_with($normalizedPath, '/api/')) {
                $path = $prefix . $normalizedPath;
            }
        }

        // Strict path canonicalization & traversal rejection BEFORE blocked/allowed prefix matching
        // (closes double-slash, dot-segment, query/fragment/matrix smuggling, percent-encoded
        // route bypass, backslash, and case bypasses).
        $decodedPath = rawurldecode($path);
        if (
            $path === ''
            || !str_starts_with($path, '/')
            || !str_starts_with($decodedPath, '/')
            || strlen($path) > 2048
            || strlen($decodedPath) > 2048
            || str_contains($path, '\\')
            || str_contains($decodedPath, '\\')
            || str_contains($path, '//')
            || str_contains($decodedPath, '//')
            || strpbrk($path, '?#;') !== false
            || strpbrk($decodedPath, '?#;') !== false
            || preg_match('/%(?:2e|2f|5c|00|25|3f|23|3b)/i', $path) === 1
            || preg_match('/%[0-9a-f]{2}/i', $decodedPath) === 1
            || preg_match('#(?:^|/)\.\.?(?:/|$)#', $path) === 1
            || preg_match('#(?:^|/)\.\.?(?:/|$)#', $decodedPath) === 1
            || preg_match('/[\x00-\x1f\x7f]/', $path) === 1
            || preg_match('/[\x00-\x1f\x7f]/', $decodedPath) === 1
        ) {
            return $decorate($this->jsonError($response, 'Provide a valid backend path starting with "/".', 400));
        }
        // Canonicalize to the single-decoded path so policy checks and downstream container
        // routers inspect the exact same path (blocking `%61dmin` / `%73ite` smuggling).
        $path = $decodedPath;
        $lowerPath = strtolower($path);
        if (str_starts_with($lowerPath, PluginService::SITE_ROUTE_PREFIX)) {
            return $decorate($this->jsonError($response, 'Not found', 404));
        }

        // 3. Enforce per-app blocked & allowed path prefixes (case-insensitive on canonical path).
        if ($isExternal) {
            foreach ($policy['blockedPaths'] as $blockedPrefix) {
                if (self::pathMatchesPrefix($lowerPath, strtolower($blockedPrefix))) {
                    return $decorate($this->jsonError($response, 'This route is blocked by the app’s external API rules.', 403, 'route_blocked'));
                }
            }
            if ($policy['allowedPaths'] !== []) {
                $matched = false;
                foreach ($policy['allowedPaths'] as $allowedPrefix) {
                    if (self::pathMatchesPrefix($lowerPath, strtolower($allowedPrefix))) {
                        $matched = true;
                        break;
                    }
                }
                if (!$matched) {
                    return $decorate($this->jsonError($response, 'This route is not exposed by the app’s external API allowlist.', 403, 'route_not_exposed'));
                }
            }
        }

        // 4. Enforce per-app customizable rate limit (`rateLimitPerMinute`).
        $rateRemaining = null;
        if ($isExternal && $this->rateLimiter !== null) {
            $limit = $policy['rateLimitPerMinute'];
            $callerKey = $via === 'api_key'
                ? 'key:' . (string) ($request->getAttribute('apiKeyId') ?? $userId)
                : 'ip:' . $clientIp;
            $bucket = 'ext_app_api:' . $appId . ':' . $callerKey;
            $count = $this->rateLimiter->hit($bucket, 60);
            if ($count > $limit) {
                $retryAfter = $this->rateLimiter->secondsUntilReset(60);
                $err = $this->jsonError($response, "App API rate limit exceeded ({$limit}/min). Try again in {$retryAfter}s.", 429, 'rate_limited')
                    ->withHeader('Retry-After', (string) $retryAfter);
                return $decorate($err, 0);
            }
            $rateRemaining = max(0, $limit - $count);
        }

        $project = $this->native->project($appId);
        if (!$project || !NativeAppService::hasBackend($project)) {
            return $decorate($this->jsonError($response, 'This app has no hosted backend.', 404), $rateRemaining);
        }
        if (in_array($method, ['POST', 'PUT', 'PATCH', 'DELETE'], true) && $this->plans->isEnforced() && !$this->plans->isCloudActive($userId)) {
            return $decorate($this->jsonError($response, 'Cloud access has expired. Read requests remain available.', 402), $rateRemaining);
        }
        $blockedForwardHeaders = [
            'host' => true, 'origin' => true, 'referer' => true, 'forwarded' => true,
            'x-real-ip' => true, 'x-original-url' => true, 'x-rewrite-url' => true,
            'x-http-method-override' => true, 'x-method-override' => true,
            'x-formlogic' => true,
        ];
        $headers = [];
        foreach ($headersIn as $k => $v) {
            if (!is_string($k) || !is_scalar($v)) continue;
            $lk = strtolower(trim($k));
            if (
                $lk === ''
                || strlen($lk) > 128
                || !preg_match('/^[a-z0-9-]+$/', $lk)
                || isset($blockedForwardHeaders[$lk])
                || str_starts_with($lk, 'x-formlogic-')
                || str_starts_with($lk, 'x-forwarded-')
                || str_starts_with($lk, 'proxy-')
            ) {
                continue;
            }
            $val = preg_replace('/[\r\n\0]+/', '', (string) $v) ?? '';
            $headers[$lk] = substr($val, 0, 8192);
            if (count($headers) >= 64) break;
        }
        $identity = $via === 'public_api'
            ? [
                'appId' => $appId,
                'userId' => null,
                'roleId' => 'visitor',
                'authenticated' => false,
                'via' => 'public_api',
                'formlogic' => ['appId' => $appId, 'userId' => null, 'roleId' => 'visitor'],
            ]
            : [
                'appId' => $appId,
                'userId' => $userId,
                'roleId' => 'owner',
                'authenticated' => true,
                'via' => $via,
                'formlogic' => ['appId' => $appId, 'userId' => $userId, 'roleId' => 'owner'],
            ];
        $groupAppIds = $this->apps->sharedDatabaseGroupAppIds($appId);
        $subscriptions = $this->flows->nativeRecordSubscriptionsForApps($groupAppIds);

        $recordAudit = function (int $status, ?string $errMsg = null) use ($appId, $method, $path, $via, $started, $arrived, $isExternal): void {
            if (!$isExternal || $this->calls === null) return;
            $ms = (int) round((hrtime(true) - $started) / 1_000_000);
            $recMethod = match ($method) {
                'PATCH' => 'PUT',
                'HEAD' => 'GET',
                default => $method,
            };
            $caller = $via === 'public_api' ? 'visitor' : 'owner';
            $this->calls->record($appId, $recMethod, $path, $status, max(0, $ms), $errMsg, $caller, $arrived);
        };

        try {
            if (NativeAppService::hasContainerBackend($project)) {
                if (!in_array($method, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'], true)) {
                    return $decorate($this->jsonError($response, 'Unsupported HTTP method.', 400), $rateRemaining);
                }
                $queryStr = is_string($query) ? ltrim($query, '?') : (is_array($query) ? http_build_query($query) : '');
                $bodyBase64 = '';
                if ($body !== null && !in_array($method, ['GET', 'HEAD'], true)) {
                    if (!isset($headers['content-type']) && is_array($body)) {
                        $headers['content-type'] = 'application/json';
                    }
                    $rawBody = is_string($body) ? $body : json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
                    $bodyBase64 = base64_encode($rawBody);
                }
                $result = $this->native->containerRequest($appId, [
                    'method' => $method,
                    'path' => $path,
                    'query' => $queryStr,
                    'headers' => (object) $headers,
                    'bodyBase64' => $bodyBase64,
                    'client_ip' => $clientIp,
                ], $identity, (int) ($project['version'] ?? 0), $subscriptions);

                $extractedHeaders = NativeRecordEventRouter::extractContainerTriggers($result['headers']);
                $result['headers'] = $extractedHeaders['headers'];
                $triggers = $extractedHeaders['triggers'];

                $rawText = base64_decode($result['bodyBase64'], true);
                $rawText = is_string($rawText) ? $rawText : '';
                $decoded = json_decode($rawText, true);
                $isJson = json_last_error() === JSON_ERROR_NONE && is_array($decoded);
                try { $this->native->dispatchRecordEvents($appId, $this->records->for($appId)); } catch (\Throwable) {}
                if ($triggers !== []) {
                    try { $this->records->triggerBackendFlows($app, $triggers); } catch (\Throwable) {}
                }
                $errSnippet = $result['status'] >= 400
                    ? (is_array($decoded) && is_string($decoded['message'] ?? $decoded['error'] ?? null) ? (string) ($decoded['message'] ?? $decoded['error']) : substr($rawText, 0, 200))
                    : null;
                $recordAudit((int) $result['status'], $errSnippet);
                if ($rawPassthrough) {
                    $resp = $response->withStatus($result['status']);
                    $safePassHeaders = ['cache-control', 'etag', 'last-modified', 'vary', 'content-language', 'x-request-id', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after'];
                    $safeContentTypes = [
                        'application/json',
                        'application/problem+json',
                        'application/vnd.api+json',
                        'text/plain',
                        'text/csv',
                        'text/tab-separated-values',
                        'application/octet-stream',
                        'image/png',
                        'image/jpeg',
                        'image/gif',
                        'image/webp',
                    ];
                    $chosenContentType = null;
                    $forceAttachment = false;
                    foreach ($result['headers'] as [$hk, $hv]) {
                        $lhk = strtolower(trim((string) $hk));
                        $val = preg_replace('/[\r\n\0]+/', '', (string) $hv) ?? '';
                        if ($lhk === 'content-type') {
                            $baseMime = strtolower(trim(explode(';', $val, 2)[0]));
                            if (in_array($baseMime, $safeContentTypes, true)) {
                                $chosenContentType = $val;
                            } else {
                                // Never serve active web/script types (text/html, image/svg+xml, application/xhtml+xml, etc.)
                                // inline on the FormLogic API origin — prevents same-origin stored XSS.
                                $chosenContentType = 'application/octet-stream';
                                $forceAttachment = true;
                            }
                            continue;
                        }
                        if (!in_array($lhk, $safePassHeaders, true)) continue;
                        $resp = $resp->withHeader($lhk, $val);
                    }
                    if ($chosenContentType === null) {
                        $chosenContentType = $isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8';
                    }
                    $resp = $resp
                        ->withHeader('Content-Type', $chosenContentType)
                        ->withHeader('X-Content-Type-Options', 'nosniff');
                    if ($forceAttachment) {
                        $resp = $resp->withHeader('Content-Disposition', 'attachment; filename="response.bin"');
                    }
                    if ($method !== 'HEAD' && $result['status'] !== 204) {
                        $resp->getBody()->write($rawText);
                    }
                    return $decorate($resp, $rateRemaining);
                }
                return $decorate($this->jsonResponse($response, [
                    'status' => $result['status'],
                    'ok' => $result['status'] >= 200 && $result['status'] < 300,
                    'headers' => $result['headers'],
                    'body' => $isJson ? $decoded : $rawText,
                ]), $rateRemaining);
            }

            if (!in_array($method, ['GET', 'POST', 'PUT', 'DELETE'], true) || !preg_match('~^/api/[a-zA-Z0-9/_-]+$~D', $path)) {
                return $decorate($this->jsonError($response, 'SoftN .logic backends support GET, POST, PUT, and DELETE under /api/....', 400), $rateRemaining);
            }
            $nativeBody = $body !== null ? $body : (object) [];
            if (is_string($nativeBody) && $nativeBody !== '') {
                $decoded = json_decode($nativeBody, true);
                if (json_last_error() !== JSON_ERROR_NONE) {
                    return $decorate($this->jsonError($response, 'Request body must be valid JSON.', 400), $rateRemaining);
                }
                $nativeBody = $decoded;
            }
            $res = $this->native->request($appId, [
                'method' => $method,
                'path' => $path,
                'query' => (object) (is_array($query) ? $query : []),
                'body' => $nativeBody,
                'headers' => (object) [
                    'authorization' => (string) ($headers['authorization'] ?? ''),
                    'idempotency-key' => (string) ($headers['idempotency-key'] ?? ''),
                ],
                'client_ip' => $clientIp,
                'photos' => false,
            ], $identity, $subscriptions, (int) ($project['version'] ?? 0));

            $extracted = NativeRecordEventRouter::extractBodyTriggers($res['body'] ?? null);
            $resBody = $extracted['body'];
            try { $this->native->dispatchRecordEvents($appId, $this->records->for($appId)); } catch (\Throwable) {}
            if ($extracted['triggers'] !== []) {
                try { $this->records->triggerBackendFlows($app, $extracted['triggers']); } catch (\Throwable) {}
            }
            $status = (int) ($res['status'] ?? 500);
            $errSnippet = $status >= 400 && is_array($resBody) && is_string($resBody['message'] ?? $resBody['error'] ?? null)
                ? (string) ($resBody['message'] ?? $resBody['error'])
                : null;
            $recordAudit($status, $errSnippet);
            if ($rawPassthrough) {
                return $decorate($this->jsonResponse($response, is_array($resBody) ? $resBody : ['data' => $resBody], $status), $rateRemaining);
            }
            return $decorate($this->jsonResponse($response, [
                'status' => $status,
                'ok' => $status >= 200 && $status < 300,
                'body' => $resBody,
            ]), $rateRemaining);
        } catch (\InvalidArgumentException $e) {
            $recordAudit(400, $e->getMessage());
            return $decorate($this->jsonError($response, $e->getMessage(), 400), $rateRemaining);
        } catch (\RuntimeException $e) {
            $code = $e->getCode();
            $status = ($code >= 400 && $code < 600) ? $code : 500;
            $recordAudit($status, $e->getMessage());
            return $decorate($this->jsonError($response, $e->getMessage(), $status), $rateRemaining);
        }
    }

    /** Segment-safe prefix match: `/api/items` matches `/api/items` and `/api/items/123`, never `/api/items-secret`. */
    private static function pathMatchesPrefix(string $path, string $prefix): bool
    {
        $cleanPrefix = rtrim($prefix, '/');
        if ($cleanPrefix === '') {
            return true;
        }
        return $path === $cleanPrefix || str_starts_with($path, $cleanPrefix . '/');
    }

    /**
     * Apply per-app CORS headers from `settings.externalApi.corsOrigins`.
     * Never sets `Access-Control-Allow-Credentials` — external APIs authenticate via Bearer token or public access.
     *
     * @param array<string, mixed> $policy
     */
    private function applyAppCors(Request $request, Response $response, array $policy): Response
    {
        $origins = is_array($policy['corsOrigins'] ?? null) ? $policy['corsOrigins'] : [];
        if ($origins === []) {
            return $response;
        }
        $reqOrigin = trim($request->getHeaderLine('Origin'));
        $matched = null;
        if (in_array('*', $origins, true)) {
            $matched = '*';
        } elseif ($reqOrigin !== '') {
            $normReq = SessionOriginPolicy::normalizeOrigin($reqOrigin);
            if ($normReq !== null) {
                foreach ($origins as $allowed) {
                    if (is_string($allowed) && SessionOriginPolicy::normalizeOrigin($allowed) === $normReq) {
                        $matched = $reqOrigin;
                        break;
                    }
                }
            }
        }
        if ($matched === null) {
            return $response;
        }
        $methods = is_array($policy['allowedMethods'] ?? null) && $policy['allowedMethods'] !== []
            ? implode(', ', array_unique(array_merge($policy['allowedMethods'], ['OPTIONS'])))
            : 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
        return $response
            ->withHeader('Access-Control-Allow-Origin', $matched)
            ->withHeader('Access-Control-Allow-Methods', $methods)
            ->withHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Origin, Authorization, X-App-Authorization, Idempotency-Key')
            ->withHeader('Access-Control-Expose-Headers', 'X-RateLimit-Limit, X-RateLimit-Remaining, Retry-After')
            ->withHeader('Access-Control-Max-Age', '3600')
            ->withHeader('Vary', 'Origin');
    }
}

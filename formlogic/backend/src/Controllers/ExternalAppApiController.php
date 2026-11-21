<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Helpers\IpResolver;
use FormLogic\Services\{AppService, CloudFlowRunner, FlowService, NativeAppService, NativeRecordEventRouter, PlanService, PluginService};
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * External API-key (`flk_...`) & cross-app invocation controller:
 *  - GET  /api/v1/apps                          (`apps:invoke`)  list owner's invokable apps & routes
 *  - POST /api/v1/apps/{appId}/invoke           (`apps:invoke`)  invoke `.logic` or container backend route
 *  - ANY  /api/v1/apps/{appId}/routes/{path:.*} (`apps:invoke`)  direct REST passthrough to app backend
 *  - POST /api/v1/flows/{flowId}/run            (`flows:run`)    programmatically run or enqueue a flow
 *  - POST /api/v1/apps/{appId}/flows/{slug}/run (`flows:run`)    programmatically run a flow by app + slug
 *  - POST /api/flows/internal/native-app-request    (session)    browser flow runner proxy (owner-only)
 *  - POST /api/flows/internal/native-record-action  (session)    browser flow runner proxy (owner-only)
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
    ) {}

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
            $result[] = [
                'id' => $appId,
                'name' => $app['name'],
                'slug' => $app['slug'],
                'status' => $app['status'],
                'backendType' => $isContainer ? (string) ($manifest['backend']['runtime'] ?? 'container') : 'softn-logic',
                'sharedDatabaseAppId' => $app['settings']['sharedDatabaseAppId'] ?? null,
                'databaseAppId' => $this->native->databaseAppId($appId),
                'routes' => $routes,
            ];
        }
        return $this->jsonResponse($response, ['apps' => $result]);
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
        $method = strtoupper($request->getMethod());
        $rawPath = '/' . ltrim((string) ($args['path'] ?? ''), '/');
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
            if (in_array($ln, ['authorization', 'host', 'cookie', 'content-length'], true) || str_starts_with($ln, 'x-formlogic-')) {
                continue;
            }
            $headers[$ln] = implode(', ', $values);
        }
        return $this->dispatchBackendCall($request, $response, $app, $userId, $method, $rawPath, $query, $body, $headers, 'api_key', true);
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
        if ($path === '' || !str_starts_with($path, '/') || strlen($path) > 2048 || str_contains($path, '..') || preg_match('/[\x00-\x1f\x7f]/', $path) === 1) {
            return $this->jsonError($response, 'Provide a valid backend path starting with "/".', 400);
        }
        if (str_starts_with(strtolower($path), PluginService::SITE_ROUTE_PREFIX)) {
            return $this->jsonError($response, 'Not found', 404);
        }
        $appId = (string) $app['id'];
        $project = $this->native->project($appId);
        if (!$project || !NativeAppService::hasBackend($project)) {
            return $this->jsonError($response, 'This app has no hosted backend.', 404);
        }
        if (in_array($method, ['POST', 'PUT', 'PATCH', 'DELETE'], true) && $this->plans->isEnforced() && !$this->plans->isCloudActive($userId)) {
            return $this->jsonError($response, 'Cloud access has expired. Read requests remain available.', 402);
        }
        $headers = [];
        foreach ($headersIn as $k => $v) {
            if (!is_string($k) || !is_scalar($v)) continue;
            $lk = strtolower(trim($k));
            if ($lk === '' || strlen($lk) > 128 || str_starts_with($lk, 'x-formlogic-')) continue;
            $headers[$lk] = substr((string) $v, 0, 8192);
            if (count($headers) >= 64) break;
        }
        $identity = [
            'appId' => $appId,
            'userId' => $userId,
            'roleId' => 'owner',
            'authenticated' => true,
            'via' => $via,
            'formlogic' => ['appId' => $appId, 'userId' => $userId, 'roleId' => 'owner'],
        ];
        $groupAppIds = $this->apps->sharedDatabaseGroupAppIds($appId);
        $subscriptions = $this->flows->nativeRecordSubscriptionsForApps($groupAppIds);
        $clientIp = IpResolver::fromEnvironment()->getClientIp($request);

        try {
            if (NativeAppService::hasContainerBackend($project)) {
                if (!in_array($method, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'], true)) {
                    return $this->jsonError($response, 'Unsupported HTTP method.', 400);
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
                if ($isJson) {
                    $extractedBody = NativeRecordEventRouter::extractBodyTriggers($decoded);
                    $decoded = $extractedBody['body'];
                    $triggers = array_merge($triggers, $extractedBody['triggers']);
                    $rawText = json_encode($decoded, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
                }
                try { $this->native->dispatchRecordEvents($appId, $this->records->for($appId)); } catch (\Throwable) {}
                if ($triggers !== []) {
                    try { $this->records->triggerBackendFlows($app, $triggers); } catch (\Throwable) {}
                }
                if ($rawPassthrough) {
                    $resp = $response->withStatus($result['status']);
                    $hasContentType = false;
                    foreach ($result['headers'] as [$hk, $hv]) {
                        $lhk = strtolower($hk);
                        if (in_array($lhk, ['set-cookie', 'transfer-encoding', 'content-length'], true)) continue;
                        if ($lhk === 'content-type') $hasContentType = true;
                        $resp = $resp->withHeader($hk, $hv);
                    }
                    if (!$hasContentType) {
                        $resp = $resp->withHeader('Content-Type', $isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8');
                    }
                    $resp->getBody()->write($rawText);
                    return $resp;
                }
                return $this->jsonResponse($response, [
                    'status' => $result['status'],
                    'ok' => $result['status'] >= 200 && $result['status'] < 300,
                    'headers' => $result['headers'],
                    'body' => $isJson ? $decoded : $rawText,
                ]);
            }

            if (!in_array($method, ['GET', 'POST', 'PUT', 'DELETE'], true) || !preg_match('~^/api/[a-zA-Z0-9/_-]+$~D', $path)) {
                return $this->jsonError($response, 'SoftN .logic backends support GET, POST, PUT, and DELETE under /api/....', 400);
            }
            $nativeBody = $body !== null ? $body : (object) [];
            if (is_string($nativeBody) && $nativeBody !== '') {
                $decoded = json_decode($nativeBody, true);
                if (json_last_error() !== JSON_ERROR_NONE) {
                    return $this->jsonError($response, 'Request body must be valid JSON.', 400);
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
            if ($rawPassthrough) {
                return $this->jsonResponse($response, is_array($resBody) ? $resBody : ['data' => $resBody], $status);
            }
            return $this->jsonResponse($response, [
                'status' => $status,
                'ok' => $status >= 200 && $status < 300,
                'body' => $resBody,
            ]);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonError($response, $e->getMessage(), 400);
        } catch (\RuntimeException $e) {
            $code = $e->getCode();
            $status = ($code >= 400 && $code < 600) ? $code : 500;
            return $this->jsonError($response, $e->getMessage(), $status);
        }
    }
}

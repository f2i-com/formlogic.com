<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\McpTokenService;
use FormLogic\Services\FormService;
use FormLogic\Services\AppService;
use FormLogic\Services\ResponseService;
use FormLogic\Services\AuditService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Log\LoggerInterface;

/**
 * MCP server (Model Context Protocol over Streamable HTTP) + ephemeral-token management.
 *
 * An external AI (Claude/Cursor/…) authenticates with a short-lived MCP token (Authorization: Bearer)
 * and drives FormLogic through a small set of tools — create/edit forms, apps, custom screens, and
 * responses — scoped to the token owner. Everything goes through the same services (+ ownership checks)
 * as the rest of the API, and generated custom screens still run in the sandbox.
 */
class McpController
{
    use JsonResponseTrait;

    private const PROTOCOL_VERSION = '2024-11-05';

    public function __construct(
        private McpTokenService $tokens,
        private FormService $formService,
        private AppService $appService,
        private ResponseService $responseService,
        private ?AuditService $auditService = null,
        private ?LoggerInterface $logger = null,
    ) {}

    // ── Token management (authenticated app owner) ──

    public function createToken(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        $body = $request->getParsedBody() ?? [];
        $appId = is_string($body['appId'] ?? null) ? $body['appId'] : null;
        // If scoped to an app, verify ownership.
        if ($appId !== null) {
            $app = $this->appService->getApp($appId);
            if (!$app || ($app['ownerId'] ?? null) !== $userId) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found or access denied'], 404);
            }
        }
        $ttl = (int) ($body['ttl'] ?? 3600);
        $idle = (int) ($body['idle'] ?? 900);
        $scopes = is_array($body['scopes'] ?? null) ? $body['scopes'] : null;
        $result = $this->tokens->create($userId, $appId, $ttl, $idle, $scopes);
        $this->audit($request, 'mcp.token.create', $userId, ['appId' => $appId]);

        $uri = $request->getUri();
        $base = $uri->getScheme() . '://' . $uri->getHost() . ($uri->getPort() ? ':' . $uri->getPort() : '');
        $result['mcpUrl'] = $base . '/api/mcp';
        return $this->jsonResponse($response, $result, 201);
    }

    public function listTokens(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        $appId = $request->getQueryParams()['appId'] ?? null;
        return $this->jsonResponse($response, ['sessions' => $this->tokens->listActive($userId, is_string($appId) ? $appId : null)]);
    }

    public function revokeToken(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        $ok = $this->tokens->revoke($args['id'], $userId);
        if ($ok) {
            $this->audit($request, 'mcp.token.revoke', $userId, ['sessionId' => $args['id']]);
        }
        return $this->jsonResponse($response, ['success' => $ok]);
    }

    // ── MCP endpoint (token-authenticated, JSON-RPC over HTTP) ──

    public function handle(Request $request, Response $response): Response
    {
        $auth = $request->getHeaderLine('Authorization');
        $token = preg_match('/^Bearer\s+(.+)$/i', $auth, $m) ? trim($m[1]) : '';
        $session = $token !== '' ? $this->tokens->validate($token, $this->ip($request)) : null;
        if (!$session) {
            return $this->rpc($response, ['jsonrpc' => '2.0', 'id' => null, 'error' => ['code' => -32001, 'message' => 'Unauthorized: invalid or expired MCP token']], 401);
        }

        // Slim's body-parsing middleware already decoded the JSON body; fall back to the raw stream.
        $body = $request->getParsedBody();
        if (!is_array($body)) {
            $raw = (string) $request->getBody();
            $body = $raw !== '' ? json_decode($raw, true) : null;
        }
        if (!is_array($body)) {
            return $this->rpc($response, ['jsonrpc' => '2.0', 'id' => null, 'error' => ['code' => -32700, 'message' => 'Parse error']], 400);
        }

        // Batch (a list of messages) or a single message.
        if (array_is_list($body)) {
            if (count($body) > 20) {
                return $this->rpc($response, ['jsonrpc' => '2.0', 'id' => null, 'error' => ['code' => -32600, 'message' => 'Batch too large (max 20 messages)']], 400);
            }
            $out = [];
            foreach ($body as $msg) {
                $r = is_array($msg) ? $this->dispatch($msg, $session, $request) : null;
                if ($r !== null) {
                    $out[] = $r;
                }
            }
            return empty($out) ? $response->withStatus(202) : $this->rpc($response, $out);
        }

        $result = $this->dispatch($body, $session, $request);
        return $result === null ? $response->withStatus(202) : $this->rpc($response, $result);
    }

    /** Handle one JSON-RPC message. Returns the response array, or null for notifications. */
    private function dispatch(array $message, array $session, Request $request): ?array
    {
        $id = $message['id'] ?? null;
        $method = (string) ($message['method'] ?? '');
        $params = is_array($message['params'] ?? null) ? $message['params'] : [];

        if ($id === null) {
            return null; // notification (e.g. notifications/initialized) — no reply
        }

        switch ($method) {
            case 'initialize':
                return $this->ok($id, [
                    'protocolVersion' => self::PROTOCOL_VERSION,
                    'capabilities' => ['tools' => (object) []],
                    'serverInfo' => ['name' => 'FormLogic', 'version' => '1.0.0'],
                ]);
            case 'ping':
                return $this->ok($id, (object) []);
            case 'tools/list':
                return $this->ok($id, ['tools' => $this->toolDefs($session)]);
            case 'tools/call':
                return $this->ok($id, $this->callTool((string) ($params['name'] ?? ''), is_array($params['arguments'] ?? null) ? $params['arguments'] : [], $session, $request));
            default:
                return ['jsonrpc' => '2.0', 'id' => $id, 'error' => ['code' => -32601, 'message' => "Method not found: {$method}"]];
        }
    }

    private function ok($id, $result): array
    {
        return ['jsonrpc' => '2.0', 'id' => $id, 'result' => $result];
    }

    // Which scope each tool requires (a token without it can't see or call the tool).
    private const TOOL_SCOPES = [
        'list_forms' => 'forms:read', 'get_form' => 'forms:read',
        'create_form' => 'forms:write', 'update_form' => 'forms:write',
        'list_apps' => 'apps:read', 'create_app' => 'apps:write',
        'update_app' => 'apps:write', 'add_form_to_app' => 'apps:write',
        'set_app_home' => 'screens:write', 'list_responses' => 'responses:read',
    ];

    /** Execute a tool, scoped to the session owner + the token's scopes + (optional) app scope. */
    private function callTool(string $name, array $args, array $session, Request $request): array
    {
        $userId = $session['userId'];
        $scopedApp = $session['appId'] ?? null;
        try {
            $this->requireScope($session, self::TOOL_SCOPES[$name] ?? '__none__');
            switch ($name) {
                case 'list_forms':
                    if ($scopedApp !== null) {
                        $data = array_map(static fn ($f) => ['id' => $f['formId'], 'title' => $f['displayName'], 'status' => $f['formStatus'] ?? 'draft'], $this->appService->getAppForms($scopedApp));
                    } else {
                        $data = array_map(static fn ($f) => ['id' => $f['id'], 'title' => $f['title'], 'status' => $f['status'] ?? 'draft', 'fieldCount' => $f['fieldCount'] ?? count($f['fields'] ?? [])], $this->formService->getAllForms($userId));
                    }
                    break;
                case 'get_form':
                    $this->assertFormInScope($session, (string) ($args['formId'] ?? ''));
                    $data = $this->ownForm((string) ($args['formId'] ?? ''), $userId);
                    break;
                case 'create_form':
                    $this->validateFormInput($args);
                    $data = $this->formService->createForm(array_merge($this->formInput($args), ['userId' => $userId]));
                    // App-scoped token: auto-attach the new form to the scoped app so it's usable + stays in scope.
                    if ($scopedApp !== null && !empty($data['id'])) {
                        $this->appService->addFormToApp($scopedApp, (string) $data['id']);
                    }
                    $this->audit($request, 'mcp.create_form', $userId, ['formId' => $data['id'] ?? null, 'appId' => $scopedApp]);
                    break;
                case 'update_form':
                    $this->assertFormInScope($session, (string) ($args['formId'] ?? ''));
                    $this->ownForm((string) ($args['formId'] ?? ''), $userId);
                    $this->validateFormInput($args);
                    $data = $this->formService->updateForm((string) $args['formId'], $this->formInput($args));
                    $this->audit($request, 'mcp.update_form', $userId, ['formId' => $args['formId'] ?? null]);
                    break;
                case 'list_apps':
                    $apps = $this->appService->getAllApps($userId);
                    if ($scopedApp !== null) {
                        $apps = array_values(array_filter($apps, static fn ($a) => $a['id'] === $scopedApp));
                    }
                    $data = array_map(static fn ($a) => ['id' => $a['id'], 'name' => $a['name'], 'slug' => $a['slug'] ?? null, 'status' => $a['status'] ?? 'draft'], $apps);
                    break;
                case 'create_app':
                    if ($scopedApp !== null) {
                        throw new \Exception('This token is scoped to one app and cannot create new apps');
                    }
                    $data = $this->appService->createApp(['name' => (string) ($args['name'] ?? 'Untitled App'), 'description' => $args['description'] ?? null], $userId);
                    $this->audit($request, 'mcp.create_app', $userId, ['appId' => $data['id'] ?? null]);
                    break;
                case 'update_app':
                    $this->assertAppScope($session, (string) ($args['appId'] ?? ''));
                    $app = $this->ownApp((string) ($args['appId'] ?? ''), $userId);
                    $upd = [];
                    foreach (['name', 'description', 'status', 'slug'] as $k) {
                        if (array_key_exists($k, $args)) {
                            $upd[$k] = $args[$k];
                        }
                    }
                    if (array_key_exists('hideNav', $args)) {
                        $settings = is_array($app['settings'] ?? null) ? $app['settings'] : [];
                        $settings['hideNav'] = (bool) $args['hideNav'];
                        $upd['settings'] = $settings;
                    }
                    $data = $this->appService->updateApp((string) $args['appId'], $upd);
                    $this->audit($request, 'mcp.update_app', $userId, ['appId' => $args['appId'] ?? null]);
                    break;
                case 'add_form_to_app':
                    $this->assertAppScope($session, (string) ($args['appId'] ?? ''));
                    $this->ownApp((string) ($args['appId'] ?? ''), $userId);
                    $this->ownForm((string) ($args['formId'] ?? ''), $userId);
                    $data = $this->appService->addFormToApp((string) $args['appId'], (string) $args['formId'], $args['displayName'] ?? null);
                    $this->audit($request, 'mcp.add_form_to_app', $userId, ['appId' => $args['appId'] ?? null, 'formId' => $args['formId'] ?? null]);
                    break;
                case 'set_app_home':
                    $this->assertAppScope($session, (string) ($args['appId'] ?? ''));
                    $this->ownApp((string) ($args['appId'] ?? ''), $userId);
                    $cs = is_array($args['customScreen'] ?? null) ? $args['customScreen'] : [];
                    if (strlen((string) json_encode($cs)) > 524288) {
                        throw new \Exception('Custom screen exceeds the 512KB limit');
                    }
                    $data = $this->appService->updateApp((string) $args['appId'], ['customScreen' => $cs]);
                    $this->audit($request, 'mcp.set_app_home', $userId, ['appId' => $args['appId'] ?? null]);
                    break;
                case 'list_responses':
                    $this->assertFormInScope($session, (string) ($args['formId'] ?? ''));
                    $this->ownForm((string) ($args['formId'] ?? ''), $userId);
                    $data = $this->responseService->getFormResponses((string) $args['formId'], ['limit' => min(200, max(1, (int) ($args['limit'] ?? 50)))]);
                    break;
                default:
                    throw new \Exception("Unknown or unavailable tool: {$name}");
            }
            return ['content' => [['type' => 'text', 'text' => json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)]]];
        } catch (\Throwable $e) {
            return ['content' => [['type' => 'text', 'text' => 'Error: ' . $e->getMessage()]], 'isError' => true];
        }
    }

    private function requireScope(array $session, string $scope): void
    {
        if (!in_array($scope, $session['scopes'] ?? [], true)) {
            throw new \Exception("This MCP token lacks the required scope: {$scope}");
        }
    }

    /** If the token is app-scoped, the target app must match. */
    private function assertAppScope(array $session, string $appId): void
    {
        $scoped = $session['appId'] ?? null;
        if ($scoped !== null && $scoped !== $appId) {
            throw new \Exception('This MCP token is scoped to a single app and cannot touch other apps');
        }
    }

    /** If the token is app-scoped, the target form must belong to that app. */
    private function assertFormInScope(array $session, string $formId): void
    {
        $scoped = $session['appId'] ?? null;
        if ($scoped !== null && ($formId === '' || !$this->appService->formBelongsToApp($scoped, $formId))) {
            throw new \Exception('This MCP token is scoped to an app; that form is not part of it');
        }
    }

    /** Size caps for MCP-created/updated forms (MCP bypasses FormController, so enforce here). */
    private function validateFormInput(array $args): void
    {
        if (isset($args['logicScript']) && is_string($args['logicScript']) && strlen($args['logicScript']) > 102400) {
            throw new \Exception('logicScript exceeds the 100KB limit');
        }
        if (isset($args['fields']) && is_array($args['fields']) && strlen((string) json_encode($args['fields'])) > 512000) {
            throw new \Exception('fields exceed the 500KB limit');
        }
        if (isset($args['customScreen']) && is_array($args['customScreen']) && strlen((string) json_encode($args['customScreen'])) > 524288) {
            throw new \Exception('customScreen exceeds the 512KB limit');
        }
    }

    private function ownForm(string $formId, string $userId): array
    {
        $f = $formId !== '' ? $this->formService->getForm($formId) : null;
        if (!$f || ($f['userId'] ?? null) !== $userId) {
            throw new \Exception('Form not found or access denied');
        }
        return $f;
    }

    private function ownApp(string $appId, string $userId): array
    {
        $a = $appId !== '' ? $this->appService->getApp($appId) : null;
        if (!$a || ($a['ownerId'] ?? null) !== $userId) {
            throw new \Exception('App not found or access denied');
        }
        return $a;
    }

    /** Pick the writable form fields from tool args. */
    private function formInput(array $args): array
    {
        $out = [];
        foreach (['title', 'description', 'logicScript', 'status', 'icon'] as $k) {
            if (array_key_exists($k, $args)) {
                $out[$k] = $args[$k];
            }
        }
        if (array_key_exists('fields', $args) && is_array($args['fields'])) {
            $out['fields'] = $args['fields'];
        }
        if (array_key_exists('customScreen', $args) && is_array($args['customScreen'])) {
            $out['customScreen'] = $args['customScreen'];
        }
        return $out;
    }

    /** Tool definitions visible to a session — filtered by its scopes (and app-scope for create_app). */
    private function toolDefs(array $session): array
    {
        $field = ['type' => 'object', 'description' => 'A field: { id, type, label, required, properties? }'];
        $screen = ['type' => 'object', 'description' => 'Custom screen { enabled, html, css, js } — sandboxed UI over the form; talks to the backend via window.FormLogic (submit/records/currentUser/context/toast).'];
        $obj = static fn (array $props, array $req = []) => array_filter(['type' => 'object', 'properties' => $props, 'required' => $req], static fn ($v) => $v !== []);
        $scopes = $session['scopes'] ?? [];
        $scopedApp = $session['appId'] ?? null;
        $all = [
            ['name' => 'list_forms', 'scope' => 'forms:read', 'description' => "List the owner's forms (only this app's forms when the token is app-scoped).", 'inputSchema' => $obj([])],
            ['name' => 'get_form', 'scope' => 'forms:read', 'description' => 'Get one form (fields, logicScript, customScreen).', 'inputSchema' => $obj(['formId' => ['type' => 'string']], ['formId'])],
            ['name' => 'create_form', 'scope' => 'forms:write', 'description' => 'Create a form. Provide title and optional fields[], logicScript (QuickJS onSubmit), customScreen, status.', 'inputSchema' => $obj(['title' => ['type' => 'string'], 'description' => ['type' => 'string'], 'fields' => ['type' => 'array', 'items' => $field], 'logicScript' => ['type' => 'string'], 'customScreen' => $screen, 'status' => ['type' => 'string', 'enum' => ['draft', 'published']]], ['title'])],
            ['name' => 'update_form', 'scope' => 'forms:write', 'description' => 'Update a form (any of fields, logicScript, customScreen, title, status).', 'inputSchema' => $obj(['formId' => ['type' => 'string'], 'title' => ['type' => 'string'], 'fields' => ['type' => 'array', 'items' => $field], 'logicScript' => ['type' => 'string'], 'customScreen' => $screen, 'status' => ['type' => 'string']], ['formId'])],
            ['name' => 'list_apps', 'scope' => 'apps:read', 'description' => "List the owner's apps (only the scoped app when app-scoped).", 'inputSchema' => $obj([])],
            ['name' => 'create_app', 'scope' => 'apps:write', 'description' => 'Create an app (container for forms).', 'inputSchema' => $obj(['name' => ['type' => 'string'], 'description' => ['type' => 'string']], ['name'])],
            ['name' => 'update_app', 'scope' => 'apps:write', 'description' => 'Update an app: rename, set description, change the URL slug, publish (status: draft|published|archived), or hide the sidebar/menu (hideNav: true for a self-contained custom-home app).', 'inputSchema' => $obj(['appId' => ['type' => 'string'], 'name' => ['type' => 'string'], 'description' => ['type' => 'string'], 'slug' => ['type' => 'string', 'description' => 'URL slug: lowercase letters, digits, hyphens.'], 'status' => ['type' => 'string', 'enum' => ['draft', 'published', 'archived']], 'hideNav' => ['type' => 'boolean', 'description' => 'Render the app full-screen without the sidebar/menu.']], ['appId'])],
            ['name' => 'add_form_to_app', 'scope' => 'apps:write', 'description' => 'Attach a form to an app.', 'inputSchema' => $obj(['appId' => ['type' => 'string'], 'formId' => ['type' => 'string'], 'displayName' => ['type' => 'string']], ['appId', 'formId'])],
            ['name' => 'set_app_home', 'scope' => 'screens:write', 'description' => "Set the app's custom HOME screen (sandboxed UI; SDK spans the app's forms: submit(formId,answers)/records(formId)/navigate(formId)).", 'inputSchema' => $obj(['appId' => ['type' => 'string'], 'customScreen' => $screen], ['appId', 'customScreen'])],
            ['name' => 'list_responses', 'scope' => 'responses:read', 'description' => "List a form's responses.", 'inputSchema' => $obj(['formId' => ['type' => 'string'], 'limit' => ['type' => 'number']], ['formId'])],
        ];
        $out = [];
        foreach ($all as $t) {
            if (!in_array($t['scope'], $scopes, true)) {
                continue;
            }
            if ($t['name'] === 'create_app' && $scopedApp !== null) {
                continue; // app-scoped tokens can't create new apps
            }
            unset($t['scope']);
            $out[] = $t;
        }
        return $out;
    }

    private function rpc(Response $response, array $payload, int $status = 200): Response
    {
        $response->getBody()->write(json_encode($payload));
        return $response->withStatus($status)->withHeader('Content-Type', 'application/json');
    }

    private function ip(Request $request): ?string
    {
        $sp = $request->getServerParams();
        return $sp['REMOTE_ADDR'] ?? null;
    }

    private function audit(Request $request, string $action, ?string $userId = null, array $details = []): void
    {
        try {
            // /api/mcp self-authenticates (no AuthMiddleware), so pass the session's userId explicitly.
            $this->auditService?->log($action, 'mcp', $details['appId'] ?? $details['formId'] ?? null, $userId ?? $request->getAttribute('userId'), $this->ip($request), $details);
        } catch (\Throwable) { /* audit is best-effort */ }
    }
}

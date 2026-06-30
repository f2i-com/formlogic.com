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
        $ttl = (int) ($body['ttl'] ?? 86400);
        $idle = (int) ($body['idle'] ?? 1800);
        $result = $this->tokens->create($userId, $appId, $ttl, $idle);
        $this->audit($request, 'mcp.token.create');

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
            $this->audit($request, 'mcp.token.revoke');
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
                return $this->ok($id, ['tools' => $this->toolDefs()]);
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

    /** Execute a tool, scoped to the session owner. Returns an MCP tools/call result. */
    private function callTool(string $name, array $args, array $session, Request $request): array
    {
        $userId = $session['userId'];
        try {
            switch ($name) {
                case 'list_forms':
                    $data = array_map(static fn ($f) => [
                        'id' => $f['id'], 'title' => $f['title'], 'status' => $f['status'] ?? 'draft',
                        'fieldCount' => $f['fieldCount'] ?? count($f['fields'] ?? []),
                    ], $this->formService->getAllForms($userId));
                    break;
                case 'get_form':
                    $data = $this->ownForm((string) ($args['formId'] ?? ''), $userId);
                    break;
                case 'create_form':
                    $data = $this->formService->createForm(array_merge($this->formInput($args), ['userId' => $userId]));
                    $this->audit($request, 'mcp.create_form');
                    break;
                case 'update_form':
                    $this->ownForm((string) ($args['formId'] ?? ''), $userId);
                    $data = $this->formService->updateForm((string) $args['formId'], $this->formInput($args));
                    $this->audit($request, 'mcp.update_form');
                    break;
                case 'list_apps':
                    $data = array_map(static fn ($a) => [
                        'id' => $a['id'], 'name' => $a['name'], 'slug' => $a['slug'] ?? null, 'status' => $a['status'] ?? 'draft',
                    ], $this->appService->getAllApps($userId));
                    break;
                case 'create_app':
                    $data = $this->appService->createApp(['name' => (string) ($args['name'] ?? 'Untitled App'), 'description' => $args['description'] ?? null], $userId);
                    $this->audit($request, 'mcp.create_app');
                    break;
                case 'add_form_to_app':
                    $this->ownApp((string) ($args['appId'] ?? ''), $userId);
                    $this->ownForm((string) ($args['formId'] ?? ''), $userId);
                    $data = $this->appService->addFormToApp((string) $args['appId'], (string) $args['formId'], $args['displayName'] ?? null);
                    $this->audit($request, 'mcp.add_form_to_app');
                    break;
                case 'set_app_home':
                    $this->ownApp((string) ($args['appId'] ?? ''), $userId);
                    $data = $this->appService->updateApp((string) $args['appId'], ['customScreen' => is_array($args['customScreen'] ?? null) ? $args['customScreen'] : []]);
                    $this->audit($request, 'mcp.set_app_home');
                    break;
                case 'list_responses':
                    $this->ownForm((string) ($args['formId'] ?? ''), $userId);
                    $data = $this->responseService->getFormResponses((string) $args['formId'], ['limit' => min(200, max(1, (int) ($args['limit'] ?? 50)))]);
                    break;
                case 'add_response':
                    $form = $this->ownForm((string) ($args['formId'] ?? ''), $userId);
                    $r = $this->responseService->createResponse((string) $args['formId'], is_array($args['answers'] ?? null) ? $args['answers'] : [], $form['logicScript'] ?? null);
                    $data = is_array($r) ? $r : ['rejected' => true, 'reason' => method_exists($r, 'getMessage') ? $r->getMessage() : 'Rejected by onSubmit script'];
                    break;
                default:
                    throw new \Exception("Unknown tool: {$name}");
            }
            return ['content' => [['type' => 'text', 'text' => json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)]]];
        } catch (\Throwable $e) {
            return ['content' => [['type' => 'text', 'text' => 'Error: ' . $e->getMessage()]], 'isError' => true];
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

    private function toolDefs(): array
    {
        $field = ['type' => 'object', 'description' => 'A field: { id, type, label, required, properties? }'];
        $screen = ['type' => 'object', 'description' => 'Custom screen { enabled, html, css, js } — sandboxed UI over the form; talks to the backend via window.FormLogic (submit/records/currentUser/context/toast).'];
        $obj = static fn (array $props, array $req = []) => array_filter(['type' => 'object', 'properties' => $props, 'required' => $req], static fn ($v) => $v !== []);
        return [
            ['name' => 'list_forms', 'description' => "List the owner's forms.", 'inputSchema' => $obj([])],
            ['name' => 'get_form', 'description' => 'Get one form (fields, logicScript, customScreen).', 'inputSchema' => $obj(['formId' => ['type' => 'string']], ['formId'])],
            ['name' => 'create_form', 'description' => 'Create a form. Provide title and optional fields[], logicScript (QuickJS onSubmit), customScreen, status.', 'inputSchema' => $obj(['title' => ['type' => 'string'], 'description' => ['type' => 'string'], 'fields' => ['type' => 'array', 'items' => $field], 'logicScript' => ['type' => 'string'], 'customScreen' => $screen, 'status' => ['type' => 'string', 'enum' => ['draft', 'published']]], ['title'])],
            ['name' => 'update_form', 'description' => 'Update a form (any of fields, logicScript, customScreen, title, status).', 'inputSchema' => $obj(['formId' => ['type' => 'string'], 'title' => ['type' => 'string'], 'fields' => ['type' => 'array', 'items' => $field], 'logicScript' => ['type' => 'string'], 'customScreen' => $screen, 'status' => ['type' => 'string']], ['formId'])],
            ['name' => 'list_apps', 'description' => "List the owner's apps.", 'inputSchema' => $obj([])],
            ['name' => 'create_app', 'description' => 'Create an app (container for forms).', 'inputSchema' => $obj(['name' => ['type' => 'string'], 'description' => ['type' => 'string']], ['name'])],
            ['name' => 'add_form_to_app', 'description' => 'Attach a form to an app.', 'inputSchema' => $obj(['appId' => ['type' => 'string'], 'formId' => ['type' => 'string'], 'displayName' => ['type' => 'string']], ['appId', 'formId'])],
            ['name' => 'set_app_home', 'description' => "Set the app's custom HOME screen (sandboxed UI; SDK spans the app's forms: submit(formId,answers)/records(formId)/navigate(formId)).", 'inputSchema' => $obj(['appId' => ['type' => 'string'], 'customScreen' => $screen], ['appId', 'customScreen'])],
            ['name' => 'list_responses', 'description' => "List a form's responses.", 'inputSchema' => $obj(['formId' => ['type' => 'string'], 'limit' => ['type' => 'number']], ['formId'])],
            ['name' => 'add_response', 'description' => 'Submit a response to a form (runs its onSubmit script).', 'inputSchema' => $obj(['formId' => ['type' => 'string'], 'answers' => ['type' => 'object']], ['formId', 'answers'])],
        ];
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

    private function audit(Request $request, string $action): void
    {
        try {
            $this->auditService?->log($action, 'mcp', null, $request->getAttribute('userId'), $this->ip($request));
        } catch (\Throwable) { /* audit is best-effort */ }
    }
}

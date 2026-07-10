<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\McpOAuthService;
use FormLogic\Services\McpTokenService;
use FormLogic\Services\FormService;
use FormLogic\Services\AppService;
use FormLogic\Services\AppReportService;
use FormLogic\Services\ResponseService;
use FormLogic\Services\AuditService;
use FormLogic\Services\RateLimiter;
use FormLogic\Services\PlanService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Log\LoggerInterface;

/**
 * Thrown when an MCP tool call is denied by a scope or ownership check (requireScope, assertAppScope,
 * assertFormInScope, ownApp, ownForm) — as opposed to an ordinary input-validation \Exception. Carries
 * a short, stable machine-readable reason code alongside the human message so callTool()'s catch site
 * can audit denials (queryable trail for a probing/misbehaving token) without parsing message text.
 * The message shown to the MCP caller is unchanged either way — this is purely additive server-side.
 */
class McpDeniedException extends \Exception
{
    public function __construct(string $message, private readonly string $reasonCode, ?\Throwable $previous = null)
    {
        parent::__construct($message, 0, $previous);
    }

    public function getReasonCode(): string
    {
        return $this->reasonCode;
    }
}

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
        private ?AppReportService $reportValidator = null,
        private ?\FormLogic\Services\DesktopCommandService $desktopCommands = null,
        private ?RateLimiter $rateLimiter = null,
        // Overridable only by tests, to prove the shared batch-deadline cap (below) engages without a
        // real ~25s sleep. Production never passes this — it always falls back to the real ceiling.
        private ?int $connectorBatchCeilingMs = null,
        // Same form-count quota FormController::checkFormQuota enforces on the web create path — MCP
        // calls FormService directly and would otherwise bypass it. Null (self-hosted default, plan
        // enforcement off) makes every check below a no-op, exactly like FormController's.
        private ?PlanService $planService = null,
    ) {}

    // ── Token management (authenticated app owner) ──

    public function createToken(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        $body = $request->getParsedBody() ?? [];
        // A "creator" token lets the AI make a NEW app (confined to what it creates) — no placeholder app.
        $creator = ($body['creator'] ?? false) === true;
        $appId = (!$creator && is_string($body['appId'] ?? null)) ? $body['appId'] : null;
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

        // The shared public Demo account is read-only: an external AI may explore its apps, forms and
        // data, but must not be able to change the shared account. Force read-only scopes (write tools
        // then don't exist for the token) and disable creator mode.
        $readOnly = $this->isDemoRequest($request);
        if ($readOnly) {
            $creator = false;
            $scopes = ['apps:read', 'forms:read', 'responses:read'];
        }
        // Opt-in: also let the AI drive the owner's FormLogic Desktop connectors (e.g. the Aokie
        // phone) via connector_command. Never for the shared demo. Appended to the builder scopes.
        if (!$readOnly && ($body['connectorAccess'] ?? false) === true) {
            $scopes = array_values(array_unique(array_merge($scopes ?? \FormLogic\Services\McpTokenService::DEFAULT_SCOPES, ['connector:command'])));
        }

        $result = $this->tokens->create($userId, $appId, $ttl, $idle, $scopes, $creator);
        $result['readOnly'] = $readOnly;
        $this->audit($request, 'mcp.token.create', $userId, ['appId' => $appId, 'creator' => $creator, 'readOnly' => $readOnly]);

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
        // Audience binding (RFC 8707): an OAuth-minted token stores the resource it was issued for;
        // reject it on any other host so a token for server A can never replay against server B.
        if ($session !== null && is_string($session['resource'] ?? null) && $session['resource'] !== ''
            && !McpOAuthService::resourceMatchesRequest($session['resource'], $request)) {
            $session = null;
        }
        if (!$session) {
            // EVERY 401 (missing, malformed, expired, revoked, wrong audience) carries the RFC 9728
            // WWW-Authenticate challenge — it is what triggers OAuth discovery in MCP clients
            // (Claude/ChatGPT ignore the header on 200s; the 401 is the discovery moment).
            return $this->rpc($response, ['jsonrpc' => '2.0', 'id' => null, 'error' => ['code' => -32001, 'message' => 'Unauthorized: invalid or expired MCP token']], 401)
                ->withHeader('WWW-Authenticate', McpOAuthService::wwwAuthenticateHeader($request));
        }

        // The route-level $mcpRateLimiter (public/index.php) is IP-keyed — /api/mcp self-authenticates
        // with no earlier session middleware, so its keyByUser would silently do nothing anyway. Now
        // that the token is validated and we have a real userId, apply a SEPARATE, correctly per-account
        // budget (same 120-per-60s ceiling) so rotating source IPs can't bypass it. This must reject
        // BEFORE any expensive work — outside callTool()'s try/catch, so a plain JSON-RPC error, not a
        // thrown \Exception.
        if ($this->rateLimiter !== null) {
            $hits = $this->rateLimiter->hit('mcp_request:u:' . hash('sha256', $session['userId']), 60);
            if ($hits > 120) {
                return $this->rpc($response, ['jsonrpc' => '2.0', 'id' => null, 'error' => ['code' => -32000, 'message' => 'Too many MCP requests — please slow down (max 120 per minute).']], 429);
            }
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

        // One shared wall-clock budget for every connector_command call in THIS request (batch or
        // not): 'deadline' is the same ceiling a single call is already allowed today, and 'seen'
        // counts connector_command calls as they're dispatched. The first one is never clamped by it
        // (so a solo call — the overwhelmingly common case — behaves exactly as before); only the 2nd+
        // connector_command call in the SAME batch has its wait clamped to whatever remains, so N
        // batched calls can't each independently block the worker for up to 25s (an N×25s DoS) — see
        // the connector_command case in callTool().
        $connectorBudget = ['deadline' => microtime(true) + $this->connectorCommandBatchCeilingMs() / 1000, 'seen' => 0];

        // Batch (a list of messages) or a single message.
        if (array_is_list($body)) {
            if (count($body) > 20) {
                return $this->rpc($response, ['jsonrpc' => '2.0', 'id' => null, 'error' => ['code' => -32600, 'message' => 'Batch too large (max 20 messages)']], 400);
            }
            $out = [];
            foreach ($body as $msg) {
                // $session is passed by reference so a create_app/create_form earlier in the batch is
                // visible to a dependent call later in the same batch (creator tokens).
                $r = is_array($msg) ? $this->dispatch($msg, $session, $request, $connectorBudget) : null;
                if ($r !== null) {
                    $out[] = $r;
                }
            }
            return empty($out) ? $response->withStatus(202) : $this->rpc($response, $out);
        }

        $result = $this->dispatch($body, $session, $request, $connectorBudget);
        return $result === null ? $response->withStatus(202) : $this->rpc($response, $result);
    }

    /** The single-call ceiling (ms), also reused as the whole batch's shared connector_command budget
     *  (see $connectorBudget in handle()). Tests may override via the constructor to prove the cap
     *  engages without a real ~25s sleep; production always uses CONNECTOR_COMMAND_MAX_WAIT_MS. */
    private function connectorCommandBatchCeilingMs(): int
    {
        return $this->connectorBatchCeilingMs ?? self::CONNECTOR_COMMAND_MAX_WAIT_MS;
    }

    /** Handle one JSON-RPC message. Returns the response array, or null for notifications. */
    private function dispatch(array $message, array &$session, Request $request, array &$connectorBudget): ?array
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
                    // Surfaced to the model by MCP clients — lets an AI build with zero prior knowledge.
                    'instructions' => $this->serverInstructions(),
                ]);
            case 'ping':
                return $this->ok($id, (object) []);
            case 'tools/list':
                return $this->ok($id, ['tools' => $this->toolDefs($session)]);
            case 'tools/call':
                return $this->ok($id, $this->callTool((string) ($params['name'] ?? ''), is_array($params['arguments'] ?? null) ? $params['arguments'] : [], $session, $request, $connectorBudget));
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
        'create_form' => 'forms:write', 'update_form' => 'forms:write', 'create_app_form' => 'forms:write',
        'list_apps' => 'apps:read', 'create_app' => 'apps:write',
        'update_app' => 'apps:write', 'add_form_to_app' => 'apps:write',
        'create_report' => 'apps:write', 'create_document' => 'apps:write',
        'set_app_home' => 'screens:write', 'list_responses' => 'responses:read',
        'connector_command' => 'connector:command', 'desktop_status' => 'connector:command',
    ];

    /** A desktop is "online" if its connector:relay key was used within this window (it long-polls ≤25s). */
    private const DESKTOP_ONLINE_WINDOW = 90;

    /** Max ms a single connector_command call may block waiting for the desktop — also reused as the
     *  shared ceiling the whole batch's connector_command calls collectively cannot exceed. */
    private const CONNECTOR_COMMAND_MAX_WAIT_MS = 25000;

    /** Execute a tool, scoped to the session owner + the token's scopes + (optional) app scope. */
    private function callTool(string $name, array $args, array &$session, Request $request, array &$connectorBudget): array
    {
        $userId = $session['userId'];
        $scopedApp = $session['appId'] ?? null;
        $creatorMode = is_array($session['created'] ?? null); // a "creator" token: confined to what it makes
        try {
            if ($name === 'get_started') {
                return ['content' => [['type' => 'text', 'text' => $this->guide()]]];
            }
            $this->requireScope($session, self::TOOL_SCOPES[$name] ?? '__none__');
            // Cloud entitlement (audit FL-003/C-10): mutating tools require an ACTIVE
            // cloud account, the SAME policy as every web/API write path — the count
            // quota alone let a lapsed account keep building through MCP. Read tools
            // stay available (mirrors CloudWriteGate's read/export/delete allowance).
            $toolScope = self::TOOL_SCOPES[$name] ?? '';
            if (
                (str_ends_with($toolScope, ':write') || $toolScope === 'connector:command')
                && $this->planService !== null
                && $this->planService->isEnforced()
                && !$this->planService->isCloudActive($userId)
            ) {
                throw new McpDeniedException('Cloud access for this account has lapsed — renew to make changes', 'cloud_lapsed');
            }
            switch ($name) {
                case 'list_forms':
                    if ($scopedApp !== null) {
                        $data = array_map(static fn ($f) => ['id' => $f['formId'], 'title' => $f['displayName'], 'status' => $f['formStatus'] ?? 'draft'], $this->appService->getAppForms($scopedApp));
                    } else {
                        $forms = $this->formService->getAllForms($userId);
                        if ($creatorMode) {
                            $allowed = $this->creatorFormIds($session);
                            $forms = array_values(array_filter($forms, static fn ($f) => isset($allowed[$f['id']])));
                        }
                        $data = array_map(static fn ($f) => ['id' => $f['id'], 'title' => $f['title'], 'status' => $f['status'] ?? 'draft', 'fieldCount' => $f['fieldCount'] ?? count($f['fields'] ?? [])], $forms);
                    }
                    break;
                case 'get_form':
                    $this->assertFormInScope($session, (string) ($args['formId'] ?? ''));
                    $data = $this->ownForm((string) ($args['formId'] ?? ''), $userId);
                    break;
                case 'create_form':
                    $this->checkFormQuota($userId);
                    $this->validateFormInput($args);
                    $data = $this->createFormSanitized($args, $userId);
                    // App-scoped token: auto-attach the new form to the scoped app so it's usable + stays in scope.
                    if ($scopedApp !== null && !empty($data['id'])) {
                        $this->appService->addFormToApp($scopedApp, (string) $data['id']);
                    }
                    // Creator token: remember the form so the token can keep editing it (and attach it later).
                    if ($creatorMode && !empty($data['id'])) {
                        $session['created']['forms'][] = (string) $data['id'];
                        $this->tokens->recordCreated((string) $session['id'], 'forms', (string) $data['id']);
                    }
                    $this->audit($request, 'mcp.create_form', $userId, ['formId' => $data['id'] ?? null, 'appId' => $scopedApp]);
                    break;
                case 'create_app_form': {
                    // Create a form AND attach it to an app in one call (preferred for app building).
                    $target = (string) ($args['appId'] ?? '');
                    if ($target === '' && $scopedApp !== null) {
                        $target = $scopedApp;
                    }
                    if ($target === '' && $creatorMode && count($session['created']['apps'] ?? []) === 1) {
                        $target = (string) $session['created']['apps'][0];
                    }
                    $this->requireScope($session, 'apps:write');
                    $this->assertAppScope($session, $target);
                    $this->ownApp($target, $userId);
                    $this->checkFormQuota($userId);
                    $this->validateFormInput($args);
                    $form = $this->createFormSanitized($args, $userId);
                    $this->appService->addFormToApp($target, (string) $form['id'], $args['displayName'] ?? null);
                    if ($creatorMode && !empty($form['id'])) {
                        $session['created']['forms'][] = (string) $form['id'];
                        $this->tokens->recordCreated((string) $session['id'], 'forms', (string) $form['id']);
                    }
                    $data = ['form' => $form, 'appId' => $target];
                    $this->audit($request, 'mcp.create_app_form', $userId, ['formId' => $form['id'] ?? null, 'appId' => $target]);
                    break;
                }
                case 'update_form':
                    $this->assertFormInScope($session, (string) ($args['formId'] ?? ''));
                    $this->ownForm((string) ($args['formId'] ?? ''), $userId);
                    $this->validateFormInput($args);
                    $input = $this->formInput($args);
                    if (is_array($input['customScreen'] ?? null)) {
                        $input['customScreen'] = $this->sanitizeSectionScreen($input['customScreen'], (string) $args['formId']);
                    }
                    $data = $this->formService->updateForm((string) $args['formId'], $input);
                    $this->audit($request, 'mcp.update_form', $userId, ['formId' => $args['formId'] ?? null]);
                    break;
                case 'list_apps':
                    $apps = $this->appService->getAllApps($userId);
                    if ($scopedApp !== null) {
                        $apps = array_values(array_filter($apps, static fn ($a) => $a['id'] === $scopedApp));
                    } elseif ($creatorMode) {
                        $mine = $session['created']['apps'] ?? [];
                        $apps = array_values(array_filter($apps, static fn ($a) => in_array($a['id'], $mine, true)));
                    }
                    $data = array_map(static fn ($a) => ['id' => $a['id'], 'name' => $a['name'], 'slug' => $a['slug'] ?? null, 'status' => $a['status'] ?? 'draft'], $apps);
                    break;
                case 'create_app':
                    if ($scopedApp !== null) {
                        throw new \Exception('This token is scoped to one app and cannot create new apps');
                    }
                    $input = ['name' => (string) ($args['name'] ?? 'Untitled App'), 'description' => $args['description'] ?? null];
                    // Optional settings.appKind audience tag. The service would silently drop an invalid
                    // value; over MCP a clear error is more useful to the AI, so validate here.
                    if (isset($args['appKind'])) {
                        if (!is_string($args['appKind']) || !in_array($args['appKind'], AppService::APP_KINDS, true)) {
                            throw new \Exception('appKind must be one of: ' . implode(', ', AppService::APP_KINDS));
                        }
                        $input['appKind'] = $args['appKind'];
                    }
                    $data = $this->appService->createApp($input, $userId);
                    // Creator token: confine future access to this newly-created app.
                    if ($creatorMode && !empty($data['id'])) {
                        $session['created']['apps'][] = (string) $data['id'];
                        $this->tokens->recordCreated((string) $session['id'], 'apps', (string) $data['id']);
                    }
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
                    if (array_key_exists('customLogic', $args) && is_array($args['customLogic'])) {
                        $bundle = \FormLogic\Helpers\CustomLogicSanitizer::sanitize($args['customLogic']);
                        if (!\FormLogic\Helpers\CustomLogicSanitizer::withinSizeCap($bundle)) {
                            throw new \Exception('customLogic exceeds the 100KB limit');
                        }
                        $upd['customLogic'] = $bundle;
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
                    $this->validateCustomScreen($cs);
                    // A widget dashboard is data, not code — sanitize its specs against this app so no
                    // widget can query a form/field outside it (the same save boundary as the UI's
                    // AppController::update path).
                    if (($cs['kind'] ?? '') === 'dashboard' && is_array($cs['dashboard'] ?? null) && $this->reportValidator !== null) {
                        $cs['dashboard'] = $this->reportValidator->sanitizeDashboardForApp($cs['dashboard'], (string) $args['appId']);
                    }
                    $data = $this->appService->updateApp((string) $args['appId'], ['customScreen' => $cs]);
                    $this->audit($request, 'mcp.set_app_home', $userId, ['appId' => $args['appId'] ?? null]);
                    break;
                case 'create_report': {
                    // Add a chart report to the app's Reports section. Spec uses REAL form ids.
                    $appId = (string) ($args['appId'] ?? '');
                    $this->assertAppScope($session, $appId);
                    $app = $this->ownApp($appId, $userId);
                    $spec = is_array($args['spec'] ?? null) ? $args['spec'] : [];
                    if (empty($spec['formId']) || !is_string($spec['formId'])) {
                        throw new \Exception('spec.formId is required (a form id in this app)');
                    }
                    if (!in_array($spec['viz'] ?? 'bar', ['table', 'bar', 'line', 'area', 'pie', 'donut', 'kpi'], true)) {
                        throw new \Exception('spec.viz must be one of: table, bar, line, area, pie, donut, kpi');
                    }
                    // Validate the spec against the app: base form must belong to it; joins/field-refs are
                    // checked + sanitized (foreign form / bad field refs are rejected, not stored).
                    if ($this->reportValidator !== null) {
                        $v = $this->reportValidator->validateChartSpec($spec, $appId);
                        if (!$v['ok']) { throw new \Exception($v['error'] ?? 'Invalid report spec'); }
                        $spec = $v['spec'];
                    }
                    $item = ['id' => 'rep_' . bin2hex(random_bytes(6)), 'name' => (string) ($args['name'] ?? 'Report'), 'type' => 'builder', 'spec' => $spec];
                    if (!empty($args['description'])) { $item['description'] = (string) $args['description']; }
                    $reports = is_array($app['reports'] ?? null) ? $app['reports'] : [];
                    $reports[] = $item;
                    if (strlen((string) json_encode($reports)) > 262144) { throw new \Exception('Reports exceed the 256KB limit'); }
                    $this->appService->updateApp($appId, ['reports' => $reports]);
                    $data = $item;
                    $this->audit($request, 'mcp.create_report', $userId, ['appId' => $appId, 'reportId' => $item['id']]);
                    break;
                }
                case 'create_document': {
                    // Add a PDF document (text + chart blocks referencing existing reports) to the app.
                    $appId = (string) ($args['appId'] ?? '');
                    $this->assertAppScope($session, $appId);
                    $app = $this->ownApp($appId, $userId);
                    $reports = is_array($app['reports'] ?? null) ? $app['reports'] : [];
                    $existingIds = [];
                    foreach ($reports as $r) { if (!empty($r['id'])) { $existingIds[(string) $r['id']] = true; } }
                    $blocks = [];
                    foreach ((is_array($args['blocks'] ?? null) ? $args['blocks'] : []) as $b) {
                        $kind = $b['kind'] ?? '';
                        if ($kind === 'text') {
                            $blocks[] = ['id' => 'blk_' . bin2hex(random_bytes(5)), 'kind' => 'text', 'title' => $b['title'] ?? null, 'body' => (string) ($b['body'] ?? '')];
                        } elseif ($kind === 'report') {
                            $rid = (string) ($b['reportId'] ?? '');
                            if (!isset($existingIds[$rid])) { throw new \Exception("Document references unknown reportId '{$rid}' — create the chart report first"); }
                            $blocks[] = ['id' => 'blk_' . bin2hex(random_bytes(5)), 'kind' => 'report', 'reportId' => $rid, 'caption' => $b['caption'] ?? null];
                        }
                    }
                    if (!$blocks) { throw new \Exception('A document needs at least one block (text or report)'); }
                    $item = ['id' => 'doc_' . bin2hex(random_bytes(6)), 'name' => (string) ($args['name'] ?? 'Document'), 'type' => 'document', 'blocks' => $blocks];
                    if (!empty($args['description'])) { $item['description'] = (string) $args['description']; }
                    $reports[] = $item;
                    // Defense-in-depth: sanitize the whole set against the app (drops broken refs, clamps text).
                    if ($this->reportValidator !== null) {
                        $reports = $this->reportValidator->sanitizeReports($reports, $appId);
                    }
                    if (strlen((string) json_encode($reports)) > 262144) { throw new \Exception('Reports exceed the 256KB limit'); }
                    $this->appService->updateApp($appId, ['reports' => $reports]);
                    $data = $item;
                    $this->audit($request, 'mcp.create_document', $userId, ['appId' => $appId, 'documentId' => $item['id']]);
                    break;
                }
                case 'list_responses':
                    $this->assertFormInScope($session, (string) ($args['formId'] ?? ''));
                    $this->ownForm((string) ($args['formId'] ?? ''), $userId);
                    $data = $this->responseService->getFormResponses((string) $args['formId'], ['limit' => min(200, max(1, (int) ($args['limit'] ?? 50)))]);
                    break;
                case 'desktop_status': {
                    if ($this->desktopCommands === null) {
                        throw new \Exception('Connector relay is not available on this server.');
                    }
                    $seen = $this->desktopCommands->ownerDesktopLastSeenSeconds($userId);
                    $online = $seen !== null && $seen <= self::DESKTOP_ONLINE_WINDOW;
                    $data = [
                        'online' => $online,
                        'lastSeenSecondsAgo' => $seen,
                        'note' => $online
                            ? 'FormLogic Desktop is linked and polling — connector_command will reach it.'
                            : ($seen === null
                                ? 'No linked FormLogic Desktop has polled the relay — start it and link with the connector:relay scope.'
                                : "The linked desktop was last seen {$seen}s ago and looks offline — start FormLogic Desktop, then retry."),
                    ];
                    break;
                }
                case 'connector_command': {
                    if ($this->desktopCommands === null) {
                        throw new \Exception('Connector relay is not available on this server.');
                    }
                    // The web enqueue path (POST /api/app/{slug}/connector-commands) is gated by a
                    // 30-per-60s-per-user RateLimitMiddleware; this MCP tool calls DesktopCommandService
                    // directly and would otherwise bypass it entirely. Apply the SAME budget here, keyed
                    // the same way (keyPrefix 'connector_relay', per-user) so an MCP client can't issue
                    // connector commands any faster than a web client could.
                    if ($this->rateLimiter !== null) {
                        $hits = $this->rateLimiter->hit('connector_relay:u:' . hash('sha256', $userId), 60);
                        if ($hits > 30) {
                            throw new \Exception('Too many connector commands — please slow down (max 30 per minute).');
                        }
                    }
                    $connectorId = trim((string) ($args['connectorId'] ?? ''));
                    $command = trim((string) ($args['command'] ?? ''));
                    if ($connectorId === '' || $command === '') {
                        throw new \Exception('connectorId and command are required.');
                    }
                    $payload = is_array($args['payload'] ?? null) ? $args['payload'] : null;
                    $waitMs = max(0, min(self::CONNECTOR_COMMAND_MAX_WAIT_MS, (int) ($args['waitMs'] ?? 15000)));
                    // Presence: if no desktop has polled the relay recently, don't block the full timeout
                    // for one that isn't there — still enqueue + give a short grace in case it's just
                    // coming online.
                    $seen = $this->desktopCommands->ownerDesktopLastSeenSeconds($userId);
                    $online = $seen !== null && $seen <= self::DESKTOP_ONLINE_WINDOW;
                    // Enqueue for the token owner's desktop runtime; the desktop (its connector:relay
                    // key) claims + executes it exactly-once and completes the result back.
                    $enq = $this->desktopCommands->enqueue($userId, $userId, $scopedApp, [
                        'connectorId' => $connectorId,
                        'command' => $command,
                        'payload' => $payload,
                    ]);
                    $cmdId = (string) ($enq['command']['commandId'] ?? '');
                    $this->audit($request, 'mcp.connector_command', $userId, ['connectorId' => $connectorId, 'command' => $command, 'commandId' => $cmdId, 'desktopOnline' => $online]);
                    // Poll for the desktop to claim + complete (a live desktop finishes in a couple of
                    // seconds); an offline desktop gets a short grace only.
                    $row = $enq['command'];
                    $effectiveWaitMs = $online ? $waitMs : min($waitMs, 3000);
                    // Batch DoS guard: the FIRST connector_command call dispatched in this request gets
                    // its full, independent wait — identical to today. Only the 2nd+ connector_command
                    // call in the SAME batch is clamped to whatever remains of the one shared ceiling
                    // (never negative), so it returns immediately with today's "still pending" shape
                    // once the ceiling is spent, instead of blocking for its own fresh timeout.
                    $connectorBudget['seen']++;
                    if ($connectorBudget['seen'] > 1) {
                        $remainingMs = (int) round(($connectorBudget['deadline'] - microtime(true)) * 1000);
                        $effectiveWaitMs = max(0, min($effectiveWaitMs, $remainingMs));
                    }
                    $deadline = microtime(true) + $effectiveWaitMs / 1000;
                    while (microtime(true) < $deadline && in_array($row['status'] ?? 'pending', ['pending', 'claimed'], true)) {
                        usleep(400000);
                        $row = $this->desktopCommands->get($cmdId, $userId) ?? $row;
                    }
                    $data = [
                        'commandId' => $cmdId,
                        'status' => $row['status'] ?? 'pending',
                        'result' => $row['result'] ?? null,
                        'error' => $row['error'] ?? null,
                        'desktopOnline' => $online,
                    ];
                    if (in_array($data['status'], ['pending', 'claimed'], true)) {
                        $data['note'] = $online
                            ? 'Queued; the desktop is online but has not finished it yet — retry shortly.'
                            : 'No FormLogic Desktop appears to be online (nothing has polled the relay recently). Start FormLogic Desktop and link it (connector:relay), then retry — call desktop_status to check.';
                    }
                    break;
                }
                default:
                    throw new \Exception("Unknown or unavailable tool: {$name}");
            }
            return ['content' => [['type' => 'text', 'text' => json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)]]];
        } catch (McpDeniedException $e) {
            // A scope/ownership denial (as opposed to ordinary validation noise below) — always audited
            // so a token probing outside its scope, or repeatedly failing, leaves a queryable trail.
            // Must be caught before the plain \Exception branch (McpDeniedException extends it).
            $this->audit($request, 'mcp.denied', $userId, ['tool' => $name, 'reason' => $e->getReasonCode()]);
            return ['content' => [['type' => 'text', 'text' => 'Error: ' . $e->getMessage()]], 'isError' => true];
        } catch (\Exception $e) {
            // Every intentional throw in this file is a plain \Exception with a deliberately
            // user-safe message — that's the convention for "safe to show the MCP caller".
            return ['content' => [['type' => 'text', 'text' => 'Error: ' . $e->getMessage()]], 'isError' => true];
        } catch (\Throwable $e) {
            // Anything else (TypeError, PDOException, etc.) was never crafted to be user-facing and
            // may carry internals (SQL fragments, file paths) — log it, don't echo it to the client.
            $this->logger?->error('MCP tool call failed unexpectedly', ['tool' => $name, 'error' => $e->getMessage()]);
            // mb_substr (not substr): a byte-cut multibyte message would be invalid UTF-8, which makes
            // json_encode() in AuditService::log() return false -> the whole details blob (incl. 'tool') is lost.
            $this->audit($request, 'mcp.tool_error', $userId, ['tool' => $name, 'message' => mb_substr($e->getMessage(), 0, 200)]);
            return ['content' => [['type' => 'text', 'text' => 'Error: an unexpected error occurred. Please try again.']], 'isError' => true];
        }
    }

    private function requireScope(array $session, string $scope): void
    {
        if (!in_array($scope, $session['scopes'] ?? [], true)) {
            throw new McpDeniedException("This MCP token lacks the required scope: {$scope}", 'scope');
        }
    }

    /** Same form-count quota FormController::checkFormQuota enforces on the web create path — a
     *  no-op unless $this->planService is set AND plan enforcement is on (self-hosted default). */
    private function checkFormQuota(string $userId): void
    {
        if ($this->planService && !$this->planService->canCreateForms($userId, 1)) {
            throw new \Exception('You\'ve reached your plan\'s limit of ' . $this->planService->formLimit($userId) . ' forms. Delete a form or upgrade to add more.');
        }
    }

    /** The target app must be in scope: the one scoped app, or (creator token) an app it created. */
    private function assertAppScope(array $session, string $appId): void
    {
        if (is_array($session['created'] ?? null)) {
            if ($appId === '' || !in_array($appId, $session['created']['apps'] ?? [], true)) {
                throw new McpDeniedException('This MCP link can only manage the app(s) it created', 'app_scope');
            }
            return;
        }
        $scoped = $session['appId'] ?? null;
        if ($scoped !== null && $scoped !== $appId) {
            throw new McpDeniedException('This MCP token is scoped to a single app and cannot touch other apps', 'app_scope');
        }
    }

    /** The target form must be in scope: belong to the scoped app, or (creator token) be one it created
     *  / belong to an app it created. */
    private function assertFormInScope(array $session, string $formId): void
    {
        if (is_array($session['created'] ?? null)) {
            $createdForms = $session['created']['forms'] ?? [];
            if ($formId !== '' && (in_array($formId, $createdForms, true) || $this->formInAnyApp($session['created']['apps'] ?? [], $formId))) {
                return;
            }
            throw new McpDeniedException('This MCP link can only touch forms it created (or forms in apps it created)', 'form_scope');
        }
        $scoped = $session['appId'] ?? null;
        if ($scoped !== null && ($formId === '' || !$this->appService->formBelongsToApp($scoped, $formId))) {
            throw new McpDeniedException('This MCP token is scoped to an app; that form is not part of it', 'form_scope');
        }
    }

    /** True if $formId belongs to any of the given apps. */
    private function formInAnyApp(array $appIds, string $formId): bool
    {
        foreach ($appIds as $aid) {
            if ($this->appService->formBelongsToApp((string) $aid, $formId)) {
                return true;
            }
        }
        return false;
    }

    /** The set (formId => true) a creator token may read in list_forms: forms it created + forms in its apps. */
    private function creatorFormIds(array $session): array
    {
        $set = [];
        foreach ($session['created']['forms'] ?? [] as $fid) {
            $set[(string) $fid] = true;
        }
        foreach ($session['created']['apps'] ?? [] as $aid) {
            foreach ($this->appService->getAppForms((string) $aid) as $f) {
                $set[$f['formId']] = true;
            }
        }
        return $set;
    }

    /** Size caps for MCP-created/updated forms (MCP bypasses FormController, so enforce here). */
    /** Mirror FormController's shape/type/size rules (MCP bypasses that controller, calling services directly). */
    private function validateFormInput(array $args): void
    {
        if (array_key_exists('title', $args) && (!is_string($args['title']) || strlen($args['title']) > 500)) {
            throw new \Exception('title must be a string up to 500 characters');
        }
        if (array_key_exists('description', $args) && $args['description'] !== null && !is_string($args['description'])) {
            throw new \Exception('description must be a string or null');
        }
        if (array_key_exists('status', $args) && !in_array($args['status'], ['draft', 'published', 'archived'], true)) {
            throw new \Exception('status must be draft, published, or archived');
        }
        if (array_key_exists('icon', $args) && $args['icon'] !== null && (!is_string($args['icon']) || strlen($args['icon']) > 100)) {
            throw new \Exception('icon must be a string up to 100 characters');
        }
        if (isset($args['logicScript']) && (!is_string($args['logicScript']) || strlen($args['logicScript']) > 102400)) {
            throw new \Exception('logicScript must be a string up to 100KB');
        }
        if (array_key_exists('fields', $args)) {
            if (!is_array($args['fields'])) {
                throw new \Exception('fields must be an array');
            }
            if (count($args['fields']) > 200) {
                throw new \Exception('a form cannot have more than 200 fields');
            }
            foreach ($args['fields'] as $i => $f) {
                if (!is_array($f) || !isset($f['type'])) {
                    throw new \Exception("field at index {$i} is malformed (must be an object with a type)");
                }
            }
            if (strlen((string) json_encode($args['fields'])) > 512000) {
                throw new \Exception('fields exceed the 500KB limit');
            }
        }
        if (isset($args['customScreen'])) {
            if (!is_array($args['customScreen'])) {
                throw new \Exception('customScreen must be an object');
            }
            $this->validateCustomScreen($args['customScreen']);
        }
    }

    /** Shared customScreen shape check (form section screens AND the app home): key whitelist + size cap. */
    private function validateCustomScreen(array $cs): void
    {
        $allowed = ['enabled', 'html', 'css', 'js', 'ts', 'files', 'entry', 'publicRecords', 'publicRecordFields', 'kind', 'dashboard'];
        $unknown = array_diff(array_keys($cs), $allowed);
        if (!empty($unknown)) {
            throw new \Exception('customScreen has unknown keys: ' . implode(', ', $unknown) . ' (a widget dashboard is { kind:"dashboard", dashboard:{ cols, widgets } })');
        }
        if (strlen((string) json_encode($cs)) > 524288) {
            throw new \Exception('customScreen exceeds the 512KB limit');
        }
    }

    /**
     * Mirror FormController::sanitizeDashboardScreen for the MCP path: a section-screen widget
     * dashboard (customScreen.kind === 'dashboard') is sanitized against the form's own fields
     * (+ its linked_record target forms) before it persists, so no widget can query outside them.
     */
    private function sanitizeSectionScreen(array $screen, string $formId): array
    {
        if (($screen['kind'] ?? '') === 'dashboard' && is_array($screen['dashboard'] ?? null) && $this->reportValidator !== null) {
            $screen['dashboard'] = $this->reportValidator->sanitizeDashboard(
                $screen['dashboard'],
                $this->reportValidator->formFieldMap($formId)
            );
        }
        return $screen;
    }

    /**
     * Create a form for create_form / create_app_form. When the customScreen is a widget DASHBOARD its
     * specs must be sanitized against the form's REAL stored fields — which don't exist until the form
     * does — so the screen is held back from the insert and attached right after (create → sanitize →
     * patch): an unsanitized dashboard never persists. Code screens pass straight through (sandboxed).
     */
    private function createFormSanitized(array $args, string $userId): array
    {
        $input = array_merge($this->formInput($args), ['userId' => $userId]);
        $screen = null;
        if (is_array($input['customScreen'] ?? null) && ($input['customScreen']['kind'] ?? '') === 'dashboard') {
            $screen = $input['customScreen'];
            unset($input['customScreen']);
        }
        $form = $this->formService->createForm($input);
        if ($screen !== null && !empty($form['id'])) {
            $form = $this->formService->updateForm((string) $form['id'], [
                'customScreen' => $this->sanitizeSectionScreen($screen, (string) $form['id']),
            ]) ?? $form;
        }
        return $form;
    }

    private function ownForm(string $formId, string $userId): array
    {
        $f = $formId !== '' ? $this->formService->getForm($formId) : null;
        if (!$f || ($f['userId'] ?? null) !== $userId) {
            throw new McpDeniedException('Form not found or access denied', 'not_found');
        }
        return $f;
    }

    private function ownApp(string $appId, string $userId): array
    {
        $a = $appId !== '' ? $this->appService->getApp($appId) : null;
        if (!$a || ($a['ownerId'] ?? null) !== $userId) {
            throw new McpDeniedException('App not found or access denied', 'not_found');
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

    /** Tool definitions visible to a session — filtered by its scopes (and app-scope for create_app;
     *  create_app_form additionally requires apps:write, since its own case in callTool() does too). */
    private function toolDefs(array $session): array
    {
        $field = ['type' => 'object', 'description' => 'A field: { id, type, label, required, properties? }'];
        $screen = ['type' => 'object', 'description' => "Custom screen — two kinds. (1) PREFERRED no-code widget DASHBOARD: { kind:'dashboard', dashboard:{ cols?:12, widgets:[{ kind:'report'|'list'|'text'|'actions'|'activity', layout:{x,y,w,h}, title?, … }] } } — 'report' embeds a chart/KPI/table via `spec` (the SAME shape as create_report's spec), 'list' shows recent records via `list`:{formId,limit?,titleField?,subtitleField?,metaField?}, 'text' a note via `text`:{body}, 'actions' new-record buttons, 'activity' a latest-records feed (both config-free, app home only). Widget specs are validated against the in-scope forms on save; out-of-scope widgets are dropped. (2) CODE screen — a sandboxed full frontend: EITHER `ts` (a single TypeScript/JS file) OR `files` (a multi-file project: an array of { path, content } with .ts/.tsx/.css files + an index.html shell and relative imports between files). Either is compiled/bundled to runnable JS automatically. Talks to the backend via window.FormLogic (submit/records/currentUser/context/toast)."];
        $obj = static fn (array $props, array $req = []) => array_filter(['type' => 'object', 'properties' => $props, 'required' => $req], static fn ($v) => $v !== []);
        $scopes = $session['scopes'] ?? [];
        $scopedApp = $session['appId'] ?? null;
        $all = [
            ['name' => 'list_forms', 'scope' => 'forms:read', 'description' => "List the owner's forms (only this app's forms when the token is app-scoped).", 'inputSchema' => $obj([])],
            ['name' => 'get_form', 'scope' => 'forms:read', 'description' => 'Get one form (fields, logicScript, customScreen).', 'inputSchema' => $obj(['formId' => ['type' => 'string']], ['formId'])],
            ['name' => 'create_form', 'scope' => 'forms:write', 'description' => 'Create a form. Provide title and optional fields[], logicScript (QuickJS onSubmit), customScreen, status.', 'inputSchema' => $obj(['title' => ['type' => 'string'], 'description' => ['type' => 'string'], 'fields' => ['type' => 'array', 'items' => $field], 'logicScript' => ['type' => 'string'], 'customScreen' => $screen, 'status' => ['type' => 'string', 'enum' => ['draft', 'published']]], ['title'])],
            ['name' => 'update_form', 'scope' => 'forms:write', 'description' => 'Update a form (any of fields, logicScript, customScreen, title, status).', 'inputSchema' => $obj(['formId' => ['type' => 'string'], 'title' => ['type' => 'string'], 'fields' => ['type' => 'array', 'items' => $field], 'logicScript' => ['type' => 'string'], 'customScreen' => $screen, 'status' => ['type' => 'string']], ['formId'])],
            ['name' => 'create_app_form', 'scope' => 'forms:write', 'description' => "PREFERRED for building an app: create a form AND attach it to an app in one call (no orphan form). appId defaults to the token's app when app-scoped; required for account-wide tokens. Same fields as create_form + displayName.", 'inputSchema' => $obj(['appId' => ['type' => 'string'], 'displayName' => ['type' => 'string'], 'title' => ['type' => 'string'], 'description' => ['type' => 'string'], 'fields' => ['type' => 'array', 'items' => $field], 'logicScript' => ['type' => 'string'], 'customScreen' => $screen, 'status' => ['type' => 'string', 'enum' => ['draft', 'published']]], ['title'])],
            ['name' => 'list_apps', 'scope' => 'apps:read', 'description' => "List the owner's apps (only the scoped app when app-scoped).", 'inputSchema' => $obj([])],
            ['name' => 'create_app', 'scope' => 'apps:write', 'description' => 'Create an app (container for forms). Optional appKind tags the audience the app serves.', 'inputSchema' => $obj(['name' => ['type' => 'string'], 'description' => ['type' => 'string'], 'appKind' => ['type' => 'string', 'enum' => AppService::APP_KINDS, 'description' => 'Optional audience tag: admin console, client portal, staff field app, public intake, internal, or custom.']], ['name'])],
            ['name' => 'update_app', 'scope' => 'apps:write', 'description' => 'Update an app: rename, set description, change the URL slug, publish (status: draft|published|archived), or hide the sidebar/menu (hideNav: true for a self-contained custom-home app).', 'inputSchema' => $obj(['appId' => ['type' => 'string'], 'name' => ['type' => 'string'], 'description' => ['type' => 'string'], 'slug' => ['type' => 'string', 'description' => 'URL slug: lowercase letters, digits, hyphens.'], 'status' => ['type' => 'string', 'enum' => ['draft', 'published', 'archived']], 'hideNav' => ['type' => 'boolean', 'description' => 'Render the app full-screen without the sidebar/menu.']], ['appId'])],
            ['name' => 'add_form_to_app', 'scope' => 'apps:write', 'description' => 'Attach a form to an app.', 'inputSchema' => $obj(['appId' => ['type' => 'string'], 'formId' => ['type' => 'string'], 'displayName' => ['type' => 'string']], ['appId', 'formId'])],
            ['name' => 'set_app_home', 'scope' => 'screens:write', 'description' => "Set the app's home screen. PREFERRED: a no-code widget DASHBOARD ({ kind:'dashboard', dashboard:{ cols, widgets } } — charts/KPIs/lists the host renders natively; report widgets take the same spec as create_report). ALTERNATIVE: a full sandboxed CODE frontend (HTML/CSS/TypeScript) over the app's forms — its SDK spans all the app's forms: submit(formId,answers)/records(formId)/navigate(formId)/context()/forms()/currentUser(). Build a whole app here; you don't need a screen per form.", 'inputSchema' => $obj(['appId' => ['type' => 'string'], 'customScreen' => $screen], ['appId', 'customScreen'])],
            ['name' => 'create_report', 'scope' => 'apps:write', 'description' => "Add a chart report to the app's Reports section (bar/line/area/pie/donut chart, a KPI number, or a table). spec = { formId, viz, groupBy?:{field,bucket?}, measure?:{fn,field?}, joins?:[{via,formId,type}], filters?:[{field,op,value?}], columns?:[…], seriesSort?, sort?, limit? }. viz: bar|line|area|pie|donut|kpi|table. fn: count|countDistinct|sum|avg|min|max. Use the REAL form ids you created. joins[].via = a linked_record field id on the base form; joins[].formId = the linked form. Field refs (group/measure/filter/columns) are a base field id, a joined ref \"<joinFormId>::<fieldId>\", or the pseudo-fields __submitted_at / __status. Returns the created report incl. its id.", 'inputSchema' => $obj(['appId' => ['type' => 'string'], 'name' => ['type' => 'string'], 'description' => ['type' => 'string'], 'spec' => ['type' => 'object', 'description' => 'Report spec (see tool description).']], ['appId', 'name', 'spec'])],
            ['name' => 'create_document', 'scope' => 'apps:write', 'description' => "Add a PDF document (a report page combining multiple charts + explanatory text) to the app's Reports section. blocks[] render in order: { kind:'text', title?, body } for a heading/paragraph, or { kind:'report', reportId, caption? } to embed a chart — reportId is the id returned by create_report. Create the chart reports FIRST, then reference them here.", 'inputSchema' => $obj(['appId' => ['type' => 'string'], 'name' => ['type' => 'string'], 'description' => ['type' => 'string'], 'blocks' => ['type' => 'array', 'items' => ['type' => 'object', 'description' => "{ kind:'text', title?, body } | { kind:'report', reportId, caption? }"]]], ['appId', 'name', 'blocks'])],
            ['name' => 'list_responses', 'scope' => 'responses:read', 'description' => "List a form's responses.", 'inputSchema' => $obj(['formId' => ['type' => 'string'], 'limit' => ['type' => 'number']], ['formId'])],
            ['name' => 'desktop_status', 'scope' => 'connector:command', 'description' => "Check whether the owner's FormLogic Desktop is online (currently polling the connector relay). Call this BEFORE connector_command to know if commands will reach a desktop. Returns { online, lastSeenSecondsAgo }.", 'inputSchema' => $obj([])],
            ['name' => 'connector_command', 'scope' => 'connector:command', 'description' => "Send a command to a hardware/service CONNECTOR on the owner's linked FormLogic Desktop and wait for the result (the desktop must be RUNNING + LINKED). connectorId names the connector (e.g. 'aokie' — the Bluetooth phone bridge). command + payload are connector-specific; for aokie: call.answer, call.reject, call.hangup, call.operatorSpeak {text}, sms.send {to, body}, sms.thread {threadId}, call.current, phone.status, dongle.list, dongle.diagnostics {simulate:'call'}. This is how you REMOTELY control the phone: e.g. hang up the current call, or speak a message to the caller. Returns the connector's result, or a note that it is still pending (desktop offline/slow).", 'inputSchema' => $obj(['connectorId' => ['type' => 'string', 'description' => "Connector id, e.g. 'aokie'."], 'command' => ['type' => 'string', 'description' => 'Connector command, e.g. call.hangup.'], 'payload' => ['type' => 'object', 'description' => 'Command arguments (connector-specific).'], 'waitMs' => ['type' => 'number', 'description' => 'Max ms to wait for the desktop result (default 15000, max 25000).']], ['connectorId', 'command'])],
        ];
        // get_started is always available (no scope) — a full how-to guide so an AI can build with no prior
        // knowledge. Listed first so it's the obvious first call.
        $out = [['name' => 'get_started', 'description' => 'Read this FIRST. A complete guide to building/editing a FormLogic app over MCP: the workflow, field types, custom-screen SDK, and a worked example.', 'inputSchema' => $obj([])]];
        foreach ($all as $t) {
            if (!in_array($t['scope'], $scopes, true)) {
                continue;
            }
            if ($t['name'] === 'create_app' && $scopedApp !== null) {
                continue; // app-scoped tokens can't create new apps
            }
            if ($t['name'] === 'create_app_form' && !in_array('apps:write', $scopes, true)) {
                continue; // callTool() also requires apps:write; hide it unless the session actually has both
            }
            unset($t['scope']);
            $out[] = $t;
        }
        return $out;
    }

    /** Short usage guide surfaced via initialize.instructions (MCP clients feed this to the model). */
    private function serverInstructions(): string
    {
        return <<<'TXT'
FormLogic builds self-hosted apps made of FORMS (fields + data), optional backend onSubmit SCRIPTS, no-code widget DASHBOARDS (charts/KPIs/record lists over the data), and optional CUSTOM CODE SCREENS (a sandboxed HTML/CSS/TypeScript frontend). This MCP server creates and edits all of it. Call the get_started tool for a full guide with a worked example.

Build an app from scratch:
1. create_app { name, description?, appKind? } — a container for forms. appKind tags the audience: admin|client|staff|public|internal|custom. (Skip if your token is already scoped to one app; then create_app is hidden.)
2. create_app_form { title, fields } — create a form AND attach it to the app in one call. Repeat per form. Fields: [{ id, type, label, required, properties? }]. Common types: short_text, long_text, email, number, dropdown / multiple_choice (properties.options: [{id,label,value}]), checkbox, date, rating, scale, file_upload, hidden, statement, linked_record (properties.targetFormId = another form's id, to relate records).
3. (optional) update_form { formId, logicScript } — a QuickJS "function onSubmit(ctx) {…}" server-side script.
4. (recommended) set_app_home { appId, customScreen: { kind:"dashboard", dashboard:{ cols:12, widgets:[…] } } } — a no-code widget DASHBOARD home screen, the primary kind. Widgets: { kind:"report", layout:{x,y,w,h}, title?, spec } (spec = the same shape as create_report), { kind:"list", layout, list:{formId,limit?,titleField?,subtitleField?,metaField?} }, { kind:"text", layout, text:{body} }, { kind:"actions", layout } (new-record buttons), { kind:"activity", layout } (latest records). ALTERNATIVE: a full CODE frontend { enabled:true, files:[{path,content}] } or { enabled:true, ts, html, css }, compiled/bundled automatically; inside it window.FormLogic is the SDK: context(), forms(), submit(formId,answers), records(formId,{limit}), currentUser(), navigate(formId), toast.success/error, escapeHtml(v) — ALWAYS escapeHtml() record data before innerHTML.
5. (optional) create_report { appId, name, spec } — add charts/KPIs/tables to the app's Reports section (bar|line|area|pie|donut|kpi|table). Then create_document { appId, name, blocks } to combine several charts + text into an exportable PDF report page.
6. update_app { appId, status:"published" } — publish (status:"draft" unpublishes). Optional: slug, hideNav (full-screen, no menu).

First inspect existing content with list_apps / list_forms / get_form. Your token is temporary and cannot read submissions unless explicitly granted. Prefer create_app_form over create_form + add_form_to_app.
TXT;
    }

    /** The full get_started guide (returned by the get_started tool). */
    private function guide(): string
    {
        return <<<'TXT'
# Building a FormLogic app over MCP

FormLogic apps = an APP (container) + one or more FORMS (each a set of fields, backed by its own database) + optionally a backend onSubmit SCRIPT per form + a HOME SCREEN (preferably a no-code widget DASHBOARD; alternatively a sandboxed HTML/CSS/TypeScript CODE screen that reads/writes the forms' data). You build all of this with the tools below.

## Recommended workflow
1. list_apps / list_forms — see what already exists (only if editing).
2. create_app { name, description?, appKind? } — unless your token is already app-scoped. appKind (optional) tags the audience: admin | client | staff | public | internal | custom.
3. For each form: create_app_form { title, fields, displayName? } — creates the form and attaches it to the app in one call.
4. Optionally update_form { formId, logicScript } to add server-side automation.
5. set_app_home { appId, customScreen } — give the app a home screen. PREFER a widget dashboard (see "Widget dashboards" below); a custom CODE frontend is the advanced alternative.
6. Optionally create_report / create_document to add analytics (see "Reports" below).
7. update_app { appId, status: "published" } to publish (status: "draft" unpublishes; optionally slug, hideNav).

## Fields
A field: { "id": "email", "type": "email", "label": "Email", "required": true, "properties": {} }
Types: short_text, long_text, email, number, phone, url, date, time, dropdown, multiple_choice, checkbox, rating, scale, file_upload, statement (display-only), hidden (computed/script-set), linked_record.
- dropdown / multiple_choice / checkbox: properties.options = [{ "id":"a", "label":"A", "value":"a" }].
- linked_record: properties.targetFormId = the id of another form to relate to. (Over MCP the other form must exist; use its real id.)

## onSubmit script (optional)
logicScript is JavaScript: "function onSubmit(ctx) { /* ctx.answers, ctx.setField, ctx.reject, ctx.setStatus, ctx.addTag */ }". Runs server-side on every submission (sandboxed QuickJS).

## Widget dashboards (the primary home screen)
A dashboard is DATA, not code: a grid of widgets the host renders natively (theming, drill-down, auto-refresh come free). Set it with set_app_home { appId, customScreen: { kind:"dashboard", dashboard } }.
dashboard = { cols?: 12, widgets: [ … up to 60 ], showRangePicker?: bool, refreshInterval?: 30|60|300 (seconds) }.
Every widget has { kind, layout:{x,y,w,h}, title? } (grid units; w up to cols, h up to 12). Kinds:
- report — an inline chart/KPI/table: { kind:"report", layout, title?, spec } where spec is EXACTLY the create_report spec shape ({ formId, viz, groupBy?, measure?, joins?, filters?, … }).
- list — recent records: { kind:"list", layout, title?, list:{ formId, limit? (max 25), titleField?, subtitleField?, metaField? } } (the *Field values are field ids on that form).
- text — a note: { kind:"text", layout, text:{ body } }.
- actions — new-record buttons for the app's forms (no extra config; app home only).
- activity — a latest-records feed across the app's forms (no extra config; app home only).
Widget specs are validated on save against the app's forms: a widget whose formId / joins / field refs point outside the app is DROPPED, so use the REAL form ids you created.
FORM SECTION dashboards: a form can carry its own dashboard, shown on its section screen inside the app — update_form { formId, customScreen: { kind:"dashboard", dashboard } } AFTER creating the form (its widget specs may reference that form and the forms its linked_record fields target).

## Custom CODE screen (advanced alternative to a dashboard)
A sandboxed frontend over the app's forms. Two shapes:
- Single file: customScreen = { enabled:true, html:"<div id='app'></div>", css:"…", ts:"…TypeScript…" }
- Multi-file: customScreen = { enabled:true, files:[ {"path":"index.html","content":"<div id='app'></div>"}, {"path":"index.ts","content":"import { render } from './ui';"}, {"path":"ui.ts","content":"export function render(){…}"} , {"path":"styles.css","content":"…"} ] }
It is compiled/bundled automatically (TypeScript, relative imports between files; no npm/CDN). The entry is index.ts/index.tsx.
Inside the screen, window.FormLogic is the SDK:
- await FormLogic.context() -> { appName, appSlug, forms:[{formId,displayName,fields}] }
- await FormLogic.forms()
- await FormLogic.submit(formId, answers)  // answers keyed by field id
- await FormLogic.records(formId, { limit }) -> [{ id, answers, submittedAt }]
- await FormLogic.currentUser()
- FormLogic.navigate(formId)
- FormLogic.toast.success(msg) / .error(msg)
- FormLogic.escapeHtml(value)  // ALWAYS use this for record/user data placed into innerHTML
Never fetch() — there is no network; only FormLogic reaches the backend.

## Reports (charts + PDF documents)
Give the app a Reports section — no custom screen needed.
- create_report { appId, name, spec } adds one chart/KPI/table. spec = { formId, viz, groupBy?, measure?, joins?, filters?, columns?, sort?, limit? }.
  - viz: "bar" | "line" | "area" | "pie" | "donut" | "kpi" (a single number) | "table".
  - groupBy: { field, bucket? } — bucket "day"|"month"|"year" for date fields. measure: { fn, field? } — fn count|countDistinct|sum|avg|min|max (field required except for count).
  - joins: [{ via, formId, type }] to chart across related forms. via = a linked_record field id on the base form; formId = the linked form's id; type "left"|"inner". Reference a joined form's field as "<joinFormId>::<fieldId>".
  - field refs (in groupBy/measure/filters/columns) are a base field id, a joined ref, or a pseudo-field: __submitted_at (submission time) or __status (workflow status).
  - Examples: { formId:"<job>", viz:"bar", groupBy:{field:"status"}, measure:{fn:"count"} }; revenue over time { formId:"<invoice>", viz:"line", groupBy:{field:"__submitted_at",bucket:"month"}, measure:{fn:"sum",field:"total"} }; cross-form { formId:"<job>", viz:"bar", joins:[{via:"customer",formId:"<customer>",type:"left"}], groupBy:{field:"<customer>::customer_type"}, measure:{fn:"sum",field:"estimated_value"} }.
- create_document { appId, name, blocks } builds an exportable PDF report page. blocks in order: { kind:"text", title?, body } or { kind:"report", reportId, caption? } (reportId = an id returned by create_report). Create the charts first, then the document.

## Worked example — a "Tasks" app with a dashboard home
1. create_app { "name": "Tasks", "appKind": "internal" }  -> returns { id }
2. create_app_form { "title": "Task", "fields": [
     { "id":"title", "type":"short_text", "label":"Title", "required":true },
     { "id":"status", "type":"dropdown", "label":"Status", "required":false,
       "properties": { "options": [ {"id":"open","label":"Open","value":"open"}, {"id":"done","label":"Done","value":"done"} ] } }
   ] }  -> returns { form:{ id }, appId }
3. set_app_home { "appId":"<appId>", "customScreen": { "kind":"dashboard", "dashboard": { "cols":12, "widgets":[
     { "kind":"report", "layout":{"x":0,"y":0,"w":4,"h":2}, "title":"Open tasks",
       "spec": { "formId":"<formId>", "viz":"kpi", "measure":{"fn":"count"}, "filters":[{"field":"status","op":"eq","value":"open"}] } },
     { "kind":"report", "layout":{"x":4,"y":0,"w":8,"h":3}, "title":"Tasks by status",
       "spec": { "formId":"<formId>", "viz":"bar", "groupBy":{"field":"status"}, "measure":{"fn":"count"} } },
     { "kind":"actions", "layout":{"x":0,"y":3,"w":12,"h":1}, "title":"Quick actions" },
     { "kind":"list", "layout":{"x":0,"y":4,"w":12,"h":3}, "title":"Latest tasks",
       "list": { "formId":"<formId>", "limit":8, "titleField":"title", "subtitleField":"status" } }
   ] } } }
4. update_app { "appId":"<appId>", "status":"published" }
(For a custom CODE home instead, pass customScreen = { "enabled":true, "files":[ {"path":"index.html","content":"<div id=\"app\"></div>"}, {"path":"index.ts","content":"…window.FormLogic SDK code…"} ] }.)

Notes: tools return their result as JSON text; a failed call returns isError:true with a message. Your token is temporary (idle-expires) and, by default, cannot read submissions.
TXT;
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

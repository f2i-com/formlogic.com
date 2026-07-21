<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\ChatToolDeniedException;
use FormLogic\Services\ChatToolsContext;
use FormLogic\Services\ChatToolsService;
use FormLogic\Services\McpOAuthService;
use FormLogic\Services\McpTokenService;
use FormLogic\Services\FormService;
use FormLogic\Services\AppService;
use FormLogic\Services\AppReportService;
use FormLogic\Services\ResponseService;
use FormLogic\Services\AuditService;
use FormLogic\Services\DesktopCommandService;
use FormLogic\Services\RateLimiter;
use FormLogic\Services\PlanService;
use FormLogic\Services\FlowService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Log\LoggerInterface;

/**
 * Thrown when an MCP tool call is denied by a scope or ownership check (requireScope, assertAppScope,
 * assertFormInScope, ownApp, ownForm) — as opposed to an ordinary input-validation \Exception. Carries
 * a short, stable machine-readable reason code alongside the human message so callTool()'s catch site
 * can audit denials (queryable trail for a probing/misbehaving token) without parsing message text.
 * The message shown to the MCP caller is unchanged either way — this is purely additive server-side.
 *
 * Since the Phase-6 ChatToolsService extraction the reason-code carrier lives in the shared base
 * class (Services\ChatToolDeniedException) — the extracted handlers throw the base, this subclass
 * marks denials raised by the MCP surface itself; callTool() catches the base so both are audited.
 */
class McpDeniedException extends ChatToolDeniedException
{
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
        // Flows (automations) — the same owner CRUD surface the /flows workspace uses. Null only in
        // older tests; production always wires it (flow tools error cleanly when absent).
        private ?FlowService $flowService = null,
        // Recycle bin: external-AI flow deletes snapshot first, like the web surface.
        private ?\FormLogic\Services\TrashService $trashService = null,
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

    // Which scope each tool requires — the map moved to ChatToolsService::TOOL_SCOPES with the
    // Phase-6 handler extraction (one home for the scope model, shared with the chat surface).
    private const TOOL_SCOPES = ChatToolsService::TOOL_SCOPES;

    /** Shared tool handlers (plan Phase 6 §5.4) — built lazily from this controller's own
     *  services so the constructor signature (pinned by tests + DI) stays untouched. */
    private ?ChatToolsService $chatToolsService = null;

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
        try {
            if ($name === 'get_started') {
                return ['content' => [['type' => 'text', 'text' => $this->guide()]]];
            }
            // The MCP-TRANSPORT tools (relay/session concerns) stay in this controller; every
            // other tool — and any unknown name, which gets the same scope-gated refusal as
            // before — runs the SHARED ChatToolsService handlers via the switch default below.
            // The service applies the scope + cloud-entitlement gates itself; for the two local
            // cases apply the SAME gates here, in the same order.
            if ($name === 'desktop_status' || $name === 'connector_command') {
                $this->requireScope($session, self::TOOL_SCOPES[$name]);
                // Cloud entitlement (audit FL-003/C-10): connector:command tools require an
                // ACTIVE cloud account, the SAME policy as every web/API write path.
                if (
                    $this->planService !== null
                    && $this->planService->isEnforced()
                    && !$this->planService->isCloudActive($userId)
                ) {
                    throw new McpDeniedException('Cloud access for this account has lapsed — renew to make changes', 'cloud_lapsed');
                }
            }
            switch ($name) {
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
                    // ROUTE-001: the registered machines, so a client can see WHICH desktop
                    // would service a command (and spot an ambiguous multi-desktop setup).
                    if ($this->flowService !== null) {
                        $data['desktops'] = array_map(static fn (array $c) => [
                            'deviceName' => $c['deviceName'],
                            'desktopInstanceId' => $c['desktopInstanceId'],
                            'lastSeenAt' => $c['lastSeenAt'],
                        ], $this->flowService->listDesktopConnections($userId));
                    }
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
                    // MCP bypasses ConnectorCommandController, so repeat the
                    // private-channel denial here before presence/target work;
                    // DesktopCommandService repeats it before persistence.
                    DesktopCommandService::assertPublicRelayCommand($connectorId, $command);
                    $payload = is_array($args['payload'] ?? null) ? $args['payload'] : null;
                    $waitMs = max(0, min(self::CONNECTOR_COMMAND_MAX_WAIT_MS, (int) ($args['waitMs'] ?? 15000)));
                    // Presence: if no desktop has polled the relay recently, don't block the full timeout
                    // for one that isn't there — still enqueue + give a short grace in case it's just
                    // coming online.
                    $seen = $this->desktopCommands->ownerDesktopLastSeenSeconds($userId);
                    $online = $seen !== null && $seen <= self::DESKTOP_ONLINE_WINDOW;
                    // ROUTE-001: route the command at ONE desktop instance (connector assignment /
                    // implicit single fresh connection). Two+ online desktops with no assignment is
                    // ambiguous — refuse with the machine list instead of letting the wrong computer
                    // claim-and-fail a phone command.
                    $resolved = $this->desktopCommands->resolveTargetInstance($userId, $connectorId);
                    if ($resolved['error'] === 'ambiguous_desktop') {
                        $names = implode(', ', array_map(
                            static fn (array $d) => (string) $d['deviceName'],
                            $resolved['desktops']
                        ));
                        throw new \Exception(
                            "More than one FormLogic Desktop is online ({$names}) — assign the '{$connectorId}' connector to one machine (PUT /api/connector-assignments {desktopConnectionId}) before sending commands."
                        );
                    }
                    // Enqueue for the token owner's desktop runtime; the desktop (its connector:relay
                    // key) claims + executes it exactly-once and completes the result back.
                    $enq = $this->desktopCommands->enqueue($userId, $userId, $scopedApp, [
                        'connectorId' => $connectorId,
                        'command' => $command,
                        'payload' => $payload,
                        'targetInstanceId' => $resolved['target'],
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
                    // Every non-transport tool — and any unknown name, which gets the same
                    // scope-gated refusal as before — runs the SHARED handlers extracted to
                    // ChatToolsService (plan Phase 6 §5.4): scope gate + cloud gate + the tool
                    // switch moved there verbatim; toolContext() threads this token's session
                    // (scopes, app confinement, creator bookkeeping, 'mcp.' audits) through.
                    $data = $this->chatTools()->call($name, $args, $this->toolContext($session, $request));
            }
            return ['content' => [['type' => 'text', 'text' => json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)]]];
        } catch (ChatToolDeniedException $e) {
            // A scope/ownership denial (as opposed to ordinary validation noise below) — always audited
            // so a token probing outside its scope, or repeatedly failing, leaves a queryable trail.
            // Must be caught before the plain \Exception branch (the denial base extends it); catching
            // the BASE covers both this controller's McpDeniedException and the shared handlers'.
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

    /** The shared handlers, built from this controller's own services (constructor unchanged). */
    private function chatTools(): ChatToolsService
    {
        return $this->chatToolsService ??= new ChatToolsService(
            $this->formService,
            $this->appService,
            $this->responseService,
            $this->reportValidator,
            $this->planService,
            $this->flowService,
            $this->trashService,
        );
    }

    /**
     * Thread the MCP token session through the shared handlers (plan §5.4): the scope closure
     * enforces THIS token's scopes (throws McpDeniedException, so denials audit exactly as
     * before), audits land under their historical 'mcp.<action>' names, and creator-token
     * bookkeeping keeps mutating the by-reference $session (+ persists via McpTokenService)
     * so later calls in the same batch see what earlier ones created.
     */
    private function toolContext(array &$session, Request $request): ChatToolsContext
    {
        $userId = (string) $session['userId'];
        $tokens = $this->tokens;
        return new ChatToolsContext(
            userId: $userId,
            scopedAppId: is_string($session['appId'] ?? null) ? $session['appId'] : null,
            creatorMode: is_array($session['created'] ?? null), // a "creator" token: confined to what it makes
            createdApps: is_array($session['created']['apps'] ?? null) ? $session['created']['apps'] : [],
            createdForms: is_array($session['created']['forms'] ?? null) ? $session['created']['forms'] : [],
            requireScope: function (string $scope) use (&$session): void {
                $this->requireScope($session, $scope);
            },
            audit: function (string $action, array $details) use ($request, $userId): void {
                $this->audit($request, 'mcp.' . $action, $userId, $details);
            },
            recordCreated: function (string $kind, string $id) use (&$session, $tokens): void {
                $session['created'][$kind][] = $id;
                $tokens->recordCreated((string) $session['id'], $kind, $id);
            },
            ip: $this->ip($request),
            userAgent: 'mcp',
            source: 'mcp',
        );
    }

    /** Tool definitions visible to a session — filtered by its scopes (and app-scope for create_app;
     *  create_app_form additionally requires apps:write, since its own case in callTool() does too). */
    private function toolDefs(array $session): array
    {
        $scopes = $session['scopes'] ?? [];
        $scopedApp = $session['appId'] ?? null;
        // The definition list (name/scope/description/inputSchema, deliberately ordered) moved
        // to ChatToolsService::toolDefinitions() with the Phase-6 extraction — one catalog
        // source shared with the chat surface; this method keeps the MCP session filtering.
        $all = ChatToolsService::toolDefinitions();
        // get_started is always available (no scope) — a full how-to guide so an AI can build with no prior
        // knowledge. Listed first so it's the obvious first call.
        $out = [['name' => 'get_started', 'description' => 'Read this FIRST. A complete guide to building/editing a FormLogic app over MCP: the workflow, field types, custom-screen SDK, and a worked example.', 'inputSchema' => ['type' => 'object']]];
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
FormLogic builds self-hosted apps made of FORMS (fields + data), optional backend onSubmit SCRIPTS, no-code widget DASHBOARDS (charts/KPIs/record lists over the data), FLOWS (event-triggered automation graphs), and optional CUSTOM CODE SCREENS (a sandboxed frontend — React-style TSX components on built-in Preact, or plain HTML/CSS/TypeScript). This MCP server creates and edits all of it. Call the get_started tool for a full guide with a worked example.

Build an app from scratch:
1. create_app { name, description?, appKind? } — a container for forms. appKind tags the audience: admin|client|staff|public|internal|custom. (Skip if your token is already scoped to one app; then create_app is hidden.)
2. create_app_form { title, fields } — create a form AND attach it to the app in one call. Repeat per form. Fields: [{ id, type, label, required, properties? }]. Common types: short_text, long_text, email, number, dropdown / multiple_choice (properties.options: [{id,label,value}]), checkbox, date, rating, scale, file_upload, hidden, statement, linked_record (properties.targetFormId = another form's id, to relate records).
3. (optional) update_form { formId, logicScript } — a QuickJS "function onSubmit(ctx) {…}" server-side script.
4. (recommended) set_app_home { appId, customScreen: { kind:"dashboard", dashboard:{ cols:12, widgets:[…] } } } — a no-code widget DASHBOARD home screen, the primary kind. Widgets: { kind:"report", layout:{x,y,w,h}, title?, spec } (spec = the same shape as create_report), { kind:"list", layout, list:{formId,limit?,titleField?,subtitleField?,metaField?} }, { kind:"text", layout, text:{body} }, { kind:"actions", layout } (new-record buttons), { kind:"activity", layout } (latest records). ALTERNATIVE: a full CODE frontend { enabled:true, files:[{path,content}] } (React-style TSX supported: entry index.tsx mounting createRoot(document.getElementById('root')!).render(<App/>); built-ins 'react'/'react-dom/client'/'preact'/'preact/hooks', no other npm; folders + relative imports fine; no index.html needed) or legacy { enabled:true, ts, html, css }; compiled/bundled automatically. Inside it window.FormLogic is the SDK: context(), forms(), submit(formId,answers), records(formId,{limit}), currentUser(), navigate(formId), toast.success/error, escapeHtml(v) — render record data as JSX text (auto-escaped), never dangerouslySetInnerHTML.
5. (optional) AUTOMATE with flows: create_flow { appId, name, flowJson:{nodes,edges}, nodeCapabilities } then create_flow_binding { flow:<slug>, event, formId?|connectorId?, inputMap?, outputActions? } — e.g. run a flow on event "form.submitted" of a form, or on a connector event like "aokie.call.incoming". Full node reference in get_started § Flows.
6. (optional) create_report { appId, name, spec } — add charts/KPIs/tables to the app's Reports section (bar|line|area|pie|donut|kpi|table). Then create_document { appId, name, blocks } to combine several charts + text into an exportable PDF report page.
7. update_app { appId, status:"published" } — publish (status:"draft" unpublishes). Optional: slug, hideNav (full-screen, no menu), customLogic (app-logic event handlers).

First inspect existing content with list_apps / list_forms / get_form / list_flows. Your token is temporary; it can only read records with the responses:read scope and only create/update/delete records (add_response / update_response / delete_response) with the explicitly-granted responses:write scope. Prefer create_app_form over create_form + add_form_to_app.
TXT;
    }

    /** The full get_started guide (returned by the get_started tool). */
    private function guide(): string
    {
        return <<<'TXT'
# Building a FormLogic app over MCP

FormLogic apps = an APP (container) + one or more FORMS (each a set of fields, backed by its own database) + optionally a backend onSubmit SCRIPT per form + a HOME SCREEN (preferably a no-code widget DASHBOARD; alternatively a sandboxed CODE screen — React-style TSX components on built-in Preact — that reads/writes the forms' data) + optionally FLOWS (event-triggered automation graphs bound to form or connector events). You build all of this with the tools below.

## Recommended workflow
1. list_apps / list_forms — see what already exists (only if editing).
2. create_app { name, description?, appKind? } — unless your token is already app-scoped. appKind (optional) tags the audience: admin | client | staff | public | internal | custom.
3. For each form: create_app_form { title, fields, displayName? } — creates the form and attaches it to the app in one call.
4. Optionally update_form { formId, logicScript } to add server-side automation.
5. set_app_home { appId, customScreen } — give the app a home screen. PREFER a widget dashboard (see "Widget dashboards" below); a custom CODE frontend is the advanced alternative.
6. Optionally add flows: create_flow + create_flow_binding (see "Flows" below).
7. Optionally create_report / create_document to add analytics (see "Reports" below).
8. update_app { appId, status: "published" } to publish (status: "draft" unpublishes; optionally slug, hideNav).

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
A sandboxed frontend over the app's forms. PREFERRED shape: a multi-file React-style TSX project —
customScreen = { enabled:true, files:[ {"path":"index.tsx","content":"…components + createRoot mount…"}, {"path":"components/Card.tsx","content":"…"}, {"path":"styles.css","content":"…"} ] }
- JSX components run on Preact with React aliased to it: import { useState, useEffect } from 'react' and import { createRoot } from 'react-dom/client' work as usual. Built-ins (always available, no network): 'react', 'react-dom/client', 'preact', 'preact/hooks', 'formlogic/kit'. PREFER the kit for UI chrome — import { Card, Button, Field, Input, Select, Textarea, Stat, Badge, EmptyState, Skeleton, Toolbar, Spacer } from 'formlogic/kit' — its components are pre-styled to the app theme, so screens look native with no CSS. Other npm packages resolve via esm.sh when the screen COMPILES (the editing browser needs internet; pin versions, e.g. 'canvas-confetti@1.9.3') — prefer the built-ins and dependency-free code.
- IMAGE ASSETS: include .svg files as text, and binary images (.png/.jpg/.gif/.webp) as data: URI strings in a file's content (e.g. {"path":"assets/logo.png","content":"data:image/png;base64,..."}). `import logo from './assets/logo.png'` yields the data: URI for <img src={logo} />. Keep images small — the whole screen caps at 2MB.
- The entry (index.tsx) MUST mount: createRoot(document.getElementById('root')!).render(<App />). A <div id="root"></div> shell exists automatically — no index.html needed (you may include one to customize the shell).
- Folders + relative imports between your files are fine (e.g. import { Card } from './components/Card'). Every .css file is injected automatically.
- The host injects CSS variables for theming — use var(--fl-accent) / var(--fl-accent-contrast) for the brand color.
Legacy shapes still work: { enabled:true, ts:"…single TypeScript/TSX file…" } or plain { html, css, js }. Everything is compiled/bundled automatically.
PER-RECORD widget (forms only): customScreen.recordScreen = { kind:"code", title?, height? (px, 160-1200), files:[…], entry:"index.tsx" } renders on EACH record's detail page in a bounded card. Its SDK additionally exposes await FormLogic.record() (the viewed record) and await FormLogic.related() (records linked to it, grouped per linking field); updateRecord(null, answers) patches the viewed record. Set it via update_form { formId, customScreen: { …section screen…, recordScreen } } — include the EXISTING section-screen keys so they persist.
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

## Flows (event-triggered automations)
A FLOW is a graph of nodes that runs when a bound event fires (a form submission, an incoming call, …). Two tools: create_flow makes the graph, create_flow_binding wires it to its trigger.

flowJson = { nodes: [ { id, type, data: { …config } } ], edges: [ { source, target, sourceHandle? } ] }.
Node ids are unique strings you choose (e.g. "summarise"); each node's config lives under its "data" key; edges connect nodes by id; a condition node has TWO out-handles — route with sourceHandle "true" / "false".

VALUE REFERENCES (how nodes read data):
- Selector strings: "$inputs.<name>" (trigger inputs), "$nodes.<nodeId>.<key>" (an earlier node's output), "$event" (the raw event). Used in JSON-ish fields (answers, payload, filters values, output value).
- Templates: free-text fields interpolate {{ inputs.name }} / {{ nodes.summarise.content }} (note: no $ inside braces needed, but tolerated).
- QuickJS code fields ("expr"): plain JS with variables inputs, nodes, event, upstream, app — e.g. nodes["lookup"].found && inputs.durationSeconds > 5.

NODE TYPES (type → config → output):
- input — the Trigger. data.inputs = [{ name, example? }] declares what the binding's inputMap provides. Output: $inputs.<name>.
- output — the flow result. data.value: a selector or JSON (selector strings inside resolve); blank passes the upstream value through. The binding's outputActions read this as $result.
- condition — data.expr (QuickJS boolean). Routes via sourceHandle true/false edges.
- template — data.template ({{…}} interpolation) → string.
- logic_block — data.expr (QuickJS, return any JSON), data.timeoutMs? → whatever you return.
- llm_chat — data.system?, data.prompt ({{…}} ok), data.model?, data.maxTokens?, data.temperature? → { content } (the reply text: $nodes.<id>.content). Uses the app/Desktop's default model when model/endpoint are omitted — leave them omitted unless you must pin one.
- http_request — data.url ({{…}} ok; allow-listed to the FormLogic API or the paired Desktop), data.method, data.body (JSON, selectors ok) → { status, ok, body }.
- formlogic_list_responses — data.form (form id), data.filters? [{ field, op ("eq"|"contains"|…), value ("$inputs.x" ok) }], data.limit? → { first, responses, count, found }.
- formlogic_submit_response — data.form, data.answers (JSON object, selectors ok) → the created record ({ id, … }). Runs the full validated pipeline.
- formlogic_update_response — data.form, data.responseId (selector ok), data.answers (partial patch) → the updated record.
- connector_request — data.connectorId (e.g. "aokie"), data.command (e.g. "sms.send"), data.payload (JSON, selectors ok) → the connector result.
- storage_get / storage_set — small persistent KV: data.key, (set) data.value or data.valueFrom, data.scope? (default flow:<slug>).
- aokie_speak — data.text ({{…}} ok) or data.textFrom (selector) — speak on the live call (needs the aokie connector).
- browser_action / image_gen / stt_transcribe / tts_speak — advanced nodes backed by local FormLogic Desktop services.
- desktop_services — read-only list of FormLogic Desktop's managed services ({services: [{id, status, port, url}]}); lets a logic block resolve a service to a live loopback endpoint.

nodeCapabilities (on create_flow/update_flow) must declare what the nodes use, or the runtime refuses:
formlogic.responses.read (find records), formlogic.responses.write (submit/update records), formlogic.kv.write (storage_set), model.llm.local (llm_chat), connector.<id>.<command> per connector command (e.g. connector.aokie.call.operatorSpeak, or the wildcard connector.aokie.*).

create_flow_binding = the TRIGGER: { flow: "<flow slug>", event, formId?, connectorId?, mode?, condition?, inputMap?, outputActions?, timeoutMs? }.
- Form trigger: event "form.submitted" + formId (must be a form of the same app). The event carries the new record: $event.data.answers.<fieldId>, $event.data.responseId.
- Connector trigger: event e.g. "aokie.call.incoming" / "aokie.call.ended" / "aokie.sms.received" + connectorId "aokie" (requires the owner's FormLogic Desktop with that connector).
- mode: async (default — fire and forget), sync (the triggering caller waits; keep it fast), background, manual.
- inputMap: { <trigger input name>: "$event.data.<key>" } — feeds the flow's input node.
- outputActions: run AFTER the flow with its result, e.g. [{ "type": "formlogic.submitResponse", "form": "<formId>", "answers": { "summary": "$result.summary" } }]. Types: formlogic.submitResponse, formlogic.updateResponse ({ responseId }), formlogic.toast ({ message }), connector.request ({ connectorId, command, payload }), call.speak ({ message }), formlogic.store ({ scope, key, value }).

Example — auto-acknowledge a new lead:
1. create_flow { "name": "Acknowledge lead", "slug": "ack-lead", "nodeCapabilities": ["model.llm.local"], "flowJson": { "nodes": [
     { "id": "in", "type": "input", "data": { "inputs": [{ "name": "name" }, { "name": "message" }] } },
     { "id": "draft", "type": "llm_chat", "data": { "prompt": "Write a one-sentence friendly acknowledgement to {{inputs.name}} who said: {{inputs.message}}" } },
     { "id": "out", "type": "output", "data": { "value": { "reply": "$nodes.draft.content" } } }
   ], "edges": [ { "source": "in", "target": "draft" }, { "source": "draft", "target": "out" } ] } }
2. create_flow_binding { "flow": "ack-lead", "event": "form.submitted", "formId": "<leadFormId>", "inputMap": { "name": "$event.data.answers.name", "message": "$event.data.answers.message" }, "outputActions": [ { "type": "formlogic.updateResponse", "form": "<leadFormId>", "responseId": "$event.data.responseId", "answers": { "ack": "$result.reply" } } ] }

## Records (responses)
Reading records needs the responses:read scope; creating/changing them needs the explicitly-granted responses:write scope (both are opt-ins on the Connect an AI link — without them these tools are hidden).
- list_responses { formId, limit? } — read records.
- add_response { formId, answers } — create a record through the FULL pipeline (validation, calculated fields, the form's onSubmit script). Not idempotent — don't blindly retry.
- update_response { formId, responseId, answers?, status? } — answers is a PARTIAL patch merged over the stored record.
- delete_response { formId, responseId } — permanent.

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

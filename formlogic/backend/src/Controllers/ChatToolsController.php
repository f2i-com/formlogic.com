<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\ApiKeyService;
use FormLogic\Services\AuditService;
use FormLogic\Services\ChatToolDeniedException;
use FormLogic\Services\ChatToolGrantService;
use FormLogic\Services\ChatToolsContext;
use FormLogic\Services\ChatToolsService;
use FormLogic\Services\DesktopCommandService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Log\LoggerInterface;

/**
 * Chat tool grants + catalog + execute (plan Phase 6 §5.4). Three surfaces:
 *
 *   - POST /api/ai/chat-tool-grant (session): mint one 10-minute grant bound to the
 *     minting user + ONE desktop instance + the ai:chat-tools scope. The instance resolves
 *     exactly like the Phase-1 AI relay enqueue (connector-assignment pin → implicit single
 *     fresh desktop → 409 ambiguous_desktop; none → 503 desktop_offline); an explicit
 *     instanceId must belong to the user's workspace. Demo → 403.
 *   - GET /api/ai/chat-tools/catalog (session OR flk_ with ai:relay / grandfathered
 *     connector:relay): the v1 tool subset as TOP-LEVEL {"tools":[…]} — the browser widget
 *     and the desktop chat agent read the same catalog.
 *   - POST /api/ai/chat-tools/execute (flk_ ONLY): the desktop presents {grantToken, tool,
 *     input}; the grant is verified (typed grant_invalid / grant_expired), its bound
 *     instance must belong to THIS key's owner (typed grant_instance_mismatch — the same
 *     instance-ownership model as the /api/v1/desktop-ai routes), and the tool executes
 *     AS THE GRANTING USER through ChatToolsService. Every execution is audit-logged.
 */
class ChatToolsController
{
    use JsonResponseTrait;

    public function __construct(
        private ChatToolGrantService $grants,
        private ChatToolsService $chatTools,
        private DesktopCommandService $commands,
        private ?ApiKeyService $apiKeyService = null,
        private ?AuditService $auditService = null,
        private ?LoggerInterface $logger = null,
    ) {}

    /** POST /api/ai/chat-tool-grant {instanceId?} → {"data":{grantToken, expiresAt}}. */
    public function mintGrant(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonError($response, 'Authentication required', 401);
        }
        if (($blocked = $this->blockIfDemo($request, $response, 'Tool actions are disabled in the shared demo.')) !== null) {
            return $blocked;
        }
        $body = $request->getParsedBody() ?? [];
        if (!is_array($body)) {
            $body = [];
        }
        $instanceId = is_string($body['instanceId'] ?? null) ? trim((string) $body['instanceId']) : '';
        if ($instanceId !== '') {
            if (strlen($instanceId) > ChatToolGrantService::MAX_INSTANCE_ID || !preg_match(ChatToolGrantService::INSTANCE_ID_PATTERN, $instanceId)) {
                return $this->jsonError($response, 'instanceId must match the desktop instance id shape', 400);
            }
            if (!$this->grants->instanceBelongsTo((string) $userId, $instanceId)) {
                return $this->jsonError($response, 'Unknown desktop instance for this workspace', 404, 'unknown_desktop_instance');
            }
        } else {
            // Same target resolution as the Phase-1 AI relay enqueue (assignment pin →
            // implicit single fresh desktop → ambiguous), against the same reserved lane id.
            $resolved = $this->commands->resolveTargetInstance((string) $userId, DesktopAiRelayController::TARGET_CONNECTOR_ID);
            if ($resolved['error'] === 'ambiguous_desktop') {
                return $this->jsonError(
                    $response,
                    'More than one FormLogic Desktop is online for this workspace — pass instanceId explicitly.',
                    409,
                    'ambiguous_desktop',
                    ['desktops' => $resolved['desktops']],
                );
            }
            if ($resolved['target'] === null) {
                return $this->jsonError($response, 'No linked FormLogic Desktop is online to bind the grant to', 503, 'desktop_offline');
            }
            $instanceId = (string) $resolved['target'];
        }

        $grant = $this->grants->mint((string) $userId, $instanceId);
        $this->audit('chat.tool_grant', (string) $userId, $request, ['instanceId' => $instanceId]);
        return $this->jsonResponse($response, ['data' => $grant]);
    }

    /**
     * GET /api/ai/chat-tools/catalog → TOP-LEVEL {"tools":[{name, description, inputSchema}]}
     * (deliberately NOT wrapped in `data` — both shipped clients read body.tools).
     */
    public function catalog(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            // No session: the desktop chat agent authenticates with its flk_ key (same
            // either-scope rule as POST /api/ai/chat — ai:relay, connector:relay grandfathered).
            [, $authError] = $this->flkOwner($request, $response);
            if ($authError !== null) {
                return $authError;
            }
        }
        return $this->jsonResponse($response, ['tools' => ChatToolsService::chatCatalog()]);
    }

    /** POST /api/ai/chat-tools/execute {grantToken, tool, input} → {"data": <tool result>}. */
    public function execute(Request $request, Response $response): Response
    {
        // ApiKeyMiddleware authenticated the flk_ key (401 on anything else) and set the
        // attributes; the either-scope check happens here like preferencesV1 (the
        // middleware's required-scope list is AND-ed, and this route accepts EITHER).
        $keyOwnerId = $request->getAttribute('userId');
        if (!$keyOwnerId) {
            return $this->jsonError($response, 'Authentication required', 401);
        }
        $scopes = $request->getAttribute('apiKeyScopes');
        $scopes = is_array($scopes) ? $scopes : [];
        if (!in_array('ai:relay', $scopes, true) && !in_array('connector:relay', $scopes, true)) {
            return $this->jsonError($response, 'Insufficient scope. Required: ai:relay — relink FormLogic Desktop to grant it.', 403, 'insufficient_scope');
        }

        $body = $request->getParsedBody() ?? [];
        if (!is_array($body)) {
            $body = [];
        }
        $grantToken = is_string($body['grantToken'] ?? null) ? $body['grantToken'] : '';
        $tool = is_string($body['tool'] ?? null) ? $body['tool'] : '';
        $input = is_array($body['input'] ?? null) ? $body['input'] : [];
        if ($tool === '') {
            return $this->jsonError($response, 'tool is required', 400);
        }

        try {
            $grant = $this->grants->verify($grantToken);
        } catch (\RuntimeException $e) {
            if ($e->getMessage() === 'grant_expired') {
                return $this->jsonError($response, 'The chat tool grant has expired — the browser mints a fresh one each turn.', 401, 'grant_expired');
            }
            return $this->jsonError($response, 'The chat tool grant is not valid.', 401, 'grant_invalid');
        }
        // Instance binding (plan §5.4): the grant's bound desktop must be one of THIS key
        // owner's registered connections — the same ownership model the v1 desktop-ai
        // routes enforce. A grant minted for another workspace's desktop never executes.
        if (!$this->grants->instanceBelongsTo((string) $keyOwnerId, $grant['desktopInstanceId'])) {
            return $this->jsonError($response, 'The grant is bound to a desktop instance outside this key\'s workspace.', 403, 'grant_instance_mismatch');
        }

        // Execute AS THE GRANTING USER (account-wide, subset-restricted); audit every execution.
        $grantUserId = $grant['userId'];
        $ip = $this->ip($request);
        $ctx = new ChatToolsContext(
            userId: $grantUserId,
            audit: function (string $action, array $details) use ($grantUserId, $ip): void {
                $this->auditService?->log('chat.' . $action, 'chat-tools', $details['appId'] ?? $details['formId'] ?? null, $grantUserId, $ip, $details);
            },
            ip: $ip,
            userAgent: 'chat',
            source: 'chat',
        );
        try {
            $data = $this->chatTools->callChatTool($tool, $input, $ctx);
        } catch (ChatToolDeniedException $e) {
            $this->audit('chat.tool_execute', $grantUserId, $request, ['tool' => $tool, 'ok' => false, 'reason' => $e->getReasonCode()]);
            if ($e->getReasonCode() === 'unknown_tool') {
                return $this->jsonError($response, $e->getMessage(), 400, 'unknown_tool');
            }
            return $this->jsonError($response, $e->getMessage(), 403, 'tool_denied');
        } catch (\Exception $e) {
            // The handlers' validation throws are deliberately user-safe (the MCP convention).
            $this->audit('chat.tool_execute', $grantUserId, $request, ['tool' => $tool, 'ok' => false, 'message' => mb_substr($e->getMessage(), 0, 200)]);
            return $this->jsonError($response, $e->getMessage(), 400, 'tool_failed');
        } catch (\Throwable $e) {
            // Anything else (TypeError, PDOException, …) may carry internals — log, don't echo.
            $this->logger?->error('Chat tool execution failed unexpectedly', ['tool' => $tool, 'error' => $e->getMessage()]);
            $this->audit('chat.tool_execute', $grantUserId, $request, ['tool' => $tool, 'ok' => false, 'message' => 'unexpected']);
            return $this->jsonError($response, 'The tool failed unexpectedly. Please try again.', 500, 'tool_failed');
        }
        $this->audit('chat.tool_execute', $grantUserId, $request, ['tool' => $tool, 'ok' => true, 'instanceId' => $grant['desktopInstanceId']]);
        return $this->jsonResponse($response, ['data' => $data]);
    }

    // ── helpers ──

    /**
     * flk_ fallback for the catalog (mirrors AIController::flkUser): a valid key carrying
     * ai:relay — or the grandfathered connector:relay (plan §7).
     *
     * @return array{0:?string, 1:?Response} [ownerUserId, errorResponse]
     */
    private function flkOwner(Request $request, Response $response): array
    {
        if ($this->apiKeyService !== null
            && preg_match('/^Bearer\s+(flk_[a-f0-9]{40})$/i', $request->getHeaderLine('Authorization'), $m)
        ) {
            $keyData = $this->apiKeyService->validateKey($m[1]);
            if ($keyData === null) {
                return [null, $this->jsonError($response, 'Invalid, expired, or revoked API key', 401)];
            }
            $scopes = is_array($keyData['scopes'] ?? null) ? $keyData['scopes'] : [];
            if (!in_array('ai:relay', $scopes, true) && !in_array('connector:relay', $scopes, true)) {
                return [null, $this->jsonError($response, 'Insufficient scope. Required: ai:relay — relink FormLogic Desktop to grant it.', 403, 'insufficient_scope')];
            }
            return [(string) $keyData['userId'], null];
        }
        return [null, $this->jsonError($response, 'Authentication required', 401)];
    }

    private function ip(Request $request): ?string
    {
        $sp = $request->getServerParams();
        return is_string($sp['REMOTE_ADDR'] ?? null) ? $sp['REMOTE_ADDR'] : null;
    }

    private function audit(string $action, string $userId, Request $request, array $details = []): void
    {
        try {
            $this->auditService?->log($action, 'chat-tools', $details['instanceId'] ?? null, $userId, $this->ip($request), $details);
        } catch (\Throwable) {
            // audit is best-effort
        }
    }
}

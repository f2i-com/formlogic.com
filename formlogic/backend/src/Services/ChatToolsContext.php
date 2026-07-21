<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * Explicit caller context for ChatToolsService handlers (plan §5.4): who the tools run AS,
 * what app scope confines them, and how the surface enforces its own permission model —
 * so BOTH the MCP surface (OAuth token scopes, app-scoped/creator tokens) and the chat
 * surface (session/grant user, account-wide, subset-restricted upstream) enforce correctly
 * through the same handler code.
 *
 * The three closures are surface-supplied seams:
 *   - requireScope(scope): throws the surface's denial exception when the caller lacks the
 *     scope. MCP passes its token-scope check (throws McpDeniedException); the chat surface
 *     passes null (a no-op — its authorization is the fixed tool subset + the session/grant
 *     user, checked before the handler is reached).
 *   - audit(action, details): best-effort audit hook. The surface owns the action prefix
 *     ('mcp.create_form' vs 'chat.create_form') so trails stay distinguishable.
 *   - recordCreated(kind, id): MCP creator-token bookkeeping (mutates the token session +
 *     persists via McpTokenService). Null for chat (no creator mode).
 */
final class ChatToolsContext
{
    /**
     * @param string[] $createdApps  App ids a creator token has made (empty otherwise).
     * @param string[] $createdForms Form ids a creator token has made (empty otherwise).
     */
    public function __construct(
        public readonly string $userId,
        public readonly ?string $scopedAppId = null,
        public readonly bool $creatorMode = false,
        public readonly array $createdApps = [],
        public readonly array $createdForms = [],
        private readonly ?\Closure $requireScope = null,
        private readonly ?\Closure $audit = null,
        private readonly ?\Closure $recordCreated = null,
        public readonly ?string $ip = null,
        public readonly string $userAgent = 'chat',
        public readonly string $source = 'chat',
    ) {}

    /** Enforce the surface's scope model; throws the surface's denial exception on refusal. */
    public function requireScope(string $scope): void
    {
        if ($this->requireScope !== null) {
            ($this->requireScope)($scope);
        }
    }

    /** Best-effort audit hook (never throws into the handler). */
    public function audit(string $action, array $details = []): void
    {
        if ($this->audit === null) {
            return;
        }
        try {
            ($this->audit)($action, $details);
        } catch (\Throwable) {
            // audit is best-effort
        }
    }

    /** Creator-token bookkeeping ($kind is 'apps'|'forms'); a no-op outside creator mode. */
    public function recordCreated(string $kind, string $id): void
    {
        if ($this->recordCreated !== null) {
            ($this->recordCreated)($kind, $id);
        }
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * Thrown when a shared chat/MCP tool call is denied by a scope, ownership, or policy check
 * (requireScope, assertAppScope, assertFormInScope, ownApp, ownForm, the cloud-entitlement
 * gate, or a chat-surface refusal such as unknown_tool / the non-destructive update_form
 * guard) — as opposed to an ordinary input-validation \Exception. Carries a short, stable
 * machine-readable reason code alongside the human message so both surfaces can audit and
 * map denials without parsing message text:
 *   - the MCP surface (McpController) audits 'mcp.denied' rows from it (its own
 *     McpDeniedException extends this class, so one catch covers both);
 *   - the chat surface (ChatToolsController / AIController tool loop) maps the reason code
 *     onto the typed wire errors of plan Phase 6 (§5.4/§5.8).
 */
class ChatToolDeniedException extends \Exception
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

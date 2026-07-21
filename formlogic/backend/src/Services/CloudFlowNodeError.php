<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * A node-level failure inside a cloud flow run (docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md §5.7).
 * Carries the flow-run-result schema's closed error-code set plus the failing node id —
 * the same envelope the desktop Rust runner produces, so run history renders both uniformly.
 */
class CloudFlowNodeError extends \RuntimeException
{
    public function __construct(
        public readonly string $flowErrorCode,
        string $message,
        public readonly ?string $nodeId = null,
    ) {
        parent::__construct($message);
    }
}

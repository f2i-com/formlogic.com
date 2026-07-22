<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * Optimistic-concurrency refusal for flow updates (extensible-flows plan §14.2): the caller
 * sent `expectedVersion` and the stored flow has moved past it. Controllers map this to
 * HTTP 409 `revision_conflict` carrying the current version so the client can reload and
 * rebase instead of silently clobbering a concurrent edit.
 */
class FlowRevisionConflictException extends \RuntimeException
{
    public function __construct(public readonly int $currentVersion)
    {
        parent::__construct("Flow was modified concurrently (current version {$currentVersion})");
    }
}

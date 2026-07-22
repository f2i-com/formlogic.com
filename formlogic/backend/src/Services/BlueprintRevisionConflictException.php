<?php

declare(strict_types=1);

namespace FormLogic\Services;

/** Stale baseSemanticRevision on a blueprint operation batch → HTTP 409 revision_conflict. */
class BlueprintRevisionConflictException extends \RuntimeException
{
    public function __construct(public readonly int $currentRevision)
    {
        parent::__construct('Blueprint semantic revision conflict');
    }
}

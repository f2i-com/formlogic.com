<?php

declare(strict_types=1);

namespace FormLogic\Services\Flows;

/**
 * A ZIPP-era Desktop whose last heartbeat did not report its engine healthy asked to run a flow
 * (FlowLogicLanguages::desktopRuns gave []). Thrown before any row is written; controllers
 * answer 409 engine_unavailable — the code OAIY's own CLI uses for the same condition, so a
 * Desktop reads one vocabulary. The message stays the bare code, like 'language_unsupported'.
 */
final class DesktopEngineUnavailableException extends \RuntimeException
{
    public const CODE = 'engine_unavailable';

    public function __construct()
    {
        parent::__construct(self::CODE);
    }
}

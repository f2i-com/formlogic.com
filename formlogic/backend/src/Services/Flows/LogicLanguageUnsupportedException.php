<?php

declare(strict_types=1);

namespace FormLogic\Services\Flows;

/**
 * A caller asked to reserve or claim a flow whose code needs a language it did not declare
 * (FlowLogicLanguages). Thrown before any row is written; controllers answer 409
 * language_unsupported. The message stays the bare code, like 'already_claimed'.
 */
final class LogicLanguageUnsupportedException extends \RuntimeException
{
    /** @param list<string> $languages what the caller lacks */
    public function __construct(public readonly array $languages)
    {
        parent::__construct('language_unsupported');
    }
}

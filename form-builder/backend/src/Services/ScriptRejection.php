<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * DTO representing a script-triggered submission rejection
 */
class ScriptRejection
{
    public function __construct(
        public readonly string $message
    ) {}
}

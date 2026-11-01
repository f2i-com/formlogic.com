<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * A record couldn't be stored once the form's script had made an HTTP request. Nothing was stored,
 * but what the script did can't be taken back, so this is not a refusal anything may send again by
 * itself: a queue that did would charge a card twice. A person can decide to.
 */
final class NotStoredAfterScript extends \RuntimeException
{
    public function __construct(\Throwable $previous)
    {
        parent::__construct(
            "Your answers could not be saved, but this form's script has already run. Please check with the form's owner before sending them again. If sending them again is refused, reload this page.",
            0,
            $previous,
        );
    }
}

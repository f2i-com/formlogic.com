<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * An account has used up its budget of answers to two-factor code prompts
 * (MfaService::SECOND_FACTOR_MAX_ATTEMPTS), so the answer just given was not read. Controllers
 * map this to a 429 — the wait is in the message.
 */
class SecondFactorLockedException extends \RuntimeException
{
    public function __construct(int $minutesLeft)
    {
        parent::__construct(
            'Too many incorrect verification codes for this account. Please try again in ' . $minutesLeft . ' minute(s).'
        );
    }
}

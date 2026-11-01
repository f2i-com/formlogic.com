<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * A form's cap on records turned a submission away, and nothing was stored. Either the form is
 * full, or `busy`: its lock couldn't be had, so nobody can say that it isn't, and the submitter
 * can try again.
 */
class FormQuotaRefused extends \RuntimeException
{
    private function __construct(string $message, public readonly bool $busy)
    {
        parent::__construct($message);
    }

    public static function full(): self
    {
        return new self('This form has reached its maximum number of responses.', false);
    }

    public static function busy(): self
    {
        return new self('The form is busy — please retry in a moment.', true);
    }
}

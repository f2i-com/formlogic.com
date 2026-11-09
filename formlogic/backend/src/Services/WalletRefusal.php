<?php

declare(strict_types=1);

namespace FormLogic\Services;

/** Why a wallet request was refused, in words for the visitor, with a code and the HTTP status to answer. */
final class WalletRefusal extends \RuntimeException
{
    public function __construct(string $message, public readonly string $reason, public readonly int $status = 400)
    {
        parent::__construct($message, $status);
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * Why a recording was not put into words (AppListening), in a plain sentence for the page, with a
 * code and the HTTP status to answer: `listen_off` (403), `invalid_audio` (400), `too_long` (413),
 * `limit_reached` (429: an AI allowance is spent, AppAiService::takeForListening) or
 * `listen_failed` (502).
 */
final class ListenRefusal extends \RuntimeException
{
    public function __construct(string $message, public readonly string $reason, public readonly int $status = 400)
    {
        parent::__construct($message, $status);
    }
}

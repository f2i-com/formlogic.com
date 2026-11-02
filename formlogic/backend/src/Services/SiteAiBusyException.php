<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * The site's OAIY cannot take a turn now: its computer is offline, or as many turns wait as it
 * takes. Answered at once with 503 and Retry-After, rather than holding a worker while it waits.
 */
final class SiteAiBusyException extends \RuntimeException
{
    public const RETRY_AFTER_SECONDS = 15;

    /** 'site_ai_busy' or 'site_ai_offline', the code the answer carries. */
    public function __construct(string $message, public readonly string $reason = 'site_ai_busy')
    {
        parent::__construct($message);
    }
}

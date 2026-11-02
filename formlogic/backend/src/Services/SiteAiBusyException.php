<?php

declare(strict_types=1);

namespace FormLogic\Services;

/** The site's OAIY has as many turns waiting as it takes: answered at once with 503 and Retry-After. */
final class SiteAiBusyException extends \RuntimeException
{
    public const RETRY_AFTER_SECONDS = 15;
}

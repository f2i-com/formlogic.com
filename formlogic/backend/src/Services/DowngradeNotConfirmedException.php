<?php

declare(strict_types=1);

namespace FormLogic\Services;

/** What is about to go in is older than what it can safely replace, and nobody said to go ahead. */
final class DowngradeNotConfirmedException extends \RuntimeException
{
}

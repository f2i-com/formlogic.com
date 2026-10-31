<?php

declare(strict_types=1);

namespace FormLogic\Services;

/** The staged package is older than what is running, and nobody said to install it anyway. */
final class DowngradeNotConfirmedException extends \RuntimeException
{
}

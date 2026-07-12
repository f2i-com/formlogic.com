<?php

declare(strict_types=1);

namespace FormLogic\Services;

/** A recycle-bin item is already claimed by a concurrent restore (HTTP 409). */
final class TrashConflictException extends \RuntimeException
{
}

<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * The staged package is not the one the admin reviewed (review FL-008: apply
 * binds to an exact package ID + content digest, so a concurrent re-stage can
 * never swap the bytes under a confirmed apply). Maps to HTTP 409.
 */
final class StagedPackageMismatchException extends \RuntimeException
{
    public function __construct(string $detail)
    {
        parent::__construct('The staged package changed since it was reviewed — ' . $detail);
    }
}

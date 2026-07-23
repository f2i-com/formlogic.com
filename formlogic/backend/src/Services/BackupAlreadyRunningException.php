<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * Another scheduled-backup run holds the cross-process lock (review FL-005).
 * Maps to HTTP 409 on the admin surface and a clean exit on the CLI.
 */
final class BackupAlreadyRunningException extends \RuntimeException
{
    public function __construct()
    {
        parent::__construct('A scheduled backup run is already in progress');
    }
}

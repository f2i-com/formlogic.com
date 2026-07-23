<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * Another stage/apply/discard/rollback holds the cross-process upgrade lock
 * (review FL-008). Maps to HTTP 409 on the admin surface.
 */
final class UpgradeInProgressException extends \RuntimeException
{
    public function __construct()
    {
        parent::__construct('Another upgrade operation is already in progress');
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Services;

/** The recycle bin could not keep a copy of something that was about to be deleted, so nothing was. */
final class TrashSnapshotException extends \RuntimeException
{
    public const ERROR_CODE = 'bin_unavailable';
}

<?php

declare(strict_types=1);

namespace FormLogic\Services;

/** The recycle bin could not keep a copy of something that was about to be deleted, so nothing was. */
final class TrashSnapshotException extends \RuntimeException
{
    public const ERROR_CODE = 'bin_unavailable';

    /**
     * Whether a person can sensibly go on without the copy. Not past a bad DATA_ENCRYPTION_KEY: that
     * stops every copy of everything, healthy or not, and the way on is to correct it.
     */
    public function canGoOn(): bool
    {
        return !($this->getPrevious() instanceof \FormLogic\Support\DataEncryptionException);
    }
}

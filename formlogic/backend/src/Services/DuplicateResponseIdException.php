<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * A private-form envelope carried a recordId that already exists (plan §6:
 * `recordId` is client-minted and must be unique — a duplicate is a 409, never
 * a silent overwrite or a server-reminted id, because the id is baked into the
 * envelope's AAD).
 */
final class DuplicateResponseIdException extends \RuntimeException
{
    public const ERROR_CODE = 'duplicate_record_id';

    public function __construct(string $message = 'A response with this recordId already exists (duplicate_record_id).')
    {
        parent::__construct($message);
    }
}

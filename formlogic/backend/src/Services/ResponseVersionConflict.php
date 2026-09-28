<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * An update was sent with `If-Match` for a version of the record that is no
 * longer the stored one: someone else changed it since the writer read it.
 * Nothing was written. The record as it is now travels with the refusal, so
 * the writer can merge and try again without another read.
 *
 * Extends RuntimeException only so an older catch site still refuses rather
 * than 500s; the API catches this first and answers 412.
 */
class ResponseVersionConflict extends \RuntimeException
{
    public const ERROR_CODE = 'version_conflict';

    /** @param array<string, mixed> $current */
    public function __construct(private array $current)
    {
        parent::__construct('The record has changed since it was read (version_conflict).');
    }

    /** @return array<string, mixed> */
    public function current(): array
    {
        return $this->current;
    }
}

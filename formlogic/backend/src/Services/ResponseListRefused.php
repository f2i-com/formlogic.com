<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * A list of a form's responses was asked for in a way its store cannot answer. A form bound to an
 * app's table (`nativeTableBinding`, NativeTableFormBridge) reads that table, and the table has no
 * answer for some of what a form's own store filters, orders and pages by. The request is refused
 * with the reason, never answered with the rows it did not ask for: a client that trusts the
 * list (a sync, an automation, an export) would take them for the answer.
 *
 * Controllers map it to a 400 with `$errorCode`.
 */
class ResponseListRefused extends \InvalidArgumentException
{
    /** The filter, order or cursor asked for is one the app's table cannot answer. */
    public const UNSUPPORTED = 'response_list_unsupported';
    /** The rows asked for are further into the table than it is read by offset. */
    public const PAST_OFFSET_LIMIT = 'response_list_offset_limit';

    public function __construct(string $message, public readonly string $errorCode = self::UNSUPPORTED)
    {
        parent::__construct($message);
    }
}

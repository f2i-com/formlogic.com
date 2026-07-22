<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * The §9.2 fail-closed gate (docs/E2EE_PRIVATE_FORMS_PLAN.md): thrown by any
 * content-dependent server surface — answer filters/sort/search, plaintext
 * response writes, CSV/SQL exports, webhook/flow-binding creation, chat/MCP
 * record tools, script recompute, field-data purge — when the target form is a
 * PRIVATE (end-to-end encrypted) form. The server holds ciphertext only and
 * must refuse loudly (typed `private_form_encrypted`), never degrade silently
 * to wrong/empty results (plan D6).
 *
 * The stable code rides in ERROR_CODE for controllers that map it onto the
 * canonical error shape, and inside the default message for legacy catch
 * paths that only surface message text.
 */
final class PrivateFormEncryptedException extends \RuntimeException
{
    public const ERROR_CODE = 'private_form_encrypted';

    public function __construct(
        string $message = 'This form is end-to-end encrypted — the server cannot read or process its answers (private_form_encrypted).'
    ) {
        parent::__construct($message);
    }
}

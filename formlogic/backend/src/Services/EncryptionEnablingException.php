<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * The §9.1 durable-enable gate (docs/E2EE_PRIVATE_FORMS_PLAN.md): thrown by
 * every mutation surface — response submit/update (plaintext AND envelope),
 * form publish/field saves, webhook/flow/integration mutations — while the
 * form's form_encryption row is in the transient 'enabling' state. Failing
 * closed here closes the enable race: no plaintext write, publish or
 * integration change can interleave between the enable preflight and commit.
 *
 * Extends PrivateFormEncryptedException so every pre-existing §9.2 catch site
 * still refuses (an enabling form looks "private" to legacy paths); the
 * contract surfaces catch THIS class first and emit the canonical
 * 409 { error:true, code:"encryption_enabling" } shape.
 */
final class EncryptionEnablingException extends PrivateFormEncryptedException
{
    public const ERROR_CODE = 'encryption_enabling';
    public const STATUS = 409;

    public function __construct(
        string $message = 'Encryption is being enabled for this form — retry in a moment.'
    ) {
        parent::__construct($message);
    }
}

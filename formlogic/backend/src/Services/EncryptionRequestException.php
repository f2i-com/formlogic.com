<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * A typed request failure from the E2EE vault / form-encryption services
 * (docs/E2EE_PRIVATE_FORMS_PLAN.md §9.1, §16-P2): carries the stable machine
 * code + HTTP status + optional structured details (e.g. the enable
 * preflight's `reasons` array) so controllers can emit the canonical
 * { error, message, code, details } shape without parsing message text.
 *
 * Codes in use: vault_not_found, vault_exists, vault_invalid,
 * vault_version_conflict, kdf_downgrade, encryption_unavailable,
 * private_enable_blocked, encryption_payload_invalid, manifest_invalid,
 * manifest_required, grant_invalid, private_form_not_encrypted,
 * import_remint_refused, encryption_not_restorable.
 */
final class EncryptionRequestException extends \RuntimeException
{
    /**
     * @param array<string,mixed>|null $details
     */
    public function __construct(
        public readonly string $errorCode,
        string $message,
        public readonly int $status = 400,
        public readonly ?array $details = null,
    ) {
        parent::__construct($message);
    }
}

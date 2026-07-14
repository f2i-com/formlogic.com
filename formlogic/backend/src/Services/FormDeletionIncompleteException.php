<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * A form's MySQL metadata was deleted, but its on-disk data (per-form SQLite database
 * and/or uploads) could not be verifiably removed (audit FL-DATA-001). The deletion
 * intent is durably recorded in the store_ops ledger, so the cleanup is retryable:
 * re-issue the delete, retry account erasure, or run `bin/reconcile.php --fix`.
 *
 * Callers must NOT report the deletion as complete — the stores still disagree.
 */
class FormDeletionIncompleteException extends \RuntimeException
{
}

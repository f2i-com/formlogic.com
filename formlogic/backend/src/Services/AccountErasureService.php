<?php

declare(strict_types=1);

namespace FormLogic\Services;

use Psr\Log\LoggerInterface;
use Psr\Log\NullLogger;

/**
 * Truthful, resumable account erasure (audit FL-005/FL-01) — the ONE engine
 * behind both the self-service DELETE /auth/me and the admin panel's
 * delete-user. Deletes every owned resource (apps, forms incl. per-form
 * SQLite databases + uploads, stalled cross-store cleanups, recycle-bin
 * snapshots) and drops the users row ONLY after the owned-resource inventory
 * verifies EMPTY. Any failure keeps the account intact and reports a
 * retryable partial result — every per-resource delete is idempotent, so a
 * failed erasure simply resumes on the next attempt.
 */
class AccountErasureService
{
    private LoggerInterface $logger;

    public function __construct(
        private AuthService $authService,
        private ?FormService $formService = null,
        private ?AppService $appService = null,
        private ?TrashService $trashService = null,
        ?LoggerInterface $logger = null,
        private ?\PDO $pdo = null,
    ) {
        $this->logger = $logger ?? new NullLogger();
    }

    /**
     * @return array{completed: bool, failedApps: int, failedForms: int, pendingCleanup: int, pendingTrash: int, pendingEncryption: int}
     */
    public function erase(string $userId): array
    {
        $failedApps = 0;
        $failedForms = 0;
        // E2EE (security review, blocker 6): the encryption tables deliberately
        // have NO cascading foreign keys — capture the owned form ids BEFORE the
        // delete loop so their vault/key/grant/manifest/schema rows can be purged
        // explicitly below (and verified empty before the account may drop).
        $encryptionFormIds = [];

        // Delete apps the user owns (membership of other people's apps is
        // removed via the user FK cascade on the users delete).
        if ($this->appService) {
            foreach ($this->appService->getAllApps($userId) as $app) {
                $owner = $app['ownerId'] ?? $app['owner_id'] ?? null;
                if ($owner === $userId && !empty($app['id'])) {
                    try {
                        $this->appService->deleteApp((string) $app['id']);
                    } catch (\Throwable $e) {
                        $failedApps++;
                        $this->logger->error('Account erasure: failed to delete app', ['appId' => $app['id'], 'userId' => $userId, 'error' => $e->getMessage()]);
                    }
                }
            }
        }

        // Delete ALL the user's forms (incl. their per-form response DB +
        // uploaded files). getAllForms defaults to 50, so loop until empty —
        // re-querying offset 0 each pass since rows are being removed. Without
        // this, forms beyond 50 leave orphaned SQLite DBs + PII files on disk
        // after a GDPR-erasure request. A pass that makes NO progress stops the
        // loop (a persistently-failing form must not spin the guard to 1000).
        if ($this->formService) {
            $guard = 0;
            do {
                $batch = $this->formService->getAllForms($userId, ['limit' => 50, 'offset' => 0]);
                $deletedThisPass = 0;
                $failedForms = 0; // per-pass: only the FINAL pass's failures matter
                foreach ($batch as $form) {
                    if (!empty($form['id'])) {
                        $encryptionFormIds[] = (string) $form['id'];
                        try {
                            $this->formService->deleteForm((string) $form['id']);
                            $deletedThisPass++;
                        } catch (\Throwable $e) {
                            $failedForms++;
                            $this->logger->error('Account erasure: failed to delete form', ['formId' => $form['id'], 'userId' => $userId, 'error' => $e->getMessage()]);
                        }
                    }
                }
            } while (count($batch) > 0 && $deletedThisPass > 0 && ++$guard < 1000);
        }

        // Cross-session stragglers (audit FL-DATA-001): a prior delete may have
        // removed a form's metadata row while its on-disk cleanup failed — those
        // forms no longer appear in getAllForms, but their durable form_delete ops
        // do. Resume them from the ledger, then require it EMPTY below: the users
        // row must never drop while deleted-form PII may still sit on disk.
        $pendingCleanup = 0;
        if ($this->formService) {
            try {
                $this->formService->retryPendingCleanup($userId);
                $pendingCleanup = $this->formService->pendingCleanupCount($userId);
            } catch (\Throwable $e) {
                $pendingCleanup = 1; // fail closed — keep the account until verified
                $this->logger->error('Account erasure: pending-cleanup retry failed', ['userId' => $userId, 'error' => $e->getMessage()]);
            }
        }

        // Recycle bin: the erasure loops above delete via the SERVICES (never
        // TrashService — erasure must not stash data), but the user's existing
        // bin snapshots contain record PII and must go too. purgeUser returns
        // the number of traces REMAINING (fail-closed), joining the guard below.
        $trashRemaining = 0;
        if ($this->trashService !== null) {
            $trashRemaining = $this->trashService->purgeUser($userId);
        }

        // E2EE (blocker 6): explicit, transactional purge of the encryption tables
        // (user_vaults, form_key_grants, form_manifests, form_ingestion_keys,
        // form_schema_versions, form_encryption) — they lack FK cascades by design,
        // so without this an erased account leaves its vault + every grant/manifest
        // behind. response_metadata needs no extra handling: private-form rows are
        // cascade-deleted with the form, and §12 already minimizes what they hold.
        $pendingEncryption = $this->purgeEncryptionArtifacts($userId, $encryptionFormIds);

        // Truthful completion: NEVER drop the user row while owned resources
        // remain — every per-resource delete is idempotent, so a failed erasure
        // is RESUMABLE: the account stays intact and the caller simply retries.
        $remainingForms = $this->formService
            ? count($this->formService->getAllForms($userId, ['limit' => 1, 'offset' => 0]))
            : 0;
        if ($failedApps > 0 || $failedForms > 0 || $remainingForms > 0 || $pendingCleanup > 0 || $trashRemaining > 0 || $pendingEncryption > 0) {
            return [
                'completed' => false,
                'failedApps' => $failedApps,
                'failedForms' => $failedForms,
                'pendingCleanup' => $pendingCleanup,
                'pendingTrash' => $trashRemaining,
                'pendingEncryption' => $pendingEncryption,
            ];
        }

        $this->authService->deleteAccount($userId);
        return ['completed' => true, 'failedApps' => 0, 'failedForms' => 0, 'pendingCleanup' => 0, 'pendingTrash' => 0, 'pendingEncryption' => 0];
    }

    /**
     * Delete the account's E2EE artifacts: the user_vaults row, every grant the
     * user holds (including grants on OTHER owners' forms — the grantee material
     * is the erased user's), and the full per-form rows for each of the user's
     * forms. One transaction with a zero-row verification INSIDE it — any
     * remainder rolls the purge back and reports non-zero (fail-closed, so the
     * erasure guard keeps the account and the next attempt resumes).
     *
     * @param list<string> $formIds form ids captured BEFORE the delete loop
     * @return int encryption rows REMAINING (0 = clean)
     */
    private function purgeEncryptionArtifacts(string $userId, array $formIds): int
    {
        if ($this->pdo === null) {
            return 0; // no DB handle (narrow test doubles) — nothing to purge through
        }
        try {
            // Also cover forms already hard-deleted before this run (trashed/parked
            // rows the delete loop never saw): enabled_by survives the forms row.
            $stmt = $this->pdo->prepare('SELECT form_id FROM form_encryption WHERE enabled_by = :u');
            $stmt->execute(['u' => $userId]);
            $formIds = array_values(array_unique(array_merge($formIds, array_map('strval', $stmt->fetchAll(\PDO::FETCH_COLUMN)))));

            $this->pdo->beginTransaction();
            $this->pdo->prepare('DELETE FROM form_key_grants WHERE user_id = :u')->execute(['u' => $userId]);
            $this->pdo->prepare('DELETE FROM user_vaults WHERE user_id = :u')->execute(['u' => $userId]);
            foreach ($formIds as $formId) {
                // Dependency order: grants/manifests/keys/schemas reference the
                // form's encryption row, which goes last.
                foreach (['form_key_grants', 'form_manifests', 'form_ingestion_keys', 'form_schema_versions', 'form_encryption'] as $table) {
                    $this->pdo->prepare("DELETE FROM {$table} WHERE form_id = :f")->execute(['f' => $formId]);
                }
            }

            $remaining = 0;
            $v = $this->pdo->prepare('SELECT COUNT(*) FROM user_vaults WHERE user_id = :u');
            $v->execute(['u' => $userId]);
            $remaining += (int) $v->fetchColumn();
            $g = $this->pdo->prepare('SELECT COUNT(*) FROM form_key_grants WHERE user_id = :u');
            $g->execute(['u' => $userId]);
            $remaining += (int) $g->fetchColumn();
            foreach ($formIds as $formId) {
                foreach (['form_key_grants', 'form_manifests', 'form_ingestion_keys', 'form_schema_versions', 'form_encryption'] as $table) {
                    $c = $this->pdo->prepare("SELECT COUNT(*) FROM {$table} WHERE form_id = :f");
                    $c->execute(['f' => $formId]);
                    $remaining += (int) $c->fetchColumn();
                }
            }

            if ($remaining > 0) {
                $this->pdo->rollBack();
                $this->logger->error('Account erasure: encryption purge verification failed', ['userId' => $userId, 'remaining' => $remaining]);
                return $remaining;
            }
            $this->pdo->commit();
            return 0;
        } catch (\Throwable $e) {
            if ($this->pdo->inTransaction()) {
                $this->pdo->rollBack();
            }
            $this->logger->error('Account erasure: encryption purge failed', ['userId' => $userId, 'error' => $e->getMessage()]);
            return 1; // fail closed — keep the account until verified clean
        }
    }
}

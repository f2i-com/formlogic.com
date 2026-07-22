<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use PDO;
use Psr\Log\LoggerInterface;
use Psr\Log\NullLogger;

/**
 * Recycle bin: delete = snapshot first, then the SAME hard delete as before.
 *
 * User-facing deletes of forms/apps/flows capture a restorable snapshot zip
 * (AccountBackupService::exportScoped — the account-backup format) into
 * storage/trash/<userId>/<trashId>.zip plus a trash_items row, then run the
 * existing delete unchanged. Nothing on any read path changes: ids and slugs
 * free immediately, and no query anywhere needs a deleted_at filter.
 *
 * Restore re-imports the snapshot in restore mode (preserve ids, re-attach
 * surviving forms/apps, rebuild inbound links) — a TRUE undelete when the
 * original ids are still free, a copy otherwise. A restore CONSUMES the item
 * (claimed atomically via status='restoring', so concurrent restores can't
 * double-create). Items expire after trash.retentionDays (default 30); the
 * nightly maintenance run (bin/backup-accounts.php) purges expired snapshots,
 * with an hour-throttled opportunistic purge on bin reads as backup.
 *
 * NEVER routed through here: account erasure (purgeUser wipes the bin instead
 * — erasure must not stash data), pack-install rollbacks, import compensation,
 * and empty drafts (0 fields + 0 responses hard-delete without a snapshot).
 */
final class TrashService
{
    private const PURGE_STAMP_KEY = 'trash_purge_last_run';

    private PDO $pdo;
    private string $trashDir;
    private int $retentionDays;
    private LoggerInterface $logger;

    public function __construct(
        MySQLConnection $mysql,
        private SQLiteConnection $sqlite,
        private AccountBackupService $backup,
        private FormService $formService,
        private AppService $appService,
        private FlowService $flowService,
        array $trashConfig = [],
        ?LoggerInterface $logger = null,
        private ?FormEncryptionService $formEncryption = null,
    ) {
        $this->pdo = $mysql->getConnection();
        $this->retentionDays = max(1, (int) ($trashConfig['retentionDays'] ?? 30));
        // 'dir' is a test override; production derives from the backend root.
        $this->trashDir = rtrim((string) ($trashConfig['dir'] ?? dirname(__DIR__, 2) . '/storage/trash'), '/\\');
        $this->logger = $logger ?? new NullLogger();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Trash (snapshot + delete)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Snapshot + delete a form. The empty-draft guard (0 fields AND 0
     * responses) skips the snapshot — purgeEmptyForms noise and abandoned
     * drafts don't belong in the bin (trashed=false tells the UI not to
     * promise a restore).
     *
     * A FormDeletionIncompleteException still COMMITS the snapshot before
     * rethrowing: the metadata row is gone and the deletion is durably in
     * progress — the data must stay recoverable.
     *
     * @return array{deleted: bool, trashed: bool}
     */
    public function trashForm(string $formId, string $userId): array
    {
        $pending = $this->capturePendingForm($formId, $userId);
        if ($pending === null) {
            $deleted = $this->formService->deleteForm($formId);
            if ($deleted) {
                // Hard delete with NO bin entry (empty draft): a private form's
                // encryption rows have nothing to be restored for — purge them.
                $this->formEncryptionLifecycle('purge', $formId);
            }
            return ['deleted' => $deleted, 'trashed' => false];
        }
        try {
            $deleted = $this->formService->deleteForm($formId);
        } catch (FormDeletionIncompleteException $e) {
            $this->commitPending($pending);
            $this->formEncryptionLifecycle('trash', $formId);
            throw $e;
        } catch (\Throwable $e) {
            $this->discardPending($pending);
            throw $e;
        }
        if (!$deleted) {
            $this->discardPending($pending);
            return ['deleted' => false, 'trashed' => false];
        }
        $this->commitPending($pending);
        // E2EE (plan §7): key/grant rows are PARKED, never deleted, while the form
        // sits in the bin — restore flips them back; purge removes them.
        $this->formEncryptionLifecycle('trash', $formId);
        return ['deleted' => true, 'trashed' => true];
    }

    /** Snapshot + delete an app (its flows/bindings/roles cascade-die; member forms survive). */
    public function trashApp(string $appId, string $userId): bool
    {
        $app = $this->appService->getApp($appId);
        if (!$app) {
            return false;
        }
        $pending = $this->capture('app', $appId, $userId, (string) ($app['name'] ?? 'App'), [
            'slug' => $app['slug'] ?? null,
        ]);
        try {
            $deleted = $this->appService->deleteApp($appId);
        } catch (\Throwable $e) {
            $this->discardPending($pending);
            throw $e;
        }
        if (!$deleted) {
            $this->discardPending($pending);
            return false;
        }
        $this->commitPending($pending);
        return true;
    }

    /** Snapshot + delete an app flow (bindings cascade with it and are in the snapshot). */
    public function trashFlow(string $appId, string $flowId, string $userId): bool
    {
        $flow = $this->flowService->getFlow($appId, $flowId);
        if (!$flow) {
            return false;
        }
        $pending = $this->capture('flow', $flowId, $userId, (string) ($flow['name'] ?? 'Flow'), [
            'appId' => $appId,
            'slug' => $flow['slug'] ?? null,
        ]);
        try {
            $deleted = $this->flowService->deleteFlow($appId, $flowId);
        } catch (\Throwable $e) {
            $this->discardPending($pending);
            throw $e;
        }
        if (!$deleted) {
            $this->discardPending($pending);
            return false;
        }
        $this->commitPending($pending);
        return true;
    }

    /** Snapshot + delete a workspace flow (its form bindings are in the snapshot). */
    public function trashWorkspaceFlow(string $flowId, string $userId): bool
    {
        $flow = $this->flowService->getWorkspaceFlow($userId, $flowId);
        if (!$flow) {
            return false;
        }
        $pending = $this->capture('flow', $flowId, $userId, (string) ($flow['name'] ?? 'Flow'), [
            'appId' => null,
            'slug' => $flow['slug'] ?? null,
        ]);
        try {
            $deleted = $this->flowService->deleteWorkspaceFlow($userId, $flowId);
        } catch (\Throwable $e) {
            $this->discardPending($pending);
            throw $e;
        }
        if (!$deleted) {
            $this->discardPending($pending);
            return false;
        }
        $this->commitPending($pending);
        return true;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Pack uninstall pre-capture (uninstallPack hard-deletes record-bearing forms)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Capture snapshots of an installation's RECORD-BEARING forms before
     * uninstallPack deletes them (apps aren't snapshotted — reinstallable from
     * the pack; recordless forms aren't worth a bin entry). Call
     * commitCapturedForms() with the result AFTER the uninstall: each pending
     * capture commits only if its form is actually gone.
     *
     * @return array[] pending capture handles
     */
    public function captureRecordBearingForms(string $installationId, string $userId): array
    {
        $stmt = $this->pdo->prepare('SELECT form_ids FROM pack_installations WHERE id = :id AND user_id = :u');
        $stmt->execute(['id' => $installationId, 'u' => $userId]);
        $raw = $stmt->fetchColumn();
        if (!is_string($raw)) {
            return [];
        }
        $formIds = json_decode($raw, true);
        $pendings = [];
        foreach (is_array($formIds) ? $formIds : [] as $formId) {
            try {
                $owned = $this->pdo->prepare('SELECT 1 FROM forms WHERE id = :id AND user_id = :u');
                $owned->execute(['id' => (string) $formId, 'u' => $userId]);
                if ($owned->fetchColumn() === false || !$this->formHasResponses((string) $formId)) {
                    continue;
                }
                $pending = $this->capturePendingForm((string) $formId, $userId);
                if ($pending !== null) {
                    $pendings[] = $pending;
                }
            } catch (\Throwable $e) {
                // A failed capture must not block the uninstall the user asked for.
                $this->logger->warning('Trash: pack-form capture failed', ['formId' => $formId, 'error' => $e->getMessage()]);
            }
        }
        return $pendings;
    }

    /** @param array[] $pendings from captureRecordBearingForms() */
    public function commitCapturedForms(array $pendings): void
    {
        foreach ($pendings as $pending) {
            $exists = $this->pdo->prepare('SELECT 1 FROM forms WHERE id = :id');
            $exists->execute(['id' => $pending['row']['original_id']]);
            if ($exists->fetchColumn() === false) {
                $this->commitPending($pending); // uninstall really deleted it
                $this->formEncryptionLifecycle('trash', (string) $pending['row']['original_id']);
            } else {
                $this->discardPending($pending); // skipped/failed — form still live
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // List / restore / purge
    // ─────────────────────────────────────────────────────────────────────────

    /** @return array[] the user's bin, newest first (opportunistic purge piggybacks) */
    public function listTrash(string $userId): array
    {
        $this->purgeExpiredThrottled();
        $stmt = $this->pdo->prepare('SELECT * FROM trash_items WHERE user_id = :u ORDER BY deleted_at DESC');
        $stmt->execute(['u' => $userId]);
        return array_map([$this, 'formatItem'], $stmt->fetchAll(PDO::FETCH_ASSOC));
    }

    public function countTrash(string $userId): int
    {
        $stmt = $this->pdo->prepare('SELECT COUNT(*) FROM trash_items WHERE user_id = :u');
        $stmt->execute(['u' => $userId]);
        return (int) $stmt->fetchColumn();
    }

    public function getItem(string $trashId, string $userId): ?array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM trash_items WHERE id = :id AND user_id = :u');
        $stmt->execute(['id' => $trashId, 'u' => $userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row === false ? null : $this->formatItem($row);
    }

    /**
     * Restore an item: atomic claim → restore-mode import (original ids when
     * free) → the item is CONSUMED (row + zip deleted). On failure the claim
     * is released and the item stays restorable.
     *
     * @throws \RuntimeException      not found / snapshot missing / import failure
     * @throws TrashConflictException already claimed by a concurrent restore
     * @return array{item: array, restored: array}
     */
    public function restore(string $trashId, string $userId): array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM trash_items WHERE id = :id AND user_id = :u');
        $stmt->execute(['id' => $trashId, 'u' => $userId]);
        $item = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($item === false) {
            throw new \RuntimeException('Recycle bin item not found');
        }

        $claim = $this->pdo->prepare("UPDATE trash_items SET status = 'restoring' WHERE id = :id AND user_id = :u AND status = 'trashed'");
        $claim->execute(['id' => $trashId, 'u' => $userId]);
        if ($claim->rowCount() !== 1) {
            throw new TrashConflictException('This item is already being restored');
        }

        $zipAbs = $this->trashDir . '/' . $item['zip_path'];
        try {
            if (!is_file($zipAbs)) {
                throw new \RuntimeException('The snapshot file for this item is missing from the server');
            }
            $summary = $this->backup->importAccount($zipAbs, $userId, [
                'preserveIds' => true,
                'attachExistingForms' => true,
                'attachExistingApps' => true,
                'lenientFormBindings' => true,
                'rebuildInboundLinks' => true,
            ]);
        } catch (\Throwable $e) {
            $release = $this->pdo->prepare("UPDATE trash_items SET status = 'trashed' WHERE id = :id");
            $release->execute(['id' => $trashId]);
            throw $e;
        }

        // Consumed ONLY after the crypto lifecycle succeeded (security review):
        // the parked key/grant flips and the trash_items delete commit in ONE
        // transaction, so a lifecycle failure rolls the WHOLE restore back —
        // imported resources removed, claim released, snapshot kept — instead of
        // consuming the recovery zip first and stranding the restored form
        // without its encryption rows.
        try {
            $this->pdo->beginTransaction();
            if (($item['kind'] ?? '') === 'form') {
                // E2EE: a restored private form gets its parked key/grant rows back
                // ('trashed' → 'active'); manifests never moved.
                $this->formEncryptionLifecycle('restore', (string) $item['original_id'], true);
            }
            $this->pdo->prepare('DELETE FROM trash_items WHERE id = :id')->execute(['id' => $trashId]);
            $this->pdo->commit();
        } catch (\Throwable $e) {
            if ($this->pdo->inTransaction()) {
                $this->pdo->rollBack();
            }
            // Roll the import back too (hard delete — the retained bin item IS the
            // recovery copy), so a retry starts from the exact pre-restore state
            // instead of dead-ending on the now-occupied original id.
            foreach (($summary['forms'] ?? []) as $restoredForm) {
                try {
                    $this->formService->deleteForm((string) ($restoredForm['id'] ?? ''));
                } catch (\Throwable $cleanupError) {
                    $this->logger->error('Trash: restore rollback could not remove the restored form', [
                        'formId' => $restoredForm['id'] ?? '', 'error' => $cleanupError->getMessage(),
                    ]);
                }
            }
            $release = $this->pdo->prepare("UPDATE trash_items SET status = 'trashed' WHERE id = :id");
            $release->execute(['id' => $trashId]);
            throw $e;
        }
        // A second restore of the same snapshot would only make copies.
        @unlink($zipAbs);

        return ['item' => $this->formatItem($item), 'restored' => $summary];
    }

    /** "Delete forever". False when the item doesn't exist or is mid-restore. */
    public function purgeItem(string $trashId, string $userId): bool
    {
        $stmt = $this->pdo->prepare("SELECT zip_path, kind, original_id FROM trash_items WHERE id = :id AND user_id = :u AND status = 'trashed'");
        $stmt->execute(['id' => $trashId, 'u' => $userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!is_array($row) || !is_string($row['zip_path'])) {
            return false;
        }
        // E2EE (security review): "delete forever" removes the form's parked
        // key/grant/manifest rows in the SAME transaction as the item delete,
        // BEFORE the recovery zip is touched — a crypto-lifecycle failure rolls
        // both back (row + zip intact) instead of consuming the snapshot first.
        try {
            $this->pdo->beginTransaction();
            if (($row['kind'] ?? '') === 'form') {
                $this->formEncryptionLifecycle('purge', (string) $row['original_id'], true);
            }
            $del = $this->pdo->prepare("DELETE FROM trash_items WHERE id = :id AND user_id = :u AND status = 'trashed'");
            $del->execute(['id' => $trashId, 'u' => $userId]);
            if ($del->rowCount() !== 1) {
                $this->pdo->rollBack();
                return false;
            }
            $this->pdo->commit();
        } catch (\Throwable $e) {
            if ($this->pdo->inTransaction()) {
                $this->pdo->rollBack();
            }
            $this->logger->error('Trash: purge failed — item and snapshot left intact', [
                'trashId' => $trashId, 'error' => $e->getMessage(),
            ]);
            return false;
        }
        @unlink($this->trashDir . '/' . $row['zip_path']);
        return true;
    }

    /**
     * Cron purge: expired rows + their zips, plus an orphan-zip sweep (files
     * with no row, past retention — leftovers from failed commits/unlinks).
     *
     * @return array{items:int, orphans:int}
     */
    public function purgeExpired(): array
    {
        $items = 0;
        $stmt = $this->pdo->query('SELECT id, zip_path, kind, original_id FROM trash_items WHERE expires_at < NOW()');
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            // The crypto purge commits in the SAME transaction as the row delete,
            // BEFORE the zip is unlinked — a failure keeps the item (row + zip)
            // so the next cron run retries instead of losing the recovery data.
            try {
                $this->pdo->beginTransaction();
                if (($row['kind'] ?? '') === 'form') {
                    $this->formEncryptionLifecycle('purge', (string) $row['original_id'], true);
                }
                $this->pdo->prepare('DELETE FROM trash_items WHERE id = :id')->execute(['id' => $row['id']]);
                $this->pdo->commit();
            } catch (\Throwable $e) {
                if ($this->pdo->inTransaction()) {
                    $this->pdo->rollBack();
                }
                $this->logger->error('Trash: expired-item purge failed — item kept for retry', [
                    'trashId' => $row['id'], 'error' => $e->getMessage(),
                ]);
                continue;
            }
            @unlink($this->trashDir . '/' . $row['zip_path']);
            $items++;
        }

        $orphans = 0;
        $cutoff = time() - ($this->retentionDays + 1) * 86400;
        foreach (glob($this->trashDir . '/*/*.zip') ?: [] as $abs) {
            if ((int) @filemtime($abs) >= $cutoff) {
                continue;
            }
            $check = $this->pdo->prepare('SELECT 1 FROM trash_items WHERE id = :id');
            $check->execute(['id' => basename($abs, '.zip')]);
            if ($check->fetchColumn() === false && @unlink($abs)) {
                $orphans++;
            }
        }
        return ['items' => $items, 'orphans' => $orphans];
    }

    /**
     * Account erasure: wipe the user's bin (rows + zips + dir). Returns the
     * number of traces REMAINING (0 = clean) — fail-CLOSED, so the erasure
     * guard keeps the account alive while snapshot PII may still sit on disk.
     */
    public function purgeUser(string $userId): int
    {
        try {
            $stmt = $this->pdo->prepare('SELECT id, zip_path, kind, original_id FROM trash_items WHERE user_id = :u');
            $stmt->execute(['u' => $userId]);
            foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
                // Crypto purge FIRST, strictly: a lifecycle failure keeps the row +
                // zip so the fail-closed count below retains the account.
                if (($row['kind'] ?? '') === 'form') {
                    $this->formEncryptionLifecycle('purge', (string) $row['original_id'], true);
                }
                $this->pdo->prepare('DELETE FROM trash_items WHERE id = :id')->execute(['id' => $row['id']]);
                @unlink($this->trashDir . '/' . $row['zip_path']);
            }
            $userDir = $this->trashDir . '/' . $this->safeSegment($userId);
            if (is_dir($userDir)) {
                foreach (glob($userDir . '/*') ?: [] as $leftover) {
                    @unlink($leftover);
                }
                @rmdir($userDir);
            }

            $count = $this->pdo->prepare('SELECT COUNT(*) FROM trash_items WHERE user_id = :u');
            $count->execute(['u' => $userId]);
            $remaining = (int) $count->fetchColumn();
            clearstatcache();
            if (is_dir($userDir)) {
                $remaining += count(glob($userDir . '/*.zip') ?: []);
            }
            return $remaining;
        } catch (\Throwable $e) {
            $this->logger->error('Trash: erasure purge failed', ['userId' => $userId, 'error' => $e->getMessage()]);
            return 1; // fail closed
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Capture internals
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Snapshot a form into a pending handle (commit/discard later). Null when
     * the form doesn't exist or is an empty draft (guard is SERVER-side — the
     * UI's purgeEmptyForms calls the same DELETE route).
     *
     * @return array{zipTmp:string, row:array}|null
     */
    public function capturePendingForm(string $formId, string $userId): ?array
    {
        $form = $this->formService->getForm($formId);
        if (!$form) {
            return null;
        }
        if (empty($form['fields']) && !$this->formHasResponses($formId)) {
            return null; // empty draft — hard-delete without a bin entry
        }
        return $this->capture('form', $formId, $userId, (string) ($form['title'] ?? 'Form'), []);
    }

    /** @return array{zipTmp:string, row:array} */
    private function capture(string $kind, string $id, string $userId, string $name, array $extraMeta): array
    {
        $zipTmp = $this->backup->exportScoped($userId, $kind, $id);

        // The zip's own manifest already counted everything worth showing.
        $meta = $extraMeta;
        try {
            $zip = new \ZipArchive();
            if ($zip->open($zipTmp) === true) {
                $manifest = json_decode((string) $zip->getFromName('manifest.json'), true);
                if (is_array($manifest['counts'] ?? null)) {
                    $meta['counts'] = $manifest['counts'];
                }
                $zip->close();
            }
        } catch (\Throwable $e) {
            // counts are informational only
        }

        return [
            'zipTmp' => $zipTmp,
            'row' => [
                'id' => $this->generateUuid(),
                'user_id' => $userId,
                'kind' => $kind,
                'original_id' => $id,
                'name' => mb_substr($name, 0, 255),
                'size_bytes' => (int) (is_file($zipTmp) ? filesize($zipTmp) : 0),
                'meta' => $meta,
            ],
        ];
    }

    /**
     * Move the snapshot into the bin + insert the row. Called AFTER the delete
     * succeeded, so a failure here must not fail the request (the resource IS
     * deleted) — it logs loudly and leaves the zip for the orphan sweep.
     */
    private function commitPending(array $pending): void
    {
        $row = $pending['row'];
        try {
            $userDir = $this->trashDir . '/' . $this->safeSegment((string) $row['user_id']);
            if (!is_dir($userDir) && !mkdir($userDir, 0700, true) && !is_dir($userDir)) {
                throw new \RuntimeException('Could not create the trash directory');
            }
            $rel = $this->safeSegment((string) $row['user_id']) . '/' . $row['id'] . '.zip';
            $dest = $this->trashDir . '/' . $rel;
            if (!@rename($pending['zipTmp'], $dest)) {
                // Cross-device or locked-handle fallback.
                if (!copy($pending['zipTmp'], $dest)) {
                    throw new \RuntimeException('Could not move the snapshot into the trash directory');
                }
                @unlink($pending['zipTmp']);
            }

            $stmt = $this->pdo->prepare('
                INSERT INTO trash_items (id, user_id, kind, original_id, name, zip_path, size_bytes, meta, status, expires_at)
                VALUES (:id, :u, :kind, :oid, :name, :zip, :size, :meta, \'trashed\', DATE_ADD(NOW(), INTERVAL ' . $this->retentionDays . ' DAY))
            ');
            $stmt->execute([
                'id' => $row['id'],
                'u' => $row['user_id'],
                'kind' => $row['kind'],
                'oid' => $row['original_id'],
                'name' => $row['name'],
                'zip' => $rel,
                'size' => $row['size_bytes'],
                'meta' => json_encode($row['meta'], JSON_UNESCAPED_SLASHES),
            ]);
        } catch (\Throwable $e) {
            $this->logger->error('Trash: could not record the snapshot — the delete succeeded but the item will NOT appear in the recycle bin', [
                'kind' => $row['kind'], 'originalId' => $row['original_id'], 'error' => $e->getMessage(),
            ]);
        }
    }

    private function discardPending(array $pending): void
    {
        @unlink($pending['zipTmp']);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * E2EE key-row lifecycle beside the bin (docs/E2EE_PRIVATE_FORMS_PLAN.md §7):
     * trash parks form_encryption / form_ingestion_keys / form_key_grants rows as
     * 'trashed' (manifests are append-only and stay put); restore flips them back
     * to 'active'; purge hard-deletes every encryption row for the form.
     *
     * Two modes: the trash-time calls are best-effort AFTER the authoritative
     * delete succeeded (a failure logs loudly but never fails the user's
     * request); restore/purge callers pass $strict so the lifecycle runs INSIDE
     * their transaction and any failure rolls the whole operation back — the
     * recovery zip is only consumed after the crypto rows really moved
     * (security review: never consume-then-best-effort).
     */
    private function formEncryptionLifecycle(string $op, string $formId, bool $strict = false): void
    {
        if ($formId === '') {
            return;
        }
        try {
            $enc = $this->formEncryption ?? new FormEncryptionService($this->pdo, $this->sqlite);
            match ($op) {
                'trash' => $enc->markFormTrashed($formId),
                'restore' => $enc->markFormRestored($formId),
                'purge' => $enc->purgeFormRows($formId),
                default => null,
            };
        } catch (\Throwable $e) {
            $this->logger->error('Trash: form-encryption lifecycle step failed', [
                'op' => $op, 'formId' => $formId, 'error' => $e->getMessage(),
            ]);
            if ($strict) {
                throw $e;
            }
        }
    }

    private function formHasResponses(string $formId): bool
    {
        if (!$this->sqlite->formDatabaseExists($formId)) {
            return false;
        }
        try {
            return (int) $this->sqlite->getFormDatabase($formId)->query('SELECT COUNT(*) FROM responses')->fetchColumn() > 0;
        } catch (\Throwable $e) {
            return true; // can't verify → snapshot anyway (never guard away real data)
        }
    }

    private function purgeExpiredThrottled(): void
    {
        try {
            $stmt = $this->pdo->prepare('SELECT meta_value FROM system_meta WHERE meta_key = :k');
            $stmt->execute(['k' => self::PURGE_STAMP_KEY]);
            $last = $stmt->fetchColumn();
            if (is_string($last) && strtotime($last) !== false && strtotime($last) > time() - 3600) {
                return;
            }
            $now = date('Y-m-d H:i:s');
            $up = $this->pdo->prepare('INSERT INTO system_meta (meta_key, meta_value) VALUES (:k, :v) ON DUPLICATE KEY UPDATE meta_value = :v2');
            $up->execute(['k' => self::PURGE_STAMP_KEY, 'v' => $now, 'v2' => $now]);
            $this->purgeExpired();
        } catch (\Throwable $e) {
            $this->logger->debug('Trash: opportunistic purge skipped', ['error' => $e->getMessage()]);
        }
    }

    private function formatItem(array $row): array
    {
        $meta = json_decode((string) ($row['meta'] ?? 'null'), true);
        $expiresTs = strtotime((string) $row['expires_at']) ?: time();
        return [
            'id' => $row['id'],
            'kind' => $row['kind'],
            'originalId' => $row['original_id'],
            'name' => $row['name'],
            'sizeBytes' => (int) $row['size_bytes'],
            'meta' => is_array($meta) ? $meta : [],
            'status' => $row['status'],
            'deletedAt' => $row['deleted_at'],
            'expiresAt' => $row['expires_at'],
            'daysRemaining' => max(0, (int) ceil(($expiresTs - time()) / 86400)),
        ];
    }

    private function safeSegment(string $id): string
    {
        return (string) preg_replace('/[^a-zA-Z0-9\-]/', '', $id);
    }

    private function generateUuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}

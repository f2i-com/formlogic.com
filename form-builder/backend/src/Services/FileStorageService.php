<?php

declare(strict_types=1);

namespace FormLogic\Services;

class FileStorageService
{
    private string $storagePath;
    private int $maxFileSize;
    private array $allowedTypes;
    private string $receiptSecret;

    public function __construct(array $config)
    {
        $this->storagePath = rtrim($config['storagePath'] ?? __DIR__ . '/../../storage/uploads', '/');
        $this->maxFileSize = $config['maxFileSize'] ?? 10 * 1024 * 1024;
        $this->allowedTypes = $config['allowedTypes'] ?? [];
        // HMAC key for short-lived file receipt tokens (FILE-PRIV-001). Empty =
        // receipts disabled: mint returns null and verify fails CLOSED.
        $this->receiptSecret = (string) ($config['receiptSecret'] ?? '');

        if (!is_dir($this->storagePath)) {
            if (!mkdir($this->storagePath, 0700, true) && !is_dir($this->storagePath)) {
                throw new \RuntimeException('Failed to create storage directory: ' . $this->storagePath);
            }
        }
    }

    // Per-form storage backstop: cap total bytes in a single form's upload dir
    // so an abusive uploader can't exhaust disk for the whole platform.
    private const MAX_FORM_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

    /**
     * Store an uploaded file for a form.
     *
     * @param string $formId
     * @param array $uploadedFile $_FILES entry
     * @param array $constraints Per-form field constraints, intersected with the
     *   global limits as a ceiling: ['maxFileSize' => ?int (bytes),
     *   'acceptedTypes' => string[] (extensions/MIME; empty = no field restriction)]
     * @param string|null $uploaderUserId Authenticated uploader, when known — bound into the
     *   pending marker so submission-time validation can require submitter == uploader
     *   (FILE-PRIV-001).
     * @return array File metadata: id, originalFilename, storedFilename, size, mimeType, url,
     *   claimToken (single-use upload claim the submitter must echo back to attach the file)
     */
    public function storeFile(string $formId, array $uploadedFile, array $constraints = [], ?string $uploaderUserId = null): array
    {
        // Validate upload
        if (empty($uploadedFile['tmp_name']) || $uploadedFile['error'] !== UPLOAD_ERR_OK) {
            throw new \RuntimeException('File upload failed');
        }

        if (!is_uploaded_file($uploadedFile['tmp_name'])) {
            throw new \RuntimeException('Invalid file upload');
        }

        // Effective size limit: the field's configured max, capped by the global
        // ceiling (global always wins so a field can't raise the platform limit).
        $effectiveMax = $this->maxFileSize;
        if (!empty($constraints['maxFileSize']) && (int) $constraints['maxFileSize'] > 0) {
            $effectiveMax = min($this->maxFileSize, (int) $constraints['maxFileSize']);
        }

        // Validate file size (always use actual file size, not client-reported)
        $size = filesize($uploadedFile['tmp_name']);
        if ($size === false || $size > $effectiveMax) {
            throw new \RuntimeException(
                'File too large. Maximum size is ' . $this->formatFileSize($effectiveMax)
            );
        }

        // Detect MIME type using finfo (don't trust client-reported type)
        $finfo = new \finfo(FILEINFO_MIME_TYPE);
        $mimeType = $finfo->file($uploadedFile['tmp_name']);

        // Validate MIME type against allowlist (fail-closed: reject if no allowlist configured)
        if (empty($this->allowedTypes) || !in_array($mimeType, $this->allowedTypes, true)) {
            throw new \RuntimeException('File type not allowed: ' . $mimeType);
        }

        // Enforce the form's per-field accepted types (extensions/MIME) on top of
        // the global allowlist, so a field restricted to "images only" is honored.
        $acceptedTypes = $constraints['acceptedTypes'] ?? [];
        if (!empty($acceptedTypes) && !$this->matchesAcceptedType($mimeType, (string) ($uploadedFile['name'] ?? ''), $acceptedTypes)) {
            throw new \RuntimeException('File type not allowed for this field');
        }

        // Create form directory
        $formDir = $this->storagePath . '/' . $this->sanitizeId($formId);
        if (!is_dir($formDir)) {
            mkdir($formDir, 0700, true);
        }

        // Per-form storage budget backstop (disk-exhaustion protection).
        if ($this->formDirBytes($formDir) + $size > self::MAX_FORM_BYTES) {
            throw new \RuntimeException('This form has reached its file storage limit');
        }

        // Generate unique file ID and safe stored filename
        $fileId = $this->generateUuid();
        $originalFilename = basename($uploadedFile['name'] ?? 'upload');
        $extension = pathinfo($originalFilename, PATHINFO_EXTENSION);
        $safeExtension = preg_replace('/[^a-zA-Z0-9]/', '', $extension);
        $storedFilename = $fileId . ($safeExtension ? '.' . $safeExtension : '');

        // Move file to storage
        $destPath = $formDir . '/' . $storedFilename;
        if (!move_uploaded_file($uploadedFile['tmp_name'], $destPath)) {
            throw new \RuntimeException('Failed to store uploaded file');
        }

        // Upload staging (audit FL-006): every upload starts PENDING — a
        // marker in .pending/ (kept out of the form dir so the fileId globs
        // never match it). A successful response submit commits its files by
        // removing their markers; markers that outlive PENDING_TTL_SECONDS
        // mark abandoned uploads for the sweeper. An invalid/never-submitted
        // form therefore cannot consume permanent storage.
        //
        // FILE-PRIV-001: the marker also carries the upload CLAIM — a hash of a
        // one-time token returned only to the uploader, plus the authenticated
        // uploader id when known. Submission-time validation requires one of
        // them, so a stranger who learns a pending file id cannot attach it to
        // their own response. The plaintext token is never stored.
        $claimToken = bin2hex(random_bytes(32));
        $pendingDir = $formDir . '/.pending';
        if (!is_dir($pendingDir)) {
            mkdir($pendingDir, 0700, true);
        }
        @file_put_contents($pendingDir . '/' . $storedFilename, json_encode([
            'claim' => hash('sha256', $claimToken),
            'uploader' => $uploaderUserId,
            'at' => time(),
        ]));

        return [
            'id' => $fileId,
            'originalFilename' => $originalFilename,
            'storedFilename' => $storedFilename,
            'size' => (int) $size,
            'mimeType' => $mimeType,
            'url' => "/api/files/{$formId}/{$fileId}/{$originalFilename}",
            'claimToken' => $claimToken,
        ];
    }

    /**
     * The upload-claim state of a stored file (FILE-PRIV-001). Returns null when the
     * file doesn't exist. `pending` is false once a response committed the file.
     * `legacy` marks a pre-claim marker (created by @touch before this shipped, or
     * unreadable) — those are grandfathered as attachable until the pending TTL
     * sweeps them, so in-flight fills across a deploy don't dead-end.
     *
     * @return array{pending: bool, uploader: ?string, claimHash: ?string, legacy: bool}|null
     */
    public function uploadClaimInfo(string $formId, string $fileId): ?array
    {
        $path = $this->getFilePath($formId, $fileId);
        if ($path === null) {
            return null;
        }
        $marker = dirname($path) . '/.pending/' . basename($path);
        if (!is_file($marker)) {
            return ['pending' => false, 'uploader' => null, 'claimHash' => null, 'legacy' => false];
        }
        $meta = json_decode((string) @file_get_contents($marker), true);
        if (!is_array($meta) || !is_string($meta['claim'] ?? null) || $meta['claim'] === '') {
            return ['pending' => true, 'uploader' => null, 'claimHash' => null, 'legacy' => true];
        }
        return [
            'pending' => true,
            'uploader' => is_string($meta['uploader'] ?? null) ? $meta['uploader'] : null,
            'claimHash' => $meta['claim'],
            'legacy' => false,
        ];
    }

    /** How long a receipt token stays valid (matches the pending-upload window). */
    public const RECEIPT_TTL_SECONDS = 86400;

    /**
     * Mint a short-lived, file-bound receipt token (FILE-PRIV-001): lets a bearer —
     * an anonymous submitter's browser or a webhook consumer — fetch ONE specific
     * file for a bounded window without authentication. Stateless HMAC over
     * formId+fileId+expiry; null when no secret is configured (receipts disabled).
     */
    public function mintReceiptToken(string $formId, string $fileId, int $ttlSeconds = self::RECEIPT_TTL_SECONDS): ?string
    {
        if ($this->receiptSecret === '') {
            return null;
        }
        $exp = time() + $ttlSeconds;
        return $exp . '.' . hash_hmac('sha256', "file-receipt|{$formId}|{$fileId}|{$exp}", $this->receiptSecret);
    }

    /** Verify a receipt token for this exact file. Fails CLOSED without a secret. */
    public function verifyReceiptToken(string $formId, string $fileId, string $token): bool
    {
        if ($this->receiptSecret === '' || $token === '') {
            return false;
        }
        $parts = explode('.', $token, 2);
        if (count($parts) !== 2 || $parts[0] === '' || !ctype_digit($parts[0])) {
            return false;
        }
        if ((int) $parts[0] < time()) {
            return false;
        }
        $expected = hash_hmac('sha256', "file-receipt|{$formId}|{$fileId}|{$parts[0]}", $this->receiptSecret);
        return hash_equals($expected, $parts[1]);
    }

    /**
     * Get the filesystem path for a stored file.
     */
    public function getFilePath(string $formId, string $fileId): ?string
    {
        if ($this->sanitizeId($formId) === '' || $this->sanitizeId($fileId) === '') {
            return null;
        }
        $formDir = $this->storagePath . '/' . $this->sanitizeId($formId);
        if (!is_dir($formDir)) {
            return null;
        }

        // Find the file by ID prefix
        $safeFileId = $this->sanitizeId($fileId);
        if ($safeFileId === '') {
            return null;
        }
        $pattern = $formDir . '/' . $safeFileId . '.*';
        $matches = glob($pattern);
        if (empty($matches)) {
            // Try exact match (no extension)
            $exact = $formDir . '/' . $this->sanitizeId($fileId);
            if (file_exists($exact) && !is_link($exact)) {
                return $exact;
            }
            return null;
        }

        $filePath = $matches[0];

        // Reject symlinks to prevent symlink-based file read attacks
        if (is_link($filePath)) {
            return null;
        }

        return $filePath;
    }

    /** How long an uncommitted upload may sit before the sweeper reclaims it. */
    public const PENDING_TTL_SECONDS = 86400;
    /** Minimum interval between sweeps of one form's pending dir. */
    private const SWEEP_INTERVAL_SECONDS = 3600;

    /**
     * Commit the files a persisted response references (audit FL-006): their
     * pending markers are removed, making them permanent. Files without a
     * marker (already committed, or pre-staging uploads) are untouched.
     *
     * @param array<string, mixed> $answers
     */
    public function commitResponseFiles(string $formId, array $answers): void
    {
        $formDir = $this->storagePath . '/' . $this->sanitizeId($formId);
        $pendingDir = $formDir . '/.pending';
        if (!is_dir($pendingDir)) {
            return;
        }
        foreach ($this->extractFileIds($answers) as $fileId) {
            $path = $this->getFilePath($formId, $fileId);
            if ($path !== null) {
                $marker = $pendingDir . '/' . basename($path);
                if (is_file($marker)) {
                    @unlink($marker);
                }
            }
        }
    }

    /**
     * Reclaim abandoned uploads (audit FL-006): delete files whose pending
     * marker is older than the TTL — uploaded but never committed by a valid
     * response. Throttled per form (marker-dir mtime) so upload bursts pay
     * for at most one scan an hour. Returns how many files were reclaimed.
     *
     * When a reference checker is supplied (FILE-PRIV-001), an expired-pending
     * file that a persisted response DOES reference is committed in place
     * (marker removed, file kept) instead of deleted — self-healing the
     * "response saved but commit failed" edge so the sweep can never break a
     * real attachment.
     */
    public function sweepAbandonedUploads(string $formId, int $ttlSeconds = self::PENDING_TTL_SECONDS, ?callable $isReferenced = null, bool $ignoreThrottle = false): int
    {
        $formDir = $this->storagePath . '/' . $this->sanitizeId($formId);
        $pendingDir = $formDir . '/.pending';
        if (!is_dir($pendingDir)) {
            return 0;
        }
        $throttle = $pendingDir . '/.last-sweep';
        $last = is_file($throttle) ? (int) filemtime($throttle) : 0;
        if (!$ignoreThrottle && time() - $last < self::SWEEP_INTERVAL_SECONDS) {
            return 0;
        }
        @touch($throttle);

        $reclaimed = 0;
        $cutoff = time() - $ttlSeconds;
        foreach (glob($pendingDir . '/*') ?: [] as $marker) {
            if (!is_file($marker) || is_link($marker)) {
                continue;
            }
            $mtime = filemtime($marker);
            if ($mtime === false || $mtime > $cutoff) {
                continue;
            }
            $fileId = explode('.', basename($marker), 2)[0];
            if ($isReferenced !== null && $fileId !== '' && $isReferenced($fileId)) {
                @unlink($marker); // referenced by a real response → commit, don't delete
                continue;
            }
            $stored = $formDir . '/' . basename($marker);
            if (is_file($stored) && !is_link($stored)) {
                @unlink($stored);
            }
            @unlink($marker);
            $reclaimed++;
        }
        return $reclaimed;
    }

    /** Grace before an orphan-marked file becomes eligible for physical deletion. */
    public const ORPHAN_GRACE_SECONDS = 900;

    /**
     * Mark a file as ORPHANED (FILE-PRIV-001): a response update/delete dropped its
     * last known reference. Nothing is deleted here — the physical file goes only
     * when sweepOrphanedFiles() later re-proves it unreferenced after a grace
     * period, so a concurrent update that re-references the id, or a second
     * response sharing it, can never lose data to this mutation.
     */
    public function markOrphaned(string $formId, string $fileId): void
    {
        $path = $this->getFilePath($formId, $fileId);
        if ($path === null) {
            return;
        }
        $orphanDir = dirname($path) . '/.orphaned';
        if (!is_dir($orphanDir)) {
            mkdir($orphanDir, 0700, true);
        }
        @touch($orphanDir . '/' . basename($path));
    }

    /**
     * Delayed garbage collector for orphan-marked files (FILE-PRIV-001). A marker
     * older than the grace period is resolved against the AUTHORITATIVE store via
     * $isReferenced(fileId): still referenced → the marker is dropped and the file
     * lives; unreferenced → the file (and its markers) are deleted. Throttled per
     * form like the abandoned-upload sweep. Returns how many files were deleted.
     */
    public function sweepOrphanedFiles(string $formId, callable $isReferenced, int $graceSeconds = self::ORPHAN_GRACE_SECONDS, bool $ignoreThrottle = false): int
    {
        $formDir = $this->storagePath . '/' . $this->sanitizeId($formId);
        $orphanDir = $formDir . '/.orphaned';
        if (!is_dir($orphanDir)) {
            return 0;
        }
        $throttle = $orphanDir . '/.last-sweep';
        $last = is_file($throttle) ? (int) filemtime($throttle) : 0;
        if (!$ignoreThrottle && time() - $last < self::SWEEP_INTERVAL_SECONDS) {
            return 0;
        }
        @touch($throttle);

        $deleted = 0;
        $cutoff = time() - $graceSeconds;
        foreach (glob($orphanDir . '/*') ?: [] as $marker) {
            if (!is_file($marker) || is_link($marker)) {
                continue;
            }
            $mtime = filemtime($marker);
            if ($mtime === false || $mtime > $cutoff) {
                continue;
            }
            $name = basename($marker);
            $fileId = explode('.', $name, 2)[0];
            if ($fileId !== '' && $isReferenced($fileId)) {
                @unlink($marker); // a response still references it → not an orphan
                continue;
            }
            $stored = $formDir . '/' . $name;
            if (is_file($stored) && !is_link($stored)) {
                @unlink($stored);
                $deleted++;
            }
            $pendingMarker = $formDir . '/.pending/' . $name;
            if (is_file($pendingMarker)) {
                @unlink($pendingMarker);
            }
            @unlink($marker);
        }
        return $deleted;
    }

    /**
     * Delete a specific file (and its pending/orphan markers, if any).
     */
    public function deleteFile(string $formId, string $fileId): bool
    {
        $path = $this->getFilePath($formId, $fileId);
        if ($path && file_exists($path)) {
            foreach (['.pending', '.orphaned'] as $stagingDir) {
                $marker = dirname($path) . '/' . $stagingDir . '/' . basename($path);
                if (is_file($marker)) {
                    @unlink($marker);
                }
            }
            return unlink($path);
        }
        return false;
    }

    /**
     * Delete all files for a form.
     */
    public function deleteFormFiles(string $formId): void
    {
        if ($this->sanitizeId($formId) === '') {
            return;
        }
        $formDir = $this->storagePath . '/' . $this->sanitizeId($formId);
        if (is_dir($formDir)) {
            // Clear the staging dirs first or the final rmdir fails (FL-006).
            foreach ([$formDir . '/.pending', $formDir . '/.orphaned'] as $stagingDir) {
                if (is_dir($stagingDir)) {
                    foreach (glob($stagingDir . '/{,.}*', GLOB_BRACE) ?: [] as $marker) {
                        if (is_file($marker) && !is_link($marker)) {
                            unlink($marker);
                        }
                    }
                    @rmdir($stagingDir);
                }
            }
            $files = glob($formDir . '/*');
            foreach ($files as $file) {
                if (is_file($file) && !is_link($file)) {
                    unlink($file);
                }
            }
            rmdir($formDir);
        }
    }

    /**
     * True when the form's upload directory no longer exists — the verification step
     * after deleteFormFiles(), whose unlink/rmdir failures are otherwise silent
     * (they emit warnings, not exceptions). An unsanitizable id maps to no directory.
     */
    public function formFilesRemoved(string $formId): bool
    {
        $safeId = $this->sanitizeId($formId);
        if ($safeId === '') {
            return true;
        }
        clearstatcache();
        return !is_dir($this->storagePath . '/' . $safeId);
    }

    /**
     * The form ids that currently have an upload directory — the work list for the
     * nightly file GC (bin/backup-accounts.php), which must sweep forms with no
     * organic traffic to retrigger the on-mutation sweeps.
     *
     * @return string[]
     */
    public function formIdsWithUploads(): array
    {
        $out = [];
        foreach (scandir($this->storagePath) ?: [] as $name) {
            if ($name === '.' || $name === '..' || $name === '') {
                continue;
            }
            if (is_dir($this->storagePath . '/' . $name) && $this->sanitizeId($name) === $name) {
                $out[] = $name;
            }
        }
        return $out;
    }

    /**
     * Collect the stored file IDs referenced in a response's answers (a file_upload
     * answer holds an array of {id, storedFilename, ...} objects). Used to delete
     * only the files that an update dropped/replaced.
     *
     * @param array<string, mixed> $answers
     * @return string[]
     */
    public function extractFileIds(array $answers): array
    {
        $ids = [];
        foreach ($answers as $value) {
            if (!is_array($value)) {
                continue;
            }
            foreach ($value as $item) {
                if (is_array($item) && isset($item['id'], $item['storedFilename']) && is_string($item['id'])) {
                    $ids[] = $item['id'];
                }
            }
        }
        return $ids;
    }

    /**
     * Get the MIME type for a file.
     */
    public function getMimeType(string $filePath): string
    {
        $finfo = new \finfo(FILEINFO_MIME_TYPE);
        return $finfo->file($filePath) ?: 'application/octet-stream';
    }

    private function sanitizeId(string $id): string
    {
        return preg_replace('/[^a-zA-Z0-9\-]/', '', $id);
    }

    /**
     * Does the file match at least one of the field's accepted types? Accepts
     * extensions ('.pdf'), wildcard MIME ('image/*'), or exact MIME.
     */
    public function matchesAcceptedType(string $mimeType, string $originalName, array $accepted): bool
    {
        $mime = strtolower($mimeType);
        $name = strtolower($originalName);
        foreach ($accepted as $raw) {
            $t = strtolower(trim((string) $raw));
            if ($t === '') {
                continue;
            }
            if ($t[0] === '.') {
                if (str_ends_with($name, $t)) {
                    return true;
                }
            } elseif (str_ends_with($t, '/*')) {
                if (str_starts_with($mime, substr($t, 0, -1))) { // e.g. "image/"
                    return true;
                }
            } elseif ($mime === $t) {
                return true;
            }
        }
        return false;
    }

    /**
     * Total bytes stored across the given forms' upload directories — used for the
     * account-level storage quota. Sizes are read from disk (no central usage table).
     *
     * @param string[] $formIds
     */
    public function bytesForForms(array $formIds): int
    {
        $total = 0;
        foreach ($formIds as $formId) {
            $dir = $this->storagePath . '/' . $this->sanitizeId((string) $formId);
            if (is_dir($dir)) {
                $total += $this->formDirBytes($dir);
            }
        }
        return $total;
    }

    /**
     * Total bytes currently stored in a form's upload directory.
     */
    private function formDirBytes(string $formDir): int
    {
        $total = 0;
        foreach (glob($formDir . '/*') ?: [] as $f) {
            if (is_file($f)) {
                $s = filesize($f);
                if ($s !== false) {
                    $total += $s;
                }
            }
        }
        return $total;
    }

    private function formatFileSize(int $bytes): string
    {
        if ($bytes < 1024) return $bytes . ' B';
        if ($bytes < 1024 * 1024) return round($bytes / 1024, 1) . ' KB';
        return round($bytes / (1024 * 1024), 1) . ' MB';
    }

    private function generateUuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}

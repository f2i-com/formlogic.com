<?php

declare(strict_types=1);

namespace FormLogic\Services;

class PackFileService
{
    /** Per-entry uncompressed cap for an extracted archive member (spec §29.6 assets). 5MB. */
    public const MAX_ASSET_BYTES = 5 * 1024 * 1024;
    /** Aggregate uncompressed ceiling across ALL entries — the zip-bomb guard for extraction. */
    public const MAX_TOTAL_UNCOMPRESSED = 64 * 1024 * 1024;

    private string $storagePath;
    private int $maxZipSize;
    private array $allowedFileTypes;

    public function __construct(array $config)
    {
        $this->storagePath = $config['storagePath'] ?? __DIR__ . '/../../storage/packs';
        $this->maxZipSize = $config['maxZipSize'] ?? 50 * 1024 * 1024;
        $this->allowedFileTypes = $config['allowedFileTypes'] ?? ['application/zip', 'application/x-zip-compressed'];
    }

    /**
     * Reject a zip entry name that could escape the extraction root (zip-slip): absolute paths,
     * Windows drive letters, backslashes, NUL bytes, a leading slash, or any ".." path segment.
     * The single source of truth for archive-path safety — reused by every zip reader in the app so
     * a new import path can never ship a weaker check than the marketplace upload.
     */
    public static function isSafeZipEntryName(string $name): bool
    {
        if ($name === '' || strlen($name) > 255) {
            return false;
        }
        if (str_contains($name, "\0") || str_contains($name, '\\')) {
            return false;
        }
        if (str_starts_with($name, '/') || preg_match('#^[A-Za-z]:#', $name) === 1) {
            return false;
        }
        foreach (explode('/', $name) as $segment) {
            if ($segment === '..') {
                return false;
            }
        }
        return true;
    }

    /**
     * Validate EVERY entry in an already-open ZipArchive against zip-slip (path traversal) and
     * zip-bomb (per-entry + aggregate uncompressed size) before anything is read out of it. Throws
     * on the first violation. Shared guard for both the marketplace upload and the application-package
     * import so all zip handling enforces the same limits.
     */
    public static function assertSafeArchive(
        \ZipArchive $zip,
        int $maxEntryBytes = self::MAX_ASSET_BYTES,
        int $maxTotalBytes = self::MAX_TOTAL_UNCOMPRESSED
    ): void {
        $total = 0;
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $stat = $zip->statIndex($i);
            if ($stat === false) {
                throw new \RuntimeException('Corrupt or unreadable archive entry');
            }
            $name = (string) ($stat['name'] ?? '');
            if (!self::isSafeZipEntryName($name)) {
                throw new \RuntimeException('Unsafe path in archive: ' . $name);
            }
            $size = (int) ($stat['size'] ?? 0);
            if ($size > $maxEntryBytes) {
                throw new \RuntimeException('Archive entry "' . $name . '" exceeds the ' . round($maxEntryBytes / 1024 / 1024) . 'MB per-file limit');
            }
            $total += $size;
            if ($total > $maxTotalBytes) {
                throw new \RuntimeException('Archive uncompressed size exceeds the ' . round($maxTotalBytes / 1024 / 1024) . 'MB limit');
            }
        }
    }

    /**
     * Process a .zip upload: extract, validate manifest.json, return parsed PackData.
     *
     * @param array $uploadedFile PSR-7 uploaded file array
     * @return array Parsed pack data from manifest.json
     */
    public function processZipUpload(array $uploadedFile): array
    {
        $tmpPath = $uploadedFile['tmp_name'] ?? null;
        $size = $uploadedFile['size'] ?? 0;
        $type = $uploadedFile['type'] ?? '';

        if (!$tmpPath || !file_exists($tmpPath)) {
            throw new \RuntimeException('No file uploaded');
        }

        // Use actual file size, not client-reported size
        $actualSize = filesize($tmpPath);
        if ($actualSize === false || $actualSize > $this->maxZipSize) {
            throw new \RuntimeException('File exceeds maximum size of ' . round($this->maxZipSize / 1024 / 1024) . 'MB');
        }

        // Validate file type using server-side detection only (don't trust client-reported type)
        $finfo = new \finfo(FILEINFO_MIME_TYPE);
        $detectedType = $finfo->file($tmpPath);
        if (!in_array($detectedType, $this->allowedFileTypes, true)) {
            throw new \RuntimeException('Invalid file type. Only .zip files are accepted.');
        }

        $zip = new \ZipArchive();
        $result = $zip->open($tmpPath);
        if ($result !== true) {
            throw new \RuntimeException('Failed to open zip file');
        }

        // Reject zip-slip / zip-bomb across ALL entries up front (shared guard) before reading any.
        try {
            self::assertSafeArchive($zip);
        } catch (\RuntimeException $e) {
            $zip->close();
            throw $e;
        }

        // Reject zip bombs: check the manifest's UNCOMPRESSED size before reading
        // it into memory (a tiny zip can declare a huge manifest entry).
        $manifestStat = $zip->statName('manifest.json');
        if ($manifestStat === false) {
            $zip->close();
            throw new \RuntimeException('Zip file must contain a manifest.json');
        }
        if (($manifestStat['size'] ?? 0) > 8 * 1024 * 1024) {
            $zip->close();
            throw new \RuntimeException('manifest.json is too large');
        }

        // Look for manifest.json
        $manifestContent = $zip->getFromName('manifest.json');
        if ($manifestContent === false) {
            $zip->close();
            throw new \RuntimeException('Zip file must contain a manifest.json');
        }

        $packData = json_decode($manifestContent, true, 128);
        if (!$packData || json_last_error() !== JSON_ERROR_NONE) {
            $zip->close();
            throw new \RuntimeException('Invalid JSON in manifest.json');
        }

        $zip->close();

        // Validate required structure
        if (!isset($packData['formatVersion']) || !isset($packData['packMeta']) || !isset($packData['forms'])) {
            throw new \RuntimeException('manifest.json must contain formatVersion, packMeta, and forms');
        }

        return $packData;
    }

    /**
     * Store pack files persistently.
     */
    public function storePackFiles(string $catalogId, string $versionId, string $tmpZipPath): string
    {
        $this->validateId($catalogId);
        $this->validateId($versionId);

        $dir = $this->storagePath . '/' . $catalogId . '/' . $versionId;
        if (!is_dir($dir)) {
            mkdir($dir, 0755, true);
        }

        $destPath = $dir . '/pack.zip';
        if (!copy($tmpZipPath, $destPath)) {
            throw new \RuntimeException('Failed to store pack zip file');
        }

        return $destPath;
    }

    /**
     * Get file path for a stored pack zip.
     */
    public function getPackFile(string $catalogId, string $versionId): ?string
    {
        $this->validateId($catalogId);
        $this->validateId($versionId);

        $path = $this->storagePath . '/' . $catalogId . '/' . $versionId . '/pack.zip';
        return file_exists($path) ? $path : null;
    }

    /**
     * Delete all stored files for a pack.
     */
    public function deletePackFiles(string $catalogId): void
    {
        $this->validateId($catalogId);

        $dir = $this->storagePath . '/' . $catalogId;
        if (is_dir($dir)) {
            $this->removeDirectory($dir);
        }
    }

    private function removeDirectory(string $dir): void
    {
        $items = scandir($dir);
        if ($items === false) {
            return;
        }
        foreach ($items as $item) {
            if ($item === '.' || $item === '..') {
                continue;
            }
            $path = $dir . '/' . $item;
            if (is_link($path)) {
                unlink($path);
            } elseif (is_dir($path)) {
                $this->removeDirectory($path);
            } else {
                unlink($path);
            }
        }
        rmdir($dir);
    }

    private function validateId(string $id): void
    {
        if (!preg_match('/^[a-f0-9\-]{36}$/', $id)) {
            throw new \RuntimeException('Invalid ID format');
        }
    }
}

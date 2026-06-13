<?php

declare(strict_types=1);

namespace FormLogic\Services;

class PackFileService
{
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

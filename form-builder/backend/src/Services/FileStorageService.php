<?php

declare(strict_types=1);

namespace FormLogic\Services;

class FileStorageService
{
    private string $storagePath;
    private int $maxFileSize;
    private array $allowedTypes;

    public function __construct(array $config)
    {
        $this->storagePath = rtrim($config['storagePath'] ?? __DIR__ . '/../../storage/uploads', '/');
        $this->maxFileSize = $config['maxFileSize'] ?? 10 * 1024 * 1024;
        $this->allowedTypes = $config['allowedTypes'] ?? [];

        if (!is_dir($this->storagePath)) {
            mkdir($this->storagePath, 0755, true);
        }
    }

    /**
     * Store an uploaded file for a form.
     *
     * @param string $formId
     * @param array $uploadedFile $_FILES entry
     * @return array File metadata: id, originalFilename, storedFilename, size, mimeType, url
     */
    public function storeFile(string $formId, array $uploadedFile): array
    {
        // Validate upload
        if (empty($uploadedFile['tmp_name']) || $uploadedFile['error'] !== UPLOAD_ERR_OK) {
            throw new \RuntimeException('File upload failed');
        }

        if (!is_uploaded_file($uploadedFile['tmp_name'])) {
            throw new \RuntimeException('Invalid file upload');
        }

        // Validate file size
        $size = $uploadedFile['size'] ?? filesize($uploadedFile['tmp_name']);
        if ($size > $this->maxFileSize) {
            throw new \RuntimeException(
                'File too large. Maximum size is ' . $this->formatFileSize($this->maxFileSize)
            );
        }

        // Detect MIME type using finfo (don't trust client-reported type)
        $finfo = new \finfo(FILEINFO_MIME_TYPE);
        $mimeType = $finfo->file($uploadedFile['tmp_name']);

        // Validate MIME type if allowlist is configured
        if (!empty($this->allowedTypes) && !in_array($mimeType, $this->allowedTypes, true)) {
            throw new \RuntimeException('File type not allowed: ' . $mimeType);
        }

        // Create form directory
        $formDir = $this->storagePath . '/' . $this->sanitizeId($formId);
        if (!is_dir($formDir)) {
            mkdir($formDir, 0755, true);
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

        return [
            'id' => $fileId,
            'originalFilename' => $originalFilename,
            'storedFilename' => $storedFilename,
            'size' => (int) $size,
            'mimeType' => $mimeType,
            'url' => "/api/files/{$formId}/{$fileId}/{$originalFilename}",
        ];
    }

    /**
     * Get the filesystem path for a stored file.
     */
    public function getFilePath(string $formId, string $fileId): ?string
    {
        $formDir = $this->storagePath . '/' . $this->sanitizeId($formId);
        if (!is_dir($formDir)) {
            return null;
        }

        // Find the file by ID prefix
        $pattern = $formDir . '/' . $this->sanitizeId($fileId) . '.*';
        $matches = glob($pattern);
        if (empty($matches)) {
            // Try exact match (no extension)
            $exact = $formDir . '/' . $this->sanitizeId($fileId);
            if (file_exists($exact)) {
                return $exact;
            }
            return null;
        }

        return $matches[0];
    }

    /**
     * Delete a specific file.
     */
    public function deleteFile(string $formId, string $fileId): bool
    {
        $path = $this->getFilePath($formId, $fileId);
        if ($path && file_exists($path)) {
            return unlink($path);
        }
        return false;
    }

    /**
     * Delete all files for a form.
     */
    public function deleteFormFiles(string $formId): void
    {
        $formDir = $this->storagePath . '/' . $this->sanitizeId($formId);
        if (is_dir($formDir)) {
            $files = glob($formDir . '/*');
            foreach ($files as $file) {
                if (is_file($file)) {
                    unlink($file);
                }
            }
            rmdir($formDir);
        }
    }

    /**
     * Delete files referenced in response answers.
     * Scans the answers for file_upload metadata and deletes associated files.
     */
    public function deleteResponseFiles(string $formId, array $answers): void
    {
        foreach ($answers as $value) {
            if (!is_array($value)) {
                continue;
            }

            // Check if this is a file upload array (array of file metadata objects)
            foreach ($value as $item) {
                if (is_array($item) && isset($item['id']) && isset($item['storedFilename'])) {
                    $this->deleteFile($formId, $item['id']);
                }
            }
        }
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

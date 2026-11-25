<?php

declare(strict_types=1);

namespace FormLogic\Services;

use InvalidArgumentException;
use PDO;
use RuntimeException;

/**
 * Sandboxed per-app file upload storage for SoftN and hosted JavaScript apps.
 *
 * Security model:
 *  - Binary payloads are stored outside the webroot under `<storageDir>/<sha256(appId)>/<uuid>.<ext>`
 *    with directory permissions 0700 and file permissions 0600, plus a fail-closed `.htaccess`.
 *  - Client filenames and MIME types are never trusted: dangerous/executable/web extensions are
 *    rejected anywhere in the filename (including double extensions like `evil.php.png`), raw bytes
 *    are inspected with `finfo(FILEINFO_MIME_TYPE)`, raster images are additionally verified with
 *    `getimagesizefromstring()`, and polyglot script headers (`<?php`, `<script`, `<svg`, `<html`)
 *    are rejected.
 *  - Per-app policy (access mode, max file size, total quota, allowed categories, optional
 *    quarantine review) is stored under `apps.settings.nativeUploads` and enforced server-side on
 *    every upload and download.
 */
class NativeAppUploadsService
{
    public const VALID_ACCESS = ['disabled', 'owner', 'members', 'anyone'];
    public const VALID_CATEGORIES = ['images', 'documents', 'audio', 'video', 'archives'];
    public const MAX_FILE_SIZE_MB = 25;
    public const MAX_TOTAL_STORAGE_MB = 2048;
    public const MAX_IMAGE_DIMENSION = 16384;

    /**
     * Extensions that are NEVER allowed anywhere in an uploaded filename (even as intermediate
     * double extensions like `photo.php.jpg` or `doc.html.txt`).
     */
    private const FORBIDDEN_EXTENSIONS = [
        'php', 'php3', 'php4', 'php5', 'php7', 'php8', 'phtml', 'phar', 'phps',
        'cgi', 'pl', 'py', 'rb', 'sh', 'bash', 'zsh',
        'exe', 'bat', 'cmd', 'com', 'msi', 'dll', 'scr', 'vbs', 'vbe', 'ps1', 'psm1', 'app', 'dmg', 'apk',
        'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx',
        'html', 'htm', 'xhtml', 'shtml', 'mhtml', 'svg', 'svgz', 'xml', 'xsl', 'xslt', 'swf',
        'asp', 'aspx', 'ashx', 'asmx', 'jsp', 'jspx', 'cfm',
        'htaccess', 'htpasswd', 'ini', 'env',
    ];

    /**
     * Allowed extension -> [category, allowed detected MIME types, canonical serving MIME].
     *
     * @var array<string, array{category: string, mimes: list<string>, serveMime: string}>
     */
    private const EXTENSION_RULES = [
        // Images (raster only — SVG is deliberately excluded to prevent script execution)
        'png'  => ['category' => 'images', 'mimes' => ['image/png'], 'serveMime' => 'image/png'],
        'jpg'  => ['category' => 'images', 'mimes' => ['image/jpeg'], 'serveMime' => 'image/jpeg'],
        'jpeg' => ['category' => 'images', 'mimes' => ['image/jpeg'], 'serveMime' => 'image/jpeg'],
        'gif'  => ['category' => 'images', 'mimes' => ['image/gif'], 'serveMime' => 'image/gif'],
        'webp' => ['category' => 'images', 'mimes' => ['image/webp'], 'serveMime' => 'image/webp'],

        // Documents & structured text
        'pdf'  => ['category' => 'documents', 'mimes' => ['application/pdf'], 'serveMime' => 'application/pdf'],
        'txt'  => ['category' => 'documents', 'mimes' => ['text/plain', 'application/x-empty'], 'serveMime' => 'text/plain; charset=utf-8'],
        'csv'  => ['category' => 'documents', 'mimes' => ['text/plain', 'text/csv', 'application/csv', 'application/x-empty'], 'serveMime' => 'text/csv; charset=utf-8'],
        'md'   => ['category' => 'documents', 'mimes' => ['text/plain', 'text/markdown', 'application/x-empty'], 'serveMime' => 'text/plain; charset=utf-8'],
        'json' => ['category' => 'documents', 'mimes' => ['application/json', 'text/plain', 'text/json'], 'serveMime' => 'application/json; charset=utf-8'],
        'rtf'  => ['category' => 'documents', 'mimes' => ['text/rtf', 'application/rtf'], 'serveMime' => 'application/rtf'],
        'docx' => ['category' => 'documents', 'mimes' => ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip'], 'serveMime' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
        'xlsx' => ['category' => 'documents', 'mimes' => ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip'], 'serveMime' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
        'pptx' => ['category' => 'documents', 'mimes' => ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/zip'], 'serveMime' => 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],

        // Audio
        'mp3'  => ['category' => 'audio', 'mimes' => ['audio/mpeg', 'application/octet-stream'], 'serveMime' => 'audio/mpeg'],
        'wav'  => ['category' => 'audio', 'mimes' => ['audio/wav', 'audio/x-wav', 'audio/vnd.wave'], 'serveMime' => 'audio/wav'],
        'ogg'  => ['category' => 'audio', 'mimes' => ['audio/ogg', 'application/ogg'], 'serveMime' => 'audio/ogg'],
        'm4a'  => ['category' => 'audio', 'mimes' => ['audio/mp4', 'audio/x-m4a', 'video/mp4'], 'serveMime' => 'audio/mp4'],
        'flac' => ['category' => 'audio', 'mimes' => ['audio/flac', 'audio/x-flac'], 'serveMime' => 'audio/flac'],

        // Video
        'mp4'  => ['category' => 'video', 'mimes' => ['video/mp4'], 'serveMime' => 'video/mp4'],
        'webm' => ['category' => 'video', 'mimes' => ['video/webm', 'audio/webm'], 'serveMime' => 'video/webm'],
        'mov'  => ['category' => 'video', 'mimes' => ['video/quicktime'], 'serveMime' => 'video/quicktime'],

        // Archives
        'zip'  => ['category' => 'archives', 'mimes' => ['application/zip', 'application/x-zip-compressed'], 'serveMime' => 'application/zip'],
        'gz'   => ['category' => 'archives', 'mimes' => ['application/gzip', 'application/x-gzip'], 'serveMime' => 'application/gzip'],
    ];

    /** MIME types safe to render inline inside a sandboxed viewer / img tag (everything else forces attachment). */
    private const INLINE_SAFE_MIMES = [
        'image/png',
        'image/jpeg',
        'image/gif',
        'image/webp',
    ];

    private string $storageDir;

    public function __construct(
        private PDO $pdo,
        private ?PlanService $plans = null,
        ?string $storageDir = null,
    ) {
        $this->storageDir = rtrim($storageDir ?? dirname(__DIR__, 2) . '/storage/native-app-uploads', '/\\');
    }

    /**
     * Returns the normalized upload sandbox policy for an app.
     *
     * @param array<string, mixed> $app
     * @return array{access: string, maxFileSizeMb: int, maxTotalStorageMb: int, allowedCategories: list<string>, requireQuarantineReview: bool}
     */
    public function getPolicy(array $app): array
    {
        $settings = is_array($app['settings'] ?? null) ? $app['settings'] : [];
        $raw = is_array($settings['nativeUploads'] ?? null) ? $settings['nativeUploads'] : [];
        $defaultAccess = (($app['settings']['nativeAccess'] ?? null) === 'members') ? 'members' : 'owner';

        $access = is_string($raw['access'] ?? null) && in_array($raw['access'], self::VALID_ACCESS, true)
            ? $raw['access']
            : $defaultAccess;
        $maxFileSizeMb = is_numeric($raw['maxFileSizeMb'] ?? null)
            ? max(1, min(self::MAX_FILE_SIZE_MB, (int) $raw['maxFileSizeMb']))
            : 10;
        $maxTotalStorageMb = is_numeric($raw['maxTotalStorageMb'] ?? null)
            ? max(10, min(self::MAX_TOTAL_STORAGE_MB, (int) $raw['maxTotalStorageMb']))
            : 250;

        $categories = [];
        if (is_array($raw['allowedCategories'] ?? null)) {
            foreach ($raw['allowedCategories'] as $cat) {
                if (is_string($cat) && in_array($cat, self::VALID_CATEGORIES, true) && !in_array($cat, $categories, true)) {
                    $categories[] = $cat;
                }
            }
        }
        if ($categories === []) {
            $categories = ['images', 'documents'];
        }

        return [
            'access' => $access,
            'maxFileSizeMb' => $maxFileSizeMb,
            'maxTotalStorageMb' => $maxTotalStorageMb,
            'allowedCategories' => $categories,
            'requireQuarantineReview' => (bool) ($raw['requireQuarantineReview'] ?? false),
        ];
    }

    /**
     * Validates and merges a partial upload policy update into `apps.settings.nativeUploads`.
     *
     * @param array<string, mixed> $app
     * @param array<string, mixed> $patch
     * @return array{access: string, maxFileSizeMb: int, maxTotalStorageMb: int, allowedCategories: list<string>, requireQuarantineReview: bool}
     */
    public function normalizePolicyPatch(array $app, array $patch): array
    {
        $current = $this->getPolicy($app);
        if (array_key_exists('access', $patch)) {
            if (!is_string($patch['access']) || !in_array($patch['access'], self::VALID_ACCESS, true)) {
                throw new InvalidArgumentException('Upload access must be disabled, owner, members, or anyone.');
            }
            $current['access'] = $patch['access'];
        }
        if (array_key_exists('maxFileSizeMb', $patch)) {
            if (!is_numeric($patch['maxFileSizeMb'])) {
                throw new InvalidArgumentException('Max file size must be a number in MB (1 to 25).');
            }
            $current['maxFileSizeMb'] = max(1, min(self::MAX_FILE_SIZE_MB, (int) $patch['maxFileSizeMb']));
        }
        if (array_key_exists('maxTotalStorageMb', $patch)) {
            if (!is_numeric($patch['maxTotalStorageMb'])) {
                throw new InvalidArgumentException('Max total storage must be a number in MB (10 to 2048).');
            }
            $current['maxTotalStorageMb'] = max(10, min(self::MAX_TOTAL_STORAGE_MB, (int) $patch['maxTotalStorageMb']));
        }
        if (array_key_exists('allowedCategories', $patch)) {
            if (!is_array($patch['allowedCategories'])) {
                throw new InvalidArgumentException('Allowed categories must be an array.');
            }
            $next = [];
            foreach ($patch['allowedCategories'] as $cat) {
                if (is_string($cat) && in_array($cat, self::VALID_CATEGORIES, true) && !in_array($cat, $next, true)) {
                    $next[] = $cat;
                }
            }
            if ($next === []) {
                throw new InvalidArgumentException('Select at least one allowed file category.');
            }
            $current['allowedCategories'] = $next;
        }
        if (array_key_exists('requireQuarantineReview', $patch)) {
            $current['requireQuarantineReview'] = (bool) $patch['requireQuarantineReview'];
        }
        return $current;
    }

    /**
     * Validates, sandboxes, writes to disk, and indexes an uploaded file for a SoftN app.
     *
     * @param array<string, mixed> $app
     * @return array<string, mixed>
     */
    public function storeBytes(
        array $app,
        string $originalFilename,
        string $bytes,
        string $folder = '',
        ?string $uploadedBy = null,
        ?string $uploaderLabel = null,
        bool $isOwner = false,
    ): array {
        $appId = (string) ($app['id'] ?? '');
        $slug = (string) ($app['slug'] ?? '');
        $ownerId = (string) ($app['ownerId'] ?? '');
        if ($appId === '' || $slug === '') {
            throw new InvalidArgumentException('Invalid app.');
        }

        $policy = $this->getPolicy($app);
        $size = strlen($bytes);
        if ($size <= 0) {
            throw new InvalidArgumentException('Uploaded file is empty.');
        }
        $maxBytes = $policy['maxFileSizeMb'] * 1024 * 1024;
        if ($size > $maxBytes) {
            throw new InvalidArgumentException(sprintf('File exceeds this app\'s %d MB per-file upload limit.', $policy['maxFileSizeMb']));
        }

        // Serialize quota check + disk write + DB insert per app to eliminate concurrent quota TOCTOU races.
        $dir = $this->ensureAppDir($appId);
        $lockPath = $dir . DIRECTORY_SEPARATOR . '.quota.lock';
        $lockFp = @fopen($lockPath, 'c');
        if ($lockFp !== false) {
            @flock($lockFp, LOCK_EX);
        }
        try {
            // Enforce per-app storage quota
            $stats = $this->getStats($appId, $policy);
            if ($stats['totalBytes'] + $size > $stats['quotaBytes']) {
                throw new InvalidArgumentException(sprintf('App upload storage quota (%d MB) would be exceeded. Delete old files or increase the quota.', $policy['maxTotalStorageMb']));
            }

            // Enforce account plan storage limit when PlanService is available
            if ($this->plans !== null && $ownerId !== '' && !$this->plans->canUpload($ownerId, $size)) {
                throw new RuntimeException('Account storage quota exceeded.', 413);
            }

            // Clean & validate filename and double extensions
            $safeName = self::sanitizeFilename($originalFilename);
            $ext = self::extractValidatedExtension($safeName);
            $rule = self::EXTENSION_RULES[$ext] ?? null;
            if ($rule === null) {
                throw new InvalidArgumentException(sprintf('File type .%s is not supported in the sandboxed upload store.', $ext));
            }
            if (!$isOwner && !in_array($rule['category'], $policy['allowedCategories'], true)) {
                throw new InvalidArgumentException(sprintf('Category "%s" uploads are disabled by this app\'s sandbox policy.', $rule['category']));
            }
            if ($isOwner && !in_array($rule['category'], $policy['allowedCategories'], true)) {
                // Even the owner is bounded by the app's allowed categories to keep the sandbox predictable.
                throw new InvalidArgumentException(sprintf('Enable the "%s" category in Upload Sandbox Policy before uploading .%s files.', $rule['category'], $ext));
            }

            // Magic-byte MIME verification via finfo
            $detectedMime = self::detectMime($bytes);
            if (!self::mimeMatchesRule($detectedMime, $ext, $bytes, $rule)) {
                throw new InvalidArgumentException(sprintf(
                    'File contents (%s) do not match the .%s file type and were blocked by the upload sandbox.',
                    $detectedMime,
                    $ext,
                ));
            }

            // Extra raster image decode check & decompression bomb guard
            if ($rule['category'] === 'images') {
                $info = @getimagesizefromstring($bytes);
                if (!is_array($info) || ($info[0] ?? 0) <= 0 || ($info[1] ?? 0) <= 0) {
                    throw new InvalidArgumentException('Image file appears corrupted or invalid.');
                }
                if ($info[0] > self::MAX_IMAGE_DIMENSION || $info[1] > self::MAX_IMAGE_DIMENSION) {
                    throw new InvalidArgumentException('Image dimensions exceed the maximum safe limit (16384px).');
                }
            }

            // Polyglot / embedded active web/PHP header scan (covers text, JSON, CSV, PDF, and leading image comments)
            if (self::containsDangerousPayloadHeader($bytes, $rule['category'])) {
                throw new InvalidArgumentException('File contains active script or HTML markup and was blocked by the upload sandbox.');
            }

            $safeFolder = self::sanitizeFolder($folder);
            $id = self::uuidV4();
            $storedFilename = $id . '.' . $ext;
            $sha256 = hash('sha256', $bytes);
            $status = (!$isOwner && $policy['requireQuarantineReview']) ? 'quarantined' : 'approved';
            $serveMime = $rule['serveMime'];

            // Write atomically to the isolated per-app sandbox directory
            $dest = $dir . DIRECTORY_SEPARATOR . $storedFilename;
            $tmp = $dir . DIRECTORY_SEPARATOR . '.tmp-' . $id;
            $written = @file_put_contents($tmp, $bytes, LOCK_EX);
            if ($written === false || $written !== $size) {
                @unlink($tmp);
                throw new RuntimeException('Could not write uploaded file to sandbox storage.');
            }
            @chmod($tmp, 0600);
            if (!@rename($tmp, $dest)) {
                @unlink($tmp);
                throw new RuntimeException('Could not finalize uploaded file in sandbox storage.');
            }

            $createdAt = gmdate('Y-m-d H:i:s');
            try {
                $stmt = $this->pdo->prepare('
                    INSERT INTO native_app_uploads
                        (id, app_id, original_filename, stored_filename, folder, mime_type, category, size_bytes, sha256, status, uploaded_by, uploader_label, notes, created_at)
                    VALUES
                        (:id, :app_id, :original_filename, :stored_filename, :folder, :mime_type, :category, :size_bytes, :sha256, :status, :uploaded_by, :uploader_label, NULL, :created_at)
                ');
                $stmt->execute([
                    'id' => $id,
                    'app_id' => $appId,
                    'original_filename' => $safeName,
                    'stored_filename' => $storedFilename,
                    'folder' => $safeFolder,
                    'mime_type' => $serveMime,
                    'category' => $rule['category'],
                    'size_bytes' => $size,
                    'sha256' => $sha256,
                    'status' => $status,
                    'uploaded_by' => $uploadedBy,
                    'uploader_label' => $uploaderLabel !== null ? mb_substr(trim($uploaderLabel), 0, 120) : null,
                    'created_at' => $createdAt,
                ]);
            } catch (\Throwable $e) {
                @unlink($dest);
                throw $e;
            }

            return $this->formatRow([
                'id' => $id,
                'app_id' => $appId,
                'original_filename' => $safeName,
                'stored_filename' => $storedFilename,
                'folder' => $safeFolder,
                'mime_type' => $serveMime,
                'category' => $rule['category'],
                'size_bytes' => $size,
                'sha256' => $sha256,
                'status' => $status,
                'uploaded_by' => $uploadedBy,
                'uploader_label' => $uploaderLabel,
                'notes' => null,
                'created_at' => $createdAt,
            ], $slug);
        } finally {
            if ($lockFp !== false) {
                @flock($lockFp, LOCK_UN);
                @fclose($lockFp);
            }
        }
    }

    /**
     * Lists uploads for an app with optional filtering and pagination.
     *
     * @param array<string, mixed> $filters
     * @return array{uploads: list<array<string, mixed>>, total: int}
     */
    public function listUploads(string $appId, string $slug, array $filters = []): array
    {
        $where = ['app_id = :app_id'];
        $params = ['app_id' => $appId];

        if (!empty($filters['status']) && in_array($filters['status'], ['approved', 'quarantined'], true)) {
            $where[] = 'status = :status';
            $params['status'] = $filters['status'];
        }
        if (!empty($filters['category']) && in_array($filters['category'], self::VALID_CATEGORIES, true)) {
            $where[] = 'category = :category';
            $params['category'] = $filters['category'];
        }
        if (isset($filters['folder']) && is_string($filters['folder']) && trim($filters['folder']) !== '') {
            $where[] = 'folder = :folder';
            $params['folder'] = self::sanitizeFolder($filters['folder']);
        }
        if (!empty($filters['search']) && is_string($filters['search'])) {
            $escaped = str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], strtolower(trim($filters['search'])));
            $where[] = "(LOWER(original_filename) LIKE :search ESCAPE '\\' OR LOWER(folder) LIKE :search2 ESCAPE '\\')";
            $needle = '%' . $escaped . '%';
            $params['search'] = $needle;
            $params['search2'] = $needle;
        }

        $whereSql = implode(' AND ', $where);
        $countStmt = $this->pdo->prepare("SELECT COUNT(*) FROM native_app_uploads WHERE {$whereSql}");
        $countStmt->execute($params);
        $total = (int) $countStmt->fetchColumn();

        $limit = max(1, min(200, (int) ($filters['limit'] ?? 100)));
        $offset = max(0, (int) ($filters['offset'] ?? 0));

        $stmt = $this->pdo->prepare("
            SELECT id, app_id, original_filename, stored_filename, folder, mime_type, category,
                   size_bytes, sha256, status, uploaded_by, uploader_label, notes, created_at
            FROM native_app_uploads
            WHERE {$whereSql}
            ORDER BY created_at DESC, id DESC
            LIMIT {$limit} OFFSET {$offset}
        ");
        $stmt->execute($params);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

        $uploads = [];
        foreach ($rows as $row) {
            $uploads[] = $this->formatRow($row, $slug);
        }
        return ['uploads' => $uploads, 'total' => $total];
    }

    /**
     * @param array{maxTotalStorageMb: int} $policy
     * @return array{totalFiles: int, approvedFiles: int, quarantinedFiles: int, totalBytes: int, quotaBytes: int}
     */
    public function getStats(string $appId, array $policy): array
    {
        $stmt = $this->pdo->prepare("
            SELECT
                COUNT(*) AS total_files,
                SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved_files,
                SUM(CASE WHEN status = 'quarantined' THEN 1 ELSE 0 END) AS quarantined_files,
                COALESCE(SUM(size_bytes), 0) AS total_bytes
            FROM native_app_uploads
            WHERE app_id = :app_id
        ");
        $stmt->execute(['app_id' => $appId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC) ?: [];

        return [
            'totalFiles' => (int) ($row['total_files'] ?? 0),
            'approvedFiles' => (int) ($row['approved_files'] ?? 0),
            'quarantinedFiles' => (int) ($row['quarantined_files'] ?? 0),
            'totalBytes' => (int) ($row['total_bytes'] ?? 0),
            'quotaBytes' => (int) $policy['maxTotalStorageMb'] * 1024 * 1024,
        ];
    }

    /** @return array<string, mixed>|null */
    public function getUploadRow(string $appId, string $uploadId): ?array
    {
        $stmt = $this->pdo->prepare('
            SELECT id, app_id, original_filename, stored_filename, folder, mime_type, category,
                   size_bytes, sha256, status, uploaded_by, uploader_label, notes, created_at
            FROM native_app_uploads
            WHERE app_id = :app_id AND id = :id
            LIMIT 1
        ');
        $stmt->execute(['app_id' => $appId, 'id' => $uploadId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return is_array($row) ? $row : null;
    }

    /**
     * Resolves and verifies the on-disk path for an upload row (guarding against traversal).
     */
    public function resolveFilePath(string $appId, string $storedFilename): ?string
    {
        if (preg_match('/^[a-f0-9-]{36}\.[a-z0-9]{1,8}$/i', $storedFilename) !== 1) {
            return null;
        }
        $dir = $this->appDir($appId);
        $path = $dir . DIRECTORY_SEPARATOR . $storedFilename;
        if (!is_file($path)) {
            return null;
        }
        $realDir = realpath($dir);
        $realFile = realpath($path);
        if ($realDir === false || $realFile === false || !str_starts_with($realFile, $realDir . DIRECTORY_SEPARATOR)) {
            return null;
        }
        return $realFile;
    }

    /**
     * Updates status (`approved` / `quarantined`), folder, or notes for an upload.
     *
     * @param array<string, mixed> $patch
     * @return array<string, mixed>|null
     */
    public function updateUpload(string $appId, string $slug, string $uploadId, array $patch): ?array
    {
        $row = $this->getUploadRow($appId, $uploadId);
        if ($row === null) {
            return null;
        }

        $sets = [];
        $params = ['app_id' => $appId, 'id' => $uploadId];

        if (array_key_exists('status', $patch)) {
            if (!is_string($patch['status']) || !in_array($patch['status'], ['approved', 'quarantined'], true)) {
                throw new InvalidArgumentException('Status must be approved or quarantined.');
            }
            $sets[] = 'status = :status';
            $params['status'] = $patch['status'];
            $row['status'] = $patch['status'];
        }
        if (array_key_exists('folder', $patch)) {
            $folder = is_string($patch['folder']) ? self::sanitizeFolder($patch['folder']) : '';
            $sets[] = 'folder = :folder';
            $params['folder'] = $folder;
            $row['folder'] = $folder;
        }
        if (array_key_exists('notes', $patch)) {
            $notes = is_string($patch['notes']) ? mb_substr(trim($patch['notes']), 0, 1000) : null;
            $sets[] = 'notes = :notes';
            $params['notes'] = $notes === '' ? null : $notes;
            $row['notes'] = $params['notes'];
        }

        if ($sets !== []) {
            $sql = 'UPDATE native_app_uploads SET ' . implode(', ', $sets) . ' WHERE app_id = :app_id AND id = :id';
            $this->pdo->prepare($sql)->execute($params);
        }

        return $this->formatRow($row, $slug);
    }

    public function deleteUpload(string $appId, string $uploadId): bool
    {
        $row = $this->getUploadRow($appId, $uploadId);
        if ($row === null) {
            return false;
        }
        $path = $this->resolveFilePath($appId, (string) $row['stored_filename']);
        $stmt = $this->pdo->prepare('DELETE FROM native_app_uploads WHERE app_id = :app_id AND id = :id');
        $stmt->execute(['app_id' => $appId, 'id' => $uploadId]);
        if ($path !== null) {
            @unlink($path);
        }
        return true;
    }

    /**
     * @param list<string> $ids
     */
    public function bulkDelete(string $appId, array $ids): int
    {
        $deleted = 0;
        foreach ($ids as $id) {
            if (is_string($id) && $id !== '' && $this->deleteUpload($appId, $id)) {
                $deleted++;
            }
        }
        return $deleted;
    }

    /** Removes all sandboxed uploads (files + rows) when an app is permanently deleted. */
    public function deleteAllForApp(string $appId): void
    {
        $this->pdo->prepare('DELETE FROM native_app_uploads WHERE app_id = :app_id')->execute(['app_id' => $appId]);
        $dir = $this->appDir($appId);
        if (!is_dir($dir)) {
            return;
        }
        $entries = @scandir($dir);
        if (is_array($entries)) {
            foreach ($entries as $entry) {
                if ($entry === '.' || $entry === '..') continue;
                @unlink($dir . DIRECTORY_SEPARATOR . $entry);
            }
        }
        @rmdir($dir);
    }

    public static function isInlineSafeMime(string $mime): bool
    {
        $base = strtolower(trim(explode(';', $mime, 2)[0]));
        return in_array($base, self::INLINE_SAFE_MIMES, true);
    }

    /**
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    public function formatRow(array $row, string $slug): array
    {
        return [
            'id' => (string) $row['id'],
            'appId' => (string) $row['app_id'],
            'originalFilename' => (string) $row['original_filename'],
            'folder' => (string) ($row['folder'] ?? ''),
            'mimeType' => (string) $row['mime_type'],
            'category' => (string) $row['category'],
            'sizeBytes' => (int) $row['size_bytes'],
            'sha256' => (string) $row['sha256'],
            'status' => (string) $row['status'],
            'uploadedBy' => $row['uploaded_by'] !== null ? (string) $row['uploaded_by'] : null,
            'uploaderLabel' => $row['uploader_label'] !== null ? (string) $row['uploader_label'] : null,
            'notes' => $row['notes'] !== null ? (string) $row['notes'] : null,
            'url' => '/api/app/' . rawurlencode($slug) . '/native/uploads/' . rawurlencode((string) $row['id']),
            'createdAt' => (string) ($row['created_at'] ?? ''),
        ];
    }

    public static function sanitizeFilename(string $raw): string
    {
        $clean = str_replace(["\0", "\r", "\n"], '', $raw);
        $clean = basename(str_replace('\\', '/', $clean));
        $clean = trim($clean);
        if ($clean === '' || str_starts_with($clean, '.')) {
            throw new InvalidArgumentException('Invalid filename.');
        }
        if (mb_strlen($clean) > 180) {
            $ext = pathinfo($clean, PATHINFO_EXTENSION);
            $stem = mb_substr(pathinfo($clean, PATHINFO_FILENAME), 0, 165);
            $clean = $ext !== '' ? "{$stem}.{$ext}" : $stem;
        }
        return $clean;
    }

    public static function sanitizeFolder(string $raw): string
    {
        $clean = str_replace('\\', '/', trim($raw));
        $clean = trim($clean, '/');
        if ($clean === '') {
            return '';
        }
        $parts = [];
        foreach (explode('/', $clean) as $part) {
            $part = preg_replace('/[^a-zA-Z0-9._-]/', '-', trim($part)) ?? '';
            if ($part === '' || $part === '.' || $part === '..') {
                continue;
            }
            $parts[] = substr($part, 0, 40);
            if (count($parts) >= 4) break;
        }
        return substr(implode('/', $parts), 0, 120);
    }

    private static function extractValidatedExtension(string $filename): string
    {
        $parts = explode('.', strtolower($filename));
        if (count($parts) < 2) {
            throw new InvalidArgumentException('Uploaded file must include a file extension.');
        }
        // Inspect EVERY extension segment after the base stem to stop double-extension attacks (`evil.php.png`).
        for ($i = 1, $n = count($parts); $i < $n; $i++) {
            $seg = $parts[$i];
            if ($seg === '' || in_array($seg, self::FORBIDDEN_EXTENSIONS, true)) {
                throw new InvalidArgumentException(sprintf('Executable or active web file extension (.%s) is blocked by the upload sandbox.', $seg ?: 'unknown'));
            }
        }
        return $parts[count($parts) - 1];
    }

    private static function detectMime(string $bytes): string
    {
        if (class_exists(\finfo::class)) {
            $finfo = new \finfo(FILEINFO_MIME_TYPE);
            $detected = $finfo->buffer($bytes);
            if (is_string($detected) && $detected !== '') {
                return strtolower(trim(explode(';', $detected, 2)[0]));
            }
        }
        return 'application/octet-stream';
    }

    /**
     * @param array{category: string, mimes: list<string>, serveMime: string} $rule
     */
    private static function mimeMatchesRule(string $detectedMime, string $ext, string $bytes, array $rule): bool
    {
        if (in_array($detectedMime, $rule['mimes'], true)) {
            if ($ext === 'json') {
                json_decode($bytes);
                return json_last_error() === JSON_ERROR_NONE;
            }
            if (in_array($ext, ['docx', 'xlsx', 'pptx'], true)) {
                return str_starts_with($bytes, "PK\x03\x04");
            }
            if ($ext === 'mp3') {
                // Verify MP3 frame sync or ID3 header when finfo falls back to octet-stream.
                return $detectedMime === 'audio/mpeg'
                    || str_starts_with($bytes, 'ID3')
                    || (strlen($bytes) >= 2 && ord($bytes[0]) === 0xFF && (ord($bytes[1]) & 0xE0) === 0xE0);
            }
            return true;
        }
        return false;
    }

    private static function containsDangerousPayloadHeader(string $bytes, string $category): bool
    {
        $head = strtolower(substr($bytes, 0, 4096));
        if (str_contains($head, '<?php') || str_contains($head, '<?=')) {
            return true;
        }
        // Reject native executables (PE/MZ, ELF, Mach-O) and shell scripts across sandboxed upload categories.
        if (
            str_starts_with($bytes, "\x7fELF") ||
            str_starts_with($bytes, "MZ\x90") ||
            str_starts_with($bytes, "\xfe\xed\xfa\xce") ||
            str_starts_with($bytes, "\xce\xfa\xed\xfe") ||
            str_starts_with($bytes, "\xfe\xed\xfa\xcf") ||
            str_starts_with($bytes, "\xcf\xfa\xed\xfe") ||
            str_starts_with($bytes, '#!/')
        ) {
            return true;
        }
        if ($category === 'documents' || $category === 'images') {
            if (preg_match('/<\s*(?:script|iframe|object|embed|svg|html|!doctype\s+html)\b/i', $head) === 1) {
                return true;
            }
        }
        return false;
    }

    private function appDir(string $appId): string
    {
        return $this->storageDir . DIRECTORY_SEPARATOR . hash('sha256', $appId);
    }

    private function ensureAppDir(string $appId): string
    {
        if (!is_dir($this->storageDir)) {
            @mkdir($this->storageDir, 0700, true);
        }
        $htaccess = $this->storageDir . DIRECTORY_SEPARATOR . '.htaccess';
        if (!is_file($htaccess)) {
            @file_put_contents(
                $htaccess,
                "<IfModule mod_authz_core.c>\nRequire all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\nOrder allow,deny\nDeny from all\n</IfModule>\n<IfModule mod_php.c>\nphp_flag engine off\n</IfModule>\n"
            );
        }
        $dir = $this->appDir($appId);
        if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
            throw new RuntimeException('Could not create isolated upload sandbox directory.');
        }
        return $dir;
    }

    private static function uuidV4(): string
    {
        $data = random_bytes(16);
        $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
        $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}

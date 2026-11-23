<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\NativeAppUploadsService;
use InvalidArgumentException;
use PDO;
use PHPUnit\Framework\TestCase;

final class NativeAppUploadsTest extends TestCase
{
    private PDO $pdo;
    private string $tmpDir;
    private NativeAppUploadsService $service;

    /** @var array<string, mixed> */
    private array $app;

    protected function setUp(): void
    {
        $this->pdo = new PDO('sqlite::memory:');
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->pdo->exec("
            CREATE TABLE native_app_uploads (
                id VARCHAR(36) NOT NULL PRIMARY KEY,
                app_id VARCHAR(36) NOT NULL,
                original_filename VARCHAR(255) NOT NULL,
                stored_filename VARCHAR(120) NOT NULL,
                folder VARCHAR(120) NOT NULL DEFAULT '',
                mime_type VARCHAR(120) NOT NULL,
                category VARCHAR(32) NOT NULL DEFAULT 'documents',
                size_bytes INTEGER NOT NULL DEFAULT 0,
                sha256 CHAR(64) NOT NULL,
                status VARCHAR(24) NOT NULL DEFAULT 'approved',
                uploaded_by VARCHAR(36) NULL,
                uploader_label VARCHAR(120) NULL,
                notes TEXT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        ");

        $this->tmpDir = sys_get_temp_dir() . '/fl-native-uploads-test-' . bin2hex(random_bytes(6));
        mkdir($this->tmpDir, 0700, true);
        $this->service = new NativeAppUploadsService($this->pdo, null, $this->tmpDir);
        $this->app = [
            'id' => 'app-sandbox-1',
            'slug' => 'my-site',
            'ownerId' => 'owner-1',
            'settings' => [
                'nativeUploads' => [
                    'access' => 'anyone',
                    'maxFileSizeMb' => 5,
                    'maxTotalStorageMb' => 10,
                    'allowedCategories' => ['images', 'documents'],
                    'requireQuarantineReview' => false,
                ],
            ],
        ];
    }

    protected function tearDown(): void
    {
        $this->removeDir($this->tmpDir);
    }

    private function removeDir(string $dir): void
    {
        if (!is_dir($dir)) return;
        foreach (scandir($dir) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..') continue;
            $full = $dir . DIRECTORY_SEPARATOR . $entry;
            if (is_dir($full)) $this->removeDir($full);
            else @unlink($full);
        }
        @rmdir($dir);
    }

    private function tinyPng(): string
    {
        // Valid 1x1 transparent PNG
        return (string) base64_decode(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
            true
        );
    }

    public function testStoresValidPngInIsolatedAppDirectoryAndCreatesHtaccess(): void
    {
        $png = $this->tinyPng();
        $record = $this->service->storeBytes($this->app, 'hero-banner.png', $png, 'gallery/2026', 'user-42', 'ada@example.test', false);

        self::assertSame('hero-banner.png', $record['originalFilename']);
        self::assertSame('gallery/2026', $record['folder']);
        self::assertSame('image/png', $record['mimeType']);
        self::assertSame('images', $record['category']);
        self::assertSame('approved', $record['status']);
        self::assertSame(strlen($png), $record['sizeBytes']);
        self::assertSame(hash('sha256', $png), $record['sha256']);
        self::assertStringStartsWith('/api/app/my-site/native/uploads/', $record['url']);

        // Isolated per-app directory + fail-closed .htaccess
        self::assertFileExists($this->tmpDir . DIRECTORY_SEPARATOR . '.htaccess');
        $row = $this->service->getUploadRow('app-sandbox-1', $record['id']);
        self::assertNotNull($row);
        $diskPath = $this->service->resolveFilePath('app-sandbox-1', $row['stored_filename']);
        self::assertNotNull($diskPath);
        self::assertSame($png, file_get_contents($diskPath));
        // Stored filename uses UUID, never raw client filename
        self::assertStringNotContainsString('hero-banner', basename($diskPath));
    }

    public function testBlocksExecutableDoubleExtensionsAndSvgAndHtml(): void
    {
        $png = $this->tinyPng();
        foreach (['shell.php', 'avatar.php.png', 'payload.phtml.jpg', 'script.js', 'page.html', 'xss.svg', '.htaccess'] as $badName) {
            try {
                $this->service->storeBytes($this->app, $badName, $png, '', null, 'Visitor', false);
                self::fail("Expected {$badName} to be rejected by upload sandbox.");
            } catch (InvalidArgumentException $e) {
                self::assertNotSame('', $e->getMessage());
            }
        }
    }

    public function testBlocksSpoofedMimeAndPolyglotScriptPayloads(): void
    {
        // PHP script disguised as .png
        try {
            $this->service->storeBytes($this->app, 'fake.png', '<?php system($_GET["c"]); ?>', '', null, 'Visitor', false);
            self::fail('Expected spoofed PHP-as-PNG to be rejected.');
        } catch (InvalidArgumentException $e) {
            self::assertStringContainsString('blocked by the upload sandbox', $e->getMessage());
        }

        // HTML/script polyglot disguised as .txt
        try {
            $this->service->storeBytes($this->app, 'notes.txt', '<html><body><script>alert(1)</script></body></html>', '', null, 'Visitor', false);
            self::fail('Expected HTML polyglot in .txt to be rejected.');
        } catch (InvalidArgumentException $e) {
            self::assertStringContainsString('blocked by the upload sandbox', $e->getMessage());
        }

        // Plain safe text file succeeds
        $ok = $this->service->storeBytes($this->app, 'readme.txt', "Hello from a safe SoftN upload.\n", '', null, 'Visitor', false);
        self::assertSame('documents', $ok['category']);
        self::assertSame('text/plain; charset=utf-8', $ok['mimeType']);
    }

    public function testQuarantineReviewAndApprovalLifecycle(): void
    {
        $appWithQuarantine = $this->app;
        $appWithQuarantine['settings']['nativeUploads']['requireQuarantineReview'] = true;

        // Visitor upload enters quarantine
        $visitorUpload = $this->service->storeBytes($appWithQuarantine, 'receipt.txt', 'Order #1234', 'orders', null, 'Visitor', false);
        self::assertSame('quarantined', $visitorUpload['status']);

        // Owner upload bypasses quarantine
        $ownerUpload = $this->service->storeBytes($appWithQuarantine, 'logo.png', $this->tinyPng(), '', 'owner-1', 'Owner', true);
        self::assertSame('approved', $ownerUpload['status']);

        $stats = $this->service->getStats('app-sandbox-1', $this->service->getPolicy($appWithQuarantine));
        self::assertSame(2, $stats['totalFiles']);
        self::assertSame(1, $stats['approvedFiles']);
        self::assertSame(1, $stats['quarantinedFiles']);

        // Approve the quarantined file
        $approved = $this->service->updateUpload('app-sandbox-1', 'my-site', $visitorUpload['id'], ['status' => 'approved', 'notes' => 'Verified safe']);
        self::assertNotNull($approved);
        self::assertSame('approved', $approved['status']);
        self::assertSame('Verified safe', $approved['notes']);

        // Delete removes both DB row and file from disk
        $row = $this->service->getUploadRow('app-sandbox-1', $visitorUpload['id']);
        $diskPath = $this->service->resolveFilePath('app-sandbox-1', (string) $row['stored_filename']);
        self::assertNotNull($diskPath);
        self::assertTrue($this->service->deleteUpload('app-sandbox-1', $visitorUpload['id']));
        self::assertFileDoesNotExist($diskPath);
        self::assertNull($this->service->getUploadRow('app-sandbox-1', $visitorUpload['id']));
    }

    public function testEnforcesCategoryPolicyAndQuota(): void
    {
        // Audio is not in allowedCategories (['images', 'documents'])
        try {
            $this->service->storeBytes($this->app, 'clip.mp3', "ID3\x03\x00\x00\x00\x00\x00\x00test", '', null, 'Visitor', false);
            self::fail('Expected audio upload to be rejected when audio category is disabled.');
        } catch (InvalidArgumentException $e) {
            self::assertStringContainsString('audio', $e->getMessage());
        }

        // Per-file limit check (policy set to 1 MB)
        $tight = $this->app;
        $tight['settings']['nativeUploads']['maxFileSizeMb'] = 1;
        try {
            $this->service->storeBytes($tight, 'big.txt', str_repeat('A', 1024 * 1024 + 5), '', null, 'Visitor', false);
            self::fail('Expected oversized file to be rejected.');
        } catch (InvalidArgumentException $e) {
            self::assertStringContainsString('1 MB', $e->getMessage());
        }
    }
}

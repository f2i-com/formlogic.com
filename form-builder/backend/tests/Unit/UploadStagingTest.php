<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\FileStorageService;
use PHPUnit\Framework\TestCase;

/**
 * Upload staging + abandoned-upload GC (audit FL-006): every upload starts
 * with a pending marker; committing a response removes the markers of the
 * files it references; the sweeper reclaims only files whose marker outlived
 * the TTL. Committed files are never touched by the sweep.
 *
 * storeFile() insists on is_uploaded_file(), so these tests build the staged
 * state the way storeFile does (file + .pending marker) and exercise the
 * lifecycle methods directly.
 */
class UploadStagingTest extends TestCase
{
    private string $root;
    private FileStorageService $storage;
    private string $formId = 'form-staging-test';

    protected function setUp(): void
    {
        $this->root = sys_get_temp_dir() . '/fl-staging-' . bin2hex(random_bytes(5));
        mkdir($this->root, 0700, true);
        $this->storage = new FileStorageService([
            'storagePath' => $this->root,
            'maxFileSize' => 1024 * 1024,
            'allowedTypes' => ['text/plain'],
        ]);
    }

    protected function tearDown(): void
    {
        $this->storage->deleteFormFiles($this->formId);
        @rmdir($this->root);
    }

    /** Stage a file exactly the way storeFile leaves it on disk. */
    private function stage(string $fileId, ?int $markerAge = null): string
    {
        $formDir = $this->root . '/' . $this->formId;
        @mkdir($formDir . '/.pending', 0700, true);
        $stored = $fileId . '.txt';
        file_put_contents($formDir . '/' . $stored, 'data');
        $marker = $formDir . '/.pending/' . $stored;
        touch($marker, $markerAge !== null ? time() - $markerAge : time());
        return $formDir . '/' . $stored;
    }

    private function answersReferencing(string ...$fileIds): array
    {
        return [
            'attachments' => array_map(
                fn (string $id) => ['id' => $id, 'storedFilename' => $id . '.txt'],
                $fileIds
            ),
        ];
    }

    public function testCommitRemovesMarkerAndSweepSparesCommittedFiles(): void
    {
        $committedPath = $this->stage('aaaaaaaa-1111-4111-8111-111111111111', FileStorageService::PENDING_TTL_SECONDS + 60);
        $abandonedPath = $this->stage('bbbbbbbb-2222-4222-8222-222222222222', FileStorageService::PENDING_TTL_SECONDS + 60);

        // The valid submission commits ONLY the file it references.
        $this->storage->commitResponseFiles($this->formId, $this->answersReferencing('aaaaaaaa-1111-4111-8111-111111111111'));

        $reclaimed = $this->storage->sweepAbandonedUploads($this->formId);

        $this->assertSame(1, $reclaimed, 'exactly the abandoned upload is reclaimed');
        $this->assertFileExists($committedPath, 'a referenced (committed) file must survive the sweep');
        $this->assertFileDoesNotExist($abandonedPath, 'the abandoned upload must disappear after the TTL');
    }

    public function testFreshPendingUploadsAreNotSwept(): void
    {
        $freshPath = $this->stage('cccccccc-3333-4333-8333-333333333333'); // just uploaded

        $this->assertSame(0, $this->storage->sweepAbandonedUploads($this->formId));
        $this->assertFileExists($freshPath, 'an upload inside the TTL window must survive');
    }

    public function testSweepIsThrottledPerForm(): void
    {
        $this->stage('dddddddd-4444-4444-8444-444444444444', FileStorageService::PENDING_TTL_SECONDS + 60);
        $this->assertSame(1, $this->storage->sweepAbandonedUploads($this->formId));

        // Another expired upload appears, but this hour's sweep already ran.
        $stillThere = $this->stage('eeeeeeee-5555-4555-8555-555555555555', FileStorageService::PENDING_TTL_SECONDS + 60);
        $this->assertSame(0, $this->storage->sweepAbandonedUploads($this->formId), 'hour throttle skips the rescan');
        $this->assertFileExists($stillThere);
    }

    public function testDeleteFileAlsoRemovesItsMarker(): void
    {
        $path = $this->stage('ffffffff-6666-4666-8666-666666666666');
        $marker = dirname($path) . '/.pending/' . basename($path);
        $this->assertFileExists($marker);

        $this->assertTrue($this->storage->deleteFile($this->formId, 'ffffffff-6666-4666-8666-666666666666'));
        $this->assertFileDoesNotExist($path);
        $this->assertFileDoesNotExist($marker, 'no orphaned marker after explicit delete');
    }
}

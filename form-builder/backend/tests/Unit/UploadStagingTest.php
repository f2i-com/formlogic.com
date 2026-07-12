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
            'receiptSecret' => 'unit-test-receipt-secret',
        ]);
    }

    protected function tearDown(): void
    {
        $this->storage->deleteFormFiles($this->formId);
        @rmdir($this->root);
    }

    /** Stage a file the way PRE-CLAIM storeFile left it on disk (empty "legacy" marker). */
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

    /** Stage a file exactly the way the CURRENT storeFile leaves it (claim-bearing marker). */
    private function stageWithClaim(string $fileId, string $claimToken, ?string $uploader = null): string
    {
        $path = $this->stage($fileId);
        file_put_contents(dirname($path) . '/.pending/' . basename($path), json_encode([
            'claim' => hash('sha256', $claimToken),
            'uploader' => $uploader,
            'at' => time(),
        ]));
        return $path;
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

    // ── FILE-PRIV-001: upload claims ────────────────────────────────────────────

    public function testUploadClaimInfoReflectsMarkerState(): void
    {
        $claimed = 'aaaa1111-0000-4000-8000-00000000c1a1';
        $this->stageWithClaim($claimed, 'the-claim-token', 'user-42');
        $info = $this->storage->uploadClaimInfo($this->formId, $claimed);
        $this->assertNotNull($info);
        $this->assertTrue($info['pending']);
        $this->assertFalse($info['legacy']);
        $this->assertSame('user-42', $info['uploader']);
        $this->assertSame(hash('sha256', 'the-claim-token'), $info['claimHash']);

        // Pre-claim (empty) marker → legacy, grandfathered.
        $legacy = 'bbbb2222-0000-4000-8000-00000000c1a2';
        $this->stage($legacy);
        $info = $this->storage->uploadClaimInfo($this->formId, $legacy);
        $this->assertTrue($info['pending']);
        $this->assertTrue($info['legacy']);

        // Committed file (no marker) → not pending.
        $committed = 'cccc3333-0000-4000-8000-00000000c1a3';
        $path = $this->stage($committed);
        unlink(dirname($path) . '/.pending/' . basename($path));
        $info = $this->storage->uploadClaimInfo($this->formId, $committed);
        $this->assertFalse($info['pending']);

        // Missing file → null.
        $this->assertNull($this->storage->uploadClaimInfo($this->formId, 'dddd4444-0000-4000-8000-00000000c1a4'));
    }

    // ── FILE-PRIV-001: receipt tokens ───────────────────────────────────────────

    public function testReceiptTokensAreFileBoundAndExpire(): void
    {
        $token = $this->storage->mintReceiptToken('form-a', 'file-1');
        $this->assertNotNull($token);
        $this->assertTrue($this->storage->verifyReceiptToken('form-a', 'file-1', $token));
        $this->assertFalse($this->storage->verifyReceiptToken('form-a', 'file-2', $token), 'bound to the file');
        $this->assertFalse($this->storage->verifyReceiptToken('form-b', 'file-1', $token), 'bound to the form');
        $this->assertFalse($this->storage->verifyReceiptToken('form-a', 'file-1', $token . 'x'), 'tamper-proof');
        $this->assertFalse($this->storage->verifyReceiptToken('form-a', 'file-1', 'garbage'));

        $expired = $this->storage->mintReceiptToken('form-a', 'file-1', -5);
        $this->assertFalse($this->storage->verifyReceiptToken('form-a', 'file-1', $expired), 'expiry enforced');

        // No secret configured → receipts disabled, verification fails CLOSED.
        $bare = new FileStorageService(['storagePath' => $this->root]);
        $this->assertNull($bare->mintReceiptToken('form-a', 'file-1'));
        $this->assertFalse($bare->verifyReceiptToken('form-a', 'file-1', $token));
    }

    // ── FILE-PRIV-001: reference-checked GC ─────────────────────────────────────

    public function testAbandonedSweepCommitsReferencedFilesInsteadOfDeleting(): void
    {
        // A response references this file but the commit step failed (marker survived).
        $referenced = $this->stage('9999aaaa-7777-4777-8777-777777777771', FileStorageService::PENDING_TTL_SECONDS + 60);
        $abandoned = $this->stage('9999bbbb-7777-4777-8777-777777777772', FileStorageService::PENDING_TTL_SECONDS + 60);

        $reclaimed = $this->storage->sweepAbandonedUploads(
            $this->formId,
            FileStorageService::PENDING_TTL_SECONDS,
            fn (string $fileId) => $fileId === '9999aaaa-7777-4777-8777-777777777771'
        );

        $this->assertSame(1, $reclaimed);
        $this->assertFileExists($referenced, 'a referenced pending file self-heals to committed');
        $this->assertFileDoesNotExist(dirname($referenced) . '/.pending/' . basename($referenced), 'its marker is consumed');
        $this->assertFileDoesNotExist($abandoned);
    }

    public function testOrphanSweepDeletesOnlyUnreferencedFilesAfterGrace(): void
    {
        $keep = 'eeee5555-8888-4888-8888-888888888881';   // still referenced elsewhere
        $doomed = 'ffff6666-8888-4888-8888-888888888882'; // truly orphaned
        $fresh = 'aabb7777-8888-4888-8888-888888888883';  // orphan-marked but inside grace
        $formDir = $this->root . '/' . $this->formId;
        foreach ([$keep, $doomed, $fresh] as $fid) {
            $path = $this->stage($fid);
            unlink(dirname($path) . '/.pending/' . basename($path)); // committed
            $this->storage->markOrphaned($this->formId, $fid);
        }
        // Age the keep/doomed markers past the grace window; leave fresh young.
        foreach ([$keep, $doomed] as $fid) {
            touch($formDir . '/.orphaned/' . $fid . '.txt', time() - FileStorageService::ORPHAN_GRACE_SECONDS - 60);
        }

        $deleted = $this->storage->sweepOrphanedFiles(
            $this->formId,
            fn (string $fileId) => $fileId === $keep
        );

        $this->assertSame(1, $deleted);
        $this->assertFileExists($formDir . '/' . $keep . '.txt', 'a file another response references is spared');
        $this->assertFileDoesNotExist($formDir . '/.orphaned/' . $keep . '.txt', 'its stale orphan marker is cleared');
        $this->assertFileDoesNotExist($formDir . '/' . $doomed . '.txt', 'the unreferenced orphan is reclaimed');
        $this->assertFileExists($formDir . '/' . $fresh . '.txt', 'grace period defers deletion');
        $this->assertFileExists($formDir . '/.orphaned/' . $fresh . '.txt');
    }

    public function testDeleteFormFilesClearsOrphanStagingToo(): void
    {
        $fid = 'ccdd8888-9999-4999-8999-999999999991';
        $this->stage($fid);
        $this->storage->markOrphaned($this->formId, $fid);
        $this->storage->deleteFormFiles($this->formId);
        $this->assertTrue($this->storage->formFilesRemoved($this->formId), 'form dir fully removed incl. .orphaned');
    }
}

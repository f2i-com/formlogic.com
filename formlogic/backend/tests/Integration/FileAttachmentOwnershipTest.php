<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\FileStorageService;
use FormLogic\Services\ResponseService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * FILE-PRIV-001 — attachment ownership + deferred file GC, through the real
 * ResponseService against per-form SQLite and on-disk uploads.
 *
 * Ownership: a submitter can only attach a pending upload they made (same
 * authenticated uploader, or the upload claim token); committed files can't be
 * grafted onto someone else's response; the transient claimToken never survives
 * validation into the persisted answers.
 *
 * GC: response update/delete never deletes a file inline — files are orphan-marked
 * and only physically reclaimed once the reference-checked sweep re-proves them
 * unreferenced after the grace window, so deleting one response can never break
 * another response's attachment (shared ids from restores/duplicates included).
 */
class FileAttachmentOwnershipTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static string $tmp = '';
    private static SQLiteConnection $sqlite;
    private static FileStorageService $files;
    private static ResponseService $responses;

    private string $formId = '';

    /** @var array{0: array<int, array<string,mixed>>} the form's fields (one file_upload) */
    private const FIELDS = [[
        'id' => 'f1',
        'type' => 'file_upload',
        'label' => 'Attachment',
        'properties' => [],
    ]];

    public static function setUpBeforeClass(): void
    {
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) {
            \Dotenv\Dotenv::createImmutable($root)->safeLoad();
        }
        $config = [
            'host' => $_ENV['DB_HOST'] ?? '127.0.0.1',
            'port' => $_ENV['DB_PORT'] ?? '3306',
            'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
            'username' => $_ENV['DB_USERNAME'] ?? 'root',
            'password' => $_ENV['DB_PASSWORD'] ?? '',
            'charset' => 'utf8mb4',
            'collation' => 'utf8mb4_unicode_ci',
        ];
        try {
            $conn = new MySQLConnection($config);
            $conn->getConnection()->query('SELECT 1');
            $conn->initializeSchema();
            $conn->runMigrations();
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
        self::$mysql = $conn;
        self::$pdo = $conn->getConnection();
        self::$tmp = sys_get_temp_dir() . '/fl-fileown-' . bin2hex(random_bytes(6));
        @mkdir(self::$tmp . '/forms', 0777, true);
        @mkdir(self::$tmp . '/uploads', 0777, true);
        self::$sqlite = new SQLiteConnection(self::$tmp . '/forms');
        self::$files = new FileStorageService([
            'storagePath' => self::$tmp . '/uploads',
            'receiptSecret' => 'ownership-test-secret',
        ]);
        self::$responses = new ResponseService($conn, self::$sqlite, null, null, null, self::$files);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->formId = 'fown' . bin2hex(random_bytes(8));
        // Materialize + migrate the per-form DB so direct INSERTs and lookups work.
        self::$sqlite->migrateFormDatabase(self::$sqlite->getFormDatabase($this->formId));
    }

    protected function tearDown(): void
    {
        if ($this->formId !== '') {
            self::$files->deleteFormFiles($this->formId);
            self::$pdo?->prepare('DELETE FROM response_metadata WHERE form_id = ?')->execute([$this->formId]);
        }
    }

    private function formDir(): string
    {
        return self::$tmp . '/uploads/' . $this->formId;
    }

    /** Stage a pending upload the way storeFile does (file + claim-bearing marker). */
    private function stagePending(string $fileId, string $claimToken, ?string $uploader = null): void
    {
        @mkdir($this->formDir() . '/.pending', 0700, true);
        file_put_contents($this->formDir() . '/' . $fileId . '.txt', 'body');
        file_put_contents($this->formDir() . '/.pending/' . $fileId . '.txt', json_encode([
            'claim' => hash('sha256', $claimToken),
            'uploader' => $uploader,
            'at' => time(),
        ]));
    }

    /** A committed (marker-less) file on disk. */
    private function placeCommitted(string $fileId): void
    {
        @mkdir($this->formDir(), 0700, true);
        file_put_contents($this->formDir() . '/' . $fileId . '.txt', 'body');
    }

    private function insertResponse(string $responseId, array $answers, ?string $submittedBy = null): void
    {
        $db = self::$sqlite->getFormDatabase($this->formId);
        $db->prepare("INSERT INTO responses (id, answers, metadata, status, submitted_at, updated_at) VALUES (?, ?, ?, 'submitted', datetime('now'), datetime('now'))")
            ->execute([$responseId, json_encode($answers), json_encode(['submittedByUserId' => $submittedBy])]);
    }

    private function fileAnswer(string $fileId, ?string $claimToken = null): array
    {
        $item = [
            'id' => $fileId,
            'originalFilename' => 'doc.txt',
            'storedFilename' => $fileId . '.txt',
            'url' => "/api/files/{$this->formId}/{$fileId}/doc.txt",
        ];
        if ($claimToken !== null) {
            $item['claimToken'] = $claimToken;
        }
        return ['f1' => [$item]];
    }

    // ── Pending uploads: claim / uploader binding ───────────────────────────────

    public function testAnonymousSubmitterNeedsTheUploadClaim(): void
    {
        $fid = 'aaaa' . bin2hex(random_bytes(6));
        $this->stagePending($fid, 'secret-claim');

        // No claim → rejected with the same message as a missing file (no oracle).
        $answers = $this->fileAnswer($fid);
        $errors = self::$responses->validateFileAnswers(self::FIELDS, $answers, $this->formId, null);
        $this->assertArrayHasKey('f1', $errors);
        $this->assertStringContainsString('could not be found', $errors['f1']);

        // Wrong claim → rejected.
        $answers = $this->fileAnswer($fid, 'not-the-claim');
        $errors = self::$responses->validateFileAnswers(self::FIELDS, $answers, $this->formId, null);
        $this->assertArrayHasKey('f1', $errors);

        // Correct claim → accepted, and the token is STRIPPED from the answers.
        $answers = $this->fileAnswer($fid, 'secret-claim');
        $errors = self::$responses->validateFileAnswers(self::FIELDS, $answers, $this->formId, null);
        $this->assertSame([], $errors);
        $this->assertArrayNotHasKey('claimToken', $answers['f1'][0], 'claim token must never persist');
    }

    public function testAuthenticatedUploaderBindingAllowsOnlyTheUploader(): void
    {
        $fid = 'bbbb' . bin2hex(random_bytes(6));
        $this->stagePending($fid, 'their-claim', 'user-uploader');

        // The uploader themselves: no claim echo needed.
        $answers = $this->fileAnswer($fid);
        $errors = self::$responses->validateFileAnswers(self::FIELDS, $answers, $this->formId, ['submitterUserId' => 'user-uploader']);
        $this->assertSame([], $errors);

        // A different authenticated user without the claim: rejected.
        $answers = $this->fileAnswer($fid);
        $errors = self::$responses->validateFileAnswers(self::FIELDS, $answers, $this->formId, ['submitterUserId' => 'user-other']);
        $this->assertArrayHasKey('f1', $errors);

        // The form owner may attach any of the form's files.
        $answers = $this->fileAnswer($fid);
        $errors = self::$responses->validateFileAnswers(self::FIELDS, $answers, $this->formId, ['isOwner' => true]);
        $this->assertSame([], $errors);
    }

    public function testLegacyPreClaimPendingUploadsAreGrandfathered(): void
    {
        // A marker created by the pre-claim @touch (deploy-boundary in-flight fill).
        $fid = 'cccc' . bin2hex(random_bytes(6));
        @mkdir($this->formDir() . '/.pending', 0700, true);
        file_put_contents($this->formDir() . '/' . $fid . '.txt', 'body');
        touch($this->formDir() . '/.pending/' . $fid . '.txt');

        $answers = $this->fileAnswer($fid);
        $errors = self::$responses->validateFileAnswers(self::FIELDS, $answers, $this->formId, null);
        $this->assertSame([], $errors, 'legacy pending uploads stay attachable until the TTL sweeps them');
    }

    // ── Committed files: no cross-submitter grafting ────────────────────────────

    public function testCommittedFileCannotBeAttachedToAnotherSubmittersResponse(): void
    {
        $fid = 'dddd' . bin2hex(random_bytes(6));
        $this->placeCommitted($fid);
        $this->insertResponse('resp-victim', $this->fileAnswer($fid), 'user-victim');

        // A stranger (even authenticated) cannot attach the victim's committed file.
        $answers = $this->fileAnswer($fid);
        $errors = self::$responses->validateFileAnswers(self::FIELDS, $answers, $this->formId, ['submitterUserId' => 'user-attacker']);
        $this->assertArrayHasKey('f1', $errors, 'committed files are not attachable by others');

        // Anonymous (with no claim — committed files have none) is rejected too.
        $answers = $this->fileAnswer($fid);
        $errors = self::$responses->validateFileAnswers(self::FIELDS, $answers, $this->formId, null);
        $this->assertArrayHasKey('f1', $errors);

        // Its own submitter may re-attach it (e.g. re-submitting after an edit).
        $answers = $this->fileAnswer($fid);
        $errors = self::$responses->validateFileAnswers(self::FIELDS, $answers, $this->formId, ['submitterUserId' => 'user-victim']);
        $this->assertSame([], $errors);

        // And an UPDATE of the response that already holds it keeps it valid.
        $answers = $this->fileAnswer($fid);
        $errors = self::$responses->validateFileAnswers(self::FIELDS, $answers, $this->formId, ['existingResponseId' => 'resp-victim']);
        $this->assertSame([], $errors);
    }

    // ── Deferred GC: cross-response + concurrency safety ────────────────────────

    /** Age every orphan marker past the grace window so the sweep may act on them. */
    private function ageOrphanMarkers(): void
    {
        foreach (glob($this->formDir() . '/.orphaned/*') ?: [] as $marker) {
            touch($marker, time() - FileStorageService::ORPHAN_GRACE_SECONDS - 60);
        }
    }

    public function testDeletingOneResponseCannotBreakAnotherResponsesAttachment(): void
    {
        $fid = 'eeee' . bin2hex(random_bytes(6));
        $this->placeCommitted($fid);
        // Two responses share the file id (restore/duplicate/legacy data shape).
        $this->insertResponse('resp-a', $this->fileAnswer($fid));
        $this->insertResponse('resp-b', $this->fileAnswer($fid));

        $this->assertTrue(self::$responses->deleteResponse($this->formId, 'resp-a'));
        $this->assertFileExists($this->formDir() . '/' . $fid . '.txt', 'no inline delete — file survives the mutation');

        // Even a forced, aged sweep spares it: resp-b still references it.
        $this->ageOrphanMarkers();
        self::$responses->sweepFileGarbage($this->formId, true);
        $this->assertFileExists($this->formDir() . '/' . $fid . '.txt', 'reference-checked GC spares the shared file');

        // Once the LAST reference goes, the aged sweep reclaims it.
        $this->assertTrue(self::$responses->deleteResponse($this->formId, 'resp-b'));
        $this->ageOrphanMarkers();
        self::$responses->sweepFileGarbage($this->formId, true);
        $this->assertFileDoesNotExist($this->formDir() . '/' . $fid . '.txt', 'unreferenced file reclaimed after grace');
    }

    // ── Anonymous receipts: webhook payload urls ────────────────────────────────

    public function testWebhookPayloadCarriesVerifiableReceiptUrlsForStandaloneForms(): void
    {
        $fid = '9f9f' . bin2hex(random_bytes(6));
        $this->placeCommitted($fid);
        $this->insertResponse('resp-hook', $this->fileAnswer($fid));

        $captured = null;
        $webhooks = $this->createMock(\FormLogic\Services\WebhookService::class);
        $webhooks->method('dispatch')->willReturnCallback(function (string $formId, string $event, array $payload) use (&$captured) {
            $captured = $payload;
        });
        $svc = new ResponseService(self::$mysql, self::$sqlite, null, null, $webhooks, self::$files);

        $svc->updateResponse($this->formId, 'resp-hook', ['answers' => $this->fileAnswer($fid)]);

        $this->assertNotNull($captured, 'webhook dispatched');
        $url = $captured['answers']['f1'][0]['url'] ?? '';
        $this->assertStringContainsString('?rt=', $url, 'file url carries a receipt token');
        $token = substr($url, strpos($url, '?rt=') + 4);
        $this->assertTrue(self::$files->verifyReceiptToken($this->formId, $fid, $token), 'the receipt verifies for this exact file');

        // The STORED answers keep the clean, auth-required url — tokens live only in the payload.
        $stored = $svc->getResponse($this->formId, 'resp-hook');
        $this->assertStringNotContainsString('?rt=', (string) ($stored['answers']['f1'][0]['url'] ?? ''));
    }

    public function testUpdateDroppingAFileDefersDeletionUntilProvedUnreferenced(): void
    {
        $fid = 'ffff' . bin2hex(random_bytes(6));
        $this->placeCommitted($fid);
        $this->insertResponse('resp-u', $this->fileAnswer($fid));

        // The update replaces the attachment with nothing.
        $updated = self::$responses->updateResponse($this->formId, 'resp-u', ['answers' => ['f1' => []]]);
        $this->assertNotNull($updated);
        $this->assertFileExists($this->formDir() . '/' . $fid . '.txt', 'dropped file is orphan-marked, not deleted inline');
        $this->assertFileExists($this->formDir() . '/.orphaned/' . $fid . '.txt');

        // A concurrent writer re-referencing the id is healed by the sweep (marker cleared).
        $this->insertResponse('resp-racer', $this->fileAnswer($fid));
        $this->ageOrphanMarkers();
        self::$responses->sweepFileGarbage($this->formId, true);
        $this->assertFileExists($this->formDir() . '/' . $fid . '.txt', 'a raced re-reference survives the sweep');
        $this->assertFileDoesNotExist($this->formDir() . '/.orphaned/' . $fid . '.txt', 'stale orphan marker cleared');
    }
}

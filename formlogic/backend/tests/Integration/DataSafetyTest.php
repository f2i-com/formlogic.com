<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\FileStorageService;

/**
 * Small things that lose data or leave it stuck: a status the index can't hold, an upload folder
 * mistaken for a form, a first-create race.
 */
final class DataSafetyTest extends E2eeTestCase
{
    private function aForm(?string $id = null): array
    {
        return self::$forms->createForm(array_filter([
            'id' => $id,
            'title' => 'Safety',
            'userId' => $this->userId,
            'status' => 'published',
            'fields' => [['id' => 'name', 'type' => 'short_text', 'label' => 'Name', 'required' => false]],
        ], static fn ($value) => $value !== null));
    }

    private function mirrored(string $responseId): ?string
    {
        $stmt = self::$pdo->prepare('SELECT status FROM response_metadata WHERE id = ?');
        $stmt->execute([$responseId]);
        return $stmt->fetchColumn() ?: null;
    }

    public function testASpamStatusIsMirroredAsArchivedAndNeverFailsTheWrite(): void
    {
        $form = $this->aForm();
        $created = self::$responses->createResponse((string) $form['id'], ['answers' => ['name' => 'Ada']], null);

        self::$responses->updateResponse((string) $form['id'], (string) $created['id'], ['status' => 'spam']);

        $this->assertSame('archived', $this->mirrored((string) $created['id']));
        $row = self::$sqlite->getFormDatabase((string) $form['id'])->query('SELECT status FROM responses LIMIT 1')->fetchColumn();
        $this->assertSame('spam', $row, 'the record itself keeps what the script said');
    }

    public function testAnUploadFolderIsFoundByItsForm(): void
    {
        $root = self::$tmpRoot . '/uploads-' . bin2hex(random_bytes(4));
        mkdir($root . '/teamintake', 0777, true);
        $files = new FileStorageService(['storagePath' => $root]);

        $this->assertTrue($files->hasUploads('team_intake'), 'upload folders drop the underscore');
        $this->assertFalse($files->hasUploads('someone_else'));
        $this->assertFalse($files->hasUploads('___'), 'an id that sanitises to nothing is not the root');
    }

    public function testBuildingAFormsFileLeavesNoLockBehind(): void
    {
        $form = $this->aForm();
        $path = self::$sqlite->getFormDbPath((string) $form['id']);
        $this->assertFileExists($path);
        $this->assertFileDoesNotExist($path . '.init');
    }

    public function testATrashClaimAWorkerDiedHoldingLapses(): void
    {
        $item = 't-' . bin2hex(random_bytes(8));
        self::$pdo->prepare("INSERT INTO trash_items (id, user_id, kind, original_id, name, zip_path, status, claimed_at, expires_at)
            VALUES (?, ?, 'form', 'f', 'Gone', 'missing.zip', 'restoring', NOW() - INTERVAL 31 MINUTE, NOW() + INTERVAL 1 DAY)")
            ->execute([$item, $this->userId]);
        $service = $this->trash();

        // The claim is taken again: the snapshot being missing is what stops it now, and it is released.
        try {
            $service->restore($item, $this->userId);
            $this->fail('the file is missing');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('missing from the server', $e->getMessage());
        }
        $status = self::$pdo->prepare('SELECT status FROM trash_items WHERE id = ?');
        $status->execute([$item]);
        $this->assertSame('trashed', $status->fetchColumn());
    }

    public function testARestoreStillRunningKeepsItsClaim(): void
    {
        $item = 't-' . bin2hex(random_bytes(8));
        self::$pdo->prepare("INSERT INTO trash_items (id, user_id, kind, original_id, name, zip_path, status, claimed_at, expires_at)
            VALUES (?, ?, 'form', 'f', 'Gone', 'missing.zip', 'restoring', NOW() - INTERVAL 5 MINUTE, NOW() + INTERVAL 1 DAY)")
            ->execute([$item, $this->userId]);

        $this->expectExceptionMessage('already being restored');
        $this->trash()->restore($item, $this->userId);
    }

    private function trash(): \FormLogic\Services\TrashService
    {
        $backup = new \FormLogic\Services\AccountBackupService(self::$mysql, self::$sqlite, self::$forms, self::$apps, self::$appUsers, self::$flows, self::$responses, [], self::$tmpRoot . '/sqlite', self::$uploadsPath);
        return new \FormLogic\Services\TrashService(self::$mysql, self::$sqlite, $backup, self::$forms, self::$apps, self::$flows, ['path' => self::$tmpRoot . '/trash-' . bin2hex(random_bytes(4))], new \Psr\Log\NullLogger());
    }

    public function testADumpedStatementFitsAServersPacketLimit(): void
    {
        // Twenty rows of 200 KB: past 4 MB as one statement, well under the old 200 rows.
        for ($i = 0; $i < 20; $i++) {
            $form = $this->aForm();
            self::$pdo->prepare('UPDATE forms SET custom_screen = ? WHERE id = ?')->execute([str_repeat('x', 200 * 1024), $form['id']]);
        }
        $upgrade = (new \ReflectionClass(\FormLogic\Services\UpgradeService::class))->newInstanceWithoutConstructor();
        (new \ReflectionProperty(\FormLogic\Services\UpgradeService::class, 'pdo'))->setValue($upgrade, self::$pdo);
        $out = self::$tmpRoot . '/dump-' . bin2hex(random_bytes(4)) . '.sql.gz';

        $upgrade->dumpDatabase($out);

        $largest = 0;
        $gz = gzopen($out, 'rb');
        while (($line = gzgets($gz, 64 * 1024 * 1024)) !== false) {
            $largest = max($largest, strlen($line));
        }
        gzclose($gz);
        $this->assertLessThan(3 * 1024 * 1024, $largest, 'every statement fits the smallest max_allowed_packet in common use');
    }
}

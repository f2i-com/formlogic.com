<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Services\AccountBackupService;
use FormLogic\Services\FormEncryptionService;
use FormLogic\Services\TrashService;

/**
 * Trash/restore key + manifest-row lifecycle (plan §7 rules + P3 gate
 * "Trash → restore → decrypt; trash purge removes key + schema + manifest rows"):
 * trash PARKS encryption rows (never deletes them), restore re-activates them
 * with ids intact, purge removes every encryption row for the form.
 */
class E2eeTrashLifecycleTest extends E2eeTestCase
{
    private static AccountBackupService $backup;
    private static TrashService $trash;

    public static function setUpBeforeClass(): void
    {
        parent::setUpBeforeClass();
        $trashDir = self::$tmpRoot . '/trash';
        mkdir($trashDir, 0777, true);
        self::$backup = new AccountBackupService(
            self::$mysql,
            self::$sqlite,
            self::$forms,
            self::$apps,
            self::$appUsers,
            self::$flows,
            self::$responses,
            [],
            self::$tmpRoot . '/sqlite',
            self::$uploadsPath
        );
        self::$trash = new TrashService(
            self::$mysql,
            self::$sqlite,
            self::$backup,
            self::$forms,
            self::$apps,
            self::$flows,
            ['retentionDays' => 30, 'dir' => $trashDir]
        );
    }

    public function testTrashParksRestoreReactivatesPurgeDeletes(): void
    {
        $form = $this->makeDraftForm();
        $formId = (string) $form['id'];
        $this->enablePrivateForm($formId);
        self::$forms->updateForm($formId, ['status' => 'published']);
        $env = $this->makeEnvelope($formId);
        self::$responses->createEncryptedResponse($formId, $env, null, null);

        // ── Trash: rows PARKED ('trashed'), manifests untouched, gates stay closed.
        $result = self::$trash->trashForm($formId, $this->userId);
        $this->assertTrue($result['trashed'] ?? false);
        FormEncryptionService::invalidateCache();

        $this->assertNull($this->row('SELECT 1 AS x FROM forms WHERE id = ?', [$formId]));
        $this->assertSame('trashed', $this->row('SELECT state FROM form_encryption WHERE form_id = ?', [$formId])['state']);
        $this->assertSame('trashed', $this->row('SELECT state FROM form_ingestion_keys WHERE form_id = ?', [$formId])['state']);
        $this->assertSame('trashed', $this->row('SELECT state FROM form_key_grants WHERE form_id = ?', [$formId])['state']);
        // Manifests are append-only and carry no state — they stay put.
        $this->assertNotNull($this->row('SELECT 1 AS x FROM form_manifests WHERE form_id = ?', [$formId]));
        $this->assertNotNull($this->row('SELECT 1 AS x FROM form_schema_versions WHERE form_id = ?', [$formId]));
        // …and the form still counts as private (no plaintext re-opening via trash).
        $this->assertTrue(self::$encryption->isPrivate($formId));

        // ── Restore: same ids back, rows re-activated, ciphertext intact.
        $item = $this->row('SELECT id FROM trash_items WHERE original_id = ? AND user_id = ?', [$formId, $this->userId]);
        $this->assertNotNull($item);
        self::$trash->restore((string) $item['id'], $this->userId);
        FormEncryptionService::invalidateCache();

        $this->assertNotNull($this->row('SELECT 1 AS x FROM forms WHERE id = ?', [$formId]));
        $this->assertSame('active', $this->row('SELECT state FROM form_encryption WHERE form_id = ?', [$formId])['state']);
        $this->assertSame('active', $this->row('SELECT state FROM form_ingestion_keys WHERE form_id = ?', [$formId])['state']);
        $this->assertSame('active', $this->row('SELECT state FROM form_key_grants WHERE form_id = ?', [$formId])['state']);

        // The encrypted record is back with its ORIGINAL recordId and envelope contents.
        $restoredDb = self::$sqlite->getFormDatabase($formId);
        $row = $restoredDb->query('SELECT * FROM responses LIMIT 1')->fetch(\PDO::FETCH_ASSOC);
        $this->assertSame($env['recordId'], $row['id']);
        $this->assertEquals($env, json_decode((string) $row['answers'], true));
        unset($restoredDb, $row);
        // Windows file-lock hygiene: drop cached SQLite handles before the next delete.
        self::$sqlite->closeAll();

        // The manifest tuple still validates new envelopes (owner can keep collecting).
        $this->assertNotEmpty(self::$encryption->acceptableManifests($formId));

        // ── Trash again + purge ("delete forever"): every encryption row goes.
        self::$trash->trashForm($formId, $this->userId);
        $item2 = $this->row('SELECT id FROM trash_items WHERE original_id = ? AND user_id = ?', [$formId, $this->userId]);
        $this->assertNotNull($item2);
        $this->assertTrue(self::$trash->purgeItem((string) $item2['id'], $this->userId));
        FormEncryptionService::invalidateCache();

        foreach (['form_encryption', 'form_ingestion_keys', 'form_key_grants', 'form_manifests', 'form_schema_versions'] as $t) {
            $this->assertNull($this->row("SELECT 1 AS x FROM {$t} WHERE form_id = ?", [$formId]), "{$t} rows must be purged");
        }
        $this->assertFalse(self::$encryption->isPrivate($formId));
    }
}

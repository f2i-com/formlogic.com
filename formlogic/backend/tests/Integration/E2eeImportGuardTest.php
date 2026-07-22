<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Services\AccountBackupService;
use FormLogic\Services\EncryptionRequestException;
use FormLogic\Services\FormEncryptionService;

/**
 * Import-id-preservation guard + restore drill (plan §7 + P3 gate: "account
 * backup → restore drill preserves ids and decrypts; id-reminting import
 * refuses"). The form_id, recordIds, key ids and epochs are baked into envelope
 * AADs — an import that would remint ANY of them must refuse with a typed error.
 */
class E2eeImportGuardTest extends E2eeTestCase
{
    private static AccountBackupService $backup;

    public static function setUpBeforeClass(): void
    {
        parent::setUpBeforeClass();
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
    }

    public function testPlainImportRefusesPrivateForms(): void
    {
        $form = $this->makeDraftForm();
        $formId = (string) $form['id'];
        $this->enablePrivateForm($formId);
        self::$forms->updateForm($formId, ['status' => 'published']);
        $zip = self::$backup->exportAccount($this->userId);

        $otherUser = $this->makeUser();
        try {
            self::$backup->importAccount($zip, $otherUser); // preserveIds defaults to false
            $this->fail('id-reminting import must refuse private forms');
        } catch (EncryptionRequestException $e) {
            $this->assertSame('import_remint_refused', $e->errorCode);
            $this->assertSame(400, $e->status);
        } finally {
            @unlink($zip);
        }
        // Nothing was created for the other user.
        $this->assertNull($this->row('SELECT 1 AS x FROM forms WHERE user_id = ?', [$otherUser]));
        $this->assertNull($this->row('SELECT 1 AS x FROM user_vaults WHERE user_id = ?', [$otherUser]));
    }

    public function testRestoreDrillPreservesIdsAndEncryptionMaterial(): void
    {
        $form = $this->makeDraftForm();
        $formId = (string) $form['id'];
        $this->enablePrivateForm($formId);
        self::$forms->updateForm($formId, ['status' => 'published']);
        $env = $this->makeEnvelope($formId);
        self::$responses->createEncryptedResponse($formId, $env, null, null);
        $zip = self::$backup->exportAccount($this->userId);

        $keyBefore = $this->row('SELECT * FROM form_ingestion_keys WHERE form_id = ?', [$formId]);
        $manifestBefore = $this->row('SELECT * FROM form_manifests WHERE form_id = ?', [$formId]);
        $schemaBefore = $this->row('SELECT * FROM form_schema_versions WHERE form_id = ?', [$formId]);

        // Simulate disaster recovery on the SAME account: the original form + its
        // encryption rows are gone, the account itself (and its vault) survives.
        // (A restore into a DIFFERENT account is refused — encryption_not_restorable,
        // see testCrossAccountRestoreIsRefused.)
        self::$forms->deleteForm($formId);
        self::$encryption->purgeFormRows($formId);
        FormEncryptionService::invalidateCache();
        $this->assertNull($this->row('SELECT 1 AS x FROM forms WHERE id = ?', [$formId]));

        try {
            $summary = self::$backup->importAccount($zip, $this->userId, ['preserveIds' => true]);
        } finally {
            @unlink($zip);
        }
        FormEncryptionService::invalidateCache();

        // The form came back with its ORIGINAL id (byte-for-byte — it is baked into AADs).
        $restored = $this->row('SELECT * FROM forms WHERE id = ?', [$formId]);
        $this->assertNotNull($restored);
        $this->assertSame($this->userId, $restored['user_id']);

        // Key material restored byte-for-byte: same key id + epoch + wrapped secret.
        $keyAfter = $this->row('SELECT * FROM form_ingestion_keys WHERE form_id = ?', [$formId]);
        $this->assertNotNull($keyAfter);
        $this->assertSame($keyBefore['id'], $keyAfter['id']);
        $this->assertSame((int) $keyBefore['epoch'], (int) $keyAfter['epoch']);
        $this->assertSame((string) $keyBefore['public_key'], (string) $keyAfter['public_key']);
        $this->assertSame((string) $keyBefore['wrapped_secret'], (string) $keyAfter['wrapped_secret']);
        $this->assertSame('active', $keyAfter['state']);

        // The append-only manifest: exact signed bytes + signature + signer key.
        $manifestAfter = $this->row('SELECT * FROM form_manifests WHERE form_id = ?', [$formId]);
        $this->assertNotNull($manifestAfter);
        $this->assertSame((string) $manifestBefore['signed_bytes'], (string) $manifestAfter['signed_bytes']);
        $this->assertSame((string) $manifestBefore['signature'], (string) $manifestAfter['signature']);
        $this->assertSame((string) $manifestBefore['signer_pk'], (string) $manifestAfter['signer_pk']);

        // The exact schema snapshot bytes round-tripped (MEDIUMBLOB, never re-encoded).
        $schemaAfter = $this->row('SELECT * FROM form_schema_versions WHERE form_id = ?', [$formId]);
        $this->assertNotNull($schemaAfter);
        $this->assertSame((string) $schemaBefore['schema_json'], (string) $schemaAfter['schema_json']);
        $this->assertSame((string) $schemaBefore['schema_hash'], (string) $schemaAfter['schema_hash']);

        // The vault stays usable: the existing row is never overwritten (INSERT
        // IGNORE — it may be newer), and it belongs to the SAME account.
        $vault = $this->row('SELECT * FROM user_vaults WHERE user_id = ?', [$this->userId]);
        $this->assertNotNull($vault);

        // The encrypted record is back with its ORIGINAL recordId and envelope contents…
        $db = self::$sqlite->getFormDatabase($formId);
        $row = $db->query('SELECT * FROM responses LIMIT 1')->fetch(\PDO::FETCH_ASSOC);
        $this->assertSame($env['recordId'], $row['id']);
        $this->assertEquals($env, json_decode((string) $row['answers'], true));

        // …and the restored manifest still accepts new envelopes (decrypt-path intact).
        $this->assertNotEmpty(self::$encryption->acceptableManifests($formId));
        $this->assertSame('private', $this->row('SELECT mode FROM form_encryption WHERE form_id = ?', [$formId])['mode']);
    }

    public function testCrossAccountRestoreIsRefused(): void
    {
        $form = $this->makeDraftForm();
        $formId = (string) $form['id'];
        $this->enablePrivateForm($formId);
        self::$forms->updateForm($formId, ['status' => 'published']);
        $env = $this->makeEnvelope($formId);
        self::$responses->createEncryptedResponse($formId, $env, null, null);
        $zip = self::$backup->exportAccount($this->userId);

        // Security review (blocker 5): the vault's wrapped UMK is AAD-bound to the
        // OWNING account id and grants to its signed user ids — under a different
        // account id nothing unwraps. v1 fails CLOSED: the WHOLE restore is refused.
        $otherUser = $this->makeUser();
        try {
            self::$backup->importAccount($zip, $otherUser, ['preserveIds' => true]);
            $this->fail('cross-account restore of encryption material must be refused');
        } catch (EncryptionRequestException $e) {
            $this->assertSame('encryption_not_restorable', $e->errorCode);
            $this->assertSame(400, $e->status);
            $this->assertStringContainsString('cryptographically bound', $e->getMessage());
        } finally {
            @unlink($zip);
        }

        // Nothing crossed accounts: no vault row, no form, no encryption rows.
        $this->assertNull($this->row('SELECT 1 AS x FROM user_vaults WHERE user_id = ?', [$otherUser]));
        $this->assertNull($this->row('SELECT 1 AS x FROM forms WHERE user_id = ?', [$otherUser]));
        $this->assertNull($this->row('SELECT 1 AS x FROM form_key_grants WHERE user_id = ?', [$otherUser]));
        $this->assertSame('active', $this->row('SELECT state FROM form_encryption WHERE form_id = ?', [$formId])['state']);
        // Cleanup the extra user (makeUser rows aren't tracked by tearDown).
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$otherUser]);
    }

    public function testRestoreWithOccupiedIdFailsHard(): void
    {
        $form = $this->makeDraftForm();
        $formId = (string) $form['id'];
        $this->enablePrivateForm($formId);
        $zip = self::$backup->exportAccount($this->userId);

        // The original form still EXISTS → preserve-ids restore can never fall back
        // to a copy for a private form (it would sever the AAD id binding). Same
        // account, so the cross-account guard is not what fires here.
        try {
            self::$backup->importAccount($zip, $this->userId, ['preserveIds' => true]);
            $this->fail('restore into an occupied id must refuse, never copy');
        } catch (EncryptionRequestException $e) {
            $this->assertSame('import_remint_refused', $e->errorCode);
            $this->assertSame(409, $e->status);
        } finally {
            @unlink($zip);
        }
        // The original form is untouched (no duplicate, no overwrite).
        $this->assertSame(1, (int) self::$pdo->query("SELECT COUNT(*) FROM forms WHERE user_id = '{$this->userId}'")->fetchColumn());
    }
}

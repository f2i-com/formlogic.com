<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Services\AccountErasureService;
use FormLogic\Services\AuthService;

/**
 * Erasure purge (security review, blocker 6): account deletion must explicitly
 * purge the E2EE tables — user_vaults, form_key_grants, form_manifests,
 * form_ingestion_keys, form_schema_versions, form_encryption — which
 * deliberately lack cascading foreign keys. The purge is transactional and
 * verified zero before the users row may drop.
 */
class E2eeErasureTest extends E2eeTestCase
{
    private function erasure(): AccountErasureService
    {
        return new AccountErasureService(
            new AuthService(self::$mysql, ['secret' => 'e2ee-erasure-test-secret-0123456789', 'algorithm' => 'HS256']),
            self::$forms,
            self::$apps,
            null,
            null,
            self::$pdo
        );
    }

    public function testErasurePurgesEveryEncryptionTable(): void
    {
        // Seed a FULL E2EE posture: vault + private form with key/schema/manifest/grant.
        $form = $this->makeDraftForm();
        $formId = (string) $form['id'];
        $this->enablePrivateForm($formId);
        self::$forms->updateForm($formId, ['status' => 'published']);
        self::$responses->createEncryptedResponse($formId, $this->makeEnvelope($formId), null, '203.0.113.7');

        foreach (['user_vaults', 'form_encryption', 'form_ingestion_keys', 'form_key_grants', 'form_manifests', 'form_schema_versions'] as $t) {
            $where = $t === 'user_vaults' ? 'user_id' : 'form_id';
            $key = $t === 'user_vaults' ? $this->userId : $formId;
            $this->assertNotNull($this->row("SELECT 1 AS x FROM {$t} WHERE {$where} = ?", [$key]), "seed: {$t} must have rows");
        }

        $result = $this->erasure()->erase($this->userId);
        $this->assertTrue($result['completed'], 'erasure must complete: ' . json_encode($result));
        $this->assertSame(0, $result['pendingEncryption']);

        // All six E2EE tables are EMPTY for this account/form…
        $this->assertNull($this->row('SELECT 1 AS x FROM user_vaults WHERE user_id = ?', [$this->userId]));
        foreach (['form_encryption', 'form_ingestion_keys', 'form_key_grants', 'form_manifests', 'form_schema_versions'] as $t) {
            $this->assertNull($this->row("SELECT 1 AS x FROM {$t} WHERE form_id = ?", [$formId]), "{$t} rows must be purged");
        }
        // …response_metadata went with the form (§12 rows are never left behind)…
        $this->assertNull($this->row('SELECT 1 AS x FROM response_metadata WHERE form_id = ?', [$formId]));
        // …and the users row itself dropped only AFTER everything verified clean.
        $this->assertNull($this->row('SELECT 1 AS x FROM users WHERE id = ?', [$this->userId]));

        // Prevent tearDown from re-deleting the already-erased user's rows.
        $this->userId = '';
    }

    public function testErasureWithoutEncryptionRowsStillCompletes(): void
    {
        // Plaintext-only account: the encryption purge is a no-op, never a blocker.
        $form = $this->makeDraftForm();
        $result = $this->erasure()->erase($this->userId);
        $this->assertTrue($result['completed']);
        $this->assertSame(0, $result['pendingEncryption']);
        $this->assertNull($this->row('SELECT 1 AS x FROM users WHERE id = ?', [$this->userId]));
        $this->userId = '';
    }
}

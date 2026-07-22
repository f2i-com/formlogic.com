<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Services\EncryptionRequestException;

/**
 * §9.1 atomic enable preflight (plan gate: "every §9.1 precondition individually
 * violated → enable blocked with the right reason"). Each test violates exactly
 * one precondition (or asserts the happy path) and checks the typed
 * `private_enable_blocked` error carries the right `reasons[]` entry — and that
 * a failed enable wrote NOTHING (one transaction, all-or-nothing).
 */
class E2eeEnablePreflightTest extends E2eeTestCase
{
    public function testHappyPathWritesAllRowsAtomically(): void
    {
        $form = $this->makeDraftForm();
        $formId = (string) $form['id'];
        $vault = $this->makeVault($this->userId);
        $body = $this->makeEnableBody($formId, $this->userId, $vault, $form);

        $result = self::$encryption->enable($formId, $this->userId, $body);
        $this->assertTrue($result['enabled']);
        $this->assertSame(1, $result['manifestSeq']);
        $this->assertTrue(self::$encryption->isPrivate($formId));

        $enc = $this->row('SELECT * FROM form_encryption WHERE form_id = ?', [$formId]);
        $this->assertNotNull($enc);
        $this->assertSame('private', $enc['mode']);
        $this->assertSame(1, (int) $enc['current_ingest_epoch']);
        $this->assertSame(1, (int) $enc['current_fk_epoch']);
        $this->assertSame('active', $enc['state']);
        $this->assertSame($this->userId, $enc['enabled_by']);

        // Schema snapshot: EXACT bytes + the verified hash.
        $sv = $this->row('SELECT * FROM form_schema_versions WHERE form_id = ? AND version = 1', [$formId]);
        $this->assertNotNull($sv);
        $this->assertSame($body['schema']['schemaJson'], (string) $sv['schema_json']);
        $this->assertSame($body['schema']['schemaHash'], $sv['schema_hash']);
        $this->assertSame(hash('sha256', (string) $sv['schema_json']), $sv['schema_hash']);

        $key = $this->row('SELECT * FROM form_ingestion_keys WHERE form_id = ? AND epoch = 1', [$formId]);
        $this->assertNotNull($key);
        $this->assertSame($body['keyId'], $key['id']);
        $this->assertSame($body['ingestionPublicKey'], $key['public_key']);
        $this->assertSame(1, (int) $key['fk_epoch']);
        $this->assertSame('active', $key['state']);

        // Manifest: exact signed bytes + signature + the signer's verification key itself.
        $m = $this->row('SELECT * FROM form_manifests WHERE form_id = ? AND manifest_seq = 1', [$formId]);
        $this->assertNotNull($m);
        $this->assertSame($body['keyId'], $m['key_id']);
        $this->assertSame($vault['ed25519PkB64'], $m['signer_pk']);
        $this->assertSame($body['manifest']['signerKeyId'], $m['signer_key_id']);
        $expectedCanonical = $this->manifestCanonical(
            $formId, $body['keyId'], 1, $body['ingestionPublicKey'], 1,
            $body['schema']['schemaHash'], $body['manifest']['signerKeyId']
        );
        $this->assertSame($expectedCanonical, (string) $m['signed_bytes']);
        $this->assertTrue(sodium_crypto_sign_verify_detached(
            base64_decode($body['manifest']['signature']),
            (string) $m['signed_bytes'],
            base64_decode($vault['ed25519PkB64'])
        ));
        $this->assertNull($m['superseded_at']);

        $g = $this->row('SELECT * FROM form_key_grants WHERE form_id = ? AND user_id = ?', [$formId, $this->userId]);
        $this->assertNotNull($g);
        $this->assertSame($body['grant']['grantId'], $g['id']);
        $this->assertSame(1, (int) $g['fk_epoch']);
        $this->assertSame('owner', $g['role']);
        $this->assertSame('active', $g['state']);
        $this->assertSame($vault['x25519PkB64'], $g['grantee_pk']);

        // The served manifest tuple is what envelopes are accepted against.
        $tuples = self::$encryption->acceptableManifests($formId);
        $this->assertCount(1, $tuples);
        $this->assertSame($body['keyId'], $tuples[0]['key_id']);
        $this->assertSame(1, $tuples[0]['schema_version']);
        $this->assertSame($body['schema']['schemaHash'], $tuples[0]['schema_hash']);
    }

    /** Assert one blocked enable: right code, right reason(s), and zero side effects. */
    private function assertEnableBlocked(string $formId, array $expectedReasons): void
    {
        $this->makeVault($this->userId);
        // The enable body must be well-formed, but since the preflight throws before
        // signature verification, the signing key here never gets checked.
        $body = $this->makeEnableBody($formId, $this->userId, $this->vaultKeys($this->userId));
        try {
            self::$encryption->enable($formId, $this->userId, $body);
            $this->fail('enable must be blocked, reasons: ' . implode(',', $expectedReasons));
        } catch (EncryptionRequestException $e) {
            $this->assertSame('private_enable_blocked', $e->errorCode);
            $this->assertSame(409, $e->status);
            $reasons = $e->details['reasons'] ?? [];
            foreach ($expectedReasons as $reason) {
                $this->assertContains($reason, $reasons);
            }
        }
        // Atomicity: a failed enable leaves NO trace.
        foreach (['form_encryption', 'form_ingestion_keys', 'form_key_grants', 'form_manifests', 'form_schema_versions'] as $t) {
            $this->assertNull($this->row("SELECT 1 AS x FROM {$t} WHERE form_id = ?", [$formId]), "{$t} must stay empty after a blocked enable");
        }
        $this->assertFalse(self::$encryption->isPrivate($formId));
    }

    /** makeVault stores pubkeys only; rebuild the helper's key array shape from the row. */
    private function vaultKeys(string $userId): array
    {
        $row = $this->row('SELECT x25519_pk, ed25519_pk FROM user_vaults WHERE user_id = ?', [$userId]);
        // The enable body signature needs the SECRET key — for preflight-blocked
        // enables the signature is never verified, so a random one is fine.
        $sign = sodium_crypto_sign_keypair();
        return [
            'x25519PkB64' => (string) $row['x25519_pk'],
            'ed25519PkB64' => (string) $row['ed25519_pk'],
            'ed25519SkRaw' => sodium_crypto_sign_secretkey($sign),
        ];
    }

    public function testEverPublishedBlocks(): void
    {
        $form = self::$forms->createForm([
            'title' => 'Published', 'userId' => $this->userId, 'status' => 'published',
            'fields' => [['id' => 'name', 'type' => 'short_text', 'label' => 'Name']],
        ]);
        $this->assertNotNull($this->row('SELECT ever_published_at FROM forms WHERE id = ?', [$form['id']])['ever_published_at']);
        $this->assertEnableBlocked((string) $form['id'], ['ever_published']);
    }

    public function testPublishAfterCreationAlsoBlocks(): void
    {
        $form = $this->makeDraftForm();
        self::$forms->updateForm((string) $form['id'], ['status' => 'published']);
        $this->assertEnableBlocked((string) $form['id'], ['ever_published']);
    }

    public function testHasResponsesBlocks(): void
    {
        $form = $this->makeDraftForm();
        self::$responses->createResponse((string) $form['id'], ['answers' => ['name' => 'Alice']], null);
        $this->assertEnableBlocked((string) $form['id'], ['has_responses']);
    }

    public function testResponseMetadataMirrorAloneBlocks(): void
    {
        $form = $this->makeDraftForm();
        self::$pdo->prepare("INSERT INTO response_metadata (id, form_id, status, submitted_at) VALUES (?, ?, 'submitted', NOW())")
            ->execute([$this->uuidV4(), $form['id']]);
        $this->assertEnableBlocked((string) $form['id'], ['has_responses']);
    }

    public function testPendingUploadsBlock(): void
    {
        $form = $this->makeDraftForm();
        $pending = self::$uploadsPath . '/' . $form['id'] . '/.pending';
        mkdir($pending, 0777, true);
        file_put_contents($pending . '/file_1.bin', '{}');
        $this->assertEnableBlocked((string) $form['id'], ['pending_uploads']);
    }

    public function testWebhooksBlock(): void
    {
        $form = $this->makeDraftForm();
        self::$webhooks->createWebhook((string) $form['id'], $this->userId, 'https://example.com/hook', ['response.created']);
        $this->assertEnableBlocked((string) $form['id'], ['has_webhooks']);
    }

    public function testFlowBindingsBlock(): void
    {
        $form = $this->makeDraftForm();
        self::$flows->createWorkspaceFlow($this->userId, ['name' => 'WF', 'slug' => 'wf-' . bin2hex(random_bytes(3))]);
        $slug = self::$pdo->query("SELECT slug FROM flow_definitions WHERE owner_user_id = " . self::$pdo->quote($this->userId))->fetchColumn();
        self::$flows->createFormBinding($this->userId, (string) $form['id'], ['flow' => $slug, 'event' => 'form.submitted', 'mode' => 'async']);
        $this->assertEnableBlocked((string) $form['id'], ['has_flow_bindings']);
    }

    public function testFlowNodesReferencingFormBlock(): void
    {
        $form = $this->makeDraftForm();
        $flow = self::$flows->createWorkspaceFlow($this->userId, ['name' => 'Node flow', 'slug' => 'nf-' . bin2hex(random_bytes(3))]);
        // A formlogic_list_responses node referencing the form inside flow_json.
        self::$pdo->prepare('UPDATE flow_definitions SET flow_json = ? WHERE id = ?')
            ->execute([json_encode(['nodes' => [['id' => 'n1', 'type' => 'formlogic_list_responses', 'data' => ['form' => $form['id']]]]]), $flow['id']]);
        $this->assertEnableBlocked((string) $form['id'], ['has_flow_nodes']);
    }

    public function testReportSpecsBlock(): void
    {
        $form = $this->makeDraftForm();
        $app = self::$apps->createApp(['name' => 'Reports app'], $this->userId);
        self::$pdo->prepare('UPDATE apps SET reports = ? WHERE id = ?')
            ->execute([json_encode([['name' => 'R', 'spec' => ['formId' => $form['id'], 'viz' => 'kpi']]]), $app['id']]);
        $this->assertEnableBlocked((string) $form['id'], ['has_report_specs']);
    }

    public function testCustomScreenBlocks(): void
    {
        $form = $this->makeDraftForm();
        self::$forms->updateForm((string) $form['id'], ['customScreen' => ['publicRecords' => true, 'publicRecordFields' => ['name']]]);
        $this->assertEnableBlocked((string) $form['id'], ['has_custom_screen']);
    }

    public function testResponseLinksBlock(): void
    {
        $form = $this->makeDraftForm();
        $other = $this->makeDraftForm();
        self::$pdo->prepare('INSERT INTO response_links (id, source_form_id, source_response_id, target_form_id, target_response_id, field_id) VALUES (?, ?, ?, ?, ?, ?)')
            ->execute([$this->uuidV4(), $other['id'], $this->uuidV4(), $form['id'], $this->uuidV4(), 'f1']);
        $this->assertEnableBlocked((string) $form['id'], ['has_response_links']);
    }

    public static function blockedFieldTypes(): array
    {
        return [
            'file_upload (P4)' => ['file_upload'],
            'camera (P4)' => ['camera'],
            'linked_record' => ['linked_record'],
        ];
    }

    /** @dataProvider blockedFieldTypes */
    public function testBlockedFieldTypesBlock(string $type): void
    {
        $form = $this->makeDraftForm(null, [
            ['id' => 'f1', 'type' => $type, 'label' => 'F', 'required' => false],
        ]);
        $this->assertEnableBlocked((string) $form['id'], ['blocked_field_types']);
    }

    public function testTargetedByLinkedRecordBlocks(): void
    {
        $candidate = $this->makeDraftForm();
        $this->makeDraftForm(null, [
            ['id' => 'link', 'type' => 'linked_record', 'label' => 'L', 'required' => false,
             'properties' => ['targetFormId' => $candidate['id'], 'displayFieldIds' => ['name']]],
        ]);
        $this->assertEnableBlocked((string) $candidate['id'], ['targeted_by_linked_record']);
    }

    public function testAttachedToAppBlocks(): void
    {
        $form = $this->makeDraftForm();
        $app = self::$apps->createApp(['name' => 'A'], $this->userId);
        self::$apps->addFormToApp((string) $app['id'], (string) $form['id']);
        $this->assertEnableBlocked((string) $form['id'], ['attached_to_app']);
    }

    public function testMissingVaultBlocks(): void
    {
        $form = $this->makeDraftForm();
        // No vault for this user — the enable body is well-formed but preflight says no_vault.
        $sign = sodium_crypto_sign_keypair();
        $box = sodium_crypto_box_keypair();
        $vault = [
            'x25519PkB64' => base64_encode(sodium_crypto_box_publickey($box)),
            'ed25519PkB64' => base64_encode(sodium_crypto_sign_publickey($sign)),
            'ed25519SkRaw' => sodium_crypto_sign_secretkey($sign),
        ];
        try {
            self::$encryption->enable((string) $form['id'], $this->userId, $this->makeEnableBody((string) $form['id'], $this->userId, $vault, $form));
            $this->fail('enable without a vault must be blocked');
        } catch (EncryptionRequestException $e) {
            $this->assertSame('private_enable_blocked', $e->errorCode);
            $this->assertContains('no_vault', $e->details['reasons'] ?? []);
        }
    }

    public function testAlreadyEnabledBlocks(): void
    {
        $form = $this->makeDraftForm();
        $this->enablePrivateForm((string) $form['id']);
        try {
            $vault = $this->vaultKeys($this->userId);
            self::$encryption->enable((string) $form['id'], $this->userId, $this->makeEnableBody((string) $form['id'], $this->userId, $vault, $form));
            $this->fail('second enable must be blocked');
        } catch (EncryptionRequestException $e) {
            $this->assertSame('private_enable_blocked', $e->errorCode);
            $this->assertContains('already_enabled', $e->details['reasons'] ?? []);
        }
    }

    public function testMultipleViolationsAreAllReported(): void
    {
        $form = $this->makeDraftForm();
        self::$responses->createResponse((string) $form['id'], ['answers' => ['name' => 'x']], null);
        self::$webhooks->createWebhook((string) $form['id'], $this->userId, 'https://example.com/hook', ['response.created']);
        $this->assertEnableBlocked((string) $form['id'], ['has_responses', 'has_webhooks']);
    }

    public function testBadManifestSignatureIsRejected(): void
    {
        $form = $this->makeDraftForm();
        $vault = $this->makeVault($this->userId);
        $body = $this->makeEnableBody((string) $form['id'], $this->userId, $vault, $form);
        // Sign over a DIFFERENT canonical string (wrong schema hash).
        $body['manifest']['signature'] = base64_encode(sodium_crypto_sign_detached(
            $this->manifestCanonical((string) $form['id'], $body['keyId'], 1, $body['ingestionPublicKey'], 1, str_repeat('0', 64), $body['manifest']['signerKeyId']),
            $vault['ed25519SkRaw']
        ));
        try {
            self::$encryption->enable((string) $form['id'], $this->userId, $body);
            $this->fail('forged manifest must be rejected');
        } catch (EncryptionRequestException $e) {
            $this->assertSame('manifest_invalid', $e->errorCode);
        }
        $this->assertNull($this->row('SELECT 1 AS x FROM form_encryption WHERE form_id = ?', [$form['id']]));
    }

    public function testManifestSignedByAnotherKeyIsRejected(): void
    {
        $form = $this->makeDraftForm();
        $vault = $this->makeVault($this->userId);
        $body = $this->makeEnableBody((string) $form['id'], $this->userId, $vault, $form);
        // Attacker substitutes a signature from THEIR OWN key — signerKeyId no longer
        // matches the requester's vault key.
        $attacker = sodium_crypto_sign_keypair();
        $body['manifest']['signerKeyId'] = substr(hash('sha256', sodium_crypto_sign_publickey($attacker)), 0, 16);
        try {
            self::$encryption->enable((string) $form['id'], $this->userId, $body);
            $this->fail('manifest signed by a non-vault key must be rejected');
        } catch (EncryptionRequestException $e) {
            $this->assertSame('manifest_invalid', $e->errorCode);
        }
    }

    public function testBadGrantSignatureIsRejected(): void
    {
        $form = $this->makeDraftForm();
        $vault = $this->makeVault($this->userId);
        $body = $this->makeEnableBody((string) $form['id'], $this->userId, $vault, $form);
        $body['grant']['signature'] = base64_encode(random_bytes(64));
        try {
            self::$encryption->enable((string) $form['id'], $this->userId, $body);
            $this->fail('forged grant must be rejected');
        } catch (EncryptionRequestException $e) {
            $this->assertSame('grant_invalid', $e->errorCode);
        }
    }

    public function testSchemaHashMismatchIsRejected(): void
    {
        $form = $this->makeDraftForm();
        $vault = $this->makeVault($this->userId);
        $body = $this->makeEnableBody((string) $form['id'], $this->userId, $vault, $form);
        $body['schema']['schemaHash'] = hash('sha256', 'different bytes');
        try {
            self::$encryption->enable((string) $form['id'], $this->userId, $body);
            $this->fail('schemaHash not matching schemaJson bytes must be rejected');
        } catch (EncryptionRequestException $e) {
            $this->assertSame('manifest_invalid', $e->errorCode);
        }
    }
}

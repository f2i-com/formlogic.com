<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Services\EncryptionRequestException;
use FormLogic\Services\FormEncryptionService;

/**
 * Atomic publish (shared contract): the form update path accepts an optional
 * `encryptionSchema` body key ({schema:{schemaJson,schemaHash},
 * manifest:{signature,signerKeyId,expiresAt:null}}) applied in the SAME
 * transaction as the field/status save. A private PUBLISHED form whose fields
 * are changing (vs the latest signed schema snapshot) MUST carry a valid one —
 * otherwise 409 manifest_required and nothing is saved. Unchanged fields (hash
 * matches the latest manifest) need nothing.
 */
class E2eeAtomicPublishTest extends E2eeTestCase
{
    /** Canonical field JSON, matching FormService::canonicalFieldsHash. */
    private function fieldsJson(array $fields): string
    {
        return (string) json_encode($fields, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    }

    /** A private PUBLISHED form; returns [formId, vault, fields-as-enabled]. */
    private function makePublishedPrivateForm(): array
    {
        $form = $this->makeDraftForm();
        $formId = (string) $form['id'];
        ['vault' => $vault] = $this->enablePrivateForm($formId);
        self::$forms->updateForm($formId, ['status' => 'published']);
        return [$formId, $vault, $form['fields']];
    }

    public function testFieldChangeOnPublishedPrivateFormRequiresManifest(): void
    {
        [$formId, $vault, $fields] = $this->makePublishedPrivateForm();
        $newFields = array_merge($fields, [['id' => 'email', 'type' => 'short_text', 'label' => 'Email', 'required' => false]]);

        try {
            self::$forms->updateForm($formId, ['fields' => $newFields], $this->userId);
            $this->fail('field change on a published private form must require encryptionSchema');
        } catch (EncryptionRequestException $e) {
            $this->assertSame('manifest_required', $e->errorCode);
            $this->assertSame(409, $e->status);
        }

        // Nothing was saved: old fields, one schema version, one manifest.
        $this->assertNull($this->row("SELECT 1 AS x FROM form_schema_versions WHERE form_id = ? AND version > 1", [$formId]));
        $saved = array_column(self::$forms->getForm($formId)['fields'], 'id');
        $this->assertSame(['name'], $saved);
    }

    public function testAtomicPublishAppliesSchemaInSameTransaction(): void
    {
        [$formId, $vault, $fields] = $this->makePublishedPrivateForm();
        $newFields = array_merge($fields, [['id' => 'email', 'type' => 'short_text', 'label' => 'Email', 'required' => false]]);
        $encryptionSchema = $this->makeEncryptionSchema($formId, $vault, $this->fieldsJson($newFields), 2);

        $updated = self::$forms->updateForm($formId, ['fields' => $newFields, 'encryptionSchema' => $encryptionSchema], $this->userId);
        $this->assertNotNull($updated);

        // Fields saved AND the new schema version + manifest committed together.
        $saved = array_column(self::$forms->getForm($formId)['fields'], 'id');
        $this->assertSame(['name', 'email'], $saved);
        $v2 = $this->row('SELECT * FROM form_schema_versions WHERE form_id = ? AND version = 2', [$formId]);
        $this->assertNotNull($v2);
        $this->assertSame(hash('sha256', $this->fieldsJson($newFields)), $v2['schema_hash']);
        $manifest = $this->row('SELECT * FROM form_manifests WHERE form_id = ? AND superseded_at IS NULL', [$formId]);
        $this->assertNotNull($manifest);
        $this->assertSame(2, (int) $manifest['manifest_seq']);
        $this->assertSame(2, (int) $manifest['schema_version']);
        // The previous manifest was superseded.
        $this->assertNotNull($this->row('SELECT 1 AS x FROM form_manifests WHERE form_id = ? AND manifest_seq = 1 AND superseded_at IS NOT NULL', [$formId]));
        // …and the new tuple is acceptable for envelopes.
        $tuples = self::$encryption->acceptableManifests($formId);
        $this->assertContains(2, array_map(static fn (array $t) => $t['schema_version'], $tuples));
    }

    public function testInvalidManifestSignatureRollsEverythingBack(): void
    {
        [$formId, $vault, $fields] = $this->makePublishedPrivateForm();
        $newFields = array_merge($fields, [['id' => 'email', 'type' => 'short_text', 'label' => 'Email', 'required' => false]]);
        $encryptionSchema = $this->makeEncryptionSchema($formId, $vault, $this->fieldsJson($newFields), 2);
        $encryptionSchema['manifest']['signature'] = base64_encode(random_bytes(64)); // tampered

        try {
            self::$forms->updateForm($formId, ['fields' => $newFields, 'encryptionSchema' => $encryptionSchema], $this->userId);
            $this->fail('a bad manifest signature must fail the whole save');
        } catch (EncryptionRequestException $e) {
            $this->assertSame('manifest_invalid', $e->errorCode);
        }

        // Full rollback: old fields, no v2 schema row, manifest 1 still current.
        $saved = array_column(self::$forms->getForm($formId)['fields'], 'id');
        $this->assertSame(['name'], $saved);
        $this->assertNull($this->row('SELECT 1 AS x FROM form_schema_versions WHERE form_id = ? AND version = 2', [$formId]));
        $this->assertNull($this->row('SELECT 1 AS x FROM form_manifests WHERE form_id = ? AND manifest_seq = 2', [$formId]));
        $current = $this->row('SELECT * FROM form_manifests WHERE form_id = ? AND superseded_at IS NULL', [$formId]);
        $this->assertSame(1, (int) $current['manifest_seq']);
    }

    public function testUnchangedFieldsNeedNoManifest(): void
    {
        [$formId, $vault, $fields] = $this->makePublishedPrivateForm();

        // Same fields as the signed snapshot (hash matches) → no requirement.
        $updated = self::$forms->updateForm($formId, ['fields' => $fields, 'title' => 'Retitled'], $this->userId);
        $this->assertSame('Retitled', $updated['title']);
        $this->assertNull($this->row('SELECT 1 AS x FROM form_schema_versions WHERE form_id = ? AND version = 2', [$formId]));

        // A status-only save (unpublish/republish) never requires a manifest.
        $updated = self::$forms->updateForm($formId, ['status' => 'draft'], $this->userId);
        $this->assertSame('draft', $updated['status']);
        $updated = self::$forms->updateForm($formId, ['status' => 'published'], $this->userId);
        $this->assertSame('published', $updated['status']);
    }

    public function testDraftPrivateFormFieldChangeNeedsNoManifest(): void
    {
        $form = $this->makeDraftForm();
        $formId = (string) $form['id'];
        $this->enablePrivateForm($formId);

        // Draft (never published) → fields may change freely pre-launch.
        $newFields = [['id' => 'other', 'type' => 'short_text', 'label' => 'Other', 'required' => false]];
        $updated = self::$forms->updateForm($formId, ['fields' => $newFields], $this->userId);
        $this->assertSame(['other'], array_column($updated['fields'], 'id'));
    }

    public function testEncryptionSchemaOnPlaintextFormIsRefused(): void
    {
        $form = $this->makeDraftForm();
        $formId = (string) $form['id'];
        $vault = $this->makeVault($this->userId);
        $schema = [
            'schema' => ['schemaJson' => '[]', 'schemaHash' => hash('sha256', '[]')],
            'manifest' => ['signature' => base64_encode(random_bytes(64)), 'signerKeyId' => substr(hash('sha256', base64_decode($vault['ed25519PkB64'])), 0, 16), 'expiresAt' => null],
        ];
        try {
            self::$forms->updateForm($formId, ['title' => 'x', 'encryptionSchema' => $schema], $this->userId);
            $this->fail('encryptionSchema on a non-private form must be refused');
        } catch (EncryptionRequestException $e) {
            $this->assertSame('private_form_not_encrypted', $e->errorCode);
        }
        // The title save was refused with it (fail closed, no partial apply).
        $this->assertSame('Private Candidate', self::$forms->getForm($formId)['title']);
    }

    public function testPublishWithFieldChangeInOneRequestRequiresManifest(): void
    {
        // Private DRAFT form; a single request that BOTH changes fields and
        // publishes is "being published" → the manifest rule applies.
        $form = $this->makeDraftForm();
        $formId = (string) $form['id'];
        ['vault' => $vault] = $this->enablePrivateForm($formId);
        $newFields = [['id' => 'other', 'type' => 'short_text', 'label' => 'Other', 'required' => false]];

        try {
            self::$forms->updateForm($formId, ['fields' => $newFields, 'status' => 'published'], $this->userId);
            $this->fail('publish+field-change without encryptionSchema must be refused');
        } catch (EncryptionRequestException $e) {
            $this->assertSame('manifest_required', $e->errorCode);
        }
        $this->assertSame('draft', self::$forms->getForm($formId)['status']);

        // With a valid encryptionSchema the same request publishes atomically.
        $encryptionSchema = $this->makeEncryptionSchema($formId, $vault, $this->fieldsJson($newFields), 2);
        $updated = self::$forms->updateForm($formId, ['fields' => $newFields, 'status' => 'published', 'encryptionSchema' => $encryptionSchema], $this->userId);
        $this->assertSame('published', $updated['status']);
        $this->assertNotNull($this->row('SELECT 1 AS x FROM form_manifests WHERE form_id = ? AND manifest_seq = 2 AND superseded_at IS NULL', [$formId]));
        FormEncryptionService::invalidateCache();
    }

    public function testJsStyleEmptyObjectsDoNotCountAsFieldChanges(): void
    {
        // The client's schema snapshot is sha256 over JSON.stringify(fields), where an
        // empty object serializes as {} — PHP's json_encode() of the decoded array
        // emits [] instead. A fields-changed check comparing a PHP re-encoding against
        // the CLIENT hash would call every unchanged save "changed" (spurious 409).
        // The comparison must therefore derive BOTH sides PHP-canonically from the
        // stored schema_json (FormEncryptionService::latestManifestSchemaHash).
        $fields = [
            ['id' => 'name', 'type' => 'short_text', 'label' => 'Name', 'required' => false, 'order' => 0, 'properties' => []],
        ];
        $form = $this->makeDraftForm(null, $fields);
        $formId = (string) $form['id'];
        $this->enablePrivateForm($formId);
        self::$forms->updateForm($formId, ['status' => 'published']);

        // Simulate the JS-originated snapshot: same logical fields, but with the
        // empty object in JS byte form ({}), and the manifest hash the client would
        // have signed over those bytes. Only `properties` differs — `validation: []`
        // is a list on both sides.
        $stored = $this->row('SELECT schema_json FROM form_schema_versions WHERE form_id = ? AND version = 1', [$formId]);
        $this->assertNotNull($stored);
        $jsSchemaJson = str_replace('"properties":[]', '"properties":{}', (string) $stored['schema_json']);
        $this->assertStringContainsString('"properties":{}', $jsSchemaJson);
        self::$pdo->prepare('UPDATE form_schema_versions SET schema_json = ? WHERE form_id = ? AND version = 1')
            ->execute([$jsSchemaJson, $formId]);
        self::$pdo->prepare('UPDATE form_manifests SET schema_hash = ? WHERE form_id = ?')
            ->execute([hash('sha256', $jsSchemaJson), $formId]);
        FormEncryptionService::invalidateCache();

        // The incoming save carries PHP-decoded fields (properties: []) — logically
        // unchanged, so it must NOT be treated as a field change.
        $incoming = self::$forms->getForm($formId)['fields'];
        $this->assertSame([], $incoming[0]['properties']); // decoded {} → []
        $updated = self::$forms->updateForm($formId, ['fields' => $incoming, 'title' => 'Retitled'], $this->userId);
        $this->assertSame('Retitled', $updated['title']);
        $this->assertNull($this->row('SELECT 1 AS x FROM form_schema_versions WHERE form_id = ? AND version = 2', [$formId]));

        // …while a REAL change on the same JS-style snapshot is still caught.
        $changed = array_merge($incoming, [['id' => 'email', 'type' => 'short_text', 'label' => 'Email', 'required' => false]]);
        try {
            self::$forms->updateForm($formId, ['fields' => $changed], $this->userId);
            $this->fail('a real field change must still require encryptionSchema');
        } catch (EncryptionRequestException $e) {
            $this->assertSame('manifest_required', $e->errorCode);
        }
    }
}

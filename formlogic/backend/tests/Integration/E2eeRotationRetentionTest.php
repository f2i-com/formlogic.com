<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Services\EnvelopeValidator;

/**
 * Rotation retention (security review): a retired/retiring ingestion key's
 * wrapped secret must STILL be served to the owner (GET /encryption →
 * FormEncryptionService::getState) so historical responses stay decryptable —
 * key state gates WRITES only (acceptableManifests / EnvelopeValidator), never
 * the owner's readback of the key material.
 */
class E2eeRotationRetentionTest extends E2eeTestCase
{
    public function testRetiredKeyStaysServedToOwnerButRejectsWrites(): void
    {
        $form = $this->makeDraftForm();
        $formId = (string) $form['id'];
        $this->enablePrivateForm($formId);
        self::$forms->updateForm($formId, ['status' => 'published']);
        $env = $this->makeEnvelope($formId);
        self::$responses->createEncryptedResponse($formId, $env, null, null);

        // Rotate the epoch away: the old key is retired (writes must stop NOW).
        self::$pdo->prepare("UPDATE form_ingestion_keys SET state = 'retired' WHERE form_id = ?")->execute([$formId]);

        // READS: the owner still gets the retired key's wrapped secret — the
        // historical envelope above stays decryptable client-side.
        $state = self::$encryption->getState($formId, $this->userId);
        $this->assertNotNull($state);
        $this->assertCount(1, $state['ingestionKeys']);
        $key = $state['ingestionKeys'][0];
        $this->assertSame('retired', $key['state']);
        $this->assertNotSame('', (string) $key['wrappedSecret']);
        $this->assertSame(72, strlen(base64_decode((string) $key['wrappedSecret'], true) ?: ''));

        // WRITES: the retired epoch is no longer an acceptable manifest…
        $this->assertSame([], self::$encryption->acceptableManifests($formId));
        // …and a new envelope under the old key is rejected key_epoch_retired.
        $validator = new EnvelopeValidator();
        $envelope = [
            '__flenc' => 1,
            'recordId' => $this->uuidV4(),
            'rev' => 1,
            'keyId' => (string) $key['id'],
            'epoch' => (int) $key['epoch'],
            'content' => 'xchacha20p1305.1',
            'wrap' => 'sealedbox-x25519xsalsa20p1305.1',
            'schemaVersion' => 1,
            'schemaHash' => (string) $this->row('SELECT schema_hash FROM form_manifests WHERE form_id = ?', [$formId])['schema_hash'],
            'wrappedDek' => base64_encode(random_bytes(80)),
            'nonce' => base64_encode(random_bytes(24)),
            'ct' => base64_encode(random_bytes(96)),
        ];
        $result = $validator->validateEnvelope($envelope, $formId, self::$encryption->acceptableManifests($formId), null);
        $this->assertFalse($result['ok'] ?? true);
        $this->assertSame('key_epoch_retired', $result['code'] ?? null);

        // The historical ciphertext row itself is untouched (still served verbatim).
        $rows = self::$responses->getFormResponses($formId, ['limit' => 1]);
        $this->assertCount(1, $rows);
        $this->assertSame($env['recordId'], $rows[0]['id']);
    }

    public function testRetiringKeyAcceptsWritesUntilAcceptUntil(): void
    {
        $form = $this->makeDraftForm();
        $formId = (string) $form['id'];
        $this->enablePrivateForm($formId);

        // Retiring with a FUTURE accept_until: still writable during the grace window…
        self::$pdo->prepare("UPDATE form_ingestion_keys SET state = 'retiring', accept_until = DATE_ADD(NOW(), INTERVAL 1 HOUR) WHERE form_id = ?")->execute([$formId]);
        $this->assertNotEmpty(self::$encryption->acceptableManifests($formId));

        // …and the owner is still served the wrapped secret throughout.
        $state = self::$encryption->getState($formId, $this->userId);
        $this->assertSame('retiring', $state['ingestionKeys'][0]['state']);
        $this->assertNotSame('', (string) $state['ingestionKeys'][0]['wrappedSecret']);

        // Past accept_until the epoch closes to writes but stays readable.
        self::$pdo->prepare("UPDATE form_ingestion_keys SET accept_until = DATE_SUB(NOW(), INTERVAL 1 HOUR) WHERE form_id = ?")->execute([$formId]);
        $this->assertSame([], self::$encryption->acceptableManifests($formId));
        $state = self::$encryption->getState($formId, $this->userId);
        $this->assertNotSame('', (string) $state['ingestionKeys'][0]['wrappedSecret']);
    }
}

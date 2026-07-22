<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Services\EncryptionEnablingException;
use FormLogic\Services\EncryptionRequestException;
use FormLogic\Services\FormEncryptionService;

/**
 * Enable-race fix (security review, blocker 1): the durable plaintext →
 * enabling → private transition. While the 'enabling' marker is present EVERY
 * mutation surface — response submit/update (plaintext AND envelope), form
 * publish/field saves, webhook/flow/integration mutations — fails closed with
 * the typed encryption_enabling refusal (409 at the HTTP boundary); a crashed
 * enable leaves only a stale marker that a retry may retake.
 */
class E2eeEnablingGateTest extends E2eeTestCase
{
    /** A draft form with ONLY the phase-1 enabling marker planted. */
    private function makeEnablingForm(): string
    {
        $form = $this->makeDraftForm();
        $formId = (string) $form['id'];
        $this->makeVault($this->userId);
        $this->insertEnablingMarker($formId);
        return $formId;
    }

    /**
     * The contract matrix: every listed surface throws EncryptionEnablingException
     * (a PrivateFormEncryptedException subtype, so legacy §9.2 catches also refuse).
     *
     * @return iterable<string, array{\Closure(string): void}>
     */
    public static function enablingSurfaces(): iterable
    {
        yield 'plaintext submit (createResponse)' => [fn (string $f) => self::$responses->createResponse($f, ['answers' => ['name' => 'x']], null)];
        yield 'plaintext update (updateResponse)' => [fn (string $f) => self::$responses->updateResponse($f, 'whatever', ['answers' => ['name' => 'y']])];
        yield 'form publish (status save)' => [fn (string $f) => self::$forms->updateForm($f, ['status' => 'published'])];
        yield 'field save (updateForm fields)' => [fn (string $f) => self::$forms->updateForm($f, ['fields' => [['id' => 'name', 'type' => 'short_text', 'label' => 'Name']]])];
        yield 'webhook creation' => [fn (string $f) => self::$webhooks->createWebhook($f, self::staticUserId(), 'https://example.com/hook', ['response.created'])];
        yield 'workspace flow binding creation' => [fn (string $f) => self::$flows->createFormBinding(self::staticUserId(), $f, ['flow' => 'en', 'event' => 'form.submitted', 'mode' => 'async'])];
        yield 'app attach' => [fn (string $f) => self::$apps->addFormToApp(self::staticAppId(), $f)];
    }

    private static string $staticUserId = '';
    private static string $staticAppId = '';
    private static function staticUserId(): string
    {
        return self::$staticUserId;
    }
    private static function staticAppId(): string
    {
        return self::$staticAppId;
    }

    /**
     * @dataProvider enablingSurfaces
     */
    public function testSurfaceFailsClosedWhileEnabling(\Closure $invoke): void
    {
        $formId = $this->makeEnablingForm();
        self::$staticUserId = $this->userId;
        $app = self::$apps->createApp(['name' => 'Enabling app'], $this->userId);
        self::$staticAppId = (string) $app['id'];
        try {
            self::$flows->createWorkspaceFlow($this->userId, ['name' => 'en', 'slug' => 'en']);
        } catch (\Throwable) { /* already exists from a prior matrix row */ }

        try {
            $invoke($formId);
            $this->fail('surface did not refuse the mid-enable form');
        } catch (EncryptionEnablingException $e) {
            $this->assertSame('encryption_enabling', EncryptionEnablingException::ERROR_CODE);
            $this->assertSame(409, EncryptionEnablingException::STATUS);
            $this->assertSame('Encryption is being enabled for this form — retry in a moment.', $e->getMessage());
        }

        // Nothing moved: the form is still mid-enable and response-free.
        $this->assertSame('enabling', self::$encryption->encryptionState($formId));
    }

    public function testPlaintextSubmitDuringEnableCannotLand(): void
    {
        $formId = $this->makeEnablingForm();
        // Publish first (direct SQL — the gated path is covered by the matrix) so
        // the submission pipeline's own preconditions can't mask the encryption gate.
        self::$pdo->prepare("UPDATE forms SET status = 'published' WHERE id = ?")->execute([$formId]);

        try {
            self::$responses->createResponse($formId, ['answers' => ['name' => 'sneaky']], null);
            $this->fail('plaintext submit must fail closed while enabling');
        } catch (EncryptionEnablingException) {
            // expected
        }

        // Neither store holds a response: the check-then-write race is closed.
        $db = self::$sqlite->getFormDatabase($formId);
        $this->assertSame(0, (int) $db->query('SELECT COUNT(*) FROM responses')->fetchColumn());
        $this->assertSame(0, (int) self::$pdo->query("SELECT COUNT(*) FROM response_metadata WHERE form_id = '{$formId}'")->fetchColumn());
    }

    public function testEnvelopeSubmitDuringEnableCannotLand(): void
    {
        $formId = $this->makeEnablingForm();
        self::$pdo->prepare("UPDATE forms SET status = 'published' WHERE id = ?")->execute([$formId]);

        // The atomic mirror write requires state='active' — a mid-enable form refuses.
        $envelope = [
            '__flenc' => 1,
            'recordId' => $this->uuidV4(),
            'rev' => 1,
            'keyId' => 'fik_nope',
            'epoch' => 1,
            'content' => 'xchacha20p1305.1',
            'wrap' => 'sealedbox-x25519xsalsa20p1305.1',
            'schemaVersion' => 1,
            'schemaHash' => str_repeat('a', 64),
            'wrappedDek' => base64_encode(random_bytes(80)),
            'nonce' => base64_encode(random_bytes(24)),
            'ct' => base64_encode(random_bytes(96)),
        ];
        try {
            self::$responses->createEncryptedResponse($formId, $envelope, null, null);
            $this->fail('envelope submit must fail closed while enabling');
        } catch (EncryptionEnablingException) {
            // expected
        }
        $db = self::$sqlite->getFormDatabase($formId);
        $this->assertSame(0, (int) $db->query('SELECT COUNT(*) FROM responses')->fetchColumn());
    }

    public function testConcurrentEnableRefusedWhileEnabling(): void
    {
        $form = $this->makeDraftForm();
        $formId = (string) $form['id'];
        $vault = $this->makeVault($this->userId);
        $this->insertEnablingMarker($formId);

        // A second enable against the fresh marker is refused (not a duplicate-key 500).
        try {
            self::$encryption->enable($formId, $this->userId, $this->makeEnableBody($formId, $this->userId, $vault));
            $this->fail('concurrent enable must be refused while enabling');
        } catch (EncryptionRequestException $e) {
            $this->assertSame('private_enable_blocked', $e->errorCode);
            $this->assertSame(409, $e->status);
            $this->assertContains('enable_in_progress', $e->details['reasons'] ?? []);
        }
        $this->assertSame('enabling', self::$encryption->encryptionState($formId));
    }

    public function testStaleEnablingMarkerIsRetakenByRetry(): void
    {
        $form = $this->makeDraftForm();
        $formId = (string) $form['id'];
        $vault = $this->makeVault($this->userId);
        // A crashed enable: the marker is older than ENABLING_STALE_SECONDS.
        $stale = date('Y-m-d H:i:s', time() - FormEncryptionService::ENABLING_STALE_SECONDS - 60);
        $this->insertEnablingMarker($formId, null, $stale);

        // The retry retakes the stale marker and completes the enable.
        $result = self::$encryption->enable($formId, $this->userId, $this->makeEnableBody($formId, $this->userId, $vault));
        $this->assertTrue($result['enabled']);
        $this->assertSame('active', self::$encryption->encryptionState($formId));
        $this->assertNotNull($this->row('SELECT 1 AS x FROM form_ingestion_keys WHERE form_id = ?', [$formId]));
        $this->assertNotNull($this->row('SELECT 1 AS x FROM form_manifests WHERE form_id = ?', [$formId]));
    }

    public function testFailedEnableLeavesFormPlaintextNotWedged(): void
    {
        $form = $this->makeDraftForm();
        $formId = (string) $form['id'];
        $vault = $this->makeVault($this->userId);

        // Tamper the manifest signature — phase 1 commits the marker, phase 2
        // fails verification, and the abort must remove the marker (plaintext).
        $body = $this->makeEnableBody($formId, $this->userId, $vault);
        $body['manifest']['signature'] = base64_encode(random_bytes(64));
        try {
            self::$encryption->enable($formId, $this->userId, $body);
            $this->fail('bad signature must fail the enable');
        } catch (EncryptionRequestException $e) {
            $this->assertSame('manifest_invalid', $e->errorCode);
        }

        // Not wedged: no form_encryption row at all, the form is still plaintext,
        // and a correct retry succeeds.
        $this->assertNull($this->row('SELECT 1 AS x FROM form_encryption WHERE form_id = ?', [$formId]));
        FormEncryptionService::invalidateCache();
        $this->assertFalse(self::$encryption->isPrivate($formId));
        $result = self::$encryption->enable($formId, $this->userId, $this->makeEnableBody($formId, $this->userId, $vault));
        $this->assertTrue($result['enabled']);
        $this->assertSame('active', self::$encryption->encryptionState($formId));
    }

    public function testEnableExposesStateInOwnerPayload(): void
    {
        $form = $this->makeDraftForm();
        $formId = (string) $form['id'];
        $this->enablePrivateForm($formId);
        $state = self::$encryption->getState($formId, $this->userId);
        $this->assertSame('active', $state['encryption']['state'] ?? null);
    }
}

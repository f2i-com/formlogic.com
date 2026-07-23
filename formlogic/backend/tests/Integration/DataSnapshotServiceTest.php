<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Services\DataCloudSigner;
use FormLogic\Services\DataSnapshotService;
use FormLogic\Support\DataCanonicalJson;

/**
 * N2 Cloud-primary Desktop snapshots (plan §27-N2 gates;
 * docs/FORMLOGIC_DATA_NODES.md §9): a live Private form exports a signed,
 * hash-complete, logically-rooted portable package; plaintext/foreign forms
 * are refused; the file surface rejects traversal; nothing key-shaped leaves
 * in the clear; active Cloud placement is untouched (the builder is
 * read-only over live data by construction).
 */
final class DataSnapshotServiceTest extends E2eeTestCase
{
    private static string $snapRoot = '';
    private static DataCloudSigner $signer;
    private static DataSnapshotService $service;

    public static function setUpBeforeClass(): void
    {
        parent::setUpBeforeClass();
        if (self::$mysql === null) {
            return;
        }
        self::$snapRoot = self::$tmpRoot . '/data-snapshots';
        self::$signer = new DataCloudSigner(self::$tmpRoot . '/keys/data-cloud-signing.key');
        self::$service = new DataSnapshotService(self::$mysql, self::$sqlite, self::$signer, self::$snapRoot);
    }

    /** @return array{formId: string, snapshot: array<string,mixed>, dir: string} */
    private function makeSnapshottedForm(int $responses = 3): array
    {
        $form = $this->makeDraftForm();
        $formId = (string) $form['id'];
        $this->enablePrivateForm($formId);
        for ($i = 0; $i < $responses; $i++) {
            self::$responses->createEncryptedResponse($formId, $this->makeEnvelope($formId), null, '127.0.0.1');
        }
        $snapshot = self::$service->createSnapshot($this->userId, $formId);
        return [
            'formId' => $formId,
            'snapshot' => $snapshot,
            'dir' => self::$snapRoot . '/' . $snapshot['snapshotId'],
        ];
    }

    public function testSnapshotIsSignedHashCompleteAndRootConsistent(): void
    {
        ['formId' => $formId, 'snapshot' => $snapshot, 'dir' => $dir] = $this->makeSnapshottedForm();
        $manifest = $snapshot['manifest'];
        $pk = self::$signer->publicKeyRaw();

        // Signed manifest + synthesized checkpoint verify under their domains
        // and NOT under each other's (domain separation).
        self::assertTrue(DataCanonicalJson::verify(DataCanonicalJson::DOMAIN_BACKUP, $manifest, $pk));
        self::assertFalse(DataCanonicalJson::verify(DataCanonicalJson::DOMAIN_CHECKPOINT, $manifest, $pk));
        $checkpoint = json_decode((string) file_get_contents($dir . '/manifests/checkpoint.json'), true);
        self::assertTrue(DataCanonicalJson::verify(DataCanonicalJson::DOMAIN_CHECKPOINT, $checkpoint, $pk));
        self::assertSame(
            $manifest['checkpointHash'],
            DataCanonicalJson::hashHex(
                DataCanonicalJson::DOMAIN_CHECKPOINT,
                array_diff_key($checkpoint, ['signature' => true]),
            ),
        );

        // Every listed file exists with the exact hash/size; counts match.
        self::assertSame(3, $manifest['counts']['responses']);
        foreach ($manifest['files'] as $f) {
            $bytes = (string) file_get_contents($dir . '/' . $f['path']);
            self::assertSame($f['sha256'], hash('sha256', $bytes), $f['path']);
            self::assertSame($f['bytes'], strlen($bytes), $f['path']);
        }

        // Recompute the logical root from the PACKAGE alone (what the desktop
        // does): response entries + artifact entries hashed over line bytes.
        $entries = [];
        $responseLines = array_filter(explode("\n", (string) file_get_contents($dir . '/data/responses.ndjson.enc')));
        foreach ($responseLines as $line) {
            $row = json_decode($line, true);
            self::assertIsArray($row);
            // answersRaw is byte-exact: its hash is the row's cipherHash and it
            // matches the live SQLite bytes verbatim.
            self::assertSame($row['cipherHash'], hash('sha256', $row['answersRaw']));
            $stored = self::$sqlite->getFormDatabase($formId)
                ->query("SELECT answers FROM responses WHERE id = '" . $row['id'] . "'")->fetchColumn();
            self::assertSame($stored, $row['answersRaw']);
            $entries[] = ['response', $row['id'], $row['rowVersion'], $row['rev'], $row['cipherHash']];
        }
        $controlLines = array_filter(explode("\n", (string) file_get_contents($dir . '/data/control.ndjson')));
        $allowedKinds = ['manifest', 'schema', 'ingestion', 'grant'];
        foreach ($controlLines as $line) {
            $artifact = json_decode($line, true);
            self::assertIsArray($artifact);
            self::assertContains($artifact['kind'], $allowedKinds, 'only wrapped/signed control kinds may ship');
            $entries[] = ['artifact', $artifact['kind'], $artifact['id'], hash('sha256', $line)];
        }
        self::assertSame($manifest['logicalRoot'], DataCanonicalJson::logicalRootHex($formId, $entries));

        // Tampering any signed field kills the signature.
        $tampered = $manifest;
        $tampered['counts']['responses'] = 99;
        self::assertFalse(DataCanonicalJson::verify(DataCanonicalJson::DOMAIN_BACKUP, $tampered, $pk));

        // A data-only package must carry no raw key material: the only 32/64-
        // byte secrets in the fixture are the vault signing keys — grep the
        // whole package for anything labelled like a raw secret.
        foreach ($manifest['files'] as $f) {
            $bytes = (string) file_get_contents($dir . '/' . $f['path']);
            self::assertStringNotContainsString('SkRaw', $bytes, $f['path']);
            self::assertStringNotContainsString('wrappedUmk', $bytes, $f['path']);
        }
    }

    public function testPlaintextForeignAndCorruptFormsAreRefused(): void
    {
        // Ordinary plaintext form: structurally ineligible.
        $plain = $this->makeDraftForm();
        try {
            self::$service->createSnapshot($this->userId, (string) $plain['id']);
            self::fail('plaintext form must be refused');
        } catch (\RuntimeException $e) {
            self::assertSame('snapshot_form_ineligible', $e->getMessage());
        }

        // Another user's private form: refused for this caller.
        $otherUser = $this->makeUser();
        $otherForm = $this->makeDraftForm($otherUser);
        $this->enablePrivateForm((string) $otherForm['id'], $otherUser);
        try {
            self::$service->createSnapshot($this->userId, (string) $otherForm['id']);
            self::fail('foreign form must be refused');
        } catch (\RuntimeException $e) {
            self::assertSame('snapshot_form_ineligible', $e->getMessage());
        }
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$otherUser]);

        // A non-envelope row inside a private form is corruption, not export.
        $form = $this->makeDraftForm();
        $formId = (string) $form['id'];
        $this->enablePrivateForm($formId);
        self::$responses->createEncryptedResponse($formId, $this->makeEnvelope($formId), null, null);
        self::$sqlite->getFormDatabase($formId)
            ->exec("INSERT INTO responses (id, answers) VALUES ('plain-row', '{\"name\":\"PLAINTEXT-CANARY\"}')");
        try {
            self::$service->createSnapshot($this->userId, $formId);
            self::fail('corrupt plaintext row must abort the snapshot');
        } catch (\RuntimeException $e) {
            self::assertStringContainsString('snapshot_corrupt_row', $e->getMessage());
        }
    }

    public function testFileSurfaceIsAllowlistedAndDeleteCleansUp(): void
    {
        ['snapshot' => $snapshot, 'dir' => $dir] = $this->makeSnapshottedForm(1);
        $id = $snapshot['snapshotId'];
        $uid = $this->userId;
        self::assertNotNull(self::$service->snapshotFilePath($uid, $id, 'manifests/backup-manifest.json'));
        self::assertNotNull(self::$service->snapshotFilePath($uid, $id, 'data/responses.ndjson.enc'));
        self::assertNull(self::$service->snapshotFilePath($uid, $id, '../../.env'));
        self::assertNull(self::$service->snapshotFilePath($uid, $id, 'data/../backup-index.json'));
        self::assertNull(self::$service->snapshotFilePath($uid, $id, 'unknown.bin'));
        self::assertNull(self::$service->snapshotFilePath($uid, 'not-a-snapshot-id', 'backup-index.json'));

        // A LEAKED valid ID is worthless to another tenant (review FL-002):
        // reads and deletes miss identically, and a denied delete leaves every
        // byte in place.
        $stranger = $this->makeUser();
        self::assertNull(self::$service->snapshotFilePath($stranger, $id, 'manifests/backup-manifest.json'));
        self::assertFalse(self::$service->deleteSnapshotOwned($stranger, $id));
        self::assertFileExists($dir . '/manifests/backup-manifest.json');
        self::assertNotNull(self::$service->snapshotFilePath($uid, $id, 'manifests/backup-manifest.json'));
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$stranger]);

        self::assertTrue(self::$service->deleteSnapshotOwned($uid, $id));
        self::assertDirectoryDoesNotExist($dir);
        self::assertNull(self::$service->snapshotFilePath($uid, $id, 'backup-index.json'));
        self::assertFalse(self::$service->deleteSnapshotOwned($uid, $id), 'second delete misses like an unknown id');
    }

    public function testEligibleFormsListsOnlyOwnPrivateForms(): void
    {
        $private = $this->makeDraftForm();
        $this->enablePrivateForm((string) $private['id']);
        $this->makeDraftForm(); // plaintext — must not appear
        $forms = self::$service->eligibleForms($this->userId);
        $ids = array_column($forms, 'formId');
        self::assertContains((string) $private['id'], $ids);
        self::assertCount(1, $ids);
    }
}

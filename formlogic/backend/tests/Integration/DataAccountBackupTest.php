<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Services\AccountBackupService;
use FormLogic\Services\DataAccountBackupService;
use FormLogic\Services\DataCloudSigner;
use FormLogic\Support\DataCanonicalJson;

/**
 * Sealed whole-account backup to a Desktop (docs/FORMLOGIC_DATA_NODES.md §10):
 * the archive (INCLUDING plaintext forms — that is the point of this lane) is
 * encrypted to the requesting desktop's ephemeral key before it leaves the
 * service; the staged payload carries no plaintext; truncation/tamper fail
 * closed; only the matching ephemeral secret opens it.
 */
final class DataAccountBackupTest extends E2eeTestCase
{
    private static DataAccountBackupService $service;
    private static DataCloudSigner $signer;

    public static function setUpBeforeClass(): void
    {
        parent::setUpBeforeClass();
        if (self::$mysql === null) {
            return;
        }
        $backups = new AccountBackupService(
            self::$mysql,
            self::$sqlite,
            self::$forms,
            self::$apps,
            self::$appUsers,
            self::$flows,
            self::$responses,
            [],
            self::$tmpRoot . '/sqlite',
            self::$uploadsPath,
        );
        self::$signer = new DataCloudSigner(self::$tmpRoot . '/keys/data-cloud-signing.key');
        self::$service = new DataAccountBackupService($backups, self::$signer, self::$tmpRoot . '/data-snapshots');
    }

    public function testSealedRoundTripTamperAndTruncationFailClosed(): void
    {
        $canary = 'ACCT-CANARY-' . bin2hex(random_bytes(6));
        $form = $this->makeDraftForm();
        $created = self::$responses->createResponse((string) $form['id'], [
            'answers' => ['name' => $canary],
        ]);
        self::assertIsArray($created);

        // Desktop side: fresh ephemeral X25519 pair per request.
        $desktopPair = sodium_crypto_box_keypair();
        $desktopPk = sodium_crypto_box_publickey($desktopPair);
        $desktopSk = sodium_crypto_box_secretkey($desktopPair);

        $result = self::$service->create($this->userId, base64_encode($desktopPk));
        $header = $result['header'];
        $backupId = $result['backupId'];

        // Signed header verifies under the flbackup domain and names its kind.
        self::assertSame('account-backup', $header['kind']);
        self::assertTrue(DataCanonicalJson::verify(
            DataCanonicalJson::DOMAIN_BACKUP,
            $header,
            self::$signer->publicKeyRaw(),
        ));

        // The staged payload must not leak the canary (or any zip magic).
        $payloadPath = self::$service->payloadPath($backupId);
        self::assertNotNull($payloadPath);
        $payload = (string) file_get_contents($payloadPath);
        self::assertStringNotContainsString($canary, $payload);
        self::assertStringNotContainsString('backup.json', $payload);

        // Open the file key exactly like the desktop does…
        $boxPair = sodium_crypto_box_keypair_from_secretkey_and_publickey(
            $desktopSk,
            (string) base64_decode($header['cloudEphemeralPk'], true),
        );
        $fileKey = sodium_crypto_box_open(
            (string) base64_decode($header['wrappedKey'], true),
            (string) base64_decode($header['keyNonce'], true),
            $boxPair,
        );
        self::assertIsString($fileKey);

        // …and decrypt every chunk (nonce = base || BE64 index; AAD binds
        // backupId + index + count).
        $baseNonce = (string) base64_decode($header['baseNonce'], true);
        $zip = '';
        $offset = 0;
        for ($i = 0; $i < $header['chunkCount']; $i++) {
            $len = unpack('N', substr($payload, $offset, 4))[1];
            $ct = substr($payload, $offset + 4, $len);
            $offset += 4 + $len;
            $pt = sodium_crypto_aead_xchacha20poly1305_ietf_decrypt(
                $ct,
                sprintf('flaccount:1|%s|%d|%d', $backupId, $i, $header['chunkCount']),
                $baseNonce . pack('J', $i),
                $fileKey,
            );
            self::assertIsString($pt, "chunk {$i} must open");
            $zip .= $pt;
        }
        self::assertSame($offset, strlen($payload), 'payload has no trailing bytes');
        self::assertSame($header['zipBytes'], strlen($zip));
        self::assertSame($header['zipSha256'], hash('sha256', $zip));

        // The decrypted archive is a real account backup, and the plaintext
        // form data IS inside it (the point of this lane) — the canary lives
        // in the deflate-compressed per-form sqlite, so extract before checking.
        $tmpZip = self::$tmpRoot . '/roundtrip.zip';
        file_put_contents($tmpZip, $zip);
        $za = new \ZipArchive();
        self::assertTrue($za->open($tmpZip));
        self::assertNotFalse($za->locateName('backup.json'));
        $formDb = $za->getFromName('data/forms/' . $form['id'] . '.sqlite');
        self::assertIsString($formDb, 'the plaintext form db is in the archive');
        self::assertStringContainsString($canary, $formDb, 'plaintext form data IS in the account backup');
        $za->close();

        // Tampered chunk fails AEAD; wrong AAD index (reorder) fails too.
        $len0 = unpack('N', substr($payload, 0, 4))[1];
        $ct0 = substr($payload, 4, $len0);
        $tampered = $ct0;
        $tampered[5] = chr(ord($tampered[5]) ^ 0x01);
        self::assertFalse(sodium_crypto_aead_xchacha20poly1305_ietf_decrypt(
            $tampered,
            sprintf('flaccount:1|%s|0|%d', $backupId, $header['chunkCount']),
            $baseNonce . pack('J', 0),
            $fileKey,
        ));
        self::assertFalse(sodium_crypto_aead_xchacha20poly1305_ietf_decrypt(
            $ct0,
            sprintf('flaccount:1|%s|1|%d', $backupId, $header['chunkCount']),
            $baseNonce . pack('J', 1),
            $fileKey,
        ));

        // A different ephemeral key cannot open the file key.
        $otherPair = sodium_crypto_box_keypair();
        $wrongBox = sodium_crypto_box_keypair_from_secretkey_and_publickey(
            sodium_crypto_box_secretkey($otherPair),
            (string) base64_decode($header['cloudEphemeralPk'], true),
        );
        self::assertFalse(sodium_crypto_box_open(
            (string) base64_decode($header['wrappedKey'], true),
            (string) base64_decode($header['keyNonce'], true),
            $wrongBox,
        ));

        self::$service->delete($backupId);
        self::assertNull(self::$service->payloadPath($backupId));
    }

    public function testBadEphemeralKeyIsRefused(): void
    {
        try {
            self::$service->create($this->userId, 'not-base64!!');
            self::fail('malformed ephemeral key must be refused');
        } catch (\RuntimeException $e) {
            self::assertSame('account_backup_bad_ephemeral_key', $e->getMessage());
        }
    }
}

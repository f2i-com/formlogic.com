<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Services\AccountBackupService;
use FormLogic\Services\DataAccountBackupService;
use FormLogic\Services\DataCloudSigner;
use FormLogic\Support\BackupEnvelope;
use FormLogic\Support\DataCanonicalJson;

/**
 * One app or form backed up to a linked computer. The staged file is sealed to a key the node
 * signed, the request can't be turned into another, and a backup restores as new copies.
 */
final class DataSourceBackupTest extends E2eeTestCase
{
    private static DataAccountBackupService $service;
    private static AccountBackupService $backups;
    private static DataCloudSigner $signer;

    public static function setUpBeforeClass(): void
    {
        parent::setUpBeforeClass();
        if (self::$mysql === null) {
            return;
        }
        self::$backups = new AccountBackupService(
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
        self::$service = new DataAccountBackupService(self::$backups, self::$signer, self::$tmpRoot . '/data-snapshots', self::$mysql);
    }

    /** @return array{node: array{id: string, signing_public_key: string}, sk: string} */
    private function node(): array
    {
        $pair = sodium_crypto_sign_keypair();
        return [
            'node' => ['id' => 'dn_test' . bin2hex(random_bytes(4)), 'signing_public_key' => base64_encode(sodium_crypto_sign_publickey($pair))],
            'sk' => sodium_crypto_sign_secretkey($pair),
        ];
    }

    /** @return array{0: string, 1: string} public, secret */
    private function recipient(): array
    {
        [$public, $secret] = BackupEnvelope::generateKeyPair();
        return [$public, base64_decode($secret)];
    }

    /** @return array<string, string> */
    private function request(string $kind, string $id, string $recipient, string $signingKey, ?string $requestedAt = null): array
    {
        $requestedAt ??= gmdate('Y-m-d\TH:i:s\Z');
        return [
            'kind' => $kind,
            'id' => $id,
            'recipientPk' => $recipient,
            'requestedAt' => $requestedAt,
            'recipientPkSignature' => base64_encode(sodium_crypto_sign_detached(
                DataAccountBackupService::SOURCE_SIGNATURE_DOMAIN . '|' . $requestedAt . '|' . $recipient . '|' . $kind . '|' . $id,
                $signingKey,
            )),
        ];
    }

    private function sign(string $zip, string $signingKey, ?string $requestedAt = null): array
    {
        $requestedAt ??= gmdate('Y-m-d\TH:i:s\Z');
        return [$requestedAt, base64_encode(sodium_crypto_sign_detached(
            DataAccountBackupService::RESTORE_SIGNATURE_DOMAIN . '|' . $requestedAt . '|' . hash_file('sha256', $zip),
            $signingKey,
        ))];
    }

    private function opened(string $userId, string $backupId, string $secret): string
    {
        $payload = self::$service->payloadPath($userId, $backupId);
        self::assertNotNull($payload);
        $zip = self::$tmpRoot . '/opened-' . bin2hex(random_bytes(4)) . '.zip';
        BackupEnvelope::open($payload, $zip, ['secretKey' => $secret]);
        return $zip;
    }

    private function appWithForm(): array
    {
        $app = self::$apps->createApp(['name' => 'Bookings'], $this->userId);
        $form = $this->makeDraftForm();
        self::$apps->addFormToApp((string) $app['id'], (string) $form['id']);
        return [(string) $app['id'], (string) $form['id']];
    }

    /** @return array<string, mixed> */
    private function structureOf(string $zipPath): array
    {
        $zip = new \ZipArchive();
        self::assertTrue($zip->open($zipPath) === true);
        $structure = json_decode((string) $zip->getFromName('backup.json'), true);
        $zip->close();
        return $structure;
    }

    public function testTheListNamesAppsAndFormsAndNoContents(): void
    {
        $canary = 'SOURCE-CANARY-' . bin2hex(random_bytes(6));
        [$appId, $inApp] = $this->appWithForm();
        $alone = $this->makeDraftForm();
        self::$responses->createResponse((string) $alone['id'], ['answers' => ['name' => $canary]]);

        $sources = self::$backups->sources($this->userId);

        $app = array_values(array_filter($sources['apps'], static fn (array $a) => $a['id'] === $appId));
        self::assertSame('Bookings', $app[0]['name']);
        self::assertSame(1, $app[0]['forms']);
        $forms = array_column($sources['forms'], null, 'id');
        self::assertTrue($forms[$inApp]['inApp']);
        self::assertFalse($forms[(string) $alone['id']]['inApp']);
        self::assertStringNotContainsString($canary, (string) json_encode($sources));
    }

    public function testTheListIsOnlyThisAccounts(): void
    {
        [$appId] = $this->appWithForm();
        $stranger = $this->makeUser();
        try {
            self::assertSame(['apps' => [], 'forms' => []], self::$backups->sources($stranger));
        } finally {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$stranger]);
        }
        self::assertNotSame('', $appId);
    }

    public function testAnAppIsSealedWithItsOwnFormsAndNothingElse(): void
    {
        $canary = 'SOURCE-CANARY-' . bin2hex(random_bytes(6));
        [$appId, $formId] = $this->appWithForm();
        self::$responses->createResponse($formId, ['answers' => ['name' => $canary]]);
        $other = $this->makeDraftForm();
        $otherApp = self::$apps->createApp(['name' => 'Elsewhere'], $this->userId);

        ['node' => $node, 'sk' => $sk] = $this->node();
        [$public, $secret] = $this->recipient();
        $result = self::$service->createSource($this->userId, $this->request('app', $appId, $public, $sk), $node);

        self::assertSame('source-backup', $result['header']['kind']);
        self::assertSame(['kind' => 'app', 'id' => $appId, 'name' => 'Bookings'], $result['header']['source']);
        self::assertTrue(DataCanonicalJson::verify(DataCanonicalJson::DOMAIN_BACKUP, $result['header'], self::$signer->publicKeyRaw()));

        $payload = (string) self::$service->payloadPath($this->userId, $result['backupId']);
        self::assertTrue(BackupEnvelope::isSealed($payload));
        self::assertStringNotContainsString($canary, (string) file_get_contents($payload));

        $zip = $this->opened($this->userId, $result['backupId'], $secret);
        self::assertSame($result['header']['zipSha256'], hash_file('sha256', $zip));
        $structure = $this->structureOf($zip);
        self::assertSame([$appId], array_column($structure['apps'], 'id'));
        self::assertSame([$formId], array_column($structure['forms'], 'id'));
        self::assertNotContains((string) $other['id'], array_column($structure['forms'], 'id'));
        self::assertNotContains((string) $otherApp['id'], array_column($structure['apps'], 'id'));
        unlink($zip);
    }

    public function testAFormIsSealedOnItsOwn(): void
    {
        $form = $this->makeDraftForm();
        $this->makeDraftForm();
        ['node' => $node, 'sk' => $sk] = $this->node();
        [$public, $secret] = $this->recipient();

        $result = self::$service->createSource($this->userId, $this->request('form', (string) $form['id'], $public, $sk), $node);

        $zip = $this->opened($this->userId, $result['backupId'], $secret);
        self::assertSame([(string) $form['id']], array_column($this->structureOf($zip)['forms'], 'id'));
        self::assertSame([], $this->structureOf($zip)['apps']);
        unlink($zip);
    }

    public function testABackupRestoresAsNewCopies(): void
    {
        $canary = 'SOURCE-CANARY-' . bin2hex(random_bytes(6));
        [$appId, $formId] = $this->appWithForm();
        self::$responses->createResponse($formId, ['answers' => ['name' => $canary]]);
        ['node' => $node, 'sk' => $sk] = $this->node();
        [$public, $secret] = $this->recipient();
        $result = self::$service->createSource($this->userId, $this->request('app', $appId, $public, $sk), $node);
        $zip = $this->opened($this->userId, $result['backupId'], $secret);

        [$requestedAt, $signature] = $this->sign($zip, $sk);
        $restored = self::$service->restoreSource($this->userId, $zip, $requestedAt, $signature, $node);

        self::assertCount(1, $restored['apps']);
        self::assertNotSame($appId, $restored['apps'][0]['id'] ?? null);
        self::assertSame(1, $restored['responses']);
        self::assertNotNull(self::$apps->getApp($appId), 'the original is untouched');
        unlink($zip);
    }

    public function testAnotherAccountsAppIsUnknown(): void
    {
        [$appId] = $this->appWithForm();
        $stranger = $this->makeUser();
        ['node' => $node, 'sk' => $sk] = $this->node();
        [$public] = $this->recipient();
        try {
            self::$service->createSource($stranger, $this->request('app', $appId, $public, $sk), $node);
            self::fail('another account\'s app was backed up');
        } catch (\RuntimeException $e) {
            self::assertSame('App not found', $e->getMessage());
        } finally {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$stranger]);
        }
    }

    public function testAnotherAccountsFormIsUnknown(): void
    {
        $form = $this->makeDraftForm();
        $stranger = $this->makeUser();
        ['node' => $node, 'sk' => $sk] = $this->node();
        [$public] = $this->recipient();
        try {
            self::$service->createSource($stranger, $this->request('form', (string) $form['id'], $public, $sk), $node);
            self::fail('another account\'s form was backed up');
        } catch (\RuntimeException $e) {
            self::assertSame('Form not found', $e->getMessage());
        } finally {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$stranger]);
        }
    }

    public function testAStolenApiKeyCannotNameItsOwnRecipient(): void
    {
        [$appId] = $this->appWithForm();
        ['node' => $node] = $this->node();
        ['sk' => $notTheNode] = $this->node();
        [$public] = $this->recipient();

        $this->expectExceptionMessage('account_backup_key_unbound');
        self::$service->createSource($this->userId, $this->request('app', $appId, $public, $notTheNode), $node);
    }

    public function testASignatureForOneThingDoesNotCoverAnother(): void
    {
        [$appId] = $this->appWithForm();
        $other = self::$apps->createApp(['name' => 'Other'], $this->userId);
        ['node' => $node, 'sk' => $sk] = $this->node();
        [$public] = $this->recipient();

        $this->expectExceptionMessage('account_backup_key_unbound');
        self::$service->createSource($this->userId, ['id' => (string) $other['id']] + $this->request('app', $appId, $public, $sk), $node);
    }

    public function testASignatureForOneRecipientDoesNotCoverAnother(): void
    {
        [$appId] = $this->appWithForm();
        ['node' => $node, 'sk' => $sk] = $this->node();
        [$public] = $this->recipient();
        [$attacker] = $this->recipient();

        $this->expectExceptionMessage('account_backup_key_unbound');
        self::$service->createSource($this->userId, ['recipientPk' => $attacker] + $this->request('app', $appId, $public, $sk), $node);
    }

    public function testAnOldRequestIsRefused(): void
    {
        [$appId] = $this->appWithForm();
        ['node' => $node, 'sk' => $sk] = $this->node();
        [$public] = $this->recipient();
        $old = gmdate('Y-m-d\TH:i:s\Z', time() - DataAccountBackupService::REQUEST_SIGNATURE_WINDOW_SECONDS - 60);

        $this->expectExceptionMessage('account_backup_key_unbound');
        self::$service->createSource($this->userId, $this->request('app', $appId, $public, $sk, $old), $node);
    }

    public function testOnlyAppsAndFormsCanBeNamed(): void
    {
        ['node' => $node, 'sk' => $sk] = $this->node();
        [$public] = $this->recipient();

        $this->expectExceptionMessage('source_backup_bad_source');
        self::$service->createSource($this->userId, $this->request('account', 'x', $public, $sk), $node);
    }

    public function testARestoreNeedsTheNodesSignatureOverThoseBytes(): void
    {
        $form = $this->makeDraftForm();
        ['node' => $node, 'sk' => $sk] = $this->node();
        [$public, $secret] = $this->recipient();
        $result = self::$service->createSource($this->userId, $this->request('form', (string) $form['id'], $public, $sk), $node);
        $zip = $this->opened($this->userId, $result['backupId'], $secret);
        [$requestedAt, $signature] = $this->sign($zip, $sk);

        file_put_contents($zip, 'x', FILE_APPEND);
        try {
            self::$service->restoreSource($this->userId, $zip, $requestedAt, $signature, $node);
            self::fail('a signature covered other bytes');
        } catch (\RuntimeException $e) {
            self::assertSame('account_backup_key_unbound', $e->getMessage());
        } finally {
            unlink($zip);
        }
    }

    public function testAnotherAccountCannotFetchOrDeleteTheStagedFile(): void
    {
        $form = $this->makeDraftForm();
        ['node' => $node, 'sk' => $sk] = $this->node();
        [$public] = $this->recipient();
        $result = self::$service->createSource($this->userId, $this->request('form', (string) $form['id'], $public, $sk), $node);
        $stranger = $this->makeUser();
        try {
            self::assertNull(self::$service->payloadPath($stranger, $result['backupId']));
            self::assertFalse(self::$service->deleteOwned($stranger, $result['backupId']));
        } finally {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$stranger]);
        }
        self::assertTrue(self::$service->deleteOwned($this->userId, $result['backupId']));
    }
}

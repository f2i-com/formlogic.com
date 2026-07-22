<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AccountBackupService;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\EncryptionRequestException;
use FormLogic\Services\FlowService;
use FormLogic\Services\FormEncryptionService;
use FormLogic\Services\FormService;
use FormLogic\Services\ResponseService;
use FormLogic\Services\TrashService;
use FormLogic\Services\VaultService;
use FormLogic\Services\WebhookService;
use FormLogic\Tests\Support\E2eePrivateFormsSupport;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * E2EE enable lifecycle (docs/E2EE_PRIVATE_FORMS_PLAN.md §9.1): the atomic
 * preflight with EVERY item individually violated, real Ed25519 manifest +
 * grant signature verification (sodium keypairs minted in the test), schema
 * version publishing, ever_published_at durability, irreversibility, and the
 * trash → restore → purge key-row lifecycle. Skipped without a test database.
 */
class FormEncryptionEnableTest extends TestCase
{
    use E2eePrivateFormsSupport;

    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static SQLiteConnection $sqlite;
    private static FormService $forms;
    private static ResponseService $responses;
    private static VaultService $vaults;
    private static FormEncryptionService $enc;
    private static WebhookService $webhooks;
    private static FlowService $flows;
    private static AppService $apps;
    private static TrashService $trash;
    private static string $tmpRoot = '';

    public static function setUpBeforeClass(): void
    {
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) {
            \Dotenv\Dotenv::createImmutable($root)->safeLoad();
        }
        $config = [
            'host' => $_ENV['DB_HOST'] ?? '127.0.0.1',
            'port' => $_ENV['DB_PORT'] ?? '3306',
            'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
            'username' => $_ENV['DB_USERNAME'] ?? 'root',
            'password' => $_ENV['DB_PASSWORD'] ?? '',
            'charset' => 'utf8mb4',
            'collation' => 'utf8mb4_unicode_ci',
        ];
        try {
            $conn = new MySQLConnection($config);
            $conn->getConnection()->query('SELECT 1');
            $conn->initializeSchema();
            $conn->runMigrations();
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
        self::$mysql = $conn;
        self::$pdo = $conn->getConnection();
        self::$tmpRoot = sys_get_temp_dir() . '/fl-e2ee-enable-' . bin2hex(random_bytes(4));
        mkdir(self::$tmpRoot . '/sqlite', 0777, true);
        mkdir(self::$tmpRoot . '/uploads', 0777, true);

        self::$sqlite = new SQLiteConnection(self::$tmpRoot . '/sqlite');
        self::$forms = new FormService($conn, self::$sqlite);
        self::$responses = new ResponseService($conn, self::$sqlite);
        self::$vaults = new VaultService($conn);
        self::$enc = new FormEncryptionService($conn, self::$sqlite, self::$tmpRoot . '/uploads');
        self::$webhooks = new WebhookService($conn);
        self::$flows = new FlowService($conn);
        self::$apps = new AppService($conn, self::$forms);
        self::$trash = new TrashService(
            $conn,
            self::$sqlite,
            new AccountBackupService(
                $conn,
                self::$sqlite,
                self::$forms,
                self::$apps,
                new AppUserService($conn),
                self::$flows,
                self::$responses,
                [],
                self::$tmpRoot . '/sqlite',
                self::$tmpRoot . '/uploads'
            ),
            self::$forms,
            self::$apps,
            self::$flows,
            ['retentionDays' => 30, 'dir' => self::$tmpRoot . '/trash']
        );
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        FormEncryptionService::invalidateCache();
    }

    // ── helpers ──

    /** @return array{userId: string, keys: array} user + vault, ready to enable */
    private function ownerWithVault(): array
    {
        $userId = $this->insertUser(self::$pdo);
        $keys = $this->makeKeys();
        self::$vaults->createVault($userId, $this->vaultBody($keys));
        return ['userId' => $userId, 'keys' => $keys];
    }

    private function makeForm(string $userId, ?array $fields = null, ?string $status = null): string
    {
        $form = self::$forms->createForm([
            'title' => 'E2EE ' . bin2hex(random_bytes(3)),
            'userId' => $userId,
            'status' => $status ?? 'draft',
            'fields' => $fields ?? [['id' => 'name', 'type' => 'short_text', 'label' => 'Name', 'required' => false]],
        ]);
        return (string) $form['id'];
    }

    private function schemaJson(): string
    {
        return json_encode([['id' => 'name', 'type' => 'short_text', 'label' => 'Name']], JSON_UNESCAPED_SLASHES) ?: '[]';
    }

    /** @return list<string> preflight reasons from a blocked enable (fails the test if it succeeded) */
    private function expectBlocked(string $formId, string $userId, array $keys): array
    {
        try {
            self::$enc->enable($formId, $userId, $this->enableBody($formId, $userId, $keys, $this->schemaJson()));
            $this->fail('enable unexpectedly succeeded');
        } catch (EncryptionRequestException $e) {
            $this->assertSame('private_enable_blocked', $e->errorCode);
            $this->assertSame(409, $e->status);
            return $e->details['reasons'] ?? [];
        }
    }

    private function tableCount(string $table, string $formId): int
    {
        $stmt = self::$pdo->prepare("SELECT COUNT(*) FROM {$table} WHERE form_id = ?");
        $stmt->execute([$formId]);
        return (int) $stmt->fetchColumn();
    }

    // ── happy path ──

    public function testEnableWritesEveryRowAndTheManifestVerifies(): void
    {
        ['userId' => $userId, 'keys' => $keys] = $this->ownerWithVault();
        $formId = $this->makeForm($userId);
        $schemaJson = $this->schemaJson();

        $result = self::$enc->enable($formId, $userId, $this->enableBody($formId, $userId, $keys, $schemaJson));
        $this->assertSame(['enabled' => true, 'manifestSeq' => 1], $result);
        $this->assertTrue(self::$enc->isPrivate($formId));

        foreach (['form_encryption', 'form_schema_versions', 'form_ingestion_keys', 'form_manifests', 'form_key_grants'] as $table) {
            $this->assertSame(1, $this->tableCount($table, $formId), $table);
        }

        // The served manifest is mathematically verifiable against its own signerPk.
        $manifest = self::$enc->publicManifest($formId);
        $this->assertNotNull($manifest);
        $this->assertSame('private', $manifest['mode']);
        $this->assertSame(1, $manifest['epoch']);
        $this->assertSame(1, $manifest['schemaVersion']);
        $this->assertSame($schemaJson, $manifest['schemaJson']);
        $this->assertSame(hash('sha256', $schemaJson), $manifest['schemaHash']);
        $this->assertNull($manifest['expiresAt']);
        $canonical = 'flmanifest:1|' . $formId . '|' . $manifest['keyId'] . '|1|' . $manifest['publicKey']
            . '|' . $manifest['content'] . '|' . $manifest['wrap']
            . '|1|' . $manifest['schemaHash'] . '|' . $manifest['signerKeyId'] . '|-';
        $this->assertTrue(sodium_crypto_sign_verify_detached(
            (string) base64_decode($manifest['sig'], true),
            $canonical,
            (string) base64_decode($manifest['signerPk'], true)
        ));
        $this->assertSame(base64_encode($keys['signPk']), $manifest['signerPk']);

        // The stored signed_bytes ARE the canonical string (append-only evidence).
        $stmt = self::$pdo->prepare('SELECT signed_bytes, signature FROM form_manifests WHERE form_id = ?');
        $stmt->execute([$formId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        $this->assertSame($canonical, (string) $row['signed_bytes']);
        $this->assertSame(64, strlen((string) $row['signature']));

        // Envelope acceptance exposes exactly the enabled tuple.
        $this->assertSame([[
            'key_id' => $manifest['keyId'],
            'ingest_epoch' => 1,
            'schema_version' => 1,
            'schema_hash' => $manifest['schemaHash'],
        ]], self::$enc->acceptableManifests($formId));

        // Owner state: the self-grant round-trips with its verification context.
        $state = self::$enc->getState($formId, $userId);
        $this->assertSame('private', $state['encryption']['mode']);
        $this->assertSame(1, $state['encryption']['currentIngestEpoch']);
        $this->assertSame($userId, $state['grant']['grantorUserId']);
        $this->assertSame($userId, $state['grant']['granteeUserId']);
        $this->assertSame('owner', $state['grant']['role']);
        $this->assertSame(base64_encode($keys['boxPk']), $state['grant']['granteePk']);
        $this->assertCount(1, $state['ingestionKeys']);
        $this->assertSame('active', $state['ingestionKeys'][0]['state']);
        $this->assertCount(1, $state['schemaVersions']);
        $this->assertSame($schemaJson, $state['schemaVersions'][0]['schemaJson']);

        // Irreversible: a second enable is blocked (already_enabled among reasons).
        $reasons = $this->expectBlocked($formId, $userId, $keys);
        $this->assertContains('already_enabled', $reasons);
    }

    // ── §9.1 preflight, each item individually ──

    public function testPublishBlocksEnableAndEverPublishedAtIsDurable(): void
    {
        ['userId' => $userId, 'keys' => $keys] = $this->ownerWithVault();
        $formId = $this->makeForm($userId);

        $stmt = self::$pdo->prepare('SELECT ever_published_at FROM forms WHERE id = ?');
        $stmt->execute([$formId]);
        $this->assertNull($stmt->fetchColumn() ?: null, 'fresh draft has no publication history');

        self::$forms->updateForm($formId, ['status' => 'published']);
        $stmt->execute([$formId]);
        $publishedAt = $stmt->fetchColumn();
        $this->assertNotEmpty($publishedAt, 'first publish stamps ever_published_at');

        // Unpublishing does NOT clear the durable history…
        self::$forms->updateForm($formId, ['status' => 'draft']);
        $stmt->execute([$formId]);
        $this->assertSame($publishedAt, $stmt->fetchColumn(), 'unpublish never clears it');

        // …so enable refuses even on the now-draft form.
        $this->assertContains('ever_published', $this->expectBlocked($formId, $userId, $keys));
    }

    public function testFormCreatedPublishedHasHistoryFromBirth(): void
    {
        ['userId' => $userId, 'keys' => $keys] = $this->ownerWithVault();
        $formId = $this->makeForm($userId, null, 'published');
        $this->assertContains('ever_published', $this->expectBlocked($formId, $userId, $keys));
    }

    public function testExistingResponsesBlockEnable(): void
    {
        ['userId' => $userId, 'keys' => $keys] = $this->ownerWithVault();
        $formId = $this->makeForm($userId);
        self::$responses->createResponse($formId, ['answers' => ['name' => 'Ada']]);
        $this->assertContains('has_responses', $this->expectBlocked($formId, $userId, $keys));
    }

    public function testPendingUploadsBlockEnable(): void
    {
        ['userId' => $userId, 'keys' => $keys] = $this->ownerWithVault();
        $formId = $this->makeForm($userId);
        mkdir(self::$tmpRoot . '/uploads/' . $formId . '/.pending', 0777, true);
        file_put_contents(self::$tmpRoot . '/uploads/' . $formId . '/.pending/fil_x.bin', 'pending');
        $this->assertContains('pending_uploads', $this->expectBlocked($formId, $userId, $keys));
    }

    public function testWebhooksBlockEnable(): void
    {
        ['userId' => $userId, 'keys' => $keys] = $this->ownerWithVault();
        $formId = $this->makeForm($userId);
        self::$webhooks->createWebhook($formId, $userId, 'https://8.8.8.8/hook', ['response.created']);
        $this->assertContains('has_webhooks', $this->expectBlocked($formId, $userId, $keys));
    }

    public function testFlowBindingsBlockEnable(): void
    {
        ['userId' => $userId, 'keys' => $keys] = $this->ownerWithVault();
        $formId = $this->makeForm($userId);
        $flow = self::$flows->createWorkspaceFlow($userId, ['name' => 'Preflight flow']);
        self::$flows->createFormBinding($userId, $formId, ['flow' => $flow['slug'], 'event' => 'form.submitted', 'mode' => 'async']);
        $this->assertContains('has_flow_bindings', $this->expectBlocked($formId, $userId, $keys));
    }

    public function testResponseLinksBlockEnable(): void
    {
        ['userId' => $userId, 'keys' => $keys] = $this->ownerWithVault();
        $formId = $this->makeForm($userId);
        self::$pdo->prepare('INSERT INTO response_links (id, source_form_id, source_response_id, target_form_id, target_response_id, field_id) VALUES (?, ?, ?, ?, ?, ?)')
            ->execute([$this->uuid4(), $this->uuid4(), $this->uuid4(), $formId, $this->uuid4(), 'link_field']);
        $this->assertContains('has_response_links', $this->expectBlocked($formId, $userId, $keys));
    }

    public function testBlockedFieldTypesBlockEnable(): void
    {
        ['userId' => $userId, 'keys' => $keys] = $this->ownerWithVault();
        foreach (['file_upload', 'camera', 'linked_record'] as $type) {
            $formId = $this->makeForm($userId, [
                ['id' => 'name', 'type' => 'short_text', 'label' => 'Name', 'required' => false],
                ['id' => 'bad', 'type' => $type, 'label' => 'Blocked', 'required' => false],
            ]);
            $this->assertContains('blocked_field_types', $this->expectBlocked($formId, $userId, $keys), $type);
        }
    }

    public function testAppAttachmentBlocksEnable(): void
    {
        ['userId' => $userId, 'keys' => $keys] = $this->ownerWithVault();
        $formId = $this->makeForm($userId);
        $app = self::$apps->createApp(['name' => 'Preflight app'], $userId);
        self::$apps->addFormToApp((string) $app['id'], $formId, 'Records');
        $this->assertContains('attached_to_app', $this->expectBlocked($formId, $userId, $keys));
    }

    public function testMissingVaultBlocksEnable(): void
    {
        $userId = $this->insertUser(self::$pdo); // no vault
        $keys = $this->makeKeys();
        $formId = $this->makeForm($userId);
        $this->assertContains('no_vault', $this->expectBlocked($formId, $userId, $keys));
    }

    public function testAllViolationsAreReportedTogether(): void
    {
        $userId = $this->insertUser(self::$pdo); // no vault
        $keys = $this->makeKeys();
        $formId = $this->makeForm($userId, null, 'published');
        self::$responses->createResponse($formId, ['answers' => ['name' => 'Ada']]);
        $reasons = $this->expectBlocked($formId, $userId, $keys);
        $this->assertContains('ever_published', $reasons);
        $this->assertContains('has_responses', $reasons);
        $this->assertContains('no_vault', $reasons);
        // Nothing was partially enabled.
        $this->assertSame(0, $this->tableCount('form_encryption', $formId));
        $this->assertSame(0, $this->tableCount('form_ingestion_keys', $formId));
    }

    // ── cryptographic verification ──

    public function testTamperedManifestSignatureIsRefused(): void
    {
        ['userId' => $userId, 'keys' => $keys] = $this->ownerWithVault();
        $formId = $this->makeForm($userId);
        $body = $this->enableBody($formId, $userId, $keys, $this->schemaJson());
        $sig = base64_decode($body['manifest']['signature'], true);
        $sig[0] = chr(ord($sig[0]) ^ 0x01);
        $body['manifest']['signature'] = base64_encode($sig);
        try {
            self::$enc->enable($formId, $userId, $body);
            $this->fail('tampered manifest signature accepted');
        } catch (EncryptionRequestException $e) {
            $this->assertSame('manifest_invalid', $e->errorCode);
        }
        $this->assertSame(0, $this->tableCount('form_encryption', $formId), 'nothing stored');
    }

    public function testForeignSignerKeyIsRefused(): void
    {
        ['userId' => $userId, 'keys' => $keys] = $this->ownerWithVault();
        $formId = $this->makeForm($userId);
        // Signed by a DIFFERENT keypair than the vault's — signerKeyId mismatch.
        $foreign = $this->makeKeys();
        $body = $this->enableBody($formId, $userId, $foreign, $this->schemaJson());
        try {
            self::$enc->enable($formId, $userId, $body);
            $this->fail('foreign signer accepted');
        } catch (EncryptionRequestException $e) {
            $this->assertSame('manifest_invalid', $e->errorCode);
        }
    }

    public function testSchemaHashMismatchIsRefused(): void
    {
        ['userId' => $userId, 'keys' => $keys] = $this->ownerWithVault();
        $formId = $this->makeForm($userId);
        $body = $this->enableBody($formId, $userId, $keys, $this->schemaJson());
        $body['schema']['schemaHash'] = hash('sha256', 'something else entirely');
        try {
            self::$enc->enable($formId, $userId, $body);
            $this->fail('schemaHash mismatch accepted');
        } catch (EncryptionRequestException $e) {
            $this->assertSame('manifest_invalid', $e->errorCode);
        }
    }

    public function testTamperedGrantSignatureIsRefused(): void
    {
        ['userId' => $userId, 'keys' => $keys] = $this->ownerWithVault();
        $formId = $this->makeForm($userId);
        $body = $this->enableBody($formId, $userId, $keys, $this->schemaJson());
        // Swap the sealed FK blob under the signature — the wrapped-key hash binding must catch it.
        $body['grant']['wrappedKey'] = base64_encode(random_bytes(80));
        try {
            self::$enc->enable($formId, $userId, $body);
            $this->fail('grant blob swap accepted');
        } catch (EncryptionRequestException $e) {
            $this->assertSame('grant_invalid', $e->errorCode);
        }
    }

    public function testMalformedShapeIsTypedPayloadInvalid(): void
    {
        ['userId' => $userId, 'keys' => $keys] = $this->ownerWithVault();
        $formId = $this->makeForm($userId);
        $body = $this->enableBody($formId, $userId, $keys, $this->schemaJson());
        $body['ingestionPublicKey'] = base64_encode(random_bytes(31)); // wrong length
        try {
            self::$enc->enable($formId, $userId, $body);
            $this->fail('malformed ingestion key accepted');
        } catch (EncryptionRequestException $e) {
            $this->assertSame('encryption_payload_invalid', $e->errorCode);
        }
    }

    // ── schema publishing ──

    public function testSchemaPublishAppendsVersionAndSupersedesManifest(): void
    {
        ['userId' => $userId, 'keys' => $keys] = $this->ownerWithVault();
        $formId = $this->makeForm($userId);
        self::$enc->enable($formId, $userId, $this->enableBody($formId, $userId, $keys, $this->schemaJson()));
        $m1 = self::$enc->publicManifest($formId);

        $schemaV2 = json_encode([
            ['id' => 'name', 'type' => 'short_text', 'label' => 'Name'],
            ['id' => 'note', 'type' => 'long_text', 'label' => 'Note'],
        ], JSON_UNESCAPED_SLASHES) ?: '[]';
        $result = self::$enc->publishSchemaVersion($formId, $userId, $this->schemaPublishBody(
            $formId,
            $keys,
            $schemaV2,
            2,
            $m1['keyId'],
            $m1['publicKey']
        ));
        $this->assertSame(['schemaVersion' => 2, 'manifestSeq' => 2], $result);

        // The served manifest is now v2; manifest 1 is superseded but still stored.
        $m2 = self::$enc->publicManifest($formId);
        $this->assertSame(2, $m2['schemaVersion']);
        $this->assertSame($schemaV2, $m2['schemaJson']);
        $stmt = self::$pdo->prepare('SELECT manifest_seq, superseded_at FROM form_manifests WHERE form_id = ? ORDER BY manifest_seq');
        $stmt->execute([$formId]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        $this->assertCount(2, $rows);
        $this->assertNotNull($rows[0]['superseded_at']);
        $this->assertNull($rows[1]['superseded_at']);

        // Superseded-manifest acceptance follows the KEY's grace (plan §8): the key
        // is still active, so BOTH tuples remain acceptable for envelope writes.
        $tuples = self::$enc->acceptableManifests($formId);
        $this->assertCount(2, $tuples);
        $versions = array_column($tuples, 'schema_version');
        sort($versions);
        $this->assertSame([1, 2], $versions);

        // A tampered schema publish fails signature verification.
        $bad = $this->schemaPublishBody($formId, $keys, $schemaV2 . ' ', 3, $m1['keyId'], $m1['publicKey']);
        $bad['manifest']['signature'] = base64_encode(random_bytes(64));
        try {
            self::$enc->publishSchemaVersion($formId, $userId, $bad);
            $this->fail('tampered schema publish accepted');
        } catch (EncryptionRequestException $e) {
            $this->assertSame('manifest_invalid', $e->errorCode);
        }
    }

    // ── trash lifecycle ──

    public function testTrashRestorePurgeLifecycle(): void
    {
        ['userId' => $userId, 'keys' => $keys] = $this->ownerWithVault();
        $formId = $this->makeForm($userId);
        self::$enc->enable($formId, $userId, $this->enableBody($formId, $userId, $keys, $this->schemaJson()));

        // Trash: rows are PARKED, not deleted — and the form stays private.
        $out = self::$trash->trashForm($formId, $userId);
        $this->assertTrue($out['deleted']);
        $this->assertTrue($out['trashed']);
        FormEncryptionService::invalidateCache();
        foreach (['form_encryption', 'form_ingestion_keys', 'form_key_grants'] as $table) {
            $stmt = self::$pdo->prepare("SELECT state FROM {$table} WHERE form_id = ?");
            $stmt->execute([$formId]);
            $this->assertSame('trashed', $stmt->fetchColumn(), $table);
        }
        $this->assertSame(1, $this->tableCount('form_manifests', $formId), 'manifests stay put');
        $this->assertTrue(self::$enc->isPrivate($formId), 'trashed private form stays gated');

        // Restore: states flip back and the form row returns with its original id.
        $items = self::$trash->listTrash($userId);
        $this->assertNotEmpty($items);
        self::$trash->restore($items[0]['id'], $userId);
        foreach (['form_encryption', 'form_ingestion_keys', 'form_key_grants'] as $table) {
            $stmt = self::$pdo->prepare("SELECT state FROM {$table} WHERE form_id = ?");
            $stmt->execute([$formId]);
            $this->assertSame('active', $stmt->fetchColumn(), $table);
        }
        $this->assertNotNull(self::$forms->getForm($formId), 'form restored under its original id');
        $this->assertNotNull(self::$enc->publicManifest($formId), 'manifest serves again after restore');

        // Purge ("delete forever"): every encryption row goes with the snapshot.
        self::$trash->trashForm($formId, $userId);
        $items = self::$trash->listTrash($userId);
        $this->assertNotEmpty($items);
        $this->assertTrue(self::$trash->purgeItem($items[0]['id'], $userId));
        foreach (['form_encryption', 'form_ingestion_keys', 'form_key_grants', 'form_manifests', 'form_schema_versions'] as $table) {
            $this->assertSame(0, $this->tableCount($table, $formId), $table);
        }
        FormEncryptionService::invalidateCache();
        $this->assertFalse(self::$enc->isPrivate($formId));
    }
}

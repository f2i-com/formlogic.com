<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FlowService;
use FormLogic\Services\FormEncryptionService;
use FormLogic\Services\FormService;
use FormLogic\Services\ResponseService;
use FormLogic\Services\VaultService;
use FormLogic\Services\WebhookService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Shared fixture base for the E2EE Private Forms integration suite
 * (docs/E2EE_PRIVATE_FORMS_PLAN.md §16-P2/P3 gates). Boots the real test MySQL
 * (formlogic_test) + a per-class temp SQLite storage, and knows how to:
 *  - mint a user vault with REAL sodium keypairs (the wrapped blobs are random
 *    bytes — the server can never open them anyway),
 *  - build a correctly-SIGNED enable body (manifest + self-grant) by recomputing
 *    the §8/§11 canonical strings test-side — an independent reimplementation,
 *    so a canonical-string drift in the service fails these tests,
 *  - build structurally valid __flenc:1 envelopes against a form's live manifest.
 */
abstract class E2eeTestCase extends TestCase
{
    protected static ?MySQLConnection $mysql = null;
    protected static ?PDO $pdo = null;
    protected static SQLiteConnection $sqlite;
    protected static FormService $forms;
    protected static ResponseService $responses;
    protected static AppService $apps;
    protected static AppUserService $appUsers;
    protected static FlowService $flows;
    protected static WebhookService $webhooks;
    protected static FormEncryptionService $encryption;
    protected static VaultService $vaults;
    protected static string $tmpRoot = '';
    protected static string $uploadsPath = '';

    protected string $userId = '';
    /** @var list<string> form ids created by this test (cleaned in tearDown) */
    private array $ownedFormIds = [];

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
        self::$tmpRoot = sys_get_temp_dir() . '/formlogic-e2ee-test-' . bin2hex(random_bytes(4));
        self::$uploadsPath = self::$tmpRoot . '/uploads';
        mkdir(self::$tmpRoot . '/sqlite', 0777, true);
        mkdir(self::$uploadsPath, 0777, true);

        self::$sqlite = new SQLiteConnection(self::$tmpRoot . '/sqlite');
        self::$forms = new FormService($conn, self::$sqlite);
        self::$responses = new ResponseService($conn, self::$sqlite);
        self::$apps = new AppService($conn, self::$forms);
        self::$appUsers = new AppUserService($conn);
        self::$flows = new FlowService($conn);
        self::$webhooks = new WebhookService($conn);
        self::$encryption = new FormEncryptionService($conn, self::$sqlite, self::$uploadsPath);
        self::$vaults = new VaultService($conn);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        if (!FormEncryptionService::sodiumAvailable()) {
            $this->markTestSkipped('ext-sodium unavailable');
        }
        $this->userId = $this->makeUser();
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null || $this->userId === '') {
            return;
        }
        $uid = $this->userId;
        self::$pdo->prepare('DELETE FROM user_vaults WHERE user_id = ?')->execute([$uid]);
        self::$pdo->prepare('DELETE FROM audit_log WHERE user_id = ?')->execute([$uid]);
        $formIds = self::$pdo->prepare('SELECT id FROM forms WHERE user_id = ?');
        $formIds->execute([$uid]);
        $ids = array_merge($formIds->fetchAll(PDO::FETCH_COLUMN), $this->ownedFormIds);
        foreach (array_unique($ids) as $fid) {
            foreach (['form_encryption', 'form_ingestion_keys', 'form_key_grants', 'form_manifests', 'form_schema_versions'] as $t) {
                self::$pdo->prepare("DELETE FROM {$t} WHERE form_id = ?")->execute([$fid]);
            }
            self::$pdo->prepare('DELETE FROM response_metadata WHERE form_id = ?')->execute([$fid]);
            self::$pdo->prepare('DELETE FROM webhooks WHERE form_id = ?')->execute([$fid]);
            self::$pdo->prepare('DELETE FROM app_flow_bindings WHERE form_id = ?')->execute([$fid]);
            self::$pdo->prepare('DELETE FROM response_links WHERE source_form_id = ? OR target_form_id = ?')->execute([$fid, $fid]);
            self::$pdo->prepare('DELETE FROM app_forms WHERE form_id = ?')->execute([$fid]);
            self::$pdo->prepare('DELETE FROM form_submission_idempotency WHERE form_id = ?')->execute([$fid]);
            self::$pdo->prepare('DELETE FROM trash_items WHERE original_id = ?')->execute([$fid]);
            self::$pdo->prepare('DELETE FROM store_ops WHERE entity_id = ?')->execute([$fid]);
            self::$pdo->prepare('DELETE FROM form_versions WHERE form_id = ?')->execute([$fid]);
        }
        $ownedApps = self::$pdo->prepare('SELECT id FROM apps WHERE owner_id = ?');
        $ownedApps->execute([$uid]);
        foreach ($ownedApps->fetchAll(PDO::FETCH_COLUMN) as $aid) {
            self::$pdo->prepare('DELETE FROM app_flow_bindings WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_forms WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?)')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$aid]);
        }
        self::$pdo->prepare('DELETE FROM app_flow_bindings WHERE flow_definition_id IN (SELECT id FROM flow_definitions WHERE owner_user_id = ?)')->execute([$uid]);
        self::$pdo->prepare('DELETE FROM flow_definitions WHERE owner_user_id = ?')->execute([$uid]);
        self::$pdo->prepare('DELETE FROM apps WHERE owner_id = ?')->execute([$uid]);
        self::$pdo->prepare('DELETE FROM forms WHERE user_id = ?')->execute([$uid]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
        FormEncryptionService::invalidateCache();
    }

    // ── fixtures ─────────────────────────────────────────────────────────────

    protected function makeUser(): string
    {
        $id = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$id, $id . '@test.local']);
        return $id;
    }

    /** A draft standalone form with one short_text field — eligible for private enable. */
    protected function makeDraftForm(?string $userId = null, array $fields = []): array
    {
        $form = self::$forms->createForm([
            'title' => 'Private Candidate',
            'userId' => $userId ?? $this->userId,
            'status' => 'draft',
            'fields' => $fields !== [] ? $fields : [
                ['id' => 'name', 'type' => 'short_text', 'label' => 'Name', 'required' => false],
            ],
        ]);
        $this->ownedFormIds[] = (string) $form['id'];
        return $form;
    }

    /**
     * Create a user_vaults row with REAL sodium keypairs (the wrapped blobs are
     * random bytes of the exact expected sizes — the server never unwraps them).
     *
     * @return array{x25519PkB64: string, ed25519PkB64: string, x25519SkRaw: string, ed25519SkRaw: string}
     */
    protected function makeVault(string $userId): array
    {
        $box = sodium_crypto_box_keypair();
        $sign = sodium_crypto_sign_keypair();
        $xPk = sodium_crypto_box_publickey($box);
        $edPk = sodium_crypto_sign_publickey($sign);
        self::$vaults->createVault($userId, [
            'kdf' => VaultService::KDF,
            'kdfSalt' => base64_encode(random_bytes(16)),
            'kdfOpslimit' => VaultService::MIN_OPSLIMIT,
            'kdfMemlimit' => VaultService::MIN_MEMLIMIT,
            'wrappedUmk' => base64_encode(random_bytes(72)),
            'wrappedUmkRecovery' => base64_encode(random_bytes(72)),
            'encKeyBundle' => base64_encode(random_bytes(120)),
            'x25519Pk' => base64_encode($xPk),
            'ed25519Pk' => base64_encode($edPk),
        ]);
        return [
            'x25519PkB64' => base64_encode($xPk),
            'ed25519PkB64' => base64_encode($edPk),
            'x25519SkRaw' => sodium_crypto_box_secretkey($box),
            'ed25519SkRaw' => sodium_crypto_sign_secretkey($sign),
        ];
    }

    // ── canonical strings (independent reimplementation of plan §8/§11) ──────

    protected function manifestCanonical(string $formId, string $keyId, int $epoch, string $publicKeyB64, int $schemaVersion, string $schemaHash, string $signerKeyId, ?string $expiresAt = null): string
    {
        return 'flmanifest:1|' . $formId . '|' . $keyId . '|' . $epoch . '|' . $publicKeyB64
            . '|xchacha20p1305.1|sealedbox-x25519xsalsa20p1305.1'
            . '|' . $schemaVersion . '|' . $schemaHash . '|' . $signerKeyId . '|' . ($expiresAt ?: '-');
    }

    protected function grantCanonical(string $grantId, string $formId, int $fkEpoch, string $grantorUserId, string $granteeUserId, string $granteePkRaw, string $wrappedKeyRaw, ?string $expiresAt = null): string
    {
        return 'flgrant:1|' . $grantId . '|' . $formId . '|' . $fkEpoch . '|' . $grantorUserId . '|' . $granteeUserId
            . '|' . hash('sha256', $granteePkRaw) . '|' . hash('sha256', $wrappedKeyRaw)
            . '|sealedbox-x25519xsalsa20p1305.1|owner|' . ($expiresAt ?: '-');
    }

    /**
     * A correctly-signed enable body for FormEncryptionService::enable().
     *
     * @param array{x25519PkB64: string, ed25519PkB64: string, ed25519SkRaw: string} $vault
     * @return array<string,mixed>
     */
    protected function makeEnableBody(string $formId, string $userId, array $vault, ?array $form = null): array
    {
        $form ??= self::$forms->getForm($formId);
        $schemaJson = (string) json_encode($form['fields'] ?? [], JSON_UNESCAPED_SLASHES);
        $schemaHash = hash('sha256', $schemaJson);

        $ingest = sodium_crypto_box_keypair();
        $ingestPkB64 = base64_encode(sodium_crypto_box_publickey($ingest));
        $keyId = 'fik_' . bin2hex(random_bytes(8));
        $grantId = 'fkg_' . bin2hex(random_bytes(8));
        $wrappedKeyRaw = random_bytes(80);
        $signerKeyId = substr(hash('sha256', base64_decode($vault['ed25519PkB64'])), 0, 16);

        $manifestSig = sodium_crypto_sign_detached(
            $this->manifestCanonical($formId, $keyId, 1, $ingestPkB64, 1, $schemaHash, $signerKeyId),
            $vault['ed25519SkRaw']
        );
        $grantSig = sodium_crypto_sign_detached(
            $this->grantCanonical(
                $grantId,
                $formId,
                1,
                $userId,
                $userId,
                base64_decode($vault['x25519PkB64']),
                $wrappedKeyRaw
            ),
            $vault['ed25519SkRaw']
        );

        return [
            'keyId' => $keyId,
            'ingestEpoch' => 1,
            'fkEpoch' => 1,
            'ingestionPublicKey' => $ingestPkB64,
            'wrappedIngestionSecret' => base64_encode(random_bytes(72)),
            'grant' => [
                'grantId' => $grantId,
                'wrappedKey' => base64_encode($wrappedKeyRaw),
                'signature' => base64_encode($grantSig),
                'role' => 'owner',
                'sigVersion' => 1,
            ],
            'schema' => ['schemaJson' => $schemaJson, 'schemaHash' => $schemaHash],
            'manifest' => ['signature' => base64_encode($manifestSig), 'signerKeyId' => $signerKeyId, 'expiresAt' => null],
        ];
    }

    /** Enable private mode on a draft form (vault is created for the owner). */
    protected function enablePrivateForm(string $formId, ?string $userId = null): array
    {
        $userId ??= $this->userId;
        $vault = $this->makeVault($userId);
        $result = self::$encryption->enable($formId, $userId, $this->makeEnableBody($formId, $userId, $vault));
        FormEncryptionService::invalidateCache();
        return ['result' => $result, 'vault' => $vault];
    }

    /**
     * A structurally valid __flenc:1 envelope matching one of the form's CURRENT
     * acceptable manifest tuples (random DEK wrap/nonce/ct — the server never
     * opens them). $schemaVersion pins which manifest tuple to use (default: the
     * lowest — deterministic across DB row order).
     *
     * @return array<string,mixed>
     */
    protected function makeEnvelope(string $formId, int $rev = 1, ?string $recordId = null, ?int $schemaVersion = null): array
    {
        $manifests = self::$encryption->acceptableManifests($formId);
        $this->assertNotEmpty($manifests, 'no acceptable manifest for the form');
        usort($manifests, static fn (array $a, array $b) => $a['schema_version'] <=> $b['schema_version']);
        $m = null;
        foreach ($manifests as $candidate) {
            if ($schemaVersion === null || $candidate['schema_version'] === $schemaVersion) {
                $m = $candidate;
                break;
            }
        }
        $this->assertNotNull($m, "no acceptable manifest at schema version " . var_export($schemaVersion, true));
        return [
            '__flenc' => 1,
            'recordId' => $recordId ?? $this->uuidV4(),
            'rev' => $rev,
            'keyId' => $m['key_id'],
            'epoch' => $m['ingest_epoch'],
            'content' => 'xchacha20p1305.1',
            'wrap' => 'sealedbox-x25519xsalsa20p1305.1',
            'schemaVersion' => $m['schema_version'],
            'schemaHash' => $m['schema_hash'],
            'wrappedDek' => base64_encode(random_bytes(80)),
            'nonce' => base64_encode(random_bytes(24)),
            'ct' => base64_encode(random_bytes(96)),
        ];
    }

    protected function uuidV4(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }

    /** Direct row fetch for assertions. */
    protected function row(string $sql, array $params = []): ?array
    {
        $stmt = self::$pdo->prepare($sql);
        $stmt->execute($params);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return is_array($row) ? $row : null;
    }
}

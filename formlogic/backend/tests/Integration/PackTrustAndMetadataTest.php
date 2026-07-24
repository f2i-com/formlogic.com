<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\PackController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FormService;
use FormLogic\Services\PackService;
use FormLogic\Services\SigningService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Response as SlimResponse;

/**
 * Trust classification (#6) + application-package envelope metadata (#7) against a real DB:
 *   - POST /api/packs/describe returns official (Ed25519) / local-only (HS256) for a VERIFYING signature,
 *     unverified for a tampered one, community for an unsigned pack — driven through the real controller.
 *   - A signed JSON envelope carrying app-level customLogic + launch/native APPLIES the customLogic to the
 *     created app and WARNS (never silently drops) the launch/native defaults that have no runtime target.
 * Skipped without a test DB.
 */
class PackTrustAndMetadataTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static FormService $forms;
    private static AppService $apps;
    private static AppUserService $appUsers;
    private static PackService $packs;
    private static SigningService $signing;

    private string $userId = '';

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
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/formlogic-packtrust-' . bin2hex(random_bytes(4)));
        self::$forms = new FormService($conn, $sqlite);
        self::$apps = new AppService($conn, self::$forms);
        self::$appUsers = new AppUserService($conn);
        self::$packs = new PackService($conn, self::$forms, self::$apps, self::$appUsers);
        self::$signing = new SigningService($conn);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->userId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan, cloud_until) VALUES (?, ?, 'x', 'T', 'personal', DATE_ADD(NOW(), INTERVAL 30 DAY))")
            ->execute([$this->userId, $this->userId . '@test.local']);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null || $this->userId === '') {
            return;
        }
        $this->cleanupUser($this->userId);
    }

    private function cleanupUser(string $uid): void
    {
        $appIds = self::$pdo->prepare('SELECT id FROM apps WHERE owner_id = ?');
        $appIds->execute([$uid]);
        foreach ($appIds->fetchAll(PDO::FETCH_COLUMN) as $aid) {
            self::$pdo->prepare('DELETE FROM app_forms WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?)')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$aid]);
        }
        self::$pdo->prepare('DELETE FROM apps WHERE owner_id = ?')->execute([$uid]);
        self::$pdo->prepare('DELETE FROM pack_installations WHERE user_id = ?')->execute([$uid]);
        self::$pdo->prepare('DELETE FROM forms WHERE user_id = ?')->execute([$uid]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
    }

    /** A minimal valid pack whose single app carries NO customLogic (so envelope logic can fill it). */
    private function minimalPack(): array
    {
        return [
            'formatVersion' => 1,
            'packMeta' => ['name' => 'Envelope App', 'version' => '1.0.0', 'description' => 'x'],
            'forms' => [
                ['packFormId' => 'intake', 'title' => 'Intake', 'fields' => [['id' => 'a', 'type' => 'short_text', 'label' => 'A']]],
            ],
            'apps' => [
                ['packAppId' => 'envelope-app', 'name' => 'Envelope App', 'forms' => [['packFormId' => 'intake', 'sortOrder' => 0]]],
            ],
        ];
    }

    private function controller(): PackController
    {
        return new PackController(self::$packs, null, null, self::$signing);
    }

    /** @return array{status:int, body:array} */
    private function callDescribe(array $body): array
    {
        $req = $this->createMock(ServerRequestInterface::class);
        $req->method('getParsedBody')->willReturn($body);
        $out = $this->controller()->describe($req, new SlimResponse());
        return ['status' => $out->getStatusCode(), 'body' => json_decode((string) $out->getBody(), true) ?: []];
    }

    /** @return array{status:int, body:array} */
    private function callImportSigned(string $userId, array $body): array
    {
        $req = $this->createMock(ServerRequestInterface::class);
        $req->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $userId : null);
        $req->method('getUploadedFiles')->willReturn([]);
        $req->method('getParsedBody')->willReturn($body);
        $out = $this->controller()->importSigned($req, new SlimResponse());
        return ['status' => $out->getStatusCode(), 'body' => json_decode((string) $out->getBody(), true) ?: []];
    }

    public function testDescribeUnsignedPackIsCommunity(): void
    {
        $r = $this->callDescribe(['pack' => $this->minimalPack()]);
        $this->assertSame(200, $r['status']);
        $this->assertSame('community', $r['body']['trust']);
    }

    public function testDescribeVerifyingSignatureIsAlgorithmAware(): void
    {
        $pack = $this->minimalPack();
        $signed = self::$signing->sign($pack);

        $r = $this->callDescribe(['pack' => $pack, 'signature' => $signed['signature'], 'alg' => $signed['alg']]);
        $this->assertSame(200, $r['status']);

        // A verifying signature is NOT blanket-'official': Ed25519 => official, the HS256 fallback =>
        // local-only. Assert against the server's real capability so the test holds in both environments.
        $expected = self::$signing->isEd25519() ? 'official' : 'local-only';
        $this->assertSame($expected, $r['body']['trust']);
        if (self::$signing->isEd25519()) {
            $this->assertSame('Ed25519', $signed['alg']);
        }
    }

    public function testDescribeTamperedSignatureIsUnverified(): void
    {
        $pack = $this->minimalPack();
        $signed = self::$signing->sign($pack);

        // Tamper: verify the ORIGINAL signature against a MODIFIED payload — must fail closed.
        $tampered = $pack;
        $tampered['packMeta']['name'] = 'Hijacked';
        $r = $this->callDescribe(['pack' => $tampered, 'signature' => $signed['signature'], 'alg' => $signed['alg']]);
        $this->assertSame(200, $r['status']);
        $this->assertSame('unverified', $r['body']['trust']);
    }

    public function testJsonEnvelopeCustomLogicAppliedAndLaunchNativeWarned(): void
    {
        $pack = $this->minimalPack();
        // Envelope-level metadata that lives OUTSIDE pack.json (spec §29.6): app custom logic + launch/native.
        $envelope = [
            'pack' => $pack,
            'customLogic' => [
                'version' => 1,
                'runtime' => 'quickjs',
                'scripts' => [
                    ['id' => 'boot', 'hook' => 'onAppStart', 'source' => 'function run(ctx){ return {}; }'],
                ],
            ],
            'launch' => ['landingPage' => 'dashboard', 'theme' => 'dark'],
            'native' => ['enabled' => true, 'window' => ['width' => 1024]],
        ];
        $signed = self::$signing->sign($envelope);

        $r = $this->callImportSigned($this->userId, [
            'package' => $envelope,
            'signature' => $signed['signature'],
            'alg' => $signed['alg'],
            'approvedConnectorGrants' => [],
        ]);

        $this->assertSame(201, $r['status'], 'signed envelope import succeeds');
        $this->assertContains($r['body']['trust'], ['official', 'local-only']);
        $this->assertCount(1, $r['body']['apps']);

        // customLogic (a metadata key WITH a runtime target) was applied to the created app.
        $appId = $r['body']['apps'][0]['id'];
        $app = self::$apps->getApp($appId);
        $this->assertNotEmpty($app['customLogic'] ?? [], 'envelope customLogic is persisted to the app');
        $this->assertSame('onAppStart', $app['customLogic']['scripts'][0]['hook'] ?? null);
        // Sanitizer forces the runtime — proves it went through CustomLogicSanitizer, not raw storage.
        $this->assertSame('quickjs', $app['customLogic']['scripts'][0]['runtime'] ?? null);

        // launch + native (no runtime target today) were WARNED, not silently dropped.
        $warnings = $r['body']['warnings'] ?? [];
        $this->assertIsArray($warnings);
        $blob = strtolower(implode(' | ', $warnings));
        $this->assertStringContainsString('launch', $blob, 'launch defaults are surfaced as a warning');
        $this->assertStringContainsString('native', $blob, 'native defaults are surfaced as a warning');
    }

    public function testUnsignedBarePackImportsWithoutEnvelopeWarnings(): void
    {
        // A bare Pack (no envelope) applies no metadata and produces no warnings.
        $r = $this->callImportSigned($this->userId, ['pack' => $this->minimalPack(), 'approvedConnectorGrants' => []]);
        $this->assertSame(201, $r['status']);
        $this->assertSame('community', $r['body']['trust']);
        $this->assertSame([], $r['body']['warnings'] ?? []);
    }

    // ── SAFE-001: every HTTP import lane fails closed without an explicit grant review ──────────────

    /** @return array{status:int, body:array} Drives the flat POST /api/packs/import controller path. */
    private function callImport(string $userId, array $body): array
    {
        $req = $this->createMock(ServerRequestInterface::class);
        $req->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $userId : null);
        $req->method('getParsedBody')->willReturn($body);
        $out = $this->controller()->import($req, new SlimResponse());
        return ['status' => $out->getStatusCode(), 'body' => json_decode((string) $out->getBody(), true) ?: []];
    }

    public function testFlatImportWithoutGrantReviewFailsClosed(): void
    {
        // Omitting approvedConnectorGrants used to mean "activate every requested grant" — now a 400.
        $r = $this->callImport($this->userId, ['pack' => $this->minimalPack()]);
        $this->assertSame(400, $r['status']);
        $this->assertSame('grant_review_required', $r['body']['code'] ?? null);

        // A malformed (non-array) value is equally a missing review.
        $r2 = $this->callImport($this->userId, ['pack' => $this->minimalPack(), 'approvedConnectorGrants' => 'all']);
        $this->assertSame(400, $r2['status']);
        $this->assertSame('grant_review_required', $r2['body']['code'] ?? null);

        // With an explicit (empty) review the same request imports.
        $r3 = $this->callImport($this->userId, ['pack' => $this->minimalPack(), 'approvedConnectorGrants' => []]);
        $this->assertSame(201, $r3['status']);
    }

    public function testImportSignedWithoutGrantReviewFailsClosed(): void
    {
        $r = $this->callImportSigned($this->userId, ['pack' => $this->minimalPack()]);
        $this->assertSame(400, $r['status']);
        $this->assertSame('grant_review_required', $r['body']['code'] ?? null);
    }

    public function testDescribeUnwrapsApplicationPackageEnvelope(): void
    {
        // An ApplicationPackage envelope carries the Pack under `.pack` plus envelope-level customLogic.
        // describe() must review the INNER pack (not report an empty 0-form summary) and must include
        // the envelope customLogic grants — the import path applies them to the created app.
        $envelope = [
            'pack' => $this->minimalPack(),
            'customLogic' => [
                'version' => 1,
                'runtime' => 'quickjs',
                'permissions' => ['connector.aokie.sms.send', 'ui.toast'],
                'scripts' => [
                    ['id' => 'boot', 'hook' => 'onAppStart', 'source' => 'function run(ctx){ return {}; }'],
                ],
            ],
        ];
        $r = $this->callDescribe(['pack' => $envelope]);
        $this->assertSame(200, $r['status']);
        $caps = $r['body']['capabilities'] ?? [];
        $this->assertSame(1, $caps['forms'] ?? null, 'inner pack is described, not the envelope wrapper');
        $this->assertSame(1, $caps['apps'] ?? null);
        $this->assertContains('connector.aokie.sms.send', $caps['permissions'] ?? [], 'envelope customLogic grants are reviewable');
        $this->assertContains('connector.aokie.sms.send', $caps['connectorGrants'] ?? [], 'envelope grants are in the strippable set');
        $this->assertContains('ui.toast', $caps['permissions'] ?? []);
    }

    public function testEnvelopeCustomLogicGrantsAreStrippedByReview(): void
    {
        // The envelope customLogic is the THIRD grant carrier: an unapproved connector grant must be
        // stripped from what gets persisted to the created app, surfaced in withheldGrants + warnings.
        $envelope = [
            'pack' => $this->minimalPack(),
            'customLogic' => [
                'version' => 1,
                'runtime' => 'quickjs',
                'permissions' => ['connector.aokie.sms.send', 'ui.toast'],
                'scripts' => [
                    [
                        'id' => 'boot',
                        'hook' => 'onAppStart',
                        'source' => 'function run(ctx){ return {}; }',
                        'permissions' => ['connector.aokie.call.hangup'],
                    ],
                ],
            ],
        ];
        $signed = self::$signing->sign($envelope);
        $r = $this->callImportSigned($this->userId, [
            'package' => $envelope,
            'signature' => $signed['signature'],
            'alg' => $signed['alg'],
            'approvedConnectorGrants' => ['connector.aokie.sms.send'],
        ]);
        $this->assertSame(201, $r['status']);

        $appId = $r['body']['apps'][0]['id'];
        $app = self::$apps->getApp($appId);
        $stored = $app['customLogic'] ?? [];
        $this->assertContains('connector.aokie.sms.send', $stored['permissions'] ?? [], 'approved grant survives');
        $this->assertContains('ui.toast', $stored['permissions'] ?? [], 'non-connector permissions always pass');
        $this->assertNotContains('connector.aokie.call.hangup', $stored['scripts'][0]['permissions'] ?? [], 'unapproved script grant is stripped');

        $this->assertContains('connector.aokie.call.hangup', $r['body']['withheldGrants'] ?? [], 'envelope-withheld grants are reported');
        $blob = strtolower(implode(' | ', $r['body']['warnings'] ?? []));
        $this->assertStringContainsString('not approved', $blob, 'the removal is surfaced as a warning');
    }
}

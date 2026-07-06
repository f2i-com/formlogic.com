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
 * Signed .formlogic ENVELOPE integrity (#1) + present-but-invalid JSON signature policy (#9).
 *
 * The detached signature now covers the CANONICAL manifest.json, which carries a sha256 of EVERY archive
 * entry (manifest.entries). So the importer must reject a tampered pack.json / quickjs/customLogic.json /
 * logo asset (entry-hash mismatch), and reject an applicable envelope file that is present but NOT covered
 * by the signed manifest (an unsigned extra). A properly signed archive applies its (now covered) envelope
 * metadata. On the JSON path, a PRESENT-but-INVALID signature is rejected 400 by default and only imports
 * (as 'unverified') with an explicit allowUnverified override; an unsigned JSON pack still imports community.
 * Skipped without a test DB.
 */
class SignedEnvelopePackageTest extends TestCase
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
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/formlogic-sigenv-' . bin2hex(random_bytes(4)));
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

    private function uuid(): string
    {
        return 'x-' . bin2hex(random_bytes(12));
    }

    // ── Fixtures ──────────────────────────────────────────────────────────────────────────────────

    /** A valid minimal pack.json whose single app carries NO customLogic (so envelope logic can fill it). */
    private function packJson(): string
    {
        return (string) json_encode([
            'formatVersion' => 1,
            'packMeta' => ['name' => 'Sig App', 'version' => '1.0.0', 'description' => 'x'],
            'forms' => [
                ['packFormId' => 'intake', 'title' => 'Intake', 'fields' => [['id' => 'a', 'type' => 'short_text', 'label' => 'A']]],
            ],
            'apps' => [
                ['packAppId' => 'sig-app', 'name' => 'Sig App', 'forms' => [['packFormId' => 'intake', 'sortOrder' => 0]]],
            ],
        ], JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    }

    /** A sanitizable app-logic bundle for quickjs/customLogic.json. */
    private function customLogicJson(): string
    {
        return (string) json_encode([
            'version' => 1,
            'runtime' => 'quickjs',
            'scripts' => [
                ['id' => 'boot', 'hook' => 'onAppStart', 'source' => 'function run(ctx){ return {}; }'],
            ],
        ], JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    }

    /** A tiny valid 1x1 PNG (bytes) for assets/logo.png. */
    private function pngBytes(): string
    {
        return (string) base64_decode(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
        );
    }

    /**
     * Build a CORRECTLY signed .formlogic archive from the given { entryName => bytes } map, mirroring
     * PackService::exportApplicationPackage: hash each entry, embed the hashes in manifest.entries, and sign
     * the canonical manifest. Tamper tests re-open the returned zip and mutate a single entry afterwards.
     *
     * @param array<string,string> $entries
     */
    private function signedArchive(array $entries): string
    {
        $entryHashes = [];
        foreach ($entries as $name => $bytes) {
            $entryHashes[$name] = hash('sha256', $bytes);
        }
        $manifest = [
            'version' => 1,
            'kind' => 'formlogic.applicationPackage',
            'id' => 'sig-app',
            'name' => 'Sig App',
            'description' => '',
            'packVersion' => '1.0.0',
            'contentHash' => 'sha256:' . ($entryHashes['pack.json'] ?? ''),
            'entries' => $entryHashes,
            'capabilities' => [],
        ];
        $signed = self::$signing->sign($manifest);

        $path = (string) tempnam(sys_get_temp_dir(), 'flsig_');
        $zip = new \ZipArchive();
        $this->assertTrue($zip->open($path, \ZipArchive::CREATE | \ZipArchive::OVERWRITE) === true);
        $zip->addFromString('manifest.json', (string) json_encode($manifest, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT));
        foreach ($entries as $name => $bytes) {
            $zip->addFromString($name, $bytes);
        }
        $zip->addFromString('signature.json', (string) json_encode([
            'signature' => $signed['signature'],
            'alg' => $signed['alg'],
            'keyId' => $signed['keyId'],
            'contentHash' => $manifest['contentHash'],
        ], JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT));
        $zip->close();
        return $path;
    }

    /** Replace ONE entry's bytes inside an existing archive without touching manifest/signature. */
    private function replaceEntry(string $zipPath, string $name, string $bytes): void
    {
        $zip = new \ZipArchive();
        $this->assertTrue($zip->open($zipPath) === true);
        $zip->deleteName($name);
        $zip->addFromString($name, $bytes);
        $zip->close();
    }

    /** Add ONE entry to an existing archive without touching manifest/signature (an unsigned extra). */
    private function addEntry(string $zipPath, string $name, string $bytes): void
    {
        $zip = new \ZipArchive();
        $this->assertTrue($zip->open($zipPath) === true);
        $zip->addFromString($name, $bytes);
        $zip->close();
    }

    // ── #1: signed-manifest integrity over the whole envelope ───────────────────────────────────────

    public function testTamperedPackJsonIsRejected(): void
    {
        $zipPath = $this->signedArchive(['pack.json' => $this->packJson()]);
        $this->replaceEntry($zipPath, 'pack.json', str_replace('Sig App', 'Hijacked', $this->packJson()));
        try {
            $this->expectException(\RuntimeException::class);
            $this->expectExceptionMessage('signature verification failed');
            self::$packs->importApplicationPackage($zipPath, $this->userId, self::$signing);
        } finally {
            @unlink($zipPath);
        }
    }

    public function testTamperedCustomLogicEnvelopeIsRejected(): void
    {
        $zipPath = $this->signedArchive([
            'pack.json' => $this->packJson(),
            'quickjs/customLogic.json' => $this->customLogicJson(),
        ]);
        // Change the covered quickjs bundle so its recomputed hash no longer matches the signed manifest.
        $this->replaceEntry($zipPath, 'quickjs/customLogic.json', str_replace('onAppStart', 'onBeforeSubmit', $this->customLogicJson()));
        try {
            $this->expectException(\RuntimeException::class);
            $this->expectExceptionMessage('signature verification failed');
            self::$packs->importApplicationPackage($zipPath, $this->userId, self::$signing);
        } finally {
            @unlink($zipPath);
        }
    }

    public function testTamperedLogoAssetIsRejected(): void
    {
        $zipPath = $this->signedArchive([
            'pack.json' => $this->packJson(),
            'assets/logo.png' => $this->pngBytes(),
        ]);
        $this->replaceEntry($zipPath, 'assets/logo.png', $this->pngBytes() . 'tampered');
        try {
            $this->expectException(\RuntimeException::class);
            $this->expectExceptionMessage('signature verification failed');
            self::$packs->importApplicationPackage($zipPath, $this->userId, self::$signing);
        } finally {
            @unlink($zipPath);
        }
    }

    public function testUnsignedExtraMetadataFileIsRejected(): void
    {
        // A signed archive that does NOT declare any quickjs bundle...
        $zipPath = $this->signedArchive(['pack.json' => $this->packJson()]);
        // ...then an attacker injects one WITHOUT re-signing the manifest. The manifest signature still
        // verifies (it is unchanged), but the injected file is not in manifest.entries → an unsigned extra.
        $this->addEntry($zipPath, 'quickjs/customLogic.json', $this->customLogicJson());
        try {
            $this->expectException(\RuntimeException::class);
            $this->expectExceptionMessage('not covered by the signed manifest');
            self::$packs->importApplicationPackage($zipPath, $this->userId, self::$signing);
        } finally {
            @unlink($zipPath);
        }
    }

    public function testUnsignedExtraAssetIsRejected(): void
    {
        $zipPath = $this->signedArchive(['pack.json' => $this->packJson()]);
        $this->addEntry($zipPath, 'assets/logo.png', $this->pngBytes());
        try {
            $this->expectException(\RuntimeException::class);
            $this->expectExceptionMessage('not covered by the signed manifest');
            self::$packs->importApplicationPackage($zipPath, $this->userId, self::$signing);
        } finally {
            @unlink($zipPath);
        }
    }

    public function testProperlySignedArchiveAppliesEnvelopeMetadata(): void
    {
        $zipPath = $this->signedArchive([
            'pack.json' => $this->packJson(),
            'quickjs/customLogic.json' => $this->customLogicJson(),
            'assets/logo.png' => $this->pngBytes(),
        ]);
        try {
            $result = self::$packs->importApplicationPackage($zipPath, $this->userId, self::$signing);
            $this->assertContains($result['trust'], ['official', 'local-only'], 'a covered, verified archive is trusted');
            $this->assertCount(1, $result['apps']);

            $app = self::$apps->getApp($result['apps'][0]['id']);
            // Envelope customLogic (covered by the signed manifest) was applied to the created app.
            $this->assertNotEmpty($app['customLogic'] ?? [], 'covered envelope customLogic is applied');
            $this->assertSame('onAppStart', $app['customLogic']['scripts'][0]['hook'] ?? null);
            // Sanitizer forces the runtime — proves it went through CustomLogicSanitizer, not raw storage.
            $this->assertSame('quickjs', $app['customLogic']['scripts'][0]['runtime'] ?? null);
            // The covered logo asset was applied as a data: URI.
            $this->assertStringStartsWith('data:image/png;base64,', (string) ($app['logoUrl'] ?? ''));
        } finally {
            @unlink($zipPath);
        }
    }

    public function testRealExportRoundTripCoversAndAppliesCustomLogic(): void
    {
        // Build a real app WITH app-level customLogic, then export via the real exporter.
        $formId = $this->uuid();
        self::$forms->createForm([
            'id' => $formId, 'userId' => $this->userId, 'title' => 'Intake', 'status' => 'published',
            'fields' => [['id' => 'a', 'type' => 'short_text', 'label' => 'A', 'required' => false]],
        ]);
        $app = self::$apps->createApp([
            'name' => 'Logic Shop',
            'customLogic' => [
                'version' => 1, 'runtime' => 'quickjs',
                'scripts' => [['id' => 'boot', 'hook' => 'onAppStart', 'source' => 'function run(ctx){ return {}; }']],
            ],
        ], $this->userId);
        self::$apps->addFormToApp($app['id'], $formId, 'Intake');

        $zipPath = self::$packs->exportApplicationPackage($app['id'], $this->userId, self::$signing);

        // The manifest now enumerates a per-entry hash for pack.json AND the quickjs bundle.
        $zip = new \ZipArchive();
        $this->assertTrue($zip->open($zipPath) === true);
        $manifest = json_decode((string) $zip->getFromName('manifest.json'), true);
        $zip->close();
        $this->assertIsArray($manifest['entries'] ?? null, 'manifest carries per-entry hashes');
        $this->assertArrayHasKey('pack.json', $manifest['entries']);
        $this->assertArrayHasKey('quickjs/customLogic.json', $manifest['entries'], 'the envelope quickjs bundle is hashed into the signed manifest');

        // Import into a SECOND account: the signed manifest verifies + every covered entry hash matches.
        $importer = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan, cloud_until) VALUES (?, ?, 'x', 'T', 'personal', DATE_ADD(NOW(), INTERVAL 30 DAY))")
            ->execute([$importer, $importer . '@test.local']);
        try {
            $result = self::$packs->importApplicationPackage($zipPath, $importer, self::$signing);
            $this->assertContains($result['trust'], ['official', 'local-only']);
            $newApp = self::$apps->getApp($result['apps'][0]['id']);
            $this->assertNotEmpty($newApp['customLogic'] ?? [], 'round-tripped customLogic survives + reapplies');
            $this->assertSame('onAppStart', $newApp['customLogic']['scripts'][0]['hook'] ?? null);
        } finally {
            @unlink($zipPath);
            $this->cleanupUser($importer);
        }
    }

    // ── #9: present-but-invalid JSON signature policy (importSigned Path B) ──────────────────────────

    private function controller(): PackController
    {
        return new PackController(self::$packs, null, null, self::$signing);
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

    private function jsonPack(): array
    {
        return [
            'formatVersion' => 1,
            'packMeta' => ['name' => 'Json Env App', 'version' => '1.0.0', 'description' => 'x'],
            'forms' => [['packFormId' => 'intake', 'title' => 'Intake', 'fields' => [['id' => 'a', 'type' => 'short_text', 'label' => 'A']]]],
            'apps' => [['packAppId' => 'json-env-app', 'name' => 'Json Env App', 'forms' => [['packFormId' => 'intake', 'sortOrder' => 0]]]],
        ];
    }

    public function testJsonPresentButInvalidSignatureRejectedByDefault(): void
    {
        // Force the workspace policy OFF so we observe the DEFAULT (400) rather than the 403 policy gate.
        $prev = $_ENV['REQUIRE_VERIFIED_PACKAGES'] ?? null;
        unset($_ENV['REQUIRE_VERIFIED_PACKAGES']);
        try {
            $pack = $this->jsonPack();
            $signed = self::$signing->sign($pack);
            // Present-but-invalid: the signature is over $pack, but the submitted package was modified.
            $tampered = $pack;
            $tampered['packMeta']['name'] = 'Hijacked';

            $r = $this->callImportSigned($this->userId, [
                'package' => $tampered,
                'signature' => $signed['signature'],
                'alg' => $signed['alg'],
            ]);
            $this->assertSame(400, $r['status'], 'a present-but-invalid signature is rejected by default');
            $this->assertSame('signature_invalid', $r['body']['code'] ?? null);

            // With an explicit override it imports, but only as 'unverified' (metadata still skipped).
            $r2 = $this->callImportSigned($this->userId, [
                'package' => $tampered,
                'signature' => $signed['signature'],
                'alg' => $signed['alg'],
                'allowUnverified' => true,
            ]);
            $this->assertSame(201, $r2['status'], 'allowUnverified lets a user knowingly proceed');
            $this->assertSame('unverified', $r2['body']['trust'] ?? null);
        } finally {
            if ($prev !== null) {
                $_ENV['REQUIRE_VERIFIED_PACKAGES'] = $prev;
            }
        }
    }

    public function testRequireVerifiedPackagesRejectsUnsignedAndInvalid(): void
    {
        // With the workspace policy ON, only positively-verified (signed) packages import. Critically, an
        // UNSIGNED package must ALSO be rejected — the previous gate only blocked 'unverified', so the
        // policy could be defeated by simply omitting the signature.
        $prev = $_ENV['REQUIRE_VERIFIED_PACKAGES'] ?? null;
        $_ENV['REQUIRE_VERIFIED_PACKAGES'] = 'true';
        try {
            $pack = $this->jsonPack();

            // (a) unsigned (community) → 403.
            $r = $this->callImportSigned($this->userId, ['package' => $pack]);
            $this->assertSame(403, $r['status'], 'unsigned package blocked when verified-only policy is on');
            $this->assertSame('unverified_package', $r['body']['code'] ?? null);

            // (b) present-but-invalid signature → 403 even WITH allowUnverified (workspace policy wins).
            $signed = self::$signing->sign($pack);
            $tampered = $pack;
            $tampered['packMeta']['name'] = 'Hijacked';
            $r2 = $this->callImportSigned($this->userId, [
                'package' => $tampered,
                'signature' => $signed['signature'],
                'alg' => $signed['alg'],
                'allowUnverified' => true,
            ]);
            $this->assertSame(403, $r2['status'], 'allowUnverified cannot bypass the workspace verified-only policy');
            $this->assertSame('unverified_package', $r2['body']['code'] ?? null);
        } finally {
            if ($prev === null) {
                unset($_ENV['REQUIRE_VERIFIED_PACKAGES']);
            } else {
                $_ENV['REQUIRE_VERIFIED_PACKAGES'] = $prev;
            }
        }
    }

    public function testUnsignedJsonStillImportsCommunity(): void
    {
        $r = $this->callImportSigned($this->userId, ['pack' => $this->jsonPack()]);
        $this->assertSame(201, $r['status']);
        $this->assertSame('community', $r['body']['trust'] ?? null);
        $this->assertSame([], $r['body']['warnings'] ?? []);
    }
}

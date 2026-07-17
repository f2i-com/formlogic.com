<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FormService;
use FormLogic\Services\PackService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * APP-501 vendor signing: a pack may embed per-component screen digests +
 * an Ed25519 signature (pack.signing). A DIRECT JSON import of an unmodified
 * pack from a PINNED publisher stamps custom_screen_trust 'verified'; a
 * tampered component stays 'untrusted' with 'vendor_modified' provenance; an
 * unpinned publisher changes nothing. The digest/message recipes here are an
 * INDEPENDENT reimplementation of formlogic/ui/scripts/packSigning.mjs — if
 * either side drifts from PackService, these tests fail. The fixture test
 * additionally recomputes every emitted marketplace pack (Node-signed) in
 * PHP, locking the cross-language recipe.
 */
class PackVendorSigningTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static FormService $forms;
    private static AppService $apps;
    private static PackService $packs;

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
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/formlogic-packsign-' . bin2hex(random_bytes(4)));
        self::$forms = new FormService($conn, $sqlite);
        self::$apps = new AppService($conn, self::$forms);
        self::$packs = new PackService($conn, self::$forms, self::$apps, new AppUserService($conn));
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->userId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$this->userId, $this->userId . '@test.local']);
    }

    protected function tearDown(): void
    {
        $this->pinPublisher(null);
        if (self::$pdo === null || $this->userId === '') {
            return;
        }
        // FK-safe teardown (the aokie fixture creates flows/bindings/roles).
        $appIds = self::$pdo->prepare('SELECT id FROM apps WHERE owner_id = ?');
        $appIds->execute([$this->userId]);
        foreach ($appIds->fetchAll(PDO::FETCH_COLUMN) as $aid) {
            self::$pdo->prepare('DELETE FROM flow_run_logs WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_flow_bindings WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM flow_definitions WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_forms WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?)')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$aid]);
        }
        self::$pdo->prepare('DELETE FROM apps WHERE owner_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM pack_installations WHERE user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM forms WHERE user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
    }

    // ── recipe (independent copy of packSigning.mjs — netstring-framed) ──────

    private function frame(string $s): string
    {
        return strlen($s) . ':' . $s . ',';
    }

    /** @param array<string,mixed> $screen */
    private function screenDigest(array $screen): string
    {
        $tokens = [];
        $scopes = [['', $screen]];
        if (is_array($screen['recordScreen'] ?? null)) {
            $scopes[] = ['record.', $screen['recordScreen']];
        }
        foreach ($scopes as [$prefix, $scope]) {
            foreach (['kind', 'entry', 'html', 'css', 'js', 'ts'] as $k) {
                if (is_string($scope[$k] ?? null)) {
                    $tokens[] = $prefix . $k;
                    $tokens[] = $scope[$k];
                }
            }
            $files = $scope['files'] ?? null;
            if (is_array($files) && array_is_list($files)) {
                foreach ($files as $f) {
                    if (is_array($f) && is_string($f['path'] ?? null) && is_string($f['content'] ?? null)) {
                        $tokens[] = $prefix . 'file';
                        $tokens[] = $f['path'];
                        $tokens[] = $f['content'];
                    }
                }
            }
        }
        return hash('sha256', implode('', array_map(fn ($t) => $this->frame($t), $tokens)));
    }

    /** @param array<string,string> $components */
    private function signingMessage(string $packId, string $version, array $components): string
    {
        $tokens = ['formlogic-pack-vendor/1', $packId, $version];
        $keys = array_keys($components);
        sort($keys, SORT_STRING);
        foreach ($keys as $k) {
            $tokens[] = (string) $k;
            $tokens[] = (string) $components[$k];
        }
        return implode('', array_map(fn ($t) => $this->frame($t), $tokens));
    }

    /** Attach a signing block over the pack's CURRENT screens. Returns [pack, publicKeyB64]. */
    private function signPack(array $pack): array
    {
        $pair = sodium_crypto_sign_keypair();
        $secret = sodium_crypto_sign_secretkey($pair);
        $public = sodium_crypto_sign_publickey($pair);
        $components = [];
        foreach ($pack['forms'] as $f) {
            if (!empty($f['customScreen'])) {
                $components['form:' . $f['packFormId']] = $this->screenDigest($f['customScreen']);
            }
        }
        foreach ($pack['apps'] ?? [] as $a) {
            if (!empty($a['customScreen'])) {
                $components['app:' . $a['packAppId']] = $this->screenDigest($a['customScreen']);
            }
        }
        $message = $this->signingMessage($pack['packMeta']['id'], $pack['packMeta']['version'], $components);
        $pack['signing'] = [
            'format' => 'formlogic-pack-vendor/1',
            'alg' => 'ed25519',
            'keyId' => 'test-vendor',
            'publisherKeyB64' => base64_encode($public),
            'components' => $components,
            'signature' => base64_encode(sodium_crypto_sign_detached($message, $secret)),
        ];
        return [$pack, base64_encode($public)];
    }

    private function pinPublisher(?string $publicKeyB64): void
    {
        if ($publicKeyB64 === null) {
            unset($_ENV['FORMLOGIC_TRUSTED_PACK_PUBLISHERS']);
            putenv('FORMLOGIC_TRUSTED_PACK_PUBLISHERS');
            return;
        }
        $_ENV['FORMLOGIC_TRUSTED_PACK_PUBLISHERS'] = $publicKeyB64;
        putenv('FORMLOGIC_TRUSTED_PACK_PUBLISHERS=' . $publicKeyB64);
    }

    private function screenPack(): array
    {
        return [
            'formatVersion' => 1,
            'packMeta' => ['id' => 'sign-' . bin2hex(random_bytes(6)), 'name' => 'Signed Pack', 'version' => '1.0.0'],
            'forms' => [[
                'packFormId' => 'main',
                'title' => 'Main',
                'fields' => [],
                'customScreen' => [
                    'enabled' => true,
                    'kind' => 'code',
                    'html' => '<div id="app"></div>',
                    'css' => '#app{color:red}',
                    'js' => 'FormLogic.records({limit:5});',
                    'recordScreen' => ['kind' => 'code', 'html' => '<b>rec</b>', 'css' => '', 'js' => 'FormLogic.related();'],
                ],
            ]],
        ];
    }

    private function screenPackWithApp(): array
    {
        $pack = $this->screenPack();
        $pack['apps'] = [[
            'packAppId' => 'app-main',
            'name' => 'Main App',
            'customScreen' => ['enabled' => true, 'kind' => 'code', 'html' => '<h1>Home</h1>', 'css' => '', 'js' => 'ok()'],
            'forms' => [['packFormId' => 'main', 'sortOrder' => 0]],
        ]];
        return $pack;
    }

    /** @return array{0:string,1:array<string,mixed>} trust + provenance of the imported form */
    private function importAndReadTrust(array $pack): array
    {
        $result = self::$packs->importPack($pack, $this->userId);
        $formId = $result['forms'][0]['id'];
        $stmt = self::$pdo->prepare('SELECT custom_screen_trust, custom_screen_provenance FROM forms WHERE id = ?');
        $stmt->execute([$formId]);
        $row = $stmt->fetch();
        return [(string) $row['custom_screen_trust'], json_decode((string) ($row['custom_screen_provenance'] ?? 'null'), true) ?? []];
    }

    // ── tests ────────────────────────────────────────────────────────────────

    public function testDirectImportOfVendorSignedPackStampsVerified(): void
    {
        [$pack, $publicB64] = $this->signPack($this->screenPack());
        $this->pinPublisher($publicB64);
        [$trust, $prov] = $this->importAndReadTrust($pack);
        $this->assertSame('verified', $trust);
        $this->assertSame('vendor-signed', $prov['source'] ?? null);
        $this->assertSame('form:main', $prov['component'] ?? null);
        $this->assertSame($publicB64, $prov['publisher'] ?? null);
    }

    public function testTamperedComponentStaysUntrustedWithVendorModifiedProvenance(): void
    {
        [$pack, $publicB64] = $this->signPack($this->screenPack());
        $this->pinPublisher($publicB64);
        // Post-signature edit of the executable payload — vendor trust lost.
        $pack['forms'][0]['customScreen']['js'] = 'FormLogic.records({limit:5});fetchEvil();';
        [$trust, $prov] = $this->importAndReadTrust($pack);
        $this->assertSame('untrusted', $trust);
        $this->assertSame('vendor_modified', $prov['verdict'] ?? null);
    }

    public function testUnpinnedPublisherChangesNothing(): void
    {
        // Valid self-signature, but the key is not in the trusted set —
        // behaves exactly like an unsigned direct import.
        [$pack] = $this->signPack($this->screenPack());
        [$trust, $prov] = $this->importAndReadTrust($pack);
        $this->assertSame('untrusted', $trust);
        $this->assertSame('direct-import', $prov['source'] ?? null);
    }

    public function testDuplicatePackAppIdIsRejected(): void
    {
        // A duplicate packAppId is a trust-confusion vector (component signing
        // keys on packAppId) and is rejected before any row is written.
        [$pack, $publicB64] = $this->signPack($this->screenPackWithApp());
        $this->pinPublisher($publicB64);
        $evil = $pack['apps'][0];
        $evil['name'] = 'Evil';
        $evil['customScreen'] = ['enabled' => true, 'kind' => 'code', 'html' => '<x>', 'css' => '', 'js' => 'steal()'];
        // Malicious duplicate first, the genuine (digest-matching) app last.
        $pack['apps'] = [$evil, $pack['apps'][0]];
        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessageMatches('/Duplicate packAppId/');
        self::$packs->importPack($pack, $this->userId);
    }

    public function testTamperedComponentNeverInheritsASiblingsVerifiedDigest(): void
    {
        // Defense in depth: even if a duplicate id slipped through, each
        // component is judged by its OWN bytes — a tampered form component
        // gets no 'verified' from a sibling's matching digest. Here two
        // DISTINCT forms exist; only the untouched one may reach 'verified'.
        $pack = $this->screenPack();
        $pack['forms'][] = [
            'packFormId' => 'second',
            'title' => 'Second',
            'fields' => [],
            'customScreen' => ['enabled' => true, 'kind' => 'code', 'html' => '<b>two</b>', 'css' => '', 'js' => 'two()'],
        ];
        [$pack, $publicB64] = $this->signPack($pack);
        $this->pinPublisher($publicB64);
        // Tamper the FIRST form's code AFTER signing; the second stays intact.
        $pack['forms'][0]['customScreen']['js'] = 'FormLogic.records({limit:5});evil()';
        $result = self::$packs->importPack($pack, $this->userId);
        $byTitle = [];
        foreach ($result['forms'] as $f) {
            $stmt = self::$pdo->prepare('SELECT custom_screen_trust FROM forms WHERE id = ?');
            $stmt->execute([$f['id']]);
            $byTitle[$f['title']] = (string) $stmt->fetch()['custom_screen_trust'];
        }
        $this->assertSame('untrusted', $byTitle['Main']); // tampered
        $this->assertSame('verified', $byTitle['Second']); // intact
    }

    public function testSignedPackageVerdictIsNeverOverriddenByEmbeddedSigning(): void
    {
        // importPack with an explicit verifiedScreenTrust (the signed-archive
        // path) ignores the embedded block entirely — even a tampered one.
        [$pack, $publicB64] = $this->signPack($this->screenPack());
        $this->pinPublisher($publicB64);
        $pack['forms'][0]['customScreen']['js'] = 'tampered();';
        $result = self::$packs->importPack($pack, $this->userId, null, null, 'verified');
        $stmt = self::$pdo->prepare('SELECT custom_screen_trust FROM forms WHERE id = ?');
        $stmt->execute([$result['forms'][0]['id']]);
        $this->assertSame('verified', (string) $stmt->fetch()['custom_screen_trust']);
    }

    public function testEmittedMarketplacePacksVerifyCrossLanguage(): void
    {
        // The emitted fixtures were digested + signed by NODE
        // (ui/scripts/packSigning.mjs); recomputing them here locks the two
        // recipes together — any canonicalization drift fails this test.
        $dir = dirname(__DIR__, 2) . '/resources/marketplace-packs';
        $signedPacks = 0;
        foreach (glob($dir . '/*.json') ?: [] as $file) {
            $record = json_decode((string) file_get_contents($file), true);
            $pack = $record['pack'] ?? null;
            $signing = is_array($pack) ? ($pack['signing'] ?? null) : null;
            if (!is_array($signing)) {
                continue;
            }
            $signedPacks++;
            $components = $signing['components'];
            $recomputed = [];
            foreach ($pack['forms'] as $f) {
                if (!empty($f['customScreen'])) {
                    $recomputed['form:' . $f['packFormId']] = $this->screenDigest($f['customScreen']);
                }
            }
            foreach ($pack['apps'] ?? [] as $a) {
                if (!empty($a['customScreen'])) {
                    $recomputed['app:' . $a['packAppId']] = $this->screenDigest($a['customScreen']);
                }
            }
            ksort($components);
            ksort($recomputed);
            $this->assertSame($components, $recomputed, basename($file) . ': component digests must match the Node recipe');
            $message = $this->signingMessage(
                (string) $pack['packMeta']['id'],
                (string) $pack['packMeta']['version'],
                $signing['components']
            );
            $this->assertTrue(
                sodium_crypto_sign_verify_detached(
                    (string) base64_decode((string) $signing['signature'], true),
                    $message,
                    (string) base64_decode((string) $signing['publisherKeyB64'], true)
                ),
                basename($file) . ': signature must verify'
            );
            // The publisher key MUST be one PackService actually pins, else the
            // whole fixture set is inert (imports stay untrusted) — a rotation
            // that forgets the pinned constant would otherwise ship green.
            $this->assertTrue(
                $this->isPinnedPublisher((string) $signing['publisherKeyB64']),
                basename($file) . ': publisherKeyB64 must be a pinned production key'
            );
        }
        $this->assertGreaterThan(0, $signedPacks, 'expected at least one vendor-signed marketplace pack');
    }

    public function testRealEmittedFixtureImportsAsVerifiedWithoutEnvOverride(): void
    {
        // Drive the ACTUAL pinned production key end-to-end: a real emitted
        // fixture (no FORMLOGIC_TRUSTED_PACK_PUBLISHERS override) must import
        // its code screen as 'verified'. Guards the pinned constant itself.
        $this->pinPublisher(null);
        $file = dirname(__DIR__, 2) . '/resources/marketplace-packs/aokie-receptionist.json';
        if (!is_file($file)) {
            $this->markTestSkipped('aokie fixture not emitted');
        }
        $pack = json_decode((string) file_get_contents($file), true)['pack'];
        $result = self::$packs->importPack($pack, $this->userId);
        // The Calls form carries the pack-owned transcript code recordScreen.
        $verifiedCode = 0;
        foreach ($result['forms'] as $f) {
            $stmt = self::$pdo->prepare('SELECT custom_screen_trust FROM forms WHERE id = ?');
            $stmt->execute([$f['id']]);
            if ((string) $stmt->fetch()['custom_screen_trust'] === 'verified') {
                $verifiedCode++;
            }
        }
        $this->assertGreaterThan(0, $verifiedCode, 'a real signed fixture must stamp at least one screen verified');
    }

    /** Reflect PackService::TRUSTED_PACK_PUBLISHER_KEYS so a rotation there is caught here. */
    private function isPinnedPublisher(string $publicKeyB64): bool
    {
        $ref = new \ReflectionClass(PackService::class);
        $pinned = $ref->getConstant('TRUSTED_PACK_PUBLISHER_KEYS');
        return is_array($pinned) && in_array($publicKeyB64, $pinned, true);
    }
}

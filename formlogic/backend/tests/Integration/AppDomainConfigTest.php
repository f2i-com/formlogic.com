<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\AppDomainService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Custom-domain config hardening #7/#8 (DB round-trip):
 *  - updateDomain() sanitizes landing/native config on write — a javascript: link and a malformed
 *    fingerprint are DROPPED, an over-long headline is capped, a valid config round-trips intact.
 *  - resolveLaunchConfig() surfaces a PUBLIC-safe native section (install/handoff metadata only) and
 *    NEVER leaks security_config (which stays on the owner-scoped admin path).
 *
 * Uses the dev-override verify path so no real DNS / TLS is needed. Skipped without a test DB.
 */
class AppDomainConfigTest extends TestCase
{
    private static ?MySQLConnection $conn = null;
    private static ?PDO $pdo = null;
    private static AppDomainService $svc;

    private string $ownerId = '';
    private string $appId = '';
    /** @var string[] */ private array $domainIds = [];

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
        self::$conn = $conn;
        self::$pdo = $conn->getConnection();
        self::$svc = new AppDomainService($conn);
    }

    protected function setUp(): void
    {
        if (self::$conn === null) {
            $this->markTestSkipped('No test database');
        }
        $this->ownerId = 'u' . bin2hex(random_bytes(8));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan) VALUES (?, ?, 'x', 'T', 'personal')")
            ->execute([$this->ownerId, $this->ownerId . '@test.local']);
        $this->appId = 'app' . bin2hex(random_bytes(8));
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status, settings) VALUES (?, ?, 'T', ?, 'published', '{}')")
            ->execute([$this->appId, $this->ownerId, 'cfg' . bin2hex(random_bytes(6))]);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        foreach ($this->domainIds as $id) {
            self::$pdo->prepare('DELETE FROM app_domains WHERE id = ?')->execute([$id]);
        }
        if ($this->appId !== '') {
            self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$this->appId]);
        }
        if ($this->ownerId !== '') {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->ownerId]);
        }
    }

    private function makeDomain(): array
    {
        $host = 'd' . bin2hex(random_bytes(6)) . '.example-app.com';
        $created = self::$svc->createDomain($this->appId, $this->ownerId, $host);
        $this->domainIds[] = $created['id'];
        return $created;
    }

    public function testUpdateDomainSanitizesLandingAndNativeConfig(): void
    {
        $d = $this->makeDomain();
        $goodFp = str_repeat('AB:', 31) . 'CD';

        $updated = self::$svc->updateDomain($d['id'], $this->ownerId, [
            'landingConfig' => [
                'headline' => str_repeat('h', 400),         // over-long → capped to 120
                'privacyUrl' => 'javascript:alert(1)',        // hostile scheme → dropped
                'termsUrl' => 'https://acme.com/terms',       // valid → kept
                'showOpenWebApp' => 'true',                   // normalized to bool
            ],
            'nativeConfig' => [
                'packageName' => 'com.acme.app',              // valid
                'sha256CertFingerprints' => [$goodFp, 'garbage'], // bad one dropped
                'installUrl' => 'javascript:alert(1)',        // hostile scheme → dropped
                'requireNativeRuntime' => 1,                  // normalized to bool
            ],
        ]);

        $this->assertNotNull($updated);
        $landing = $updated['landingConfig'];
        $this->assertSame(120, mb_strlen($landing['headline']));
        $this->assertArrayNotHasKey('privacyUrl', $landing);
        $this->assertSame('https://acme.com/terms', $landing['termsUrl']);
        $this->assertTrue($landing['showOpenWebApp']);

        $native = $updated['nativeConfig'];
        $this->assertSame('com.acme.app', $native['packageName']);
        $this->assertSame([$goodFp], $native['sha256CertFingerprints']);
        $this->assertArrayNotHasKey('installUrl', $native);
        $this->assertTrue($native['requireNativeRuntime']);

        // Re-fetch confirms it PERSISTED sanitized (not just returned from memory).
        $reloaded = self::$svc->getDomain($d['id'], $this->ownerId);
        $this->assertArrayNotHasKey('privacyUrl', $reloaded['landingConfig']);
        $this->assertArrayNotHasKey('installUrl', $reloaded['nativeConfig']);
    }

    public function testUpdateDomainRoundTripsAValidConfig(): void
    {
        $d = $this->makeDomain();
        $fp = str_repeat('12:', 31) . 'FF';
        $landingIn = [
            'headline' => 'MineCab',
            'subheadline' => 'Dispatch, simplified',
            'logoUrl' => 'https://cdn.acme.com/logo.png',
            'supportEmail' => 'help@acme.com',
        ];
        $nativeIn = [
            'packageName' => 'com.acme.minecab',
            'sha256CertFingerprints' => [$fp],
            'minRuntimeVersion' => '0.1.0',
            'installUrl' => 'https://play.google.com/store/apps/details?id=com.acme.minecab',
            'showNativeCta' => true,
        ];

        $updated = self::$svc->updateDomain($d['id'], $this->ownerId, [
            'landingConfig' => $landingIn,
            'nativeConfig' => $nativeIn,
        ]);

        $this->assertSame('MineCab', $updated['landingConfig']['headline']);
        $this->assertSame('https://cdn.acme.com/logo.png', $updated['landingConfig']['logoUrl']);
        $this->assertSame('help@acme.com', $updated['landingConfig']['supportEmail']);
        $this->assertSame('com.acme.minecab', $updated['nativeConfig']['packageName']);
        $this->assertSame([$fp], $updated['nativeConfig']['sha256CertFingerprints']);
        $this->assertSame('0.1.0', $updated['nativeConfig']['minRuntimeVersion']);
        $this->assertTrue($updated['nativeConfig']['showNativeCta']);
    }

    public function testResolveLaunchConfigExposesPublicNativeAndNeverSecurityConfig(): void
    {
        $d = $this->makeDomain();
        $secret = 'TOPSECRET-' . bin2hex(random_bytes(6));

        self::$svc->updateDomain($d['id'], $this->ownerId, [
            'nativeConfig' => [
                'packageName' => 'com.acme.app',
                'sha256CertFingerprints' => [str_repeat('AB:', 31) . 'CD'],
                'installUrl' => 'https://play.google.com/store/apps/details?id=com.acme.app',
                'requireNativeRuntime' => true,
                'showNativeCta' => true,
            ],
            // securityConfig is INTERNAL/RESERVED — updateDomain must DROP this write silently (#5).
            'securityConfig' => ['secret' => $secret, 'signingKey' => $secret],
        ]);

        // The reserved key was never persisted: the admin shape shows an empty securityConfig.
        $afterWrite = self::$svc->getDomain($d['id'], $this->ownerId);
        $this->assertSame([], $afterWrite['securityConfig'], 'updateDomain must silently drop securityConfig writes');

        // Simulate a LEGACY row that already carries security material (written before the write path
        // was closed) — the public resolver must still never surface it.
        self::$pdo->prepare('UPDATE app_domains SET security_config = ? WHERE id = ?')
            ->execute([json_encode(['secret' => $secret, 'signingKey' => $secret]), $d['id']]);

        // Activate the domain (dev-override) so the public resolver returns it.
        self::$svc->verifyDomain($d['id'], $this->ownerId, true);

        $launch = self::$svc->resolveLaunchConfig($d['normalizedDomain']);
        $this->assertNotNull($launch, 'active published domain should resolve');

        // Public native section is present with exactly the whitelisted keys.
        $this->assertArrayHasKey('native', $launch);
        $native = $launch['native'];
        $this->assertTrue($native['enabled']);
        $this->assertSame('com.acme.app', $native['packageName']);
        $this->assertSame('https://play.google.com/store/apps/details?id=com.acme.app', $native['installUrl']);
        $this->assertTrue($native['requireNativeRuntime']);
        $this->assertTrue($native['showNativeCta']);
        // Fingerprints + security material never appear in the public payload.
        $this->assertArrayNotHasKey('sha256CertFingerprints', $native);
        $this->assertArrayNotHasKey('security', $launch);
        $this->assertArrayNotHasKey('securityConfig', $launch);
        $this->assertStringNotContainsString($secret, json_encode($launch) ?: '', 'security secret must not leak publicly');

        // …but the owner-scoped admin path still returns the legacy-stored value (read stays open; only
        // the owner-facing WRITE path is closed until a real consumer exists).
        $admin = self::$svc->getDomain($d['id'], $this->ownerId);
        $this->assertSame($secret, $admin['securityConfig']['secret']);
    }

    public function testUpdateDomainWhitelistsPwaConfig(): void
    {
        $d = $this->makeDomain();

        $updated = self::$svc->updateDomain($d['id'], $this->ownerId, [
            'pwaConfig' => [
                'themeColor' => '#6366f1',              // valid hex → kept
                'backgroundColor' => 'red',              // named color → dropped (hex only)
                'display' => 'standalone',               // valid enum → kept
                'orientation' => 'diagonal',             // not in enum → dropped
                'startUrl' => 'https://evil.example/x',  // unknown key → stripped
                'serviceWorker' => '/sw.js',             // unknown key → stripped
            ],
        ]);

        $this->assertNotNull($updated);
        // Key order is a sanitizer implementation detail — compare canonically.
        $this->assertEqualsCanonicalizing(
            ['themeColor' => '#6366f1', 'display' => 'standalone'],
            $updated['pwaConfig']
        );

        // Re-fetch confirms the WHITELISTED shape persisted (not just returned from memory).
        $reloaded = self::$svc->getDomain($d['id'], $this->ownerId);
        $this->assertEqualsCanonicalizing(['themeColor' => '#6366f1', 'display' => 'standalone'], $reloaded['pwaConfig']);
    }
}

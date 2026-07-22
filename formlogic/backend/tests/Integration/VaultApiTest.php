<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\VaultController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Services\VaultService;
use FormLogic\Tests\Support\E2eePrivateFormsSupport;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response as SlimResponse;

/**
 * E2EE vault API (docs/E2EE_PRIVATE_FORMS_PLAN.md §16-P2): create-only PUT with
 * strict canonical-base64 + length + KDF-minimum validation, 404/409 typed codes,
 * the version-CAS passphrase change (touches passphrase-side fields ONLY), and
 * the demo/acting-as refusals. Skipped without a test database.
 */
class VaultApiTest extends TestCase
{
    use E2eePrivateFormsSupport;

    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static VaultService $service;
    private static VaultController $controller;

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
        self::$service = new VaultService($conn);
        self::$controller = new VaultController(self::$service);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
    }

    // ── helpers ──

    private function request(string $method, ?array $body = null, ?string $userId = null, ?object $user = null, ?string $actorId = null): ServerRequestInterface
    {
        $req = (new ServerRequestFactory())->createServerRequest($method, '/api/vault');
        if ($body !== null) {
            $req = $req->withParsedBody($body);
        }
        if ($userId !== null) {
            $req = $req->withAttribute('userId', $userId);
        }
        $req = $req->withAttribute('user', $user ?? (object) ['email' => 'someone@test.local']);
        if ($actorId !== null) {
            $req = $req->withAttribute('adminActorId', $actorId);
        }
        return $req;
    }

    private function decode(ResponseInterface $resp): array
    {
        $resp->getBody()->rewind();
        return json_decode((string) $resp->getBody(), true) ?: [];
    }

    // ── GET / PUT round trip ──

    public function testGetWithoutVaultIs404Typed(): void
    {
        $userId = $this->insertUser(self::$pdo);
        $resp = self::$controller->getVault($this->request('GET', null, $userId), new SlimResponse());
        $this->assertSame(404, $resp->getStatusCode());
        $this->assertSame('vault_not_found', $this->decode($resp)['code'] ?? null);
    }

    public function testCreateRoundTripsAndSecondCreateConflicts(): void
    {
        $userId = $this->insertUser(self::$pdo);
        $keys = $this->makeKeys();
        $body = $this->vaultBody($keys);

        $resp = self::$controller->createVault($this->request('PUT', $body, $userId), new SlimResponse());
        $this->assertSame(200, $resp->getStatusCode(), (string) json_encode($this->decode($resp)));
        $vault = $this->decode($resp)['data']['vault'];
        $this->assertSame(1, $vault['version']);
        $this->assertSame('argon2id13.1', $vault['kdf']);
        // Byte fields round-trip as the exact canonical base64 that was sent.
        foreach (['kdfSalt', 'wrappedUmk', 'wrappedUmkRecovery', 'encKeyBundle', 'x25519Pk', 'ed25519Pk'] as $field) {
            $this->assertSame($body[$field], $vault[$field], $field);
        }
        $this->assertSame(3, $vault['kdfOpslimit']);
        $this->assertSame(67_108_864, $vault['kdfMemlimit']);

        // Raw storage is BYTES (VARBINARY), not base64 text.
        $stmt = self::$pdo->prepare('SELECT kdf_salt, wrapped_umk FROM user_vaults WHERE user_id = ?');
        $stmt->execute([$userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        $this->assertSame(16, strlen((string) $row['kdf_salt']));
        $this->assertSame(72, strlen((string) $row['wrapped_umk']));

        // Create-only: a second PUT is a typed conflict.
        $again = self::$controller->createVault($this->request('PUT', $this->vaultBody($this->makeKeys()), $userId), new SlimResponse());
        $this->assertSame(409, $again->getStatusCode());
        $this->assertSame('vault_exists', $this->decode($again)['code'] ?? null);

        // GET serves the stored vault.
        $get = self::$controller->getVault($this->request('GET', null, $userId), new SlimResponse());
        $this->assertSame(200, $get->getStatusCode());
        $this->assertSame($body['wrappedUmk'], $this->decode($get)['data']['vault']['wrappedUmk']);
    }

    public function testCreateValidationRejectsEveryMalformedField(): void
    {
        $userId = $this->insertUser(self::$pdo);
        $keys = $this->makeKeys();
        $good = $this->vaultBody($keys);

        $bad = [
            'wrong kdf' => array_merge($good, ['kdf' => 'argon2id13.0']),
            'short salt' => array_merge($good, ['kdfSalt' => base64_encode(random_bytes(15))]),
            'non-canonical base64 salt' => array_merge($good, ['kdfSalt' => rtrim(base64_encode(random_bytes(16)), '=')]),
            'opslimit below minimum' => array_merge($good, ['kdfOpslimit' => 2]),
            'memlimit below minimum' => array_merge($good, ['kdfMemlimit' => 67_108_863]),
            'wrappedUmk wrong length' => array_merge($good, ['wrappedUmk' => base64_encode(random_bytes(71))]),
            'missing recovery (mandatory)' => array_diff_key($good, ['wrappedUmkRecovery' => true]),
            'recovery wrong length' => array_merge($good, ['wrappedUmkRecovery' => base64_encode(random_bytes(40))]),
            'bundle too small' => array_merge($good, ['encKeyBundle' => base64_encode(random_bytes(99))]),
            'bundle too large' => array_merge($good, ['encKeyBundle' => base64_encode(random_bytes(513))]),
            'x25519 wrong length' => array_merge($good, ['x25519Pk' => base64_encode(random_bytes(31))]),
            'ed25519 wrong length' => array_merge($good, ['ed25519Pk' => base64_encode(random_bytes(33))]),
            'opslimit not an int' => array_merge($good, ['kdfOpslimit' => '3']),
        ];
        foreach ($bad as $label => $body) {
            $resp = self::$controller->createVault($this->request('PUT', $body, $userId), new SlimResponse());
            $this->assertSame(400, $resp->getStatusCode(), $label);
            $this->assertSame('vault_invalid', $this->decode($resp)['code'] ?? null, $label);
        }

        // Nothing was stored by any of the rejected attempts.
        $get = self::$controller->getVault($this->request('GET', null, $userId), new SlimResponse());
        $this->assertSame(404, $get->getStatusCode());
    }

    // ── Passphrase change (version CAS) ──

    public function testChangePassphraseCasTouchesPassphraseSideOnly(): void
    {
        $userId = $this->insertUser(self::$pdo);
        $keys = $this->makeKeys();
        $original = $this->vaultBody($keys);
        self::$controller->createVault($this->request('PUT', $original, $userId), new SlimResponse());

        $change = [
            'expectedVersion' => 1,
            'kdfSalt' => base64_encode(random_bytes(16)),
            'kdfOpslimit' => 4,
            'kdfMemlimit' => 134_217_728,
            'wrappedUmk' => base64_encode(random_bytes(72)),
        ];
        $resp = self::$controller->changePassphrase($this->request('POST', $change, $userId), new SlimResponse());
        $this->assertSame(200, $resp->getStatusCode());
        $vault = $this->decode($resp)['data']['vault'];
        $this->assertSame(2, $vault['version']);
        $this->assertSame($change['kdfSalt'], $vault['kdfSalt']);
        $this->assertSame($change['wrappedUmk'], $vault['wrappedUmk']);
        // The passphrase change rewraps ONLY — recovery wrap, bundle and keys untouched.
        $this->assertSame($original['wrappedUmkRecovery'], $vault['wrappedUmkRecovery']);
        $this->assertSame($original['encKeyBundle'], $vault['encKeyBundle']);
        $this->assertSame($original['x25519Pk'], $vault['x25519Pk']);
        $this->assertSame($original['ed25519Pk'], $vault['ed25519Pk']);

        // Stale expectedVersion (a concurrent tab) → typed 409 with the current version.
        $stale = self::$controller->changePassphrase($this->request('POST', $change, $userId), new SlimResponse());
        $this->assertSame(409, $stale->getStatusCode());
        $decoded = $this->decode($stale);
        $this->assertSame('vault_version_conflict', $decoded['code'] ?? null);
        $this->assertSame(2, $decoded['details']['currentVersion'] ?? null);
    }

    public function testChangePassphraseWithoutVaultIs404(): void
    {
        $userId = $this->insertUser(self::$pdo);
        $change = [
            'expectedVersion' => 1,
            'kdfSalt' => base64_encode(random_bytes(16)),
            'kdfOpslimit' => 3,
            'kdfMemlimit' => 67_108_864,
            'wrappedUmk' => base64_encode(random_bytes(72)),
        ];
        $resp = self::$controller->changePassphrase($this->request('POST', $change, $userId), new SlimResponse());
        $this->assertSame(404, $resp->getStatusCode());
        $this->assertSame('vault_not_found', $this->decode($resp)['code'] ?? null);
    }

    // ── Demo + acting-as refusals ──

    public function testDemoAccountRefusedOnEveryVaultVerb(): void
    {
        $userId = $this->insertUser(self::$pdo);
        $demo = (object) ['email' => $_ENV['DEMO_EMAIL'] ?? 'demo@formlogic.local'];
        foreach ([
            self::$controller->getVault($this->request('GET', null, $userId, $demo), new SlimResponse()),
            self::$controller->createVault($this->request('PUT', $this->vaultBody($this->makeKeys()), $userId, $demo), new SlimResponse()),
            self::$controller->changePassphrase($this->request('POST', ['expectedVersion' => 1], $userId, $demo), new SlimResponse()),
        ] as $resp) {
            $this->assertSame(403, $resp->getStatusCode());
            $this->assertSame('demo_readonly', $this->decode($resp)['code'] ?? null);
        }
    }

    public function testActingAsRefusedOnEveryVaultVerb(): void
    {
        $userId = $this->insertUser(self::$pdo);
        foreach ([
            self::$controller->getVault($this->request('GET', null, $userId, null, 'admin-1'), new SlimResponse()),
            self::$controller->createVault($this->request('PUT', $this->vaultBody($this->makeKeys()), $userId, null, 'admin-1'), new SlimResponse()),
            self::$controller->changePassphrase($this->request('POST', ['expectedVersion' => 1], $userId, null, 'admin-1'), new SlimResponse()),
        ] as $resp) {
            $this->assertSame(403, $resp->getStatusCode());
            $this->assertSame('acting_as_denied', $this->decode($resp)['code'] ?? null);
        }
    }
}

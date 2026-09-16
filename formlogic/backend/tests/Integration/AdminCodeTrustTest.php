<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\AdminController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Services\AdminService;
use FormLogic\Services\AuditService;
use FormLogic\Services\AuthService;
use FormLogic\Services\MaintenanceService;
use FormLogic\Services\MfaService;
use FormLogic\Services\RuntimeEngineService;
use FormLogic\Services\TotpService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * Code trust: the one flag that lets an account's apps run without the ZIPP VM around them.
 *
 * What is pinned here: the shared demo can never hold it; an account without two-factor auth can
 * never be given it; revoking clears the account's stored host-js choices so a later
 * re-verification cannot silently switch host JavaScript back on; switching two-factor auth off
 * revokes it wherever that happens; the acting admin's password step-up is required; and the
 * change never commits without its audit row.
 */
class AdminCodeTrustTest extends TestCase
{
    public const AUDIT_KEY = 'code-trust-test-audit-key';

    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static AdminService $admin;
    private static AuthService $auth;
    private static string $tmpRoot = '';

    private string $adminId = '';
    private string $ownerId = '';
    private string $appId = '';
    private string $otherAppId = '';

    public static function setUpBeforeClass(): void
    {
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) {
            \Dotenv\Dotenv::createImmutable($root)->safeLoad();
        }
        try {
            $conn = new MySQLConnection([
                'host' => $_ENV['DB_HOST'] ?? '127.0.0.1',
                'port' => $_ENV['DB_PORT'] ?? '3306',
                'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
                'username' => $_ENV['DB_USERNAME'] ?? 'root',
                'password' => $_ENV['DB_PASSWORD'] ?? '',
                'charset' => 'utf8mb4',
                'collation' => 'utf8mb4_unicode_ci',
            ]);
            $conn->getConnection()->query('SELECT 1');
            $conn->initializeSchema();
            $conn->runMigrations();
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
        self::$mysql = $conn;
        self::$pdo = $conn->getConnection();
        self::$admin = new AdminService($conn);
        self::$auth = new AuthService($conn, ['secret' => 'code-trust-test-secret-0123456789abcdef', 'algorithm' => 'HS256']);
        self::$tmpRoot = sys_get_temp_dir() . '/fl-code-trust-' . bin2hex(random_bytes(6));
        mkdir(self::$tmpRoot, 0700, true);
    }

    public static function tearDownAfterClass(): void
    {
        foreach (glob(self::$tmpRoot . '/*') ?: [] as $file) {
            unlink($file);
        }
        if (self::$tmpRoot !== '' && is_dir(self::$tmpRoot)) {
            rmdir(self::$tmpRoot);
        }
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->adminId = 'u-' . bin2hex(random_bytes(12));
        $this->ownerId = 'u-' . bin2hex(random_bytes(12));
        $ins = self::$pdo->prepare('INSERT INTO users (id, email, password_hash, is_admin, mfa_enabled) VALUES (?, ?, ?, ?, ?)');
        $ins->execute([$this->adminId, $this->adminId . '@test.local', password_hash('admin-pass-123', PASSWORD_DEFAULT), 1, 1]);
        $ins->execute([$this->ownerId, $this->ownerId . '@test.local', password_hash('owner-pass-123', PASSWORD_DEFAULT), 0, 1]);
        $this->appId = 'a-' . bin2hex(random_bytes(12));
        $this->otherAppId = 'a-' . bin2hex(random_bytes(12));
        $apps = self::$pdo->prepare('INSERT INTO apps (id, owner_id, name, slug, client_engine) VALUES (?, ?, ?, ?, ?)');
        $apps->execute([$this->appId, $this->ownerId, 'Host JS app', 'host-js-' . bin2hex(random_bytes(6)), 'host-js']);
        $apps->execute([$this->otherAppId, $this->ownerId, 'ZIPP app', 'zipp-' . bin2hex(random_bytes(6)), 'zipp-web']);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        self::$pdo->prepare('DELETE FROM system_meta WHERE meta_key = ?')->execute([RuntimeEngineService::POLICY_KEY]);
        foreach ([$this->appId, $this->otherAppId] as $appId) {
            self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$appId]);
        }
        foreach ([$this->adminId, $this->ownerId] as $uid) {
            self::$pdo->prepare('DELETE FROM audit_log WHERE user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM apps WHERE owner_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
        }
    }

    private function audit(): AuditService
    {
        return new AuditService(self::$mysql, null, self::AUDIT_KEY);
    }

    private function verify(string $userId): void
    {
        self::$pdo->prepare('UPDATE users SET code_trust_verified_at = NOW(), code_trust_verified_by = ? WHERE id = ?')
            ->execute([$this->adminId, $userId]);
    }

    private function clientEngine(string $appId): ?string
    {
        $stmt = self::$pdo->prepare('SELECT client_engine FROM apps WHERE id = ?');
        $stmt->execute([$appId]);
        $value = $stmt->fetchColumn();
        return is_string($value) ? $value : null;
    }

    /** @return array<array{action: string, user_id: ?string, details: ?string}> */
    private function auditRows(string $subjectId): array
    {
        $stmt = self::$pdo->prepare('SELECT action, user_id, details FROM audit_log WHERE resource_id = ? ORDER BY sequence_number ASC');
        $stmt->execute([$subjectId]);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    // ── the service guards ───────────────────────────────────────────────────

    public function testAnAccountWithoutTwoFactorAuthCannotBeVerified(): void
    {
        self::$pdo->prepare('UPDATE users SET mfa_enabled = 0 WHERE id = ?')->execute([$this->ownerId]);
        $this->expectExceptionMessageMatches('/two-factor authentication enabled/');
        self::$admin->setCodeTrust($this->ownerId, true, $this->adminId, $this->audit());
    }

    public function testTheSharedDemoAccountCanNeverBeVerified(): void
    {
        $demoId = 'u-' . bin2hex(random_bytes(12));
        $demoEmail = $_ENV['DEMO_EMAIL'] ?? 'demo@formlogic.local';
        self::$pdo->prepare('DELETE FROM users WHERE email = ?')->execute([$demoEmail]);
        self::$pdo->prepare('INSERT INTO users (id, email, password_hash, mfa_enabled) VALUES (?, ?, ?, 1)')
            ->execute([$demoId, $demoEmail, 'x']);
        try {
            self::$admin->setCodeTrust($demoId, true, $this->adminId, $this->audit());
            $this->fail('the demo account was verified');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('demo account', $e->getMessage());
        } finally {
            self::$pdo->prepare('DELETE FROM audit_log WHERE resource_id = ?')->execute([$demoId]);
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$demoId]);
        }
    }

    public function testVerifyingRecordsWhoDidItAndWhen(): void
    {
        $result = self::$admin->setCodeTrust($this->ownerId, true, $this->adminId, $this->audit(), '203.0.113.9');
        $this->assertTrue($result['verified']);
        $this->assertSame($this->adminId, $result['verifiedBy']);
        $this->assertNotNull($result['verifiedAt']);
        $this->assertFalse($result['self']);
        $this->assertSame([], $result['affectedApps']);

        $rows = $this->auditRows($this->ownerId);
        $this->assertCount(1, $rows);
        $this->assertSame('admin.verify_code_trust', $rows[0]['action']);
        $this->assertSame($this->adminId, $rows[0]['user_id']);
        $this->assertSame(['affectedApps' => [], 'self' => false], json_decode((string) $rows[0]['details'], true));
    }

    public function testAnAdminMayVerifyTheirOwnAccountAndTheRecordSaysSo(): void
    {
        $result = self::$admin->setCodeTrust($this->adminId, true, $this->adminId, $this->audit());
        $this->assertTrue($result['verified']);
        $this->assertTrue($result['self']);
        $rows = $this->auditRows($this->adminId);
        $this->assertSame('admin.verify_code_trust', $rows[0]['action']);
        $this->assertTrue(json_decode((string) $rows[0]['details'], true)['self']);
    }

    public function testRevokingClearsTheStoredHostJsChoicesAndNamesTheApps(): void
    {
        $this->verify($this->ownerId);
        $result = self::$admin->setCodeTrust($this->ownerId, false, $this->adminId, $this->audit());
        $this->assertFalse($result['verified']);
        $this->assertNull($result['verifiedAt']);
        $this->assertSame([$this->appId], $result['affectedApps']);
        $this->assertNull($this->clientEngine($this->appId), 'the host-js choice is gone, not just clamped');
        $this->assertSame('zipp-web', $this->clientEngine($this->otherAppId), 'a ZIPP choice is untouched');

        $rows = $this->auditRows($this->ownerId);
        $this->assertSame('admin.revoke_code_trust', $rows[0]['action']);
        $this->assertSame([$this->appId], json_decode((string) $rows[0]['details'], true)['affectedApps']);
    }

    public function testAChangeThatCannotBeRecordedLeavesBothTablesUntouched(): void
    {
        $this->verify($this->ownerId);
        $failing = new class (self::$mysql) extends AuditService {
            public function __construct(MySQLConnection $mysql)
            {
                parent::__construct($mysql, null, AdminCodeTrustTest::AUDIT_KEY);
            }

            public function logStrict(string $action, string $resourceType, ?string $resourceId, ?string $userId, ?string $ipAddress, array $details = []): void
            {
                throw new \RuntimeException('audit store is down');
            }
        };
        try {
            self::$admin->setCodeTrust($this->ownerId, false, $this->adminId, $failing);
            $this->fail('the revocation committed without its audit row');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('audit store is down', $e->getMessage());
        }
        $this->assertTrue(self::$admin->codeTrustRow($this->ownerId)['verified'], 'the user row rolled back');
        $this->assertSame('host-js', $this->clientEngine($this->appId), 'the apps rolled back too');
    }

    // ── two-factor auth is a standing requirement, not just an entry check ───

    public function testSwitchingTwoFactorAuthOffRevokesCodeTrustAndClearsTheAppChoices(): void
    {
        $this->verify($this->ownerId);
        $mfa = new MfaService(self::$mysql, new TotpService(), $this->audit());
        $mfa->disable($this->ownerId);

        $this->assertFalse(self::$admin->codeTrustRow($this->ownerId)['verified']);
        $this->assertNull($this->clientEngine($this->appId));
        $rows = $this->auditRows($this->ownerId);
        $this->assertSame('user.revoke_code_trust', $rows[0]['action']);
        $details = json_decode((string) $rows[0]['details'], true);
        $this->assertSame('mfa_disabled', $details['trigger']);
        $this->assertSame([$this->appId], $details['affectedApps']);
    }

    public function testSwitchingTwoFactorAuthOffOnAnUnverifiedAccountRecordsNothing(): void
    {
        // The common case, and the one MfaService must handle with no audit service configured.
        $mfa = new MfaService(self::$mysql, new TotpService());
        $mfa->disable($this->ownerId);
        $this->assertFalse(self::$admin->codeTrustRow($this->ownerId)['verified']);
        $this->assertSame('host-js', $this->clientEngine($this->appId), 'an unverified account\'s stored choice is left alone');
        $this->assertSame([], $this->auditRows($this->ownerId));
    }

    // ── the admin endpoint ───────────────────────────────────────────────────

    private function controller(?AuditService $audit = null): AdminController
    {
        return new AdminController(
            self::$admin,
            self::$auth,
            new MaintenanceService(self::$tmpRoot . '/maintenance-' . bin2hex(random_bytes(3)) . '.json'),
            new \FormLogic\Services\UpgradeService(self::$tmpRoot . '/nowhere', self::$mysql, new MaintenanceService(self::$tmpRoot . '/m2.json')),
            $this->createMock(\FormLogic\Services\FormService::class),
            $this->createMock(\FormLogic\Services\AppService::class),
            $this->createMock(\FormLogic\Services\FlowService::class),
            $this->createMock(\FormLogic\Services\ResponseService::class),
            $audit ?? $this->audit(),
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            new RuntimeEngineService(self::$mysql),
        );
    }

    private function post(string $userId, array $body): ResponseInterface
    {
        $request = (new ServerRequestFactory())
            ->createServerRequest('POST', '/api/admin/users/' . $userId . '/code-trust', ['REMOTE_ADDR' => '203.0.113.9'])
            ->withAttribute('userId', $this->adminId)
            ->withParsedBody($body);
        return $this->controller()->setCodeTrust($request, (new ResponseFactory())->createResponse(), ['id' => $userId]);
    }

    private function jsonBody(ResponseInterface $response): array
    {
        $response->getBody()->rewind();
        return json_decode((string) $response->getBody(), true) ?? [];
    }

    public function testTheEndpointRefusesAWrongStepUpPasswordAndRecordsTheAttempt(): void
    {
        $response = $this->post($this->ownerId, ['verified' => true, 'password' => 'not-my-password']);
        $this->assertSame(403, $response->getStatusCode());
        $this->assertFalse(self::$admin->codeTrustRow($this->ownerId)['verified']);
        $denied = self::$pdo->prepare('SELECT action FROM audit_log WHERE resource_id = ? AND action = ?');
        $denied->execute([$this->ownerId, 'admin.code_trust_denied']);
        $this->assertSame('admin.code_trust_denied', $denied->fetchColumn());
    }

    public function testTheEndpointVerifiesWithTheAdminsOwnPassword(): void
    {
        $response = $this->post($this->ownerId, ['verified' => true, 'password' => 'admin-pass-123']);
        $this->assertSame(200, $response->getStatusCode());
        $this->assertTrue($this->jsonBody($response)['codeTrust']['verified']);
        $this->assertTrue(self::$admin->codeTrustRow($this->ownerId)['verified']);
    }

    public function testTheEndpointAnswers404ForAnUnknownAccountAnd400ForAGuardViolation(): void
    {
        $this->assertSame(404, $this->post('u-nobody', ['verified' => true, 'password' => 'admin-pass-123'])->getStatusCode());
        self::$pdo->prepare('UPDATE users SET mfa_enabled = 0 WHERE id = ?')->execute([$this->ownerId]);
        $response = $this->post($this->ownerId, ['verified' => true, 'password' => 'admin-pass-123']);
        $this->assertSame(400, $response->getStatusCode());
        $this->assertStringContainsString('two-factor', $this->jsonBody($response)['message']);
    }

    // ── what the admin UI is told ────────────────────────────────────────────

    public function testTheUserDirectoryAndOverviewCarryTheVerificationAndTheAppEngines(): void
    {
        $this->verify($this->ownerId);
        // A site that allows host-js: the only thing left standing between this app and the
        // engine is the installed runtime, which advertises none in this slice.
        (new RuntimeEngineService(self::$mysql))->writePolicy(['default' => 'zipp-web-python', 'allowed' => ['zipp-web-python', 'host-js']]);
        $listed = self::$admin->listUsers($this->ownerId . '@test.local');
        $this->assertTrue($listed['users'][0]['codeTrustVerified']);

        $overview = self::$admin->getUserOverview($this->ownerId);
        $this->assertTrue($overview['codeTrustVerified']);
        $this->assertSame($this->adminId, $overview['codeTrustVerifiedBy']);
        $engines = [];
        foreach ($overview['apps'] as $app) {
            $engines[$app['id']] = $app['engine'];
        }
        // Requested host-js, verified owner, and the installed runtime serves it: this is the
        // whole chain agreeing, which is the only way host JavaScript ever becomes effective.
        $this->assertSame('host-js', $engines[$this->appId]['requested']);
        $this->assertSame('host-js', $engines[$this->appId]['id']);
        $this->assertArrayNotHasKey('reason', $engines[$this->appId]);
        $this->assertSame('zipp-web-python', $engines[$this->otherAppId]['id']);
        $this->assertSame('policy', $engines[$this->otherAppId]['reason'], 'zipp-web is not in the default allow-list');
    }
}

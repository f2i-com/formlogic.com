<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use Firebase\JWT\JWT;
use FormLogic\Controllers\AdminController;
use FormLogic\Controllers\AuthController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Middleware\AdminConfirmationMiddleware;
use FormLogic\Middleware\AdminGateMiddleware;
use FormLogic\Models\User;
use FormLogic\Services\AdminService;
use FormLogic\Services\AdminSupportActivity;
use FormLogic\Services\AppService;
use FormLogic\Services\AuditService;
use FormLogic\Services\AuthService;
use FormLogic\Services\EmailService;
use FormLogic\Services\FlowService;
use FormLogic\Services\FormService;
use FormLogic\Services\MaintenanceService;
use FormLogic\Services\MfaService;
use FormLogic\Services\ResponseService;
use FormLogic\Services\UpgradeService;
use FormLogic\Support\HostedActorContext;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * What stands between a stolen admin session and everyone's accounts: two-factor to reach the
 * tools, a fresh password and code for what takes an account over, a reset the owner holds the
 * link to, and the owner being told. Skipped without a test database.
 */
class AdminSafeguardsTest extends TestCase
{
    private const JWT = ['secret' => 'test-secret-for-admin-safeguards-0123456789', 'algorithm' => 'HS256', 'issuer' => 'formlogic', 'audience' => 'formlogic-api', 'expiry' => 3600];
    private const SESSION = 'session-identity-1';

    private static ?MySQLConnection $mysql = null;
    private static PDO $pdo;
    private static AuthService $auth;
    private static AdminService $admin;
    private static AuditService $audit;

    private string $adminId = '';
    private string $ownerId = '';

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
        self::$auth = new AuthService($conn, self::JWT);
        self::$admin = new AdminService($conn);
        self::$audit = new AuditService($conn, null, 'admin-safeguards-hmac-key');
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->adminId = $this->user(true);
        $this->ownerId = $this->user(false);
    }

    protected function tearDown(): void
    {
        if (self::$mysql === null) {
            return;
        }
        foreach ([$this->adminId, $this->ownerId] as $id) {
            self::$pdo->prepare('DELETE FROM password_resets WHERE user_id = ?')->execute([$id]);
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$id]);
        }
    }

    private function user(bool $isAdmin): string
    {
        $id = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare('INSERT INTO users (id, email, password_hash, name, is_admin) VALUES (?, ?, ?, ?, ?)')
            ->execute([$id, $id . '@safeguards.test', password_hash('the-right-password', PASSWORD_DEFAULT), 'T', $isAdmin ? 1 : 0]);
        return $id;
    }

    private function owner(): User
    {
        return self::$auth->getUserById($this->ownerId);
    }

    private function controller(?MfaService $mfa = null, ?EmailService $email = null, ?FormService $forms = null, ?FlowService $flows = null): AdminController
    {
        return new AdminController(
            self::$admin,
            self::$auth,
            $this->createStub(MaintenanceService::class),
            $this->createStub(UpgradeService::class),
            $forms ?? $this->createStub(FormService::class),
            $this->createStub(AppService::class),
            $flows ?? $this->createStub(FlowService::class),
            $this->createStub(ResponseService::class),
            self::$audit,
            null,
            null,
            null,
            $mfa,
            null,
            $email,
        );
    }

    private function adminRequest(string $path, array $body = [], ?string $session = self::SESSION): ServerRequestInterface
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', 'https://formlogic.example' . $path)
            ->withAttribute('userId', $this->adminId)
            ->withParsedBody($body);
        return $session === null ? $request : $request->withAttribute(HostedActorContext::SESSION_ATTRIBUTE, $session);
    }

    private static function decode(ResponseInterface $response): array
    {
        $response->getBody()->rewind();
        return json_decode((string) $response->getBody(), true) ?? [];
    }

    private function confirm(array $body, ?MfaService $mfa = null): ResponseInterface
    {
        return $this->controller($mfa)->confirm($this->adminRequest('/api/admin/confirm', $body), (new ResponseFactory())->createResponse());
    }

    private function passesGate(ServerRequestInterface $request, callable $middleware): int
    {
        $handler = new class implements RequestHandlerInterface {
            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                return new Response(204);
            }
        };
        return $middleware($request, $handler)->getStatusCode();
    }

    // ── Two-factor to reach the tools ────────────────────────────────────────

    public function testTheAdminToolsWaitForTwoFactor(): void
    {
        $request = (new ServerRequestFactory())->createServerRequest('GET', 'https://formlogic.example/api/admin/users')
            ->withAttribute('user', self::$auth->getUserById($this->adminId));
        $gate = new AdminGateMiddleware(self::$auth, true);
        $handler = new class implements RequestHandlerInterface {
            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                return new Response(204);
            }
        };

        $refused = $gate->process($request, $handler);
        $this->assertSame(403, $refused->getStatusCode());
        $this->assertSame(AdminGateMiddleware::NEEDS_MFA, self::decode($refused)['code']);

        self::$pdo->prepare('UPDATE users SET mfa_enabled = 1 WHERE id = ?')->execute([$this->adminId]);
        $this->assertSame(204, $gate->process($request, $handler)->getStatusCode());
        // Someone who isn't an administrator hears nothing about two-factor.
        $plain = $request->withAttribute('user', $this->owner());
        $this->assertSame('Administrator access required', self::decode($gate->process($plain, $handler))['message']);
    }

    public function testTwoFactorIsRequiredOutsideDevelopmentUnlessTheServerSaysOtherwise(): void
    {
        $saved = [$_ENV['APP_ENV'] ?? null, $_ENV['ADMIN_MFA_REQUIRED'] ?? null];
        try {
            unset($_ENV['ADMIN_MFA_REQUIRED']);
            foreach (['production' => true, 'staging' => true, 'development' => false] as $env => $required) {
                $_ENV['APP_ENV'] = $env;
                $this->assertSame($required, AuthService::adminMfaRequired(), $env);
            }
            $_ENV['APP_ENV'] = 'production';
            $_ENV['ADMIN_MFA_REQUIRED'] = 'false';
            $this->assertFalse(AuthService::adminMfaRequired());
            $_ENV['ADMIN_MFA_REQUIRED'] = 'enabled';
            $this->assertTrue(AuthService::adminMfaRequired(), 'a typo keeps it on');
            $_ENV['APP_ENV'] = 'development';
            $_ENV['ADMIN_MFA_REQUIRED'] = 'true';
            $this->assertTrue(AuthService::adminMfaRequired());
            $this->assertTrue(self::$auth->userPayload(self::$auth->getUserById($this->adminId))['adminNeedsMfa']);
            $this->assertFalse(self::$auth->userPayload($this->owner())['adminNeedsMfa']);
        } finally {
            foreach (['APP_ENV', 'ADMIN_MFA_REQUIRED'] as $i => $key) {
                if ($saved[$i] === null) {
                    unset($_ENV[$key]);
                } else {
                    $_ENV[$key] = $saved[$i];
                }
            }
        }
    }

    // ── A fresh password and code ────────────────────────────────────────────

    public function testAConfirmationAsksForThePassword(): void
    {
        $refused = $this->confirm(['password' => 'a-guess']);
        $this->assertSame(403, $refused->getStatusCode());
        $this->assertSame('admin_confirmation_failed', self::decode($refused)['code']);
        $this->assertArrayNotHasKey('confirmation', self::decode($refused));

        $confirmed = $this->confirm(['password' => 'the-right-password']);
        $this->assertSame(200, $confirmed->getStatusCode());
        $this->assertSame('no-store', $confirmed->getHeaderLine('Cache-Control'));
        $this->assertTrue(self::$auth->adminConfirmed(self::decode($confirmed)['confirmation'], $this->adminId, self::SESSION));
    }

    public function testWithTwoFactorOnItAsksForTheCodeToo(): void
    {
        $mfa = $this->createMock(MfaService::class);
        $mfa->method('isEnabled')->willReturn(true);
        $mfa->method('verifyChallenge')->willReturnCallback(static fn (string $id, string $code): bool => $code === '123456');
        $this->assertSame(403, $this->confirm(['password' => 'the-right-password'], $mfa)->getStatusCode());
        $this->assertSame(403, $this->confirm(['password' => 'the-right-password', 'code' => '000000'], $mfa)->getStatusCode());
        $this->assertSame(200, $this->confirm(['password' => 'the-right-password', 'code' => '123456'], $mfa)->getStatusCode());
    }

    public function testAWrongPasswordNeverSpendsACode(): void
    {
        $mfa = $this->createMock(MfaService::class);
        $mfa->method('isEnabled')->willReturn(true);
        $mfa->expects($this->never())->method('verifyChallenge');
        $this->assertSame(403, $this->confirm(['password' => 'a-guess', 'code' => 'recovery-code'], $mfa)->getStatusCode());
    }

    public function testAConfirmationIsGoodForThisAdminThisSessionAndNotLong(): void
    {
        $token = self::$auth->issueAdminConfirmation($this->adminId, self::SESSION);
        $this->assertTrue(self::$auth->adminConfirmed($token, $this->adminId, self::SESSION));
        $this->assertFalse(self::$auth->adminConfirmed($token, $this->adminId, 'another-session'));
        $this->assertFalse(self::$auth->adminConfirmed($token, $this->ownerId, self::SESSION));
        $this->assertFalse(self::$auth->adminConfirmed('', $this->adminId, self::SESSION));
        $this->assertFalse(self::$auth->adminConfirmed('not-a-token', $this->adminId, self::SESSION));

        // A session token is not a confirmation, nor a confirmation a session.
        $platform = self::$auth->issueToken(self::$auth->getUserById($this->adminId));
        $this->assertFalse(self::$auth->adminConfirmed($platform, $this->adminId, self::SESSION));
        $this->assertNull(self::$auth->validateToken($token));

        $claims = ['iss' => 'formlogic', 'aud' => 'formlogic-admin-confirmation', 'sub' => $this->adminId, 'ses' => self::SESSION, 'tv' => 0];
        $this->assertFalse(self::$auth->adminConfirmed(JWT::encode($claims + ['exp' => time() - 1], self::JWT['secret'], 'HS256'), $this->adminId, self::SESSION), 'expired');
        $this->assertFalse(self::$auth->adminConfirmed(JWT::encode($claims + ['exp' => time() + 60], 'another-secret-another-secret-another-secret', 'HS256'), $this->adminId, self::SESSION), 'forged');
        $this->assertFalse(self::$auth->adminConfirmed(JWT::encode(['aud' => 'formlogic-api', 'exp' => time() + 60] + $claims, self::JWT['secret'], 'HS256'), $this->adminId, self::SESSION), 'another token of ours');

        self::$auth->revokeTokens($this->adminId);
        $this->assertFalse(self::$auth->adminConfirmed($token, $this->adminId, self::SESSION), 'a sign-out everywhere ends it');
    }

    public function testEveryAdminWriteIsConfirmedAndReadsPass(): void
    {
        $middleware = new AdminConfirmationMiddleware(self::$auth, true);
        $handler = new class implements RequestHandlerInterface {
            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                return new Response(204);
            }
        };
        $at = fn (string $method, string $path) => (new ServerRequestFactory())->createServerRequest($method, 'https://formlogic.example' . $path)
            ->withAttribute('userId', $this->adminId)->withAttribute(HostedActorContext::SESSION_ATTRIBUTE, self::SESSION);
        foreach ([['POST', '/api/admin/upgrade/apply'], ['POST', '/api/admin/upgrade/rollback'], ['POST', '/api/admin/upgrade/restore-db'], ['POST', '/api/admin/backups/restore'], ['PUT', '/api/admin/flows/x'], ['POST', '/api/admin/maintenance'], ['DELETE', '/api/admin/notices/x']] as [$method, $path]) {
            $this->assertSame(403, $middleware->process($at($method, $path), $handler)->getStatusCode(), $path);
        }
        $this->assertSame(204, $middleware->process($at('GET', '/api/admin/overview'), $handler)->getStatusCode());
        $this->assertSame(204, $middleware->process($at('POST', '/api/admin/confirm'), $handler)->getStatusCode(), 'how one gets confirmed');
        $this->assertSame(403, $middleware->process($at('POST', '/api/admin/confirm/x'), $handler)->getStatusCode());
        $this->assertSame(403, (new AdminConfirmationMiddleware(self::$auth))->process($at('GET', '/api/admin/users/x/flows'), $handler)->getStatusCode(), 'acting asks for reads too');
    }

    public function testTheMiddlewareAdmitsOnlyAConfirmedRequest(): void
    {
        $middleware = new AdminConfirmationMiddleware(self::$auth);
        $handler = new class implements RequestHandlerInterface {
            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                return new Response(204);
            }
        };
        $request = $this->adminRequest('/api/admin/users/x/password');
        $refused = $middleware->process($request, $handler);
        $this->assertSame(403, $refused->getStatusCode());
        $this->assertSame(AdminConfirmationMiddleware::CODE, self::decode($refused)['code']);

        $token = self::$auth->issueAdminConfirmation($this->adminId, self::SESSION);
        $this->assertSame(204, $middleware->process($request->withHeader(AdminConfirmationMiddleware::HEADER, $token), $handler)->getStatusCode());
        $noSession = $this->adminRequest('/api/admin/users/x/password', [], null)->withHeader(AdminConfirmationMiddleware::HEADER, $token);
        $this->assertSame(403, $middleware->process($noSession, $handler)->getStatusCode());
    }

    // ── The owner holds the reset ────────────────────────────────────────────

    public function testWithMailAResetIsALinkToTheOwnerAndNoPasswordChanges(): void
    {
        $saved = $_ENV['APP_URL'] ?? null;
        $_ENV['APP_URL'] = 'https://forms.safeguards.test';
        try {
            $email = $this->createStub(EmailService::class);
            $email->method('isConfigured')->willReturn(true);
            $response = $this->controller(null, $email)->resetPassword($this->adminRequest('/x', ['password' => 'admin-chosen-password-1']), (new ResponseFactory())->createResponse(), ['id' => $this->ownerId]);
            $body = self::decode($response);
            $this->assertSame(200, $response->getStatusCode(), json_encode($body));
            $this->assertTrue($body['emailed']);
            $this->assertArrayNotHasKey('tempPassword', $body);
            $this->assertTrue(self::$auth->verifyPassword($this->ownerId, 'the-right-password'), 'still the owner\'s own');
            $this->assertFalse(self::$auth->verifyPassword($this->ownerId, 'admin-chosen-password-1'));
            $row = self::$pdo->prepare('SELECT COUNT(*) FROM password_resets WHERE user_id = ?');
            $row->execute([$this->ownerId]);
            $this->assertSame(1, (int) $row->fetchColumn());
        } finally {
            if ($saved === null) {
                unset($_ENV['APP_URL']);
            } else {
                $_ENV['APP_URL'] = $saved;
            }
        }
    }

    public function testWithoutMailATemporaryPasswordIsTheWayBackIn(): void
    {
        $email = $this->createStub(EmailService::class);
        $email->method('isConfigured')->willReturn(false);
        $session = self::$auth->issueToken($this->owner());
        $response = $this->controller(null, $email)->resetPassword($this->adminRequest('/x', ['password' => 'admin-chosen-password-1']), (new ResponseFactory())->createResponse(), ['id' => $this->ownerId]);
        $body = self::decode($response);
        $this->assertTrue(self::$auth->verifyPassword($this->ownerId, $body['tempPassword']));
        $this->assertFalse(self::$auth->verifyPassword($this->ownerId, 'admin-chosen-password-1'), 'an administrator doesn\'t choose it');
        $this->assertNull(self::$auth->validateToken($session), 'old sessions end');
    }

    public function testAnotherAdministratorsAccountIsNotResetFromHere(): void
    {
        self::$pdo->prepare('UPDATE users SET is_admin = 1 WHERE id = ?')->execute([$this->ownerId]);
        $mfa = $this->createStub(MfaService::class);
        $factory = new ResponseFactory();
        $this->assertStringContainsString('administrator', self::decode($this->controller()->resetPassword($this->adminRequest('/x'), $factory->createResponse(), ['id' => $this->ownerId]))['message']);
        $this->assertSame(400, $this->controller()->updateEmail($this->adminRequest('/x', ['email' => 'mine@safeguards.test']), $factory->createResponse(), ['id' => $this->ownerId])->getStatusCode());
        $this->assertSame(400, $this->controller($mfa)->resetMfa($this->adminRequest('/x', ['password' => 'the-right-password']), $factory->createResponse(), ['id' => $this->ownerId])->getStatusCode());
        $this->assertTrue(self::$auth->verifyPassword($this->ownerId, 'the-right-password'));
    }

    public function testAnEmailChangeEndsResetLinksAlreadySent(): void
    {
        self::$pdo->prepare('INSERT INTO password_resets (id, user_id, token_hash, expires_at) VALUES (UUID(), ?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR))')
            ->execute([$this->ownerId, hash('sha256', bin2hex(random_bytes(8)))]);
        self::$admin->setUserEmail($this->ownerId, 'moved-' . $this->ownerId . '@safeguards.test');
        $left = self::$pdo->prepare('SELECT COUNT(*) FROM password_resets WHERE user_id = ?');
        $left->execute([$this->ownerId]);
        $this->assertSame(0, (int) $left->fetchColumn());
    }

    public function testChangingTheEmailTellsTheOldAddress(): void
    {
        $old = $this->ownerId . '@safeguards.test';
        $email = $this->createMock(EmailService::class);
        $email->expects($this->once())->method('send')->with($old, $this->stringContains('email was changed'), $this->anything())->willReturn(true);
        $response = $this->controller(null, $email)->updateEmail($this->adminRequest('/x', ['email' => 'new-' . $old]), (new ResponseFactory())->createResponse(), ['id' => $this->ownerId]);
        $this->assertSame(200, $response->getStatusCode());
    }

    // ── The owner is told ────────────────────────────────────────────────────

    public function testOpeningAnAccountTellsItsOwnerOnceADay(): void
    {
        $email = $this->createMock(EmailService::class);
        $email->expects($this->once())->method('send')->with($this->ownerId . '@safeguards.test', $this->anything(), $this->anything())->willReturn(true);
        $activity = new AdminSupportActivity(self::$mysql, self::$audit, $email);
        $activity->opened($this->owner(), $this->adminId, null);
        $activity->opened($this->owner(), $this->adminId, null);

        $count = self::$pdo->prepare("SELECT COUNT(*) FROM audit_log WHERE action = 'admin.support_opened' AND resource_id = ?");
        $count->execute([$this->ownerId]);
        $this->assertSame(1, (int) $count->fetchColumn());
    }

    public function testAnOwnerSeesWhatWasDoneInTheirAccountAndNobodyElses(): void
    {
        $activity = new AdminSupportActivity(self::$mysql, self::$audit);
        self::$audit->log('admin.password_reset_link', 'admin', $this->ownerId, $this->adminId, null, []);
        self::$audit->log('admin.on_behalf', 'admin', $this->ownerId, $this->adminId, null, ['path' => '/secret/route']);
        self::$audit->log('admin.mfa_reset', 'admin', $this->adminId, $this->ownerId, null, []);
        self::$audit->log('admin.user_note', 'admin', $this->ownerId, $this->adminId, null, []);

        $seen = $activity->recentFor($this->ownerId);
        $what = array_column($seen, 'what');
        sort($what);
        $this->assertSame(['An administrator changed something in your account', 'An administrator sent you a password reset link'], $what);
        $this->assertSame(['at', 'what'], array_keys($seen[0]));
        $this->assertStringNotContainsString($this->adminId, (string) json_encode($seen), 'which administrator stays in the log');
    }

    public function testAnOrdinaryEditCannotPushAResetOffTheList(): void
    {
        $activity = new AdminSupportActivity(self::$mysql, self::$audit);
        self::$audit->log('admin.mfa_reset', 'admin', $this->ownerId, $this->adminId, null, []);
        for ($i = 0; $i < 12; $i++) {
            self::$audit->log('admin.on_behalf', 'admin', $this->ownerId, $this->adminId, null, []);
        }
        $this->assertContains('An administrator turned off your two-factor authentication', array_column($activity->recentFor($this->ownerId, 5), 'what'));
    }

    public function testASecondAdministratorIsToldAboutToo(): void
    {
        $other = $this->user(true);
        try {
            $email = $this->createMock(EmailService::class);
            $email->expects($this->exactly(2))->method('send')->willReturn(true);
            $activity = new AdminSupportActivity(self::$mysql, self::$audit, $email);
            $activity->opened($this->owner(), $this->adminId, null);
            $activity->opened($this->owner(), $other, null);
        } finally {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$other]);
        }
    }

    public function testAFlowEditFromTheAdminPanelWaitsForTheOwner(): void
    {
        $flowId = 'flow-' . bin2hex(random_bytes(6));
        self::$pdo->prepare("INSERT INTO flow_definitions (id, owner_user_id, name, slug, flow_json) VALUES (?, ?, 'F', ?, '{}')")->execute([$flowId, $this->ownerId, $flowId]);
        try {
            $refused = $this->controller()->updateFlow($this->adminRequest('/x', ['flowJson' => ['nodes' => []]]), (new ResponseFactory())->createResponse(), ['id' => $flowId]);
            $this->assertSame(403, $refused->getStatusCode());
            $this->assertSame('admin_support_access_required', self::decode($refused)['code']);
        } finally {
            self::$pdo->prepare('DELETE FROM flow_definitions WHERE id = ?')->execute([$flowId]);
        }
    }

    public function testAnAdministratorPausesARunawayFlowWithoutTheOwner(): void
    {
        $flowId = 'flow-' . bin2hex(random_bytes(6));
        self::$pdo->prepare("INSERT INTO flow_definitions (id, owner_user_id, name, slug, flow_json) VALUES (?, ?, 'F', ?, '{}')")->execute([$flowId, $this->ownerId, $flowId]);
        $flows = $this->createMock(FlowService::class);
        $flows->expects($this->once())->method('updateWorkspaceFlow')->with($this->ownerId, $flowId, ['enabled' => false])->willReturn(['id' => $flowId, 'enabled' => false]);
        $put = fn (array $body) => $this->controller(null, null, null, $flows)->updateFlow($this->adminRequest('/x', $body), (new ResponseFactory())->createResponse(), ['id' => $flowId]);
        try {
            foreach ([['enabled' => true], ['enabled' => 'false'], ['enabled' => false, 'name' => 'Renamed'], ['enabled' => false, 'flowJson' => ['nodes' => []]]] as $body) {
                $this->assertSame(403, $put($body)->getStatusCode(), json_encode($body));
            }
            $this->assertSame(200, $put(['enabled' => false])->getStatusCode());

            $audited = self::$pdo->prepare("SELECT COUNT(*) FROM audit_log WHERE action = 'admin.update_flow' AND resource_id = ?");
            $audited->execute([$flowId]);
            $this->assertSame(1, (int) $audited->fetchColumn());
        } finally {
            self::$pdo->prepare('DELETE FROM flow_definitions WHERE id = ?')->execute([$flowId]);
        }
    }

    // ── Two-factor can't be taken with a session alone ───────────────────────

    public function testSettingUpTwoFactorTakesThePassword(): void
    {
        $mfa = $this->createMock(MfaService::class);
        $mfa->expects($this->once())->method('beginSetup')->willReturn(['secret' => 's', 'uri' => 'u']);
        $controller = new AuthController(self::$auth, [], 3600, null, null, '', null, null, null, null, null, $mfa);
        $request = (new ServerRequestFactory())->createServerRequest('POST', 'https://formlogic.example/api/auth/mfa/setup')
            ->withAttribute('user', $this->owner())->withAttribute('userId', $this->ownerId);
        $this->assertSame(403, $controller->mfaSetup($request, (new ResponseFactory())->createResponse())->getStatusCode());
        $this->assertSame(403, $controller->mfaSetup($request->withParsedBody(['password' => 'a-guess']), (new ResponseFactory())->createResponse())->getStatusCode());
        $this->assertSame(200, $controller->mfaSetup($request->withParsedBody(['password' => 'the-right-password']), (new ResponseFactory())->createResponse())->getStatusCode());
    }

    public function testTurningTwoFactorOnEndsEveryOtherSession(): void
    {
        $mfa = $this->createStub(MfaService::class);
        $mfa->method('enable')->willReturn(['code-1']);
        $controller = new AuthController(self::$auth, [], 3600, null, null, 'csrf', null, null, null, null, null, $mfa);
        $stolen = self::$auth->issueToken($this->owner());
        $request = (new ServerRequestFactory())->createServerRequest('POST', 'https://formlogic.example/api/auth/mfa/enable')
            ->withAttribute('user', $this->owner())->withAttribute('userId', $this->ownerId)->withParsedBody(['code' => '123456']);
        $response = $controller->mfaEnable($request, (new ResponseFactory())->createResponse());
        $this->assertSame(200, $response->getStatusCode());
        $this->assertNull(self::$auth->validateToken($stolen));
        preg_match('/^formlogic_auth=([^;]+)/', $response->getHeader('Set-Cookie')[0], $match);
        $this->assertNotNull(self::$auth->validateToken(urldecode($match[1])), 'this one carries on');
    }

    public function testTurningTwoFactorOffTakesTheCodeToo(): void
    {
        $mfa = $this->createMock(MfaService::class);
        $mfa->method('verifyChallenge')->willReturnCallback(static fn (string $id, string $code): bool => $code === '123456');
        $mfa->expects($this->once())->method('disable');
        $controller = new AuthController(self::$auth, [], 3600, null, null, 'csrf', null, null, null, null, null, $mfa);
        $request = (new ServerRequestFactory())->createServerRequest('POST', 'https://formlogic.example/api/auth/mfa/disable')
            ->withAttribute('user', $this->owner())->withAttribute('userId', $this->ownerId);
        $this->assertSame(403, $controller->mfaDisable($request->withParsedBody(['password' => 'the-right-password']), (new ResponseFactory())->createResponse())->getStatusCode());
        $this->assertSame(200, $controller->mfaDisable($request->withParsedBody(['password' => 'the-right-password', 'code' => '123456']), (new ResponseFactory())->createResponse())->getStatusCode());
    }

    // ── Support access ───────────────────────────────────────────────────────

    public function testTheAdminFormEditorWaitsForTheOwnerToo(): void
    {
        $form = ['id' => 'form-1', 'userId' => $this->ownerId, 'status' => 'draft', 'logicScript' => 'function onSubmit() {}', 'customScreen' => [], 'settings' => []];
        $forms = $this->createMock(FormService::class);
        $forms->method('getForm')->willReturn($form);
        $forms->method('updateForm')->willReturn($form);
        $save = fn (array $body) => $this->controller(null, null, $forms)->updateForm($this->adminRequest('/x', $body), (new ResponseFactory())->createResponse(), ['id' => 'form-1']);

        $refused = $save(['logicScript' => 'steal()']);
        $this->assertSame(403, $refused->getStatusCode());
        $this->assertSame('admin_support_access_required', self::decode($refused)['code']);
        $this->assertSame(200, $save(['title' => 'Renamed', 'logicScript' => 'function onSubmit() {}'])->getStatusCode());
        self::$auth->setSupportAccess($this->ownerId, true);
        $this->assertSame(200, $save(['logicScript' => 'fixed()'])->getStatusCode());
    }

    public function testSupportAccessIsOnlyEverForADay(): void
    {
        $this->assertNull(self::$auth->supportAccessUntil($this->ownerId));
        $until = self::$auth->setSupportAccess($this->ownerId, true);
        $this->assertNotNull($until);
        $left = strtotime((string) $until) - time();
        $this->assertGreaterThan(23 * 3600, $left);
        $this->assertLessThanOrEqual(24 * 3600, $left);

        self::$pdo->prepare('UPDATE users SET support_access_until = NOW() - INTERVAL 1 SECOND WHERE id = ?')->execute([$this->ownerId]);
        $this->assertNull(self::$auth->supportAccessUntil($this->ownerId), 'it lapses by itself');

        self::$auth->setSupportAccess($this->ownerId, true);
        $this->assertNull(self::$auth->setSupportAccess($this->ownerId, false));
        $this->assertNull(self::$auth->supportAccessUntil($this->ownerId));
    }

    public function testAnOwnerTurnsItOnAndOffFromTheirOwnSession(): void
    {
        $controller = new AuthController(self::$auth);
        $request = (new ServerRequestFactory())->createServerRequest('PUT', 'https://formlogic.example/api/auth/support-access')
            ->withAttribute('user', $this->owner())->withAttribute('userId', $this->ownerId);

        $on = self::decode($controller->setSupportAccess($request->withParsedBody(['allow' => true]), (new ResponseFactory())->createResponse()));
        $this->assertNotNull($on['until']);
        $read = self::decode($controller->supportAccess($request, (new ResponseFactory())->createResponse()));
        $this->assertSame($on['until'], $read['until']);

        // Only `true` allows it.
        foreach ([['allow' => 'true'], ['allow' => 1], []] as $body) {
            self::$auth->setSupportAccess($this->ownerId, true);
            $this->assertNull(self::decode($controller->setSupportAccess($request->withParsedBody($body), (new ResponseFactory())->createResponse()))['until'], json_encode($body));
        }
    }
}

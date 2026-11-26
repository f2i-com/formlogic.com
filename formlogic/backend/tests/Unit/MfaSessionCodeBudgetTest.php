<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\AdminController;
use FormLogic\Controllers\AuthController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Models\User;
use FormLogic\Services\AdminService;
use FormLogic\Services\AppService;
use FormLogic\Services\AuthService;
use FormLogic\Services\FlowService;
use FormLogic\Services\FormService;
use FormLogic\Services\MaintenanceService;
use FormLogic\Services\MfaService;
use FormLogic\Services\ResponseService;
use FormLogic\Services\TotpService;
use FormLogic\Services\UpgradeService;
use FormLogic\Support\HostedActorContext;
use PDO;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\MockObject\MockObject;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * A two-factor code is also asked for inside a session: to finish setting two-factor up, to turn
 * it off, for new recovery codes, and to confirm an administrator. Those routes let a session
 * make ten requests a minute, and the account's budget of code answers (ten in fifteen minutes,
 * MfaAccountBudgetTest) only counted the sign-in prompt's, so whoever held a session that was not
 * theirs could guess there for as long as it lasted.
 *
 * Here the service is the real one over an in-memory `users` table, with real codes; only the
 * count itself is stood in for (it lives in MySQL: MfaFlowTest), so each test says what the count
 * answers and looks at what was done with the code.
 */
final class MfaSessionCodeBudgetTest extends TestCase
{
    private const LOCKED = 'Too many incorrect verification codes for this account. Please try again in 7 minute(s).';
    private const RECOVERY_CODE = 'AAAAA-BBBBB';

    private PDO $pdo;
    private TotpService $totp;
    private string $secret;
    private User $user;
    private AuthService&MockObject $auth;
    private MfaService&MockObject $mfa;
    private AuthController $controller;

    protected function setUp(): void
    {
        $this->pdo = new PDO('sqlite::memory:');
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->pdo->exec('CREATE TABLE users (id TEXT PRIMARY KEY, mfa_enabled INTEGER NOT NULL DEFAULT 0, mfa_secret TEXT,
            mfa_recovery_codes TEXT, mfa_last_totp_step INTEGER)');
        $this->totp = new TotpService();
        $this->secret = $this->totp->generateSecret();
        $this->pdo->prepare('INSERT INTO users (id, mfa_enabled, mfa_secret, mfa_recovery_codes) VALUES (?, 1, ?, ?)')
            ->execute(['user-1', $this->secret, json_encode([hash('sha256', 'AAAAABBBBB')])]);

        $connection = $this->createMock(MySQLConnection::class);
        $connection->method('getConnection')->willReturn($this->pdo);
        // Everything but the count is the real service; turning two-factor off is MySQL's (FOR UPDATE).
        $this->mfa = $this->getMockBuilder(MfaService::class)
            ->setConstructorArgs([$connection, $this->totp])
            ->onlyMethods(['secondFactorAttempt', 'secondFactorPassed', 'secondFactorMinutesLeft', 'disable'])
            ->getMock();
        $this->mfa->method('secondFactorMinutesLeft')->willReturn(7);

        $this->user = new User('user-1', 'ada@example.test');
        $this->auth = $this->createMock(AuthService::class);
        $this->auth->method('getUserById')->willReturn($this->user);
        $this->auth->method('issueToken')->willReturn('session-token');
        $this->auth->method('issueAdminConfirmation')->willReturn('confirmation-token');
        $this->controller = new AuthController($this->auth, mfaService: $this->mfa);
    }

    private function rightCode(): string
    {
        return $this->totp->code($this->secret, intdiv(time(), TotpService::PERIOD));
    }

    /** A code no step near now accepts: the right one with its last digit moved on. */
    private function wrongCode(): string
    {
        $right = $this->rightCode();
        $wrong = substr($right, 0, 5) . (((int) $right[5] + 1) % 10);
        return $this->totp->verify($this->secret, $wrong) ? substr($right, 0, 5) . (((int) $right[5] + 2) % 10) : $wrong;
    }

    /** @param array<string, mixed> $body */
    private function post(string $path, array $body): ServerRequestInterface
    {
        return (new ServerRequestFactory())->createServerRequest('POST', $path)
            ->withAttribute('user', $this->user)->withAttribute('userId', 'user-1')->withParsedBody($body);
    }

    /** @return array{0: int, 1: array<string, mixed>} */
    private static function answer(ResponseInterface $response): array
    {
        return [$response->getStatusCode(), json_decode((string) $response->getBody(), true) ?: []];
    }

    /** @return array<string, mixed> */
    private function account(): array
    {
        return $this->pdo->query("SELECT * FROM users WHERE id = 'user-1'")->fetch(PDO::FETCH_ASSOC);
    }

    /**
     * The routes that take a code from a signed-in account that has two-factor on.
     *
     * @return array{0: int, 1: array<string, mixed>}
     */
    private function ask(string $route, string $code): array
    {
        $new = (new ResponseFactory())->createResponse();
        return self::answer(match ($route) {
            'recovery-codes' => $this->controller->mfaRegenerateRecoveryCodes($this->post('/api/auth/mfa/recovery-codes', ['code' => $code]), $new),
            'disable' => $this->controller->mfaDisable($this->post('/api/auth/mfa/disable', ['password' => 'correct-horse', 'code' => $code]), $new),
            'admin-confirm' => $this->adminController()->confirm(
                $this->post('/api/admin/confirm', ['password' => 'correct-horse', 'code' => $code])->withAttribute(HostedActorContext::SESSION_ATTRIBUTE, 'session-1'),
                $new
            ),
        });
    }

    private function adminController(): AdminController
    {
        return new AdminController(
            $this->createMock(AdminService::class),
            $this->auth,
            $this->createMock(MaintenanceService::class),
            $this->createMock(UpgradeService::class),
            $this->createMock(FormService::class),
            $this->createMock(AppService::class),
            $this->createMock(FlowService::class),
            $this->createMock(ResponseService::class),
            mfaService: $this->mfa,
        );
    }

    /** @return array<string, array{0: string}> */
    public static function routesThatTakeACode(): array
    {
        return ['new recovery codes' => ['recovery-codes'], 'turning two-factor off' => ['disable'], 'an administrator\'s confirmation' => ['admin-confirm']];
    }

    #[DataProvider('routesThatTakeACode')]
    public function testOverTheAccountsBudgetEvenTheRightCodeIsNotRead(string $route): void
    {
        $this->auth->method('verifyPassword')->willReturn(true);
        $this->mfa->expects($this->once())->method('secondFactorAttempt')->with('user-1')->willReturn(false);
        $this->mfa->expects($this->never())->method('secondFactorPassed');
        $this->mfa->expects($this->never())->method('disable');
        $before = $this->account();

        [$status, $body] = $this->ask($route, $this->rightCode());

        $this->assertSame(429, $status);
        $this->assertSame(self::LOCKED, $body['message']);
        $this->assertArrayNotHasKey('recoveryCodes', $body);
        $this->assertArrayNotHasKey('confirmation', $body);
        // Unread: the code's time step is unspent, and the recovery codes are the ones there were.
        $this->assertSame($before, $this->account());
        $this->assertNull($this->account()['mfa_last_totp_step']);
    }

    #[DataProvider('routesThatTakeACode')]
    public function testACodeThatCannotBeCountedIsNotRead(string $route): void
    {
        $this->auth->method('verifyPassword')->willReturn(true);
        $this->mfa->method('secondFactorAttempt')->willReturn(null);
        $this->mfa->expects($this->never())->method('secondFactorPassed');
        $this->mfa->expects($this->never())->method('disable');
        $before = $this->account();

        [$status, $body] = $this->ask($route, $this->rightCode());

        $this->assertSame(503, $status);
        $this->assertTrue($body['retryable']);
        $this->assertSame($before, $this->account());
    }

    #[DataProvider('routesThatTakeACode')]
    public function testAWrongCodeIsCountedAndTheCountStands(string $route): void
    {
        $this->auth->method('verifyPassword')->willReturn(true);
        $this->mfa->expects($this->once())->method('secondFactorAttempt')->with('user-1')->willReturn(true);
        $this->mfa->expects($this->never())->method('secondFactorPassed');
        $this->mfa->expects($this->never())->method('disable');

        [$status, $body] = $this->ask($route, $this->wrongCode());

        $this->assertSame(403, $status);
        $this->assertSame($route === 'admin-confirm' ? 'admin_confirmation_failed' : 'mfa_code_required', $body['code']);
    }

    #[DataProvider('routesThatTakeACode')]
    public function testTheRightCodeIsCountedFirstAndEndsTheCount(string $route): void
    {
        $this->auth->method('verifyPassword')->willReturn(true);
        $order = [];
        $this->mfa->expects($this->once())->method('secondFactorAttempt')->with('user-1')->willReturnCallback(function () use (&$order): bool {
            // Counted before the code is looked at: its time step is not spent yet.
            $order[] = 'counted with step ' . json_encode($this->account()['mfa_last_totp_step']);
            return true;
        });
        $this->mfa->expects($this->once())->method('secondFactorPassed')->with('user-1')->willReturnCallback(function () use (&$order): void {
            $order[] = 'count ended';
        });
        $this->mfa->expects($route === 'disable' ? $this->once() : $this->never())->method('disable')->willReturn(['affectedApps' => []]);

        [$status] = $this->ask($route, $this->rightCode());

        $this->assertSame(200, $status);
        $this->assertSame(['counted with step null', 'count ended'], $order);
        $this->assertNotNull($this->account()['mfa_last_totp_step']);
    }

    #[DataProvider('routesThatTakeACode')]
    public function testARecoveryCodeIsCountedTheSameWay(string $route): void
    {
        $this->auth->method('verifyPassword')->willReturn(true);
        $this->mfa->expects($this->exactly(2))->method('secondFactorAttempt')->willReturnOnConsecutiveCalls(false, true);
        $this->mfa->expects($this->once())->method('secondFactorPassed');
        $this->mfa->method('disable')->willReturn(['affectedApps' => []]);

        // Over the budget the recovery code is not read, so it is not spent…
        $this->assertSame(429, $this->ask($route, self::RECOVERY_CODE)[0]);
        $this->assertSame(json_encode([hash('sha256', 'AAAAABBBBB')]), $this->account()['mfa_recovery_codes']);
        // …and within it the same code still works.
        $this->assertSame(200, $this->ask($route, self::RECOVERY_CODE)[0]);
    }

    #[DataProvider('routesThatTakeACode')]
    public function testARequestWithNoCodeInItIsNoGuess(string $route): void
    {
        $this->auth->method('verifyPassword')->willReturn(true);
        $this->mfa->expects($this->never())->method('secondFactorAttempt');
        $this->mfa->expects($this->never())->method('disable');

        $this->assertSame(403, $this->ask($route, '')[0]);
        $this->assertSame(403, $this->ask($route, '   ')[0]);
    }

    public function testAnAccountWithoutTwoFactorHasNoCodeToGuessAt(): void
    {
        $this->pdo->exec("UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, mfa_recovery_codes = NULL WHERE id = 'user-1'");
        $this->auth->method('verifyPassword')->willReturn(true);
        $this->mfa->expects($this->never())->method('secondFactorAttempt');

        $this->assertSame(403, $this->ask('recovery-codes', '123456')[0]);
        $this->assertSame(403, $this->ask('disable', '123456')[0]);
    }

    public function testAWrongPasswordNeverReachesTheCode(): void
    {
        $this->auth->method('verifyPassword')->willReturn(false);
        $this->mfa->expects($this->never())->method('secondFactorAttempt');

        $this->assertSame(403, $this->ask('disable', $this->rightCode())[0]);
        $this->assertSame(403, $this->ask('admin-confirm', $this->rightCode())[0]);
        $this->assertNull($this->account()['mfa_last_totp_step']);
    }

    // ── Finishing the setup ──────────────────────────────────────────────────
    //
    // A setup its owner started and left has a secret that a session held by someone else never
    // saw. Guessing its code right would turn two-factor on and hand over the recovery codes.

    private function leaveASetupUnfinished(): void
    {
        $this->pdo->exec("UPDATE users SET mfa_enabled = 0, mfa_recovery_codes = NULL WHERE id = 'user-1'");
    }

    /** @return array{0: int, 1: array<string, mixed>} */
    private function finishSetup(string $code): array
    {
        return self::answer($this->controller->mfaEnable($this->post('/api/auth/mfa/enable', ['code' => $code]), (new ResponseFactory())->createResponse()));
    }

    public function testTheSetupsCodeIsNotReadOverTheBudget(): void
    {
        $this->leaveASetupUnfinished();
        $this->mfa->expects($this->once())->method('secondFactorAttempt')->with('user-1')->willReturn(false);
        $this->mfa->expects($this->never())->method('secondFactorPassed');
        $this->auth->expects($this->never())->method('revokeTokens');

        [$status, $body] = $this->finishSetup($this->rightCode());

        $this->assertSame(429, $status);
        $this->assertSame(self::LOCKED, $body['message']);
        $this->assertArrayNotHasKey('recoveryCodes', $body);
        $this->assertSame(0, (int) $this->account()['mfa_enabled']);
        $this->assertNull($this->account()['mfa_recovery_codes']);
    }

    public function testTheSetupsCodeIsNotReadWhenItCannotBeCounted(): void
    {
        $this->leaveASetupUnfinished();
        $this->mfa->method('secondFactorAttempt')->willReturn(null);

        [$status, $body] = $this->finishSetup($this->rightCode());

        $this->assertSame(503, $status);
        $this->assertTrue($body['retryable']);
        $this->assertSame(0, (int) $this->account()['mfa_enabled']);
    }

    public function testAWrongSetupCodeIsCountedAndTheCountStands(): void
    {
        $this->leaveASetupUnfinished();
        $this->mfa->expects($this->once())->method('secondFactorAttempt')->with('user-1')->willReturn(true);
        $this->mfa->expects($this->never())->method('secondFactorPassed');

        [$status, $body] = $this->finishSetup($this->wrongCode());

        $this->assertSame(400, $status);
        $this->assertStringContainsString('didn\'t match', $body['message']);
        $this->assertSame(0, (int) $this->account()['mfa_enabled']);
    }

    public function testTheRightSetupCodeTurnsTwoFactorOnAndEndsTheCount(): void
    {
        $this->leaveASetupUnfinished();
        $this->mfa->expects($this->once())->method('secondFactorAttempt')->with('user-1')->willReturn(true);
        $this->mfa->expects($this->once())->method('secondFactorPassed')->with('user-1');

        [$status, $body] = $this->finishSetup($this->rightCode());

        $this->assertSame(200, $status);
        $this->assertCount(8, $body['recoveryCodes']);
        $this->assertSame(1, (int) $this->account()['mfa_enabled']);
    }

    public function testARequestThatChecksNoSetupCodeIsNotCounted(): void
    {
        $this->mfa->expects($this->never())->method('secondFactorAttempt');
        $this->mfa->expects($this->never())->method('secondFactorPassed');

        // Two-factor is already on: there is no setup to finish, so no code is looked at.
        $this->assertSame(400, $this->finishSetup($this->rightCode())[0]);
        // No setup was started.
        $this->pdo->exec("UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, mfa_recovery_codes = NULL WHERE id = 'user-1'");
        $this->assertSame(400, $this->finishSetup('123456')[0]);
        // A setup is waiting, and the request has no code in it.
        $this->pdo->prepare("UPDATE users SET mfa_secret = ? WHERE id = 'user-1'")->execute([$this->secret]);
        $this->assertSame(400, $this->finishSetup('')[0]);
        $this->assertSame(0, (int) $this->account()['mfa_enabled']);
    }
}

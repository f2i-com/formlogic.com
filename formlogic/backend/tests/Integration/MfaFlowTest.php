<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\AuthService;
use FormLogic\Services\MfaService;
use FormLogic\Services\TotpService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * TOTP MFA acceptance:
 *  - enrollment is pending until a valid code proves the authenticator, then
 *    recovery codes mint (plaintext once, hashes stored);
 *  - the challenge accepts a live TOTP code and a recovery code exactly ONCE;
 *  - trusted browsers: minted token verifies (usage tracked), garbage doesn't,
 *    revocation works, disable wipes everything;
 *  - the pending-MFA token bridges password→code and is NOT a session token
 *    (and a session token is not a pending token).
 */
class MfaFlowTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static AuthService $auth;
    private static MfaService $mfa;
    private static TotpService $totp;

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
        self::$totp = new TotpService();
        self::$mfa = new MfaService($conn, self::$totp);
        self::$auth = new AuthService($conn, [
            'secret' => 'test-secret-key-for-mfa-flow-test-0123456789',
            'algorithm' => 'HS256',
            'issuer' => 'formlogic',
            'audience' => 'formlogic-api',
            'expiry' => 3600,
        ]);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->userId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, 'T')")
            ->execute([$this->userId, $this->userId . '@test.local', password_hash('correct-horse', PASSWORD_DEFAULT)]);
    }

    protected function tearDown(): void
    {
        if (self::$pdo !== null && $this->userId !== '') {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
        }
    }

    private function currentCode(string $secret): string
    {
        return self::$totp->code($secret, intdiv(time(), TotpService::PERIOD));
    }

    public function testEnrollmentIsPendingUntilProvenThenMintsRecoveryCodes(): void
    {
        $setup = self::$mfa->beginSetup($this->userId, 'x@test.local');
        $this->assertMatchesRegularExpression('/^[A-Z2-7]{32}$/', $setup['secret']);
        $this->assertStringStartsWith('otpauth://totp/', $setup['uri']);
        $this->assertFalse(self::$mfa->isEnabled($this->userId), 'pending setup must not gate logins');

        // A wrong code refuses to enable.
        try {
            self::$mfa->enable($this->userId, '000000');
            $this->fail('wrong code enabled MFA');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('didn\'t match', $e->getMessage());
        }

        $codes = self::$mfa->enable($this->userId, $this->currentCode($setup['secret']));
        $this->assertCount(8, $codes);
        $this->assertMatchesRegularExpression('/^[A-Z2-9]{5}-[A-Z2-9]{5}$/', $codes[0]);
        $this->assertTrue(self::$mfa->isEnabled($this->userId));

        $status = self::$mfa->status($this->userId);
        $this->assertTrue($status['enabled']);
        $this->assertSame(8, $status['recoveryCodesRemaining']);
    }

    public function testChallengeAcceptsTotpAndSingleUseRecoveryCodes(): void
    {
        $setup = self::$mfa->beginSetup($this->userId, 'x@test.local');
        $codes = self::$mfa->enable($this->userId, $this->currentCode($setup['secret']));

        $this->assertTrue(self::$mfa->verifyChallenge($this->userId, $this->currentCode($setup['secret'])));
        $this->assertFalse(self::$mfa->verifyChallenge($this->userId, '000000'));

        // Recovery code: works once (case/dash-insensitively), then is consumed.
        $recovery = strtolower(str_replace('-', ' ', $codes[3]));
        $this->assertTrue(self::$mfa->verifyChallenge($this->userId, $recovery));
        $this->assertFalse(self::$mfa->verifyChallenge($this->userId, $recovery), 'recovery codes are single-use');
        $this->assertSame(7, self::$mfa->status($this->userId)['recoveryCodesRemaining']);

        // Regeneration invalidates the remaining old set.
        $fresh = self::$mfa->regenerateRecoveryCodes($this->userId);
        $this->assertCount(8, $fresh);
        $this->assertFalse(self::$mfa->verifyChallenge($this->userId, $codes[5]), 'old set invalidated');
        $this->assertTrue(self::$mfa->verifyChallenge($this->userId, $fresh[0]));
    }

    public function testTrustedBrowsersTrackRevokeAndDieWithDisable(): void
    {
        $setup = self::$mfa->beginSetup($this->userId, 'x@test.local');
        self::$mfa->enable($this->userId, $this->currentCode($setup['secret']));

        $token = self::$mfa->mintTrust($this->userId, 'Mozilla/5.0 TestBrowser');
        $this->assertTrue(self::$mfa->checkTrust($this->userId, $token));
        $this->assertFalse(self::$mfa->checkTrust($this->userId, 'garbage'));
        $this->assertFalse(self::$mfa->checkTrust($this->userId, null));
        $this->assertFalse(self::$mfa->checkTrust('someone-else', $token), 'trust is per-user');

        $status = self::$mfa->status($this->userId, $token);
        $this->assertCount(1, $status['trustedBrowsers']);
        $this->assertTrue($status['trustedBrowsers'][0]['current']);
        $this->assertSame('Mozilla/5.0 TestBrowser', $status['trustedBrowsers'][0]['label']);

        $this->assertTrue(self::$mfa->revokeTrust($this->userId, $status['trustedBrowsers'][0]['id']));
        $this->assertFalse(self::$mfa->checkTrust($this->userId, $token), 'revoked browser re-prompts');

        // Disable wipes secret, codes and any remaining trust rows.
        self::$mfa->mintTrust($this->userId, 'Another');
        self::$mfa->disable($this->userId);
        $this->assertFalse(self::$mfa->isEnabled($this->userId));
        $count = self::$pdo->prepare('SELECT COUNT(*) FROM mfa_trusted_browsers WHERE user_id = ?');
        $count->execute([$this->userId]);
        $this->assertSame(0, (int) $count->fetchColumn());
    }

    public function testPendingTokenBridgesButNeverActsAsASession(): void
    {
        $user = self::$auth->getUserById($this->userId);
        $this->assertNotNull($user);

        $pending = self::$auth->issueMfaPendingToken($user);
        $this->assertNotSame('', $pending['jti']);
        $bridged = self::$auth->consumeMfaPendingToken($pending['token']);
        $this->assertNotNull($bridged);
        $this->assertSame($this->userId, $bridged['user']->id);
        $this->assertSame($pending['jti'], $bridged['jti'], 'the jti rides the token to the challenge gate');

        // The pending token is NOT a session; a session is NOT a pending token.
        $this->assertNull(self::$auth->validateToken($pending['token']), 'pending token must not authenticate requests');
        $session = self::$auth->issueToken($user);
        $this->assertNull(self::$auth->consumeMfaPendingToken($session), 'session token must not answer the MFA bridge');
        $this->assertNull(self::$auth->consumeMfaPendingToken('garbage'));

        // Credential change (token_version bump) kills outstanding pending tokens.
        self::$auth->revokeTokens($this->userId);
        $this->assertNull(self::$auth->consumeMfaPendingToken($pending['token']));
    }

    // ── Audit MFA-001: one-time challenges, attempt budgets, revoking resets ──

    public function testChallengeIsClaimedExactlyOnce(): void
    {
        self::$mfa->registerChallenge($this->userId, 'jti-once-' . $this->userId);

        $this->assertTrue(self::$mfa->challengeAttempt('jti-once-' . $this->userId));
        $this->assertTrue(self::$mfa->claimChallenge('jti-once-' . $this->userId), 'first exchange wins');
        $this->assertFalse(self::$mfa->claimChallenge('jti-once-' . $this->userId), 'replay must not mint a second session');
        $this->assertFalse(self::$mfa->challengeAttempt('jti-once-' . $this->userId), 'a consumed challenge refuses further answers');

        $this->assertFalse(self::$mfa->claimChallenge('never-registered'), 'unknown challenges refuse');
        $this->assertFalse(self::$mfa->challengeAttempt('never-registered'));
    }

    public function testChallengeBurnsAfterItsAttemptBudget(): void
    {
        self::$mfa->registerChallenge($this->userId, 'jti-burn-' . $this->userId);
        for ($i = 0; $i < MfaService::CHALLENGE_MAX_ATTEMPTS; $i++) {
            $this->assertTrue(self::$mfa->challengeAttempt('jti-burn-' . $this->userId), "attempt {$i} within budget");
        }
        $this->assertFalse(self::$mfa->challengeAttempt('jti-burn-' . $this->userId), 'budget exhausted');
        $this->assertTrue(self::$mfa->claimChallenge('jti-burn-' . $this->userId), 'burning attempts does not consume the row for a correct late answer within its window');
    }

    // ── The account's own budget of code answers, across prompts and addresses ──

    private function forgetSecondFactorCount(string $userId): void
    {
        self::$pdo->prepare('DELETE FROM rate_limits WHERE bucket = ?')->execute([hash('sha256', 'mfa_fail:' . $userId)]);
    }

    public function testAnAccountsCodeAnswersAreCountedWhicheverPromptTheyAnswer(): void
    {
        $other = 'someone-else-' . $this->userId;
        try {
            $this->assertFalse(self::$mfa->secondFactorLocked($this->userId));
            for ($i = 1; $i <= MfaService::SECOND_FACTOR_MAX_ATTEMPTS; $i++) {
                $this->assertTrue(self::$mfa->secondFactorAttempt($this->userId), "answer {$i} is within the budget");
            }
            $this->assertTrue(self::$mfa->secondFactorLocked($this->userId), 'the next answer would be refused, so no prompt is given');
            $this->assertFalse(self::$mfa->secondFactorAttempt($this->userId), 'one more than the budget');
            $this->assertTrue(self::$mfa->secondFactorAttempt($other), 'the count is the account\'s own');

            self::$mfa->secondFactorPassed($this->userId);
            $this->assertFalse(self::$mfa->secondFactorLocked($this->userId), 'a right answer ends the count');
            $this->assertTrue(self::$mfa->secondFactorAttempt($this->userId));
        } finally {
            $this->forgetSecondFactorCount($this->userId);
            $this->forgetSecondFactorCount($other);
        }
    }

    public function testWrongCodesOverFreshPromptsStopTheAccountBeingAsked(): void
    {
        $setup = self::$mfa->beginSetup($this->userId, 'x@test.local');
        self::$mfa->enable($this->userId, $this->currentCode($setup['secret']));
        // The enabling code's time step is spent; a sign-in code has to come from a later one.
        $nextCode = self::$totp->code($setup['secret'], intdiv(time(), TotpService::PERIOD) + 1);
        $controller = new \FormLogic\Controllers\AuthController(self::$auth, mfaService: self::$mfa);
        $post = static fn (string $path, array $body) => (new \Slim\Psr7\Factory\ServerRequestFactory())
            ->createServerRequest('POST', 'http://formlogic.local' . $path)->withParsedBody($body);
        $json = static fn (\Psr\Http\Message\ResponseInterface $r): array => json_decode((string) $r->getBody(), true) ?: [];
        $newResponse = static fn () => (new \Slim\Psr7\Factory\ResponseFactory())->createResponse();
        $signIn = fn () => $controller->login($post('/api/auth/login', ['email' => $this->userId . '@test.local', 'password' => 'correct-horse']), $newResponse());
        $answer = fn (string $token, string $code) => $controller->mfaVerify($post('/api/auth/mfa/verify', ['mfaToken' => $token, 'code' => $code]), $newResponse());

        try {
            // Whoever knows the password gets a new prompt for the asking: three of them.
            $prompts = [];
            for ($i = 0; $i < 3; $i++) {
                $asked = $json($signIn());
                $this->assertTrue($asked['mfaRequired'] ?? false);
                $prompts[] = (string) $asked['mfaToken'];
            }
            // Two prompts' worth of wrong answers is the account's whole budget.
            foreach ([$prompts[0], $prompts[1]] as $prompt) {
                for ($i = 0; $i < MfaService::CHALLENGE_MAX_ATTEMPTS; $i++) {
                    $wrong = $answer($prompt, '000000');
                    $this->assertSame(401, $wrong->getStatusCode());
                    $this->assertStringContainsString('didn\'t match', $json($wrong)['message']);
                }
            }

            // The third prompt was untouched, and the right code no longer opens it…
            $refused = $answer($prompts[2], $nextCode);
            $this->assertSame(429, $refused->getStatusCode());
            $this->assertStringStartsWith('Too many incorrect verification codes', $json($refused)['message']);
            $this->assertSame([], $refused->getHeader('Set-Cookie'), 'no session');
            // …nor does the password get a fourth.
            $unasked = $signIn();
            $this->assertSame(429, $unasked->getStatusCode());
            $this->assertArrayNotHasKey('mfaToken', $json($unasked));

            // Once the window has passed the same prompt and code sign in, and the count ends.
            $this->forgetSecondFactorCount($this->userId);
            $signedIn = $answer($prompts[2], $nextCode);
            $this->assertSame(200, $signedIn->getStatusCode(), (string) $signedIn->getBody());
            $this->assertSame($this->userId, $json($signedIn)['user']['id'] ?? null);
            $this->assertFalse(self::$mfa->secondFactorLocked($this->userId));
        } finally {
            $this->forgetSecondFactorCount($this->userId);
        }
    }

    /** What the service answers to one code asked for inside a session: true, false, or the refusal it threw. */
    private function sessionAnswer(string $code): bool|\RuntimeException
    {
        try {
            return self::$mfa->verifySessionCode($this->userId, $code);
        } catch (\FormLogic\Services\SecondFactorLockedException | \FormLogic\Services\RateLimiterUnavailableException $e) {
            return $e;
        }
    }

    // Turning two-factor off, new recovery codes and an administrator's confirmation ask a session
    // for a code. Their answers come out of the account's one budget, so a session someone else
    // holds gets ten guesses in fifteen minutes there too, not ten a minute.
    public function testCodesAskedForInsideASessionDrawOnTheSameBudget(): void
    {
        $setup = self::$mfa->beginSetup($this->userId, 'x@test.local');
        $codes = self::$mfa->enable($this->userId, $this->currentCode($setup['secret']));
        try {
            $this->assertFalse(self::$mfa->secondFactorLocked($this->userId), 'the right setup code ended its own count');
            // A right answer ends the count: nine wrong and one right leave the budget whole.
            for ($i = 1; $i < MfaService::SECOND_FACTOR_MAX_ATTEMPTS; $i++) {
                $this->assertFalse($this->sessionAnswer('000000'), "wrong answer {$i} is read and refused");
            }
            $this->assertTrue($this->sessionAnswer($codes[1]));
            for ($i = 1; $i <= MfaService::SECOND_FACTOR_MAX_ATTEMPTS; $i++) {
                $this->assertFalse($this->sessionAnswer('000000'), "wrong answer {$i} is read and refused");
            }

            // Over the budget not even a right code is read, and the sign-in prompt closes with it.
            $refused = $this->sessionAnswer($codes[0]);
            $this->assertInstanceOf(\FormLogic\Services\SecondFactorLockedException::class, $refused);
            $this->assertStringStartsWith('Too many incorrect verification codes', $refused->getMessage());
            $this->assertTrue(self::$mfa->secondFactorLocked($this->userId));
            // A request with no code in it is no guess, over the budget or within it.
            $this->assertFalse($this->sessionAnswer(''));

            // Once the window has passed the same recovery code works: it was never spent.
            $this->forgetSecondFactorCount($this->userId);
            $this->assertTrue($this->sessionAnswer($codes[0]));
            $this->assertFalse(self::$mfa->secondFactorLocked($this->userId));
        } finally {
            $this->forgetSecondFactorCount($this->userId);
        }
    }

    public function testTheCodeThatFinishesASetupDrawsOnTheSameBudget(): void
    {
        $setup = self::$mfa->beginSetup($this->userId, 'x@test.local');
        $finish = function (string $code): array|\RuntimeException {
            try {
                return self::$mfa->enable($this->userId, $code);
            } catch (\RuntimeException $e) {
                return $e;
            }
        };
        try {
            for ($i = 1; $i <= MfaService::SECOND_FACTOR_MAX_ATTEMPTS; $i++) {
                $wrong = $finish('000000');
                $this->assertInstanceOf(\RuntimeException::class, $wrong);
                $this->assertStringContainsString('didn\'t match', $wrong->getMessage(), "wrong answer {$i} is read and refused");
            }
            // Over the budget the right code is not read, and two-factor stays off.
            $this->assertInstanceOf(\FormLogic\Services\SecondFactorLockedException::class, $finish($this->currentCode($setup['secret'])));
            $this->assertFalse(self::$mfa->isEnabled($this->userId));

            $this->forgetSecondFactorCount($this->userId);
            $codes = $finish($this->currentCode($setup['secret']));
            $this->assertIsArray($codes);
            $this->assertCount(8, $codes);
            $this->assertTrue(self::$mfa->isEnabled($this->userId));
            $this->assertFalse(self::$mfa->secondFactorLocked($this->userId), 'the right code ended the count');
        } finally {
            $this->forgetSecondFactorCount($this->userId);
        }
    }

    public function testThePasswordAloneDoesNotEndTheAccountsSignInCount(): void
    {
        $email = $this->userId . '@test.local';
        // Without two-factor a right password is the whole sign-in: the count ends each time.
        for ($i = 0; $i < 12; $i++) {
            $this->assertSame($email, self::$auth->login($email, 'correct-horse', '198.51.100.' . $i)['user']['email']);
        }

        $setup = self::$mfa->beginSetup($this->userId, 'x@test.local');
        self::$mfa->enable($this->userId, $this->currentCode($setup['secret']));
        // With it on, each right password only asks for a code, and all of them count.
        for ($i = 0; $i < 10; $i++) {
            self::$auth->login($email, 'correct-horse', '203.0.113.' . $i);
        }
        try {
            self::$auth->login($email, 'correct-horse', '203.0.113.99');
            $this->fail('an eleventh code prompt was given for the password alone');
        } catch (\RuntimeException $refused) {
            $this->assertStringStartsWith('Too many login attempts for this account', $refused->getMessage());
        }

        // The code (or a remembered browser) completes the sign-in, and that ends the count.
        self::$auth->signInCompleted(self::$auth->getUserById($this->userId));
        $this->assertSame($email, self::$auth->login($email, 'correct-horse', '203.0.113.100')['user']['email']);
        self::$auth->signInCompleted(self::$auth->getUserById($this->userId));
    }

    public function testDisableRevokesSessionsChallengesAndTrust(): void
    {
        $setup = self::$mfa->beginSetup($this->userId, 'x@test.local');
        self::$mfa->enable($this->userId, $this->currentCode($setup['secret']));
        self::$mfa->mintTrust($this->userId, 'Browser');
        self::$mfa->registerChallenge($this->userId, 'jti-dis-' . $this->userId);

        $user = self::$auth->getUserById($this->userId);
        $this->assertNotNull($user);
        $session = self::$auth->issueToken($user);
        $pending = self::$auth->issueMfaPendingToken($user);
        $this->assertNotNull(self::$auth->validateToken($session));

        self::$mfa->disable($this->userId);

        $this->assertNull(self::$auth->validateToken($session), 'old sessions die with the reset (token_version bump)');
        $this->assertNull(self::$auth->consumeMfaPendingToken($pending['token']), 'outstanding pending tokens die too');
        $count = self::$pdo->prepare('SELECT COUNT(*) FROM mfa_trusted_browsers WHERE user_id = ?');
        $count->execute([$this->userId]);
        $this->assertSame(0, (int) $count->fetchColumn());
        $chal = self::$pdo->prepare('SELECT COUNT(*) FROM mfa_challenges WHERE user_id = ?');
        $chal->execute([$this->userId]);
        $this->assertSame(0, (int) $chal->fetchColumn());
    }

    // Someone locked out by wrong codes is let back in by an administrator's reset, which is this
    // same disable(). The count against the factor that went must go with it, or the code of the
    // setup they start next would be refused unread.
    public function testDisableEndsTheCountOfCodeAnswersSoANewSetupCanFinish(): void
    {
        $setup = self::$mfa->beginSetup($this->userId, 'x@test.local');
        self::$mfa->enable($this->userId, $this->currentCode($setup['secret']));
        try {
            for ($i = 0; $i <= MfaService::SECOND_FACTOR_MAX_ATTEMPTS; $i++) {
                self::$mfa->secondFactorAttempt($this->userId);
            }
            $this->assertTrue(self::$mfa->secondFactorLocked($this->userId));

            self::$mfa->disable($this->userId);

            $this->assertFalse(self::$mfa->secondFactorLocked($this->userId));
            $again = self::$mfa->beginSetup($this->userId, 'x@test.local');
            $this->assertCount(8, self::$mfa->enable($this->userId, $this->currentCode($again['secret'])));
        } finally {
            $this->forgetSecondFactorCount($this->userId);
        }
    }

    public function testDisableRollsBackAtomicallyOnPartialFailure(): void
    {
        $setup = self::$mfa->beginSetup($this->userId, 'x@test.local');
        self::$mfa->enable($this->userId, $this->currentCode($setup['secret']));
        self::$mfa->mintTrust($this->userId, 'Survivor');

        $root = dirname(__DIR__, 2);
        $config = [
            'host' => $_ENV['DB_HOST'] ?? '127.0.0.1',
            'port' => $_ENV['DB_PORT'] ?? '3306',
            'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
            'username' => $_ENV['DB_USERNAME'] ?? 'root',
            'password' => $_ENV['DB_PASSWORD'] ?? '',
            'charset' => 'utf8mb4',
            'collation' => 'utf8mb4_unicode_ci',
        ];
        $proxy = new MfaFailingPdo(
            sprintf('mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4', $config['host'], $config['port'], $config['database']),
            $config['username'],
            $config['password'],
            [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]
        );
        $conn = new class ($config, $proxy) extends MySQLConnection {
            private PDO $proxyPdo;
            public function __construct(array $config, PDO $proxy)
            {
                parent::__construct($config);
                $this->proxyPdo = $proxy;
            }
            public function getConnection(): PDO
            {
                return $this->proxyPdo;
            }
        };
        $failingMfa = new MfaService($conn, self::$totp);

        $proxy->failTrustDelete = true;
        try {
            $failingMfa->disable($this->userId);
            $this->fail('disable must surface the partial failure');
        } catch (\Throwable $e) {
            $this->assertStringContainsString('injected', $e->getMessage());
        }

        // The WHOLE reset rolled back: MFA still on, secret intact, trust row alive.
        $this->assertTrue(self::$mfa->isEnabled($this->userId), 'partial failure must not leave MFA half-disabled');
        $row = self::$pdo->prepare('SELECT mfa_secret FROM users WHERE id = ?');
        $row->execute([$this->userId]);
        $this->assertNotEmpty($row->fetchColumn());
        $count = self::$pdo->prepare('SELECT COUNT(*) FROM mfa_trusted_browsers WHERE user_id = ?');
        $count->execute([$this->userId]);
        $this->assertSame(1, (int) $count->fetchColumn());
    }

    public function testRecoveryCodeDoubleSpendLosesEvenWithStaleRead(): void
    {
        $setup = self::$mfa->beginSetup($this->userId, 'x@test.local');
        $codes = self::$mfa->enable($this->userId, $this->currentCode($setup['secret']));

        // Simulate the classic read/modify/write race: capture the stored set,
        // consume a code, then restore the STALE set and consume a different
        // code — the compare-and-swap retries from a fresh read, so the fresh
        // state (code 0 gone) is what gets rewritten, and the already-spent
        // code still refuses.
        $stale = self::$pdo->prepare('SELECT mfa_recovery_codes FROM users WHERE id = ?');
        $stale->execute([$this->userId]);
        $staleJson = (string) $stale->fetchColumn();

        $this->assertTrue(self::$mfa->verifyChallenge($this->userId, $codes[0]));
        $this->assertFalse(self::$mfa->verifyChallenge($this->userId, $codes[0]), 'double-spend refused');

        self::$pdo->prepare('UPDATE users SET mfa_recovery_codes = ? WHERE id = ?')
            ->execute([$staleJson, $this->userId]);
        $this->assertTrue(self::$mfa->verifyChallenge($this->userId, $codes[0]), 'restored stale set makes code 0 valid again (precondition)');
        $this->assertFalse(self::$mfa->verifyChallenge($this->userId, $codes[0]), 'and single-use holds again');
    }
}

/**
 * PDO double failing exactly the trusted-browser DELETE inside MfaService::disable()
 * — proves the reset is one transaction (audit MFA-001).
 */
class MfaFailingPdo extends PDO
{
    public bool $failTrustDelete = false;

    #[\ReturnTypeWillChange]
    public function prepare($query, $options = [])
    {
        if ($this->failTrustDelete && str_contains($query, 'DELETE FROM mfa_trusted_browsers')) {
            throw new \RuntimeException('injected mfa_trusted_browsers DELETE failure');
        }
        return parent::prepare($query, $options);
    }
}

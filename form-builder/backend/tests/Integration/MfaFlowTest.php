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

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
        $bridged = self::$auth->consumeMfaPendingToken($pending);
        $this->assertNotNull($bridged);
        $this->assertSame($this->userId, $bridged->id);

        // The pending token is NOT a session; a session is NOT a pending token.
        $this->assertNull(self::$auth->validateToken($pending), 'pending token must not authenticate requests');
        $session = self::$auth->issueToken($user);
        $this->assertNull(self::$auth->consumeMfaPendingToken($session), 'session token must not answer the MFA bridge');
        $this->assertNull(self::$auth->consumeMfaPendingToken('garbage'));

        // Credential change (token_version bump) kills outstanding pending tokens.
        self::$auth->revokeTokens($this->userId);
        $this->assertNull(self::$auth->consumeMfaPendingToken($pending));
    }
}

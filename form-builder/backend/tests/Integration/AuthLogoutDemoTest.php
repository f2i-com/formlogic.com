<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\AuthController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Models\User;
use FormLogic\Services\AuthService;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * Regression for the demo-logout DoS: every /api/demo/start call resolves to the SAME shared
 * "Demo" user row (AuthService::ensureDemoUser), so AuthController::logout() unconditionally
 * bumping token_version (sign-out-everywhere) invalidated every OTHER concurrent demo visitor's
 * JWT too — a trivial, unauthenticated, repeatable DoS against the live demo via either
 * DemoBanner button. logout() must skip revokeTokens() for the shared demo account while still
 * doing it for a real account (unchanged "sign out everywhere" behavior).
 * Skipped without a test database.
 */
class AuthLogoutDemoTest extends TestCase
{
    private const DEMO_EMAIL = 'demo-logout-regression@formlogic.test';

    private static ?MySQLConnection $mysql = null;
    private static AuthService $authService;
    private static AuthController $controller;

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

        // AuthController::demoEmail() reads $_ENV['DEMO_EMAIL'], so pin it to a
        // dedicated test address rather than whatever the real demo is configured to.
        $_ENV['DEMO_EMAIL'] = self::DEMO_EMAIL;

        $jwtConfig = [
            'secret' => 'test-secret-for-auth-logout-demo-test',
            'algorithm' => 'HS256',
            'issuer' => 'formlogic',
            'audience' => 'formlogic-api',
            'expiry' => 3600,
        ];
        self::$authService = new AuthService($conn, $jwtConfig);
        self::$controller = new AuthController(self::$authService);
    }

    private function logoutAs(User $user): void
    {
        $request = (new ServerRequestFactory())
            ->createServerRequest('POST', 'http://formlogic.local/api/auth/logout')
            ->withAttribute('user', $user)
            ->withAttribute('userId', $user->id);
        self::$controller->logout($request, (new ResponseFactory())->createResponse());
    }

    /**
     * Two demo visitors resolve to the same shared row. One of them logging out must not
     * invalidate the other's still-live token.
     */
    public function testDemoLogoutDoesNotRevokeOtherDemoVisitorsToken(): void
    {
        // Simulates two separate POST /api/demo/start calls, i.e. two different visitors.
        $demoUser = self::$authService->ensureDemoUser(self::DEMO_EMAIL);
        $visitorAToken = self::$authService->issueToken($demoUser);
        $visitorBToken = self::$authService->issueToken($demoUser);

        // Sanity: both tokens are valid before anyone logs out.
        $this->assertNotNull(self::$authService->validateToken($visitorAToken));
        $this->assertNotNull(self::$authService->validateToken($visitorBToken));

        // Visitor A leaves via a button that calls logout() (e.g. DemoBanner).
        $this->logoutAs($demoUser);

        // Visitor B must still be logged in — the shared demo account's token_version
        // must not have been bumped by A's logout.
        $this->assertNotNull(
            self::$authService->validateToken($visitorBToken),
            'logout() from one demo visitor must not invalidate another demo visitor\'s session'
        );
    }

    /**
     * Control case: an ordinary (non-demo) account logging out must still revoke its
     * outstanding tokens exactly as before this fix.
     */
    public function testRealAccountLogoutStillRevokesTokens(): void
    {
        $email = 'auth-logout-control-' . bin2hex(random_bytes(4)) . '@formlogic.test';
        $result = self::$authService->register($email, 'a-strong-password-123', 'Real User');
        $user = User::fromArray($result['user']);
        $token = self::$authService->issueToken($user);

        $this->assertNotNull(self::$authService->validateToken($token));

        $this->logoutAs($user);

        $this->assertNull(
            self::$authService->validateToken($token),
            'logout() for a real (non-demo) account must still invalidate its outstanding tokens'
        );
    }
}

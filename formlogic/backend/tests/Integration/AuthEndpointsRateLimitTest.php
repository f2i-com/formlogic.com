<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\AuthController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Middleware\RateLimitMiddleware;
use FormLogic\Services\AuthService;
use FormLogic\Services\RateLimiter;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * Coverage for the 3 auth security gaps closed in this pass:
 *
 *  1. PUT/DELETE /api/auth/me get a NEW per-user rate limiter (keyPrefix
 *     'auth_me_mutation', 10 req / 60s, keyByUser=true) so a stolen session can't
 *     brute-force the real password via the currentPassword check with zero throttling.
 *  2. AuthService::requestPasswordReset() gets a NEW per-email rate limit (4 req / 3600s,
 *     keyed on the raw submitted email string, checked BEFORE the existence lookup) so
 *     an attacker can't email-bomb an address; AuthController::forgotPassword() surfaces
 *     ONLY that specific exception as 429 while every other case (incl. "no such account")
 *     keeps the exact same generic 200 response, preserving enumeration-safety.
 *  3. The old shared 'auth' IP bucket (register+login+forgot+reset) is split into
 *     'auth_login' (register/login) and 'auth_password_reset' (forgot/reset), so spending
 *     login's budget can't artificially throttle a legitimate password-reset attempt.
 *
 * Also covers basic register+login happy path and the wrong-password generic error, since
 * there was previously zero endpoint-level coverage of /register, /login, /forgot-password,
 * /reset-password (only PasswordPolicyTest covers password validation in isolation).
 *
 * Skipped without a test database, following AuthLogoutDemoTest's exact setup pattern.
 */
class AuthEndpointsRateLimitTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static AuthService $authService;
    private static AuthController $controller;
    private static RateLimiter $rateLimiter;

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

        $jwtConfig = [
            'secret' => 'test-secret-for-auth-rate-limit-test',
            'algorithm' => 'HS256',
            'issuer' => 'formlogic',
            'audience' => 'formlogic-api',
            'expiry' => 3600,
        ];
        self::$authService = new AuthService($conn, $jwtConfig);
        self::$controller = new AuthController(self::$authService);
        self::$rateLimiter = new RateLimiter($conn->getConnection());
    }

    private function jsonOf(ResponseInterface $response): array
    {
        return json_decode((string) $response->getBody(), true) ?: [];
    }

    private function uniqueEmail(string $label): string
    {
        return 'auth-rl-' . $label . '-' . bin2hex(random_bytes(6)) . '@formlogic.test';
    }

    // ---------------------------------------------------------------------
    // (a) Register + login happy path
    // ---------------------------------------------------------------------

    public function testRegisterAndLoginHappyPath(): void
    {
        $email = $this->uniqueEmail('happy');
        $password = 'a-strong-password-123';

        $registerRequest = (new ServerRequestFactory())
            ->createServerRequest('POST', 'http://formlogic.local/api/auth/register')
            ->withParsedBody(['email' => $email, 'password' => $password, 'name' => 'Happy Path']);
        $registerResponse = self::$controller->register($registerRequest, (new ResponseFactory())->createResponse());
        $this->assertSame(201, $registerResponse->getStatusCode());
        $this->assertSame($email, $this->jsonOf($registerResponse)['user']['email'] ?? null);

        $loginRequest = (new ServerRequestFactory())
            ->createServerRequest('POST', 'http://formlogic.local/api/auth/login')
            ->withParsedBody(['email' => $email, 'password' => $password]);
        $loginResponse = self::$controller->login($loginRequest, (new ResponseFactory())->createResponse());
        $this->assertSame(200, $loginResponse->getStatusCode());
        $this->assertSame($email, $this->jsonOf($loginResponse)['user']['email'] ?? null);
    }

    // ---------------------------------------------------------------------
    // (b) Wrong password -> generic, enumeration-safe error
    // ---------------------------------------------------------------------

    public function testLoginWithWrongPasswordReturnsGenericEnumerationSafeError(): void
    {
        $email = $this->uniqueEmail('wrongpw');
        $registerRequest = (new ServerRequestFactory())
            ->createServerRequest('POST', 'http://formlogic.local/api/auth/register')
            ->withParsedBody(['email' => $email, 'password' => 'a-strong-password-123']);
        self::$controller->register($registerRequest, (new ResponseFactory())->createResponse());

        $loginRequest = (new ServerRequestFactory())
            ->createServerRequest('POST', 'http://formlogic.local/api/auth/login')
            ->withParsedBody(['email' => $email, 'password' => 'totally-wrong-password']);
        $loginResponse = self::$controller->login($loginRequest, (new ResponseFactory())->createResponse());

        $this->assertSame(401, $loginResponse->getStatusCode());
        $this->assertSame('Invalid email or password', $this->jsonOf($loginResponse)['message'] ?? null);
    }

    // ---------------------------------------------------------------------
    // (c) Gap 1 — PUT/DELETE /me per-user rate limiter returns 429
    // ---------------------------------------------------------------------

    /**
     * The throttle itself lives in RateLimitMiddleware (registered around PUT/DELETE /me
     * in index.php), not in the controller methods — the controller is never reached once
     * the limit is exceeded. So this test exercises that middleware directly, constructed
     * with the exact same parameters used in index.php (10 req / 60s, keyPrefix
     * 'auth_me_mutation', keyByUser=true), wrapping a trivial stub handler. A random
     * per-run keyPrefix suffix keeps the test independent of any state left by a previous
     * run within the same 60s window.
     */
    public function testAccountMutationRateLimitReturns429AfterExceedingLimit(): void
    {
        $keyPrefix = 'auth_me_mutation_test_' . bin2hex(random_bytes(4));
        $limiter = new RateLimitMiddleware(self::$rateLimiter, 10, 60, $keyPrefix, true);

        $handler = new class implements RequestHandlerInterface {
            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                return (new ResponseFactory())->createResponse(200);
            }
        };

        $request = (new ServerRequestFactory())
            ->createServerRequest('PUT', 'http://formlogic.local/api/auth/me')
            ->withAttribute('userId', 'test-user-' . bin2hex(random_bytes(4)));

        for ($i = 1; $i <= 10; $i++) {
            $response = $limiter->process($request, $handler);
            $this->assertNotSame(429, $response->getStatusCode(), "Request $i of 10 should not be throttled yet");
        }

        // The 11th request within the window must be throttled.
        $blocked = $limiter->process($request, $handler);
        $this->assertSame(429, $blocked->getStatusCode());
        $this->assertSame('Too many requests. Please try again later.', $this->jsonOf($blocked)['message'] ?? null);
    }

    /**
     * Same limiter, but keyed by userId: a different user hitting the identical route at
     * the same time must not be affected by another user's exhausted budget (keyByUser
     * means IP rotation - or in this case, a shared IP - can't bypass or falsely trip it).
     */
    public function testAccountMutationRateLimitIsPerUserNotPerIp(): void
    {
        $keyPrefix = 'auth_me_mutation_test_' . bin2hex(random_bytes(4));
        $limiter = new RateLimitMiddleware(self::$rateLimiter, 10, 60, $keyPrefix, true);
        $handler = new class implements RequestHandlerInterface {
            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                return (new ResponseFactory())->createResponse(200);
            }
        };

        $userARequest = (new ServerRequestFactory())
            ->createServerRequest('DELETE', 'http://formlogic.local/api/auth/me')
            ->withAttribute('userId', 'user-a-' . bin2hex(random_bytes(4)));
        $userBRequest = (new ServerRequestFactory())
            ->createServerRequest('DELETE', 'http://formlogic.local/api/auth/me')
            ->withAttribute('userId', 'user-b-' . bin2hex(random_bytes(4)));

        for ($i = 1; $i <= 10; $i++) {
            $limiter->process($userARequest, $handler);
        }
        $userABlocked = $limiter->process($userARequest, $handler);
        $this->assertSame(429, $userABlocked->getStatusCode());

        // User B, same IP (both requests default to 127.0.0.1), fresh budget.
        $userBFirst = $limiter->process($userBRequest, $handler);
        $this->assertNotSame(429, $userBFirst->getStatusCode());
    }

    // ---------------------------------------------------------------------
    // (d) Gap 2 — per-email password-reset rate limit, enumeration-safe
    // ---------------------------------------------------------------------

    /**
     * The critical enumeration-safety assertion: an email with NO account behind it, and an
     * email that DOES have a real account, must produce byte-for-byte the same responses at
     * every step — including once the per-email rate limit trips. Hitting the limit is safe
     * to reveal (it only says "this email string was submitted too many times", a fact the
     * caller already knows) but it must never differ based on account existence.
     */
    public function testPasswordResetRateLimitIsEnumerationSafe(): void
    {
        $existingEmail = $this->uniqueEmail('exists');
        $registerRequest = (new ServerRequestFactory())
            ->createServerRequest('POST', 'http://formlogic.local/api/auth/register')
            ->withParsedBody(['email' => $existingEmail, 'password' => 'a-strong-password-123']);
        self::$controller->register($registerRequest, (new ResponseFactory())->createResponse());

        $nonexistentEmail = $this->uniqueEmail('ghost');

        $callForgotPassword = function (string $email) {
            $request = (new ServerRequestFactory())
                ->createServerRequest('POST', 'http://formlogic.local/api/auth/forgot-password')
                ->withParsedBody(['email' => $email]);
            return self::$controller->forgotPassword($request, (new ResponseFactory())->createResponse());
        };

        // Within the limit (PASSWORD_RESET_MAX_ATTEMPTS = 4): both emails get the exact
        // same generic 200, regardless of whether the account exists.
        for ($i = 1; $i <= 4; $i++) {
            $existingResp = $callForgotPassword($existingEmail);
            $ghostResp = $callForgotPassword($nonexistentEmail);

            $this->assertSame(200, $existingResp->getStatusCode(), "existing-email attempt $i");
            $this->assertSame(200, $ghostResp->getStatusCode(), "nonexistent-email attempt $i");
            $this->assertSame(
                'If an account exists for that email, a reset link has been sent.',
                $this->jsonOf($existingResp)['message'] ?? null
            );
            $this->assertSame(
                $this->jsonOf($existingResp)['message'] ?? null,
                $this->jsonOf($ghostResp)['message'] ?? null,
                'existing vs nonexistent email responses must be identical below the rate limit'
            );
        }

        // The 5th request for EACH email exceeds its own per-email budget (4/hour) and must
        // now surface as 429 — but identically so for both, since the limiter is keyed on
        // the raw email string, not on whether an account was found.
        $existingBlocked = $callForgotPassword($existingEmail);
        $ghostBlocked = $callForgotPassword($nonexistentEmail);

        $this->assertSame(429, $existingBlocked->getStatusCode());
        $this->assertSame(429, $ghostBlocked->getStatusCode());

        $pattern = '/^Too many password reset requests for this email\. Please try again in \d+ minute\(s\)\.$/';
        $existingMessage = (string) ($this->jsonOf($existingBlocked)['message'] ?? '');
        $ghostMessage = (string) ($this->jsonOf($ghostBlocked)['message'] ?? '');
        $this->assertMatchesRegularExpression($pattern, $existingMessage);
        $this->assertMatchesRegularExpression($pattern, $ghostMessage);
    }

    // ---------------------------------------------------------------------
    // (e) Gap 3 — split login vs password-reset buckets track independently
    // ---------------------------------------------------------------------

    /**
     * Tested at the RateLimitMiddleware/RateLimiter level (both IP-keyed, sharing the same
     * default 127.0.0.1 test-request IP) rather than through the full HTTP route table,
     * since that would require booting index.php's entire container — this is a faithful
     * proxy because both production limiters are constructed identically
     * (RateLimitMiddleware($rateLimiter, 10, 60, <prefix>)) and differ only in keyPrefix,
     * which is exactly the mechanism under test.
     */
    public function testLoginAndPasswordResetBucketsAreIndependent(): void
    {
        $suffix = bin2hex(random_bytes(4));
        $loginLimiter = new RateLimitMiddleware(self::$rateLimiter, 10, 60, 'auth_login_test_' . $suffix);
        $resetLimiter = new RateLimitMiddleware(self::$rateLimiter, 10, 60, 'auth_password_reset_test_' . $suffix);
        $handler = new class implements RequestHandlerInterface {
            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                return (new ResponseFactory())->createResponse(200);
            }
        };
        $request = (new ServerRequestFactory())->createServerRequest('POST', 'http://formlogic.local/api/auth/login');

        // Exhaust the login/register bucket.
        for ($i = 1; $i <= 10; $i++) {
            $loginLimiter->process($request, $handler);
        }
        $loginBlocked = $loginLimiter->process($request, $handler);
        $this->assertSame(429, $loginBlocked->getStatusCode(), 'login bucket should now be exhausted');

        // The independent forgot/reset bucket, from the same IP, must be untouched.
        $resetFirst = $resetLimiter->process($request, $handler);
        $this->assertNotSame(429, $resetFirst->getStatusCode(), 'password-reset bucket must not share login\'s budget');
    }

    // ---------------------------------------------------------------------
    // (f) Route-wiring guard for gaps 1 & 3
    // ---------------------------------------------------------------------

    /**
     * testAccountMutationRateLimit* and testLoginAndPasswordResetBucketsAreIndependent above
     * construct fresh RateLimitMiddleware instances directly with test-local keyPrefixes —
     * they pin that RateLimitMiddleware itself works, but NOT that it is actually attached to
     * the right routes in public/index.php. That attachment (route wiring) was the actual
     * substance of gaps 1 and 3, and no test in this codebase boots the full Slim route table
     * (index.php unconditionally calls $app->run() and was never made testable), so without
     * this test someone could revert e.g. `->add($accountMutationRateLimiter)->add($authRequired)`
     * on PUT/DELETE /me, or re-merge the login/password-reset buckets back into one shared
     * limiter, and the rest of this suite would stay 100% green.
     *
     * This reads the real public/index.php source and asserts, via structural regex over the
     * '/api/auth' route-group section (not a full parse, but scoped tightly enough that only a
     * genuine wiring change can flip it):
     *  - register/login and forgot/reset are wired to two DIFFERENT limiter variables/keyPrefixes
     *    (gap 3 — no shared bucket).
     *  - PUT/DELETE /me is wired to $accountMutationRateLimiter (constructed with keyByUser=true)
     *    AND to $authRequired, with $authRequired added AFTER the rate limiter in the chain — Slim's
     *    middleware stack is LIFO ("added before is executed after the newly added one"), so being
     *    added last means $authRequired runs FIRST and sets `userId` before the limiter reads it
     *    (gap 1 — per-user keying actually takes effect, confirmed independently against the real
     *    Slim MiddlewareDispatcher, not just asserted here).
     *  - GET /me stays outside the mutation limiter (unthrottled beyond auth, by design).
     */
    public function testIndexPhpWiresRateLimitersOntoTheExpectedAuthRoutes(): void
    {
        $indexPath = dirname(__DIR__, 2) . '/public/index.php';
        $this->assertFileExists($indexPath);
        $src = file_get_contents($indexPath);
        $this->assertIsString($src);

        $start = strpos($src, '$rateLimiter = new \\FormLogic\\Services\\RateLimiter(');
        $end = $start === false ? false : strpos($src, '// Public no-signup demo', $start);
        $this->assertNotFalse($start, 'could not locate the auth rate limiter section anchor in index.php');
        $this->assertNotFalse($end, 'could not locate the end-of-section anchor in index.php');
        $section = substr($src, $start, $end - $start);

        preg_match_all(
            '/\$app->group\(\'\/api\/auth\',\s*function[^{]*\{(.*?)\}\)((?:->add\([^)]*\))+);/s',
            $section,
            $matches,
            PREG_SET_ORDER
        );
        $this->assertGreaterThanOrEqual(4, count($matches), 'expected at least 4 /api/auth route groups in this section');

        $putMeBlock = null;
        $getMeOnlyBlock = null;
        $loginBlock = null;
        $resetBlock = null;
        foreach ($matches as $m) {
            $body = $m[1];
            $chain = $m[2];
            if (preg_match('/\$group->put\(\'\/me\'/', $body)) {
                $putMeBlock = $chain;
            } elseif (preg_match('/\$group->get\(\'\/me\'/', $body)) {
                $getMeOnlyBlock = $chain;
            }
            if (str_contains($body, "'/login'")) {
                $loginBlock = $chain;
            }
            if (str_contains($body, "'/forgot-password'")) {
                $resetBlock = $chain;
            }
        }

        $this->assertNotNull($loginBlock, 'could not find the register/login route group');
        $this->assertNotNull($resetBlock, 'could not find the forgot/reset-password route group');
        $this->assertNotNull($putMeBlock, 'could not find the PUT/DELETE /me route group');
        $this->assertNotNull($getMeOnlyBlock, 'could not find the GET /me (only) route group');

        // Gap 3: independent buckets, not merged back together.
        $this->assertStringContainsString('$authRateLimiter', $loginBlock);
        $this->assertStringNotContainsString('$passwordResetRateLimiter', $loginBlock);
        $this->assertStringContainsString('$passwordResetRateLimiter', $resetBlock);
        $this->assertStringNotContainsString('$authRateLimiter', $resetBlock);
        // RATE-001: the auth buckets are IP-keyed AND fail CLOSED — a limiter-store
        // outage must refuse these high-risk actions, not un-throttle them.
        // The login limit is the AUTH_LOGIN_RATE_LIMIT knob (an e2e run logs in from one
        // address hundreds of times) — pin that it defaults to 10 and is bounded, and that
        // the limiter is built from it with the fail-closed flags intact.
        $this->assertMatchesRegularExpression(
            '/\$authLoginLimit\s*=\s*max\(1,\s*min\(10000,.*AUTH_LOGIN_RATE_LIMIT.*\?: 10\)\)\);/',
            $section
        );
        $this->assertMatchesRegularExpression(
            '/\$authRateLimiter\s*=\s*new RateLimitMiddleware\(\$rateLimiter,\s*\$authLoginLimit,\s*\d+,\s*\'auth_login\',\s*false,\s*true\)/',
            $section
        );
        $this->assertMatchesRegularExpression(
            '/\$passwordResetRateLimiter\s*=\s*new RateLimitMiddleware\(\$rateLimiter,\s*\d+,\s*\d+,\s*\'auth_password_reset\',\s*false,\s*true\)/',
            $section
        );

        // Gap 1: PUT/DELETE /me carries both the per-user limiter and auth, in the order that
        // makes $authRequired run first (added after == executes first, per Slim's LIFO stack).
        $this->assertStringContainsString('$accountMutationRateLimiter', $putMeBlock);
        $this->assertStringContainsString('$authRequired', $putMeBlock);
        $limiterPos = strpos($putMeBlock, '$accountMutationRateLimiter');
        $authPos = strpos($putMeBlock, '$authRequired');
        $this->assertLessThan(
            $authPos,
            $limiterPos,
            '$authRequired must be added AFTER $accountMutationRateLimiter so it runs first and sets userId'
        );
        $this->assertMatchesRegularExpression(
            '/\$accountMutationRateLimiter\s*=\s*new RateLimitMiddleware\(\$rateLimiter,\s*\d+,\s*\d+,\s*\'auth_me_mutation\'\s*,\s*true,\s*true\)/',
            $section
        );

        // GET /me stays outside the mutation limiter.
        $this->assertStringNotContainsString('$accountMutationRateLimiter', $getMeOnlyBlock);

        // RATE-001: the MFA code exchange fails closed too (6-digit codes must
        // never see an un-throttled window).
        $this->assertMatchesRegularExpression(
            '/new RateLimitMiddleware\(\$rateLimiter,\s*\d+,\s*\d+,\s*\'auth_mfa_verify\',\s*false,\s*true\)/',
            $section
        );
    }
}

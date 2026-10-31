<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\AuthController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Models\User;
use FormLogic\Services\AppDomainService;
use FormLogic\Services\AuthService;
use FormLogic\Support\AppDomainSession;
use Firebase\JWT\JWT;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Factory\StreamFactory;

/**
 * The real tokens and cookies of a sign-in on an app's connected domain, and the domain rows
 * behind it. Skipped without a test database.
 */
class AppDomainTokenTest extends TestCase
{
    private const JWT = ['secret' => 'test-secret-for-app-domain-token-test', 'algorithm' => 'HS256', 'issuer' => 'formlogic', 'audience' => 'formlogic-api', 'expiry' => 3600];

    private static ?MySQLConnection $mysql = null;
    private static PDO $pdo;
    private static AuthService $auth;
    private static AppDomainService $domains;

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
        self::$domains = new AppDomainService($conn);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
    }

    private function user(): User
    {
        $email = 'app-domain-' . bin2hex(random_bytes(4)) . '@formlogic.test';
        return User::fromArray(self::$auth->register($email, 'a-strong-password-123', 'Member')['user']);
    }

    private function app(string $status = 'published'): array
    {
        $owner = $this->user();
        $id = 'app' . bin2hex(random_bytes(8));
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status, settings) VALUES (?, ?, 'T', ?, ?, '{}')")
            ->execute([$id, $owner->id, 'dom' . bin2hex(random_bytes(6)), $status]);
        return ['id' => $id, 'ownerId' => $owner->id];
    }

    private function connected(array $app): string
    {
        $host = 'shop-' . bin2hex(random_bytes(4)) . '.acme-apps.com';
        $domain = self::$domains->createDomain($app['id'], $app['ownerId'], $host, 'runtime_direct');
        self::$domains->verifyDomain($domain['id'], $app['ownerId'], true);
        return $host;
    }

    private function signInRequest(array $body, string $host): ServerRequestInterface
    {
        return (new ServerRequestFactory())->createServerRequest('POST', 'https://' . $host . '/api/auth/login')
            ->withBody((new StreamFactory())->createStream(json_encode($body)))
            ->withParsedBody($body)
            ->withAttribute(AppDomainSession::SIGN_IN_ATTRIBUTE, ['appId' => 'app-x', 'host' => $host]);
    }

    public function testThePlatformRefusesItAndOnlyItsOwnCheckAcceptsIt(): void
    {
        $user = $this->user();
        $token = self::$auth->issueAppDomainToken($user->id, 'app-1', 'shop.acme.com');
        self::assertNull(self::$auth->validateToken($token), 'every platform route goes through validateToken');
        $session = self::$auth->validateAppDomainToken($token);
        self::assertSame([$user->id, 'app-1', 'shop.acme.com'], [$session['user']->id ?? null, $session['appId'] ?? null, $session['host'] ?? null]);
        self::assertNull(self::$auth->validateAppDomainToken(self::$auth->issueToken($user)), 'a platform token is not one of these');
    }

    public function testChangingCredentialsEndsIt(): void
    {
        $user = $this->user();
        $token = self::$auth->issueAppDomainToken($user->id, 'app-1', 'shop.acme.com');
        self::$auth->revokeTokens($user->id);
        self::assertNull(self::$auth->validateAppDomainToken($token));
    }

    public function testAForgedOrIncompleteTokenIsRefused(): void
    {
        $user = $this->user();
        $claims = ['iss' => 'formlogic', 'aud' => AppDomainSession::AUDIENCE, 'sub' => $user->id, 'iat' => time(), 'exp' => time() + 60, 'tv' => 0, 'sg' => 0];
        $forged = JWT::encode($claims + ['app' => 'app-1', 'host' => 'shop.acme.com'], 'another-secret-another-secret-another', 'HS256');
        self::assertNull(self::$auth->validateAppDomainToken($forged));
        self::assertNull(self::$auth->validateAppDomainToken(JWT::encode($claims, self::JWT['secret'], 'HS256')), 'no app, no session');
        self::assertNull(self::$auth->validateAppDomainToken(JWT::encode($claims + ['app' => 'app-1'], self::JWT['secret'], 'HS256')), 'no host, no session');
    }

    public function testASignInOnADomainEndsWithTheLimitedSessionAndNoCookieDomain(): void
    {
        $email = 'app-domain-signin-' . bin2hex(random_bytes(4)) . '@formlogic.test';
        self::$auth->register($email, 'a-strong-password-123', 'Member');
        // The platform's own cookie Domain, which a browser would refuse on this host.
        $controller = new AuthController(self::$auth, ['domain' => '.formlogic.example'], 3600, null, null, 'csrf-secret');
        $host = 'shop.acme-apps.com';
        $response = $controller->login($this->signInRequest(['email' => $email, 'password' => 'a-strong-password-123'], $host), (new ResponseFactory())->createResponse());

        self::assertSame(200, $response->getStatusCode());
        self::assertTrue(json_decode((string) $response->getBody(), true)['user']['domainSession'] ?? false);
        $cookies = $response->getHeader('Set-Cookie');
        self::assertCount(2, $cookies);
        foreach ($cookies as $cookie) {
            self::assertStringNotContainsString('Domain=', $cookie);
        }
        preg_match('/^formlogic_auth=([^;]+)/', $cookies[0], $match);
        $token = urldecode($match[1]);
        self::assertNull(self::$auth->validateToken($token), 'never a platform session');
        self::assertSame(['app-x', $host], array_values(array_intersect_key(self::$auth->validateAppDomainToken($token) ?? [], ['appId' => 1, 'host' => 1])));
    }

    public function testAPlatformSignInIsUnchanged(): void
    {
        $email = 'app-domain-platform-' . bin2hex(random_bytes(4)) . '@formlogic.test';
        self::$auth->register($email, 'a-strong-password-123', 'Member');
        $controller = new AuthController(self::$auth, ['domain' => '.formlogic.example'], 3600, null, null, 'csrf-secret');
        $body = ['email' => $email, 'password' => 'a-strong-password-123'];
        $request = $this->signInRequest($body, 'formlogic.example')->withoutAttribute(AppDomainSession::SIGN_IN_ATTRIBUTE);
        $response = $controller->login($request, (new ResponseFactory())->createResponse());

        self::assertArrayNotHasKey('domainSession', json_decode((string) $response->getBody(), true)['user']);
        self::assertStringContainsString('Domain=.formlogic.example', $response->getHeader('Set-Cookie')[0]);
        preg_match('/^formlogic_auth=([^;]+)/', $response->getHeader('Set-Cookie')[0], $match);
        self::assertNotNull(self::$auth->validateToken(urldecode($match[1])));
    }

    public function testLeavingADomainDoesNotSignTheMemberOutEverywhere(): void
    {
        $user = $this->user();
        $platform = self::$auth->issueToken($user);
        $controller = new AuthController(self::$auth);
        $request = (new ServerRequestFactory())->createServerRequest('POST', 'https://shop.acme-apps.com/api/auth/logout')
            ->withAttribute('user', $user)->withAttribute('userId', $user->id)
            ->withAttribute(AppDomainSession::ATTRIBUTE, ['appId' => 'app-x', 'host' => 'shop.acme-apps.com']);
        $response = $controller->logout($request, (new ResponseFactory())->createResponse());

        self::assertNotNull(self::$auth->validateToken($platform), 'the one session a domain owner could hold cannot sign the member out of FormLogic');
        self::assertStringContainsString('Max-Age=0', $response->getHeader('Set-Cookie')[0]);
    }

    public function testMeSaysTheSessionIsLimited(): void
    {
        $user = $this->user();
        $controller = new AuthController(self::$auth);
        $request = (new ServerRequestFactory())->createServerRequest('GET', 'https://shop.acme-apps.com/api/auth/me')
            ->withAttribute('user', $user)->withAttribute(AppDomainSession::ATTRIBUTE, ['appId' => 'app-x', 'host' => 'shop.acme-apps.com']);
        self::assertTrue(json_decode((string) $controller->me($request, (new ResponseFactory())->createResponse())->getBody(), true)['user']['domainSession'] ?? false);
    }

    public function testOnlyAConnectedDomainOfAPublishedAppResolves(): void
    {
        $app = $this->app();
        $host = $this->connected($app);
        self::assertSame($app['id'], self::$domains->resolveAppSlugByHost($host . ':8443')['id'] ?? null);

        self::$pdo->prepare("UPDATE apps SET status = 'draft' WHERE id = ?")->execute([$app['id']]);
        self::assertNull(self::$domains->resolveAppSlugByHost($host), 'unpublishing ends it');

        $pending = $this->app();
        $unproven = 'pending-' . bin2hex(random_bytes(4)) . '.acme-apps.com';
        self::$domains->createDomain($pending['id'], $pending['ownerId'], $unproven);
        self::assertNull(self::$domains->resolveAppSlugByHost($unproven), 'a claim alone is nothing');
    }

    public function testACertificateIsOnlyForAProvenDomain(): void
    {
        $app = $this->app();
        $host = $this->connected($app);
        self::assertTrue(self::$domains->ownershipProven(strtoupper($host) . '.'));

        $pending = $this->app();
        $unproven = 'pending-' . bin2hex(random_bytes(4)) . '.acme-apps.com';
        self::$domains->createDomain($pending['id'], $pending['ownerId'], $unproven);
        self::assertFalse(self::$domains->ownershipProven($unproven));
        self::assertFalse(self::$domains->ownershipProven('never-heard-of.example.org'));
    }

    public function testAnUnprovenClaimLapsesSoTheRealOwnerCanTakeTheDomain(): void
    {
        $squatter = $this->app();
        $owner = $this->app();
        $host = 'claimed-' . bin2hex(random_bytes(4)) . '.acme-apps.com';
        $claim = self::$domains->createDomain($squatter['id'], $squatter['ownerId'], $host);

        try {
            self::$domains->createDomain($owner['id'], $owner['ownerId'], $host);
            self::fail('a fresh claim still holds the name');
        } catch (\InvalidArgumentException $held) {
            self::assertStringContainsString('already connected', $held->getMessage());
        }

        self::$pdo->prepare('UPDATE app_domains SET created_at = NOW() - INTERVAL 73 HOUR WHERE id = ?')->execute([$claim['id']]);
        $taken = self::$domains->createDomain($owner['id'], $owner['ownerId'], $host);
        self::assertSame($owner['id'], $taken['appId']);
        self::assertNull(self::$domains->getDomain($claim['id'], $squatter['ownerId']));
    }

    public function testAProvenDomainNeverLapses(): void
    {
        $app = $this->app();
        $host = $this->connected($app);
        self::$pdo->prepare('UPDATE app_domains SET created_at = NOW() - INTERVAL 30 DAY WHERE normalized_domain = ?')->execute([$host]);
        $other = $this->app();
        $this->expectException(\InvalidArgumentException::class);
        self::$domains->createDomain($other['id'], $other['ownerId'], $host);
    }

    public function testTheOwnerIsToldWhereToPointTheDomain(): void
    {
        $app = $this->app();
        $saved = [$_ENV['APP_URL'] ?? null, $_ENV['APP_DOMAIN_CNAME_TARGET'] ?? null, $_ENV['APP_DOMAIN_A_RECORD'] ?? null];
        $host = 'routed-' . bin2hex(random_bytes(4)) . '.acme-apps.com';
        try {
            $_ENV['APP_URL'] = 'https://formlogic.com';
            unset($_ENV['APP_DOMAIN_CNAME_TARGET'], $_ENV['APP_DOMAIN_A_RECORD']);
            $domain = self::$domains->createDomain($app['id'], $app['ownerId'], $host);
            self::assertSame(['cname' => 'formlogic.com', 'a' => null], $domain['routing'], 'the site itself by default');

            $_ENV['APP_DOMAIN_CNAME_TARGET'] = 'domains.formlogic.com';
            $_ENV['APP_DOMAIN_A_RECORD'] = '203.0.113.7';
            self::assertSame(['cname' => 'domains.formlogic.com', 'a' => '203.0.113.7'], self::$domains->getDomain($domain['id'], $app['ownerId'])['routing']);

            unset($_ENV['APP_DOMAIN_CNAME_TARGET'], $_ENV['APP_DOMAIN_A_RECORD']);
            $_ENV['APP_URL'] = 'http://127.0.0.1:8091';
            self::assertSame(['cname' => null, 'a' => null], self::$domains->getDomain($domain['id'], $app['ownerId'])['routing'], 'never an address nobody can point at');
        } finally {
            foreach (['APP_URL', 'APP_DOMAIN_CNAME_TARGET', 'APP_DOMAIN_A_RECORD'] as $i => $key) {
                if ($saved[$i] === null) {
                    unset($_ENV[$key]);
                } else {
                    $_ENV[$key] = $saved[$i];
                }
            }
        }
    }
}

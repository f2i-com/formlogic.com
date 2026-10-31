<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\AuthController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Models\User;
use FormLogic\Services\AppDomainService;
use FormLogic\Services\AppDomainSignInService;
use FormLogic\Services\AuthService;
use FormLogic\Support\AppDomainSession;
use FormLogic\Support\Environment;
use Firebase\JWT\JWT;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Factory\StreamFactory;

/**
 * The real tokens, codes and cookies of signing in to an app on its connected domain, and the
 * domain rows behind them. Skipped without a test database.
 */
class AppDomainTokenTest extends TestCase
{
    private const JWT = ['secret' => 'test-secret-for-app-domain-token-test', 'algorithm' => 'HS256', 'issuer' => 'formlogic', 'audience' => 'formlogic-api', 'expiry' => 3600];

    private static ?MySQLConnection $mysql = null;
    private static PDO $pdo;
    private static AuthService $auth;
    private static AppDomainService $domains;
    private static AppDomainSignInService $signIns;

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
        self::$signIns = new AppDomainSignInService($conn);
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
            ->withParsedBody($body);
    }

    /** The controller as index.php builds it, as far as a domain's sign-in goes. */
    private function controller(array $cookie = []): AuthController
    {
        return new AuthController(self::$auth, $cookie, 3600, null, null, 'csrf-secret', null, null, null, null, null, null, null, self::$domains, self::$signIns);
    }

    /** POST /api/auth/app-domain/code as this member, from the platform. */
    private function askForCode(User $user, string $origin): array
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', 'https://formlogic.example/api/auth/app-domain/code')
            ->withAttribute('user', $user)->withAttribute('userId', $user->id)
            ->withParsedBody(['origin' => $origin]);
        $response = $this->controller()->appDomainCode($request, (new ResponseFactory())->createResponse());
        return [$response->getStatusCode(), json_decode((string) $response->getBody(), true), $response];
    }

    /** POST /api/auth/app-domain/exchange on the domain, as CsrfMiddleware admitted it. */
    private function exchange(string $code, array $app, string $host, array $cookie = [])
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', 'https://' . $host . '/api/auth/app-domain/exchange')
            ->withParsedBody(['code' => $code])
            ->withAttribute(AppDomainSession::SIGN_IN_ATTRIBUTE, ['appId' => $app['id'], 'host' => $host]);
        return $this->controller($cookie)->appDomainExchange($request, (new ResponseFactory())->createResponse());
    }

    /** @param list<string> $cookies */
    private function tokenIn(array $cookies): string
    {
        preg_match('/^formlogic_auth=([^;]+)/', $cookies[0], $match);
        return urldecode($match[1]);
    }

    private function withAppEnv(string $value, callable $run): void
    {
        $saved = Environment::get('APP_ENV');
        $_ENV['APP_ENV'] = $value;
        try {
            $run();
        } finally {
            if ($saved === null) {
                unset($_ENV['APP_ENV']);
            } else {
                $_ENV['APP_ENV'] = $saved;
            }
        }
    }

    public function testThePlatformRefusesItAndOnlyItsOwnCheckAcceptsIt(): void
    {
        $user = $this->user();
        $token = self::$auth->issueAppDomainToken($user->id, 'app-1', 'shop.acme.com', 'sign-in-1');
        self::assertNull(self::$auth->validateToken($token), 'every platform route goes through validateToken');
        $session = self::$auth->validateAppDomainToken($token);
        self::assertSame([$user->id, 'app-1', 'shop.acme.com', 'sign-in-1'], [$session['user']->id ?? null, $session['appId'] ?? null, $session['host'] ?? null, $session['signInId'] ?? null]);
        self::assertNull(self::$auth->validateAppDomainToken(self::$auth->issueToken($user)), 'a platform token is not one of these');
    }

    public function testChangingCredentialsEndsIt(): void
    {
        $user = $this->user();
        $token = self::$auth->issueAppDomainToken($user->id, 'app-1', 'shop.acme.com', 'sign-in-1');
        self::$auth->revokeTokens($user->id);
        self::assertNull(self::$auth->validateAppDomainToken($token));
    }

    public function testAForgedOrIncompleteTokenIsRefused(): void
    {
        $user = $this->user();
        $claims = ['iss' => 'formlogic', 'aud' => AppDomainSession::AUDIENCE, 'sub' => $user->id, 'iat' => time(), 'exp' => time() + 60, 'tv' => 0, 'sg' => 0];
        $forged = JWT::encode($claims + ['app' => 'app-1', 'host' => 'shop.acme.com', 'sid' => 'sign-in-1'], 'another-secret-another-secret-another', 'HS256');
        self::assertNull(self::$auth->validateAppDomainToken($forged));
        self::assertNull(self::$auth->validateAppDomainToken(JWT::encode($claims, self::JWT['secret'], 'HS256')), 'no app, no session');
        self::assertNull(self::$auth->validateAppDomainToken(JWT::encode($claims + ['app' => 'app-1'], self::JWT['secret'], 'HS256')), 'no host, no session');
        self::assertNull(self::$auth->validateAppDomainToken(JWT::encode($claims + ['app' => 'app-1', 'host' => 'shop.acme.com'], self::JWT['secret'], 'HS256')), 'no sign-in, no session');
    }

    public function testACodeBecomesTheLimitedSessionAndNoCookieDomain(): void
    {
        $app = $this->app();
        $host = $this->connected($app);
        $member = $this->user();
        [$status, $body, $asked] = $this->askForCode($member, 'https://' . $host);
        self::assertSame(200, $status, json_encode($body));
        self::assertSame('no-store', $asked->getHeaderLine('Cache-Control'));

        // The platform's own cookie Domain, which a browser would refuse on this host.
        $response = $this->exchange($body['code'], $app, $host, ['domain' => '.formlogic.example']);
        self::assertSame(200, $response->getStatusCode(), (string) $response->getBody());
        self::assertTrue(json_decode((string) $response->getBody(), true)['user']['domainSession'] ?? false);
        $cookies = $response->getHeader('Set-Cookie');
        self::assertCount(2, $cookies);
        foreach ($cookies as $cookie) {
            self::assertStringNotContainsString('Domain=', $cookie);
        }
        $token = $this->tokenIn($cookies);
        self::assertNull(self::$auth->validateToken($token), 'never a platform session');
        $session = self::$auth->validateAppDomainToken($token);
        self::assertSame([$member->id, $app['id'], $host], [$session['user']->id, $session['appId'], $session['host']]);
        self::assertTrue(self::$signIns->isLive($session['signInId']));
    }

    public function testACodeIsSpentOnceOnItsOwnDomain(): void
    {
        $app = $this->app();
        $host = $this->connected($app);
        $other = $this->app();
        $otherHost = $this->connected($other);
        $member = $this->user();
        $code = $this->askForCode($member, 'https://' . $host)[1]['code'];

        self::assertSame(400, $this->exchange($code, $other, $otherHost)->getStatusCode(), 'another domain');
        self::assertSame(400, $this->exchange($code, $other, $host)->getStatusCode(), 'another app');
        self::assertSame(400, $this->exchange($code . 'x', $app, $host)->getStatusCode(), 'another code');
        self::assertSame(400, $this->exchange('', $app, $host)->getStatusCode());
        self::assertSame(200, $this->exchange($code, $app, $host)->getStatusCode(), 'none of that spent it');
        // A moment later, or the update below would change nothing and pass for a refusal.
        self::$pdo->prepare('UPDATE app_domain_sign_ins SET exchanged_at = NOW() - INTERVAL 5 SECOND WHERE code_hash = ?')->execute([hash('sha256', $code)]);
        self::assertSame(400, $this->exchange($code, $app, $host)->getStatusCode(), 'spent');
    }

    public function testACodeLapsesInAMinute(): void
    {
        $app = $this->app();
        $host = $this->connected($app);
        $code = $this->askForCode($this->user(), 'https://' . $host)[1]['code'];
        self::$pdo->prepare('UPDATE app_domain_sign_ins SET code_expires_at = NOW() - INTERVAL 1 SECOND WHERE code_hash = ?')->execute([hash('sha256', $code)]);
        self::assertSame(400, $this->exchange($code, $app, $host)->getStatusCode());
    }

    public function testACodeStoresOnlyItsHash(): void
    {
        $app = $this->app();
        $host = $this->connected($app);
        $code = $this->askForCode($this->user(), 'https://' . $host)[1]['code'];
        $row = self::$pdo->prepare('SELECT * FROM app_domain_sign_ins WHERE code_hash = ?');
        $row->execute([hash('sha256', $code)]);
        self::assertStringNotContainsString($code, (string) json_encode($row->fetch(PDO::FETCH_ASSOC)));
    }

    public function testOnlyAConnectedDomainGetsACode(): void
    {
        $member = $this->user();
        $app = $this->app();
        $host = $this->connected($app);
        $pending = $this->app();
        $unproven = 'pending-' . bin2hex(random_bytes(4)) . '.acme-apps.com';
        self::$domains->createDomain($pending['id'], $pending['ownerId'], $unproven);
        foreach (['https://' . $unproven, 'https://never-heard-of.example.org', 'https://' . $host . '/path', 'not an origin', ''] as $origin) {
            self::assertSame(404, $this->askForCode($member, $origin)[0], $origin);
        }
        self::$pdo->prepare("UPDATE apps SET status = 'draft' WHERE id = ?")->execute([$app['id']]);
        self::assertSame(404, $this->askForCode($member, 'https://' . $host)[0], 'unpublished');
    }

    public function testPlainHttpGetsNoCodeOutsideDevelopment(): void
    {
        $app = $this->app();
        $host = $this->connected($app);
        $member = $this->user();
        $this->withAppEnv('production', function () use ($member, $host): void {
            self::assertSame(404, $this->askForCode($member, 'http://' . $host)[0]);
            self::assertSame(200, $this->askForCode($member, 'https://' . $host)[0]);
        });
        $this->withAppEnv('development', function () use ($member, $host): void {
            self::assertSame(200, $this->askForCode($member, 'http://' . $host . ':8091')[0]);
        });
    }

    public function testADarkDomainStaysKnownToBeACustomers(): void
    {
        $app = $this->app();
        $host = $this->connected($app);
        self::assertTrue(self::$domains->provenByAnOwner($host));
        self::$pdo->prepare("UPDATE apps SET status = 'draft' WHERE id = ?")->execute([$app['id']]);
        self::assertTrue(self::$domains->provenByAnOwner(strtoupper($host) . ':8443'), 'unpublished, still a name its owner can repoint');
        self::$pdo->prepare("UPDATE app_domains SET status = 'failed' WHERE normalized_domain = ?")->execute([$host]);
        self::assertTrue(self::$domains->provenByAnOwner($host));

        $pending = $this->app();
        $unproven = 'pending-' . bin2hex(random_bytes(4)) . '.acme-apps.com';
        self::$domains->createDomain($pending['id'], $pending['ownerId'], $unproven);
        self::assertFalse(self::$domains->provenByAnOwner($unproven), 'a claim must not refuse sign-in on a name');
    }

    public function testAPlatformSignInIsUnchanged(): void
    {
        $email = 'app-domain-platform-' . bin2hex(random_bytes(4)) . '@formlogic.test';
        self::$auth->register($email, 'a-strong-password-123', 'Member');
        $controller = new AuthController(self::$auth, ['domain' => '.formlogic.example'], 3600, null, null, 'csrf-secret');
        $body = ['email' => $email, 'password' => 'a-strong-password-123'];
        $request = $this->signInRequest($body, 'formlogic.example');
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
        $app = $this->app();
        $host = $this->connected($app);
        $token = $this->tokenIn($this->exchange($this->askForCode($user, 'https://' . $host)[1]['code'], $app, $host)->getHeader('Set-Cookie'));
        $session = self::$auth->validateAppDomainToken($token);
        $request = (new ServerRequestFactory())->createServerRequest('POST', 'https://' . $host . '/api/auth/logout')
            ->withAttribute('user', $user)->withAttribute('userId', $user->id)
            ->withAttribute(AppDomainSession::ATTRIBUTE, $session);
        $response = $this->controller()->logout($request, (new ResponseFactory())->createResponse());

        self::assertNotNull(self::$auth->validateToken($platform), 'the one session a domain owner could hold cannot sign the member out of FormLogic');
        self::assertStringContainsString('Max-Age=0', $response->getHeader('Set-Cookie')[0]);
        self::assertFalse(self::$signIns->isLive($session['signInId']), 'and it is over: a copy of the token opens nothing');
    }

    public function testMeSaysTheSessionIsLimited(): void
    {
        $user = $this->user();
        $controller = new AuthController(self::$auth);
        $request = (new ServerRequestFactory())->createServerRequest('GET', 'https://shop.acme-apps.com/api/auth/me')
            ->withAttribute('user', $user)->withAttribute(AppDomainSession::ATTRIBUTE, ['appId' => 'app-x', 'host' => 'shop.acme-apps.com', 'signInId' => 'sign-in-1']);
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

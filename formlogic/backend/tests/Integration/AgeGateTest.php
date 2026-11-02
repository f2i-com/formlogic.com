<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use Firebase\JWT\JWT;
use FormLogic\Constants\AppPermissions;
use FormLogic\Controllers\AgeVerificationController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Middleware\AppAccessGateMiddleware;
use FormLogic\Middleware\AuthMiddleware;
use FormLogic\Services\AccessGateService;
use FormLogic\Services\AppDomainService;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\AuthService;
use FormLogic\Services\FormService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\Factory\AppFactory;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Routing\RouteCollectorProxy;

/**
 * An app's age gate through the real middleware, on a group like /api/app/{slug} and on a route
 * outside it with optional sign-in (as the native runtime has), and the main site's verification
 * endpoints that open it. RouteGateWiringTest holds public/index.php to the same wiring.
 */
final class AgeGateTest extends TestCase
{
    private const JWT_SECRET = 'age-gate-test-secret-0123456789abcdef';

    private static ?PDO $pdo = null;
    private static ?MySQLConnection $mysql = null;
    private static AppService $apps;
    private static AccessGateService $gate;
    private static \Slim\App $slim;
    private static string $tmpRoot = '';

    /** @var string[] */
    private array $userIds = [];
    /** @var string[] */
    private array $appIds = [];
    private string $ownerId = '';
    private string $memberId = '';

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
        self::$tmpRoot = sys_get_temp_dir() . '/formlogic-age-gate-' . bin2hex(random_bytes(4));
        mkdir(self::$tmpRoot, 0777, true);
        self::$apps = new AppService($conn, new FormService($conn, new SQLiteConnection(self::$tmpRoot . '/sqlite')));
        self::$gate = new AccessGateService($conn);
        $auth = new AuthService($conn, [
            'secret' => self::JWT_SECRET, 'expiry' => 3600, 'algorithm' => 'HS256', 'issuer' => 'formlogic', 'audience' => 'formlogic-api',
        ]);
        $authRequired = new AuthMiddleware($auth);
        $authOptional = new AuthMiddleware($auth, true);
        $gateMiddleware = new AppAccessGateMiddleware(self::$apps, self::$gate, $authOptional);
        $verification = new AgeVerificationController(self::$apps, self::$gate, new AppDomainService($conn));

        $ok = static function ($request, $response) {
            $response->getBody()->write('{"data":"the app\'s"}');
            return $response->withHeader('Content-Type', 'application/json');
        };
        self::$slim = AppFactory::create();
        self::$slim->group('/api/app/{slug}', function (RouteCollectorProxy $group) use ($ok, $authRequired) {
            $group->get('', $ok)->add($authRequired);
            $group->get('/forms/{formId}/responses', $ok)->add($authRequired);
            $group->get('/membership', $ok)->add($authRequired);
            $group->get('/manifest.json', $ok);
        })->add($gateMiddleware);
        self::$slim->post('/api/app/{slug}/native/request', $ok)->add($gateMiddleware)->add($authOptional);
        self::$slim->get('/api/verification/age', fn ($rq, $rs) => $verification->status($rq, $rs))->add($authRequired);
        self::$slim->post('/api/verification/age/declare', fn ($rq, $rs) => $verification->declare($rq, $rs))->add($authRequired);
        self::$slim->get('/api/verification/receipts', fn ($rq, $rs) => $verification->receipts($rq, $rs))->add($authRequired);
        self::$slim->delete('/api/verification/receipts/{id}', fn ($rq, $rs, $args) => $verification->revoke($rq, $rs, $args))->add($authRequired);
        self::$slim->addRoutingMiddleware();
    }

    public static function tearDownAfterClass(): void
    {
        if (self::$tmpRoot !== '' && is_dir(self::$tmpRoot)) {
            @rmdir(self::$tmpRoot . '/sqlite');
            @rmdir(self::$tmpRoot);
        }
    }

    protected function setUp(): void
    {
        if (self::$pdo === null) {
            $this->markTestSkipped('No test database');
        }
        $this->ownerId = $this->makeUser();
        $this->memberId = $this->makeUser();
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        foreach ($this->appIds as $appId) {
            self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?)')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_versions WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$appId]);
        }
        foreach ($this->userIds as $uid) {
            self::$pdo->prepare('DELETE FROM access_receipts WHERE user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
        }
        $this->userIds = [];
        $this->appIds = [];
    }

    public function testAMemberWithoutACheckIsRefusedEverythingButTheWayIn(): void
    {
        $slug = $this->gatedApp(18, 'declared');
        foreach (['GET' => ["/api/app/{$slug}", "/api/app/{$slug}/forms/f1/responses"], 'POST' => ["/api/app/{$slug}/native/request"]] as $method => $paths) {
            foreach ($paths as $path) {
                $response = $this->call($method, $path, $this->memberId);
                self::assertSame(403, $response->getStatusCode(), $path);
                $body = $this->json($response);
                self::assertSame('age_verification_required', $body['code'] ?? null, $path);
                self::assertSame(18, $body['ageGate']['minimumAge'] ?? null);
                self::assertSame("/verify/age?app={$slug}", $body['ageGate']['verifyPath'] ?? null);
                self::assertStringNotContainsString("the app's", (string) $response->getBody(), $path);
            }
        }
        // What a page needs before the member can pass stays open.
        self::assertSame(200, $this->call('GET', "/api/app/{$slug}/membership", $this->memberId)->getStatusCode());
        self::assertSame(200, $this->call('GET', "/api/app/{$slug}/manifest.json", null)->getStatusCode());
    }

    public function testNobodyAnonymousPassesAndTheOwnerIsNotGated(): void
    {
        $slug = $this->gatedApp(18, 'declared');
        $anonymous = $this->call('POST', "/api/app/{$slug}/native/request", null);
        self::assertSame(401, $anonymous->getStatusCode());
        self::assertSame('sign_in_required', $this->json($anonymous)['code'] ?? null);
        self::assertSame(200, $this->call('GET', "/api/app/{$slug}", $this->ownerId)->getStatusCode());
        self::assertSame(200, $this->call('POST', "/api/app/{$slug}/native/request", $this->ownerId)->getStatusCode());
    }

    public function testAnAppWithoutAGateIsUntouched(): void
    {
        $app = self::$apps->createApp(['name' => 'Open app ' . bin2hex(random_bytes(3))], $this->ownerId);
        $this->appIds[] = (string) $app['id'];
        self::$apps->publishApp((string) $app['id'], null, $this->ownerId);
        $slug = (string) self::$apps->getApp((string) $app['id'])['slug'];
        self::assertSame(200, $this->call('GET', "/api/app/{$slug}", $this->memberId)->getStatusCode());
        self::assertSame(200, $this->call('POST', "/api/app/{$slug}/native/request", null)->getStatusCode());
    }

    public function testADeclarationOpensTheAppAndWithdrawingItClosesItAgain(): void
    {
        $slug = $this->gatedApp(18, 'declared');
        $status = $this->json($this->call('GET', "/api/verification/age?app={$slug}", $this->memberId));
        self::assertFalse($status['ageGate']['satisfied']);
        self::assertSame(['self_declaration'], $status['methods']);

        $refused = $this->call('POST', '/api/verification/age/declare', $this->memberId, ['app' => $slug]);
        self::assertSame(400, $refused->getStatusCode(), 'a declaration is made, not assumed');

        $declared = $this->call('POST', '/api/verification/age/declare', $this->memberId, ['app' => $slug, 'confirm' => true]);
        self::assertSame(201, $declared->getStatusCode());
        $receipt = $this->json($declared)['receipt'];
        self::assertSame(['declared', 'self_declaration', 18], [$receipt['assurance'], $receipt['method'], $receipt['minimumAge']]);
        self::assertSame(200, $this->call('GET', "/api/app/{$slug}", $this->memberId)->getStatusCode());

        // What is kept: who, which age, how, until when. Nothing else.
        $columns = array_keys((array) self::$pdo->query("SELECT * FROM access_receipts WHERE id = " . self::$pdo->quote($receipt['id']))->fetch(PDO::FETCH_ASSOC));
        sort($columns);
        self::assertSame(['assurance', 'expires_at', 'id', 'issued_at', 'kind', 'method', 'minimum_age', 'revoked_at', 'user_id', 'verifier'], $columns);

        $listed = $this->json($this->call('GET', '/api/verification/receipts', $this->memberId))['receipts'];
        self::assertSame([$receipt['id']], array_column($listed, 'id'));
        self::assertSame(404, $this->call('DELETE', "/api/verification/receipts/{$receipt['id']}", $this->ownerId)->getStatusCode(), 'only its member withdraws it');
        self::assertSame(200, $this->call('DELETE', "/api/verification/receipts/{$receipt['id']}", $this->memberId)->getStatusCode());
        self::assertSame(403, $this->call('GET', "/api/app/{$slug}", $this->memberId)->getStatusCode());
    }

    public function testAReceiptOpensOnlyWhatItEstablished(): void
    {
        $adult = $this->gatedApp(18, 'declared');
        $older = $this->gatedApp(21, 'declared');
        $stronger = $this->gatedApp(18, 'estimated');
        self::$gate->issue($this->memberId, 18, 'self_declaration');
        self::assertSame(200, $this->call('GET', "/api/app/{$adult}", $this->memberId)->getStatusCode());
        self::assertSame(403, $this->call('GET', "/api/app/{$older}", $this->memberId)->getStatusCode(), 'an 18 receipt is no 21');
        self::assertSame(403, $this->call('GET', "/api/app/{$stronger}", $this->memberId)->getStatusCode(), 'a declaration is no estimate');

        // A declaration is not offered where the app asks for more.
        self::assertSame([], $this->json($this->call('GET', "/api/verification/age?app={$stronger}", $this->memberId))['methods']);
        $declared = $this->call('POST', '/api/verification/age/declare', $this->memberId, ['app' => $stronger, 'confirm' => true]);
        self::assertSame(403, $declared->getStatusCode());
        self::assertSame('method_not_offered', $this->json($declared)['code'] ?? null);

        // An expired receipt opens nothing.
        self::$pdo->prepare('UPDATE access_receipts SET expires_at = ? WHERE user_id = ?')->execute([gmdate('Y-m-d H:i:s', time() - 60), $this->memberId]);
        self::assertSame(403, $this->call('GET', "/api/app/{$adult}", $this->memberId)->getStatusCode());
    }

    public function testItSendsTheMemberBackOnlyToThisSiteOrThisAppsOwnDomain(): void
    {
        $slug = $this->gatedApp(18, 'declared');
        foreach ([
            '/app/' . $slug => '/app/' . $slug,
            '//evil.example/x' => null,
            'https://evil.example/' => null,
            'javascript:alert(1)' => null,
            "/app/x\nSet-Cookie: a=b" => null,
            '/\\evil.example' => null,
        ] as $return => $expected) {
            $status = $this->json($this->call('GET', "/api/verification/age?app={$slug}&return=" . rawurlencode($return), $this->memberId));
            self::assertSame($expected, $status['returnTo'], $return);
        }
    }

    public function testAnUnverifiedMemberHoldsNoPermissionWhateverPathAsks(): void
    {
        $slug = $this->gatedApp(18, 'declared');
        $appId = (string) self::$apps->getAppBySlug($slug)['id'];
        $users = new AppUserService(self::$mysql);
        $users->useAccessGate(new AccessGateService(self::$mysql));
        $role = $users->createRole($appId, ['name' => 'Reader']);
        $users->setRolePermissions((string) $role['id'], [['formId' => null, 'permission' => AppPermissions::VIEW_ALL_RESPONSES]], true);
        self::$pdo->prepare("INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at) VALUES (?, ?, ?, ?, 'active', NOW())")
            ->execute(['au-' . bin2hex(random_bytes(10)), $appId, $this->memberId, $role['id']]);

        // The member list and detail, Aokie Companion and the MCP grants all ask through these two.
        self::assertFalse($users->hasPermission($appId, $this->memberId, AppPermissions::VIEW_ALL_RESPONSES));
        self::assertSame(['appLevel' => [], 'formLevel' => []], $users->getUserPermissions($appId, $this->memberId));
        self::assertTrue($users->hasPermission($appId, $this->ownerId, AppPermissions::VIEW_ALL_RESPONSES), 'the owner is never gated');

        self::$gate->issue($this->memberId, 18, 'self_declaration');
        $fresh = new AppUserService(self::$mysql);
        $fresh->useAccessGate(new AccessGateService(self::$mysql));
        self::assertTrue($fresh->hasPermission($appId, $this->memberId, AppPermissions::VIEW_ALL_RESPONSES));
    }

    public function testTheSettingIsHeldToItsShape(): void
    {
        self::assertSame(['minimumAge' => 18, 'assurance' => 'declared'], AccessGateService::normalizeSetting(['minimumAge' => 18]));
        self::assertSame(['minimumAge' => 21, 'assurance' => 'estimated'], AccessGateService::normalizeSetting(['minimumAge' => 21, 'assurance' => 'estimated']));
        foreach ([null, true, [], ['minimumAge' => '18'], ['minimumAge' => 12], ['minimumAge' => 121], ['minimumAge' => 18, 'assurance' => 'guessed']] as $bad) {
            self::assertNull(AccessGateService::normalizeSetting($bad), json_encode($bad));
        }
        $app = self::$apps->createApp(['name' => 'Bad gate ' . bin2hex(random_bytes(3)), 'settings' => ['ageGate' => ['minimumAge' => 5]]], $this->ownerId);
        $this->appIds[] = (string) $app['id'];
        self::assertArrayNotHasKey('ageGate', self::$apps->getApp((string) $app['id'])['settings'] ?? []);
    }

    private function gatedApp(int $age, string $assurance): string
    {
        $app = self::$apps->createApp([
            'name' => 'Gated ' . bin2hex(random_bytes(4)),
            'settings' => ['ageGate' => ['minimumAge' => $age, 'assurance' => $assurance]],
        ], $this->ownerId);
        $this->appIds[] = (string) $app['id'];
        self::$apps->publishApp((string) $app['id'], null, $this->ownerId);
        $stored = self::$apps->getApp((string) $app['id']);
        self::assertEquals(['minimumAge' => $age, 'assurance' => $assurance], $stored['settings']['ageGate'] ?? null);
        return (string) $stored['slug'];
    }

    private function makeUser(): string
    {
        $id = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")->execute([$id, $id . '@test.local']);
        $this->userIds[] = $id;
        return $id;
    }

    private function call(string $method, string $path, ?string $userId, ?array $body = null): ResponseInterface
    {
        $request = (new ServerRequestFactory())->createServerRequest($method, $path);
        $query = parse_url($path, PHP_URL_QUERY);
        if (is_string($query)) {
            parse_str($query, $params);
            $request = $request->withQueryParams($params);
        }
        if ($userId !== null) {
            $iat = time();
            $token = JWT::encode(['iss' => 'formlogic', 'aud' => 'formlogic-api', 'sub' => $userId, 'email' => $userId . '@test.local',
                'iat' => $iat, 'nbf' => $iat, 'exp' => $iat + 3600, 'tv' => 0], self::JWT_SECRET, 'HS256');
            $request = $request->withHeader('Authorization', 'Bearer ' . $token);
        }
        if ($body !== null) {
            $request = $request->withParsedBody($body);
        }
        return self::$slim->handle($request);
    }

    private function json(ResponseInterface $response): array
    {
        $response->getBody()->rewind();
        return json_decode((string) $response->getBody(), true) ?? [];
    }
}

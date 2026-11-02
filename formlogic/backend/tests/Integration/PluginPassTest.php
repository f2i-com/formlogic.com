<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use Firebase\JWT\JWT;
use FormLogic\Constants\AppPermissions;
use FormLogic\Controllers\PluginController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Middleware\AdminActAsMiddleware;
use FormLogic\Middleware\AppAccessGateMiddleware;
use FormLogic\Middleware\AuthMiddleware;
use FormLogic\Middleware\PluginAccountGuardMiddleware;
use FormLogic\Services\AccessGateService;
use FormLogic\Services\AdminService;
use FormLogic\Services\AppDomainService;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\AuthService;
use FormLogic\Services\FormService;
use FormLogic\Services\NativeAppService;
use FormLogic\Services\PluginService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\Factory\AppFactory;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Routing\RouteCollectorProxy;

/**
 * Plugins' passes and the apps that require them (docs/AGE_GATE_AND_SITE_AI.md), through the real
 * middleware on a group like /api/app/{slug} and on a route outside it with optional sign-in (as
 * the native runtime has); the recording of a plugin backend's answer; the plugin page's context;
 * and the fences around the Plugins account. RouteGateWiringTest holds public/index.php to the
 * same wiring; e2e/age-gate.spec.ts runs the built-in plugin in the real runner and frame.
 */
final class PluginPassTest extends TestCase
{
    private const JWT_SECRET = 'plugin-pass-test-secret-0123456789abcdef';
    private const AGE = ['kind' => 'age', 'label' => 'Age', 'unit' => 'years', 'min' => 13, 'max' => 120, 'strengths' => ['declared'], 'issueRoute' => '/api/pass'];

    private static ?PDO $pdo = null;
    private static ?MySQLConnection $mysql = null;
    private static AppService $apps;
    private static AuthService $auth;
    private static \Slim\App $slim;
    private static string $tmpRoot = '';

    private PluginService $plugins;
    private AccessGateService $gate;
    /** @var string[] */
    private array $userIds = [];
    /** @var string[] */
    private array $appIds = [];
    /** @var string[] */
    private array $pluginIds = [];
    private string $ownerId = '';
    private string $memberId = '';
    private string $pluginId = '';

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
        self::$tmpRoot = sys_get_temp_dir() . '/formlogic-plugin-pass-' . bin2hex(random_bytes(4));
        mkdir(self::$tmpRoot, 0777, true);
        self::$apps = new AppService($conn, new FormService($conn, new SQLiteConnection(self::$tmpRoot . '/sqlite')));
        self::$auth = new AuthService($conn, [
            'secret' => self::JWT_SECRET, 'expiry' => 3600, 'algorithm' => 'HS256', 'issuer' => 'formlogic', 'audience' => 'formlogic-api',
        ]);
        // The account plugins' projects belong to, as PluginService makes it on the first install.
        self::$pdo->prepare("INSERT IGNORE INTO users (id, email, password_hash, name) VALUES (?, 'plugins@formlogic.invalid', '!', 'Plugins')")
            ->execute([PluginService::SYSTEM_USER_ID]);
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
        $this->fresh();
        $this->pluginId = $this->installRow([self::AGE]);
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
        foreach ($this->pluginIds as $manifestId) {
            self::$pdo->prepare('DELETE FROM plugins WHERE manifest_id = ?')->execute([$manifestId]);
        }
        foreach ($this->userIds as $uid) {
            self::$pdo->prepare('DELETE FROM passes WHERE user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
        }
        $this->userIds = [];
        $this->appIds = [];
        $this->pluginIds = [];
    }

    public function testAMemberWithoutAPassIsRefusedEverythingButTheWayIn(): void
    {
        $slug = $this->gatedApp(18);
        foreach (['GET' => ["/api/app/{$slug}", "/api/app/{$slug}/forms/f1/responses"], 'POST' => ["/api/app/{$slug}/native/request"]] as $method => $paths) {
            foreach ($paths as $path) {
                $response = $this->call($method, $path, $this->memberId);
                self::assertSame(403, $response->getStatusCode(), $path);
                $body = $this->json($response);
                self::assertSame('pass_required', $body['code'] ?? null, $path);
                self::assertSame(18, $body['requirement']['min'] ?? null);
                self::assertSame("/plugins/{$this->pluginId}/verify?app={$slug}&kind=age", $body['requirement']['verifyPath'] ?? null);
                self::assertStringNotContainsString("the app's", (string) $response->getBody(), $path);
            }
        }
        // What a page needs before the member can pass stays open.
        self::assertSame(200, $this->call('GET', "/api/app/{$slug}/membership", $this->memberId)->getStatusCode());
        self::assertSame(200, $this->call('GET', "/api/app/{$slug}/manifest.json", null)->getStatusCode());
    }

    public function testNobodyAnonymousPassesAndTheOwnerIsNotGated(): void
    {
        $slug = $this->gatedApp(18);
        $anonymous = $this->call('POST', "/api/app/{$slug}/native/request", null);
        self::assertSame(401, $anonymous->getStatusCode());
        self::assertSame('sign_in_required', $this->json($anonymous)['code'] ?? null);
        self::assertSame(200, $this->call('GET', "/api/app/{$slug}", $this->ownerId)->getStatusCode());
        self::assertSame(200, $this->call('POST', "/api/app/{$slug}/native/request", $this->ownerId)->getStatusCode());
    }

    public function testAnAppWithoutRequirementsIsUntouched(): void
    {
        $app = self::$apps->createApp(['name' => 'Open app ' . bin2hex(random_bytes(3))], $this->ownerId);
        $this->appIds[] = (string) $app['id'];
        self::$apps->publishApp((string) $app['id'], null, $this->ownerId);
        $slug = (string) self::$apps->getApp((string) $app['id'])['slug'];
        self::assertSame(200, $this->call('GET', "/api/app/{$slug}", $this->memberId)->getStatusCode());
        self::assertSame(200, $this->call('POST', "/api/app/{$slug}/native/request", null)->getStatusCode());
    }

    public function testAPluginsAnswerOpensTheAppAndWithdrawingItClosesItAgain(): void
    {
        $slug = $this->gatedApp(18);
        $result = $this->answer('POST', '/api/pass', 200, ['kind' => 'age', 'value' => 18, 'strength' => 'declared', 'method' => 'self_declaration']);
        self::assertObjectNotHasProperty('pass', $result['body'], 'the page never sees the pass itself');
        self::assertSame(['age', 18, 'declared'], [$result['body']->recorded['kind'], $result['body']->recorded['value'], $result['body']->recorded['strength']]);
        self::assertSame(200, $this->call('GET', "/api/app/{$slug}", $this->memberId)->getStatusCode());

        $listed = $this->json($this->call('GET', '/api/verification/receipts', $this->memberId))['receipts'];
        self::assertCount(1, $listed);
        self::assertSame([$this->pluginId, 'age', 18, 'declared', 'self_declaration', 'Test plugin'],
            [$listed[0]['plugin'], $listed[0]['kind'], $listed[0]['value'], $listed[0]['strength'], $listed[0]['method'], $listed[0]['pluginName']]);
        // What is kept: who, which plugin, what for, the value, how, until when. Nothing else.
        $columns = array_keys((array) self::$pdo->query('SELECT * FROM passes WHERE id = ' . self::$pdo->quote($listed[0]['id']))->fetch(PDO::FETCH_ASSOC));
        sort($columns);
        self::assertSame(['expires_at', 'id', 'issued_at', 'kind', 'method', 'plugin_id', 'revoked_at', 'strength', 'user_id', 'value'], $columns);

        self::assertSame(404, $this->call('DELETE', "/api/verification/receipts/{$listed[0]['id']}", $this->ownerId)->getStatusCode(), 'only its member withdraws it');
        self::assertSame(200, $this->call('DELETE', "/api/verification/receipts/{$listed[0]['id']}", $this->memberId)->getStatusCode());
        self::assertSame(403, $this->call('GET', "/api/app/{$slug}", $this->memberId)->getStatusCode());
    }

    public function testNothingIsRecordedOutsideTheGrant(): void
    {
        $pass = ['kind' => 'age', 'value' => 18, 'strength' => 'declared'];
        // Not the issuing route, not a POST, not a success, no pass: the answer passes through, nothing kept.
        $this->answer('POST', '/api/other', 200, $pass);
        $this->answer('GET', '/api/pass', 200, $pass);
        $this->answer('POST', '/api/pass', 422, $pass);
        $this->answer('POST', '/api/pass', 200, null);
        // A pass the plugin may not issue is refused outright.
        foreach ([
            'a kind it was not granted' => ['kind' => 'height', 'value' => 18, 'strength' => 'declared'],
            'a strength above its grant' => ['kind' => 'age', 'value' => 18, 'strength' => 'verified'],
            'below its range' => ['kind' => 'age', 'value' => 12, 'strength' => 'declared'],
            'above its range' => ['kind' => 'age', 'value' => 121, 'strength' => 'declared'],
            'not a whole number' => ['kind' => 'age', 'value' => '18', 'strength' => 'declared'],
        ] as $what => $bad) {
            try {
                $this->answer('POST', '/api/pass', 200, $bad);
                self::fail("recorded {$what}");
            } catch (\InvalidArgumentException) {
            }
        }
        self::assertSame(0, $this->receiptCount($this->memberId));

        // A body naming someone else still records for the person who asked, and only them.
        $other = $this->makeUser();
        $this->answer('POST', '/api/pass', 200, $pass + ['userId' => $other, 'user_id' => $other]);
        self::assertSame(1, $this->receiptCount($this->memberId));
        self::assertSame(0, $this->receiptCount($other));

        // A plugin turned off since its page opened issues nothing.
        $plugin = $this->plugins->find($this->pluginId);
        $this->plugins->setEnabled($this->pluginId, false);
        $this->fresh();
        try {
            $this->gate->recordFromPluginAnswer($plugin, $this->memberId, 'POST', '/api/pass', ['status' => 200, 'body' => (object) ['pass' => (object) $pass]]);
            self::fail('a turned-off plugin issued a pass');
        } catch (\InvalidArgumentException) {
        }
        self::assertSame(1, $this->receiptCount($this->memberId));
    }

    public function testAPassOpensOnlyWhatItEstablished(): void
    {
        $adult = $this->gatedApp(18);
        $older = $this->gatedApp(21);
        $stronger = $this->gatedApp(18, 'estimated');
        $otherPlugin = $this->installRow([self::AGE]);
        $theOthers = $this->gatedApp(18, 'declared', $otherPlugin);
        $this->answer('POST', '/api/pass', 200, ['kind' => 'age', 'value' => 18, 'strength' => 'declared']);
        self::assertSame(200, $this->call('GET', "/api/app/{$adult}", $this->memberId)->getStatusCode());
        self::assertSame(403, $this->call('GET', "/api/app/{$older}", $this->memberId)->getStatusCode(), 'an 18 pass is no 21');
        self::assertSame(403, $this->call('GET', "/api/app/{$stronger}", $this->memberId)->getStatusCode(), 'a declaration is no estimate');
        self::assertSame(403, $this->call('GET', "/api/app/{$theOthers}", $this->memberId)->getStatusCode(), 'one plugin\'s pass is not another\'s');

        // An expired pass opens nothing.
        self::$pdo->prepare('UPDATE passes SET expires_at = ? WHERE user_id = ?')->execute([gmdate('Y-m-d H:i:s', time() - 60), $this->memberId]);
        self::assertSame(403, $this->call('GET', "/api/app/{$adult}", $this->memberId)->getStatusCode());
    }

    public function testATurnedOffPluginClosesTheAppsThatNeedItAndRemovingItWithdrawsItsPasses(): void
    {
        $slug = $this->gatedApp(18);
        $this->answer('POST', '/api/pass', 200, ['kind' => 'age', 'value' => 18, 'strength' => 'declared']);
        self::assertSame(200, $this->call('GET', "/api/app/{$slug}", $this->memberId)->getStatusCode());

        $this->plugins->setEnabled($this->pluginId, false);
        $off = $this->call('GET', "/api/app/{$slug}", $this->memberId);
        self::assertSame(403, $off->getStatusCode());
        self::assertSame('plugin_unavailable', $this->json($off)['code'] ?? null);
        self::assertFalse($this->json($off)['requirement']['available']);
        $this->plugins->setEnabled($this->pluginId, true);
        self::assertSame(200, $this->call('GET', "/api/app/{$slug}", $this->memberId)->getStatusCode());

        // Its app is gone already (a test row); removing the plugin withdraws what it issued.
        $this->plugins->remove($this->pluginId);
        self::assertSame(0, (int) self::$pdo->query('SELECT COUNT(*) FROM passes WHERE revoked_at IS NULL AND user_id = ' . self::$pdo->quote($this->memberId))->fetchColumn());
        self::assertSame('plugin_unavailable', $this->json($this->call('GET', "/api/app/{$slug}", $this->memberId))['code'] ?? null);
        // The app keeps its setting and says what is missing.
        self::assertSame($this->pluginId, self::$apps->getAppBySlug($slug)['settings']['requires'][0]['plugin'] ?? null);
    }

    public function testThePluginPageIsToldWhatItIsForAndSendsTheMemberBackOnlyToThisSiteOrThisAppsOwnDomain(): void
    {
        $slug = $this->gatedApp(18);
        $context = $this->json($this->call('GET', "/api/plugins/{$this->pluginId}/context?app={$slug}&kind=age", $this->memberId));
        self::assertSame(['age', 18, false, true], [$context['requirement']['kind'], $context['requirement']['min'], $context['requirement']['satisfied'], $context['requirement']['available']]);
        self::assertSame('/app/' . $slug, $context['returnTo']);
        foreach ([
            '/app/' . $slug . '?x=1' => '/app/' . $slug . '?x=1',
            '//evil.example/x' => '/app/' . $slug,
            'https://evil.example/' => '/app/' . $slug,
            'javascript:alert(1)' => '/app/' . $slug,
            "/app/x\nSet-Cookie: a=b" => '/app/' . $slug,
            '/\\evil.example' => '/app/' . $slug,
        ] as $return => $expected) {
            $answer = $this->json($this->call('GET', "/api/plugins/{$this->pluginId}/context?app={$slug}&kind=age&return=" . rawurlencode($return), $this->memberId));
            self::assertSame($expected, $answer['returnTo'], $return);
        }
        // Only for what the app asks of this plugin, and only while the plugin is on.
        self::assertSame(404, $this->call('GET', "/api/plugins/{$this->pluginId}/context?app={$slug}&kind=height", $this->memberId)->getStatusCode());
        $other = $this->installRow([self::AGE]);
        self::assertSame(404, $this->call('GET', "/api/plugins/{$other}/context?app={$slug}&kind=age", $this->memberId)->getStatusCode());
        $this->plugins->setEnabled($this->pluginId, false);
        self::assertSame(404, $this->call('GET', "/api/plugins/{$this->pluginId}/context?app={$slug}&kind=age", $this->memberId)->getStatusCode());
    }

    public function testAMemberWithoutAPassHoldsNoPermissionWhateverPathAsks(): void
    {
        $slug = $this->gatedApp(18);
        $appId = (string) self::$apps->getAppBySlug($slug)['id'];
        $users = new AppUserService(self::$mysql);
        $users->useAccessGate($this->gate);
        $role = $users->createRole($appId, ['name' => 'Reader']);
        $users->setRolePermissions((string) $role['id'], [['formId' => null, 'permission' => AppPermissions::VIEW_ALL_RESPONSES]], true);
        $this->addMember($appId, $this->memberId, (string) $role['id']);

        // The member list and detail, Aokie Companion and the MCP grants all ask through these two.
        self::assertFalse($users->hasPermission($appId, $this->memberId, AppPermissions::VIEW_ALL_RESPONSES));
        self::assertSame(['appLevel' => [], 'formLevel' => []], $users->getUserPermissions($appId, $this->memberId));
        self::assertTrue($users->hasPermission($appId, $this->ownerId, AppPermissions::VIEW_ALL_RESPONSES), 'the owner is never gated');

        $this->answer('POST', '/api/pass', 200, ['kind' => 'age', 'value' => 18, 'strength' => 'declared']);
        $this->fresh();
        $users = new AppUserService(self::$mysql);
        $users->useAccessGate($this->gate);
        self::assertTrue($users->hasPermission($appId, $this->memberId, AppPermissions::VIEW_ALL_RESPONSES));
    }

    public function testThePluginsAccountIsNobodysToSignInAsManageOrBeAMemberOf(): void
    {
        // Its password matches nothing.
        try {
            self::$auth->login('plugins@formlogic.invalid', '!');
            self::fail('signed in as the Plugins account');
        } catch (\Throwable) {
        }
        // Nobody holds a permission on one of its apps, whatever role they were given.
        $app = self::$apps->createApp(['name' => 'Plugin: test', 'settings' => ['softnApp' => true, 'plugin' => $this->pluginId]], PluginService::SYSTEM_USER_ID);
        $appId = (string) $app['id'];
        $this->appIds[] = $appId;
        $users = new AppUserService(self::$mysql);
        $users->useAccessGate($this->gate);
        $role = $users->createRole($appId, ['name' => 'Editor']);
        $users->setRolePermissions((string) $role['id'], [['formId' => null, 'permission' => AppPermissions::MANAGE_APP]], true);
        $this->addMember($appId, $this->memberId, (string) $role['id']);
        self::assertFalse($users->hasPermission($appId, $this->memberId, AppPermissions::MANAGE_APP));
        // An owner's settings cannot make an app of theirs a plugin.
        $fake = self::$apps->createApp(['name' => 'Not a plugin', 'settings' => ['plugin' => $this->pluginId]], $this->ownerId);
        $this->appIds[] = (string) $fake['id'];
        self::assertNull($this->plugins->forApp(self::$apps->getApp((string) $fake['id'])));

        // The administrator's tools do not reach it, or change its apps.
        $admin = $this->makeUser();
        self::$pdo->prepare('UPDATE users SET is_admin = 1 WHERE id = ?')->execute([$admin]);
        self::assertSame(404, $this->call('POST', '/api/admin/users/' . PluginService::SYSTEM_USER_ID . '/password', $admin, ['password' => 'x'])->getStatusCode());
        self::assertSame(404, $this->call('POST', '/api/admin/users/' . PluginService::SYSTEM_USER_ID . '/delete', $admin)->getStatusCode());
        self::assertSame(200, $this->call('POST', "/api/admin/users/{$this->ownerId}/password", $admin, ['password' => 'x'])->getStatusCode(), 'anyone else is still reached');
        self::assertSame(403, $this->call('PUT', "/api/admin/apps/{$appId}", $admin, ['status' => 'draft'])->getStatusCode());
        self::assertSame(200, $this->call('GET', "/api/admin/apps/{$appId}", $admin)->getStatusCode(), 'it can be looked at');
        self::assertSame(404, $this->call('GET', '/api/admin/users/' . PluginService::SYSTEM_USER_ID . '/apps', $admin)->getStatusCode(), 'nobody acts as it');
        $listed = (new AdminService(self::$mysql))->listUsers('plugins@formlogic.invalid');
        self::assertSame([], $listed['users']);
    }

    public function testTheSettingIsHeldToItsShape(): void
    {
        $id = $this->pluginId;
        self::assertSame([['plugin' => $id, 'kind' => 'age', 'min' => 18, 'strength' => 'declared']],
            AccessGateService::normalizeRequirements([['plugin' => $id, 'kind' => 'age', 'min' => 18]]));
        self::assertSame([['plugin' => $id, 'kind' => 'age', 'min' => 21, 'strength' => 'estimated']],
            AccessGateService::normalizeRequirements([['plugin' => $id, 'kind' => 'age', 'min' => 18], ['plugin' => $id, 'kind' => 'age', 'min' => 21, 'strength' => 'estimated']]), 'one a plugin and kind, the last kept');
        foreach ([null, true, ['plugin' => $id], [['plugin' => $id, 'kind' => 'age', 'min' => '18']], [['plugin' => 'Bad Id', 'kind' => 'age', 'min' => 18]],
            [['plugin' => $id, 'kind' => 'age', 'min' => -1]], [['plugin' => $id, 'kind' => 'age', 'min' => 18, 'strength' => 'guessed']]] as $bad) {
            self::assertSame([], AccessGateService::normalizeRequirements($bad), json_encode($bad));
        }
        self::assertCount(4, AccessGateService::normalizeRequirements(array_map(fn ($n) => ['plugin' => $id, 'kind' => 'k' . $n, 'min' => 1], range(1, 9))));
        $app = self::$apps->createApp(['name' => 'Bad requirement ' . bin2hex(random_bytes(3)), 'settings' => ['requires' => [['kind' => 'age']], 'ageGate' => ['minimumAge' => 18]]], $this->ownerId);
        $this->appIds[] = (string) $app['id'];
        $settings = self::$apps->getApp((string) $app['id'])['settings'] ?? [];
        self::assertArrayNotHasKey('requires', $settings);
        self::assertArrayNotHasKey('ageGate', $settings);
    }

    public function testThePluginManifestIsHeldToItsShape(): void
    {
        $manifest = fn (array $plugin, array $routes = [['path' => '/api/pass', 'method' => 'POST']]) => ['version' => '1.2.3', 'server' => ['routes' => $routes], 'formlogicPlugin' => $plugin];
        $good = ['id' => 'example.plugin', 'name' => 'Example', 'passes' => [self::AGE]];
        $read = PluginService::pluginManifest($manifest($good));
        self::assertSame(['example.plugin', 'Example', '1.2.3', ['age']], [$read['id'], $read['name'], $read['version'], array_column($read['passes'], 'kind')]);
        foreach ([
            'no section' => ['version' => '1'],
            'a bad id' => $manifest(['id' => 'Has Spaces', 'name' => 'x', 'passes' => []]),
            'no name' => $manifest(['id' => 'example.plugin', 'passes' => []]),
            'an undeclared route' => $manifest(['id' => 'example.plugin', 'name' => 'x', 'passes' => [['issueRoute' => '/api/elsewhere'] + self::AGE]]),
            'a GET route' => $manifest($good, [['path' => '/api/pass', 'method' => 'GET']]),
            'an unknown strength' => $manifest(['id' => 'example.plugin', 'name' => 'x', 'passes' => [['strengths' => ['sworn']] + self::AGE]]),
            'no strengths' => $manifest(['id' => 'example.plugin', 'name' => 'x', 'passes' => [['strengths' => []] + self::AGE]]),
            'a reversed range' => $manifest(['id' => 'example.plugin', 'name' => 'x', 'passes' => [['min' => 50, 'max' => 10] + self::AGE]]),
            'a kind twice' => $manifest(['id' => 'example.plugin', 'name' => 'x', 'passes' => [self::AGE, self::AGE]]),
            'five passes' => $manifest(['id' => 'example.plugin', 'name' => 'x', 'passes' => array_map(fn ($n) => ['kind' => 'k' . $n] + self::AGE, range(1, 5))]),
            'a use the site has not got' => $manifest(['uses' => ['microphone']] + $good),
            'the camera without its routes' => $manifest(['uses' => ['camera']] + $good),
            'a pass issued on a site route' => $manifest(['id' => 'example.plugin', 'name' => 'x', 'passes' => [['issueRoute' => '/api/site/camera/decide'] + self::AGE]],
                [['path' => '/api/site/camera/decide', 'method' => 'POST']]),
            'a sandbox permission plugins may not have' => ['server' => ['routes' => [['path' => '/api/pass', 'method' => 'POST']], 'requires' => ['capabilities' => ['photos']]], 'formlogicPlugin' => $good],
            'a setting with no type' => $manifest(['settings' => [['key' => 'x', 'label' => 'X']]] + $good),
            'a setting whose default is out of range' => $manifest(['settings' => [['key' => 'x', 'label' => 'X', 'type' => 'integer', 'min' => 1, 'max' => 5, 'default' => 9]]] + $good),
            'a choice whose default is not one' => $manifest(['settings' => [['key' => 'x', 'label' => 'X', 'type' => 'choice', 'options' => [['value' => 'a']], 'default' => 'b']]] + $good),
        ] as $what => $bad) {
            try {
                PluginService::pluginManifest($bad);
                self::fail("accepted {$what}");
            } catch (\InvalidArgumentException) {
            }
        }
        // Settings handed to a plugin are held to their schema: a value that does not fit is its default.
        $schema = PluginService::pluginManifest($manifest(['settings' => [
            ['key' => 'n', 'label' => 'N', 'type' => 'integer', 'min' => 1, 'max' => 5, 'default' => 2],
            ['key' => 'c', 'label' => 'C', 'type' => 'choice', 'options' => [['value' => 'a'], ['value' => 'b']], 'default' => 'a'],
            ['key' => 'b', 'label' => 'B', 'type' => 'boolean', 'default' => false],
        ]] + $good))['settings'];
        self::assertSame(['n' => 4, 'c' => 'a', 'b' => true], PluginService::settingsValues($schema, ['n' => 4, 'c' => 'z', 'b' => true, 'other' => 1]));
        // An upload cannot take a built-in's id.
        $upload = ['files' => ['manifest.json' => json_encode(['id' => 'x', 'main' => 'ui/main.ui', 'version' => '1', 'formlogicPlugin' => ['id' => 'formlogic.mine', 'name' => 'Mine']]), 'ui/main.ui' => '<Text>Hi</Text>']];
        try {
            $this->plugins->inspect($upload, 'upload');
            self::fail('an upload posed as a built-in');
        } catch (\InvalidArgumentException $e) {
            self::assertStringContainsString('formlogic.', $e->getMessage());
        }
        $upload['files']['manifest.json'] = str_replace('formlogic.mine', 'someone.mine', $upload['files']['manifest.json']);
        self::assertSame(['someone.mine', null], [($read = $this->plugins->inspect($upload, 'upload'))['id'], $read['updates']]);

        // The plugin that ships with FormLogic reads as one, and is a valid SoftN project.
        $builtin = $this->plugins->builtins()['formlogic.age-gate'] ?? null;
        self::assertNotNull($builtin);
        self::assertSame([['kind' => 'age', 'min' => 13, 'max' => 120, 'strengths' => ['declared', 'estimated'], 'issueRoute' => '/api/pass']],
            array_map(fn ($p) => array_intersect_key($p, array_flip(['kind', 'min', 'max', 'strengths', 'issueRoute'])), $builtin['passes']));
    }

    public function testABuiltInPluginInstallsIssuesThroughItsOwnBackendUpdatesAndRemoves(): void
    {
        $native = new NativeAppService(self::$tmpRoot . '/native-' . bin2hex(random_bytes(3)));
        if (!$native->available()) {
            $this->markTestSkipped('No SoftN runner here (set FORMLOGIC_NODE_BIN)');
        }
        // A copy of the plugin that ships, so a newer version can be laid beside it.
        $shipped = dirname(__DIR__, 2) . '/resources/plugins/age-gate';
        $builtins = self::$tmpRoot . '/builtins-' . bin2hex(random_bytes(3));
        $all = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($shipped, \FilesystemIterator::SKIP_DOTS));
        foreach ($all as $source) {
            $file = str_replace('\\', '/', substr((string) $source, strlen($shipped) + 1));
            @mkdir(dirname("{$builtins}/age-gate/{$file}"), 0777, true);
            copy((string) $source, "{$builtins}/age-gate/{$file}");
        }
        $version = json_decode((string) file_get_contents("{$shipped}/manifest.json"), true)['version'];
        $next = preg_replace_callback('/(\d+)$/', fn ($m) => (string) ((int) $m[1] + 1), $version);
        $plugins = new PluginService(self::$mysql, self::$apps, $native, $builtins);
        $gate = new AccessGateService(self::$mysql, $plugins);
        self::$pdo->prepare("DELETE FROM plugins WHERE manifest_id = 'formlogic.age-gate' AND scope = 'site'")->execute();
        $this->pluginIds[] = 'formlogic.age-gate';

        $plugin = $plugins->installBuiltin('formlogic.age-gate', $this->ownerId);
        $this->appIds[] = $plugin['appId'];
        self::assertSame(['formlogic.age-gate', $version, true, 'builtin', ['camera']], [$plugin['manifestId'], $plugin['version'], $plugin['enabled'], $plugin['source'], $plugin['uses']]);
        self::assertSame(['bufferYears' => 7, 'turns' => 'all', 'ageModel' => 'prefer'], $plugin['settings'], 'its settings start at their defaults');
        $app = self::$apps->getApp($plugin['appId']);
        self::assertSame([PluginService::SYSTEM_USER_ID, 'published'], [$app['ownerId'], $app['status']]);
        self::assertNotNull($plugins->forApp($app));
        self::assertNull($plugins->pendingUpdate($plugin), 'what was installed is what ships');

        // Its own backend, in the runner, answers a declaration with a pass, recorded for whoever asked.
        $identity = ['formlogic' => ['appId' => $plugin['appId'], 'userId' => $this->memberId, 'roleId' => 'member']];
        $ask = fn (array $body) => $native->request($plugin['appId'], ['method' => 'POST', 'path' => '/api/pass', 'query' => (object) [], 'body' => (object) $body,
            'headers' => (object) ['authorization' => '', 'idempotency-key' => ''], 'client_ip' => '127.0.0.1', 'photos' => false], $identity, [], null, true);
        $refused = $ask(['minimumAge' => 18]);
        self::assertSame(422, $refused['status'], 'a declaration is made, not assumed');
        $answer = $gate->recordFromPluginAnswer($plugin, $this->memberId, 'POST', '/api/pass', $ask(['minimumAge' => 18, 'confirmed' => true]));
        self::assertSame(200, $answer['status']);
        self::assertSame(1, $this->receiptCount($this->memberId));
        self::assertTrue($gate->satisfies($this->memberId, ['plugin' => 'formlogic.age-gate', 'kind' => 'age', 'min' => 18, 'strength' => 'declared']));

        // A newer version laid beside it is offered, taken, and then no longer offered.
        $manifest = json_decode((string) file_get_contents("{$builtins}/age-gate/manifest.json"), true);
        $manifest['version'] = $next;
        file_put_contents("{$builtins}/age-gate/manifest.json", json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
        $plugins = new PluginService(self::$mysql, self::$apps, $native, $builtins);
        self::assertSame($next, $plugins->pendingUpdate($plugins->find('formlogic.age-gate'))['version'] ?? null);
        $plugins->setSettings('formlogic.age-gate', ['bufferYears' => 10]);
        try {
            $plugins->setSettings('formlogic.age-gate', ['bufferYears' => 99]);
            self::fail('a setting out of its range');
        } catch (\InvalidArgumentException) {
        }
        $updated = $plugins->updateBuiltin('formlogic.age-gate');
        self::assertSame($next, $updated['version']);
        self::assertSame(['bufferYears' => 10, 'turns' => 'all', 'ageModel' => 'prefer'], $updated['settings'], 'settings that still fit are kept');
        self::assertNull($plugins->pendingUpdate($updated));
        self::assertSame(1, $this->receiptCount($this->memberId), 'its passes stay');

        $plugins->remove('formlogic.age-gate');
        self::assertNull($plugins->find('formlogic.age-gate'));
        self::assertNull(self::$apps->getApp($plugin['appId']));
        self::assertSame(0, (int) self::$pdo->query('SELECT COUNT(*) FROM passes WHERE revoked_at IS NULL AND user_id = ' . self::$pdo->quote($this->memberId))->fetchColumn());
    }

    public function testAnUploadedPluginInstallsAndItsNextVersionUpdatesIt(): void
    {
        $native = new NativeAppService(self::$tmpRoot . '/native-' . bin2hex(random_bytes(3)));
        if (!$native->available()) {
            $this->markTestSkipped('No SoftN runner here (set FORMLOGIC_NODE_BIN)');
        }
        $plugins = new PluginService(self::$mysql, self::$apps, $native);
        // The Age gate's own files, as someone's upload under another id.
        $project = function (string $id, string $version) {
            $dir = dirname(__DIR__, 2) . '/resources/plugins/age-gate';
            $files = [];
            $assets = [];
            foreach (new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS)) as $file) {
                $relative = str_replace('\\', '/', substr((string) $file, strlen($dir) + 1));
                if (str_starts_with($relative, 'assets/')) {
                    $assets[$relative] = base64_encode((string) file_get_contents((string) $file));
                } else {
                    $files[$relative] = (string) file_get_contents((string) $file);
                }
            }
            $manifest = json_decode($files['manifest.json'], true);
            $manifest['id'] = $id;
            $manifest['version'] = $version;
            $manifest['formlogicPlugin']['id'] = $id;
            $manifest['formlogicPlugin']['name'] = 'Someone\'s age check';
            $files['manifest.json'] = json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
            return ['files' => $files, 'assets' => $assets];
        };
        $id = 'someone.age-' . bin2hex(random_bytes(3));
        $this->pluginIds[] = $id;

        $read = $plugins->inspect($project($id, '2.0.0'), 'upload');
        self::assertSame([$id, null, ['camera'], ['Keep its own records, in a database only it can read', 'Make random numbers and seal its own data']],
            [$read['id'], $read['updates'], $read['uses'], PluginService::review($read)['sandbox']]);
        $installed = $plugins->installUpload($project($id, '2.0.0'), $this->ownerId);
        $this->appIds[] = $installed['appId'];
        self::assertSame([$id, 'upload', '2.0.0', true], [$installed['manifestId'], $installed['source'], $installed['version'], $installed['enabled']]);
        self::assertNull($plugins->pendingUpdate($installed), 'an upload is updated by uploading, never from what ships');
        $plugins->setSettings($id, ['turns' => 'updown']);

        // Its own backend runs, in the runner, under its new id.
        $identity = ['formlogic' => ['appId' => $installed['appId'], 'userId' => $this->memberId, 'roleId' => 'member']];
        $answer = $native->request($installed['appId'], ['method' => 'POST', 'path' => '/api/pass', 'query' => (object) [], 'body' => (object) ['minimumAge' => 18, 'confirmed' => true],
            'headers' => (object) ['authorization' => '', 'idempotency-key' => ''], 'client_ip' => '127.0.0.1', 'photos' => false], $identity, [], null, true);
        self::assertSame(200, $answer['status']);

        // The next version, uploaded: read as an update, then taken, keeping what still fits.
        self::assertSame(['version' => '2.0.0'], $plugins->inspect($project($id, '2.1.0'), 'upload')['updates']);
        $updated = $plugins->installUpload($project($id, '2.1.0'), $this->ownerId);
        self::assertSame([$installed['appId'], '2.1.0', 'updown'], [$updated['appId'], $updated['version'], $updated['settings']['turns']]);

        // A built-in's id cannot be uploaded, and neither can the same id from elsewhere.
        try {
            $plugins->installUpload($project('formlogic.age-gate', '9.0.0'), $this->ownerId);
            self::fail('an upload took a built-in\'s id');
        } catch (\InvalidArgumentException) {
        }
        $plugins->remove($id);
        self::assertNull($plugins->find($id));
    }

    /** A plugin's answer on its own route, recorded (or not) for the member. Returns what the page gets. */
    private function answer(string $method, string $path, int $status, ?array $pass): array
    {
        $plugin = $this->plugins->find($this->pluginId);
        self::assertNotNull($plugin);
        $body = (object) ['ok' => true];
        if ($pass !== null) {
            $body->pass = (object) $pass;
        }
        $result = $this->gate->recordFromPluginAnswer($plugin, $this->memberId, $method, $path, ['status' => $status, 'body' => $body]);
        self::assertObjectNotHasProperty('pass', $result['body']);
        return $result;
    }

    private function receiptCount(string $userId): int
    {
        $stmt = self::$pdo->prepare('SELECT COUNT(*) FROM passes WHERE user_id = ?');
        $stmt->execute([$userId]);
        return (int) $stmt->fetchColumn();
    }

    /** A plugin row, as an install records it, with no project behind it. */
    private function installRow(array $grants): string
    {
        $manifestId = 'test.plugin-' . bin2hex(random_bytes(4));
        $now = gmdate('Y-m-d H:i:s');
        self::$pdo->prepare("INSERT INTO plugins (id, manifest_id, scope, source, app_id, name, version, enabled, grants, uses, settings_schema, settings, installed_by, installed_at, updated_at) VALUES (?, ?, 'site', 'upload', ?, 'Test plugin', '1.0.0', 1, ?, '[]', '[]', '{}', NULL, ?, ?)")
            ->execute([bin2hex(random_bytes(16)), $manifestId, 'no-app-' . bin2hex(random_bytes(4)), json_encode($grants), $now, $now]);
        $this->pluginIds[] = $manifestId;
        $this->fresh();
        return $manifestId;
    }

    /** New services and routes, so nothing read in an earlier step is remembered. */
    private function fresh(): void
    {
        $conn = self::$mysql;
        $this->plugins = new PluginService($conn, self::$apps, new NativeAppService(self::$tmpRoot . '/native'));
        $this->gate = new AccessGateService($conn, $this->plugins);
        $authRequired = new AuthMiddleware(self::$auth);
        $authOptional = new AuthMiddleware(self::$auth, true);
        $gateMiddleware = new AppAccessGateMiddleware(self::$apps, $this->gate, $authOptional);
        $controller = new PluginController(self::$apps, $this->gate, $this->plugins, new AppDomainService($conn));
        $ok = static function ($request, $response) {
            $response->getBody()->write('{"data":"the app\'s"}');
            return $response->withHeader('Content-Type', 'application/json');
        };
        $slim = AppFactory::create();
        $slim->group('/api/app/{slug}', function (RouteCollectorProxy $group) use ($ok, $authRequired) {
            $group->get('', $ok)->add($authRequired);
            $group->get('/forms/{formId}/responses', $ok)->add($authRequired);
            $group->get('/membership', $ok)->add($authRequired);
            $group->get('/manifest.json', $ok);
        })->add($gateMiddleware);
        $slim->post('/api/app/{slug}/native/request', $ok)->add($gateMiddleware)->add($authOptional);
        $slim->get('/api/plugins/{plugin}/context', fn ($rq, $rs, $args) => $controller->context($rq, $rs, $args))->add($authRequired);
        $slim->get('/api/verification/receipts', fn ($rq, $rs) => $controller->receipts($rq, $rs))->add($authRequired);
        $slim->delete('/api/verification/receipts/{id}', fn ($rq, $rs, $args) => $controller->revoke($rq, $rs, $args))->add($authRequired);
        $slim->group('/api/admin', function (RouteCollectorProxy $group) use ($ok) {
            $group->post('/users/{id}/password', $ok);
            $group->post('/users/{id}/delete', $ok);
            $group->get('/apps/{id}', $ok);
            $group->put('/apps/{id}', $ok);
        })->add(new PluginAccountGuardMiddleware(self::$apps))->add($authRequired);
        $slim->group('/api/admin/users/{ownerId}', function (RouteCollectorProxy $group) use ($ok) {
            $group->get('/apps', $ok);
        })->add(new AdminActAsMiddleware(self::$auth))->add($authRequired);
        $slim->addRoutingMiddleware();
        self::$slim = $slim;
    }

    private function gatedApp(int $min, string $strength = 'declared', ?string $plugin = null): string
    {
        $requires = [['plugin' => $plugin ?? $this->pluginId, 'kind' => 'age', 'min' => $min, 'strength' => $strength]];
        $app = self::$apps->createApp(['name' => 'Gated ' . bin2hex(random_bytes(4)), 'settings' => ['requires' => $requires]], $this->ownerId);
        $this->appIds[] = (string) $app['id'];
        self::$apps->publishApp((string) $app['id'], null, $this->ownerId);
        $stored = self::$apps->getApp((string) $app['id']);
        self::assertEquals($requires, $stored['settings']['requires'] ?? null);
        return (string) $stored['slug'];
    }

    private function addMember(string $appId, string $userId, string $roleId): void
    {
        self::$pdo->prepare("INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at) VALUES (?, ?, ?, ?, 'active', NOW())")
            ->execute(['au-' . bin2hex(random_bytes(10)), $appId, $userId, $roleId]);
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

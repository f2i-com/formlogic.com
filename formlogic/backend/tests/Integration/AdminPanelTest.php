<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use Firebase\JWT\JWT;
use FormLogic\Controllers\AdminController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Middleware\AdminGateMiddleware;
use FormLogic\Services\AccountBackupService;
use FormLogic\Services\AppUserService;
use FormLogic\Middleware\MaintenanceMiddleware;
use FormLogic\Models\User;
use FormLogic\Services\AdminService;
use FormLogic\Services\AppService;
use FormLogic\Services\AuthService;
use FormLogic\Services\FlowService;
use FormLogic\Services\FormService;
use FormLogic\Services\MaintenanceService;
use FormLogic\Services\ResponseService;
use FormLogic\Services\UpgradeService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * Admin panel acceptance: the platform-admin gate, global session boot,
 * maintenance mode (file flag + middleware allowlist + admin bypass),
 * broadcast notices, the no-response-data oversight boundary, and the
 * upgrade machinery's data-safety invariants (.env / per-form SQLite are
 * never touched; a DB export + code snapshot exist before files change).
 */
class AdminPanelTest extends TestCase
{
    private const JWT_SECRET = 'admin-panel-test-secret-0123456789abcdef';

    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static AuthService $auth;
    private static AdminService $admin;
    private static FormService $forms;
    private static ResponseService $responses;
    private static AppService $apps;
    private static SQLiteConnection $sqlite;
    private static FlowService $flows;
    private static string $tmpRoot = '';

    private string $userId = '';
    private string $adminId = '';

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
        self::$tmpRoot = sys_get_temp_dir() . '/formlogic-admin-test-' . bin2hex(random_bytes(4));
        mkdir(self::$tmpRoot, 0777, true);

        $sqlite = new SQLiteConnection(self::$tmpRoot . '/sqlite');
        self::$sqlite = $sqlite;
        self::$forms = new FormService($conn, $sqlite);
        self::$responses = new ResponseService($conn, $sqlite);
        self::$apps = new AppService($conn, self::$forms);
        self::$flows = new FlowService($conn);
        self::$admin = new AdminService($conn);
        self::$auth = new AuthService($conn, [
            'secret' => self::JWT_SECRET,
            'expiry' => 3600,
            'algorithm' => 'HS256',
            'issuer' => 'formlogic',
            'audience' => 'formlogic-api',
        ], [], null, 30, ['allowlisted-admin@test.local']);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        // Fresh epoch so boot tests from a previous run don't invalidate this run's tokens.
        self::$pdo->exec("DELETE FROM system_meta WHERE meta_key = 'session_epoch'");
        $this->userId = $this->makeUser(false);
        $this->adminId = $this->makeUser(true);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        self::$pdo->exec("DELETE FROM system_meta WHERE meta_key = 'session_epoch'");
        self::$pdo->prepare('DELETE FROM admin_notices WHERE created_by IN (?, ?)')->execute([$this->userId, $this->adminId]);
        foreach ([$this->userId, $this->adminId] as $uid) {
            if ($uid === '') {
                continue;
            }
            self::$pdo->prepare('DELETE FROM flow_definitions WHERE owner_user_id = ?')->execute([$uid]);
            $owned = self::$pdo->prepare('SELECT id FROM apps WHERE owner_id = ?');
            $owned->execute([$uid]);
            foreach ($owned->fetchAll(PDO::FETCH_COLUMN) as $aid) {
                self::$pdo->prepare('DELETE FROM app_forms WHERE app_id = ?')->execute([$aid]);
                self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$aid]);
                self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?)')->execute([$aid]);
                self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$aid]);
            }
            self::$pdo->prepare('DELETE FROM apps WHERE owner_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM forms WHERE user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
        }
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    private function makeUser(bool $isAdmin): string
    {
        $id = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, is_admin) VALUES (?, ?, 'x', 'T', ?)")
            ->execute([$id, $id . '@test.local', $isAdmin ? 1 : 0]);
        return $id;
    }

    private function tokenFor(string $userId, int $iat): string
    {
        $stmt = self::$pdo->prepare('SELECT email FROM users WHERE id = ?');
        $stmt->execute([$userId]);
        return JWT::encode([
            'iss' => 'formlogic', 'aud' => 'formlogic-api', 'sub' => $userId,
            'email' => (string) $stmt->fetchColumn(),
            'iat' => $iat, 'nbf' => $iat, 'exp' => time() + 3600, 'tv' => 0,
        ], self::JWT_SECRET, 'HS256');
    }

    /** A token carrying the session-generation claim, exactly as AuthService issues it (FL-17). */
    private function tokenWithSg(string $userId, int $iat, int $sg): string
    {
        $stmt = self::$pdo->prepare('SELECT email FROM users WHERE id = ?');
        $stmt->execute([$userId]);
        return JWT::encode([
            'iss' => 'formlogic', 'aud' => 'formlogic-api', 'sub' => $userId,
            'email' => (string) $stmt->fetchColumn(),
            'iat' => $iat, 'nbf' => $iat, 'exp' => time() + 3600, 'tv' => 0, 'sg' => $sg,
        ], self::JWT_SECRET, 'HS256');
    }

    private function userModel(string $userId): User
    {
        $stmt = self::$pdo->prepare('SELECT * FROM users WHERE id = ?');
        $stmt->execute([$userId]);
        return User::fromArray($stmt->fetch(PDO::FETCH_ASSOC));
    }

    private function request(string $method, string $path, ?array $body = null, ?string $asUserId = null): ServerRequestInterface
    {
        $req = (new ServerRequestFactory())->createServerRequest($method, $path);
        if ($body !== null) {
            $req = $req->withParsedBody($body);
        }
        if ($asUserId !== null) {
            $req = $req->withAttribute('userId', $asUserId)->withAttribute('user', $this->userModel($asUserId));
        }
        return $req;
    }

    private function passthroughHandler(): RequestHandlerInterface
    {
        return new class implements RequestHandlerInterface {
            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                $r = (new ResponseFactory())->createResponse(200);
                $r->getBody()->write('{"ok":true}');
                return $r;
            }
        };
    }

    private function controller(?UpgradeService $upgrade = null, ?MaintenanceService $maintenance = null): AdminController
    {
        $maintenance ??= new MaintenanceService(self::$tmpRoot . '/maintenance-' . bin2hex(random_bytes(3)) . '.json');
        $upgrade ??= new UpgradeService(self::$tmpRoot . '/nowhere', self::$mysql, $maintenance);
        $backup = new AccountBackupService(
            self::$mysql, self::$sqlite, self::$forms, self::$apps,
            new AppUserService(self::$mysql), self::$flows, self::$responses,
            [], self::$tmpRoot . '/sqlite', self::$tmpRoot . '/uploads'
        );
        return new AdminController(
            self::$admin, self::$auth, $maintenance, $upgrade,
            self::$forms, self::$apps, self::$flows, self::$responses,
            null, null, $backup
        );
    }

    private function json(ResponseInterface $response): array
    {
        $response->getBody()->rewind();
        return json_decode((string) $response->getBody(), true) ?? [];
    }

    // ── admin identity + gate ───────────────────────────────────────────────

    public function testPlatformAdminRequiresDurableFlagAndDemoIsDenied(): void
    {
        $this->assertTrue(self::$auth->isPlatformAdmin($this->userModel($this->adminId)));
        $this->assertFalse(self::$auth->isPlatformAdmin($this->userModel($this->userId)));

        // A configured bootstrap address is reserved, never runtime authority.
        $allowId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash) VALUES (?, 'allowlisted-admin@test.local', 'x')")->execute([$allowId]);
        try {
            $this->assertFalse(self::$auth->isPlatformAdmin($this->userModel($allowId)));
            try {
                self::$auth->register('allowlisted-admin@test.local', 'correct-horse-battery');
                $this->fail('reserved bootstrap address must not register publicly');
            } catch (\RuntimeException $e) {
                $this->assertStringContainsString('reserved', $e->getMessage());
            }
        } finally {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$allowId]);
        }

        // The shared demo account can never be admin, even with the flag set.
        $demoEmail = $_ENV['DEMO_EMAIL'] ?? 'demo@formlogic.local';
        $demoId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare('INSERT INTO users (id, email, password_hash, is_admin) VALUES (?, ?, ?, 1)')->execute([$demoId, 'tmp-' . $demoId, 'x']);
        self::$pdo->prepare('UPDATE users SET email = ? WHERE id = ?')->execute([$demoEmail . '.testcase', $demoId]);
        $demo = $this->userModel($demoId);
        $demo->email = $demoEmail; // simulate the shared demo account exactly
        try {
            $this->assertFalse(self::$auth->isPlatformAdmin($demo));
        } finally {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$demoId]);
        }
    }

    public function testLoginAndRegisterPayloadsCarryIsAdmin(): void
    {
        // The SPA stores the user object handed back at sign-in. It must carry the
        // same computed decorations /auth/me returns (isAdmin, isDemo) — without
        // them the Admin nav entry only appeared after a full page refresh.
        $email = 'signin-' . bin2hex(random_bytes(6)) . '@test.local';
        $reg = self::$auth->register($email, 'correct-horse-battery');
        try {
            $this->assertArrayHasKey('isAdmin', $reg['user']);
            $this->assertFalse($reg['user']['isAdmin']);
            $this->assertFalse($reg['user']['isDemo']);

            // Grant the flag → the next login payload reflects it immediately.
            self::$pdo->prepare('UPDATE users SET is_admin = 1 WHERE id = ?')->execute([$reg['user']['id']]);
            $login = self::$auth->login($email, 'correct-horse-battery');
            $this->assertTrue($login['user']['isAdmin']);
            $this->assertFalse($login['user']['isDemo']);
        } finally {
            self::$pdo->prepare('DELETE FROM users WHERE email = ?')->execute([$email]);
        }
    }

    public function testAdminGateBlocksNonAdmins(): void
    {
        $gate = new AdminGateMiddleware(self::$auth);

        $denied = $gate->process($this->request('GET', '/api/admin/overview', null, $this->userId), $this->passthroughHandler());
        $this->assertSame(403, $denied->getStatusCode());

        $allowed = $gate->process($this->request('GET', '/api/admin/overview', null, $this->adminId), $this->passthroughHandler());
        $this->assertSame(200, $allowed->getStatusCode());

        // No user attribute at all (auth failed upstream) → denied.
        $anon = $gate->process($this->request('GET', '/api/admin/overview'), $this->passthroughHandler());
        $this->assertSame(403, $anon->getStatusCode());
    }

    // ── global session boot ─────────────────────────────────────────────────

    public function testBootSessionsInvalidatesNonAdminTokensButSparesAdmins(): void
    {
        $oldUserToken = $this->tokenFor($this->userId, time() - 100);
        $oldAdminToken = $this->tokenFor($this->adminId, time() - 100);
        $this->assertNotNull(self::$auth->validateToken($oldUserToken), 'pre-boot token must validate');

        self::$auth->bootAllSessions();

        // Fresh AuthService (the epoch is memoized per instance/request).
        $auth2 = new AuthService(self::$mysql, [
            'secret' => self::JWT_SECRET, 'expiry' => 3600, 'algorithm' => 'HS256',
            'issuer' => 'formlogic', 'audience' => 'formlogic-api',
        ]);
        $this->assertNull($auth2->validateToken($oldUserToken), 'non-admin tokens issued before the boot must be rejected');
        $this->assertNotNull($auth2->validateToken($oldAdminToken), 'the admin who pressed the button keeps their session');

        sleep(1); // a token minted after the epoch is valid again
        $freshToken = $this->tokenFor($this->userId, time());
        $this->assertNotNull($auth2->validateToken($freshToken));
    }

    public function testBootRejectsTokensMintedInTheSameSecond(): void
    {
        // Audit FL-17: revocation authority is the MONOTONIC session generation ('sg'),
        // not the second-resolution timestamp — a token minted immediately before the
        // boot in the very same second used to satisfy iat == session_epoch and survive.
        $genBefore = self::$auth->getSessionGeneration();
        $preBoot = $this->tokenWithSg($this->userId, time(), $genBefore);
        $this->assertNotNull(self::$auth->validateToken($preBoot), 'pre-boot token must validate');

        self::$auth->bootAllSessions();

        $auth2 = new AuthService(self::$mysql, [
            'secret' => self::JWT_SECRET, 'expiry' => 3600, 'algorithm' => 'HS256',
            'issuer' => 'formlogic', 'audience' => 'formlogic-api',
        ]);
        $this->assertNull($auth2->validateToken($preBoot), 'a token minted in the boot second must be rejected');

        // A post-boot token is valid IMMEDIATELY (no sleep — the generation is exact).
        $postBoot = $this->tokenWithSg($this->userId, time(), $auth2->getSessionGeneration());
        $this->assertNotNull($auth2->validateToken($postBoot));

        // Legacy tokens without 'sg' fail closed at the boundary second (iat == epoch).
        $epoch = (int) self::$pdo->query("SELECT meta_value FROM system_meta WHERE meta_key = 'session_epoch'")->fetchColumn();
        $this->assertNull(
            $auth2->validateToken($this->tokenFor($this->userId, $epoch)),
            'a legacy token with iat == session_epoch must be rejected'
        );
    }

    // ── maintenance mode ────────────────────────────────────────────────────

    public function testMaintenanceMiddlewareBlocksAllowsAndBypasses(): void
    {
        $flag = self::$tmpRoot . '/maintenance-' . bin2hex(random_bytes(3)) . '.json';
        $maintenance = new MaintenanceService($flag);
        $mw = new MaintenanceMiddleware($maintenance, self::$auth);

        // Off → everything passes.
        $ok = $mw->process($this->request('GET', '/api/forms'), $this->passthroughHandler());
        $this->assertSame(200, $ok->getStatusCode());

        $maintenance->enable('Back at 9pm sharp.', $this->adminId);

        // Ordinary API traffic → 503 with the admin's message.
        $blocked = $mw->process($this->request('GET', '/api/forms'), $this->passthroughHandler());
        $this->assertSame(503, $blocked->getStatusCode());
        $body = $this->json($blocked);
        $this->assertTrue($body['maintenance']);
        $this->assertSame('Back at 9pm sharp.', $body['message']);

        // The allowlist stays reachable (health for embeds, login/me for admins, the panel itself).
        foreach (['/api/health', '/api/auth/login', '/api/auth/me', '/api/admin/maintenance'] as $path) {
            $r = $mw->process($this->request('GET', $path), $this->passthroughHandler());
            $this->assertSame(200, $r->getStatusCode(), "{$path} must stay reachable during maintenance");
        }

        // A platform admin's token bypasses maintenance everywhere.
        $adminReq = $this->request('GET', '/api/forms')
            ->withHeader('Authorization', 'Bearer ' . $this->tokenFor($this->adminId, time()));
        $this->assertSame(200, $mw->process($adminReq, $this->passthroughHandler())->getStatusCode());

        // A non-admin token does not.
        $userReq = $this->request('GET', '/api/forms')
            ->withHeader('Authorization', 'Bearer ' . $this->tokenFor($this->userId, time()));
        $this->assertSame(503, $mw->process($userReq, $this->passthroughHandler())->getStatusCode());

        $maintenance->disable($this->adminId);
        $this->assertSame(200, $mw->process($this->request('GET', '/api/forms'), $this->passthroughHandler())->getStatusCode());
    }

    // ── user directory + counts + no-data boundary ──────────────────────────

    public function testUserDirectoryCountsAndStructureWithoutData(): void
    {
        // The user owns a form with one submitted response, an app, and a flow.
        $form = self::$forms->createForm([
            'title' => 'Contact', 'userId' => $this->userId,
            'fields' => [['id' => 'name', 'type' => 'short_text', 'label' => 'Name', 'required' => false]],
        ]);
        self::$responses->createResponse((string) $form['id'], ['answers' => ['name' => 'TOP-SECRET-ANSWER']], null);
        $app = self::$apps->createApp(['name' => 'Helpdesk'], $this->userId);
        self::$flows->createWorkspaceFlow($this->userId, ['name' => 'Digest']);

        $ctrl = $this->controller();

        $list = $this->json($ctrl->listUsers($this->request('GET', '/api/admin/users?search=' . $this->userId, null, $this->adminId)->withQueryParams(['search' => $this->userId]), (new ResponseFactory())->createResponse()));
        $this->assertSame(1, $list['total']);
        $row = $list['users'][0];
        $this->assertSame(1, $row['formsCount']);
        $this->assertSame(1, $row['appsCount']);
        $this->assertSame(1, $row['flowsCount']);
        $this->assertSame(1, $row['responsesCount']);

        $detail = $this->json($ctrl->getUser($this->request('GET', '/x', null, $this->adminId), (new ResponseFactory())->createResponse(), ['id' => $this->userId]));
        $this->assertSame('Contact', $detail['user']['forms'][0]['title']);
        $this->assertSame(1, $detail['user']['forms'][0]['responseCount']);
        $this->assertSame('Helpdesk', $detail['user']['apps'][0]['name']);

        // Structure endpoint: field definitions + a COUNT — never the answers.
        $structure = $this->json($ctrl->getFormStructure($this->request('GET', '/x', null, $this->adminId), (new ResponseFactory())->createResponse(), ['id' => (string) $form['id']]));
        $this->assertSame(1, $structure['form']['responseCount']);
        $this->assertSame('name', $structure['form']['fields'][0]['id'] ?? null);
        $this->assertArrayNotHasKey('responses', $structure['form']);
        $this->assertStringNotContainsString('TOP-SECRET-ANSWER', json_encode($structure));

        // Admin structural edit acts on the owner's form through the same service path.
        $upd = $this->json($ctrl->updateForm(
            $this->request('PUT', '/x', ['title' => 'Contact v2'], $this->adminId),
            (new ResponseFactory())->createResponse(),
            ['id' => (string) $form['id']]
        ));
        $this->assertSame('Contact v2', $upd['form']['title'] ?? null);
    }

    public function testBackupManifestReturnsPathsAndSchemaNeverData(): void
    {
        $form = self::$forms->createForm([
            'title' => 'Contact', 'userId' => $this->userId,
            'fields' => [['id' => 'name', 'type' => 'short_text', 'label' => 'Name', 'required' => false]],
        ]);
        self::$responses->createResponse((string) $form['id'], ['answers' => ['name' => 'TOP-SECRET-ANSWER']], null);

        $ctrl = $this->controller();
        $res = $ctrl->backupManifest($this->request('GET', '/x', null, $this->adminId), (new ResponseFactory())->createResponse(), ['id' => $this->userId]);
        $this->assertSame(200, $res->getStatusCode());
        $body = $this->json($res);
        $m = $body['manifest'];

        // Paths + schema + counts are all there...
        $this->assertSame('formlogic.adminBackupManifest', $m['kind']);
        $entry = $m['forms'][0];
        $this->assertSame('Contact', $entry['title']);
        $this->assertSame(1, $entry['responseCount']);
        $this->assertSame('name', $entry['fields'][0]['id'] ?? null);
        $this->assertStringContainsString('storage/forms/', $entry['sqlite']['relativePath']);
        $this->assertTrue($entry['sqlite']['exists']);
        $this->assertGreaterThan(0, $entry['sqlite']['sizeBytes']);
        $this->assertStringContainsString('storage/uploads/', $entry['uploads']['relativePath']);

        // ...but never the record data. THE boundary assertion.
        $this->assertStringNotContainsString('TOP-SECRET-ANSWER', json_encode($body));

        // Unknown user → 404.
        $nf = $ctrl->backupManifest($this->request('GET', '/x', null, $this->adminId), (new ResponseFactory())->createResponse(), ['id' => 'no-such-user']);
        $this->assertSame(404, $nf->getStatusCode());
    }

    public function testSetAdminGuards(): void
    {
        $ctrl = $this->controller();

        // Grant + revoke round trip.
        $grant = $this->json($ctrl->setAdmin($this->request('POST', '/x', ['isAdmin' => true], $this->adminId), (new ResponseFactory())->createResponse(), ['id' => $this->userId]));
        $this->assertTrue($grant['success']);
        $this->assertTrue(self::$auth->isPlatformAdmin($this->userModel($this->userId)));

        // Self-demotion is refused (an instance must keep at least this admin).
        $self = $ctrl->setAdmin($this->request('POST', '/x', ['isAdmin' => false], $this->adminId), (new ResponseFactory())->createResponse(), ['id' => $this->adminId]);
        $this->assertSame(400, $self->getStatusCode());
    }

    // ── notices ─────────────────────────────────────────────────────────────

    public function testNoticeLifecycle(): void
    {
        $notice = self::$admin->createNotice('Upgrading at 10pm tonight', 'warning', 'online', $this->adminId);
        $this->assertTrue($notice['active']);

        $active = self::$admin->activeNotices();
        $this->assertContains($notice['id'], array_column($active, 'id'));

        self::$admin->revokeNotice($notice['id']);
        $this->assertNotContains($notice['id'], array_column(self::$admin->activeNotices(), 'id'));

        $this->expectException(\InvalidArgumentException::class);
        self::$admin->createNotice('x', 'catastrophic', 'online', $this->adminId);
    }

    // ── upgrade machinery ───────────────────────────────────────────────────

    /** Build a minimal valid single-domain release zip (with a correct manifest). */
    private function buildFakePackage(string $version, bool $tamper = false): string
    {
        $files = [
            'index.html' => "<html>NEW-UI-{$version}</html>",
            '.htaccess' => "# routing\n",
            'VERSION' => "{$version}\n",
            'api/public/index.php' => "<?php // new backend {$version}\n",
            'api/vendor/autoload.php' => "<?php // autoload\n",
            'api/database/schema.sql' => "-- schema\n",
            'api/src/NewFeature.php' => "<?php // shipped in {$version}\n",
            'api/VERSION' => "{$version}\n",
            'api/storage/forms/.gitkeep' => '',
        ];
        $manifest = ['name' => 'formlogic', 'version' => $version, 'files' => []];
        foreach ($files as $path => $content) {
            $manifest['files'][$path] = hash('sha256', $content);
        }
        if ($tamper) {
            $manifest['files']['index.html'] = str_repeat('0', 64);
        }
        $zipPath = self::$tmpRoot . '/pkg-' . bin2hex(random_bytes(3)) . '.zip';
        $zip = new \ZipArchive();
        $zip->open($zipPath, \ZipArchive::CREATE);
        foreach ($files as $path => $content) {
            $zip->addFromString($path, $content);
        }
        $zip->addFromString('manifest.json', (string) json_encode($manifest));
        $zip->close();
        return $zipPath;
    }

    /** A fake DEPLOYED layout: <webroot>/index.html + <webroot>/api/{...}. */
    private function buildFakeInstall(): array
    {
        $webRoot = self::$tmpRoot . '/site-' . bin2hex(random_bytes(3));
        $apiRoot = $webRoot . '/api';
        mkdir($apiRoot . '/storage/forms', 0777, true);
        mkdir($apiRoot . '/src', 0777, true);
        file_put_contents($webRoot . '/index.html', '<html>OLD-UI</html>');
        file_put_contents($apiRoot . '/.env', 'JWT_SECRET=super-secret-must-survive');
        file_put_contents($apiRoot . '/storage/forms/user-data.sqlite', 'PRECIOUS-USER-RECORDS');
        file_put_contents($apiRoot . '/src/OldFeature.php', '<?php // old');
        file_put_contents($apiRoot . '/VERSION', "1.0.0\n");
        return [$webRoot, $apiRoot];
    }

    public function testUpgradePackageValidation(): void
    {
        [, $apiRoot] = $this->buildFakeInstall();
        $maintenance = new MaintenanceService($apiRoot . '/storage/maintenance.json');
        $svc = new UpgradeService($apiRoot, self::$mysql, $maintenance);

        // A zip that isn't a FormLogic package is refused.
        $bad = self::$tmpRoot . '/bad-' . bin2hex(random_bytes(3)) . '.zip';
        $zip = new \ZipArchive();
        $zip->open($bad, \ZipArchive::CREATE);
        $zip->addFromString('readme.txt', 'nope');
        $zip->close();
        try {
            $svc->stageUploadedPackage($bad);
            $this->fail('expected rejection');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('Not a FormLogic release package', $e->getMessage());
        }

        // A tampered file fails the manifest checksum verification.
        try {
            $svc->stageUploadedPackage($this->buildFakePackage('2.0.0', tamper: true));
            $this->fail('expected integrity rejection');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('integrity failure', $e->getMessage());
        }
        $this->assertNull($svc->stagedInfo(), 'a failed validation must clear the staging area');

        // A good package stages with verified integrity.
        $info = $svc->stageUploadedPackage($this->buildFakePackage('2.0.0'));
        $this->assertSame('2.0.0', $info['version']);
        $this->assertSame('verified', $info['integrity']);
        $this->assertFalse($info['isDowngrade']);
    }

    public function testUpgradeApplyProtectsUserDataAndBacksUpFirst(): void
    {
        [$webRoot, $apiRoot] = $this->buildFakeInstall();
        $maintenance = new MaintenanceService($apiRoot . '/storage/maintenance.json');
        $svc = new UpgradeService($apiRoot, self::$mysql, $maintenance);

        $this->assertSame('deployed', $svc->layout()['mode']);
        $this->assertSame('1.0.0', $svc->currentVersion());

        $svc->stageUploadedPackage($this->buildFakePackage('2.0.0'));
        $result = $svc->apply($this->adminId);

        $this->assertTrue($result['ok']);
        $this->assertSame('1.0.0', $result['fromVersion']);
        $this->assertSame('2.0.0', $result['toVersion']);

        // New code + UI applied.
        $this->assertFileExists($apiRoot . '/src/NewFeature.php');
        $this->assertStringContainsString('NEW-UI-2.0.0', (string) file_get_contents($webRoot . '/index.html'));
        $this->assertSame("2.0.0\n", (string) file_get_contents($apiRoot . '/VERSION'));

        // THE data-safety invariants: secrets + per-form SQLite are untouched.
        $this->assertSame('JWT_SECRET=super-secret-must-survive', (string) file_get_contents($apiRoot . '/.env'));
        $this->assertSame('PRECIOUS-USER-RECORDS', (string) file_get_contents($apiRoot . '/storage/forms/user-data.sqlite'));

        // An automatic backup exists: database export + code snapshot of the OLD version.
        $backupDir = $apiRoot . '/storage/backups/' . $result['backupId'];
        $this->assertFileExists($backupDir . '/database.sql.gz');
        $dump = (string) gzdecode((string) file_get_contents($backupDir . '/database.sql.gz'));
        $this->assertStringContainsString('CREATE TABLE', $dump);
        $this->assertStringContainsString('users', $dump);
        $this->assertFileExists($backupDir . '/api/src/OldFeature.php');
        $this->assertStringContainsString('OLD-UI', (string) file_get_contents($backupDir . '/web/index.html'));
        // The snapshot must NOT contain user data or secrets (it ships in support bundles).
        $this->assertFileDoesNotExist($backupDir . '/api/.env');
        $this->assertFileDoesNotExist($backupDir . '/api/storage/forms/user-data.sqlite');

        // Maintenance reopened after a clean apply.
        $this->assertFalse($maintenance->enabled());

        // Rollback restores the old code — and still never touches protected paths.
        file_put_contents($apiRoot . '/.env', 'JWT_SECRET=rotated-after-upgrade');
        $rb = $svc->rollback($result['backupId'], $this->adminId);
        $this->assertTrue($rb['ok']);
        $this->assertFileExists($apiRoot . '/src/OldFeature.php');
        $this->assertStringContainsString('OLD-UI', (string) file_get_contents($webRoot . '/index.html'));
        $this->assertSame('JWT_SECRET=rotated-after-upgrade', (string) file_get_contents($apiRoot . '/.env'), 'rollback must not clobber .env');
        $this->assertSame('PRECIOUS-USER-RECORDS', (string) file_get_contents($apiRoot . '/storage/forms/user-data.sqlite'));
    }
}

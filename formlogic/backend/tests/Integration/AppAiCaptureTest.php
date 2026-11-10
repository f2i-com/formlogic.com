<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\NativeAppController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Middleware\AuthMiddleware;
use FormLogic\Middleware\CsrfMiddleware;
use FormLogic\Models\User;
use FormLogic\Services\AIService;
use FormLogic\Services\AppAiService;
use FormLogic\Services\AuthService;
use FormLogic\Services\AppAiSiteSettings;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\AppVisitors;
use FormLogic\Services\FlowService;
use FormLogic\Services\FormService;
use FormLogic\Services\NativeAppService;
use FormLogic\Services\NativeRecordEventRouter;
use FormLogic\Services\PlanService;
use FormLogic\Services\RuntimeEngineService;
use FormLogic\Support\SessionOriginPolicy;
use PDO;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * App AI's capture, through the real controller, the real runner (softn-runner and Node) and MySQL:
 * a visitor's or member's job is taken from the app's own write, whole, once, counted against the
 * limits; a write that rolls back asks for nothing; and an app that declares nothing of FormLogic's
 * is exactly as it was. The stage-1 probe's checks (scratchpad agents/app-ai/probe), kept.
 */
final class AppAiCaptureTest extends TestCase
{
    private const ORIGIN = 'http://127.0.0.1:8300';
    private const IP = '203.0.113.9';

    private static ?PDO $pdo = null;
    private static ?MySQLConnection $mysql = null;
    private static AppService $apps;
    private static string $tmpRoot = '';

    private string $ownerId = '';
    private string $storage = '';
    private NativeAppService $native;
    private AppAiSiteSettings $site;
    private AppVisitors $visitors;
    private AppAiService $ai;
    private NativeRecordEventRouter $router;
    private NativeAppController $controller;
    /** The apps' members, as the controller asks for them: nobody is one, until a test says who. */
    private AppUserService&\PHPUnit\Framework\MockObject\MockObject $members;
    /** @var string[] */
    private array $appIds = [];

    public static function setUpBeforeClass(): void
    {
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) \Dotenv\Dotenv::createImmutable($root)->safeLoad();
        try {
            $conn = new MySQLConnection([
                'host' => $_ENV['DB_HOST'] ?? '127.0.0.1', 'port' => $_ENV['DB_PORT'] ?? '3306', 'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
                'username' => $_ENV['DB_USERNAME'] ?? 'root', 'password' => $_ENV['DB_PASSWORD'] ?? '', 'charset' => 'utf8mb4', 'collation' => 'utf8mb4_unicode_ci',
            ]);
            $conn->getConnection()->query('SELECT 1');
            $conn->initializeSchema();
            $conn->runMigrations();
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
        self::$mysql = $conn;
        self::$pdo = $conn->getConnection();
        self::$tmpRoot = sys_get_temp_dir() . '/formlogic-app-ai-' . bin2hex(random_bytes(4));
        mkdir(self::$tmpRoot . '/sqlite', 0777, true);
        self::$apps = new AppService($conn, new FormService($conn, new SQLiteConnection(self::$tmpRoot . '/sqlite')));
    }

    public static function tearDownAfterClass(): void
    {
        if (self::$tmpRoot !== '' && is_dir(self::$tmpRoot)) self::removeTree(self::$tmpRoot);
    }

    public static function runners(): array
    {
        return ['softn-runner (or Node where none ships)' => ['auto'], 'Node runner.mjs' => ['node']];
    }

    private function boot(string $runner = 'auto'): void
    {
        if (self::$pdo === null) $this->markTestSkipped('No test database');
        $this->storage = self::$tmpRoot . '/native-' . bin2hex(random_bytes(3));
        $node = getenv('FORMLOGIC_NODE_BIN') ?: null;
        if ($runner === 'node' && $node === null) $this->markTestSkipped('Set FORMLOGIC_NODE_BIN to run the Node runner');
        $this->native = new NativeAppService($this->storage, null, $node, $runner);
        if (!$this->native->available()) $this->markTestSkipped('No SoftN runtime here');
        $this->ownerId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'Owner')")->execute([$this->ownerId, $this->ownerId . '@test.local']);
        $this->site = new AppAiSiteSettings(self::$tmpRoot . '/app-ai-' . bin2hex(random_bytes(3)) . '.json');
        $this->site->save(['allowApps' => true, 'pictureModel' => 'flux-test']);
        $this->visitors = new AppVisitors(self::$mysql, ['secure' => false], new SessionOriginPolicy([self::ORIGIN]));
        $configured = $this->createMock(AIService::class);
        $configured->method('isConfigured')->willReturn(true);
        $this->ai = new AppAiService(self::$mysql, $this->site, $this->visitors, $this->native, null, $configured);
        $flows = new FlowService(self::$mysql);
        $this->router = new NativeRecordEventRouter($flows, $this->ai);
        $engines = $this->createMock(RuntimeEngineService::class);
        $engines->method('effective')->willReturn(['id' => 'zipp-web-python', 'requested' => 'zipp-web-python', 'stored' => null, 'revision' => '0123456789abcdef']);
        $plans = $this->createMock(PlanService::class);
        $this->members = $this->createMock(AppUserService::class);
        $this->controller = new NativeAppController(self::$apps, $this->members, $this->native, $plans, $flows, $engines, null, null, null, null, $this->router, $this->visitors, $this->ai);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) return;
        foreach ($this->appIds as $appId) {
            self::$pdo->prepare('DELETE FROM app_ai_counters WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?)')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_versions WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$appId]);
        }
        self::$pdo->exec("DELETE FROM app_ai_counters WHERE app_id = ''");
        if ($this->ownerId !== '') {
            self::$pdo->prepare('DELETE FROM desktop_connections WHERE owner_user_id = ?')->execute([$this->ownerId]);
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->ownerId]);
        }
        $this->appIds = [];
    }

    // ------------------------------------------------------------------ the app

    private const SERVER = <<<'JS'
function insertJob(req, kind, note) {
  var body = req.body || {};
  var id = softn.crypto.randomHex(16);
  var prompt = typeof body.prompt === "string" ? body.prompt : "";
  while (prompt.length < 1500) prompt += "A friendly logo for a coffee cart called Five Cents, warm colours. ";
  prompt = prompt.slice(0, 1500);
  var messages = kind === "chat" ? JSON.stringify([{role: "system", content: "You edit logos."}, {role: "user", content: "Make the cup bigger."}]) : null;
  softn.sql.execute("INSERT INTO ai_jobs(id, kind, prompt, size, seed, messages, note) VALUES(?,?,?,?,?,?,?)", [id, kind, kind === "chat" ? null : prompt, "1024x1024", 7, messages, note]);
  return id;
}
function echo(req, extra) {
  var out = { context: req.context === undefined ? "(undefined)" : req.context };
  for (var k in extra) out[k] = extra[k];
  return out;
}
function createJob(req) { var id = insertJob(req, "picture", "ok"); return { status: 201, body: echo(req, { id: id }) }; }
function createChat(req) { var id = insertJob(req, "chat", "chat"); return { status: 201, body: echo(req, { id: id }) }; }
function createBad(req) { var id = insertJob(req, "video", "bad"); return { status: 201, body: echo(req, { id: id }) }; }
function createJobThrow(req) { insertJob(req, "picture", "throw"); throw new Error("failing after the insert"); }
function createJobRollback(req) { insertJob(req, "picture", "rollback"); return { status: 400, body: { error: "rolled back" }, rollback: true }; }
function showContext(req) { return { status: 200, body: echo(req, {}) }; }
function cancelJob(req) { softn.sql.execute("UPDATE ai_jobs SET status = 'cancelled' WHERE id = ?", [String((req.body || {}).id)]); return { status: 200, body: {} }; }
function touchJob(req) { softn.sql.execute("UPDATE ai_jobs SET note = 'seen' WHERE id = ?", [String((req.body || {}).id)]); return { status: 200, body: {} }; }
function forgetJob(req) { softn.sql.execute("DELETE FROM ai_jobs WHERE id = ?", [String((req.body || {}).id)]); return { status: 200, body: {} }; }
function deliver(req) { return { status: 200, body: { delivered: true } }; }
JS;

    private function project(string $access, bool $asks, bool $sells = false): array
    {
        $manifest = [
            'name' => 'Logo maker', 'version' => '0.0.1', 'main' => 'ui/main.ui',
            'server' => [
                'entry' => 'server/main.logic',
                'requires' => ['apiVersion' => 1, 'capabilities' => ['sql', 'crypto', 'trusted-client-ip']],
                'database' => ['kind' => 'private-sqlite', 'migrations' => ['server/migrations/001.sql']],
                'routes' => [
                    ['path' => '/api/jobs', 'method' => 'POST', 'handler' => 'createJob', 'transaction' => 'write', 'authorization' => 'anonymous'],
                    ['path' => '/api/chat', 'method' => 'POST', 'handler' => 'createChat', 'transaction' => 'write', 'authorization' => 'anonymous'],
                    ['path' => '/api/bad', 'method' => 'POST', 'handler' => 'createBad', 'transaction' => 'write', 'authorization' => 'anonymous'],
                    ['path' => '/api/jobs-throw', 'method' => 'POST', 'handler' => 'createJobThrow', 'transaction' => 'write', 'authorization' => 'anonymous'],
                    ['path' => '/api/jobs-rollback', 'method' => 'POST', 'handler' => 'createJobRollback', 'transaction' => 'write', 'authorization' => 'anonymous'],
                    ['path' => '/api/context', 'method' => 'GET', 'handler' => 'showContext', 'transaction' => 'read', 'authorization' => 'anonymous'],
                    ['path' => '/api/cancel', 'method' => 'POST', 'handler' => 'cancelJob', 'transaction' => 'write', 'authorization' => 'anonymous'],
                    ['path' => '/api/touch', 'method' => 'POST', 'handler' => 'touchJob', 'transaction' => 'write', 'authorization' => 'anonymous'],
                    ['path' => '/api/forget', 'method' => 'POST', 'handler' => 'forgetJob', 'transaction' => 'write', 'authorization' => 'anonymous'],
                    ['path' => '/api/site/ai/deliver', 'method' => 'POST', 'handler' => 'deliver', 'transaction' => 'write', 'authorization' => 'anonymous'],
                ],
            ],
        ];
        if ($asks) $manifest['formlogicAi'] = ['uses' => ['pictures', 'picture-edits', 'chat'], 'purpose' => 'Draws logos.', 'jobs' => ['table' => 'ai_jobs', 'deliver' => '/api/site/ai/deliver']];
        if ($sells) $manifest['formlogicPayments'] = ['purpose' => 'Pay 5 cents to download a logo.', 'items' => [['id' => 'download', 'label' => 'Download a logo', 'priceCents' => 5]], 'routes' => ['/api/touch']];
        return ['version' => 0, 'home' => true, 'access' => $access, 'assets' => [], 'files' => [
            'manifest.json' => json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES),
            'ui/main.ui' => '<Stack><Text>Logos</Text></Stack>',
            'server/main.logic' => self::SERVER,
            'server/migrations/001.sql' => 'CREATE TABLE ai_jobs(id TEXT PRIMARY KEY, kind TEXT NOT NULL, prompt TEXT, size TEXT, seed INTEGER, reference TEXT, messages TEXT, note TEXT, status TEXT);',
        ]];
    }

    /** A published app with this project, and AI set to $mode for it. $sells: it declares payments too. */
    private function app(string $access = 'application', bool $asks = true, string $mode = 'site', bool $sells = false): array
    {
        $app = self::$apps->createApp(['name' => 'Logos ' . bin2hex(random_bytes(3)), 'settings' => ['softnApp' => true]], $this->ownerId);
        $this->appIds[] = $app['id'];
        $this->native->install($app['id'], $this->project($access, $asks, $sells), 0);
        self::$pdo->prepare("UPDATE apps SET status = 'published' WHERE id = ?")->execute([$app['id']]);
        if ($mode !== 'off') self::$pdo->prepare('INSERT INTO app_ai_settings (app_id, mode) VALUES (?, ?)')->execute([$app['id'], $mode]);
        return self::$apps->getApp($app['id']);
    }

    /**
     * The request FormLogic's page posts for one call of the app's backend; $extra: more (or other) fields of what it posts.
     * $server: what the web server says of the connection (its peer's address, a proxy's headers); the test's own address when null.
     */
    private function posted(array $app, string $path, array $headers = [], array $cookies = [], string $method = 'POST', array $body = [], array $extra = [], ?array $server = null): \Psr\Http\Message\ServerRequestInterface
    {
        $payload = array_replace(['method' => $method, 'path' => $path, 'query' => [], 'headers' => [], 'body' => $body === [] ? new \stdClass() : $body], $extra);
        $request = (new ServerRequestFactory())->createServerRequest('POST', self::ORIGIN . '/api/app/' . $app['slug'] . '/native/request', $server ?? ['REMOTE_ADDR' => self::IP])
            ->withHeader('Host', '127.0.0.1:8300')->withHeader('Content-Type', 'application/json')->withCookieParams($cookies)->withParsedBody(json_decode(json_encode($payload), true));
        $request->getBody()->write(json_encode($payload));
        foreach ($headers as $name => $value) $request = $request->withHeader($name, $value);
        return $request;
    }

    /** What the page is answered, read. */
    private static function answered(\Psr\Http\Message\ResponseInterface $response): array
    {
        $data = json_decode((string) $response->getBody(), true);
        return ['http' => $response->getStatusCode(), 'status' => $data['result']['status'] ?? null, 'body' => $data['result']['body'] ?? $data, 'cookie' => $response->getHeaderLine('Set-Cookie')];
    }

    /** One request from the app's page, as the parent sends it, signed in as $user (as the sign-in middleware leaves it) or nobody. */
    private function call(array $app, string $path, array $headers = [], array $cookies = [], ?string $user = null, string $method = 'POST', array $body = [], array $extra = [], ?array $server = null): array
    {
        $request = $this->posted($app, $path, $headers, $cookies, $method, $body, $extra, $server);
        if ($user !== null) $request = $request->withAttribute('userId', $user)->withAttribute('user', new User(id: $user, email: $user . '@test.local'));
        return self::answered($this->controller->runtime($request, new Response(), ['slug' => $app['slug']]));
    }

    private const MARKED = [AppVisitors::HEADER => '1', 'Origin' => self::ORIGIN];

    private static function cookieValue(string $setCookie): array
    {
        return preg_match('/^formlogic_visitor=([^;]+)/', $setCookie, $m) ? [AppVisitors::COOKIE => $m[1]] : [];
    }

    private function jobs(string $appId): array
    {
        $statement = self::$pdo->prepare('SELECT * FROM app_ai_jobs WHERE app_id = ? ORDER BY created_at');
        $statement->execute([$appId]);
        return $statement->fetchAll(PDO::FETCH_ASSOC);
    }

    private function counter(string $appId, string $scope, string $subject): int
    {
        $statement = self::$pdo->prepare('SELECT used FROM app_ai_counters WHERE app_id = ? AND scope = ? AND subject = ? AND period = ?');
        $statement->execute([$appId, $scope, $subject, $scope === 'ip-hour' ? gmdate('Y-m-d\TH') : gmdate('Y-m-d')]);
        return (int) $statement->fetchColumn();
    }

    // ------------------------------------------------------------------ the tests

    #[DataProvider('runners')]
    public function testAVisitorsJobIsTakenWholeOnceAndCounted(string $runner): void
    {
        $this->boot($runner);
        $app = $this->app();
        $first = $this->call($app, '/api/jobs', self::MARKED);
        $this->assertSame(201, $first['status'], json_encode($first['body']));
        $this->assertStringContainsString('formlogic_visitor=', $first['cookie'], 'a new browser is given its cookie');
        $visitor = $first['body']['context']['formlogic']['visitor']['id'] ?? null;
        $this->assertMatchesRegularExpression('/^[0-9a-f]{32}$/D', (string) $visitor);
        $ai = $first['body']['context']['formlogic']['ai'];
        $this->assertTrue($ai['enabled']);
        $this->assertSame(['site', 'This site\'s AI', ['pictures', 'picture-edits', 'chat'], 10, 0, 20, 0], [$ai['source'], $ai['label'], $ai['uses'], $ai['perDay'], $ai['usedToday'], $ai['ipPerDay'], $ai['ipUsedToday']]);
        $this->assertSame($app['id'], $first['body']['context']['formlogic']['appId']);
        $this->assertArrayNotHasKey('userId', $first['body']['context']['formlogic'], 'application access names no member');
        $this->assertSame('v-' . $visitor, $ai['requester'], 'who is asking, as the delivery of their jobs will name them (contract §0.13)');

        $jobs = $this->jobs($app['id']);
        $this->assertCount(1, $jobs);
        $job = $jobs[0];
        $this->assertSame([$first['body']['id'], 'picture', 'queued', 'visitor', $visitor, 'env', 'site-env', '1024x1024', 7],
            [$job['app_job_id'], $job['kind'], $job['status'], $job['requester_kind'], $job['requester_id'], $job['target'], $job['source'], $job['size'], (int) $job['seed']]);
        $this->assertSame(1500, mb_strlen((string) $job['prompt']), 'the whole prompt, not the event\'s 400-character preview');
        $this->assertSame($this->visitors->ipKey(self::IP), $job['ip_key']);
        foreach ([['requester', 'v:' . $visitor], ['ip', $job['ip_key']], ['ip-hour', $job['ip_key']], ['app', '']] as [$scope, $subject]) {
            $this->assertSame(1, $this->counter($app['id'], $scope, $subject), "{$scope} counted once");
        }

        // The same browser again: the same visitor, told of its first job and the day's use.
        $second = $this->call($app, '/api/jobs', self::MARKED, self::cookieValue($first['cookie']));
        $this->assertSame($visitor, $second['body']['context']['formlogic']['visitor']['id']);
        $this->assertSame('', $second['cookie'], 'a known browser keeps its cookie');
        $this->assertSame(1, $second['body']['context']['formlogic']['ai']['usedToday']);
        $this->assertSame(['status' => 'queued', 'lane' => 'picture', 'position' => 1, 'waiting' => 'queue'], $second['body']['context']['formlogic']['ai']['jobs'][$first['body']['id']]);
        // A third while two wait: refused, told why, and not counted.
        $third = $this->call($app, '/api/jobs', self::MARKED, self::cookieValue($first['cookie']));
        $this->assertSame(201, $third['status']);
        $jobs = $this->jobs($app['id']);
        $this->assertSame(['queued', 'queued', 'refused'], array_column($jobs, 'status'));
        $this->assertSame('busy', $jobs[2]['code']);
        $this->assertSame(2, $this->counter($app['id'], 'requester', 'v:' . $visitor));
    }

    #[DataProvider('runners')]
    public function testAWriteThatRollsBackAsksForNothing(string $runner): void
    {
        $this->boot($runner);
        $app = $this->app();
        $this->assertSame(500, $this->call($app, '/api/jobs-throw', self::MARKED)['status']);
        $this->assertSame(400, $this->call($app, '/api/jobs-rollback', self::MARKED)['status']);
        $this->assertSame([], $this->jobs($app['id']));
        $this->assertSame(0, $this->counter($app['id'], 'app', ''));
    }

    public function testAnAppThatAsksForNothingIsExactlyAsItWas(): void
    {
        $this->boot();
        $app = $this->app('application', false, 'site');
        $answer = $this->call($app, '/api/context', self::MARKED, [], null, 'GET');
        $this->assertSame([], $answer['body']['context'], 'Coffee.Dating\'s shape: no formlogic at all');
        $this->assertSame('', $answer['cookie'], 'no visitor cookie');
        $this->call($app, '/api/jobs', self::MARKED);
        $this->assertSame([], $this->jobs($app['id']), 'its own table is its own');
        $get = $this->controller->runtime((new ServerRequestFactory())->createServerRequest('GET', self::ORIGIN . '/api/app/' . $app['slug'] . '/native'), new Response(), ['slug' => $app['slug']]);
        $this->assertSame('', $get->getHeaderLine('Set-Cookie'));
        $this->assertArrayNotHasKey('formlogic', json_decode((string) $get->getBody(), true)['project']);
    }

    public function testTheRuntimeGetGivesAnAppThatAsksItsVisitorsCookieAndStripsTheSections(): void
    {
        $this->boot();
        $app = $this->app();
        $get = $this->controller->runtime((new ServerRequestFactory())->createServerRequest('GET', self::ORIGIN . '/api/app/' . $app['slug'] . '/native'), new Response(), ['slug' => $app['slug']]);
        $this->assertStringContainsString('formlogic_visitor=', $get->getHeaderLine('Set-Cookie'));
        $this->assertStringContainsString('HttpOnly', $get->getHeaderLine('Set-Cookie'));
        $project = json_decode((string) $get->getBody(), true)['project'];
        $this->assertSame(['visitors' => true, 'ai' => true, 'payments' => false], $project['formlogic']);
        $this->assertArrayNotHasKey('formlogicAi', json_decode($project['client']['manifest.json'], true), 'FormLogic\'s sections are not the page\'s');
    }

    public function testWithoutFormLogicsMarkerOrFromElsewhereThereIsNoVisitor(): void
    {
        $this->boot();
        $app = $this->app();
        foreach ([[], [AppVisitors::HEADER => '1', 'Origin' => 'https://evil.example']] as $headers) {
            $answer = $this->call($app, '/api/jobs', $headers);
            $this->assertSame(201, $answer['status']);
            $formlogic = $answer['body']['context']['formlogic'];
            $this->assertArrayNotHasKey('visitor', $formlogic);
            $this->assertFalse($formlogic['ai']['enabled']);
            $this->assertSame('visitor_required', $formlogic['ai']['reason']);
            $this->assertArrayNotHasKey('requester', $formlogic['ai'], 'nobody known is asking');
            $this->assertSame('', $answer['cookie']);
        }
        // Their writes are still taken, so the app is answered: refused, as nobody known asked.
        $this->assertSame([['refused', AppAiService::NOBODY, 'ai_unavailable'], ['refused', AppAiService::NOBODY, 'ai_unavailable']],
            array_map(static fn(array $job) => [$job['status'], $job['requester_kind'], $job['code']], $this->jobs($app['id'])));
        $this->assertSame(0, $this->counter($app['id'], 'app', ''));
    }

    public function testTheLimitsRefuseAndSayWhy(): void
    {
        $this->boot();
        $app = $this->app();
        self::$pdo->prepare('UPDATE app_ai_settings SET per_requester_day = 1 WHERE app_id = ?')->execute([$app['id']]);
        $first = $this->call($app, '/api/jobs', self::MARKED);
        $this->call($app, '/api/jobs', self::MARKED, self::cookieValue($first['cookie']));
        $jobs = $this->jobs($app['id']);
        $this->assertSame(['queued', 'refused'], array_column($jobs, 'status'));
        $this->assertSame('limit_reached', $jobs[1]['code']);
        $this->assertStringContainsString('today', (string) $jobs[1]['message']);
        $this->assertSame(1, $this->counter($app['id'], 'app', ''), 'a refused job is not counted');
        // Another visitor on the same network still has their own allowance.
        $other = $this->call($app, '/api/jobs', self::MARKED);
        $this->assertSame('queued', $this->jobs($app['id'])[2]['status']);
        $this->assertSame(2, $this->counter($app['id'], 'ip', $this->visitors->ipKey(self::IP)));
        $this->assertNotSame($first['body']['context']['formlogic']['visitor']['id'], $other['body']['context']['formlogic']['visitor']['id']);
    }

    /** No row waits forever (contract §0.11): a job the AI cannot take is still taken, and answered at once with its code. */
    public function testAJobAskedForWhileItsAiCannotTakeItIsAnsweredWithItsCode(): void
    {
        $this->boot();
        $off = $this->app('application', true, 'off');
        $answer = $this->call($off, '/api/jobs', self::MARKED);
        $this->assertFalse($answer['body']['context']['formlogic']['ai']['enabled']);
        $this->assertSame('ai_off', $answer['body']['context']['formlogic']['ai']['reason']);
        $job = $this->jobs($off['id'])[0] ?? [];
        $this->assertSame(['refused', 'ai_off'], [$job['status'] ?? null, $job['code'] ?? null], 'taken all the same');
        $this->assertNotNull($job['next_attempt_at'], 'and told at once');
        $this->assertSame(0, $this->counter($off['id'], 'app', ''), 'and not counted');

        $unset = $this->app('application', true, 'own');
        $this->call($unset, '/api/jobs', self::MARKED);
        $this->assertSame(['refused', 'ai_unavailable'], [$this->jobs($unset['id'])[0]['status'], $this->jobs($unset['id'])[0]['code']], 'its owner has chosen no computer');

        $this->site->save(['allowApps' => true, 'pictureModel' => 'flux-test', 'paused' => true]);
        $paused = $this->app();
        $this->call($paused, '/api/jobs', self::MARKED);
        $this->assertSame(['refused', 'ai_paused'], [$this->jobs($paused['id'])[0]['status'], $this->jobs($paused['id'])[0]['code']]);
    }

    /** Cancel (contract §0.11): the row's status set to cancelled, or the row deleted. */
    #[DataProvider('runners')]
    public function testAnAppCancelsAJobByItsStatusOrByDeletingItsRow(string $runner): void
    {
        $this->boot($runner);
        $app = $this->app();
        $first = $this->call($app, '/api/jobs', self::MARKED);
        $cookie = self::cookieValue($first['cookie']);
        $visitor = 'v:' . $first['body']['context']['formlogic']['visitor']['id'];
        $second = $this->call($app, '/api/jobs', self::MARKED, $cookie);
        $this->assertSame(2, $this->counter($app['id'], 'requester', $visitor));

        // Another write to the row is no cancel.
        $this->call($app, '/api/touch', self::MARKED, $cookie, null, 'POST', ['id' => $first['body']['id']]);
        $this->assertSame(['queued', 'queued'], array_column($this->jobs($app['id']), 'status'));

        $this->assertSame(200, $this->call($app, '/api/cancel', self::MARKED, $cookie, null, 'POST', ['id' => $first['body']['id']])['status']);
        $this->assertSame(200, $this->call($app, '/api/forget', self::MARKED, $cookie, null, 'POST', ['id' => $second['body']['id']])['status']);
        [$cancelled, $deleted] = $this->jobs($app['id']);
        $this->assertSame(['cancelled', 'cancelled', 1, 1], [$cancelled['status'], $deleted['status'], (int) $cancelled['refunded'], (int) $deleted['refunded']]);
        $this->assertNotNull($cancelled['next_attempt_at'], 'a row set to cancelled is told so, once');
        $this->assertNull($deleted['next_attempt_at'], 'a deleted row hears nothing');
        $this->assertSame([0, 0], [$this->counter($app['id'], 'requester', $visitor), $this->counter($app['id'], 'app', '')], 'both uses given back');

        // Cancelled again: nothing more given back. And cancelled jobs hold no place.
        $this->call($app, '/api/cancel', self::MARKED, $cookie, null, 'POST', ['id' => $first['body']['id']]);
        $this->assertSame(0, $this->counter($app['id'], 'app', ''));
        $third = $this->call($app, '/api/jobs', self::MARKED, $cookie);
        $this->assertSame('queued', $this->jobs($app['id'])[2]['status'] ?? null);
        $this->assertSame(['status' => 'queued', 'lane' => 'picture', 'position' => 1, 'waiting' => 'queue'], $this->call($app, '/api/context', self::MARKED, $cookie, null, 'GET')['body']['context']['formlogic']['ai']['jobs'][$third['body']['id']] ?? null);
    }

    /** What a requester sees of their open jobs (contract §0.11): each in its own lane, and why it waits. */
    public function testWaitingJobsAreCountedInTheirOwnLaneAndSayWhyTheyWait(): void
    {
        $this->boot();
        $app = $this->app();
        $this->call($app, '/api/jobs', self::MARKED);
        $chat = $this->call($app, '/api/chat', self::MARKED);
        $cookie = self::cookieValue($chat['cookie']);
        $picture = $this->call($app, '/api/jobs', self::MARKED, $cookie);
        $jobs = $this->call($app, '/api/context', self::MARKED, $cookie, null, 'GET')['body']['context']['formlogic']['ai']['jobs'];
        $this->assertSame(['status' => 'queued', 'lane' => 'chat', 'position' => 1, 'waiting' => 'queue'], $jobs[$chat['body']['id']], 'the picture asked for before it is in the other lane');
        $this->assertSame(['status' => 'queued', 'lane' => 'picture', 'position' => 2, 'waiting' => 'queue'], $jobs[$picture['body']['id']], 'behind another visitor\'s picture');

        // On the owner's own computer, not heard from for ten minutes: it waits for the computer, not its turn.
        $connection = bin2hex(random_bytes(16));
        $key = base64_encode(random_bytes(32));
        self::$pdo->prepare("INSERT INTO desktop_connections (id, owner_user_id, device_name, desktop_instance_id, last_seen_at, e2e_public_key) VALUES (?, ?, 'Home PC', ?, NOW() - INTERVAL 10 MINUTE, ?)")
            ->execute([$connection, $this->ownerId, 'inst-' . bin2hex(random_bytes(4)), $key]);
        $own = $this->app('application', true, 'own');
        self::$pdo->prepare("UPDATE app_ai_settings SET own_connection_id = ?, own_instance_id = 'inst-own', own_public_key = ?, own_provider_id = 'oaiy-engine', own_picture_model = 'flux-test', own_device_name = 'Home PC' WHERE app_id = ?")
            ->execute([$connection, $key, $own['id']]);
        $waiting = $this->call($own, '/api/jobs', self::MARKED);
        $this->assertSame($connection, $this->jobs($own['id'])[0]['target']);
        $seen = $this->call($own, '/api/context', self::MARKED, self::cookieValue($waiting['cookie']), null, 'GET')['body']['context']['formlogic']['ai'];
        $this->assertSame(['status' => 'queued', 'lane' => 'picture', 'position' => 1, 'waiting' => 'computer_offline'], $seen['jobs'][$waiting['body']['id']]);
    }

    public function testSiteRoutesAreNeverAPagesToCall(): void
    {
        $this->boot();
        foreach ([$this->app(), $this->app('application', false)] as $app) {
            $answer = $this->call($app, '/api/site/ai/deliver', self::MARKED);
            $this->assertSame(404, $answer['http'], 'for every app, not only plugins');
        }
    }

    public function testAMembersAppNamesTheMemberAndKeepsItsIdentity(): void
    {
        $this->boot();
        $app = $this->app('members');
        $answer = $this->call($app, '/api/jobs', [], [], $this->ownerId);
        $formlogic = $answer['body']['context']['formlogic'];
        $this->assertSame([$app['id'], $this->ownerId, 'owner'], [$formlogic['appId'], $formlogic['userId'], $formlogic['roleId']]);
        $this->assertArrayNotHasKey('owner', $formlogic, 'a members\' app says its owner by roleId, as it always has');
        $this->assertArrayNotHasKey('visitor', $formlogic);
        $this->assertTrue($formlogic['ai']['enabled']);
        $this->assertSame('u-' . $this->ownerId, $formlogic['ai']['requester']);
        $job = $this->jobs($app['id'])[0];
        $this->assertSame(['user', $this->ownerId], [$job['requester_kind'], $job['requester_id']]);
    }

    // ------------------------------------------------------------------ the owner of a public app

    /**
     * An app anyone may open is told when its own owner is the one asking: `owner: true`, from the
     * sign-in alone, so the owner can reach the app's own settings once it is public. Nothing else of
     * them is said: no `userId`, and who asks for AI stays the browser's visitor.
     */
    public function testAPublicAppIsToldWhenItsOwnerIsAsking(): void
    {
        $this->boot();
        $app = $this->app();
        $seen = fn(array $headers, array $cookies, ?string $user, array $body = [], array $extra = []): array
            => $this->call($app, '/api/context', $headers, $cookies, $user, 'GET', $body, $extra)['body']['context']['formlogic'];

        // The owner, signed in, on the app's own page.
        $first = $this->call($app, '/api/jobs', self::MARKED, [], $this->ownerId);
        $cookie = self::cookieValue($first['cookie']);
        $formlogic = $first['body']['context']['formlogic'];
        $this->assertTrue($formlogic['owner']);
        $this->assertArrayNotHasKey('userId', $formlogic, 'no account is named: the app is open to anyone');
        $this->assertArrayNotHasKey('roleId', $formlogic);
        $this->assertMatchesRegularExpression('/^[0-9a-f]{32}$/D', (string) ($formlogic['visitor']['id'] ?? ''));
        $this->assertSame('v-' . $formlogic['visitor']['id'], $formlogic['ai']['requester'], 'who asks for AI is still the browser\'s visitor');
        $job = $this->jobs($app['id'])[0];
        $this->assertSame(['visitor', $formlogic['visitor']['id']], [$job['requester_kind'], $job['requester_id']], 'and their job is counted as a visitor\'s');
        $fields = array_keys($seen(self::MARKED, $cookie, $this->ownerId));
        sort($fields);
        $this->assertSame(['addressKey', 'ai', 'appId', 'owner', 'visitor'], $fields, 'and that is all');

        // Signed in, but not through the app's page (no marker): still the owner, and no visitor.
        $direct = $seen([], [], $this->ownerId);
        $this->assertTrue($direct['owner']);
        $this->assertArrayNotHasKey('visitor', $direct);

        // Anyone else: the field is absent, never false.
        $stranger = 'u-' . bin2hex(random_bytes(12));
        $this->assertArrayNotHasKey('owner', $seen(self::MARKED, $cookie, $stranger), 'someone else, signed in');
        $this->assertArrayNotHasKey('owner', $seen(self::MARKED, $cookie, null), 'a visitor, the owner\'s own browser included once signed out');
        $this->assertArrayNotHasKey('owner', $seen([], [], null), 'nobody');

        // Nothing the page sends makes an owner: not a header, not the app's own headers, not the
        // body, not a field beside them.
        $forgedHeaders = self::MARKED + ['X-FormLogic-Owner' => '1', 'X-Owner' => 'true', 'X-FormLogic-User' => $this->ownerId];
        $forgedFields = [
            'headers' => ['x-formlogic-owner' => '1', 'owner' => 'true', 'authorization' => 'Bearer ' . $this->ownerId],
            'owner' => true, 'userId' => $this->ownerId, 'formlogic' => ['owner' => true], 'context' => ['formlogic' => ['owner' => true]], 'identity' => ['formlogic' => ['owner' => true, 'userId' => $this->ownerId]],
        ];
        $forgedBody = ['owner' => true, 'formlogic' => ['owner' => true], 'context' => ['formlogic' => ['owner' => true]]];
        foreach ([null, $stranger] as $who) {
            $forged = $seen($forgedHeaders, $cookie, $who, $forgedBody, $forgedFields);
            $this->assertArrayNotHasKey('owner', $forged, json_encode($who));
            $this->assertArrayNotHasKey('userId', $forged);
        }
        // And the owner's is FormLogic's own word, whatever the page adds.
        $this->assertTrue($seen($forgedHeaders, $cookie, $this->ownerId, ['owner' => false], ['owner' => false, 'formlogic' => ['owner' => false]])['owner']);
    }

    /** Which apps are told: one that declares AI or payments and is open to anyone. Every other app is exactly as it was. */
    public function testOnlyAPublicAppThatDeclaresAiOrPaymentsIsToldOfItsOwner(): void
    {
        $this->boot();
        // Payments alone.
        $shop = $this->app('application', false, 'site', true);
        $formlogic = $this->call($shop, '/api/context', self::MARKED, [], $this->ownerId, 'GET')['body']['context']['formlogic'];
        $this->assertTrue($formlogic['owner']);
        $this->assertArrayNotHasKey('userId', $formlogic);
        $this->assertArrayNotHasKey('owner', $this->call($shop, '/api/context', self::MARKED, [], null, 'GET')['body']['context']['formlogic']);

        // Neither section (Coffee.Dating's shape): no `formlogic` at all, for its owner as for anyone.
        $plain = $this->app('application', false);
        $this->assertSame([], $this->call($plain, '/api/context', self::MARKED, [], $this->ownerId, 'GET')['body']['context']);
        $this->assertSame([], $this->call($plain, '/api/context', self::MARKED + ['X-FormLogic-Owner' => '1'], [], null, 'GET', ['owner' => true], ['owner' => true])['body']['context']);

        // A members' app, with or without the sections: the owner is `roleId: "owner"`, and no `owner`.
        foreach ([true, false] as $asks) {
            $members = $this->app('members', $asks);
            $formlogic = $this->call($members, '/api/context', [], [], $this->ownerId, 'GET')['body']['context']['formlogic'];
            $this->assertSame([$this->ownerId, 'owner'], [$formlogic['userId'], $formlogic['roleId']]);
            $this->assertArrayNotHasKey('owner', $formlogic);
        }
    }

    /**
     * The sign-in that makes an owner is the session's, checked as every signed-in request is: a
     * POST that carries the sign-in cookie reaches the app only with that session's CSRF token.
     * Through the middleware as public/index.php stacks it (CSRF for every route, then the route's
     * optional sign-in), with a real session.
     */
    public function testTheOwnersSignInCountsOnlyPastTheCsrfCheck(): void
    {
        $this->boot();
        $app = $this->app();
        $jwt = ['secret' => 'owner-context-test-secret-0123456789abcdef', 'algorithm' => 'HS256', 'expiry' => 3600];
        $auth = new AuthService(self::$mysql, $jwt);
        $csrfSecret = CsrfMiddleware::secretForJwt($jwt['secret']);
        $csrf = new CsrfMiddleware('formlogic_csrf', 'X-CSRF-Token', 'formlogic_auth', $csrfSecret, [self::ORIGIN]);
        $signIn = new AuthMiddleware($auth, true, 'formlogic_auth');
        $controller = $this->controller;
        $route = new class($controller, $app['slug']) implements RequestHandlerInterface {
            public function __construct(private NativeAppController $controller, private string $slug) {}
            public function handle(\Psr\Http\Message\ServerRequestInterface $request): \Psr\Http\Message\ResponseInterface
            {
                return $this->controller->runtime($request, new Response(), ['slug' => $this->slug]);
            }
        };
        $afterCsrf = new class($signIn, $route) implements RequestHandlerInterface {
            public function __construct(private AuthMiddleware $signIn, private RequestHandlerInterface $route) {}
            public function handle(\Psr\Http\Message\ServerRequestInterface $request): \Psr\Http\Message\ResponseInterface
            {
                return $this->signIn->process($request, $this->route);
            }
        };
        $send = fn(array $cookies, array $headers): array => self::answered($csrf->process($this->posted($app, '/api/context', self::MARKED + $headers, $cookies, 'GET'), $afterCsrf));

        $session = $auth->issueToken(new User(id: $this->ownerId, email: $this->ownerId . '@test.local'));
        $token = CsrfMiddleware::tokenForAuth($session, $csrfSecret);

        // The owner's browser, as FormLogic's page sends it: the cookie and its token.
        $owner = $send(['formlogic_auth' => $session], ['X-CSRF-Token' => $token]);
        $this->assertSame(200, $owner['http'], json_encode($owner['body']));
        $this->assertTrue($owner['body']['context']['formlogic']['owner']);
        $this->assertArrayNotHasKey('userId', $owner['body']['context']['formlogic']);

        // The cookie alone, as another site's page could make the browser send it: refused before
        // the app is asked anything. So is a token that is not this session's.
        $other = $auth->issueToken(new User(id: $this->ownerId, email: 'someone-else@test.local'));
        foreach ([[], ['X-CSRF-Token' => 'forged'], ['X-CSRF-Token' => CsrfMiddleware::tokenForAuth($other, $csrfSecret)], ['X-FormLogic-Owner' => '1']] as $headers) {
            $refused = $send(['formlogic_auth' => $session], $headers);
            $this->assertSame([403, 'CSRF token validation failed'], [$refused['http'], $refused['body']['message'] ?? null], json_encode($headers));
        }
        // No sign-in: a visitor, and nothing of an owner. A cookie that is no session: the same.
        foreach ([[], ['formlogic_auth' => '']] as $cookies) {
            $visitor = $send($cookies, ['X-CSRF-Token' => $token]);
            $this->assertSame(200, $visitor['http']);
            $this->assertArrayNotHasKey('owner', $visitor['body']['context']['formlogic']);
            $this->assertArrayHasKey('visitor', $visitor['body']['context']['formlogic']);
        }
        // Someone else's real session, with their own token: signed in, and not the owner.
        $stranger = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'Someone')")->execute([$stranger, $stranger . '@test.local']);
        try {
            $theirs = $auth->issueToken(new User(id: $stranger, email: $stranger . '@test.local'));
            $answer = $send(['formlogic_auth' => $theirs], ['X-CSRF-Token' => CsrfMiddleware::tokenForAuth($theirs, $csrfSecret)]);
            $this->assertSame(200, $answer['http']);
            $this->assertArrayNotHasKey('owner', $answer['body']['context']['formlogic']);
        } finally {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$stranger]);
        }
    }

    // ------------------------------------------------------------------ the address a request came from

    /** `req.context.formlogic` on one call of $app's backend, over the connection $server describes (the test's own address when null). */
    private function seenFrom(array $app, ?array $server, array $headers = self::MARKED, array $cookies = [], ?string $user = null, array $body = [], array $extra = []): array
    {
        $answer = $this->call($app, '/api/context', $headers, $cookies, $user, 'GET', $body, $extra, $server);
        $this->assertSame(200, $answer['status'], json_encode($answer['body']));
        return $answer['body']['context']['formlogic'];
    }

    /** Run $work on a site whose TRUSTED_PROXIES is $proxies (none when null) and that names no TRUSTED_PROXY_HEADER; then put both back. */
    private static function withTrustedProxies(?string $proxies, callable $work): void
    {
        $names = ['TRUSTED_PROXIES', 'TRUSTED_PROXY_HEADER'];
        $before = array_map(static fn(string $name): array => [getenv($name), $_ENV[$name] ?? null], array_combine($names, $names));
        try {
            foreach ($names as $name) { putenv($name); unset($_ENV[$name]); }
            if ($proxies !== null) putenv('TRUSTED_PROXIES=' . $proxies);
            $work();
        } finally {
            foreach ($before as $name => [$process, $loaded]) {
                $process === false ? putenv($name) : putenv($name . '=' . $process);
                if ($loaded === null) unset($_ENV[$name]); else $_ENV[$name] = $loaded;
            }
        }
    }

    /**
     * An app that declares AI or payments is given a key for the address each request came from
     * (`addressKey`), so its own limits can be per address as FormLogic's AI limits are: a count per
     * visitor alone is no limit, since a new cookie is a new visitor. One address is one key in one
     * app, whoever asks; another app sees another; an IPv6 address counts by its /64; the address
     * itself is never given; and where no address is known, nothing is.
     */
    public function testAnAppIsGivenAKeyForTheAddressEachRequestCameFrom(): void
    {
        $this->boot();
        $app = $this->app();
        self::withTrustedProxies(null, function () use ($app): void {
            // A visitor, on the app's own page.
            $first = $this->call($app, '/api/jobs', self::MARKED);
            $visitor = $first['body']['context']['formlogic']['visitor']['id'];
            $key = $first['body']['context']['formlogic']['addressKey'] ?? null;
            $this->assertMatchesRegularExpression('/^[0-9a-f]{32}$/D', (string) $key);
            // Nothing goes into it but the site's key, the app and the address: it is the same
            // tomorrow, and for as long as the site's key is.
            $siteKey = (string) hex2bin((string) self::$pdo->query("SELECT meta_value FROM system_meta WHERE meta_key = 'app_visitor_key'")->fetchColumn());
            $this->assertSame(substr(hash_hmac('sha256', 'fl-app-address-v1|' . $app['id'] . '|' . self::IP, $siteKey), 0, 32), $key);
            $this->assertSame($key, (new AppVisitors(self::$mysql))->addressKey($app['id'], self::IP), 'another process reads the same key');
            $told = (string) json_encode($first['body']['context']);
            $this->assertStringNotContainsString(self::IP, $told, 'the address itself is never given');
            $this->assertStringNotContainsString($this->visitors->ipKey(self::IP), $told, 'nor FormLogic\'s own key for it, which is the same in every app');

            // Whoever asks from that address: the same browser again, a new one (a new cookie is a
            // new visitor, at the same address), a request nobody marked, the owner signed in.
            $cookie = self::cookieValue($first['cookie']);
            $again = $this->seenFrom($app, null, self::MARKED, $cookie);
            $this->assertSame([$visitor, $key], [$again['visitor']['id'], $again['addressKey']]);
            $another = $this->seenFrom($app, null);
            $this->assertNotSame($visitor, $another['visitor']['id']);
            $this->assertSame($key, $another['addressKey'], 'a cleared cookie is a new visitor, and the same address');
            $unmarked = $this->seenFrom($app, null, []);
            $this->assertArrayNotHasKey('visitor', $unmarked);
            $this->assertSame($key, $unmarked['addressKey'], 'a request nobody marked has an address too, so the app can count or refuse it');
            $owner = $this->seenFrom($app, null, self::MARKED, $cookie, $this->ownerId);
            $this->assertSame([true, $key], [$owner['owner'], $owner['addressKey']]);

            // Another app sees another key for the same address: it cannot be followed from app to app.
            $cafe = $this->app();
            $there = $this->seenFrom($cafe, null, self::MARKED, $cookie)['addressKey'];
            $this->assertMatchesRegularExpression('/^[0-9a-f]{32}$/D', (string) $there);
            $this->assertNotSame($key, $there);
            $this->assertSame($there, $this->seenFrom($cafe, null)['addressKey']);

            // Another address is another key, for the same browser.
            $moved = $this->seenFrom($app, ['REMOTE_ADDR' => '203.0.113.10'], self::MARKED, $cookie);
            $this->assertSame($visitor, $moved['visitor']['id']);
            $this->assertMatchesRegularExpression('/^[0-9a-f]{32}$/D', (string) $moved['addressKey']);
            $this->assertNotSame($key, $moved['addressKey']);

            // An IPv6 address by its /64, as FormLogic's own limits count it (AppVisitors::ipKey).
            $six = fn(string $address): ?string => $this->seenFrom($app, ['REMOTE_ADDR' => $address])['addressKey'] ?? null;
            $this->assertMatchesRegularExpression('/^[0-9a-f]{32}$/D', (string) $six('2001:db8:1:2::10'));
            $this->assertSame($six('2001:db8:1:2::10'), $six('2001:db8:1:2:ffff::1'), 'one /64 is one subscriber, whichever of its addresses they use');
            $this->assertNotSame($six('2001:db8:1:2::10'), $six('2001:db8:1:3::10'), 'the next /64 is someone else');
            $this->assertSame($key, $six('::ffff:' . self::IP), 'an IPv4 peer as a dual-stack listener reports it');

            // No address known: the field is absent, so the app can tell that from an address. The
            // visitor is still the visitor.
            foreach ([[], ['REMOTE_ADDR' => ''], ['REMOTE_ADDR' => 'unix:'], ['REMOTE_ADDR' => 'unknown'], ['HTTP_X_FORWARDED_FOR' => self::IP]] as $server) {
                $nowhere = $this->seenFrom($app, $server, self::MARKED, $cookie);
                $this->assertArrayNotHasKey('addressKey', $nowhere, json_encode($server));
                $this->assertSame($visitor, $nowhere['visitor']['id']);
            }

            // Nothing the page sends sets it, or moves it: not a header, not the app's own headers,
            // not the body, not a field beside them.
            $made = str_repeat('a', 32);
            $elsewhere = '198.51.100.77';
            $forgedHeaders = self::MARKED + ['X-Forwarded-For' => $elsewhere, 'X-Real-IP' => $elsewhere, 'Client-IP' => $elsewhere, 'CF-Connecting-IP' => $elsewhere, 'Forwarded' => 'for=' . $elsewhere,
                'X-FormLogic-Address-Key' => $made, 'X-FormLogic-Address' => $elsewhere, 'X-Address-Key' => $made];
            $forgedConnection = ['HTTP_X_FORWARDED_FOR' => $elsewhere, 'HTTP_X_REAL_IP' => $elsewhere, 'HTTP_CLIENT_IP' => $elsewhere, 'HTTP_CF_CONNECTING_IP' => $elsewhere, 'HTTP_FORWARDED' => 'for=' . $elsewhere];
            $forgedFields = [
                'headers' => ['x-forwarded-for' => $elsewhere, 'x-formlogic-address-key' => $made, 'addresskey' => $made],
                'addressKey' => $made, 'client_ip' => $elsewhere, 'clientIp' => $elsewhere, 'ip' => $elsewhere,
                'formlogic' => ['addressKey' => $made], 'context' => ['formlogic' => ['addressKey' => $made]], 'identity' => ['formlogic' => ['addressKey' => $made]],
            ];
            $forgedBody = ['addressKey' => $made, 'client_ip' => $elsewhere, 'formlogic' => ['addressKey' => $made], 'context' => ['formlogic' => ['addressKey' => $made]]];
            $forged = $this->seenFrom($app, ['REMOTE_ADDR' => self::IP] + $forgedConnection, $forgedHeaders, $cookie, null, $forgedBody, $forgedFields);
            $this->assertSame($key, $forged['addressKey'], 'the connection\'s address, whatever the page says');
            $this->assertArrayNotHasKey('addressKey', $this->seenFrom($app, $forgedConnection, $forgedHeaders, $cookie, null, $forgedBody, $forgedFields), 'and where none is known, the page cannot make one');
        });

        // Behind a proxy. Without TRUSTED_PROXIES every visitor is the proxy, so an app's limits
        // per address become one shared allowance (docs/HOSTED_APPS.md, "Before going live"). With
        // it, each visitor is the address the proxy says they came from.
        $behind = static fn(string $visitor): array => ['REMOTE_ADDR' => '10.0.0.2', 'HTTP_X_FORWARDED_FOR' => $visitor];
        self::withTrustedProxies(null, function () use ($app, $behind): void {
            $this->assertSame($this->seenFrom($app, $behind('198.51.100.7'))['addressKey'], $this->seenFrom($app, $behind('198.51.100.8'))['addressKey'], 'two visitors, one key: the proxy\'s');
        });
        self::withTrustedProxies('10.0.0.0/8', function () use ($app, $behind): void {
            $one = $this->seenFrom($app, $behind('198.51.100.7'))['addressKey'];
            $this->assertNotSame($one, $this->seenFrom($app, $behind('198.51.100.8'))['addressKey'], 'two visitors, two keys');
            $this->assertSame($one, $this->seenFrom($app, ['REMOTE_ADDR' => '198.51.100.7'])['addressKey'], 'the visitor\'s own address, as if they had come directly');
            $this->assertSame($one, $this->seenFrom($app, $behind('6.6.6.6, 198.51.100.7'))['addressKey'], 'what the visitor wrote before the proxy\'s word is not read');
        });
    }

    /** Which apps are given it: one that declares AI or payments, open to anyone or members only. Every other app is exactly as it was. */
    public function testOnlyAnAppThatDeclaresAiOrPaymentsIsGivenAnAddressKey(): void
    {
        $this->boot();
        $key = '/^[0-9a-f]{32}$/D';
        // Payments alone, open to anyone.
        $shop = $this->app('application', false, 'site', true);
        $this->assertMatchesRegularExpression($key, (string) ($this->seenFrom($shop, null)['addressKey'] ?? ''));

        // A members' app that declares AI: beside who the member is, for its owner and for any other member.
        $members = $this->app('members');
        $owner = $this->seenFrom($members, null, [], [], $this->ownerId);
        $this->assertSame([$this->ownerId, 'owner'], [$owner['userId'], $owner['roleId']]);
        $this->assertMatchesRegularExpression($key, (string) ($owner['addressKey'] ?? ''));
        $this->members->method('getAppUser')->willReturn(['status' => 'active', 'roleId' => 'member']);
        $member = 'u-' . bin2hex(random_bytes(12));
        $theirs = $this->seenFrom($members, null, [], [], $member);
        $this->assertSame([$member, 'member', $owner['addressKey']], [$theirs['userId'], $theirs['roleId'], $theirs['addressKey'] ?? null], 'two members at one address');
        $this->assertArrayNotHasKey('addressKey', $this->seenFrom($members, [], [], [], $member), 'and none where no address is known');

        // Neither section (Coffee.Dating's shape): no `formlogic` at all, whatever the page sends.
        $plain = $this->app('application', false);
        $this->assertSame([], $this->call($plain, '/api/context', self::MARKED, [], null, 'GET')['body']['context']);
        $made = str_repeat('a', 32);
        $this->assertSame([], $this->call($plain, '/api/context', self::MARKED + ['X-FormLogic-Address-Key' => $made, 'X-Forwarded-For' => '198.51.100.77'], [], $this->ownerId, 'GET',
            ['addressKey' => $made], ['addressKey' => $made, 'formlogic' => ['addressKey' => $made], 'context' => ['formlogic' => ['addressKey' => $made]]])['body']['context']);

        // A members' app with neither: who the member is, exactly as it always was.
        $old = $this->app('members', false);
        $this->assertSame(['appId' => $old['id'], 'userId' => $this->ownerId, 'roleId' => 'owner'], $this->call($old, '/api/context', [], [], $this->ownerId, 'GET')['body']['context']['formlogic']);
        $this->assertSame(['appId' => $old['id'], 'userId' => $member, 'roleId' => 'member'], $this->call($old, '/api/context', [], [], $member, 'GET')['body']['context']['formlogic']);
    }

    // ------------------------------------------------------------------ a chat answer's length, and follow-ups (contract §0.13)

    /** A jobs row as the app wrote it, of a chat or a picture. */
    private static function row(string $kind = 'chat', array $more = []): array
    {
        $row = ['id' => 'row-' . bin2hex(random_bytes(6)), 'kind' => $kind];
        if ($kind === 'chat') $row['messages'] = json_encode([['role' => 'user', 'content' => 'Name my cafe.']]);
        else $row['prompt'] = 'A coffee cup logo, flat colours';
        return $more + $row;
    }

    /** The binding of a request from a visitor's page: [binding, visitor id, address key]. */
    private static function visitor(?string $ipKey = null): array
    {
        $visitor = bin2hex(random_bytes(16));
        $ipKey ??= bin2hex(random_bytes(8));
        return [AppAiService::binding(['kind' => 'visitor', 'id' => $visitor], $ipKey), $visitor, $ipKey];
    }

    /**
     * One created row captured as a dispatcher hands it over ($binding: the request's, or a
     * delivery's): the job it became, or null when it was not taken.
     */
    private function captured(array $app, array $row, string $binding, string $event = 'app.record.created.ai_jobs'): ?array
    {
        $taken = $this->ai->capture($app['id'], bin2hex(random_bytes(16)), $event, ['record' => ['id' => $row['id']]], [$binding], static fn(): array => $row);
        if ($taken === 0) return null;
        $statement = self::$pdo->prepare('SELECT * FROM app_ai_jobs WHERE app_id = ? AND app_job_id = ?');
        $statement->execute([$app['id'], (string) $row['id']]);
        $job = $statement->fetch(PDO::FETCH_ASSOC);
        return is_array($job) ? $job : null;
    }

    /** What a delivery of job $jobId carries: a new row it writes in the jobs table may be that job's follow-up. */
    private static function deliveryBinding(string $jobId): string
    {
        return AppAiService::followUpSubscription('ai_jobs', $jobId)[0]['bindings'][0];
    }

    public function testAChatJobsRowMaySayHowLongItsAnswerMayBe(): void
    {
        $this->boot();
        $app = $this->app();
        $ask = fn(array $more): array => (array) $this->captured($app, self::row('chat', $more), self::visitor()[0]);

        $this->assertNull($ask([])['max_output'], 'none given: the site\'s ceiling, read as the job is sent');
        foreach ([[null, null], ['', null], [1500, 1500], ['1500', 1500], [1500.0, 1500], [1, 1], [8000, 8000], [99999, 8000]] as [$given, $kept]) {
            $job = $ask(['max_output' => $given]);
            $this->assertSame(['queued', $kept], [$job['status'], $job['max_output'] === null ? null : (int) $job['max_output']], json_encode($given));
        }
        $counted = $this->counter($app['id'], 'app', '');
        $this->assertSame(9, $counted);
        foreach ([0, -5, '0', 'lots', 1.5, true, '1e3'] as $given) {
            $job = $ask(['max_output' => $given]);
            $this->assertSame(['refused', 'bad_request', 'A chat job\'s max_output is a whole number of tokens, 1 or more.', null], [$job['status'], $job['code'], $job['message'], $job['max_output']], json_encode($given));
        }
        $this->assertSame($counted, $this->counter($app['id'], 'app', ''), 'a refused job is not counted');
        // A picture has no answer length: the column is not read.
        $picture = (array) $this->captured($app, self::row('picture', ['max_output' => 'lots']), self::visitor()[0]);
        $this->assertSame(['queued', null], [$picture['status'], $picture['max_output']]);
    }

    public function testAnAnswersLengthIsHeldToTheAdministratorsCeiling(): void
    {
        $site = AppAiSiteSettings::defaults();
        $this->assertSame(2000, $site['chatMaxOutput']);
        $this->assertSame(2000, AppAiService::answerTokens(null, $site), 'an app that gives none gets the ceiling');
        $this->assertSame(1500, AppAiService::answerTokens(1500, $site));
        $this->assertSame(1500, AppAiService::answerTokens('1500', $site), 'as MySQL hands the column back');
        $this->assertSame(2000, AppAiService::answerTokens(5000, $site), 'more than the site allows is held to what it allows');
        $this->assertSame(300, AppAiService::answerTokens(1500, ['chatMaxOutput' => 300] + $site), 'a ceiling lowered since the job was asked for applies');
        $this->assertSame(300, AppAiService::answerTokens(null, ['chatMaxOutput' => 300] + $site));
        $this->assertSame(2000, AppAiService::answerTokens(null, []), 'settings from before there was a ceiling');
        // What is read of an answer, whatever comes: eight characters a token, and never more than 32,000.
        $this->assertSame([8, 160, 12000, 16000, 32000, 32000], array_map(AppAiService::answerCharacters(...), [1, 20, 1500, 2000, 4000, 8000]));

        $this->assertSame(600, AppAiSiteSettings::validate(['chatMaxOutput' => 600])['chatMaxOutput']);
        $this->assertSame([16, 8000], [AppAiSiteSettings::validate(['chatMaxOutput' => 16])['chatMaxOutput'], AppAiSiteSettings::validate(['chatMaxOutput' => 8000])['chatMaxOutput']]);
        foreach ([15, 8001, '600', 2000.0] as $refused) {
            try {
                AppAiSiteSettings::validate(['chatMaxOutput' => $refused]);
                $this->fail('accepted ' . json_encode($refused));
            } catch (\InvalidArgumentException $e) {
                $this->assertSame('chatMaxOutput must be a whole number from 16 to 8000.', $e->getMessage());
            }
        }
    }

    public function testADeliverysBindingIsReadBackAsItsJob(): void
    {
        $job = bin2hex(random_bytes(16));
        $this->assertSame([['event' => 'app.record.created.ai_jobs', 'bindings' => ['fl-ai-f-' . $job]]], AppAiService::followUpSubscription('ai_jobs', $job), 'only the creation of a row: a delivery\'s update or delete asks nothing');
        $this->assertSame(['kind' => AppAiService::FOLLOW_UP, 'job' => $job, 'id' => '', 'ipKey' => ''], AppAiService::parseBinding('fl-ai-f-' . $job));
        foreach (['fl-ai-f-' . strtoupper($job), 'fl-ai-f-' . substr($job, 1), 'fl-ai-f-' . $job . '0', 'fl-ai-f-' . $job . "\n"] as $not) {
            $this->assertNull(AppAiService::parseBinding($not));
        }
        $this->assertSame('v-abc', AppAiService::requesterId(['kind' => 'visitor', 'id' => 'abc']));
        $this->assertSame('u-u-123', AppAiService::requesterId(['kind' => 'user', 'id' => 'u-123']));
        foreach ([null, ['kind' => AppAiService::NOBODY, 'id' => ''], ['kind' => AppAiService::TEST_REQUESTER, 'id' => 'u-1']] as $nobody) {
            $this->assertNull(AppAiService::requesterId($nobody));
        }
    }

    /**
     * A row the deliver route writes while a job's result is handed to it is a follow-up job for
     * whoever asked for that job (contract §0.13): theirs in every count, one for a delivered job,
     * and none from a follow-up's delivery.
     */
    public function testARowWrittenDuringADeliveryIsAFollowUpForTheDeliveredJobsRequester(): void
    {
        $this->boot();
        $app = $this->app();
        [$binding, $visitor, $ipKey] = self::visitor();
        $chat = (array) $this->captured($app, self::row('chat'), $binding);
        $this->assertSame(['queued', null], [$chat['status'], $chat['follow_up_of']]);
        // The chat is answered and its result is being delivered: it holds no place any more.
        self::$pdo->prepare("UPDATE app_ai_jobs SET status = 'delivering' WHERE id = ?")->execute([$chat['id']]);

        $drawing = (array) $this->captured($app, self::row('picture'), self::deliveryBinding($chat['id']));
        $this->assertSame(['picture', 'queued', 'visitor', $visitor, $ipKey, $chat['id']],
            [$drawing['kind'], $drawing['status'], $drawing['requester_kind'], $drawing['requester_id'], $drawing['ip_key'], $drawing['follow_up_of']], 'asked for as if their page had asked');
        foreach ([['requester', 'v:' . $visitor], ['ip', $ipKey], ['ip-hour', $ipKey], ['app', '']] as [$scope, $subject]) {
            $this->assertSame(2, $this->counter($app['id'], $scope, $subject), "{$scope}: the chat and its follow-up");
        }

        // A second row from the same delivery (or from a second try of it): refused, the app told, nothing counted.
        $second = (array) $this->captured($app, self::row('picture'), self::deliveryBinding($chat['id']));
        $this->assertSame(['refused', 'limit_reached', 'One follow-up job may be asked for while a job\'s result is delivered, and this delivery has asked for its one.', $chat['id'], $visitor],
            [$second['status'], $second['code'], $second['message'], $second['follow_up_of'], $second['requester_id']]);
        $this->assertNotNull($second['next_attempt_at'], 'told at once');
        $this->assertSame(2, $this->counter($app['id'], 'app', ''));

        // The follow-up is drawn and delivered: a row its delivery writes is no job. The chain ends by itself.
        self::$pdo->prepare("UPDATE app_ai_jobs SET status = 'delivering' WHERE id = ?")->execute([$drawing['id']]);
        $third = (array) $this->captured($app, self::row('picture'), self::deliveryBinding($drawing['id']));
        $this->assertSame(['refused', 'limit_reached', 'A follow-up job\'s delivery cannot ask for another job.', $drawing['id']], [$third['status'], $third['code'], $third['message'], $third['follow_up_of']]);
        $this->assertSame(2, $this->counter($app['id'], 'app', ''));

        // And those refusals' own deliveries ask for nothing at all: a deliver route that writes a
        // row every time it is called is not answered for ever.
        foreach ([$second, $third] as $refused) {
            $this->assertFalse(AppAiService::deliveryMayAsk($refused));
            $this->assertNull($this->captured($app, self::row('picture'), self::deliveryBinding($refused['id'])));
        }
        $this->assertTrue(AppAiService::deliveryMayAsk($chat));
        $this->assertTrue(AppAiService::deliveryMayAsk(['status' => 'done'] + $drawing), 'a taken follow-up\'s delivery is still heard, to be told no');
        $this->assertCount(4, $this->jobs($app['id']));
    }

    /** A follow-up is held to its requester's limits like any job of theirs, and answered with the usual code. */
    public function testAFollowUpIsHeldToItsRequestersOwnLimits(): void
    {
        $this->boot();
        $app = $this->app();

        // Their day's allowance: one job, which the chat used.
        self::$pdo->prepare('UPDATE app_ai_settings SET per_requester_day = 1 WHERE app_id = ?')->execute([$app['id']]);
        [$binding, $visitor] = self::visitor();
        $chat = (array) $this->captured($app, self::row('chat'), $binding);
        self::$pdo->prepare("UPDATE app_ai_jobs SET status = 'delivering' WHERE id = ?")->execute([$chat['id']]);
        $refused = (array) $this->captured($app, self::row('picture'), self::deliveryBinding($chat['id']));
        $this->assertSame(['refused', 'limit_reached', 'You have used today\'s AI allowance. It starts again tomorrow (UTC).', $visitor],
            [$refused['status'], $refused['code'], $refused['message'], $refused['requester_id']]);
        $this->assertSame(1, $this->counter($app['id'], 'requester', 'v:' . $visitor));
        // That was the delivery's one: another row is not taken in its place.
        $this->assertSame('limit_reached', $this->captured($app, self::row('picture'), self::deliveryBinding($chat['id']))['code'] ?? null);

        // Their two open jobs: a follow-up asked for while both still run waits for neither.
        self::$pdo->prepare('UPDATE app_ai_settings SET per_requester_day = 10 WHERE app_id = ?')->execute([$app['id']]);
        [$binding, $busy] = self::visitor();
        $delivered = (array) $this->captured($app, self::row('chat'), $binding);
        self::$pdo->prepare("UPDATE app_ai_jobs SET status = 'delivering' WHERE id = ?")->execute([$delivered['id']]);
        $this->captured($app, self::row('picture'), $binding);
        $this->captured($app, self::row('chat'), $binding);
        $third = (array) $this->captured($app, self::row('picture'), self::deliveryBinding($delivered['id']));
        $this->assertSame(['refused', 'busy', 'Wait for your current requests to finish first.', $busy], [$third['status'], $third['code'], $third['message'], $third['requester_id']]);

        // Their address: the hour's requests from it are used up.
        [$binding, , $ipKey] = self::visitor();
        $last = (array) $this->captured($app, self::row('chat'), $binding);
        self::$pdo->prepare("UPDATE app_ai_jobs SET status = 'delivering' WHERE id = ?")->execute([$last['id']]);
        self::$pdo->prepare('UPDATE app_ai_settings SET per_ip_hour = 1 WHERE app_id = ?')->execute([$app['id']]);
        $fromThere = (array) $this->captured($app, self::row('picture'), self::deliveryBinding($last['id']));
        $this->assertSame(['refused', 'limit_reached', $ipKey], [$fromThere['status'], $fromThere['code'], $fromThere['ip_key']]);
        $this->assertStringContainsString('this network', (string) $fromThere['message']);
    }

    /** What a delivery's binding never does: ask for another app, for nobody, for a test, or cancel. */
    public function testADeliverysBindingAsksOnlyForItsOwnJobsRequester(): void
    {
        $this->boot();
        $app = $this->app();
        $other = $this->app();
        [$binding] = self::visitor();
        $job = (array) $this->captured($app, self::row('chat'), $binding);

        $this->assertNull($this->captured($other, self::row('picture'), self::deliveryBinding($job['id'])), 'another app\'s job');
        $this->assertNull($this->captured($app, self::row('picture'), self::deliveryBinding(bin2hex(random_bytes(16)))), 'no such job');
        // A delivery's update or delete of a jobs row cancels nothing, even with the binding.
        $open = (array) $this->captured($app, self::row('picture'), $binding);
        foreach (['app.record.updated.ai_jobs', 'app.record.deleted.ai_jobs'] as $event) {
            $this->assertSame(0, $this->ai->capture($app['id'], bin2hex(random_bytes(16)), $event, ['record' => ['id' => $open['app_job_id'], 'status' => 'cancelled']], [self::deliveryBinding($job['id'])], null));
        }
        $this->assertSame('queued', $this->jobs($app['id'])[1]['status']);

        // A job nobody known asked for, and an owner's test: their deliveries ask for nothing.
        $nobody = (array) $this->captured($app, self::row('chat'), 'fl-ai-n-' . bin2hex(random_bytes(8)));
        $this->assertSame(['refused', AppAiService::NOBODY], [$nobody['status'], $nobody['requester_kind']]);
        $this->assertFalse(AppAiService::deliveryMayAsk($nobody));
        $this->assertNull($this->captured($app, self::row('picture'), self::deliveryBinding($nobody['id'])));
        $this->assertFalse(AppAiService::deliveryMayAsk(['requester_kind' => AppAiService::TEST_REQUESTER, 'follow_up_of' => null, 'status' => 'done']));
    }

    public function testChatAndBadJobsAreReadAsTheyAre(): void
    {
        $this->boot();
        $app = $this->app();
        $first = $this->call($app, '/api/chat', self::MARKED);
        $this->call($app, '/api/bad', self::MARKED, self::cookieValue($first['cookie']));
        [$chat, $bad] = $this->jobs($app['id']);
        $this->assertSame(['chat', 'queued'], [$chat['kind'], $chat['status']]);
        $this->assertSame([['role' => 'system', 'content' => 'You edit logos.'], ['role' => 'user', 'content' => 'Make the cup bigger.']], json_decode((string) $chat['prompt'], true));
        $this->assertSame(['refused', 'bad_request'], [$bad['status'], $bad['code']]);
    }

    public function testTheCronDispatcherTakesWhatAnInlineDispatchMissed(): void
    {
        $this->boot();
        $app = $this->app();
        // Another process is dispatching this app's events: the request's own dispatch gives way.
        $lock = fopen($this->storage . '/' . hash('sha256', $app['id']) . '/private/events.lock', 'c');
        $this->assertTrue(flock($lock, LOCK_EX));
        try {
            $answer = $this->call($app, '/api/jobs', self::MARKED);
            $this->assertSame(201, $answer['status']);
            $this->assertSame([], $this->jobs($app['id']), 'not taken yet: the event waits in the app\'s outbox');
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
        // bin/native-record-dispatch.php's call.
        $this->assertSame(1, $this->native->dispatchRecordEvents($app['id'], $this->router->for($app['id'])));
        $jobs = $this->jobs($app['id']);
        $this->assertCount(1, $jobs);
        $this->assertSame([$answer['body']['id'], 'queued', 1500], [$jobs[0]['app_job_id'], $jobs[0]['status'], mb_strlen((string) $jobs[0]['prompt'])]);
        $this->assertSame(0, $this->native->dispatchRecordEvents($app['id'], $this->router->for($app['id'])), 'acknowledged once taken');
    }

    private static function removeTree(string $path): void
    {
        $iterator = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($path, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($iterator as $entry) { if ($entry->isDir() && !$entry->isLink()) @rmdir($entry->getPathname()); else @unlink($entry->getPathname()); }
        @rmdir($path);
    }
}

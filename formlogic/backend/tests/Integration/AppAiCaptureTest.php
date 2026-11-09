<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\NativeAppController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Models\User;
use FormLogic\Services\AIService;
use FormLogic\Services\AppAiService;
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
        $this->controller = new NativeAppController(self::$apps, $this->createMock(AppUserService::class), $this->native, $plans, $flows, $engines, null, null, null, null, $this->router, $this->visitors, $this->ai);
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
        if ($this->ownerId !== '') self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->ownerId]);
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
function deliver(req) { return { status: 200, body: { delivered: true } }; }
JS;

    private function project(string $access, bool $asks): array
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
                    ['path' => '/api/site/ai/deliver', 'method' => 'POST', 'handler' => 'deliver', 'transaction' => 'write', 'authorization' => 'anonymous'],
                ],
            ],
        ];
        if ($asks) $manifest['formlogicAi'] = ['uses' => ['pictures', 'picture-edits', 'chat'], 'purpose' => 'Draws logos.', 'jobs' => ['table' => 'ai_jobs', 'deliver' => '/api/site/ai/deliver']];
        return ['version' => 0, 'home' => true, 'access' => $access, 'assets' => [], 'files' => [
            'manifest.json' => json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES),
            'ui/main.ui' => '<Stack><Text>Logos</Text></Stack>',
            'server/main.logic' => self::SERVER,
            'server/migrations/001.sql' => 'CREATE TABLE ai_jobs(id TEXT PRIMARY KEY, kind TEXT NOT NULL, prompt TEXT, size TEXT, seed INTEGER, reference TEXT, messages TEXT, note TEXT);',
        ]];
    }

    /** A published app with this project, and AI set to $mode for it. */
    private function app(string $access = 'application', bool $asks = true, string $mode = 'site'): array
    {
        $app = self::$apps->createApp(['name' => 'Logos ' . bin2hex(random_bytes(3)), 'settings' => ['softnApp' => true]], $this->ownerId);
        $this->appIds[] = $app['id'];
        $this->native->install($app['id'], $this->project($access, $asks), 0);
        self::$pdo->prepare("UPDATE apps SET status = 'published' WHERE id = ?")->execute([$app['id']]);
        if ($mode !== 'off') self::$pdo->prepare('INSERT INTO app_ai_settings (app_id, mode) VALUES (?, ?)')->execute([$app['id'], $mode]);
        return self::$apps->getApp($app['id']);
    }

    /** One request from the app's page, as the parent sends it. */
    private function call(array $app, string $path, array $headers = [], array $cookies = [], ?string $user = null, string $method = 'POST'): array
    {
        $payload = ['method' => $method, 'path' => $path, 'query' => [], 'headers' => [], 'body' => new \stdClass()];
        $request = (new ServerRequestFactory())->createServerRequest('POST', self::ORIGIN . '/api/app/' . $app['slug'] . '/native/request', ['REMOTE_ADDR' => self::IP])
            ->withHeader('Host', '127.0.0.1:8300')->withHeader('Content-Type', 'application/json')->withCookieParams($cookies)->withParsedBody(json_decode(json_encode($payload), true));
        $request->getBody()->write(json_encode($payload));
        foreach ($headers as $name => $value) $request = $request->withHeader($name, $value);
        if ($user !== null) $request = $request->withAttribute('userId', $user)->withAttribute('user', new User(id: $user, email: $user . '@test.local'));
        $response = $this->controller->runtime($request, new Response(), ['slug' => $app['slug']]);
        $data = json_decode((string) $response->getBody(), true);
        return ['http' => $response->getStatusCode(), 'status' => $data['result']['status'] ?? null, 'body' => $data['result']['body'] ?? $data, 'cookie' => $response->getHeaderLine('Set-Cookie')];
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
        $this->assertSame(['status' => 'queued', 'position' => 1], $second['body']['context']['formlogic']['ai']['jobs'][$first['body']['id']]);
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
            $this->assertSame('', $answer['cookie']);
        }
        $this->assertSame([], $this->jobs($app['id']), 'no subscription, so the writes asked for nothing');
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

    public function testAiTurnedOffTakesNothing(): void
    {
        $this->boot();
        $app = $this->app('application', true, 'off');
        $answer = $this->call($app, '/api/jobs', self::MARKED);
        $this->assertFalse($answer['body']['context']['formlogic']['ai']['enabled']);
        $this->assertSame('ai_off', $answer['body']['context']['formlogic']['ai']['reason']);
        $this->assertSame([], $this->jobs($app['id']));
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
        $this->assertArrayNotHasKey('visitor', $formlogic);
        $this->assertTrue($formlogic['ai']['enabled']);
        $job = $this->jobs($app['id'])[0];
        $this->assertSame(['user', $this->ownerId], [$job['requester_kind'], $job['requester_id']]);
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

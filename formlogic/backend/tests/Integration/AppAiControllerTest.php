<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\AppAiController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AIService;
use FormLogic\Services\AppAiService;
use FormLogic\Services\AppAiSiteSettings;
use FormLogic\Services\AppService;
use FormLogic\Services\AppVisitors;
use FormLogic\Services\FormService;
use FormLogic\Services\NativeAppService;
use FormLogic\Support\SessionOriginPolicy;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * The owner's "AI for this app" and the administrator's "AI for apps" (AppAiController): who may look
 * and who may change, what is checked, a test that is a real job, a stop for one app, and the warning
 * for a site behind Cloudflare that reads every visitor as Cloudflare.
 */
final class AppAiControllerTest extends TestCase
{
    private static ?PDO $pdo = null;
    private static ?MySQLConnection $mysql = null;
    private static AppService $apps;
    private static string $tmpRoot = '';

    private string $ownerId = '';
    private string $otherId = '';
    private array $app = [];
    private AppAiSiteSettings $site;
    private AppAiService $ai;
    private AppAiController $controller;
    private NativeAppService $native;

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
        self::$tmpRoot = sys_get_temp_dir() . '/formlogic-app-ai-ctrl-' . bin2hex(random_bytes(4));
        mkdir(self::$tmpRoot . '/sqlite', 0777, true);
        self::$apps = new AppService($conn, new FormService($conn, new SQLiteConnection(self::$tmpRoot . '/sqlite')));
    }

    protected function setUp(): void
    {
        if (self::$pdo === null) $this->markTestSkipped('No test database');
        $this->native = new NativeAppService(self::$tmpRoot . '/native-' . bin2hex(random_bytes(3)), null, getenv('FORMLOGIC_NODE_BIN') ?: null);
        if (!$this->native->available()) $this->markTestSkipped('No SoftN runtime here');
        $this->ownerId = $this->user();
        $this->otherId = $this->user();
        $this->site = new AppAiSiteSettings(self::$tmpRoot . '/app-ai-' . bin2hex(random_bytes(3)) . '.json');
        $this->site->save(['allowApps' => true, 'pictureModel' => 'flux-test', 'defaults' => ['perAppDay' => 300]]);
        $configured = $this->createMock(AIService::class);
        $configured->method('isConfigured')->willReturn(true);
        $this->ai = new AppAiService(self::$mysql, $this->site, new AppVisitors(self::$mysql, ['secure' => false], new SessionOriginPolicy([])), $this->native, null, $configured);
        $this->controller = new AppAiController(self::$apps, $this->ai, $this->site, null, self::$tmpRoot . '/results');
        $manifest = [
            'name' => 'Logos', 'version' => '0.0.1', 'main' => 'ui/main.ui',
            'server' => ['entry' => 'server/main.logic', 'requires' => ['apiVersion' => 1, 'capabilities' => ['sql']], 'database' => ['kind' => 'private-sqlite', 'migrations' => ['server/migrations/001.sql']],
                'routes' => [['path' => '/api/site/ai/deliver', 'method' => 'POST', 'handler' => 'deliver', 'transaction' => 'write', 'authorization' => 'anonymous']]],
            'formlogicAi' => ['uses' => ['pictures', 'chat'], 'purpose' => 'Draws logos.', 'jobs' => ['table' => 'ai_jobs', 'deliver' => '/api/site/ai/deliver']],
        ];
        $app = self::$apps->createApp(['name' => 'Logos ' . bin2hex(random_bytes(3)), 'settings' => ['softnApp' => true]], $this->ownerId);
        $this->native->install($app['id'], ['version' => 0, 'home' => true, 'access' => 'application', 'assets' => [], 'files' => [
            'manifest.json' => json_encode($manifest, JSON_UNESCAPED_SLASHES), 'ui/main.ui' => '<Stack><Text>Logos</Text></Stack>',
            'server/main.logic' => 'function deliver(req) { return { status: 200, body: {} }; }',
            'server/migrations/001.sql' => 'CREATE TABLE ai_jobs(id TEXT PRIMARY KEY, kind TEXT NOT NULL, prompt TEXT, size TEXT, seed INTEGER, reference TEXT, messages TEXT);',
        ]], 0);
        $this->app = self::$apps->getApp($app['id']);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null || $this->app === []) return;
        $id = $this->app['id'];
        self::$pdo->prepare('DELETE FROM app_ai_counters WHERE app_id IN (?, \'\')')->execute([$id]);
        self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$id]);
        self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?)')->execute([$id]);
        self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$id]);
        self::$pdo->prepare('DELETE FROM app_versions WHERE app_id = ?')->execute([$id]);
        self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$id]);
        foreach ([$this->ownerId, $this->otherId] as $user) self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$user]);
        putenv('TRUSTED_PROXIES');
        unset($_ENV['TRUSTED_PROXIES'], $_SERVER['TRUSTED_PROXIES']);
    }

    private function user(): string
    {
        $id = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")->execute([$id, $id . '@test.local']);
        return $id;
    }

    private function request(string $method, ?string $user, array $body = [], array $server = [], array $headers = []): ServerRequestInterface
    {
        $request = (new ServerRequestFactory())->createServerRequest($method, 'http://127.0.0.1:8300/api', $server + ['REMOTE_ADDR' => '203.0.113.5'])->withParsedBody($body);
        if ($user !== null) $request = $request->withAttribute('userId', $user);
        foreach ($headers as $name => $value) $request = $request->withHeader($name, $value);
        return $request;
    }

    private static function read(\Psr\Http\Message\ResponseInterface $response): array
    {
        return ['status' => $response->getStatusCode(), 'body' => json_decode((string) $response->getBody(), true)];
    }

    public function testTheOwnerSeesTheirAppsAiAndChangesItWithinWhatIsAllowed(): void
    {
        $seen = self::read($this->controller->ownerGet($this->request('GET', $this->ownerId), new Response(), ['id' => $this->app['id']]));
        $this->assertSame(200, $seen['status']);
        $view = $seen['body']['data'];
        $this->assertSame(['pictures', 'chat'], $view['declared']['uses']);
        $this->assertSame(['off', 300, 'off'], [$view['settings']['mode'], $view['settings']['perAppDay'], $view['status']['state']], 'off until the owner turns it on, from the site\'s defaults');
        $this->assertTrue($view['siteOffers']);

        $on = self::read($this->controller->ownerPut($this->request('PUT', $this->ownerId, ['mode' => 'site', 'perIpDay' => 5, 'perAppDay' => 250]), new Response(), ['id' => $this->app['id']]));
        $this->assertSame(200, $on['status'], json_encode($on['body']));
        $this->assertSame(['site', 5, 250, true, 'idle'], [$on['body']['data']['settings']['mode'], $on['body']['data']['settings']['perIpDay'], $on['body']['data']['settings']['perAppDay'], $on['body']['data']['availability']['enabled'], $on['body']['data']['status']['state']]);

        foreach ([
            [['mode' => 'site', 'perAppDay' => 301], 'at most 300'],
            [['mode' => 'everyone'], 'Choose off'],
            [['perIpHour' => -1], 'from 0 to'],
            [['perRequesterDay' => '12'], 'whole number'],
            [['mode' => 'own'], 'linked computers'],
        ] as [$body, $said]) {
            $refused = self::read($this->controller->ownerPut($this->request('PUT', $this->ownerId, $body), new Response(), ['id' => $this->app['id']]));
            $this->assertSame(400, $refused['status'], json_encode($body));
            $this->assertStringContainsString($said, $refused['body']['message']);
        }
        $this->assertSame(['site', 250], [$this->ai->settings($this->app['id'])['mode'], $this->ai->settings($this->app['id'])['perAppDay']], 'nothing refused was saved');

        // Once the site stops offering its AI, an app that had it keeps it; one that never had it cannot start.
        $this->site->save(['allowApps' => false, 'pictureModel' => 'flux-test']);
        $this->assertSame(200, self::read($this->controller->ownerPut($this->request('PUT', $this->ownerId, ['mode' => 'site', 'perAppDay' => 250]), new Response(), ['id' => $this->app['id']]))['status']);
        $this->assertSame('off', self::read($this->controller->ownerGet($this->request('GET', $this->ownerId), new Response(), ['id' => $this->app['id']]))['body']['data']['status']['state']);
    }

    public function testNobodyElseSeesItAndAnAdministratorActingAsTheOwnerOnlyLooks(): void
    {
        $this->assertSame(404, $this->controller->ownerGet($this->request('GET', $this->otherId), new Response(), ['id' => $this->app['id']])->getStatusCode());
        $this->assertSame(404, $this->controller->ownerPut($this->request('PUT', $this->otherId, ['mode' => 'site']), new Response(), ['id' => $this->app['id']])->getStatusCode());
        $this->assertSame(404, $this->controller->ownerGet($this->request('GET', null), new Response(), ['id' => $this->app['id']])->getStatusCode());
        $actingAs = fn(string $method, array $body = []) => $this->request($method, $this->ownerId, $body)->withAttribute('adminActorId', $this->otherId);
        $this->assertSame(200, $this->controller->ownerGet($actingAs('GET'), new Response(), ['id' => $this->app['id']])->getStatusCode());
        $refused = self::read($this->controller->ownerPut($actingAs('PUT', ['mode' => 'site']), new Response(), ['id' => $this->app['id']]));
        $this->assertSame([403, 'acting_as_denied'], [$refused['status'], $refused['body']['code']]);
        $this->assertSame(403, $this->controller->ownerTest($actingAs('POST', ['kind' => 'picture']), new Response(), ['id' => $this->app['id']])->getStatusCode());
        $this->assertSame('off', $this->ai->settings($this->app['id'])['mode']);
    }

    public function testATestIsRefusedWhileTheAiIsOffAndQueuedOnceItIsOn(): void
    {
        $off = self::read($this->controller->ownerTest($this->request('POST', $this->ownerId, ['kind' => 'picture']), new Response(), ['id' => $this->app['id']]));
        $this->assertSame([409, 'ai_unavailable'], [$off['status'], $off['body']['code']]);
        $this->ai->saveSettings($this->app, ['mode' => 'site'], $this->ownerId);
        $started = self::read($this->controller->ownerTest($this->request('POST', $this->ownerId, ['kind' => 'chat']), new Response(), ['id' => $this->app['id']]));
        $this->assertSame(202, $started['status'], json_encode($started['body']));
        $jobId = $started['body']['data']['jobId'];
        $result = self::read($this->controller->ownerTestResult($this->request('GET', $this->ownerId), new Response(), ['id' => $this->app['id'], 'job' => $jobId]));
        $this->assertSame(['status' => 'queued'], $result['body']['data']);
        $this->assertSame(404, $this->controller->ownerTestResult($this->request('GET', $this->otherId), new Response(), ['id' => $this->app['id'], 'job' => $jobId])->getStatusCode());
        $view = $this->ai->ownerView($this->app);
        $this->assertSame([true, 'Test', 'chat'], [$view['log'][0]['test'], $view['log'][0]['requester'], $view['log'][0]['kind']]);
        $this->assertSame('busy', $view['status']['state']);
    }

    public function testTheAdministratorSeesEveryAppAndCanStopOne(): void
    {
        $this->ai->saveSettings($this->app, ['mode' => 'site'], $this->ownerId);
        $seen = self::read($this->controller->adminGet($this->request('GET', $this->otherId), new Response()));
        $listed = array_values(array_filter($seen['body']['data']['apps'], fn($row) => $row['appId'] === $this->app['id']));
        $this->assertSame(['site', false, $this->ownerId . '@test.local'], [$listed[0]['mode'], $listed[0]['blocked'], $listed[0]['ownerEmail']]);
        $this->assertSame('flux-test', $seen['body']['data']['settings']['pictureModel']);

        $stopped = self::read($this->controller->adminBlock($this->request('PUT', $this->otherId, ['blocked' => true, 'reason' => 'Too many complaints']), new Response(), ['id' => $this->app['id']]));
        $this->assertSame(200, $stopped['status']);
        $this->assertSame(['ai_blocked', 'blocked'], [$this->ai->availability($this->app, ['kinds' => ['picture', 'chat'], 'uses' => ['pictures', 'chat']])['reason'], $this->ai->ownerView($this->app)['status']['state']]);
        $this->assertStringContainsString('Too many complaints', $this->ai->ownerView($this->app)['status']['message']);
        $this->controller->adminBlock($this->request('PUT', $this->otherId, ['blocked' => false]), new Response(), ['id' => $this->app['id']]);
        $this->assertTrue($this->ai->availability($this->app, ['kinds' => ['picture', 'chat'], 'uses' => ['pictures', 'chat']])['enabled']);

        $bad = self::read($this->controller->adminPut($this->request('PUT', $this->otherId, ['allowApps' => 'yes']), new Response()));
        $this->assertSame(400, $bad['status']);
        $saved = self::read($this->controller->adminPut($this->request('PUT', $this->otherId, ['allowApps' => true, 'paused' => true, 'pictureModel' => 'flux-3-image-klein', 'siteDay' => 50, 'words' => ['Forbidden']]), new Response()));
        $this->assertSame([true, 'flux-3-image-klein', 50, ['forbidden']], [$saved['body']['data']['settings']['paused'], $saved['body']['data']['settings']['pictureModel'], $saved['body']['data']['settings']['siteDay'], $saved['body']['data']['settings']['words']]);
        $this->assertSame('paused', $this->ai->ownerView($this->app)['status']['state'], 'the site\'s pause stops every app');
        $this->assertSame(404, $this->controller->adminBlock($this->request('PUT', $this->otherId, ['blocked' => true]), new Response(), ['id' => 'no-such-app'])->getStatusCode());
    }

    /** Jobs waiting minutes while no worker runs: bin/app-ai-worker.php is not scheduled, and the administrator is told. */
    public function testWaitingJobsWithNoWorkerRunningAreWarned(): void
    {
        $codes = fn() => array_column(self::read($this->controller->adminGet($this->request('GET', $this->otherId), new Response()))['body']['data']['warnings'], 'code');
        $this->assertNotContains('worker_idle', $codes());
        self::$pdo->prepare("INSERT INTO app_ai_jobs (id, app_id, event_id, app_job_id, requester_kind, requester_id, ip_key, kind, status, created_at) VALUES (?, ?, ?, 'a1', 'visitor', ?, 'abcdefabcdefabcd', 'chat', 'queued', ?)")
            ->execute([bin2hex(random_bytes(16)), $this->app['id'], bin2hex(random_bytes(16)), bin2hex(random_bytes(16)), AppAiService::stamp(time() - 300)]);
        $this->assertContains('worker_idle', $codes(), 'no worker has ever run here');
        @mkdir(self::$tmpRoot . '/results', 0777, true);
        touch(self::$tmpRoot . '/results/.alive');
        $this->assertNotContains('worker_idle', $codes(), 'a worker ran a moment ago: the job waits for its computer');
        touch(self::$tmpRoot . '/results/.alive', time() - 600);
        $this->assertContains('worker_idle', $codes());
    }

    /** Behind Cloudflare with TRUSTED_PROXIES unset, every visitor reads as Cloudflare: the administrator is told. */
    public function testASiteBehindCloudflareWithoutTrustedProxiesIsWarned(): void
    {
        $codes = fn(array $server = [], array $headers = []) => array_column(AppAiController::proxyWarnings($this->request('GET', $this->otherId, [], $server, $headers)), 'code');
        $this->assertSame(['trusted_proxies_unset'], $codes(['REMOTE_ADDR' => '104.16.1.1']));
        $this->assertSame(['trusted_proxies_unset'], $codes(['REMOTE_ADDR' => '2606:4700:10::1']));
        $this->assertSame(['trusted_proxies_unset'], $codes([], ['CF-Connecting-IP' => '198.51.100.7']), 'a local proxy between Cloudflare and PHP');
        $this->assertSame([], $codes(['REMOTE_ADDR' => '203.0.113.5']));
        putenv('TRUSTED_PROXIES=173.245.48.0/20,103.21.244.0/22');
        $this->assertSame([], $codes(['REMOTE_ADDR' => '104.16.1.1']));
        $message = self::read($this->controller->adminGet($this->request('GET', $this->otherId), new Response()));
        $this->assertSame([], array_values(array_filter($message['body']['data']['warnings'], static fn($w) => $w['code'] === 'trusted_proxies_unset')));
        putenv('TRUSTED_PROXIES');
        $warned = self::read($this->controller->adminGet($this->request('GET', $this->otherId, [], ['REMOTE_ADDR' => '172.64.1.9']), new Response()))['body']['data']['warnings'];
        $this->assertStringContainsString('X-Forwarded-For', array_values(array_filter($warned, static fn($w) => $w['code'] === 'trusted_proxies_unset'))[0]['message']);
    }
}

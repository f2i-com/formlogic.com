<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\NativeAppController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AIService;
use FormLogic\Services\AppAiPictures;
use FormLogic\Services\AppAiService;
use FormLogic\Services\AppAiSiteSettings;
use FormLogic\Services\AppAiUpstream;
use FormLogic\Services\AppAiWorker;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\AppVisitors;
use FormLogic\Services\DesktopAiRelayService;
use FormLogic\Services\FlowService;
use FormLogic\Services\FormService;
use FormLogic\Services\NativeAppService;
use FormLogic\Services\NativeRecordEventRouter;
use FormLogic\Services\PlanService;
use FormLogic\Services\RuntimeEngineService;
use FormLogic\Services\SiteAiDesktopSettings;
use FormLogic\Services\SiteDesktopAi;
use FormLogic\Support\DataEncryption;
use FormLogic\Support\SessionOriginPolicy;
use FormLogic\Tests\Support\StubImagesServer;
use PDO;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * App AI's worker, end to end: jobs an app's server asked for go to the site's OAIY (played here by
 * the contract's test desktop, docs/contracts/e2e-envelope-vectors.json, on the real relay) or the
 * .env upstream (a stand-in for Studio's gateway), and what comes back is redrawn and delivered to
 * the app's own /api/site/ route, through the real runner, into the app's own database.
 */
final class AppAiWorkerTest extends TestCase
{
    private const ORIGIN = 'http://127.0.0.1:8300';
    private const IP = '203.0.113.20';
    private const IP_KEY = 'abcdefabcdefabcd';

    private static ?PDO $pdo = null;
    private static ?MySQLConnection $mysql = null;
    private static AppService $apps;
    private static string $tmpRoot = '';
    private static array $vectors = [];
    private static ?StubImagesServer $stub = null;

    private string $adminId = '';
    private NativeAppService $native;
    private AppAiSiteSettings $site;
    private AppVisitors $visitors;
    private AppAiService $ai;
    private DesktopAiRelayService $relay;
    private SiteAiDesktopSettings $computers;
    private SiteDesktopAi $desktop;
    private NativeRecordEventRouter $router;
    private string $results = '';
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
        self::$tmpRoot = sys_get_temp_dir() . '/formlogic-app-ai-worker-' . bin2hex(random_bytes(4));
        mkdir(self::$tmpRoot . '/sqlite', 0777, true);
        self::$apps = new AppService($conn, new FormService($conn, new SQLiteConnection(self::$tmpRoot . '/sqlite')));
        self::$vectors = json_decode((string) file_get_contents(dirname($root, 2) . '/docs/contracts/e2e-envelope-vectors.json'), true, 512, JSON_THROW_ON_ERROR);
        if (function_exists('curl_multi_init') && AppAiPictures::available()) self::$stub = StubImagesServer::start();
    }

    public static function tearDownAfterClass(): void
    {
        self::$stub?->stop();
        self::$stub = null;
        if (self::$tmpRoot !== '' && is_dir(self::$tmpRoot)) self::removeTree(self::$tmpRoot);
    }

    public static function runners(): array
    {
        return ['softn-runner (or Node where none ships)' => ['auto'], 'Node runner.mjs' => ['node']];
    }

    /** The site, its administrator (who owns the apps here, as 5CD's owner does) and their OAIY computer. */
    private function boot(string $runner = 'auto', bool $computer = true): void
    {
        if (self::$pdo === null) $this->markTestSkipped('No test database');
        if (!AppAiPictures::available()) $this->markTestSkipped('No GD here');
        $node = getenv('FORMLOGIC_NODE_BIN') ?: null;
        if ($runner === 'node' && $node === null) $this->markTestSkipped('Set FORMLOGIC_NODE_BIN to run the Node runner');
        $this->native = new NativeAppService(self::$tmpRoot . '/native-' . bin2hex(random_bytes(3)), null, $node, $runner);
        if (!$this->native->available()) $this->markTestSkipped('No SoftN runtime here');
        $this->adminId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, is_admin) VALUES (?, ?, 'x', 'Admin', 1)")->execute([$this->adminId, $this->adminId . '@test.local']);
        $this->site = new AppAiSiteSettings(self::$tmpRoot . '/app-ai-' . bin2hex(random_bytes(3)) . '.json');
        $this->site->save(['allowApps' => true, 'pictureModel' => 'flux-3-image-klein']);
        $this->visitors = new AppVisitors(self::$mysql, ['secure' => false], new SessionOriginPolicy([self::ORIGIN]));
        $this->relay = new DesktopAiRelayService(self::$mysql);
        $this->computers = new SiteAiDesktopSettings(self::$mysql, self::$tmpRoot . '/site-ai-desktop-' . bin2hex(random_bytes(3)) . '.json');
        $this->desktop = new SiteDesktopAi($this->relay, $this->computers);
        if ($computer) {
            $connection = bin2hex(random_bytes(16));
            self::$pdo->prepare("INSERT INTO desktop_connections (id, owner_user_id, device_name, desktop_instance_id, last_seen_at, e2e_public_key) VALUES (?, ?, 'Studio PC', 'inst-site-ai', NOW(), ?)")
                ->execute([$connection, $this->adminId, self::$vectors['desktop']['publicKey']]);
            $this->computers->choose($this->adminId, $connection);
        }
        $configured = $this->createMock(AIService::class);
        $configured->method('isConfigured')->willReturn(true);
        $this->ai = new AppAiService(self::$mysql, $this->site, $this->visitors, $this->native, $this->computers, $configured);
        $this->router = new NativeRecordEventRouter(new FlowService(self::$mysql), $this->ai);
        $this->results = self::$tmpRoot . '/results-' . bin2hex(random_bytes(3));
    }

    private function worker(?DataEncryption $encryption = null, ?AppAiUpstream $env = null): AppAiWorker
    {
        $env ??= new AppAiUpstream(self::$stub !== null ? ['url' => self::$stub->url(), 'key' => '', 'model' => 'stub-chat'] : null);
        return new AppAiWorker(self::$mysql, $this->ai, $this->site, $this->native, $this->router, $this->desktop, $this->computers, $env, $this->results, $encryption);
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
        if ($this->adminId !== '') {
            self::$pdo->prepare('DELETE FROM desktop_ai_frames WHERE request_id IN (SELECT id FROM desktop_ai_requests WHERE owner_user_id = ?)')->execute([$this->adminId]);
            self::$pdo->prepare('DELETE FROM desktop_ai_requests WHERE owner_user_id = ?')->execute([$this->adminId]);
            self::$pdo->prepare('DELETE FROM desktop_connections WHERE owner_user_id = ?')->execute([$this->adminId]);
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->adminId]);
        }
        $this->appIds = [];
        putenv(DataEncryption::KEY_ENV);
        unset($_ENV[DataEncryption::KEY_ENV], $_SERVER[DataEncryption::KEY_ENV]);
    }

    // ------------------------------------------------------------------ the app

    private const SERVER = <<<'JS'
function createJob(req) {
  var body = req.body || {};
  var id = softn.crypto.randomHex(16);
  softn.sql.execute("INSERT INTO ai_jobs(id, kind, prompt, size, seed, reference, messages) VALUES(?,?,?,?,?,?,?)",
    [id, body.kind || "picture", body.prompt || null, body.size || null, body.seed === undefined ? null : body.seed, body.reference || null, body.messages ? JSON.stringify(body.messages) : null]);
  return { status: 201, body: { id: id } };
}
function deliver(req) {
  var b = req.body || {};
  var formlogic = req.context && req.context.formlogic ? req.context.formlogic : {};
  var ai = formlogic.ai || {};
  var tries = softn.sql.first("SELECT COUNT(*) AS n FROM tries", []);
  softn.sql.execute("INSERT INTO tries(job_id, idem) VALUES(?,?)", [String(b.jobId || ""), String((req.headers || {})["idempotency-key"] || "")]);
  var refuse = softn.sql.first("SELECT value FROM settings WHERE name = 'refuse'", []);
  if (refuse && Number(refuse.value) > Number(tries.n)) return { status: 503, body: { error: "busy" } };
  softn.sql.execute("INSERT INTO deliveries(job_id, status, picture, mime, width, height, seed, model, text, code, message, is_delivery) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    [String(b.jobId), String(b.status), b.picture || null, b.mimeType || null, b.width || null, b.height || null,
     b.seed === undefined || b.seed === null ? null : String(b.seed), b.model || null, b.text || null, b.code || null, b.message || null, ai.delivery === true ? 1 : 0]);
  return { status: 200, body: { ok: true } };
}
function ping(req) { return { status: 200, body: { ok: true } }; }
JS;

    private function project(): array
    {
        $manifest = [
            'name' => 'Logo maker', 'version' => '0.0.1', 'main' => 'ui/main.ui',
            'server' => [
                'entry' => 'server/main.logic',
                'requires' => ['apiVersion' => 1, 'capabilities' => ['sql', 'crypto', 'trusted-client-ip']],
                'database' => ['kind' => 'private-sqlite', 'migrations' => ['server/migrations/001.sql']],
                'routes' => [
                    ['path' => '/api/jobs', 'method' => 'POST', 'handler' => 'createJob', 'transaction' => 'write', 'authorization' => 'anonymous'],
                    ['path' => '/api/ping', 'method' => 'GET', 'handler' => 'ping', 'transaction' => 'read', 'authorization' => 'anonymous'],
                    ['path' => '/api/site/ai/deliver', 'method' => 'POST', 'handler' => 'deliver', 'transaction' => 'write', 'authorization' => 'anonymous'],
                ],
            ],
            'formlogicAi' => ['uses' => ['pictures', 'picture-edits', 'chat'], 'purpose' => 'Draws logos.', 'jobs' => ['table' => 'ai_jobs', 'deliver' => '/api/site/ai/deliver']],
        ];
        return ['version' => 0, 'home' => true, 'access' => 'application', 'assets' => [], 'files' => [
            'manifest.json' => json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES),
            'ui/main.ui' => '<Stack><Text>Logos</Text></Stack>',
            'server/main.logic' => self::SERVER,
            'server/migrations/001.sql' => "CREATE TABLE ai_jobs(id TEXT PRIMARY KEY, kind TEXT NOT NULL, prompt TEXT, size TEXT, seed INTEGER, reference TEXT, messages TEXT);\n"
                . "CREATE TABLE deliveries(job_id TEXT, status TEXT, picture TEXT, mime TEXT, width INTEGER, height INTEGER, seed TEXT, model TEXT, text TEXT, code TEXT, message TEXT, is_delivery INTEGER);\n"
                . "CREATE TABLE tries(job_id TEXT, idem TEXT);\n"
                . "CREATE TABLE settings(name TEXT PRIMARY KEY, value TEXT);",
        ]];
    }

    /** A published app, owned by the administrator, its AI on the site's. */
    private function app(): array
    {
        $app = self::$apps->createApp(['name' => 'Logos ' . bin2hex(random_bytes(3)), 'settings' => ['softnApp' => true]], $this->adminId);
        $this->appIds[] = $app['id'];
        $this->native->install($app['id'], $this->project(), 0);
        self::$pdo->prepare("UPDATE apps SET status = 'published' WHERE id = ?")->execute([$app['id']]);
        self::$pdo->prepare("INSERT INTO app_ai_settings (app_id, mode) VALUES (?, 'site')")->execute([$app['id']]);
        $this->native->request($app['id'], ['method' => 'GET', 'path' => '/api/ping', 'query' => (object) [], 'body' => (object) [], 'headers' => (object) [], 'client_ip' => '127.0.0.1', 'photos' => false]);
        return self::$apps->getApp($app['id']);
    }

    /** A job as AppAiService::capture queues one, counted as it counts one. Answers its id. */
    private function queue(string $appId, string $kind = 'picture', array $fields = [], ?string $visitor = null, ?string $createdAt = null): string
    {
        $id = bin2hex(random_bytes(16));
        $visitor ??= bin2hex(random_bytes(16));
        $prompt = $kind === 'chat' ? json_encode([['role' => 'user', 'content' => $fields['say'] ?? 'Say hello.']]) : ($fields['prompt'] ?? 'A coffee cup logo, flat colours');
        $available = $this->ai->availability(['id' => $appId, 'ownerId' => $this->adminId], self::DECLARED);
        self::$pdo->prepare(
            'INSERT INTO app_ai_jobs (id, app_id, event_id, app_job_id, requester_kind, requester_id, ip_key, kind, status, source, target, prompt, prompt_sha256, size, seed, reference, counted_day, counted_hour, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )->execute([$id, $appId, bin2hex(random_bytes(16)), 'job-' . substr($id, 0, 8), 'visitor', $visitor, self::IP_KEY, $kind, 'queued',
            $available['source'] . '-' . ($available['target'] === 'env' ? 'env' : 'oaiy'), $available['target'], $prompt, hash('sha256', (string) $prompt),
            $kind === 'chat' ? null : ($fields['size'] ?? '1024x1024'), $fields['seed'] ?? null, $fields['reference'] ?? null, gmdate('Y-m-d'), gmdate('Y-m-d\TH'),
            $createdAt ?? AppAiService::stamp(microtime(true))]);
        foreach ([['requester', 'v:' . $visitor, gmdate('Y-m-d')], ['ip', self::IP_KEY, gmdate('Y-m-d')], ['ip-hour', self::IP_KEY, gmdate('Y-m-d\TH')], ['app', '', gmdate('Y-m-d')]] as [$scope, $subject, $period]) {
            self::$pdo->prepare('INSERT INTO app_ai_counters (app_id, scope, subject, period, used) VALUES (?, ?, ?, ?, 1) ON DUPLICATE KEY UPDATE used = used + 1')->execute([$appId, $scope, $subject, $period]);
        }
        self::$pdo->prepare("INSERT INTO app_ai_counters (app_id, scope, subject, period, used) VALUES ('', 'site', '', ?, 1) ON DUPLICATE KEY UPDATE used = used + 1")->execute([gmdate('Y-m-d')]);
        return $id;
    }

    private function job(string $id): array
    {
        $statement = self::$pdo->prepare('SELECT * FROM app_ai_jobs WHERE id = ?');
        $statement->execute([$id]);
        return (array) $statement->fetch(PDO::FETCH_ASSOC);
    }

    private function used(string $appId, string $scope = 'app', string $subject = ''): int
    {
        $statement = self::$pdo->prepare('SELECT used FROM app_ai_counters WHERE app_id = ? AND scope = ? AND subject = ? AND period = ?');
        $statement->execute([$appId, $scope, $subject, $scope === 'ip-hour' ? gmdate('Y-m-d\TH') : gmdate('Y-m-d')]);
        return (int) $statement->fetchColumn();
    }

    /** Rows of the app's own database. */
    private function appRows(string $appId, string $sql): array
    {
        return $this->native->withDatabase($appId, static fn(PDO $db) => $db->query($sql)->fetchAll(PDO::FETCH_ASSOC));
    }

    /** OAIY, played by the test desktop: claims the next turn (of $kind) and opens it. [requestId, turn, pair] */
    private function oaiyTakes(?string $kind = null): array
    {
        foreach ($this->relay->listPending($this->adminId, null, 10, 'inst-site-ai') as $row) {
            if ($kind !== null && $row['kind'] !== $kind) continue;
            $claimed = $this->relay->claim($row['requestId'], $this->adminId, ['instanceId' => 'inst-site-ai']);
            $pair = sodium_crypto_box_keypair_from_secretkey_and_publickey(base64_decode(self::$vectors['desktop']['secretKey'], true), base64_decode($claimed['ephPub'], true));
            return [$claimed['requestId'], SiteDesktopAi::open($claimed['envelope'], 0, 0, $pair), $pair];
        }
        self::fail('nothing waits for OAIY' . ($kind !== null ? " of kind {$kind}" : ''));
    }

    /** OAIY sends frames (by counter), then completes the turn as $status (null: not yet). */
    private function oaiySends(string $id, string $pair, array $frames, ?string $status = 'done'): void
    {
        foreach ($frames as $counter => $frame) $this->relay->appendFrame($id, $this->adminId, SiteDesktopAi::seal($frame, 1, $counter, $pair), 'inst-site-ai');
        if ($status !== null) $this->relay->complete($id, $this->adminId, ['status' => $status, 'instanceId' => 'inst-site-ai']);
    }

    private static function jpeg(int $width, int $height, bool $progressive = false): string
    {
        $image = imagecreatetruecolor($width, $height);
        imagefill($image, 0, 0, imagecolorallocate($image, 250, 240, 220));
        imagefilledellipse($image, intdiv($width, 2), intdiv($height, 2), intdiv($width, 2), intdiv($height, 2), imagecolorallocate($image, 120, 60, 20));
        imageinterlace($image, $progressive);
        ob_start();
        imagejpeg($image, null, 90);
        return (string) ob_get_clean();
    }

    private static function pictureFrame(string $bytes, int $seed = 1873465): array
    {
        $info = (array) getimagesizefromstring($bytes);
        return ['v' => 1, 'type' => 'final', 'kind' => 'final', 'picture' => ['mimeType' => 'image/jpeg', 'data' => base64_encode($bytes), 'width' => $info[0], 'height' => $info[1], 'seed' => $seed, 'model' => 'flux-3-image-klein']];
    }

    private const PROGRESS = ['v' => 1, 'type' => 'progress', 'kind' => 'progress', 'progress' => 'drawing'];

    // ------------------------------------------------------------------ the tests

    /** A visitor's picture, from their request to the app's database: the whole lane, on both runners. */
    #[DataProvider('runners')]
    public function testAVisitorsPictureGoesToTheSitesOaiyAndComesBackToTheApp(string $runner): void
    {
        $this->boot($runner);
        $app = $this->app();
        // The visitor's request, as the app's page sends it: captured from the app's own write.
        $controller = new NativeAppController(self::$apps, $this->createMock(AppUserService::class), $this->native, $this->createMock(PlanService::class), new FlowService(self::$mysql), $this->engines(), null, null, null, null, $this->router, $this->visitors, $this->ai);
        $payload = ['method' => 'POST', 'path' => '/api/jobs', 'query' => [], 'headers' => [], 'body' => ['prompt' => 'A coffee cart logo called Five Cents', 'size' => '1024x768', 'seed' => 9007199254740991]];
        $request = (new ServerRequestFactory())->createServerRequest('POST', self::ORIGIN . '/api/app/' . $app['slug'] . '/native/request', ['REMOTE_ADDR' => self::IP])
            ->withHeader('Host', '127.0.0.1:8300')->withHeader('Content-Type', 'application/json')->withHeader(AppVisitors::HEADER, '1')->withHeader('Origin', self::ORIGIN)
            ->withParsedBody($payload);
        $request->getBody()->write((string) json_encode($payload));
        $answer = json_decode((string) $controller->runtime($request, new Response(), ['slug' => $app['slug']])->getBody(), true);
        $appJobId = (string) ($answer['result']['body']['id'] ?? '');
        $jobs = self::$pdo->query('SELECT id FROM app_ai_jobs WHERE app_id = ' . self::$pdo->quote($app['id']))->fetchAll(PDO::FETCH_COLUMN);
        $this->assertCount(1, $jobs, json_encode($answer));
        $id = (string) $jobs[0];

        $worker = $this->worker();
        $this->assertSame(1, $worker->tick()['sent']);
        $job = $this->job($id);
        $this->assertSame(['running', 'site-oaiy', 'flux-3-image-klein', 1], [$job['status'], $job['source'], $job['model'], (int) $job['attempts']]);
        [$relayId, $turn, $pair] = $this->oaiyTakes(DesktopAiRelayService::PICTURE_KIND);
        $this->assertSame(['v', 'kind', 'providerId', 'requestId', 'model', 'prompt', 'size', 'seed', 'reference', 'incognito'], array_keys($turn), 'the fields of contract §1, and no chat thread or tool grant');
        $this->assertSame(['image', 'oaiy-engine', 'fl-ai-job-' . $id, 'flux-3-image-klein', 'A coffee cart logo called Five Cents', '1024x768', 9007199254740991, null, true],
            [$turn['kind'], $turn['providerId'], $turn['requestId'], $turn['model'], $turn['prompt'], $turn['size'], $turn['seed'], $turn['reference'], $turn['incognito']]);
        $row = self::$pdo->query('SELECT source, requesting_user_id FROM desktop_ai_requests WHERE id = ' . self::$pdo->quote($relayId))->fetch(PDO::FETCH_ASSOC);
        $this->assertSame(['app-ai', $this->adminId], [$row['source'], $row['requesting_user_id']], 'queued as the app\'s owner, outside their own two places');

        // Still drawing: a progress frame, and nothing to deliver yet.
        $this->oaiySends($relayId, $pair, [0 => self::PROGRESS], null);
        $this->assertSame(['collected' => 0, 'delivered' => 0], array_intersect_key($worker->tick(), ['collected' => 0, 'delivered' => 0]));
        $this->assertSame('running', $this->job($id)['status']);
        // Drawn: a progressive JPEG comes back, and the app gets a baseline one in the same pass.
        $this->oaiySends($relayId, $pair, [1 => self::pictureFrame(self::jpeg(1024, 768, true), 424242)]);
        $done = $worker->tick();
        $this->assertSame([1, 1], [$done['collected'], $done['delivered']]);

        $delivered = $this->appRows($app['id'], 'SELECT * FROM deliveries');
        $this->assertCount(1, $delivered);
        $this->assertSame([$appJobId, 'done', 'image/jpeg', 1024, 768, '424242', 'flux-3-image-klein', 1],
            [$delivered[0]['job_id'], $delivered[0]['status'], $delivered[0]['mime'], (int) $delivered[0]['width'], (int) $delivered[0]['height'], $delivered[0]['seed'], $delivered[0]['model'], (int) $delivered[0]['is_delivery']]);
        $bytes = (string) base64_decode(substr((string) $delivered[0]['picture'], strlen('data:image/jpeg;base64,')), true);
        $this->assertTrue(AppAiPictures::isBaselineJpeg($bytes), 'redrawn, never progressive');
        $this->assertSame(['fl-ai-' . $id], array_column($this->appRows($app['id'], 'SELECT idem FROM tries'), 'idem'));
        $job = $this->job($id);
        $this->assertSame(['done', null, null], [$job['status'], $job['result_path'], $job['channel']]);
        $this->assertNotNull($job['delivered_at']);
        $this->assertSame([], glob($this->results . '/*.json') ?: [], 'the result leaves this server once delivered');
        $this->assertSame(1, $this->used($app['id']), 'a delivered job stays counted');
    }

    public function testAPictureAndAChatRunSideBySideAndASecondPictureWaitsItsTurn(): void
    {
        $this->boot();
        $app = $this->app();
        $first = $this->queue($app['id'], 'picture');
        $second = $this->queue($app['id'], 'picture');
        $chat = $this->queue($app['id'], 'chat', ['say' => 'Name my cafe.']);
        $worker = $this->worker();
        $this->assertSame(2, $worker->tick()['sent'], 'one picture and one chat');
        $this->assertSame(['running', 'queued', 'running'], [$this->job($first)['status'], $this->job($second)['status'], $this->job($chat)['status']]);

        [$chatTurn, $chatBody, $chatPair] = $this->oaiyTakes('chat');
        $this->assertSame([['role' => 'user', 'content' => 'Name my cafe.']], $chatBody['messages']);
        $this->assertArrayNotHasKey('model', $chatBody, 'OAIY\'s own engine answers with its own model');
        [$pictureTurn, , $picturePair] = $this->oaiyTakes(DesktopAiRelayService::PICTURE_KIND);
        $this->oaiySends($chatTurn, $chatPair, [0 => ['v' => 1, 'kind' => 'delta', 'delta' => 'Five '], 1 => ['v' => 1, 'kind' => 'delta', 'delta' => 'Cents Cafe'], 2 => ['v' => 1, 'kind' => 'final']]);
        $this->assertSame(1, $worker->tick()['delivered'], 'the chat is answered while the picture is drawn');
        $this->assertSame('Five Cents Cafe', $this->appRows($app['id'], "SELECT text FROM deliveries")[0]['text']);
        $this->assertSame('queued', $this->job($second)['status'], 'one picture at a time on a computer');

        $this->oaiySends($pictureTurn, $picturePair, [0 => self::pictureFrame(self::jpeg(512, 512))]);
        $worker->tick();
        $this->assertSame('done', $this->job($first)['status']);
        $worker->tick();
        $this->assertSame('running', $this->job($second)['status'], 'the next picture goes once the first is done');
    }

    public function testOaiysErrorsAreToldToTheAppAndGiveTheUseBack(): void
    {
        $this->boot();
        $app = $this->app();
        $id = $this->queue($app['id'], 'picture');
        $this->assertSame(1, $this->used($app['id']));
        $worker = $this->worker();
        $worker->tick();
        [$turn, , $pair] = $this->oaiyTakes();
        $this->oaiySends($turn, $pair, [0 => ['v' => 1, 'type' => 'final', 'kind' => 'final', 'error' => ['code' => 'model_disabled', 'message' => 'OAIY\'s engines: image model flux-3-image-klein is set up in OAIY Engines, but its files are not on this computer']]], 'failed');
        $worker->tick();
        $job = $this->job($id);
        $this->assertSame(['failed', 'model_disabled', 1], [$job['status'], $job['code'], (int) $job['refunded']]);
        $this->assertSame(0, $this->used($app['id']), 'its use is given back');
        $delivered = $this->appRows($app['id'], 'SELECT status, code, message FROM deliveries')[0];
        $this->assertSame(['failed', 'model_disabled'], [$delivered['status'], $delivered['code']]);
        $this->assertStringContainsString('files are not on this computer', (string) $delivered['message']);
        $this->assertSame(['model_disabled'], array_column(array_filter($this->ai->adminWarnings(), static fn($w) => $w['code'] === 'model_disabled'), 'code'), 'the administrator is told');

        // Studio's queue full: the job waits and is sent again, not failed.
        $busy = $this->queue($app['id'], 'picture');
        $worker->tick();
        [$turn, , $pair] = $this->oaiyTakes();
        $this->oaiySends($turn, $pair, [0 => ['v' => 1, 'type' => 'final', 'kind' => 'final', 'error' => ['code' => 'busy', 'message' => 'the media queue is full']]], 'failed');
        $worker->tick();
        $job = $this->job($busy);
        $this->assertSame(['queued', null], [$job['status'], $job['relay_id']]);
        $this->assertGreaterThan(gmdate('Y-m-d H:i:s', time() + 20), (string) $job['next_attempt_at']);
    }

    /** A turn nobody took in time, or one gone silent, is sent once more; lost twice, the job fails. */
    public function testALostTurnIsSentOnceMoreThenFails(): void
    {
        $this->boot();
        $app = $this->app();
        $id = $this->queue($app['id'], 'picture');
        $worker = $this->worker();
        $worker->tick();
        self::$pdo->prepare("UPDATE desktop_ai_requests SET expires_at = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE owner_user_id = ?")->execute([$this->adminId]);
        $this->relay->expireStale($this->adminId);
        $worker->tick();
        $job = $this->job($id);
        $this->assertSame(['queued', 1, null], [$job['status'], (int) $job['attempts'], $job['relay_id']], 'never taken: it waits to be sent again');
        $worker->tick();
        $job = $this->job($id);
        $this->assertSame(['running', 2], [$job['status'], (int) $job['attempts']], 'and is, once');
        // Claimed, then silent for five minutes: the relay lets it go, and the job has had its two.
        $this->oaiyTakes();
        self::$pdo->prepare("UPDATE desktop_ai_requests SET claimed_at = DATE_SUB(NOW(), INTERVAL 400 SECOND) WHERE owner_user_id = ? AND status = 'claimed'")->execute([$this->adminId]);
        $this->relay->expireStale($this->adminId);
        $worker->tick();
        $job = $this->job($id);
        $this->assertSame(['failed', 'timeout', 1], [$job['status'], $job['code'], (int) $job['refunded']]);
        $this->assertSame('failed', $this->appRows($app['id'], 'SELECT status FROM deliveries')[0]['status']);
    }

    /** A worker that stops mid-picture leaves nothing behind: the next carries on from the job's row, its key sealed. */
    public function testAnotherWorkerCarriesOnWhereOneStopped(): void
    {
        $this->boot();
        $app = $this->app();
        putenv(DataEncryption::KEY_ENV . '=' . DataEncryption::generateKey());
        $id = $this->queue($app['id'], 'picture');
        $this->worker(DataEncryption::fromEnvironment())->tick();
        $channel = (string) $this->job($id)['channel'];
        $this->assertTrue(DataEncryption::isSealed($channel), 'the turn\'s key is sealed with the site\'s data key');
        [$turn, , $pair] = $this->oaiyTakes();
        $this->oaiySends($turn, $pair, [0 => self::pictureFrame(self::jpeg(256, 256))]);
        $this->assertSame(1, $this->worker(DataEncryption::fromEnvironment())->tick()['delivered'], 'a new worker reads the answer');
        $this->assertSame('done', $this->job($id)['status']);
    }

    public function testAnOfflineComputerKeepsJobsWaitingUntilTheyRunOut(): void
    {
        $this->boot();
        $app = $this->app();
        self::$pdo->prepare('UPDATE desktop_connections SET last_seen_at = NOW() - INTERVAL 10 MINUTE WHERE owner_user_id = ?')->execute([$this->adminId]);
        $id = $this->queue($app['id'], 'picture');
        $worker = $this->worker();
        $this->assertSame(0, $worker->tick()['sent']);
        $this->assertSame('queued', $this->job($id)['status']);
        $this->assertSame('offline', $this->ai->ownerView($app)['status']['state']);
        self::$pdo->prepare('UPDATE app_ai_jobs SET created_at = ? WHERE id = ?')->execute([AppAiService::stamp(time() - AppAiWorker::QUEUED_EXPIRY - 60), $id]);
        $this->assertSame(1, $worker->tick()['expired']);
        $job = $this->job($id);
        $this->assertSame(['failed', 'expired', 1], [$job['status'], $job['code'], (int) $job['refunded']]);
        $this->assertSame('expired', $this->appRows($app['id'], 'SELECT code FROM deliveries')[0]['code']);
    }

    public function testFiveFailuresInARowRestTheAppsAi(): void
    {
        $this->boot();
        $app = $this->app();
        $worker = $this->worker();
        for ($i = 0; $i < AppAiWorker::BREAKER_FAILURES; $i++) {
            $this->queue($app['id'], 'picture');
            $worker->tick();
            [$turn, , $pair] = $this->oaiyTakes();
            $this->oaiySends($turn, $pair, [0 => ['v' => 1, 'type' => 'final', 'kind' => 'final', 'error' => ['code' => 'engine_failed', 'message' => 'the engines are not running']]], 'failed');
            $worker->tick();
        }
        $settings = $this->ai->settings($app['id']);
        $this->assertNotNull($settings['pausedUntil']);
        $this->assertSame('ai_resting', $this->ai->availability($app, self::DECLARED)['reason']);
        $next = $this->queue($app['id'], 'picture');
        $worker->tick();
        $this->assertSame(['failed', 'ai_unavailable'], [$this->job($next)['status'], $this->job($next)['code']]);
    }

    /** An app that is busy is asked again with the same key, until it takes the result. */
    public function testABusyAppIsAskedAgainWithTheSameKey(): void
    {
        $this->boot();
        $app = $this->app();
        $this->native->withDatabase($app['id'], static fn(PDO $db) => $db->exec("INSERT INTO settings(name, value) VALUES('refuse', '2')"));
        $id = $this->queue($app['id'], 'chat');
        $worker = $this->worker();
        $worker->tick();
        [$turn, , $pair] = $this->oaiyTakes('chat');
        $this->oaiySends($turn, $pair, [0 => ['v' => 1, 'kind' => 'final', 'completion' => 'Hi there']]);
        $worker->tick();
        $job = $this->job($id);
        $this->assertSame(['delivering', 1], [$job['status'], (int) $job['delivery_attempts']]);
        $this->assertGreaterThan(gmdate('Y-m-d H:i:s'), (string) $job['next_attempt_at'], 'asked again later');
        for ($i = 0; $i < 2; $i++) {
            self::$pdo->prepare('UPDATE app_ai_jobs SET next_attempt_at = ? WHERE id = ?')->execute([AppAiService::stamp(time() - 1), $id]);
            $worker->tick();
        }
        $this->assertSame('done', $this->job($id)['status']);
        $tries = $this->appRows($app['id'], 'SELECT idem FROM tries');
        $this->assertSame(array_fill(0, 3, 'fl-ai-' . $id), array_column($tries, 'idem'));
        $this->assertSame('Hi there', $this->appRows($app['id'], 'SELECT text FROM deliveries')[0]['text']);
    }

    /** The .env upstream: a picture too large to send as it came is redrawn under 1.5 MB, and the app takes all of it. */
    #[DataProvider('runners')]
    public function testTheEnvUpstreamsPictureIsHeldToTheCapAndTheAppTakesItWhole(string $runner): void
    {
        $this->boot($runner, false);
        if (self::$stub === null) $this->markTestSkipped('Needs curl');
        self::$stub->clear();
        $app = $this->app();
        $big = $this->queue($app['id'], 'picture', ['prompt' => '[big] A noisy texture', 'seed' => 77]);
        $edit = $this->queue($app['id'], 'edit', ['prompt' => '[jpeg] Make it warmer', 'reference' => 'data:image/jpeg;base64,' . base64_encode(self::jpeg(1600, 1200))]);
        $chat = $this->queue($app['id'], 'chat');
        $this->assertSame('env', $this->job($big)['target']);
        $worker = $this->worker();
        $deadline = microtime(true) + 60;
        while (microtime(true) < $deadline && count(array_filter([$big, $edit, $chat], fn($id) => $this->job($id)['status'] === 'done')) < 3) {
            $worker->tick();
        }
        $this->assertSame(['done', 'done', 'done'], [$this->job($big)['status'], $this->job($edit)['status'], $this->job($chat)['status']]);
        $rows = [];
        foreach ($this->appRows($app['id'], 'SELECT job_id, picture, mime, width, seed, text FROM deliveries') as $row) $rows[$row['job_id']] = $row;
        $picture = $rows['job-' . substr($big, 0, 8)];
        $this->assertSame(['image/jpeg', 1024, '77'], [$picture['mime'], (int) $picture['width'], $picture['seed']]);
        $this->assertLessThanOrEqual(AppAiPictures::MAX_DATA_URL, strlen((string) $picture['picture']));
        $this->assertGreaterThan(500000, strlen((string) $picture['picture']), 'a picture near the cap reaches the app whole');
        $this->assertSame('Hello from the stub.', $rows['job-' . substr($chat, 0, 8)]['text']);
        $sent = self::$stub->requests();
        $edits = array_values(array_filter($sent, static fn($r) => ($r['body']['prompt'] ?? '') === '[jpeg] Make it warmer'));
        $this->assertCount(1, $edits);
        $this->assertStringStartsWith('data:image/jpeg;base64,', $edits[0]['body']['images'][0]['prefix']);
        $this->assertLessThanOrEqual((int) floor(AppAiPictures::MAX_REFERENCE_BYTES * 4 / 3) + 23, $edits[0]['body']['images'][0]['length']);
        foreach ($sent as $request) {
            if ($request['path'] === '/v1/images/generations') $this->assertSame([true, '1'], [$request['body']['incognito'] ?? null, $request['headers']['x-oaiy-incognito'] ?? null]);
        }
    }

    /** An owner's test runs like any job, counts in the app's day, and is kept for them: never delivered to the app. */
    public function testAnOwnersTestIsKeptForThemAndNeverDelivered(): void
    {
        $this->boot('auto', false);
        if (self::$stub === null) $this->markTestSkipped('Needs curl');
        $app = $this->app();
        $id = $this->ai->queueTest($app, 'picture');
        $this->assertSame(['queued', 'test', '512x512'], [$this->job($id)['status'], $this->job($id)['requester_kind'], $this->job($id)['size']]);
        try {
            $this->ai->queueTest($app, 'picture');
            $this->fail('two tests at once');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('already running', $e->getMessage());
        }
        $worker = $this->worker();
        $deadline = microtime(true) + 30;
        while (microtime(true) < $deadline && $this->job($id)['status'] !== 'done') $worker->tick();
        $result = $this->ai->testResult($app['id'], $id, $this->results);
        $this->assertSame('done', $result['status']);
        $this->assertStringStartsWith('data:image/png;base64,', $result['picture']);
        $this->assertIsFloat($result['seconds']);
        $this->assertSame([], $this->appRows($app['id'], 'SELECT * FROM deliveries'), 'never delivered to the app');
        $this->assertSame([1, 0], [$this->used($app['id']), $this->used($app['id'], 'requester', 'v:' . $this->adminId)]);
        $this->assertNull($this->ai->testResult($app['id'], bin2hex(random_bytes(16)), $this->results));
        // An hour on, its picture is no longer kept.
        self::$pdo->prepare('UPDATE app_ai_jobs SET finished_at = ? WHERE id = ?')->execute([AppAiService::stamp(time() - 3700), $id]);
        $this->assertSame(1, $this->ai->sweep($this->results)['filesRemoved']);
        $this->assertSame('failed', $this->ai->testResult($app['id'], $id, $this->results)['status']);
    }

    /** Turns are fair: an app that has been served waits behind one that has not, whatever came first. */
    public function testTurnsAreFairBetweenApps(): void
    {
        $this->boot('auto', false);
        if (self::$stub === null) $this->markTestSkipped('Needs curl');
        $busy = $this->app();
        $quiet = $this->app();
        $visitor = bin2hex(random_bytes(16));
        $a1 = $this->queue($busy['id'], 'chat', ['say' => '[slow:1] one'], $visitor);
        $a2 = $this->queue($busy['id'], 'chat', ['say' => '[slow:1] two'], $visitor);
        $b1 = $this->queue($quiet['id'], 'chat', ['say' => '[slow:1] three']);
        $this->worker()->tick();
        $this->assertNotNull($this->job($a1)['started_at']);
        $this->assertNotNull($this->job($b1)['started_at'], 'the other app goes before this app\'s second');
        $this->assertNull($this->job($a2)['started_at']);
        sleep(2);
    }

    private function engines(): RuntimeEngineService
    {
        $engines = $this->createMock(RuntimeEngineService::class);
        $engines->method('effective')->willReturn(['id' => 'zipp-web-python', 'requested' => 'zipp-web-python', 'stored' => null, 'revision' => '0123456789abcdef']);
        return $engines;
    }

    private static function removeTree(string $path): void
    {
        if (!is_dir($path)) {
            @unlink($path);
            return;
        }
        foreach (new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($path, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST) as $entry) {
            $entry->isDir() && !$entry->isLink() ? @rmdir($entry->getPathname()) : @unlink($entry->getPathname());
        }
        @rmdir($path);
    }

    /** What the test app declares, as AppFormlogicManifest::ai() reads it. */
    private const DECLARED = ['uses' => ['pictures', 'picture-edits', 'chat'], 'kinds' => ['picture', 'edit', 'chat'], 'purpose' => 'Draws logos.', 'table' => 'ai_jobs', 'deliver' => '/api/site/ai/deliver'];
}

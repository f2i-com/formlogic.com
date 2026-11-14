<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\AppAiController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AIService;
use FormLogic\Services\AppAiPictures;
use FormLogic\Services\AppAiService;
use FormLogic\Services\AppAiSiteSettings;
use FormLogic\Services\AppService;
use FormLogic\Services\AppVisitors;
use FormLogic\Services\FormService;
use FormLogic\Services\NativeAppService;
use FormLogic\Services\SiteAiDesktopSettings;
use FormLogic\Support\SessionOriginPolicy;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * The administrator's setup checklist for App AI (AppAiController::adminGet's `setup`) and its test
 * (POST /api/admin/app-ai/test): where the site's AI runs, what apps on it would get, and a real job
 * that is no app's. The worker's side of the test is in AppAiWorkerTest.
 */
final class AppAiSetupTest extends TestCase
{
    private static ?PDO $pdo = null;
    private static ?MySQLConnection $mysql = null;
    private static AppService $apps;
    private static string $tmpRoot = '';

    private string $adminId = '';
    private AppAiSiteSettings $site;
    private SiteAiDesktopSettings $computers;
    private AppAiService $ai;
    private AppAiController $controller;
    private string $results = '';
    /** The server's own provider: named in its settings, and the Site AI switch. */
    private bool $named = false;
    private bool $switch = false;
    /** The server code's fingerprint as the web reads it on disk. */
    private string $code = 'code-1';

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
        self::$tmpRoot = sys_get_temp_dir() . '/formlogic-app-ai-setup-' . bin2hex(random_bytes(4));
        mkdir(self::$tmpRoot . '/sqlite', 0777, true);
        self::$apps = new AppService($conn, new FormService($conn, new SQLiteConnection(self::$tmpRoot . '/sqlite')));
    }

    protected function setUp(): void
    {
        if (self::$pdo === null) $this->markTestSkipped('No test database');
        if (!AppAiPictures::available()) $this->markTestSkipped('No GD here');
        $this->adminId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, is_admin) VALUES (?, ?, 'x', 'Admin', 1)")->execute([$this->adminId, $this->adminId . '@test.local']);
        // The site's tests are the whole site's: none left by another test may be read as this one's.
        self::$pdo->exec('DELETE FROM app_ai_jobs WHERE app_id IS NULL');
        $this->site = new AppAiSiteSettings(self::$tmpRoot . '/app-ai-' . bin2hex(random_bytes(3)) . '.json');
        $this->computers = new SiteAiDesktopSettings(self::$mysql, self::$tmpRoot . '/site-ai-' . bin2hex(random_bytes(3)) . '.json');
        $this->named = false;
        $this->switch = false;
        $provider = $this->createMock(AIService::class);
        $provider->method('envProvided')->willReturnCallback(fn(): bool => $this->named);
        $provider->method('siteAiSwitch')->willReturnCallback(fn(): bool => $this->switch);
        $provider->method('isConfigured')->willReturnCallback(fn(): bool => $this->named && $this->switch);
        $this->ai = new AppAiService(self::$mysql, $this->site, new AppVisitors(self::$mysql, ['secure' => false], new SessionOriginPolicy([])), new NativeAppService(self::$tmpRoot . '/native'), $this->computers, $provider);
        $this->results = self::$tmpRoot . '/results-' . bin2hex(random_bytes(3));
        $this->code = 'code-1';
        $this->controller = new AppAiController(self::$apps, $this->ai, $this->site, null, $this->results, null, fn(): string => $this->code);
    }

    /** A worker's heartbeat: it made a pass $secondsAgo, running the code $fingerprint names. */
    private function workerRuns(string $fingerprint = 'code-1', string $mode = 'watch', int $secondsAgo = 1): void
    {
        @mkdir($this->results, 0777, true);
        file_put_contents($this->results . '/.alive', json_encode(['fingerprint' => $fingerprint, 'mode' => $mode, 'startedAt' => time() - 600]));
        touch($this->results . '/.alive', time() - $secondsAgo);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null || $this->adminId === '') return;
        self::$pdo->prepare('DELETE FROM app_ai_jobs WHERE app_id IS NULL AND requester_id = ?')->execute([$this->adminId]);
        self::$pdo->prepare('DELETE FROM desktop_connections WHERE owner_user_id = ?')->execute([$this->adminId]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->adminId]);
    }

    private function request(string $method, array $body = []): ServerRequestInterface
    {
        return (new ServerRequestFactory())->createServerRequest($method, 'http://127.0.0.1:8300/api', ['REMOTE_ADDR' => '203.0.113.5'])->withParsedBody($body)->withAttribute('userId', $this->adminId);
    }

    private static function read(\Psr\Http\Message\ResponseInterface $response): array
    {
        return ['status' => $response->getStatusCode(), 'body' => json_decode((string) $response->getBody(), true)];
    }

    private function checklist(): array
    {
        return self::read($this->controller->adminGet($this->request('GET'), new Response()))['body']['data']['setup'];
    }

    /** One of the administrator's linked computers, with a published key. */
    private function computer(string $name = 'Studio PC', bool $online = true): string
    {
        $id = bin2hex(random_bytes(16));
        $when = $online ? 'NOW()' : 'NOW() - INTERVAL 10 MINUTE';
        self::$pdo->prepare('INSERT INTO desktop_connections (id, owner_user_id, device_name, desktop_instance_id, last_seen_at, ai_polled_at, e2e_public_key) VALUES (?, ?, ?, ?, ' . $when . ', ' . $when . ', ?)')
            ->execute([$id, $this->adminId, $name, 'inst-' . bin2hex(random_bytes(4)), base64_encode(random_bytes(32))]);
        return $id;
    }

    private function askFor(string $kind): array
    {
        return self::read($this->controller->adminTest($this->request('POST', ['kind' => $kind]), new Response()));
    }

    private function answerOf(string $jobId): array
    {
        return self::read($this->controller->adminTestResult($this->request('GET'), new Response(), ['job' => $jobId]));
    }

    public function testTheChecklistSaysWhereTheSitesAiRunsAndWhatAppsWouldGet(): void
    {
        // Nothing set up.
        $none = $this->checklist();
        $this->assertSame(['none', null, null, ['named' => false, 'on' => false], [], 'site_ai_unavailable', false, null],
            [$none['source'], $none['computer'], $none['gone'], $none['provider'], $none['kinds'], $none['reason'], $none['ready'], $none['workerIdleSeconds']]);
        $this->assertTrue($none['drawing']);
        $this->assertNull($none['lastTest'], 'no test picture has been made');
        $this->assertSame(['state' => 'missing', 'idleSeconds' => null, 'mode' => null, 'message' => AppAiController::WORKER_MESSAGES['missing']], $none['worker']);
        $this->workerRuns();

        // The server's settings name a provider: it is used only once the Site AI switch is on.
        $this->named = true;
        $this->assertSame(['env', ['named' => true, 'on' => false], [], false], array_values(array_intersect_key($this->checklist(), array_flip(['source', 'provider', 'kinds', 'ready']))));
        $this->switch = true;
        $this->assertSame(['env', ['chat'], null, false], array_values(array_intersect_key($this->checklist(), array_flip(['source', 'kinds', 'reason', 'ready']))), 'no picture model yet: chat only');
        $this->site->save(['pictureModel' => 'stub-image']);
        $this->assertSame([['picture', 'chat'], false], [$this->checklist()['kinds'], $this->checklist()['ready']], 'it can draw, but apps are not allowed yet');
        $this->site->save(['pictureModel' => 'stub-image', 'allowApps' => true]);
        $this->assertTrue($this->checklist()['ready']);
        $this->site->save(['pictureModel' => 'stub-image', 'allowApps' => true, 'paused' => true]);
        $this->assertFalse($this->checklist()['ready'], 'paused');

        // A computer of the administrator's, chosen: apps need no Site AI switch for it, nor any provider.
        $this->named = false;
        $this->switch = false;
        $this->site->save(['pictureModel' => 'flux-3-image-klein', 'allowApps' => true]);
        $connection = $this->computer();
        $this->assertSame('none', $this->checklist()['source'], 'linked, but not chosen');
        $this->computers->choose($this->adminId, $connection);
        $chosen = $this->checklist();
        $this->assertSame(['computer', $connection, 'Studio PC', 'oaiy-engine', true, ['picture', 'chat'], true],
            [$chosen['source'], $chosen['computer']['connectionId'], $chosen['computer']['deviceName'], $chosen['computer']['providerId'], $chosen['computer']['online'], $chosen['kinds'], $chosen['ready']]);
        // Linked and heartbeating, its AI lane unasked for ten minutes (OAIY closed there, or too old for the lane):
        // not online for the site's AI. Its heartbeat alone was what "online" read before.
        self::$pdo->prepare('UPDATE desktop_connections SET last_seen_at = NOW(), ai_polled_at = NOW() - INTERVAL 10 MINUTE WHERE id = ?')->execute([$connection]);
        $quiet = $this->checklist();
        $this->assertSame(['computer', false], [$quiet['source'], $quiet['computer']['online']], 'its heartbeat alone is not online');
        $this->assertEqualsWithDelta(time() - 600, strtotime($quiet['computer']['lastSeenAt'] . ' UTC'), 5, 'when it last asked its lane');
        self::$pdo->prepare('UPDATE desktop_connections SET last_seen_at = NOW() - INTERVAL 10 MINUTE, ai_polled_at = NOW() - INTERVAL 10 MINUTE WHERE id = ?')->execute([$connection]);
        $offline = $this->checklist();
        $this->assertSame(['computer', false, true], [$offline['source'], $offline['computer']['online'], $offline['ready']], 'offline: still where the site\'s AI runs');
        $this->assertEqualsWithDelta(time() - 600, strtotime($offline['computer']['lastSeenAt'] . ' UTC'), 5);

        // Gone (a new key): nothing takes its place, though a provider is named and switched on.
        $this->named = true;
        $this->switch = true;
        self::$pdo->prepare('UPDATE desktop_connections SET e2e_public_key = ? WHERE id = ?')->execute([base64_encode(random_bytes(32)), $connection]);
        $gone = $this->checklist();
        $this->assertSame(['gone', null, ['deviceName' => 'Studio PC'], [], 'site_ai_gone', false], [$gone['source'], $gone['computer'], $gone['gone'], $gone['kinds'], $gone['reason'], $gone['ready']]);
        $this->computers->clear();
        $this->assertSame(['env', true], [$this->checklist()['source'], $this->checklist()['ready']], 'forgotten: the provider in the server\'s settings again');

        // Whether anything runs the worker: seconds since its last pass.
        touch($this->results . '/.alive', time() - 30);
        $this->assertEqualsWithDelta(30, $this->checklist()['workerIdleSeconds'], 3);
    }

    /** Apps' requests are sent by the worker: with none, or one running older code, nothing is ready. */
    public function testTheChecklistSaysWhenTheWorkerIsMissingOrWasStartedBeforeTheLastUpdate(): void
    {
        $this->named = true;
        $this->switch = true;
        $this->site->save(['pictureModel' => 'stub-image', 'allowApps' => true]);
        $missing = $this->checklist();
        $this->assertSame(['missing', 'The AI worker isn\'t running. Start it: php bin/app-ai-worker.php --watch under a supervisor, or every minute from cron.'], [$missing['worker']['state'], $missing['worker']['message']]);
        $this->assertFalse($missing['ready'], 'everything is set, and nothing would send a request');
        $this->assertSame(['picture', 'chat'], $missing['kinds']);

        $this->workerRuns('code-1', 'watch');
        $ok = $this->checklist();
        $this->assertSame(['ok', null, 'watch', true], [$ok['worker']['state'], $ok['worker']['message'], $ok['worker']['mode'], $ok['ready']]);

        // FormLogic was updated, and the --watch worker is still the one from before.
        $this->code = 'code-2';
        $stale = $this->checklist();
        $this->assertSame(['stale', 'The AI worker was started before the last update. Restart it.', false], [$stale['worker']['state'], $stale['worker']['message'], $stale['ready']]);
        // Its supervisor started a fresh one.
        $this->workerRuns('code-2', 'watch');
        $this->assertSame(['ok', true], [$this->checklist()['worker']['state'], $this->checklist()['ready']]);

        // A cron run from the minute before an update is over within seconds: the next is fresh.
        $this->workerRuns('code-1', 'cron', 40);
        $this->assertSame(['ok', true], [$this->checklist()['worker']['state'], $this->checklist()['ready']]);
        // A worker from before workers said what they run only touched its file.
        file_put_contents($this->results . '/.alive', '');
        $this->assertSame('stale', $this->checklist()['worker']['state']);
        // One that stopped: quiet for more than two minutes.
        $this->workerRuns('code-2', 'watch', 200);
        $quiet = $this->checklist();
        $this->assertSame(['missing', false], [$quiet['worker']['state'], $quiet['ready']]);
        $this->assertEqualsWithDelta(200, $quiet['worker']['idleSeconds'], 3);
    }

    /** Pressing the test says the same as the card, instead of queueing a test that would wait or be failed. */
    public function testTheTestIsNotQueuedWhenNoWorkerWouldRunItOrAStaleOneWould(): void
    {
        $this->named = true;
        $this->switch = true;
        $queued = fn(): int => (int) self::$pdo->query('SELECT COUNT(*) FROM app_ai_jobs WHERE app_id IS NULL')->fetchColumn();
        $missing = $this->askFor('chat');
        $this->assertSame([409, 'worker_missing', AppAiController::WORKER_MESSAGES['missing']], [$missing['status'], $missing['body']['code'], $missing['body']['message']]);
        $this->workerRuns('code-0', 'watch');
        $stale = $this->askFor('chat');
        $this->assertSame([409, 'worker_stale', 'The AI worker was started before the last update. Restart it.'], [$stale['status'], $stale['body']['code'], $stale['body']['message']]);
        $this->assertSame(0, $queued());
        $this->workerRuns('code-1', 'watch');
        $this->assertSame(202, $this->askFor('chat')['status']);
        $this->assertSame(1, $queued());
    }

    /**
     * A test that a worker running older code took and failed as it fails an app's job with no app
     * ("AI is turned off for this app") is told to the administrator as what it was, in the test's
     * result and on the checklist's last line.
     */
    public function testATestFailedByAnOutdatedWorkerIsNeverToldAsAnApps(): void
    {
        $this->named = true;
        $this->switch = true;
        $this->site->save(['pictureModel' => 'stub-image']);
        $this->workerRuns();
        $jobId = (string) $this->askFor('picture')['body']['data']['jobId'];
        // What the worker from before the update did with it.
        self::$pdo->prepare("UPDATE app_ai_jobs SET status = 'failed', code = 'ai_unavailable', message = 'AI is turned off for this app.', finished_at = UTC_TIMESTAMP(3) WHERE id = ?")->execute([$jobId]);
        $failed = $this->answerOf($jobId)['body']['data'];
        $this->assertSame(['failed', 'worker_outdated', AppAiService::SITE_TEST_FAILURES['worker_outdated'], ''], [$failed['status'], $failed['code'], $failed['message'], $failed['advice']]);
        $this->assertStringNotContainsString('this app', json_encode($failed));
        $this->assertStringNotContainsString('switched off or changed', json_encode($failed));
        $last = $this->checklist()['lastTest'];
        $this->assertSame(['failed', 'worker_outdated', AppAiService::SITE_TEST_FAILURES['worker_outdated']], [$last['status'], $last['code'], $last['message']]);

        // What the AI itself refused is told as it said it, with what to try.
        self::$pdo->prepare("UPDATE app_ai_jobs SET code = 'model_disabled', message = 'image model stub-image is disabled' WHERE id = ?")->execute([$jobId]);
        $refused = $this->answerOf($jobId)['body']['data'];
        $this->assertSame(['model_disabled', 'image model stub-image is disabled', AppAiService::SITE_TEST_ADVICE['model_disabled']], [$refused['code'], $refused['message'], $refused['advice']]);
    }

    public function testTheAdministratorsTestIsARealJobThatIsNoApps(): void
    {
        // Apps are neither allowed nor unpaused: the test is the administrator's own, and needs neither.
        $this->site->save(['allowApps' => false, 'paused' => true]);
        $this->workerRuns();
        $refused = $this->askFor('picture');
        $this->assertSame([409, 'ai_unavailable', 'The site\'s AI is not set up yet. Choose where it runs first.'], [$refused['status'], $refused['body']['code'], $refused['body']['message']]);

        $this->named = true;
        $this->switch = true;
        $unset = $this->askFor('picture');
        $this->assertSame([409, 'No picture model is chosen yet. Choose one first.'], [$unset['status'], $unset['body']['message']], 'a picture needs its model');
        $counted = fn(): int => (int) self::$pdo->query('SELECT COALESCE(SUM(used), 0) FROM app_ai_counters')->fetchColumn();
        $before = $counted();
        $chat = $this->askFor('chat');
        $this->assertSame(202, $chat['status'], json_encode($chat['body']));
        $jobId = (string) $chat['body']['data']['jobId'];
        $row = self::$pdo->query('SELECT * FROM app_ai_jobs WHERE id = ' . self::$pdo->quote($jobId))->fetch(PDO::FETCH_ASSOC);
        $this->assertSame([null, 'test', $this->adminId, 'chat', 'queued', 'site-env', 'env', null, null],
            [$row['app_id'], $row['requester_kind'], $row['requester_id'], $row['kind'], $row['status'], $row['source'], $row['target'], $row['counted_day'], $row['size']]);
        $this->assertSame($before, $counted(), 'it counts against no allowance');

        $again = $this->askFor('chat');
        $this->assertSame([409, 'A test is already running. Wait for it to finish.'], [$again['status'], $again['body']['message']]);

        // While it waits, a worker that ran a moment ago is about to take it.
        $waiting = $this->answerOf($jobId);
        $this->assertSame([200, 'queued'], [$waiting['status'], $waiting['body']['data']['status']]);
        $this->assertArrayNotHasKey('waiting', $waiting['body']['data']);
        $this->assertLessThan(5, $waiting['body']['data']['waitedSeconds']);
        // The worker stopped since: the administrator is told what the test waits for, and what to do.
        $this->workerRuns('code-1', 'watch', 200);
        $stopped = $this->answerOf($jobId)['body']['data'];
        $this->assertSame(['queued', 'worker', AppAiController::WORKER_MESSAGES['missing']], [$stopped['status'], $stopped['waiting'], $stopped['workerMessage']]);
        // Or FormLogic was updated under it.
        $this->workerRuns('code-0', 'watch');
        $outdated = $this->answerOf($jobId)['body']['data'];
        $this->assertSame(['worker', AppAiController::WORKER_MESSAGES['stale']], [$outdated['waiting'], $outdated['workerMessage']]);
        $this->workerRuns();

        $this->assertSame(404, $this->answerOf(bin2hex(random_bytes(16)))['status']);
        $this->assertSame(404, $this->answerOf('not-an-id')['status']);
        $this->assertNull($this->ai->testResult('some-app', $jobId, $this->results), 'no app\'s owner can read the site\'s test');
        self::$pdo->prepare('DELETE FROM app_ai_jobs WHERE id = ?')->execute([$jobId]);

        // On a computer that is offline, the picture waits for the computer.
        $this->site->save(['pictureModel' => 'flux-3-image-klein']);
        $this->computers->choose($this->adminId, $this->computer('Studio PC', false));
        $picture = $this->askFor('picture');
        $this->assertSame(202, $picture['status'], json_encode($picture['body']));
        $queued = self::$pdo->query('SELECT source, size FROM app_ai_jobs WHERE id = ' . self::$pdo->quote((string) $picture['body']['data']['jobId']))->fetch(PDO::FETCH_ASSOC);
        $this->assertSame(['site-oaiy', '512x512'], [$queued['source'], $queued['size']]);
        $this->assertSame('computer', $this->answerOf((string) $picture['body']['data']['jobId'])['body']['data']['waiting']);
    }
}

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
        $this->controller = new AppAiController(self::$apps, $this->ai, $this->site, null, $this->results);
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
        self::$pdo->prepare('INSERT INTO desktop_connections (id, owner_user_id, device_name, desktop_instance_id, last_seen_at, e2e_public_key) VALUES (?, ?, ?, ?, ' . ($online ? 'NOW()' : 'NOW() - INTERVAL 10 MINUTE') . ', ?)')
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
        self::$pdo->prepare('UPDATE desktop_connections SET last_seen_at = NOW() - INTERVAL 10 MINUTE WHERE id = ?')->execute([$connection]);
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
        @mkdir($this->results, 0777, true);
        touch($this->results . '/.alive', time() - 30);
        $this->assertEqualsWithDelta(30, $this->checklist()['workerIdleSeconds'], 3);
    }

    public function testTheAdministratorsTestIsARealJobThatIsNoApps(): void
    {
        // Apps are neither allowed nor unpaused: the test is the administrator's own, and needs neither.
        $this->site->save(['allowApps' => false, 'paused' => true]);
        $refused = $this->askFor('picture');
        $this->assertSame([409, 'ai_unavailable', 'The site\'s AI is not set up.'], [$refused['status'], $refused['body']['code'], $refused['body']['message']]);

        $this->named = true;
        $this->switch = true;
        $unset = $this->askFor('picture');
        $this->assertSame([409, 'No model is chosen for this kind of request yet.'], [$unset['status'], $unset['body']['message']], 'a picture needs its model');
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

        // While it waits, the administrator is told what for: here, nothing runs the worker.
        $waiting = $this->answerOf($jobId);
        $this->assertSame([200, 'queued', 'worker'], [$waiting['status'], $waiting['body']['data']['status'], $waiting['body']['data']['waiting']]);
        $this->assertLessThan(5, $waiting['body']['data']['waitedSeconds']);
        @mkdir($this->results, 0777, true);
        touch($this->results . '/.alive');
        $this->assertArrayNotHasKey('waiting', $this->answerOf($jobId)['body']['data'], 'a worker ran a moment ago: it is about to be taken');

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

<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\{NativeAppCallsController, NativeAppController};
use FormLogic\Database\MySQLConnection;
use FormLogic\Services\{AppService, AppUserService, FlowService, FormService, NativeAppCalls, NativeAppService, PlanService, RuntimeEngineService};
use PDO;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * The record of each app's calls in MySQL (NativeAppCalls): written as a call is answered, read
 * back newest first, each app held to its newest 500 calls of the last 14 days (here trimmed after
 * every call; the real cadence, one call in TRIM_EVERY, has a test of its own), swept of what is
 * older for apps nobody calls, and gone with its app. Then the whole way: a call the runtime
 * answers is on its owner's list, and on nobody else's.
 */
final class NativeAppCallsTest extends TestCase
{
    private static ?PDO $pdo = null;
    private static ?MySQLConnection $mysql = null;
    private NativeAppCalls $calls;
    private string $owner = '';
    /** @var list<string> */
    private array $apps = [];

    /** A connection of its own: MySQLConnection keeps one for the whole process, so a second one of those is the same. */
    private static function separate(): PDO
    {
        $c = self::config();
        return new PDO(sprintf('mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4', $c['host'], $c['port'], $c['database']), $c['username'], $c['password'], [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    }

    /** The test database's settings, from the backend's .env. */
    private static function config(): array
    {
        return [
            'host' => $_ENV['DB_HOST'] ?? '127.0.0.1', 'port' => $_ENV['DB_PORT'] ?? '3306', 'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
            'username' => $_ENV['DB_USERNAME'] ?? 'root', 'password' => $_ENV['DB_PASSWORD'] ?? '', 'charset' => 'utf8mb4', 'collation' => 'utf8mb4_unicode_ci',
        ];
    }

    public static function setUpBeforeClass(): void
    {
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) \Dotenv\Dotenv::createImmutable($root)->safeLoad();
        $config = self::config();
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
    }

    protected function setUp(): void
    {
        if (self::$pdo === null) $this->markTestSkipped('No test database');
        $this->calls = new NativeAppCalls(self::$mysql, trimEvery: 1);
        $this->owner = 'u' . bin2hex(random_bytes(10));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")->execute([$this->owner, $this->owner . '@example.test']);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) return;
        foreach ($this->apps as $id) self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$id]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->owner]);
        $this->apps = [];
    }

    private function app(): string
    {
        $id = 'app' . bin2hex(random_bytes(10));
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status, settings) VALUES (?, ?, 'Task board', ?, 'published', '{\"softnApp\":true}')")->execute([$id, $this->owner, 'calls' . bin2hex(random_bytes(6))]);
        $this->apps[] = $id;
        return $id;
    }

    /** $count calls of $appId, $daysAgo days old, written straight into the table (the oldest first, the newest a millisecond before then). */
    private function plant(string $appId, int $count, float $daysAgo = 0.0): void
    {
        $at = (new \DateTimeImmutable('now', new \DateTimeZone('UTC')))->modify('-' . (int) round($daysAgo * 86400) . ' seconds')->modify('-' . $count . ' milliseconds');
        $rows = [];
        $values = [];
        for ($i = 0; $i < $count; $i++) {
            $rows[] = '(?, ?, ?, ?, ?, ?, ?, ?)';
            array_push($values, $appId, $at->modify('+' . $i . ' milliseconds')->format('Y-m-d H:i:s.v'), 'GET', '/api/planted/' . $i, 200, 5, null, 'visitor');
        }
        foreach (array_chunk($rows, 200) as $n => $chunk) {
            self::$pdo->prepare('INSERT INTO native_app_calls (app_id, called_at, method, path, status, ms, error, caller) VALUES ' . implode(', ', $chunk))
                ->execute(array_slice($values, $n * 200 * 8, count($chunk) * 8));
        }
    }

    private function held(string $appId): int
    {
        $statement = self::$pdo->prepare('SELECT COUNT(*) FROM native_app_calls WHERE app_id = ?');
        $statement->execute([$appId]);
        return (int) $statement->fetchColumn();
    }

    public function testACallIsWrittenDownAndReadBackNewestFirst(): void
    {
        $app = $this->app();
        $this->assertSame([], $this->calls->recent($app), 'an app nobody has called has no calls');
        $this->assertTrue($this->calls->record($app, 'GET', '/api/items', 200, 14, 'ignored: it did not fail', 'owner'));
        $this->assertTrue($this->calls->record($app, 'POST', '/api/items', 422, 31, 'Give a title of 1 to 200 characters', 'visitor'));
        $this->assertTrue($this->calls->record($app, 'DELETE', '/api/items/7', 404, 3, 'Endpoint not found.', 'member'));
        $calls = $this->calls->recent($app);
        $this->assertSame([
            ['DELETE', '/api/items/7', 404, 3, 'Endpoint not found.', 'member'],
            ['POST', '/api/items', 422, 31, 'Give a title of 1 to 200 characters', 'visitor'],
            ['GET', '/api/items', 200, 14, null, 'owner'],
        ], array_map(static fn (array $call): array => [$call['method'], $call['path'], $call['status'], $call['ms'], $call['error'], $call['caller']], $calls));
        $this->assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00$/', $calls[0]['at']);
        $this->assertLessThan(60, abs(time() - (new \DateTimeImmutable($calls[0]['at']))->getTimestamp()), 'written now, in UTC');
        $this->assertSame(['id', 'at', 'method', 'path', 'status', 'ms', 'error', 'caller'], array_keys($calls[0]), 'nothing the call carried');
        $this->assertCount(2, $this->calls->recent($app, 2));
    }

    public function testAnErrorIsCutToItsColumnAndAPathToItsOwn(): void
    {
        $app = $this->app();
        $this->calls->record($app, 'POST', '/api/' . str_repeat('a', 300), 500, 9, str_repeat('Something went wrong. ', 30), 'owner');
        [$call] = $this->calls->recent($app);
        $this->assertSame(200, mb_strlen((string) $call['error']));
        $this->assertSame(200, strlen($call['path']));
    }

    public function testEachAppKeepsItsNewestFiveHundredCalls(): void
    {
        [$busy, $quiet] = [$this->app(), $this->app()];
        $this->plant($busy, 505);
        $this->plant($quiet, 3);
        $this->assertTrue($this->calls->record($busy, 'POST', '/api/items', 201, 8, null, 'visitor'));
        $this->assertSame(500, $this->held($busy));
        $kept = array_column($this->calls->recent($busy, 500), 'path');
        $this->assertSame('/api/items', $kept[0], 'the newest is kept');
        $this->assertSame('/api/planted/6', $kept[499], 'and the oldest six are gone');
        $this->assertNotContains('/api/planted/5', $kept);
        $this->assertSame(3, $this->held($quiet), 'another app\'s are its own');
        // At the limit, each new call takes the oldest one's place.
        $this->calls->record($busy, 'GET', '/api/items', 200, 2, null, 'owner');
        $this->assertSame(500, $this->held($busy));
        $this->assertNotContains('/api/planted/6', array_column($this->calls->recent($busy, 500), 'path'));
    }

    public function testACallIsWrittenAloneAndAnOpenTransactionIsLeftToItsOwner(): void
    {
        $app = $this->app();
        $this->plant($app, 500);
        // Written alone: committed at once, so another connection sees it straight away.
        $this->assertTrue($this->calls->record($app, 'GET', '/api/first', 200, 2, null, 'owner'));
        $this->assertSame(500, $this->held($app), 'and trimmed after it, in a statement of its own');
        $seen = self::separate()->prepare('SELECT COUNT(*) FROM native_app_calls WHERE app_id = ? AND path = ?');
        $seen->execute([$app, '/api/first']);
        $this->assertSame(1, (int) $seen->fetchColumn(), 'committed, not left in a transaction');
        // Someone else's transaction, still open: the call is written inside it and goes when it is rolled back; no
        // trim runs inside a transaction that is not the record's.
        self::$pdo->beginTransaction();
        try {
            $this->assertTrue($this->calls->record($app, 'GET', '/api/items', 200, 2, null, 'owner'));
            $this->assertTrue(self::$pdo->inTransaction(), 'the record did not end a transaction that is not its own');
            $this->assertSame(501, $this->held($app));
        } finally {
            self::$pdo->rollBack();
        }
        $this->assertSame(500, $this->held($app));
        $this->assertNotContains('/api/items', array_column($this->calls->recent($app, 500), 'path'));
    }

    public function testAWriteWaitsForTheAppsRowNoLongerThanItsLimitAndLeavesTheConnectionAsItWas(): void
    {
        $app = $this->app();
        // Something else holds the app's row (a publish, a change of its settings) and does not let go.
        $holder = self::separate();
        $holder->beginTransaction();
        $holder->prepare('SELECT id FROM apps WHERE id = ? FOR UPDATE')->execute([$app]);
        $log = tempnam(sys_get_temp_dir(), 'fl-calls-log-');
        $previous = ini_set('error_log', (string) $log);
        try {
            $started = microtime(true);
            $written = $this->calls->record($app, 'GET', '/api/items', 200, 2, null, 'visitor');
            $waited = microtime(true) - $started;
        } finally {
            ini_set('error_log', $previous === false ? '' : $previous);
            $holder->rollBack();
        }
        $said = (string) file_get_contents((string) $log);
        unlink((string) $log);
        $this->assertFalse($written, 'given up, not waited for: MySQL\'s own limit is 50 seconds');
        $this->assertGreaterThanOrEqual(NativeAppCalls::LOCK_WAIT_SECONDS - 0.5, $waited, 'it did wait for the row');
        $this->assertLessThan(NativeAppCalls::LOCK_WAIT_SECONDS + 3, $waited);
        $this->assertStringContainsString('App call not recorded for app ' . $app, $said);
        // What else the connection runs waits as long as it always has.
        $this->assertSame((int) self::$pdo->query('SELECT @@GLOBAL.innodb_lock_wait_timeout')->fetchColumn(), (int) self::$pdo->query('SELECT @@SESSION.innodb_lock_wait_timeout')->fetchColumn());
        // Let go: written.
        $this->assertTrue($this->calls->record($app, 'GET', '/api/items', 200, 2, null, 'visitor'));
    }

    public function testACallThatWasNeverAnsweredKeepsWhyAndOneToAnAddressTheAppLacksKeepsNone(): void
    {
        $app = $this->app();
        $this->calls->record($app, 'POST', '/api/report', 0, 30_000, 'The call was stopped before it was answered: it took too long, or ran out of memory.', 'visitor');
        $this->calls->record($app, 'GET', '', 404, 3, 'Endpoint not found.', 'visitor');
        [$lacking, $stopped] = $this->calls->recent($app);
        $this->assertSame([0, 'The call was stopped before it was answered: it took too long, or ran out of memory.'], [$stopped['status'], $stopped['error']]);
        $this->assertSame(['', 404], [$lacking['path'], $lacking['status']]);
    }

    public function testAtTheRealCadenceTheRecordIsTrimmedOnAHostWhoseIdsStepByTen(): void
    {
        // ClearDB steps its ids by 10 (a Galera cluster by its size): an id is never a multiple of 25 there, and a trim
        // by id never ran. By chance, one call in TRIM_EVERY trims whatever the ids.
        $calls = new NativeAppCalls(self::$mysql);
        $app = $this->app();
        $this->plant($app, 505);
        self::$pdo->exec('SET SESSION auto_increment_increment = 10');
        try {
            for ($n = 0; $n < 300; $n++) $this->assertTrue($calls->record($app, 'GET', '/api/items', 200, 2, null, 'visitor'));
            $steps = self::$pdo->query('SELECT id FROM native_app_calls WHERE app_id = ' . self::$pdo->quote($app) . ' ORDER BY id DESC LIMIT 2')->fetchAll(PDO::FETCH_COLUMN);
        } finally {
            self::$pdo->exec('SET SESSION auto_increment_increment = DEFAULT');
        }
        $this->assertSame(10, (int) $steps[0] - (int) $steps[1], 'the ids did step by ten');
        // (no trim in 300 calls at one in 25: about one run in 200,000)
        $this->assertLessThan(505 + 300, $this->held($app), 'trimmed');
        $this->assertCount(NativeAppCalls::KEEP, $calls->recent($app, NativeAppCalls::KEEP), 'and the page is shown what is kept');
    }

    public function testCallsAreListedByWhenTheyCameNotWhenTheyWereWritten(): void
    {
        // A long call is written after a short one that came after it (and, on PHP-FPM, after its answer).
        $app = $this->app();
        $utc = new \DateTimeZone('UTC');
        $this->calls->record($app, 'GET', '/api/quick', 200, 5, null, 'visitor', new \DateTimeImmutable('-2 seconds', $utc));
        $this->calls->record($app, 'POST', '/api/slow', 200, 25_000, null, 'visitor', new \DateTimeImmutable('-25 seconds', $utc));
        $listed = $this->calls->recent($app);
        $this->assertSame(['/api/quick', '/api/slow'], array_column($listed, 'path'));
        $this->assertLessThan(60, abs((time() - 25) - (new \DateTimeImmutable($listed[1]['at']))->getTimestamp()), 'shown when it came');
    }

    public function testCallsOlderThanFourteenDaysAreNeverShownAndGoWhenTheAppIsCalledAgain(): void
    {
        $app = $this->app();
        $this->plant($app, 4, 15);
        $this->plant($app, 2, 13);
        $this->assertSame(['/api/planted/1', '/api/planted/0'], array_column($this->calls->recent($app), 'path'), 'only the last fourteen days are shown');
        $this->assertSame(6, $this->held($app));
        $this->calls->record($app, 'GET', '/api/items', 200, 2, null, 'owner');
        $this->assertSame(3, $this->held($app), 'the older ones went as the next call was written');
    }

    public function testWhereBothLimitsReachTheFartherOneIsKeptTo(): void
    {
        // Three calls past fourteen days and 505 since: the newest 500 stay, and none of the old three.
        $app = $this->app();
        $this->plant($app, 3, 15);
        $this->plant($app, 505, 1);
        $this->assertTrue($this->calls->record($app, 'GET', '/api/items', 200, 2, null, 'owner'));
        $this->assertSame(500, $this->held($app));
        $statement = self::$pdo->prepare('SELECT COUNT(*) FROM native_app_calls WHERE app_id = ? AND called_at < ?');
        $statement->execute([$app, (new \DateTimeImmutable('now', new \DateTimeZone('UTC')))->modify('-14 days')->format('Y-m-d H:i:s.v')]);
        $this->assertSame(0, (int) $statement->fetchColumn());
        // Old calls alone, fewer than 500: they go, and what is newer stays.
        $quiet = $this->app();
        $this->plant($quiet, 2, 30);
        $this->plant($quiet, 1, 2);
        $this->calls->record($quiet, 'GET', '/api/items', 200, 2, null, 'owner');
        $this->assertSame(['/api/items', '/api/planted/0'], array_column($this->calls->recent($quiet), 'path'));
        $this->assertSame(2, $this->held($quiet));
    }

    public function testTheSweepTakesWhatIsOlderOfEveryApp(): void
    {
        [$one, $two] = [$this->app(), $this->app()];
        $this->plant($one, 3, 20);
        $this->plant($two, 2, 15);
        $this->plant($two, 1, 1);
        $this->assertGreaterThanOrEqual(5, $this->calls->sweep());
        $this->assertSame([0, 1], [$this->held($one), $this->held($two)]);
    }

    public function testAnAppsCallsGoWithIt(): void
    {
        $app = $this->app();
        $this->calls->record($app, 'GET', '/api/items', 200, 2, null, 'owner');
        self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$app]);
        $this->assertSame(0, $this->held($app));
        // A call to an app that is gone is not written down, and is no error.
        $log = tempnam(sys_get_temp_dir(), 'fl-calls-log-');
        $previous = ini_set('error_log', (string) $log);
        try {
            $this->assertFalse($this->calls->record($app, 'GET', '/api/items', 200, 2, null, 'owner'));
        } finally {
            ini_set('error_log', $previous === false ? '' : $previous);
            unlink((string) $log);
        }
    }

    /** The whole way: a call the runtime answers is on its owner's list, as they are told it, and on nobody else's. */
    public function testACallTheRuntimeAnsweredIsOnItsOwnersListAndNobodyElses(): void
    {
        $app = $this->app();
        $apps = new AppService(self::$mysql, $this->createMock(FormService::class));
        $slug = (string) $apps->getApp($app)['slug'];
        $project = ['access' => 'application', 'version' => 1, 'assets' => [], 'files' => ['manifest.json' => '{"id":"tasks","server":{"entry":"server/main.logic","routes":[{"path":"/api/items","method":"POST","handler":"createItem"}]}}', 'index.html' => '<h1>Tasks</h1>']];
        $native = $this->createMock(NativeAppService::class);
        $native->method('runtimeProject')->willReturn(['project' => $project, 'media' => null]);
        $native->method('request')->willReturn(['status' => 422, 'body' => (object) ['error' => 'Give a title of 1 to 200 characters']]);
        $engines = $this->createMock(RuntimeEngineService::class);
        $runtime = new NativeAppController($apps, $this->createMock(AppUserService::class), $native, $this->createMock(PlanService::class), $this->createMock(FlowService::class), $engines, calls: $this->calls);
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/api/app/' . $slug . '/native/request', ['REMOTE_ADDR' => '198.51.100.4'])
            ->withParsedBody(['method' => 'POST', 'path' => '/api/items', 'body' => ['title' => '']]);
        $this->assertSame(200, $runtime->runtime($request, new Response(), ['slug' => $slug])->getStatusCode());

        $list = new NativeAppCallsController($apps, $this->calls);
        $read = fn (?string $user) => $list->index((new ServerRequestFactory())->createServerRequest('GET', '/api/apps/' . $app . '/native/calls')->withAttribute('userId', $user), new Response(), ['id' => $app]);
        $owners = $read($this->owner);
        $this->assertSame(200, $owners->getStatusCode());
        $calls = json_decode((string) $owners->getBody(), true)['calls'];
        $this->assertSame([['POST', '/api/items', 422, 'Give a title of 1 to 200 characters', 'visitor']], array_map(static fn (array $call): array => [$call['method'], $call['path'], $call['status'], $call['error'], $call['caller']], $calls));
        $this->assertStringNotContainsString('198.51.100.4', (string) $owners->getBody());
        $this->assertSame(404, $read('someone-else')->getStatusCode());
        $this->assertSame(404, $read(null)->getStatusCode());
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\AppController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\FormService;
use FormLogic\Services\NativeAppService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response as SlimResponse;

/**
 * GET /api/apps/summary: what the apps list shows of each app its caller owns beyond the app
 * itself. One entry for each owned app and for no other; the installed SoftN project's version,
 * access and server side, its database's tables and size (no rows counted, no runtime started);
 * the first connected custom domain; and the active members besides the owner.
 *
 * Skipped unless a test database is reachable (DB_TEST_DATABASE / DB_HOST / DB_USERNAME / DB_PASSWORD).
 */
class AppSummaryTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static AppService $apps;
    private static string $forms = '';

    private string $storage = '';
    private NativeAppService $native;
    /** @var string[] */ private array $userIds = [];
    /** @var string[] */ private array $appIds = [];

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
        self::$forms = sys_get_temp_dir() . '/fl-appsummary-' . bin2hex(random_bytes(5));
        self::$apps = new AppService($conn, new FormService($conn, new SQLiteConnection(self::$forms)));
    }

    public static function tearDownAfterClass(): void
    {
        // The form store's folder is made with the service and never written to here.
        if (self::$forms !== '' && is_dir(self::$forms)) {
            @rmdir(self::$forms);
        }
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->storage = sys_get_temp_dir() . '/formlogic-native-summary-' . bin2hex(random_bytes(8));
        mkdir($this->storage, 0700);
        $this->native = new NativeAppService($this->storage, $this->storage . '/no-runtime');
    }

    protected function tearDown(): void
    {
        if (self::$pdo !== null) {
            foreach ($this->appIds as $appId) {
                self::$pdo->prepare('DELETE FROM app_domains WHERE app_id = ?')->execute([$appId]);
                self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$appId]);
                self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$appId]);
                self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$appId]);
            }
            foreach ($this->userIds as $userId) {
                self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$userId]);
            }
        }
        if ($this->storage === '' || !is_dir($this->storage)) {
            return;
        }
        $root = realpath($this->storage);
        $temp = realpath(sys_get_temp_dir()) . DIRECTORY_SEPARATOR;
        if ($root === false || !str_starts_with($root, $temp) || !str_starts_with(basename($root), 'formlogic-native-summary-')) {
            throw new \RuntimeException('Unexpected fixture path');
        }
        $iterator = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($iterator as $file) {
            $file->isDir() && !$file->isLink() ? rmdir($file->getPathname()) : unlink($file->getPathname());
        }
        rmdir($root);
    }

    private function id(string $prefix): string
    {
        return $prefix . bin2hex(random_bytes(10));
    }

    private function makeUser(): string
    {
        $id = $this->id('u');
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")->execute([$id, $id . '@test.local']);
        $this->userIds[] = $id;
        return $id;
    }

    private function makeApp(string $ownerId, array $settings): string
    {
        $id = $this->id('app');
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status, settings) VALUES (?, ?, 'T', ?, 'published', ?)")
            ->execute([$id, $ownerId, 'sum' . bin2hex(random_bytes(6)), json_encode((object) $settings)]);
        $this->appIds[] = $id;
        return $id;
    }

    private function addMember(string $appId, string $userId, string $status): void
    {
        $role = $this->id('role');
        self::$pdo->prepare('INSERT INTO app_roles (id, app_id, name, is_system, sort_order) VALUES (?, ?, ?, 0, 0)')->execute([$role, $appId, 'R' . substr($role, 0, 10)]);
        self::$pdo->prepare('INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at) VALUES (?, ?, ?, ?, ?, NOW())')
            ->execute([$this->id('au'), $appId, $userId, $role, $status]);
    }

    /** A custom domain in a status, made $minutesAgo: the oldest connected one is the app's first. */
    private function addDomain(string $appId, string $ownerId, string $status, int $minutesAgo): string
    {
        $host = 'd' . bin2hex(random_bytes(6)) . '.example-app.com';
        self::$pdo->prepare(
            "INSERT INTO app_domains (id, app_id, owner_id, domain, normalized_domain, mode, status, verification_method, verification_token, verified_at, created_at)
             VALUES (?, ?, ?, ?, ?, 'runtime_direct', ?, 'dns_txt', ?, ?, NOW() - INTERVAL ? MINUTE)"
        )->execute([$this->id('dom'), $appId, $ownerId, $host, $host, $status, 'fl-domain-verification=' . bin2hex(random_bytes(8)), in_array($status, ['active', 'verified'], true) ? date('Y-m-d H:i:s') : null, $minutesAgo]);
        return $host;
    }

    /** A SoftN project installed for the app, at version 4 for members: with a server side and this database, or all client when $sql is null. */
    private function install(string $appId, ?string $sql): string
    {
        $root = $this->storage . '/' . hash('sha256', $appId);
        mkdir($root . '/private/data', 0700, true);
        $manifest = ['id' => 'test.summary', 'main' => 'ui/main.ui'] + ($sql === null ? [] : ['server' => ['entry' => 'server/main.logic']]);
        file_put_contents($root . '/project.json', json_encode(['home' => false, 'version' => 4, 'files' => ['manifest.json' => json_encode($manifest), 'ui/main.ui' => '<Text>x</Text>'], 'assets' => [], 'access' => 'members']));
        $database = $root . '/private/data/application.sqlite';
        if ($sql !== null) {
            (new PDO('sqlite:' . $database, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]))->exec($sql);
        }
        return $database;
    }

    private function summary(?string $userId, ?NativeAppService $native = null): ResponseInterface
    {
        $request = (new ServerRequestFactory())->createServerRequest('GET', '/api/apps/summary');
        if ($userId !== null) {
            $request = $request->withAttribute('userId', $userId);
        }
        return (new AppController(self::$apps, null, null, null, null, null, $native))->summary($request, new SlimResponse());
    }

    public function testOneEntryForEachAppTheCallerOwnsWithItsProjectDatabaseDomainAndMembers(): void
    {
        $owner = $this->makeUser();
        $other = $this->makeUser();
        [$ada, $bo, $cy] = [$this->makeUser(), $this->makeUser(), $this->makeUser()];

        // A SoftN app with a server side: three tables, one of them the host's own.
        $softn = $this->makeApp($owner, ['softnApp' => true]);
        $database = $this->install($softn, "CREATE TABLE notes(id INTEGER PRIMARY KEY, title TEXT); CREATE TABLE tags(name TEXT PRIMARY KEY); CREATE TABLE _softn_migrations(id INTEGER PRIMARY KEY); INSERT INTO notes(title) VALUES ('a'), ('b')");
        $this->addDomain($softn, $owner, 'pending', 90);
        $this->addDomain($softn, $owner, 'verified', 80);
        $second = $this->addDomain($softn, $owner, 'active', 10);
        $first = $this->addDomain($softn, $owner, 'active', 60);
        $this->addMember($softn, $owner, 'active');
        $this->addMember($softn, $ada, 'active');
        $this->addMember($softn, $bo, 'active');
        $this->addMember($softn, $cy, 'pending');

        // A forms app: nothing installed, a domain whose ownership is proven but which is not live yet.
        $forms = $this->makeApp($owner, []);
        $this->addDomain($forms, $owner, 'verified', 30);
        $this->addMember($forms, $cy, 'suspended');

        // An app whose settings do not say SoftN, with an all-client project installed.
        $client = $this->makeApp($owner, ['appKind' => 'custom']);
        $this->install($client, null);
        $this->addMember($client, $ada, 'active');

        // Somebody else's app, with everything an entry could show.
        $theirs = $this->makeApp($other, ['softnApp' => true]);
        $this->install($theirs, 'CREATE TABLE t(id INTEGER PRIMARY KEY)');
        $theirDomain = $this->addDomain($theirs, $other, 'active', 5);
        $this->addMember($theirs, $owner, 'active');

        $response = $this->summary($owner, $this->native);
        $this->assertSame(200, $response->getStatusCode());
        $body = json_decode((string) $response->getBody(), true);
        $this->assertSame(['apps'], array_keys($body));
        $apps = $body['apps'];
        ksort($apps);
        $expected = [
            $softn => ['softn' => true, 'installed' => true, 'version' => 4, 'access' => 'members', 'backend' => true, 'tables' => 2, 'bytes' => filesize($database), 'domain' => $first, 'members' => 2],
            $forms => ['softn' => false, 'installed' => false, 'version' => null, 'access' => null, 'backend' => false, 'tables' => null, 'bytes' => null, 'domain' => null, 'members' => 0],
            $client => ['softn' => true, 'installed' => true, 'version' => 4, 'access' => 'members', 'backend' => false, 'tables' => null, 'bytes' => null, 'domain' => null, 'members' => 1],
        ];
        ksort($expected);
        $this->assertSame($expected, $apps);
        $this->assertNotSame($second, $first);
        $this->assertGreaterThan(0, filesize($database));

        // The other owner's list holds their app and none of this owner's; a member of it is not its owner.
        $this->assertSame([$theirs => ['softn' => true, 'installed' => true, 'version' => 4, 'access' => 'members', 'backend' => true, 'tables' => 1, 'bytes' => filesize($this->storage . '/' . hash('sha256', $theirs) . '/private/data/application.sqlite'), 'domain' => $theirDomain, 'members' => 1]],
            json_decode((string) $this->summary($other, $this->native)->getBody(), true)['apps']);
        $this->assertSame('{"apps":{}}', (string) $this->summary($ada, $this->native)->getBody(), 'a member owns nothing: an empty object, not a list');
        $this->assertSame(401, $this->summary(null, $this->native)->getStatusCode());

        // What the service answers from its three queries.
        $this->assertEquals([
            $softn => ['softn' => true, 'domain' => $first, 'members' => 2],
            $forms => ['softn' => false, 'domain' => null, 'members' => 0],
            $client => ['softn' => false, 'domain' => null, 'members' => 1],
        ], self::$apps->ownerSummaries($owner));
        $this->assertSame([], self::$apps->ownerSummaries($ada));
    }

    public function testAnInstallationThatCannotBeReadDoesNotFailTheList(): void
    {
        $owner = $this->makeUser();
        $busy = $this->makeApp($owner, ['softnApp' => true]);
        $this->install($busy, 'CREATE TABLE t(id INTEGER PRIMARY KEY)');
        $broken = $this->makeApp($owner, ['softnApp' => true]);
        $root = $this->storage . '/' . hash('sha256', $broken);
        mkdir($root, 0700, true);
        file_put_contents($root . '/project.json', '{"version": 4, "files": {');
        $plain = $this->makeApp($owner, []);

        // Being updated: an installer holds the management lock.
        $lock = fopen($this->storage . '/' . hash('sha256', $busy) . '/private/manage.lock', 'c');
        $this->assertTrue(flock($lock, LOCK_EX | LOCK_NB));
        try {
            $apps = json_decode((string) $this->summary($owner, $this->native)->getBody(), true)['apps'];
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
        $this->assertSame(['softn' => true, 'installed' => true, 'version' => 4, 'access' => 'members', 'backend' => true, 'tables' => null, 'bytes' => null, 'domain' => null, 'members' => 0], $apps[$busy]);
        // A project file that does not read is shown as nothing installed; the app's settings still say SoftN.
        $this->assertSame(['softn' => true, 'installed' => false, 'version' => null, 'access' => null, 'backend' => false, 'tables' => null, 'bytes' => null, 'domain' => null, 'members' => 0], $apps[$broken]);
        $this->assertFalse($apps[$plain]['softn']);
        $this->assertCount(3, $apps);

        // With no native host wired in, every app is shown as having nothing installed.
        $without = json_decode((string) $this->summary($owner)->getBody(), true)['apps'];
        $this->assertSame([true, false], [$without[$busy]['softn'], $without[$busy]['installed']]);
    }

    /**
     * GET /api/apps and GET /api/apps/{id} name a SoftN app's own icon (`lookIcon`), for its owner and
     * for a member alike, at the address the app's look gives its images; an app without one, a forms
     * app, and a controller with no look service wired in carry no such field.
     */
    public function testTheListAndAnAppsOwnAnswerNameASoftnAppsIcon(): void
    {
        $owner = $this->makeUser();
        $member = $this->makeUser();
        $withIcon = $this->makeApp($owner, ['softnApp' => true]);
        $root = $this->storage . '/' . hash('sha256', $withIcon);
        mkdir($root . '/private', 0700, true);
        file_put_contents($root . '/project.json', json_encode([
            'home' => true, 'version' => 1, 'access' => 'members',
            'files' => ['manifest.json' => json_encode(['id' => 'test.icon', 'main' => 'ui/main.ui', 'icon' => 'assets/icon.svg']), 'ui/main.ui' => '<Text>x</Text>'],
            'assets' => ['assets/icon.svg' => base64_encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>')],
        ]));
        $noIcon = $this->makeApp($owner, ['softnApp' => true]);
        $this->install($noIcon, null);
        $forms = $this->makeApp($owner, []);
        $this->addMember($withIcon, $member, 'active');

        $look = new \FormLogic\Services\AppLookService($this->native);
        $controller = new AppController(self::$apps, null, null, null, null, null, $this->native, $look);
        $as = static fn (string $userId, string $path) => (new ServerRequestFactory())->createServerRequest('GET', $path)->withAttribute('userId', $userId);
        $listed = static function (ResponseInterface $response): array {
            $apps = [];
            foreach (json_decode((string) $response->getBody(), true)['apps'] as $app) {
                $apps[$app['id']] = $app;
            }
            return $apps;
        };

        $expected = ['kind' => 'svg', 'version' => $look->resolve(self::$apps->getApp($withIcon))['version']];
        $mine = $listed($controller->index($as($owner, '/api/apps'), new SlimResponse()));
        $this->assertSame($expected, $mine[$withIcon]['lookIcon']);
        $this->assertArrayNotHasKey('lookIcon', $mine[$noIcon]);
        $this->assertArrayNotHasKey('lookIcon', $mine[$forms]);

        $one = json_decode((string) $controller->show($as($owner, "/api/apps/$withIcon"), new SlimResponse(), ['id' => $withIcon])->getBody(), true)['app'];
        $this->assertSame($expected, $one['lookIcon']);

        // A member is listed the app as the runtime gives it them, and the same icon at the same address.
        $theirs = $listed($controller->index($as($member, '/api/apps'), new SlimResponse()));
        $this->assertSame([$withIcon], array_keys($theirs));
        $this->assertSame($expected, $theirs[$withIcon]['lookIcon']);
        $this->assertArrayNotHasKey('ownerId', $theirs[$withIcon]);

        // The owner's answer to a change carries it too: the page keeps that answer in place of the app it had.
        $saved = json_decode((string) $controller->update($as($owner, "/api/apps/$withIcon")->withParsedBody(['description' => 'Another description']), new SlimResponse(), ['id' => $withIcon])->getBody(), true)['app'];
        $this->assertSame('svg', $saved['lookIcon']['kind']);
        $this->assertSame($look->resolve(self::$apps->getApp($withIcon))['version'], $saved['lookIcon']['version']);

        // No look service wired in: the list is the list it always was.
        $without = $listed((new AppController(self::$apps, null, null, null, null, null, $this->native))->index($as($owner, '/api/apps'), new SlimResponse()));
        $this->assertArrayNotHasKey('lookIcon', $without[$withIcon]);
    }

    /** `summary` is a path of its own: registered before `/{id}`, which would take it for an app's id, and beside the apps list in its group. */
    public function testTheRouteIsRegisteredBeforeTheOneThatWouldTakeItForAnAppId(): void
    {
        $index = (string) file_get_contents(dirname(__DIR__, 2) . '/public/index.php');
        $group = strpos($index, "\$app->group('/api/apps', function (RouteCollectorProxy \$group)");
        $this->assertNotFalse($group);
        $list = strpos($index, "\$group->get('', function (\$request, \$response) use (\$container) {", $group);
        $summary = strpos($index, "\$group->get('/summary', function (\$request, \$response) use (\$container) {", $group);
        $handler = strpos($index, 'return $container->get(AppController::class)->summary($request, $response);', $group);
        $byId = strpos($index, "\$group->get('/{id}'", $group);
        $end = strpos($index, '})->add($cloudWriteGate)->add($authRequired);', $group);
        foreach ([$list, $summary, $handler, $byId, $end] as $found) {
            $this->assertNotFalse($found);
        }
        $this->assertTrue($list < $summary && $summary < $handler && $handler < $byId && $byId < $end, 'list, summary, {id}, inside the one group and its sign-in');
        $this->assertSame(1, substr_count($index, "'/summary'"));
    }
}

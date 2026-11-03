<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\FormService;
use FormLogic\Services\SoftnDirectoryService;
use FormLogic\Support\DataEncryption;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * Publishing a hosted SoftN app to a SoftN directory, against an in-memory directory that answers as apps/softn-api
 * does (a 201 with the app and an edit key; versions only with that key). Nothing reaches a real one.
 */
final class SoftnDirectoryServiceTest extends TestCase
{
    private static ?PDO $pdo = null;
    private static ?MySQLConnection $mysql = null;
    private static AppService $apps;
    private static string $tmp = '';

    private string $owner = '';
    private string $other = '';
    private string $appId = '';
    /** @var array<string, array{key:string, name:string, versions:int}> */
    private array $listed = [];
    /** @var list<array{method:string, url:string, headers:array, fields:array, entries:list<string>}> */
    private array $calls = [];
    /** @var null|\Closure(string, string): ?array A twist on the directory's next answer. */
    private ?\Closure $answer = null;
    private array $project = [];
    private string $key = '';

    public static function setUpBeforeClass(): void
    {
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) {
            \Dotenv\Dotenv::createImmutable($root)->safeLoad();
        }
        try {
            $conn = new MySQLConnection([
                'host' => $_ENV['DB_HOST'] ?? '127.0.0.1', 'port' => $_ENV['DB_PORT'] ?? '3306',
                'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test', 'username' => $_ENV['DB_USERNAME'] ?? 'root',
                'password' => $_ENV['DB_PASSWORD'] ?? '', 'charset' => 'utf8mb4', 'collation' => 'utf8mb4_unicode_ci',
            ]);
            $conn->getConnection()->query('SELECT 1');
            $conn->initializeSchema();
            $conn->runMigrations();
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
        self::$mysql = $conn;
        self::$pdo = $conn->getConnection();
        self::$tmp = sys_get_temp_dir() . '/fl-softn-dir-' . bin2hex(random_bytes(4));
        @mkdir(self::$tmp, 0777, true);
        self::$apps = new AppService($conn, new FormService($conn, new SQLiteConnection(self::$tmp . '/sqlite')));
    }

    protected function setUp(): void
    {
        if (self::$pdo === null) $this->markTestSkipped('No test database');
        $this->key = DataEncryption::generateKey();
        putenv(DataEncryption::KEY_ENV . '=' . $this->key);
        $_ENV[DataEncryption::KEY_ENV] = $this->key;
        $this->owner = $this->user();
        $this->other = $this->user();
        $this->appId = (string) self::$apps->createApp(['name' => 'Booking ' . bin2hex(random_bytes(3)), 'settings' => ['softnApp' => true]], $this->owner)['id'];
        $this->project = ['version' => 3, 'files' => [
            'manifest.json' => json_encode(['id' => 'local.booking', 'name' => 'Booking', 'version' => '1.0.0', 'main' => 'index.html']),
            'index.html' => '<h1>Book a table</h1>',
            'permission.json' => json_encode(['permissions' => ['net' => ['enabled' => true, 'allowed_hosts' => ['api.example.com']]]]),
            'server/main.logic' => 'function book(req) { return {status: 200}; }',
        ], 'assets' => ['images/logo.png' => base64_encode("\x89PNG fake")]];
        $this->listed = $this->calls = [];
        $this->answer = null;
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) return;
        foreach ([$this->owner, $this->other] as $uid) {
            self::$pdo->prepare('DELETE FROM softn_directory_drafts WHERE owner_user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM softn_directory_publications WHERE owner_user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM app_users WHERE app_id IN (SELECT id FROM apps WHERE owner_id = ?)')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT r.id FROM app_roles r JOIN apps a ON a.id = r.app_id WHERE a.owner_id = ?)')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM app_roles WHERE app_id IN (SELECT id FROM apps WHERE owner_id = ?)')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM app_versions WHERE app_id IN (SELECT id FROM apps WHERE owner_id = ?)')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM apps WHERE owner_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
        }
        putenv(DataEncryption::KEY_ENV);
        unset($_ENV[DataEncryption::KEY_ENV]);
    }

    public function testNothingReachesADirectoryUntilTheAdministratorNamesOne(): void
    {
        $service = $this->service(null);
        $this->assertRefused(fn () => $service->createDraft($this->owner, $this->appId, ['name' => 'Booking', 'category' => 'tools']), 'does not publish');
        foreach (['ftp://dir.test', 'http://dir.example.com', 'https://user:pw@dir.test', 'https://dir.test/?x=1', 'not a url'] as $bad) {
            $this->assertRefused(fn () => $service->setDirectory($bad), 'address');
        }
        self::assertSame('https://dir.test', $service->setDirectory('https://dir.test/')['url']);
        self::assertSame('http://127.0.0.1:5510', $service->setDirectory('http://127.0.0.1:5510')['url']);
        self::assertNull($service->setDirectory('')['url']);
        self::assertSame([], $this->calls, 'and nothing was asked of any directory');
    }

    public function testEditKeysAreNeverKeptPlain(): void
    {
        putenv(DataEncryption::KEY_ENV);
        unset($_ENV[DataEncryption::KEY_ENV], $_SERVER[DataEncryption::KEY_ENV]);
        $service = $this->service('https://dir.test');
        $this->assertRefused(fn () => $service->createDraft($this->owner, $this->appId, ['name' => 'Booking', 'category' => 'tools']), 'DATA_ENCRYPTION_KEY');
    }

    public function testADraftIsTheAppsProjectPackedCheckedAndItsOwnersAlone(): void
    {
        $service = $this->service('https://dir.test');
        $draft = $service->createDraft($this->owner, $this->appId, ['name' => " Booking\u{202E}", 'description' => 'Book a table.', 'category' => 'tools', 'tags' => ['food', 'tables']]);
        self::assertSame('draft', $draft['status']);
        self::assertSame(['name' => 'Booking', 'description' => 'Book a table.', 'category' => 'tools', 'tags' => ['food', 'tables']], $draft['listing']);
        self::assertSame(['net' => ['enabled' => true, 'allowed_hosts' => ['api.example.com']]], $draft['permissions']);
        self::assertStringContainsString('server/', $draft['warnings'][0]);
        self::assertSame('/softn-directory/approve/' . $draft['draftId'], $draft['approvalUrl']);
        $file = self::$tmp . '/staging/' . $draft['draftId'] . '.softn';
        self::assertSame(hash_file('sha256', $file), $draft['sha256']);
        $zip = new \ZipArchive();
        $zip->open($file);
        $names = [];
        for ($i = 0; $i < $zip->numFiles; $i++) $names[] = $zip->getNameIndex($i);
        sort($names);
        self::assertSame(['images/logo.png', 'index.html', 'manifest.json', 'permission.json'], $names, 'the backend stays here');
        self::assertSame("\x89PNG fake", $zip->getFromName('images/logo.png'));
        $zip->close();

        // Another account sees none of it, and makes no draft of an app it does not own.
        $this->assertRefused(fn () => $service->draft($this->other, $draft['draftId']), 'No draft of yours');
        $this->assertRefused(fn () => $service->requestPublish($this->other, $draft['draftId']), 'No draft of yours');
        $this->assertRefused(fn () => $service->approve($this->other, $draft['draftId']), 'No draft of yours');
        $this->assertRefused(fn () => $service->createDraft($this->other, $this->appId, ['name' => 'Mine', 'category' => 'tools']), 'No app of yours');
        $this->assertRefused(fn () => $service->createDraft($this->owner, $this->appId, ['name' => 'Booking']), 'listing.category');
    }

    public function testWhatABundleCannotHoldIsRefused(): void
    {
        $service = $this->service('https://dir.test');
        $before = glob(self::$tmp . '/staging/*.softn') ?: [];
        foreach (['../escape.js', '/etc/passwd', 'a\\b.js', 'ui/./x.ui'] as $bad) {
            $this->project['files'][$bad] = 'x';
            $this->assertRefused(fn () => $service->createDraft($this->owner, $this->appId, ['name' => 'Booking', 'category' => 'tools']), 'a bundle cannot hold');
            unset($this->project['files'][$bad]);
        }
        $this->project['assets']['big.bin'] = base64_encode(random_bytes(SoftnDirectoryService::MAX_BUNDLE_BYTES + 1024));
        $this->assertRefused(fn () => $service->createDraft($this->owner, $this->appId, ['name' => 'Booking', 'category' => 'tools']), '32 MB');
        self::assertSame($before, glob(self::$tmp . '/staging/*.softn') ?: [], 'and nothing of a refused bundle is kept');
    }

    public function testOnlyTheOwnersApprovalPublishesAndOnlyOnce(): void
    {
        $service = $this->service('https://dir.test');
        $draft = $service->createDraft($this->owner, $this->appId, ['name' => 'Booking', 'category' => 'tools']);
        $this->assertRefused(fn () => $service->approve($this->owner, $draft['draftId']), 'Ask for this draft to be published first');
        self::assertSame('awaiting_approval', $service->requestPublish($this->owner, $draft['draftId'])['status']);
        self::assertSame('awaiting_approval', $service->requestPublish($this->owner, $draft['draftId'])['status'], 'asking again changes nothing');
        self::assertSame([], $this->posts(), 'asking publishes nothing');

        $done = $service->approve($this->owner, $draft['draftId']);
        self::assertSame('published', $done['status']);
        $slug = $done['publication']['slug'];
        self::assertSame(['https://dir.test/app/' . $slug, 'https://dir.test/play/' . $slug], [$done['publication']['page'], $done['publication']['play']]);
        self::assertSame(['name' => 'Booking', 'category' => 'tools'], array_intersect_key($this->posts()[0]['fields'], ['name' => 1, 'category' => 1]));
        self::assertNotContains('server/main.logic', $this->posts()[0]['entries']);

        // Again, from another tab or a retrying agent: the same app, and no second one in the directory.
        self::assertSame($done['publication'], $service->approve($this->owner, $draft['draftId'])['publication']);
        self::assertSame($done['publication'], $service->requestPublish($this->owner, $draft['draftId'])['publication']);
        self::assertCount(1, $this->posts());
        self::assertCount(1, $this->listed);

        // The key: never in anything handed out, kept sealed, and it is the directory's.
        $editKey = $this->listed[$slug]['key'];
        foreach ([$done, $service->publications($this->owner), $service->publication($this->owner, $slug), $service->getStarted()] as $view) {
            self::assertStringNotContainsString($editKey, json_encode($view));
        }
        $stored = (string) self::$pdo->query('SELECT edit_key FROM softn_directory_publications WHERE slug = ' . self::$pdo->quote($slug))->fetchColumn();
        self::assertTrue(DataEncryption::isSealed($stored));
        self::assertStringNotContainsString($editKey, $stored);
    }

    public function testAnUpdateIsANewVersionOfTheAccountsOwnAppOnly(): void
    {
        $service = $this->service('https://dir.test');
        $first = $service->createDraft($this->owner, $this->appId, ['name' => 'Booking', 'category' => 'tools']);
        $service->requestPublish($this->owner, $first['draftId']);
        $slug = $service->approve($this->owner, $first['draftId'])['publication']['slug'];

        $this->project['files']['index.html'] = '<h1>Book a table tonight</h1>';
        $next = $service->createDraft($this->owner, $this->appId, ['notes' => 'Tonight’s tables'], $slug);
        $service->requestPublish($this->owner, $next['draftId']);
        $done = $service->approve($this->owner, $next['draftId']);
        self::assertSame(2, $done['publication']['version']);
        $version = $this->posts()[1];
        self::assertStringEndsWith('/api/apps/' . $slug . '/versions', $version['url']);
        self::assertSame($this->listed[$slug]['key'], $version['headers']['X-Edit-Key'], 'the account’s key, from its sealed copy');
        self::assertCount(1, $this->listed, 'a version, not another app');

        // Another account cannot aim at it, whatever it knows of the slug.
        $theirs = (string) self::$apps->createApp(['name' => 'Theirs ' . bin2hex(random_bytes(3)), 'settings' => ['softnApp' => true]], $this->other)['id'];
        $this->assertRefused(fn () => $service->createDraft($this->other, $theirs, [], $slug), 'only its own apps');
    }

    public function testAppChangedSinceItsDraftIsNotWhatThePersonWouldApprove(): void
    {
        $service = $this->service('https://dir.test');
        $draft = $service->createDraft($this->owner, $this->appId, ['name' => 'Booking', 'category' => 'tools']);
        $service->requestPublish($this->owner, $draft['draftId']);
        self::assertFalse($service->draft($this->owner, $draft['draftId'])['appChanged']);

        // The workspace the person tries is the app now; the bundle is the app when the draft was made.
        $tried = $this->project;
        $this->project['files']['index.html'] = '<h1>Something else</h1>';
        self::assertTrue($service->draft($this->owner, $draft['draftId'])['appChanged']);
        $this->assertRefused(fn () => $service->approve($this->owner, $draft['draftId']), 'changed since this draft');
        $this->assertRefused(fn () => $service->approve($this->owner, $draft['draftId'], true), 'changed since this draft');

        $this->project = $tried;
        $this->project['assets']['images/extra.png'] = base64_encode('another picture');
        self::assertTrue($service->draft($this->owner, $draft['draftId'])['appChanged'], 'a file added counts');
        self::assertSame([], $this->posts(), 'and nothing went');

        // The backend is not in the bundle: changing it changes nothing the person is approving.
        $this->project = $tried;
        $this->project['files']['server/main.logic'] = 'function book(req) { return {status: 201}; }';
        self::assertFalse($service->draft($this->owner, $draft['draftId'])['appChanged']);
        self::assertSame('published', $service->approve($this->owner, $draft['draftId'])['status']);
        self::assertFalse($service->draft($this->owner, $draft['draftId'])['appChanged'], 'a published draft has nothing left to compare');
    }

    public function testNothingBrowsersAreNotServedHereGoesPublic(): void
    {
        $this->project['files'] += [
            'private/keys.json' => '{"key":"sk-very-secret"}',
            'backend/db.logic' => 'let password = "hunter2";',
            'Server/x.logic' => 'function x() {}',
            'db/seed.sql' => "INSERT INTO users VALUES ('secret');",
        ];
        $this->project['files']['manifest.json'] = json_encode([
            'id' => 'local.booking', 'name' => 'Booking', 'version' => '1.0.0', 'main' => 'index.html', 'engine' => 'zipp-web-python', 'logicEngine' => 'x',
            'server' => ['routes' => ['/api/x' => 'server/main.logic'], 'secret' => 'sk-in-the-manifest'],
            'config' => ['server' => ['allowedOrigins' => ['https://me.example']], 'engine' => 'y', 'theme' => (object) []],
        ]);
        $service = $this->service('https://dir.test');
        $draft = $service->createDraft($this->owner, $this->appId, ['name' => 'Booking', 'category' => 'tools']);
        self::assertSame(['images/logo.png', 'index.html', 'manifest.json', 'permission.json'], $draft['files']);
        self::assertStringContainsString('5 files', $draft['warnings'][0]);
        $zip = new \ZipArchive();
        $zip->open(self::$tmp . '/staging/' . $draft['draftId'] . '.softn');
        $manifest = (string) $zip->getFromName('manifest.json');
        $zip->close();
        self::assertStringNotContainsString('sk-in-the-manifest', $manifest);
        self::assertStringNotContainsString('me.example', $manifest);
        self::assertSame(['id', 'name', 'version', 'main', 'config'], array_keys(json_decode($manifest, true)));
        self::assertStringContainsString('"theme":{}', $manifest, 'an empty object stays one');
        self::assertFalse($draft['appChanged'], 'and that is what the app is compared with');
    }

    public function testAByteOrderMarkDoesNotHideWhatAnAppAsksFor(): void
    {
        $this->project['files']['permission.json'] = "\xEF\xBB\xBF" . $this->project['files']['permission.json'];
        $this->project['files']['manifest.json'] = "\xEF\xBB\xBF" . $this->project['files']['manifest.json'];
        $draft = $this->service('https://dir.test')->createDraft($this->owner, $this->appId, ['name' => 'Booking', 'category' => 'tools']);
        self::assertTrue($draft['permissions']['net']['enabled']);
    }

    /**
     * A listing without a description or author leaves the directory to take its manifest's (Apps::create): the
     * approval page used to show neither, and the app was listed with both.
     */
    public function testANewAppIsShownWithTheDescriptionAndAuthorItsManifestWillListItUnder(): void
    {
        $this->project['files']['manifest.json'] = json_encode(['id' => 'local.booking', 'name' => 'Booking', 'version' => '1.0.0', 'main' => 'index.html',
            'description' => 'Sign in with your bank password to keep the clock in sync.', 'author' => ['name' => 'Your Bank']]);
        $service = $this->service('https://dir.test');
        $draft = $service->createDraft($this->owner, $this->appId, ['name' => 'Clock', 'category' => 'tools']);
        self::assertSame(['name' => 'Clock', 'category' => 'tools', 'description' => 'Sign in with your bank password to keep the clock in sync.', 'author' => 'Your Bank'], $draft['listing']);
        $service->requestPublish($this->owner, $draft['draftId']);
        $service->approve($this->owner, $draft['draftId']);
        self::assertSame(['Sign in with your bank password to keep the clock in sync.', 'Your Bank'], [$this->posts()[0]['fields']['description'], $this->posts()[0]['fields']['author']], 'and sent as shown');

        // What the agent gives is what goes, and no more of an author than the directory keeps.
        $mine = $service->createDraft($this->owner, $this->appId, ['name' => 'Clock', 'category' => 'tools', 'description' => 'A clock.', 'author' => str_repeat('a', 50)]);
        self::assertSame(['A clock.', str_repeat('a', 40)], [$mine['listing']['description'], $mine['listing']['author']]);
    }

    /**
     * The page shows the listing as the directory keeps it (Apps::create: a name of 64, notes of 400, tags as Text::tags
     * writes them): it showed a longer name, whose cut-off end was its point, and tags the directory rewrote. A category
     * the directory does not have, which it would file as "other", is refused while there is still an agent to fix it.
     */
    public function testThePageShowsTheListingAsTheDirectoryKeepsIt(): void
    {
        $service = $this->service('https://dir.test');
        $name = 'Clock for the whole family: alarms, timers and a calendar - and no ads';
        $draft = $service->createDraft($this->owner, $this->appId, ['name' => $name, 'category' => 'tools', 'notes' => str_repeat('n', 450),
            'tags' => ['Family Fun!', 'no-ads-ever-for-anyone-at-all', 'family fun', '!!!']]);
        self::assertSame(mb_substr($name, 0, 64), $draft['listing']['name']);
        self::assertSame(400, mb_strlen($draft['listing']['notes']));
        self::assertSame(['family-fun', 'no-ads-ever-for-anyone-a'], $draft['listing']['tags'], 'as the directory writes them, once each');
        $this->assertRefused(fn () => $service->createDraft($this->owner, $this->appId, ['name' => 'Clock', 'category' => 'kids']), 'no category "kids": use one of tools');
    }

    /** A new version sends its notes alone: its page showed a name, description, author and tags that never went. */
    public function testANewVersionShowsItsNotesAloneUnderTheNameItIsListedBy(): void
    {
        $service = $this->service('https://dir.test');
        $first = $service->createDraft($this->owner, $this->appId, ['name' => 'Clock', 'category' => 'tools']);
        $service->requestPublish($this->owner, $first['draftId']);
        $slug = $service->approve($this->owner, $first['draftId'])['publication']['slug'];

        $next = $service->createDraft($this->owner, $this->appId, ['name' => 'Family Photo Album', 'description' => 'Private, nothing leaves your device.',
            'category' => 'kids', 'author' => 'Your bank', 'tags' => ['safe'], 'notes' => 'Bug fixes'], $slug);
        self::assertSame(['notes' => 'Bug fixes'], $next['listing']);
        self::assertSame(['slug' => $slug, 'name' => 'Clock'], $next['target']);
        $service->requestPublish($this->owner, $next['draftId']);
        $service->approve($this->owner, $next['draftId']);
        self::assertSame(['notes' => 'Bug fixes'], $this->posts()[1]['fields']);
    }

    /**
     * Without permission.json, what the app may use is the manifest's older block, read as SoftN reads it: `network`
     * set to anything JavaScript calls true turns the network on. The page said "no network" for 1, "yes" and the rest.
     */
    public function testAnOlderManifestsPermissionsAreReadAsTheRuntimeReadsThem(): void
    {
        $net = ['net' => ['enabled' => true]];
        foreach ([[1, $net], ['yes', $net], ['0', $net], [[], $net], [['enabled' => false], $net], [true, $net],
            [0, []], [false, []], [null, []], ['', []]] as [$value, $expected]) {
            self::assertSame($expected, SoftnDirectoryService::declaredPermissions([], ['permissions' => ['network' => $value]]), json_encode($value));
        }
        // `{}` in the manifest itself, as JSON decodes it here.
        $decoded = json_decode('{"permissions":{"network":{},"filesystem":"no"}}', true);
        self::assertSame(['net' => ['enabled' => true], 'files' => ['enabled' => true]], SoftnDirectoryService::declaredPermissions([], $decoded));
        self::assertSame([], SoftnDirectoryService::declaredPermissions([], ['permissions' => true]), 'not a block: nothing');
        // With permission.json, only it counts: one that cannot be read, or has no block, grants nothing.
        $legacy = ['permissions' => ['network' => true]];
        self::assertSame([], SoftnDirectoryService::declaredPermissions(['permission.json' => '{not json'], $legacy));
        self::assertSame([], SoftnDirectoryService::declaredPermissions(['permission.json' => '{"other":1}'], $legacy));
        self::assertSame($net, SoftnDirectoryService::declaredPermissions(['permission.json' => ''], $legacy), 'an empty file is no file');

        unset($this->project['files']['permission.json']);
        $this->project['files']['manifest.json'] = json_encode(['id' => 'local.booking', 'name' => 'Booking', 'version' => '1.0.0', 'main' => 'index.html', 'permissions' => ['network' => 1]]);
        $service = $this->service('https://dir.test');
        $draft = $service->createDraft($this->owner, $this->appId, ['name' => 'Booking', 'category' => 'tools']);
        self::assertSame($net, $draft['permissions']);

        // A draft made before this kept the older block as it stood: shown as SoftN reads it all the same.
        self::$pdo->prepare('UPDATE softn_directory_drafts SET permissions = ? WHERE id = ?')->execute(['{"network":true,"filesystem":0}', $draft['draftId']]);
        self::assertSame($net, $service->draft($this->owner, $draft['draftId'])['permissions']);
        // Not a bundle with a permission.json: such keys there are that file's, and grant nothing.
        $this->project['files']['permission.json'] = '{"permissions":{"network":{"enabled":true}}}';
        $declared = $service->createDraft($this->owner, $this->appId, ['name' => 'Booking', 'category' => 'tools']);
        self::assertSame(['network' => ['enabled' => true]], $declared['permissions']);
    }

    public function testADraftOfADeletedAppIsNotPublished(): void
    {
        $service = $this->service('https://dir.test');
        $draft = $service->createDraft($this->owner, $this->appId, ['name' => 'Booking', 'category' => 'tools']);
        $service->requestPublish($this->owner, $draft['draftId']);
        self::$apps->deleteApp($this->appId);
        $this->assertRefused(fn () => $service->approve($this->owner, $draft['draftId']), 'has been deleted');
        self::assertSame([], $this->posts());
    }

    public function testAPublishedDraftAnswersWithItsAppAfterItsDayIsOver(): void
    {
        $service = $this->service('https://dir.test');
        $draft = $service->createDraft($this->owner, $this->appId, ['name' => 'Booking', 'category' => 'tools']);
        $service->requestPublish($this->owner, $draft['draftId']);
        $service->approve($this->owner, $draft['draftId']);
        self::$pdo->prepare('UPDATE softn_directory_drafts SET expires_at = ? WHERE id = ?')->execute([gmdate('Y-m-d H:i:s', time() - 60), $draft['draftId']]);
        self::assertSame('published', $service->requestPublish($this->owner, $draft['draftId'])['status']);
    }

    public function testASlugGivenOutAgainIsTheNewAppsAndAKnownAppIsNotCalledUnclear(): void
    {
        $service = $this->service('https://dir.test');
        $ask = function () use ($service): string {
            $draft = $service->createDraft($this->owner, $this->appId, ['name' => 'Booking', 'category' => 'tools']);
            $service->requestPublish($this->owner, $draft['draftId']);
            return $draft['draftId'];
        };
        $answer = fn (string $key) => fn () => ['status' => 201, 'body' => json_encode(['ok' => true, 'app' => ['slug' => 'booking', 'name' => 'Booking'], 'editKey' => $key])];
        $this->answer = $answer('first-key');
        self::assertSame('published', $service->approve($this->owner, $ask())['status']);
        // Removed from the directory, then the same name published again: the same slug, and only the new key works.
        $this->answer = $answer('second-key');
        self::assertSame('published', $service->approve($this->owner, $ask())['status']);
        self::assertCount(1, $service->publications($this->owner));

        // The directory took it and only keeping it here failed: the page must not invite a second one.
        $this->answer = fn () => ['status' => 201, 'body' => json_encode(['ok' => true, 'app' => ['slug' => 'keyless', 'name' => 'Booking']])];
        $kept = $service->approve($this->owner, $ask());
        self::assertSame('uncertain', $kept['status']);
        self::assertStringContainsString('Do not publish it again', (string) $kept['error']);
        self::assertStringContainsString('https://dir.test/app/keyless', (string) $kept['error']);
    }

    public function testExpiredBundlesGoAndAnErasedAccountLeavesNone(): void
    {
        $staging = self::$tmp . '/staging';
        $service = $this->service('https://dir.test');
        $old = $service->createDraft($this->owner, $this->appId, ['name' => 'Booking', 'category' => 'tools']);
        $older = $service->createDraft($this->owner, $this->appId, ['name' => 'Booking', 'category' => 'tools']);
        $live = $service->createDraft($this->owner, $this->appId, ['name' => 'Booking', 'category' => 'tools']);
        self::$pdo->prepare('UPDATE softn_directory_drafts SET expires_at = ? WHERE id = ?')->execute([gmdate('Y-m-d H:i:s', time() - 60), $old['draftId']]);
        self::$pdo->prepare('UPDATE softn_directory_drafts SET expires_at = ? WHERE id = ?')->execute([gmdate('Y-m-d H:i:s', time() - 8 * 86400), $older['draftId']]);

        self::assertGreaterThanOrEqual(2, SoftnDirectoryService::sweepExpired(self::$pdo, $staging));
        self::assertFileDoesNotExist($staging . '/' . $old['draftId'] . '.softn');
        self::assertFileDoesNotExist($staging . '/' . $older['draftId'] . '.softn');
        self::assertFileExists($staging . '/' . $live['draftId'] . '.softn');
        self::assertSame('expired', $service->draft($this->owner, $old['draftId'])['status'], 'it can still be read for a week');
        $this->assertRefused(fn () => $service->draft($this->owner, $older['draftId']), 'No draft of yours');

        SoftnDirectoryService::eraseStaged(self::$pdo, $this->owner, $staging);
        self::assertFileDoesNotExist($staging . '/' . $live['draftId'] . '.softn');
    }

    public function testNothingGoesWhoseEditKeyCouldNotBeKept(): void
    {
        $service = $this->service('https://dir.test');
        $draft = $service->createDraft($this->owner, $this->appId, ['name' => 'Booking', 'category' => 'tools']);
        $service->requestPublish($this->owner, $draft['draftId']);
        putenv(DataEncryption::KEY_ENV);
        unset($_ENV[DataEncryption::KEY_ENV], $_SERVER[DataEncryption::KEY_ENV]);
        $unkeyed = $this->service('https://dir.test');
        $this->assertRefused(fn () => $unkeyed->approve($this->owner, $draft['draftId']), 'DATA_ENCRYPTION_KEY');
        self::assertSame([], $this->posts());
    }

    public function testANewAppsNotesGoWithIt(): void
    {
        $service = $this->service('https://dir.test');
        $draft = $service->createDraft($this->owner, $this->appId, ['name' => 'Booking', 'category' => 'tools', 'notes' => 'The first cut.']);
        $service->requestPublish($this->owner, $draft['draftId']);
        $service->approve($this->owner, $draft['draftId']);
        self::assertSame('The first cut.', $this->posts()[0]['fields']['notes']);
    }

    public function testATokenKeptToOneAppIsKeptFromAnothersDraftsAndListing(): void
    {
        $service = $this->service('https://dir.test');
        $tools = new \FormLogic\Services\ChatToolsService(
            new FormService(self::$mysql, new SQLiteConnection(self::$tmp . '/sqlite')), self::$apps,
            new \FormLogic\Services\ResponseService(self::$mysql, new SQLiteConnection(self::$tmp . '/sqlite')), softnDirectory: $service,
        );
        $second = (string) self::$apps->createApp(['name' => 'Second ' . bin2hex(random_bytes(3)), 'settings' => ['softnApp' => true]], $this->owner)['id'];
        $context = fn (?string $app, bool $creator = false) => new \FormLogic\Services\ChatToolsContext(
            userId: $this->owner, requireScope: function (string $scope): void {}, audit: function (string $action, array $details): void {},
            scopedAppId: $app, creatorMode: $creator, createdApps: $creator && $app !== null ? [$app] : [],
        );
        $denied = function (\Closure $call): void {
            try {
                $call();
            } catch (\FormLogic\Services\ChatToolDeniedException) {
                $this->addToAssertionCount(1);
                return;
            }
            self::fail('Expected the token to be kept out');
        };

        $draft = $service->createDraft($this->owner, $this->appId, ['name' => 'Booking', 'category' => 'tools']);
        $service->requestPublish($this->owner, $draft['draftId']);
        $slug = $service->approve($this->owner, $draft['draftId'])['publication']['slug'];
        $waiting = $service->createDraft($this->owner, $this->appId, ['name' => 'Booking', 'category' => 'tools']);

        foreach ([$context($second), $context($second, true)] as $kept) {
            foreach (['softn_get_app', 'softn_validate_draft', 'softn_preview_draft', 'softn_publish_draft'] as $tool) {
                $denied(fn () => $tools->call($tool, ['draftId' => $waiting['draftId']], $kept));
            }
            // Its own app may not go out as a new version of the other's listing.
            $denied(fn () => $tools->call('softn_publish_version', ['appId' => $second, 'slug' => $slug], $kept));
            self::assertSame([], $tools->call('softn_list_my_apps', [], $kept)['apps']);
        }
        self::assertSame('draft', $tools->call('softn_get_app', ['draftId' => $waiting['draftId']], $context($this->appId))['status']);
        self::assertCount(1, $tools->call('softn_list_my_apps', [], $context($this->appId))['apps']);
        self::assertCount(1, $tools->call('softn_list_my_apps', [], $context(null))['apps'], 'an account-wide token sees the account’s');
    }

    public function testADirectoryThatRefusesOrDoesNotAnswerSaysSo(): void
    {
        $service = $this->service('https://dir.test');
        $draft = $service->createDraft($this->owner, $this->appId, ['name' => 'Booking', 'category' => 'tools']);
        $service->requestPublish($this->owner, $draft['draftId']);

        $this->answer = fn () => ['status' => 400, 'body' => json_encode(['error' => 'That category does not exist.'])];
        $failed = $service->approve($this->owner, $draft['draftId']);
        self::assertSame(['failed', 'The directory refused it: That category does not exist.'], [$failed['status'], $failed['error']]);

        // Tried again: a 502 after the bundle went may have listed it, so it is never tried again by itself.
        $this->answer = fn () => ['status' => 502, 'body' => 'Bad gateway'];
        $unsure = $service->approve($this->owner, $draft['draftId']);
        self::assertSame('uncertain', $unsure['status']);
        $this->assertRefused(fn () => $service->approve($this->owner, $draft['draftId']), 'may have reached the directory');
        $this->answer = null;
        self::assertSame('published', $service->approve($this->owner, $draft['draftId'], true)['status'], 'unless the person says to');
    }

    public function testADirectoryThatNeverAnswersDoesNotHoldAnAgentsFirstCall(): void
    {
        // A directory that takes the connection and never answers: the real transport, not the one in memory.
        $listener = stream_socket_server('tcp://127.0.0.1:0', $errno, $error);
        self::assertNotFalse($listener, $error);
        $address = (string) stream_socket_get_name($listener, false);
        $settings = self::$tmp . '/settings-silent.json';
        file_put_contents($settings, json_encode(['url' => 'http://' . $address]));
        $service = new SoftnDirectoryService(self::$mysql, self::$apps, null, $settings, self::$tmp . '/staging');
        try {
            $started = microtime(true);
            $answer = $service->getStarted();
            $took = microtime(true) - $started;
        } finally {
            fclose($listener);
        }
        self::assertTrue($answer['enabled']);
        self::assertSame([], $answer['categories'], 'the categories are left out');
        self::assertLessThan(SoftnDirectoryService::READ_TIMEOUT_SECONDS + 3, $took, 'and the call is answered in seconds, not the upload\'s two minutes');
    }

    public function testNoDraftIsLeftPublishing(): void
    {
        $service = $this->service('https://dir.test');
        $ask = function () use ($service): string {
            $draft = $service->createDraft($this->owner, $this->appId, ['name' => 'Booking', 'category' => 'tools']);
            $service->requestPublish($this->owner, $draft['draftId']);
            return $draft['draftId'];
        };

        // The connection drops once the bundle is on its way: it may be listed.
        $this->answer = fn () => throw new \RuntimeException('Connection reset');
        self::assertSame('uncertain', $service->approve($this->owner, $ask())['status']);
        // The directory says yes without an edit key: listed, but not keepable.
        $this->answer = fn () => ['status' => 201, 'body' => json_encode(['ok' => true, 'app' => ['slug' => 'keyless', 'name' => 'Booking']])];
        self::assertSame('uncertain', $service->approve($this->owner, $ask())['status']);
        $this->answer = null;

        // A version whose key cannot be opened (the server's key was replaced): nothing went, so it failed.
        $first = $ask();
        $slug = $service->approve($this->owner, $first)['publication']['slug'];
        $publicationId = (string) self::$pdo->query('SELECT id FROM softn_directory_publications WHERE slug = ' . self::$pdo->quote($slug))->fetchColumn();
        $other = DataEncryption::generateKey();
        putenv(DataEncryption::KEY_ENV . '=' . $other);
        $_ENV[DataEncryption::KEY_ENV] = $other;
        $sealedElsewhere = DataEncryption::fromEnvironment()->seal('a-key-this-server-cannot-open', 'softn_directory_publications.edit_key:' . $publicationId);
        putenv(DataEncryption::KEY_ENV . '=' . $this->key);
        $_ENV[DataEncryption::KEY_ENV] = $this->key;
        self::$pdo->prepare('UPDATE softn_directory_publications SET edit_key = ? WHERE id = ?')->execute([$sealedElsewhere, $publicationId]);
        $next = $service->createDraft($this->owner, $this->appId, [], $slug);
        $service->requestPublish($this->owner, $next['draftId']);
        $posts = count($this->posts());
        $failed = $service->approve($this->owner, $next['draftId']);
        self::assertSame('failed', $failed['status']);
        self::assertSame($posts, count($this->posts()), 'and nothing was sent');

        // A publish whose worker was stopped mid-upload reads as unclear once it is stale.
        $stuck = $ask();
        self::$pdo->prepare("UPDATE softn_directory_drafts SET status = 'publishing', updated_at = ? WHERE id = ?")->execute([gmdate('Y-m-d H:i:s', time() - SoftnDirectoryService::PUBLISHING_STALE_SECONDS - 60), $stuck]);
        self::assertSame('uncertain', $service->draft($this->owner, $stuck)['status']);
        self::assertSame('published', $service->approve($this->owner, $stuck, true)['status'], 'and the person can settle it');
    }

    public function testAnExpiredDraftIsNotPublished(): void
    {
        $service = $this->service('https://dir.test');
        $draft = $service->createDraft($this->owner, $this->appId, ['name' => 'Booking', 'category' => 'tools']);
        self::$pdo->prepare('UPDATE softn_directory_drafts SET expires_at = ? WHERE id = ?')->execute([gmdate('Y-m-d H:i:s', time() - 60), $draft['draftId']]);
        self::assertSame('expired', $service->draft($this->owner, $draft['draftId'])['status']);
        $this->assertRefused(fn () => $service->requestPublish($this->owner, $draft['draftId']), 'expired');
    }

    public function testAnAgentDraftsAndAsksButOnlyThePersonPublishes(): void
    {
        $service = $this->service('https://dir.test');
        $tools = new \FormLogic\Services\ChatToolsService(
            new FormService(self::$mysql, new SQLiteConnection(self::$tmp . '/sqlite')), self::$apps,
            new \FormLogic\Services\ResponseService(self::$mysql, new SQLiteConnection(self::$tmp . '/sqlite')), softnDirectory: $service,
        );
        $granted = ['apps:read', 'apps:write'];
        $audited = [];
        $ctx = new \FormLogic\Services\ChatToolsContext(
            userId: $this->owner,
            requireScope: function (string $scope) use (&$granted): void {
                if (!in_array($scope, $granted, true)) throw new \FormLogic\Services\ChatToolDeniedException('Missing scope ' . $scope, 'scope');
            },
            audit: function (string $action, array $details) use (&$audited): void { $audited[] = $action; },
            siteUrl: 'https://forms.test',
        );
        $names = array_column(array_filter(\FormLogic\Services\ChatToolsService::toolDefinitions(), fn ($t) => str_starts_with($t['name'], 'softn_')), 'name');
        self::assertSame(['softn_get_started', 'softn_create_draft', 'softn_validate_draft', 'softn_preview_draft', 'softn_publish_draft', 'softn_publish_version', 'softn_get_app', 'softn_list_my_apps'], $names, 'and none of them approves');

        self::assertTrue($tools->call('softn_get_started', [], $ctx)['enabled']);
        $draft = $tools->call('softn_create_draft', ['appId' => $this->appId, 'listing' => ['name' => 'Booking', 'category' => 'tools']], $ctx);
        self::assertSame('https://forms.test/softn-directory/approve/' . $draft['draftId'], $draft['approvalUrl']);
        $asked = $tools->call('softn_publish_draft', ['draftId' => $draft['draftId']], $ctx);
        self::assertSame('awaiting_approval', $asked['status']);
        self::assertStringContainsString('approvalUrl', $asked['next']);
        self::assertSame([], $this->posts(), 'an agent’s asking publishes nothing');

        // The person approves on the page; the agent then sees the app, and never its key.
        $service->approve($this->owner, $draft['draftId']);
        $seen = $tools->call('softn_get_app', ['draftId' => $draft['draftId']], $ctx);
        self::assertSame('published', $seen['status']);
        $mine = $tools->call('softn_list_my_apps', [], $ctx);
        $key = $this->listed[$seen['publication']['slug']]['key'];
        self::assertStringNotContainsString($key, json_encode([$seen, $mine]));
        self::assertSame(['softn_create_draft', 'softn_publish_draft'], $audited);

        // A read-only token reads, and drafts nothing.
        $granted = ['apps:read'];
        $this->expectException(\FormLogic\Services\ChatToolDeniedException::class);
        $tools->call('softn_create_draft', ['appId' => $this->appId, 'listing' => ['name' => 'Booking', 'category' => 'tools']], $ctx);
    }

    // ── The directory, in memory ────────────────────────────────────────────────

    private function service(?string $directory, ?DataEncryption $encryption = null): SoftnDirectoryService
    {
        $settings = self::$tmp . '/settings-' . bin2hex(random_bytes(3)) . '.json';
        if ($directory !== null) file_put_contents($settings, json_encode(['url' => $directory]));
        $transport = function (string $method, string $url, array $headers, array $fields, ?string $file): array {
            $entries = [];
            if ($file !== null) {
                $zip = new \ZipArchive();
                $zip->open($file);
                for ($i = 0; $i < $zip->numFiles; $i++) $entries[] = (string) $zip->getNameIndex($i);
                $zip->close();
            }
            $this->calls[] = compact('method', 'url', 'headers', 'fields', 'entries');
            if ($this->answer !== null) return ($this->answer)($method, $url);
            $path = (string) parse_url($url, PHP_URL_PATH);
            if ($method === 'GET' && $path === '/api/categories') return ['status' => 200, 'body' => json_encode(['ok' => true, 'categories' => [['id' => 'tools', 'name' => 'Tools']]])];
            if ($method === 'POST' && $path === '/api/apps') {
                $slug = strtolower((string) preg_replace('/[^a-z0-9]+/i', '-', (string) $fields['name'])) . '-' . count($this->listed);
                $key = bin2hex(random_bytes(20));
                $this->listed[$slug] = ['key' => $key, 'name' => (string) $fields['name'], 'versions' => 1];
                return ['status' => 201, 'body' => json_encode(['ok' => true, 'app' => ['slug' => $slug, 'name' => $fields['name'], 'urls' => ['page' => '/app/' . $slug]], 'editKey' => $key, 'page' => '/app/' . $slug])];
            }
            if ($method === 'POST' && preg_match('#^/api/apps/([^/]+)/versions$#', $path, $m)) {
                if (($this->listed[$m[1]]['key'] ?? null) !== ($headers['X-Edit-Key'] ?? null)) return ['status' => 403, 'body' => json_encode(['error' => 'That edit key does not match.'])];
                $this->listed[$m[1]]['versions']++;
                return ['status' => 201, 'body' => json_encode(['ok' => true, 'app' => ['slug' => $m[1], 'name' => $this->listed[$m[1]]['name'], 'version' => $this->listed[$m[1]]['versions']]])];
            }
            return ['status' => 404, 'body' => '{}'];
        };
        return new SoftnDirectoryService(self::$mysql, self::$apps, null, $settings, self::$tmp . '/staging', \Closure::fromCallable($transport),
            fn (string $appId) => $appId === $this->appId ? $this->project : ['version' => 1, 'files' => ['manifest.json' => '{"main":"index.html"}', 'index.html' => '<p>x</p>']], $encryption);
    }

    /** @return list<array> */
    private function posts(): array
    {
        return array_values(array_filter($this->calls, fn ($c) => $c['method'] === 'POST'));
    }

    private function assertRefused(\Closure $call, string $words): void
    {
        try {
            $call();
        } catch (\DomainException | \InvalidArgumentException $e) {
            self::assertStringContainsString($words, $e->getMessage());
            return;
        }
        self::fail('Expected a refusal mentioning: ' . $words);
    }

    private function user(): string
    {
        $id = 'u' . bin2hex(random_bytes(10));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")->execute([$id, $id . '@test.local']);
        return $id;
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AIService;
use FormLogic\Services\AppAiService;
use FormLogic\Services\AppAiSiteSettings;
use FormLogic\Services\AppListening;
use FormLogic\Services\AppService;
use FormLogic\Services\AppVisitors;
use FormLogic\Services\FormService;
use FormLogic\Services\NativeAppService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * FormLogic's listening for a hosted app, on MySQL: the owner's two choices as an app keeps them,
 * listening on exactly while the owner's "AI for this app" would have the site's speech server
 * asked (the app's own row in app_ai_settings), a recording taken from the allowances the app's AI
 * requests are taken from, and counted in the app's day by its length as well.
 */
final class AppListenCountTest extends TestCase
{
    private static ?PDO $pdo = null;
    private static ?MySQLConnection $mysql = null;
    private static AppService $apps;
    private static string $tmpRoot = '';

    private string $ownerId = '';
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
        self::$tmpRoot = sys_get_temp_dir() . '/formlogic-listen-count-' . bin2hex(random_bytes(4));
        mkdir(self::$tmpRoot . '/sqlite', 0777, true);
        self::$apps = new AppService($conn, new FormService($conn, new SQLiteConnection(self::$tmpRoot . '/sqlite')));
    }

    public static function tearDownAfterClass(): void
    {
        if (self::$tmpRoot === '' || !is_dir(self::$tmpRoot)) return;
        $iterator = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator(self::$tmpRoot, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($iterator as $file) { if ($file->isDir() && !$file->isLink()) @rmdir($file->getPathname()); else @unlink($file->getPathname()); }
        @rmdir(self::$tmpRoot);
    }

    protected function setUp(): void
    {
        if (self::$pdo === null) $this->markTestSkipped('No test database');
        $this->ownerId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'Owner')")->execute([$this->ownerId, $this->ownerId . '@test.local']);
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
        if ($this->ownerId !== '') self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->ownerId]);
        $this->appIds = [];
    }

    private function app(array $settings): array
    {
        $app = self::$apps->createApp(['name' => 'Dictation ' . bin2hex(random_bytes(3)), 'settings' => ['softnApp' => true] + $settings], $this->ownerId);
        $this->appIds[] = $app['id'];
        return self::$apps->getApp($app['id']);
    }

    /** App AI as the site wires it, on a site whose AI is the server's own provider and names a speech server. */
    private function appAi(array $site = ['allowApps' => true]): AppAiService
    {
        $settings = new AppAiSiteSettings(self::$tmpRoot . '/app-ai-' . bin2hex(random_bytes(3)) . '.json');
        $settings->save($site);
        $ai = $this->createMock(AIService::class);
        $ai->method('isConfigured')->willReturn(true);
        $ai->method('envSpeech')->willReturn(['url' => 'http://127.0.0.1:9/v1', 'key' => '', 'model' => '', 'voice' => '']);
        return new AppAiService(self::$mysql, $settings, new AppVisitors(self::$mysql), new NativeAppService(self::$tmpRoot . '/native'), null, $ai);
    }

    private function listening(AppAiService $ai): AppListening
    {
        $site = $this->createMock(AIService::class);
        $site->method('envSpeech')->willReturn(['url' => 'http://127.0.0.1:9/v1', 'key' => '', 'model' => '', 'voice' => '']);
        return new AppListening($ai, $site);
    }

    public function testAnAppKeepsTheOwnersTwoChoicesAndNothingElseInTheirPlace(): void
    {
        $app = $this->app(['softnListen' => 'allow', 'softnApps' => 'allow']);
        $this->assertSame(['allow', 'allow'], [$app['settings']['softnListen'] ?? null, $app['settings']['softnApps'] ?? null]);
        // Saved again as anything else, each is off: the key is gone.
        $changed = self::$apps->updateApp($app['id'], ['settings' => ['softnListen' => 'ask', 'softnApps' => true] + $app['settings']]);
        $kept = self::$apps->getApp($app['id'])['settings'];
        $this->assertNotNull($changed);
        $this->assertArrayNotHasKey('softnListen', $kept);
        $this->assertArrayNotHasKey('softnApps', $kept);
        $this->assertTrue($kept['softnApp']);
    }

    public function testListeningFollowsTheOwnersAiForThisApp(): void
    {
        $app = $this->app(['softnListen' => 'allow']);
        $ai = $this->appAi();
        $listening = $this->listening($ai);
        // AI for this app is off until its owner turns it on: nothing is listened for.
        $this->assertFalse($ai->siteSpeaksFor($app));
        $this->assertFalse($listening->on($app));

        self::$pdo->prepare("INSERT INTO app_ai_settings (app_id, mode) VALUES (?, 'site')")->execute([$app['id']]);
        $this->assertTrue($ai->siteSpeaksFor($app));
        $this->assertTrue($listening->on($app));
        // The same app without the owner's leave to listen.
        $this->assertFalse($listening->on(['settings' => ['softnApp' => true]] + $app));
        // A site that does not let apps use its AI.
        $this->assertFalse($this->listening($this->appAi(['allowApps' => false]))->on($app));

        // The administrator stops this app's AI, and listening stops with it.
        self::$pdo->prepare("UPDATE app_ai_settings SET blocked_by_admin = 1 WHERE app_id = ?")->execute([$app['id']]);
        $this->assertFalse($listening->on($app));
        self::$pdo->prepare("UPDATE app_ai_settings SET blocked_by_admin = 0, mode = 'off' WHERE app_id = ?")->execute([$app['id']]);
        $this->assertFalse($listening->on($app));
    }

    public function testARecordingIsCountedInTheAppsDayByItsLengthAlone(): void
    {
        $app = $this->app(['softnListen' => 'allow']);
        $ai = $this->appAi();
        $day = gmdate('Y-m-d');
        $site = static function () use ($day): int {
            $used = self::$pdo->prepare("SELECT COALESCE(SUM(used), 0) FROM app_ai_counters WHERE app_id = '' AND period = ?");
            $used->execute([$day]);
            return (int) $used->fetchColumn();
        };
        $before = $site();
        $ai->heard($app['id'], 12.4);
        $ai->heard($app['id'], 0.3);
        $rows = self::$pdo->prepare('SELECT scope, subject, period, used FROM app_ai_counters WHERE app_id = ? ORDER BY scope');
        $rows->execute([$app['id']]);
        $this->assertSame([
            ['scope' => 'listen', 'subject' => '', 'period' => $day, 'used' => 2],
            // Whole seconds, each recording rounded up: 13 and 1.
            ['scope' => 'listen-secs', 'subject' => '', 'period' => $day, 'used' => 14],
        ], array_map(static fn(array $row) => ['scope' => (string) $row['scope'], 'subject' => (string) $row['subject'], 'period' => trim((string) $row['period']), 'used' => (int) $row['used']], $rows->fetchAll(PDO::FETCH_ASSOC)));
        // Being heard is counted apart: what it takes from the allowances is takeForListening's, before it is sent.
        $this->assertSame($before, $site());
    }

    public function testARecordingIsTakenFromTheAllowancesTheAppsAiRequestsAre(): void
    {
        $app = $this->app(['softnListen' => 'allow']);
        $ai = $this->appAi();
        // The owner allows three requests a day for the app, two for each person.
        self::$pdo->prepare("INSERT INTO app_ai_settings (app_id, mode, per_requester_day, per_ip_day, per_ip_hour, per_app_day) VALUES (?, 'site', 2, 100, 100, 3)")->execute([$app['id']]);
        $ana = ['kind' => 'visitor', 'id' => 'v-ana'];
        $ben = ['kind' => 'visitor', 'id' => 'v-ben'];
        $day = gmdate('Y-m-d');
        $used = static function (string $appId, string $scope, string $subject, string $period): int {
            $row = self::$pdo->prepare('SELECT used FROM app_ai_counters WHERE app_id = ? AND scope = ? AND subject = ? AND period = ?');
            $row->execute([$appId, $scope, $subject, $period]);
            return (int) $row->fetchColumn();
        };
        $siteBefore = $used('', 'site', '', $day);
        $taken = [];
        try {
            $taken[] = $ai->takeForListening($app['id'], $ana, '203.0.113.7');
            $taken[] = $ai->takeForListening($app['id'], $ana, '203.0.113.7');
            $this->assertArrayHasKey('taken', $taken[0]);
            $this->assertArrayHasKey('taken', $taken[1]);
            // Ana has had her two today.
            $this->assertSame(['refused' => ['code' => 'limit_reached', 'message' => "You have used today's AI allowance. It starts again tomorrow (UTC)."]], $ai->takeForListening($app['id'], $ana, '203.0.113.7'));
            // Ben has his own, and the app has one left; then the app has used its day.
            $taken[] = $ai->takeForListening($app['id'], $ben, '198.51.100.9');
            $this->assertArrayHasKey('taken', $taken[2]);
            $this->assertSame('This app has used its AI for today. Try again tomorrow (UTC).', $ai->takeForListening($app['id'], $ben, '198.51.100.9')['refused']['message'] ?? null);
            $this->assertSame([2, 1, 3, 3], [$used($app['id'], 'requester', 'v:v-ana', $day), $used($app['id'], 'requester', 'v:v-ben', $day), $used($app['id'], 'app', '', $day), $used('', 'site', '', $day) - $siteBefore]);
            // One the speech server could not put into words is given back, everywhere it was counted.
            $ai->giveBackListening($taken[2]['taken']);
            array_pop($taken);
            $this->assertSame([0, 2, 2], [$used($app['id'], 'requester', 'v:v-ben', $day), $used($app['id'], 'app', '', $day), $used('', 'site', '', $day) - $siteBefore]);
            // Nobody known (an app that does not ask for visitors): the network's, the app's and the site's are counted.
            $taken[] = $ai->takeForListening($app['id'], null, '192.0.2.1');
            $this->assertCount(4, $taken[2]['taken'] ?? []);
            $this->assertSame(3, $used($app['id'], 'app', '', $day));
        } finally {
            // The site's day is every app's: what this test took from it is given back.
            foreach ($taken as $one) if (isset($one['taken'])) $ai->giveBackListening($one['taken']);
            self::$pdo->prepare('DELETE FROM app_ai_settings WHERE app_id = ?')->execute([$app['id']]);
        }
    }
}

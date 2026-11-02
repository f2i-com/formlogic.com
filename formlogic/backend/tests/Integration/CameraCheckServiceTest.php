<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AccessGateService;
use FormLogic\Services\AppService;
use FormLogic\Services\CameraCheckService;
use FormLogic\Services\CameraCheckSettings;
use FormLogic\Services\DesktopAiRelayService;
use FormLogic\Services\FormService;
use FormLogic\Services\NativeAppService;
use FormLogic\Services\PluginService;
use FormLogic\Services\SiteAiDesktopSettings;
use FormLogic\Services\SiteDesktopAi;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * The camera check end to end, but for the camera and the model: the Age gate plugin that ships
 * with FormLogic, installed in the real SoftN runner, chooses the turns and writes the turn and
 * decides (its ZIPP code); the site seals the turn to the administrator's OAIY, played here by the
 * contract's test desktop (docs/contracts/e2e-envelope-vectors.json), which opens what it was sent
 * and answers as a model would, honestly or not.
 */
final class CameraCheckServiceTest extends TestCase
{
    private const IN_PICTURE = ['center' => 'camera', 'left' => 'picture_right', 'right' => 'picture_left', 'up' => 'up', 'down' => 'down'];

    private static ?PDO $pdo = null;
    private static ?MySQLConnection $mysql = null;
    private static AppService $apps;
    private static array $vectors = [];
    private static string $tmpRoot = '';

    private DesktopAiRelayService $relay;
    private PluginService $plugins;
    private CameraCheckService $checks;
    private AccessGateService $gate;
    private NativeAppService $native;
    private string $adminId = '';
    private string $memberId = '';
    private string $ownerId = '';
    private string $slug = '';
    /** @var string[] */
    private array $appIds = [];
    /** @var array<string, int> sha256 of each control picture => its digit */
    private array $controls = [];

    public static function setUpBeforeClass(): void
    {
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) {
            \Dotenv\Dotenv::createImmutable($root)->safeLoad();
        }
        try {
            $conn = new MySQLConnection([
                'host' => $_ENV['DB_HOST'] ?? '127.0.0.1',
                'port' => $_ENV['DB_PORT'] ?? '3306',
                'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
                'username' => $_ENV['DB_USERNAME'] ?? 'root',
                'password' => $_ENV['DB_PASSWORD'] ?? '',
                'charset' => 'utf8mb4',
                'collation' => 'utf8mb4_unicode_ci',
            ]);
            $conn->getConnection()->query('SELECT 1');
            $conn->initializeSchema();
            $conn->runMigrations();
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
        self::$mysql = $conn;
        self::$pdo = $conn->getConnection();
        self::$vectors = json_decode((string) file_get_contents(dirname($root, 2) . '/docs/contracts/e2e-envelope-vectors.json'), true, 512, JSON_THROW_ON_ERROR);
        self::$tmpRoot = sys_get_temp_dir() . '/formlogic-camera-' . bin2hex(random_bytes(4));
        mkdir(self::$tmpRoot, 0777, true);
        self::$apps = new AppService($conn, new FormService($conn, new SQLiteConnection(self::$tmpRoot . '/sqlite')));
    }

    protected function setUp(): void
    {
        if (self::$pdo === null) {
            $this->markTestSkipped('No test database');
        }
        $this->native = new NativeAppService(self::$tmpRoot . '/native-' . bin2hex(random_bytes(3)));
        if (!$this->native->available()) {
            $this->markTestSkipped('No SoftN runner here (set FORMLOGIC_NODE_BIN)');
        }
        $this->adminId = $this->makeUser();
        $this->memberId = $this->makeUser();
        $this->ownerId = $this->makeUser();
        self::$pdo->prepare("DELETE FROM plugins WHERE manifest_id = 'formlogic.age-gate'")->execute();
        $this->plugins = new PluginService(self::$mysql, self::$apps, $this->native);
        $plugin = $this->plugins->installBuiltin('formlogic.age-gate', $this->adminId);
        $this->appIds[] = $plugin['appId'];
        foreach (glob(dirname(__DIR__, 2) . '/resources/plugins/age-gate/assets/controls/*.jpg') ?: [] as $file) {
            $this->controls[hash('sha256', (string) file_get_contents($file))] = (int) basename($file, '.jpg');
        }

        // The administrator's OAIY: the contract's test desktop, its own engine reading the pictures.
        self::$pdo->prepare('INSERT INTO desktop_connections (id, owner_user_id, device_name, desktop_instance_id, last_seen_at, e2e_public_key) VALUES (?, ?, ?, ?, NOW(), ?)')
            ->execute([$connection = bin2hex(random_bytes(16)), $this->adminId, 'Test PC', 'inst-camera', self::$vectors['desktop']['publicKey']]);
        $computers = new SiteAiDesktopSettings(self::$mysql, self::$tmpRoot . '/site-ai-' . bin2hex(random_bytes(3)) . '.json');
        $settings = new CameraCheckSettings($computers, self::$tmpRoot . '/camera-' . bin2hex(random_bytes(3)) . '.json');
        $settings->choose($this->adminId, $connection, SiteDesktopAi::PROVIDER, null);
        $this->relay = new DesktopAiRelayService(self::$mysql);
        $desktop = new SiteDesktopAi($this->relay, $computers);
        $this->gate = new AccessGateService(self::$mysql, $this->plugins);
        $this->checks = new CameraCheckService(self::$mysql, $settings, $desktop, $this->gate, $this->plugins, self::$apps, $this->native);

        $app = self::$apps->createApp(['name' => 'Night Market ' . bin2hex(random_bytes(3)), 'settings' => ['requires' => [
            ['plugin' => 'formlogic.age-gate', 'kind' => 'age', 'min' => 18, 'strength' => 'estimated'],
        ]]], $this->ownerId);
        $this->appIds[] = (string) $app['id'];
        self::$apps->publishApp((string) $app['id'], null, $this->ownerId);
        $this->slug = (string) self::$apps->getApp((string) $app['id'])['slug'];
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        foreach ($this->appIds as $appId) {
            try { $this->native->remove($appId); } catch (\Throwable) {}
            self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?)')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_versions WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$appId]);
        }
        self::$pdo->prepare("DELETE FROM plugins WHERE manifest_id = 'formlogic.age-gate'")->execute();
        foreach ([$this->adminId, $this->memberId, $this->ownerId] as $uid) {
            self::$pdo->prepare('DELETE FROM desktop_ai_requests WHERE owner_user_id = ? OR requesting_user_id = ?')->execute([$uid, $uid]);
            self::$pdo->prepare('DELETE FROM desktop_connections WHERE owner_user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
        }
        $this->appIds = [];
    }

    public function testAnHonestAnswerWellAboveTheAppsAgeRecordsAnEstimatedPassAtTheAppsAge(): void
    {
        [$check, $turn] = $this->check(fn (array $honest) => $honest);
        self::assertSame(['passed', 'Done. The app now opens for you.'], [$check['outcome'], $check['message']]);
        $passes = $this->gate->receiptsFor($this->memberId);
        self::assertCount(1, $passes);
        self::assertSame(['formlogic.age-gate', 'age', 18, 'estimated', 'face_check'], [$passes[0]['plugin'], $passes[0]['kind'], $passes[0]['value'], $passes[0]['strength'], $passes[0]['method']]);
        self::assertTrue($this->gate->satisfies($this->memberId, ['plugin' => 'formlogic.age-gate', 'kind' => 'age', 'min' => 18, 'strength' => 'estimated']));

        // What went to OAIY: the plugin's instructions first, every picture in place, its control
        // picture among them, no tool grant, no model (OAIY's own engine uses the one chosen there),
        // and within the lane at full size.
        self::assertArrayNotHasKey('toolGrant', $turn);
        self::assertArrayNotHasKey('model', $turn);
        self::assertSame('system', $turn['messages'][0]['role']);
        $parts = $turn['messages'][1]['content'];
        self::assertSame('text', $parts[0]['type']);
        self::assertStringContainsString('control picture', $parts[0]['text']);
        self::assertSame(5, count(array_filter($parts, fn ($p) => $p['type'] === 'image_url')));
        // Nothing of the check is kept but its outcome.
        $row = self::$pdo->query("SELECT turn, channel, steps FROM camera_checks WHERE id = " . self::$pdo->quote($check['id']))->fetch(PDO::FETCH_ASSOC);
        self::assertSame([null, null], [$row['turn'], $row['channel']]);
    }

    public function testWhatTheModelSaysIsReadAsItsDescriptionAndNothingMore(): void
    {
        $cases = [
            'a wrong control digit: the pictures did not reach it' => [fn ($a) => self::control($a, 1), 'unavailable'],
            'a model that says the check passed, with the wrong turns' => [fn ($a) => ['passed' => true, 'verdict' => 'pass'] + self::turnAll($a, 'up'), 'turns'],
            'two faces' => [fn ($a) => self::set($a, 'faces', 2), 'no_face'],
            'writing in a picture' => [fn ($a) => self::set($a, 'text_visible', true), 'not_live'],
            'a face on a screen' => [fn ($a) => self::set($a, 'screen_or_print', true), 'not_live'],
            'not the same person' => [fn ($a) => ['same_person' => false] + $a, 'not_same'],
            'old enough, but not by the buffer' => [fn ($a) => ['age_low' => 21, 'age_estimate' => 24] + $a, 'stronger_check'],
            'one entry missing' => [fn ($a) => ['images' => array_slice($a['images'], 1)] + $a, 'unavailable'],
        ];
        foreach ($cases as $what => [$twist, $expected]) {
            self::$pdo->prepare('DELETE FROM camera_checks WHERE user_id = ?')->execute([$this->memberId]);
            [$check] = $this->check($twist);
            self::assertSame($expected, $check['outcome'], $what);
        }
        [$check] = $this->check(fn () => null, 'Sure! Here is my answer: it is fine.');
        self::assertSame('unavailable', $check['outcome'], 'no JSON at all');
        self::assertSame([], $this->gate->receiptsFor($this->memberId), 'none of these recorded a pass');
    }

    public function testTriesAreCountedAndAnUnconfirmedAgeWaitsAnHour(): void
    {
        // A check that did not run is not a try.
        [$check] = $this->check(fn ($a) => self::control($a, 1));
        self::assertSame(3, $check['attemptsLeft']);
        // Below the app's age: never called under age, and the next start waits.
        [$check] = $this->check(fn ($a) => ['age_low' => 12, 'age_estimate' => 14] + $a);
        self::assertSame('not_confirmed', $check['outcome']);
        self::assertStringNotContainsString('under', strtolower((string) $check['message']));
        try {
            $this->checks->start($this->memberId, 'formlogic.age-gate', $this->slug, 'age');
            self::fail('started again at once');
        } catch (\InvalidArgumentException $e) {
            self::assertStringContainsString('an hour', $e->getMessage());
        }
        self::$pdo->prepare("UPDATE camera_checks SET outcome = 'turns' WHERE user_id = ?")->execute([$this->memberId]);
        $this->check(fn ($a) => self::turnAll($a, 'down'));
        [$check] = $this->check(fn ($a) => self::turnAll($a, 'down'));
        self::assertSame(0, $check['attemptsLeft']);
        try {
            $this->checks->start($this->memberId, 'formlogic.age-gate', $this->slug, 'age');
            self::fail('a fourth try in a day');
        } catch (\InvalidArgumentException $e) {
            self::assertStringContainsString('today', $e->getMessage());
        }
    }

    public function testOnlyWhatTheSiteCanRunIsOffered(): void
    {
        $plugin = $this->plugins->find('formlogic.age-gate');
        self::assertTrue($this->checks->offeredFor($plugin, ['plugin' => 'formlogic.age-gate', 'kind' => 'age', 'min' => 18, 'strength' => 'estimated']));
        self::assertFalse($this->checks->offeredFor($plugin, ['plugin' => 'formlogic.age-gate', 'kind' => 'age', 'min' => 18, 'strength' => 'verified']), 'not granted a document check');
        // Its own route cannot record more than a declaration: an estimate is the camera check's.
        try {
            $this->gate->recordFromPluginAnswer($plugin, $this->memberId, 'POST', '/api/pass', ['status' => 200, 'body' => (object) ['pass' => (object) ['kind' => 'age', 'value' => 18, 'strength' => 'estimated']]]);
            self::fail('its own route recorded an estimate');
        } catch (\InvalidArgumentException) {
        }
        // And a page cannot start one for an app that does not ask it.
        $open = self::$apps->createApp(['name' => 'Open ' . bin2hex(random_bytes(3))], $this->ownerId);
        $this->appIds[] = (string) $open['id'];
        self::$apps->publishApp((string) $open['id'], null, $this->ownerId);
        $this->expectException(\InvalidArgumentException::class);
        $this->checks->start($this->memberId, 'formlogic.age-gate', (string) self::$apps->getApp((string) $open['id'])['slug'], 'age');
    }

    /**
     * One check: start it, send real-sized pictures, let the test desktop answer with $twist applied
     * to an honest description (or $raw text), then ask until it is decided. Returns [the last
     * status, the turn as OAIY opened it].
     */
    private function check(\Closure $twist, ?string $raw = null): array
    {
        $started = $this->checks->start($this->memberId, 'formlogic.age-gate', $this->slug, 'age');
        self::assertSame('started', $started['status']);
        $steps = $started['steps'];
        self::assertSame('center', $steps[0]['hint']);
        $frames = array_map(fn () => 'data:image/jpeg;base64,' . base64_encode("\xFF\xD8\xFF\xE0" . random_bytes(40000)), $steps);
        $this->checks->submit($this->memberId, $started['id'], $frames);

        // The desktop: claims the turn, opens it, describes each picture as an honest model would.
        $pending = $this->relay->listPending($this->adminId, null, 10, 'inst-camera');
        self::assertCount(1, $pending);
        $claimed = $this->relay->claim($pending[0]['requestId'], $this->adminId, ['instanceId' => 'inst-camera']);
        $pair = sodium_crypto_box_keypair_from_secretkey_and_publickey(base64_decode(self::$vectors['desktop']['secretKey'], true), base64_decode($claimed['ephPub'], true));
        $turn = SiteDesktopAi::open($claimed['envelope'], 0, 0, $pair);
        self::assertLessThan(DesktopAiRelayService::MAX_ENVELOPE_BYTES, strlen((string) base64_decode($claimed['envelope'], true)));
        $images = [];
        $camera = 0;
        foreach ($turn['messages'][1]['content'] as $part) {
            if ($part['type'] !== 'image_url') {
                continue;
            }
            $bytes = (string) base64_decode(substr($part['image_url']['url'], strpos($part['image_url']['url'], ',') + 1), true);
            $digit = $this->controls[hash('sha256', $bytes)] ?? null;
            $images[] = $digit !== null
                ? ['image' => count($images) + 1, 'kind' => 'control', 'digit' => $digit, 'faces' => 0, 'facing' => null, 'screen_or_print' => false, 'text_visible' => false]
                : ['image' => count($images) + 1, 'kind' => 'camera', 'digit' => null, 'faces' => 1, 'facing' => self::IN_PICTURE[$steps[$camera++]['hint']], 'screen_or_print' => false, 'text_visible' => false];
        }
        $honest = ['images' => $images, 'same_person' => true, 'age_estimate' => 34, 'age_low' => 29];
        $content = $raw ?? "```json\n" . json_encode($twist($honest)) . "\n```";
        $this->relay->appendFrame($claimed['requestId'], $this->adminId, SiteDesktopAi::seal(['kind' => 'delta', 'delta' => $content], 1, 0, $pair), 'inst-camera');
        $this->relay->appendFrame($claimed['requestId'], $this->adminId, SiteDesktopAi::seal(['kind' => 'final'], 1, 1, $pair), 'inst-camera');
        $this->relay->complete($claimed['requestId'], $this->adminId, ['status' => 'done', 'instanceId' => 'inst-camera']);

        $status = $this->checks->status($this->memberId, $started['id']);
        self::assertSame('done', $status['status']);
        self::assertArrayNotHasKey('answer', $status, 'a member never sees the model\'s answer');
        return [$status, $turn];
    }

    private static function set(array $answer, string $field, mixed $value): array
    {
        foreach ($answer['images'] as $i => $image) {
            if ($image['kind'] === 'camera') {
                $answer['images'][$i][$field] = $value;
                break;
            }
        }
        return $answer;
    }

    private static function turnAll(array $answer, string $facing): array
    {
        foreach ($answer['images'] as $i => $image) {
            if ($image['kind'] === 'camera') {
                $answer['images'][$i]['facing'] = $facing;
            }
        }
        return $answer;
    }

    private static function control(array $answer, int $digit): array
    {
        foreach ($answer['images'] as $i => $image) {
            if ($image['kind'] === 'control') {
                $answer['images'][$i]['digit'] = $digit;
            }
        }
        return $answer;
    }

    private function makeUser(): string
    {
        $id = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")->execute([$id, $id . '@test.local']);
        return $id;
    }
}

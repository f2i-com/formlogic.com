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
    /** @var array<string, string> the test database, for a second process */
    private static array $config = [];
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
            self::$config = [
                'host' => $_ENV['DB_HOST'] ?? '127.0.0.1',
                'port' => $_ENV['DB_PORT'] ?? '3306',
                'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
                'username' => $_ENV['DB_USERNAME'] ?? 'root',
                'password' => $_ENV['DB_PASSWORD'] ?? '',
                'charset' => 'utf8mb4',
                'collation' => 'utf8mb4_unicode_ci',
            ];
            $conn = new MySQLConnection(self::$config);
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
        // A computer serves the site only while the account it was chosen under is an administrator.
        self::$pdo->prepare('UPDATE users SET is_admin = 1 WHERE id = ?')->execute([$this->adminId]);
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
        self::$pdo->prepare('INSERT INTO desktop_connections (id, owner_user_id, device_name, desktop_instance_id, last_seen_at, ai_polled_at, e2e_public_key) VALUES (?, ?, ?, ?, NOW(), NOW(), ?)')
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

    /**
     * While a check waits for OAIY's answer, the key that reads it (which opens the turn holding the member's pictures)
     * is kept sealed with the site's data key where one is set, as App AI's are; the answer is still read with it.
     */
    public function testTheTurnsKeyIsKeptSealedWithTheSitesDataKey(): void
    {
        $this->withDataKey(\FormLogic\Support\DataEncryption::generateKey(), function (): void {
            $kept = null;
            [$check] = $this->check(function (array $honest) use (&$kept) {
                // (after the check was sent, before its answer is read)
                $kept = (string) self::$pdo->query("SELECT channel FROM camera_checks WHERE user_id = " . self::$pdo->quote($this->memberId) . " AND status = 'assessing'")->fetchColumn();
                return $honest;
            });
            self::assertTrue(\FormLogic\Support\DataEncryption::isSealed($kept), 'the turn\'s key is sealed at rest: ' . substr((string) $kept, 0, 12));
            self::assertSame('passed', $check['outcome'], 'and OAIY\'s answer was read with it');
        });
    }

    /**
     * A data key that is set and cannot be used: the turn's key could only be kept in the clear, so nothing is sent, and
     * the check ends as unavailable without being counted as a try.
     */
    public function testNothingIsSentWhileTheSitesDataKeyCannotBeUsed(): void
    {
        $this->withDataKey('not-a-key', function (): void {
            self::assertFalse(\FormLogic\Support\DataEncryption::fromEnvironment()->usable());
            $started = $this->checks->start($this->memberId, 'formlogic.age-gate', $this->slug, 'age');
            $frames = array_map(fn () => 'data:image/jpeg;base64,' . base64_encode("\xFF\xD8\xFF\xE0" . random_bytes(40000)), $started['steps']);
            try {
                $this->checks->submit($this->memberId, $started['id'], $frames);
                self::fail('a check was sent with a data key that cannot be used');
            } catch (\FormLogic\Support\DataEncryptionException) {
            }
            self::assertSame([], $this->relay->listPending($this->adminId, null, 10, 'inst-camera'), 'nothing reached the lane');
            $row = self::$pdo->query('SELECT status, outcome, submitted_at, channel FROM camera_checks WHERE id = ' . self::$pdo->quote($started['id']))->fetch(PDO::FETCH_ASSOC);
            self::assertSame(['done', 'unavailable', null, null], [$row['status'], $row['outcome'], $row['submitted_at'], $row['channel']], 'ended, and not a try');
        });
    }

    /** `$run` with the site's data key `$key`, everywhere FormLogic reads it (a .env's in $_ENV comes first); what was there is put back. */
    private function withDataKey(string $key, \Closure $run): void
    {
        $name = \FormLogic\Support\DataEncryption::KEY_ENV;
        $kept = [getenv($name), $_ENV[$name] ?? null, $_SERVER[$name] ?? null];
        putenv($name . '=' . $key);
        $_ENV[$name] = $_SERVER[$name] = $key;
        try {
            $run();
        } finally {
            $kept[0] === false ? putenv($name) : putenv($name . '=' . $kept[0]);
            if ($kept[1] === null) unset($_ENV[$name]); else $_ENV[$name] = $kept[1];
            if ($kept[2] === null) unset($_SERVER[$name]); else $_SERVER[$name] = $kept[2];
        }
    }

    /**
     * OAIY's age model reads the camera pictures (never the control), and its readings decide with the AI's as the
     * backup: its detector must find one face in each, and both ages must clear the line.
     */
    public function testOaiysAgeModelDecidesWithTheAiAsItsBackup(): void
    {
        $ages = fn (array $years) => function (?array $asked, int $count) use ($years) {
            self::assertSame('face-age', $asked['task'] ?? null);
            self::assertCount($count, $asked['images'], 'the camera pictures only');
            return ['task' => 'face-age', 'model' => 'mivolo-v2', 'detector' => 'yunet-2023mar',
                'images' => array_map(fn ($a) => is_array($a) ? $a : ['faces' => 1, 'age' => $a], array_slice($years + array_fill(0, $count, 40.0), 0, $count))];
        };

        // Both well above: a pass, by the age model.
        [$check, $turn] = $this->check(fn ($a) => $a, null, true, $ages([31.5, 33.0, 30.2, 34.8]));
        self::assertSame('passed', $check['outcome']);
        self::assertSame('face_check_age_model', $this->gate->receiptsFor($this->memberId)[0]['method']);
        // The turn named the camera pictures by their places among its pictures, the control left out.
        $places = [];
        $at = 0;
        foreach ($turn['messages'][1]['content'] as $part) {
            if ($part['type'] !== 'image_url') {
                continue;
            }
            $bytes = (string) base64_decode(substr($part['image_url']['url'], strpos($part['image_url']['url'], ',') + 1), true);
            if (!isset($this->controls[hash('sha256', $bytes)])) {
                $places[] = $at;
            }
            $at++;
        }
        self::assertSame($places, $turn['verify']['images']);

        $cases = [
            'the age model reads one picture young, the AI does not' => [$ages([19.5]), fn ($a) => $a, 'stronger_check'],
            'the age model reads them old, the AI young: the backup holds' => [$ages([35.0, 36.0]), fn ($a) => ['age_low' => 15, 'age_estimate' => 17] + $a, 'stronger_check'],
            'both read a child' => [$ages([11.0, 12.0, 11.5, 12.5]), fn ($a) => ['age_low' => 9, 'age_estimate' => 12] + $a, 'not_confirmed'],
            'the detector finds two faces in one picture' => [$ages([['faces' => 2, 'age' => 30.0]]), fn ($a) => $a, 'no_face'],
            'an age the model could not give' => [$ages([['faces' => 1]]), fn ($a) => $a, 'unavailable'],
        ];
        foreach ($cases as $what => [$readings, $twist, $expected]) {
            self::$pdo->prepare('DELETE FROM camera_checks WHERE user_id = ?')->execute([$this->memberId]);
            self::$pdo->prepare('DELETE FROM passes WHERE user_id = ?')->execute([$this->memberId]);
            [$check] = $this->check($twist, null, true, $readings);
            self::assertSame($expected, $check['outcome'], $what);
        }
    }

    /**
     * Where OAIY measured which way each face points (from its landmarks), the turns are read from those angles, each
     * against the straight-on picture, and the AI's left and right are not asked. A camera that mirrors its picture
     * turns every left and right round, and still counts.
     */
    public function testTheTurnsAreReadFromTheAnglesOaiyMeasured(): void
    {
        // A camera above the screen: the straight-on picture looks down 12° and a little aside. `by` degrees each turn.
        $angles = fn (float $by, bool $mirrored = false, array $lost = [], ?float $tilt = null) => function (?array $asked, int $count, array $hints) use ($by, $mirrored, $lost, $tilt) {
            $side = $mirrored ? -$by : $by;
            $tilt ??= $by;
            $images = [];
            foreach ($hints as $i => $hint) {
                [$yaw, $pitch] = match ($hint) {
                    'center' => [5.0, -12.0],
                    'left' => [5.0 + $side, -12.0],
                    'right' => [5.0 - $side, -12.0],
                    'up' => [5.0, -12.0 + $tilt],
                    'down' => [5.0, -12.0 - $tilt],
                };
                $images[] = in_array($i, $lost, true) ? ['faces' => 0] : ['faces' => 1, 'age' => 35.0, 'yaw' => $yaw, 'pitch' => $pitch];
            }
            return ['task' => 'face-age', 'model' => 'mivolo-v2', 'detector' => 'yunet-2023mar', 'images' => $images];
        };
        $wrongWay = fn ($a) => self::turnAll($a, 'camera');

        // Turned as asked: a pass, though the AI said every face looked straight at it.
        [$check] = $this->check($wrongWay, null, true, $angles(15.0));
        self::assertSame('passed', $check['outcome']);
        self::assertSame('face_check_age_model', $this->gate->receiptsFor($this->memberId)[0]['method']);

        $cases = [
            'turns that did not go far enough' => [$angles(4.0), 'turns', 'did not go far enough'],
            'every turn the other way' => [$angles(-15.0), 'turns', 'the other way'],
            'a camera that mirrors its picture' => [$angles(15.0, true), 'passed', 'Done'],
            'a smaller tilt up or down: three quarters of a turn aside' => [$angles(15.0, false, [], 6.5), 'passed', 'Done'],
            'a face lost on the second turn' => [$angles(15.0, false, [2]), 'no_face', 'second turn'],
        ];
        foreach ($cases as $what => [$readings, $expected, $words]) {
            self::$pdo->prepare('DELETE FROM camera_checks WHERE user_id = ?')->execute([$this->memberId]);
            self::$pdo->prepare('DELETE FROM passes WHERE user_id = ?')->execute([$this->memberId]);
            [$check] = $this->check($wrongWay, null, true, $readings);
            self::assertSame($expected, $check['outcome'], $what);
            self::assertStringContainsString($words, (string) $check['message'], $what);
            self::assertStringNotContainsString('Measured', (string) $check['message'], 'a member is not shown the numbers');
        }

        // How far a turn must go is the site's setting.
        $this->plugins->setSettings('formlogic.age-gate', ['turnDegrees' => 20]);
        self::$pdo->prepare('DELETE FROM camera_checks WHERE user_id = ?')->execute([$this->memberId]);
        [$check] = $this->check(fn ($a) => $a, null, true, $angles(15.0));
        self::assertSame('turns', $check['outcome']);

        // The administrator trying it on themselves is told what each turn measured.
        [$check] = $this->check(fn ($a) => $a, null, true, $angles(15.0), true);
        self::assertSame('turns', $check['outcome']);
        self::assertMatchesRegularExpression('/Measured from the straight-on picture: (left|right|up|down) 15°, .* \(each needs 20° sideways, 15° up or down\)/', (string) $check['message']);
    }

    /**
     * What a real room gives a webcam: the AI misreads one picture as a screen, there is writing behind the person and
     * a poster face the detector leaves out, the AI counts two faces where the detector sees one. None of it is a
     * reason to refuse someone; with OAIY's detector its count decides, and only most pictures called a screen is one.
     */
    public function testAnOrdinaryRoomIsNotARefusal(): void
    {
        $ages = fn (?array $asked, int $count) => ['task' => 'face-age', 'images' => array_fill(0, $count, ['faces' => 1, 'age' => 35.0])];
        $cases = [
            'one picture misread as a screen' => [fn ($a) => self::set($a, 'screen_or_print', true), $ages],
            'the AI counts two faces where the detector sees one' => [fn ($a) => self::setAll($a, 'faces', 2), $ages],
            'writing held up, where the age model reads the age' => [fn ($a) => self::set($a, 'held_writing', true), $ages],
            'one picture misread as a screen, without the age model' => [fn ($a) => self::set($a, 'screen_or_print', true), null],
        ];
        foreach ($cases as $what => [$twist, $readings]) {
            self::$pdo->prepare('DELETE FROM camera_checks WHERE user_id = ?')->execute([$this->memberId]);
            self::$pdo->prepare('DELETE FROM passes WHERE user_id = ?')->execute([$this->memberId]);
            [$check] = $this->check($twist, null, true, $readings);
            self::assertSame('passed', $check['outcome'], $what . ': ' . $check['message']);
        }

        // The detector's own count, picture by picture, says which picture and what to do.
        $detector = fn (array $faces) => fn (?array $asked, int $count) => ['task' => 'face-age', 'images' => array_map(fn ($n) => $n === 1 ? ['faces' => 1, 'age' => 35.0] : ['faces' => $n], $faces)];
        foreach ([
            [[0, 1, 1, 1], "wasn't found in the first picture"],
            [[1, 2, 1, 1], 'More than one face was in your first turn'],
        ] as [$faces, $words]) {
            self::$pdo->prepare('DELETE FROM camera_checks WHERE user_id = ?')->execute([$this->memberId]);
            [$check] = $this->check(fn ($a) => $a, null, true, $detector($faces));
            self::assertSame('no_face', $check['outcome']);
            self::assertStringContainsString($words, (string) $check['message']);
        }
    }

    public function testWithoutOaiysAgeModelTheAisEstimateIsUsedUnlessTheSiteRequiresTheModel(): void
    {
        $missing = fn (?array $asked) => ['task' => 'face-age', 'error' => 'not_installed', 'message' => 'this OAIY has no age model'];
        // Preferred, not there: the AI's estimate, as before.
        [$check] = $this->check(fn ($a) => $a, null, true, $missing);
        self::assertSame('passed', $check['outcome']);
        self::assertSame('face_check', $this->gate->receiptsFor($this->memberId)[0]['method']);

        // Required: no face check without it, and not one of their tries.
        $this->plugins->setSettings('formlogic.age-gate', ['ageModel' => 'require']);
        self::$pdo->prepare('DELETE FROM camera_checks WHERE user_id = ?')->execute([$this->memberId]);
        self::$pdo->prepare('DELETE FROM passes WHERE user_id = ?')->execute([$this->memberId]);
        [$check] = $this->check(fn ($a) => $a, null, true, $missing);
        self::assertSame('unavailable', $check['outcome']);
        self::assertStringContainsString('age model', (string) $check['message']);
        self::assertSame('0', (string) self::$pdo->query('SELECT COUNT(*) FROM camera_checks WHERE submitted_at IS NOT NULL AND user_id = ' . self::$pdo->quote($this->memberId))->fetchColumn());
        // An OAIY that says nothing of it (older than the age check) is the same as none.
        self::$pdo->prepare('DELETE FROM camera_checks WHERE user_id = ?')->execute([$this->memberId]);
        [$check] = $this->check(fn ($a) => $a);
        self::assertSame('unavailable', $check['outcome']);
    }

    /**
     * OAIY has an age model and it did not read these pictures: that is no reason to settle for the AI alone, or
     * whoever could send a picture it cannot read would choose the weaker check. Nobody's try is spent on it.
     */
    public function testAnAgeModelThatDidNotReadThePicturesIsNotSettledWithout(): void
    {
        $said = fn (array $words) => fn (?array $asked) => ['task' => 'face-age'] + $words;
        $cases = [
            'it failed' => $said(['error' => 'failed', 'message' => 'the worker ran out of time']),
            'a picture it would not read' => $said(['error' => 'invalid', 'message' => 'not a picture']),
            'an answer for too few pictures' => fn (?array $asked, int $count) => ['task' => 'face-age', 'images' => array_fill(0, $count - 1, ['faces' => 1, 'age' => 35.0])],
        ];
        foreach ($cases as $what => $readings) {
            self::$pdo->prepare('DELETE FROM camera_checks WHERE user_id = ?')->execute([$this->memberId]);
            [$check] = $this->check(fn ($a) => $a, null, true, $readings);
            self::assertSame('unavailable', $check['outcome'], $what);
            self::assertSame(3, $check['attemptsLeft'], $what);
        }
        self::assertSame([], $this->gate->receiptsFor($this->memberId), 'none of these recorded a pass');

        // An OAIY that does not know the task has no age model, which is the case the AI stands in for.
        self::$pdo->prepare('DELETE FROM camera_checks WHERE user_id = ?')->execute([$this->memberId]);
        [$check] = $this->check(fn ($a) => $a, null, true, $said(['error' => 'unknown_task', 'message' => 'this OAIY does not check it']));
        self::assertSame('passed', $check['outcome']);
        self::assertSame('face_check', $this->gate->receiptsFor($this->memberId)[0]['method']);
    }

    /**
     * Nothing else looks for a screen, and nothing else says it is one person: an answer that leaves those out, or
     * says them in some other way, did not do that part of the check. Never read as "no", or held against the person.
     */
    public function testAnAnswerThatDoesNotSayIsNotCountedEitherWay(): void
    {
        $ages = fn (?array $asked, int $count) => ['task' => 'face-age', 'images' => array_fill(0, $count, ['faces' => 1, 'age' => 35.0])];
        $partly = function (?array $asked, int $count, array $hints) {
            $images = [];
            foreach ($hints as $i => $hint) {
                $images[] = ['faces' => 1, 'age' => 35.0] + ($i === 1 ? [] : ['yaw' => 0.0, 'pitch' => 0.0]);
            }
            return ['task' => 'face-age', 'images' => $images];
        };
        $cases = [
            'no word on a screen, with the age model' => [fn ($a) => self::setAll($a, 'screen_or_print', null), $ages],
            'no word on a screen, without it' => [fn ($a) => self::setAll($a, 'screen_or_print', null), null],
            'a screen said in words' => [fn ($a) => self::setAll($a, 'screen_or_print', 'true'), $ages],
            'no word on writing, where the AI alone reads the age' => [fn ($a) => self::setAll($a, 'held_writing', null), null],
            'no word on one person' => [function ($a) { unset($a['same_person']); return $a; }, $ages],
            'no count from the AI, without the age model' => [fn ($a) => self::setAll($a, 'faces', null), null],
            'no count from the detector' => [fn ($a) => $a, fn (?array $asked, int $count) => ['task' => 'face-age', 'images' => array_fill(0, $count, ['age' => 35.0])]],
            'angles in some pictures and not others' => [fn ($a) => $a, $partly],
        ];
        foreach ($cases as $what => [$twist, $readings]) {
            self::$pdo->prepare('DELETE FROM camera_checks WHERE user_id = ?')->execute([$this->memberId]);
            [$check] = $this->check($twist, null, true, $readings);
            self::assertSame('unavailable', $check['outcome'], $what . ': ' . $check['message']);
            self::assertSame(3, $check['attemptsLeft'], $what);
        }
        self::assertSame([], $this->gate->receiptsFor($this->memberId));

        // With the age model reading the age, writing is no longer the AI's to weigh, so it need not say.
        self::$pdo->prepare('DELETE FROM camera_checks WHERE user_id = ?')->execute([$this->memberId]);
        [$check] = $this->check(fn ($a) => self::setAll($a, 'held_writing', null), null, true, $ages);
        self::assertSame('passed', $check['outcome']);
    }

    public function testATurnThatFellShortIsNamedWhicheverWayTheCameraReads(): void
    {
        // A camera that mirrors its picture, with the third turn short: the turn named is that one, not the first.
        $mirrored = function (?array $asked, int $count, array $hints) {
            $images = [];
            foreach ($hints as $i => $hint) {
                $by = $i === 3 ? 2.0 : 15.0;
                [$yaw, $pitch] = match ($hint) {
                    'center' => [0.0, 0.0],
                    'left' => [-$by, 0.0],
                    'right' => [$by, 0.0],
                    'up' => [0.0, $by],
                    'down' => [0.0, -$by],
                };
                $images[] = ['faces' => 1, 'age' => 35.0, 'yaw' => $yaw, 'pitch' => $pitch];
            }
            return ['task' => 'face-age', 'images' => $images];
        };
        $this->plugins->setSettings('formlogic.age-gate', ['turns' => 'all']);
        for ($tries = 0; $tries < 12; $tries++) {
            self::$pdo->prepare('DELETE FROM camera_checks WHERE user_id = ?')->execute([$this->memberId]);
            [$check] = $this->check(fn ($a) => $a, null, true, $mirrored);
            if ($check['outcome'] === 'turns' && str_contains((string) $check['message'], 'third turn')) {
                self::assertStringContainsString('did not go far enough', (string) $check['message']);
                return;
            }
            // Turns that were up and down alone read the same either way, and a mirrored left first is what this is about.
            self::assertSame('turns', $check['outcome']);
        }
        self::fail('The short turn was never named as the third.');
    }

    public function testAnAdministratorsTrialLeavesNoMarkOnTheirOwnRealCheck(): void
    {
        [$check] = $this->check(fn ($a) => ['age_low' => 12, 'age_estimate' => 14] + $a, null, true, null, true);
        self::assertSame('not_confirmed', $check['outcome']);
        $started = $this->checks->start($this->adminId, 'formlogic.age-gate', $this->slug, 'age');
        self::assertSame('started', $started['status']);
    }

    public function testAnotherAdministratorsTrialIsTheirsAndIsNotHandedToAComputerWhoseOwnerWasDemoted(): void
    {
        $other = $this->makeUser();
        self::$pdo->prepare('UPDATE users SET is_admin = 1 WHERE id = ?')->execute([$other]);
        $started = $this->checks->startTrial($other, 'formlogic.age-gate', 18);
        $frames = array_map(fn () => 'data:image/jpeg;base64,' . base64_encode("\xFF\xD8\xFF\xE0" . random_bytes(40000)), $started['steps']);
        $this->checks->submit($other, $started['id'], $frames);
        // The other administrator's own face, queued for this one's computer: theirs, not the computer owner's.
        $row = self::$pdo->query('SELECT requesting_user_id FROM desktop_ai_requests WHERE owner_user_id = ' . self::$pdo->quote($this->adminId))->fetchColumn();
        self::assertSame($other, $row);
        self::$pdo->prepare('UPDATE users SET is_admin = 0 WHERE id = ?')->execute([$this->adminId]);
        try {
            self::assertSame([], $this->relay->listPending($this->adminId, null, 10, 'inst-camera'), 'nor handed to it once its owner is demoted');
        } finally {
            self::$pdo->prepare('UPDATE users SET is_admin = 1 WHERE id = ?')->execute([$this->adminId]);
        }
    }

    public function testWhatTheModelSaysIsReadAsItsDescriptionAndNothingMore(): void
    {
        $cases = [
            'a wrong control digit: the pictures did not reach it' => [fn ($a) => self::control($a, 1), 'unavailable'],
            'a model that says the check passed, with the wrong turns' => [fn ($a) => ['passed' => true, 'verdict' => 'pass'] + self::turnAll($a, 'up'), 'turns'],
            'two faces' => [fn ($a) => self::set($a, 'faces', 2), 'no_face'],
            'writing held up to the camera' => [fn ($a) => self::set($a, 'held_writing', true), 'not_live'],
            'a face on a screen in most pictures' => [fn ($a) => self::setAll($a, 'screen_or_print', true), 'not_live'],
            'not the same person' => [fn ($a) => ['same_person' => false] + $a, 'not_same'],
            'old enough, but not by the buffer' => [fn ($a) => ['age_low' => 21, 'age_estimate' => 24] + $a, 'stronger_check'],
            'one entry missing' => [fn ($a) => ['images' => array_slice($a['images'], 1)] + $a, 'unavailable'],
            // Seen with a real model on a test pattern: every picture called the control.
            'a camera picture taken for the control' => [fn ($a) => self::set($a, 'kind', 'control'), 'unavailable'],
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

    public function testTwoAsksAtOnceDecideItOnce(): void
    {
        [, , $id] = $this->check(fn (array $honest) => $honest, null, false);
        // Another ask is deciding it: this one reads it as still being checked, and asks the plugin nothing.
        self::$pdo->prepare("UPDATE camera_checks SET status = 'deciding' WHERE id = ?")->execute([$id]);
        self::assertSame('assessing', $this->checks->status($this->memberId, $id)['status']);
        self::assertSame([], $this->gate->receiptsFor($this->memberId));
        self::$pdo->prepare("UPDATE camera_checks SET status = 'assessing' WHERE id = ?")->execute([$id]);
        $first = $this->checks->status($this->memberId, $id);
        $again = $this->checks->status($this->memberId, $id);
        self::assertSame(['done', 'passed', 'done', 'passed'], [$first['status'], $first['outcome'], $again['status'], $again['outcome']]);
        self::assertCount(1, $this->gate->receiptsFor($this->memberId), 'one pass');
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

    public function testChecksStartedSideBySideAreHeldToTheLimitsWhenSent(): void
    {
        // Two starts at the same moment both pass start()'s limits before either is written: as
        // that leaves them, both started.
        $first = $this->checks->start($this->memberId, 'formlogic.age-gate', $this->slug, 'age');
        $second = $this->checks->start($this->memberId, 'formlogic.age-gate', $this->slug, 'age');
        $turn = self::$pdo->query('SELECT turn FROM camera_checks WHERE id = ' . self::$pdo->quote($second['id']))->fetchColumn();
        self::$pdo->prepare("UPDATE camera_checks SET status = 'started', outcome = NULL, finished_at = NULL, turn = ? WHERE id = ?")->execute([$turn, $first['id']]);
        $frames = fn (array $started) => array_map(fn () => 'data:image/jpeg;base64,' . base64_encode("\xFF\xD8\xFF\xE0" . random_bytes(40000)), $started['steps']);
        $refused = function (array $started, string $words) use ($frames): void {
            try {
                $this->checks->submit($this->memberId, $started['id'], $frames($started));
                self::fail("sent past the limit: $words");
            } catch (\InvalidArgumentException $e) {
                self::assertStringContainsString($words, $e->getMessage());
            }
            self::assertSame('started', self::$pdo->query('SELECT status FROM camera_checks WHERE id = ' . self::$pdo->quote($started['id']))->fetchColumn(), 'and not claimed');
        };

        $this->checks->submit($this->memberId, $first['id'], $frames($first));
        $refused($second, 'still being looked at');
        // The first comes back "not_confirmed": the second waits the hour like any other.
        self::$pdo->prepare("UPDATE camera_checks SET status = 'done', outcome = 'not_confirmed', finished_at = ? WHERE id = ?")->execute([gmdate('Y-m-d H:i:s'), $first['id']]);
        $refused($second, 'an hour');
        // And with today's tries used, it is not one more.
        self::$pdo->prepare("UPDATE camera_checks SET outcome = 'turns' WHERE id = ?")->execute([$first['id']]);
        foreach ([1, 2] as $n) {
            self::$pdo->prepare("INSERT INTO camera_checks (id, user_id, mode, plugin_id, app_id, kind, min_value, steps, turn, status, outcome, created_at, expires_at, submitted_at, finished_at)
                VALUES (?, ?, 'member', 'formlogic.age-gate', NULL, 'age', 18, '[]', NULL, 'done', 'turns', ?, ?, ?, ?)")
                ->execute([bin2hex(random_bytes(16)), $this->memberId, $now = gmdate('Y-m-d H:i:s'), $now, $now, $now]);
        }
        $refused($second, 'today');
    }

    /**
     * The same, sent at the same moment rather than one after the other. One send has taken the
     * member's lock and claimed its check, but not yet committed; the other, in its own process
     * and connection, must wait for that lock, then see the first one's claim and be refused.
     * Without the lock, it reads the limits before the first claim is visible and is sent too.
     */
    public function testTwoChecksSentAtTheSameMomentAreTakenOneAtATime(): void
    {
        $first = $this->checks->start($this->memberId, 'formlogic.age-gate', $this->slug, 'age');
        $second = $this->checks->start($this->memberId, 'formlogic.age-gate', $this->slug, 'age');
        $turn = self::$pdo->query('SELECT turn FROM camera_checks WHERE id = ' . self::$pdo->quote($second['id']))->fetchColumn();
        self::$pdo->prepare("UPDATE camera_checks SET status = 'started', outcome = NULL, finished_at = NULL, turn = ? WHERE id = ?")->execute([$turn, $first['id']]);

        // The first send, inside its lock: the member's row held and its check claimed, not yet committed.
        $other = new PDO(
            sprintf('mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4', self::$config['host'], self::$config['port'], self::$config['database']),
            self::$config['username'],
            self::$config['password'],
            [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
        );
        $other->beginTransaction();
        $other->prepare('SELECT id FROM users WHERE id = ? FOR UPDATE')->execute([$this->memberId]);
        $other->prepare("UPDATE camera_checks SET status = 'sending' WHERE id = ? AND status = 'started'")->execute([$first['id']]);

        // The second send, in a process of its own: the service's own claim, as submit() makes it.
        $script = tempnam(sys_get_temp_dir(), 'fl-camera-');
        file_put_contents($script, '<?php require $argv[1]; $c = json_decode($argv[2], true);'
            . ' $pdo = (new FormLogic\Database\MySQLConnection($c))->getConnection();'
            . ' $service = (new ReflectionClass(FormLogic\Services\CameraCheckService::class))->newInstanceWithoutConstructor();'
            . ' (new ReflectionProperty($service, "pdo"))->setValue($service, $pdo);'
            . ' $row = $pdo->query("SELECT * FROM camera_checks WHERE id = " . $pdo->quote($argv[3]))->fetch(PDO::FETCH_ASSOC);'
            . ' try { (new ReflectionMethod($service, "claimWithinLimits"))->invoke($service, $row); echo "sent"; }'
            . ' catch (InvalidArgumentException $e) { echo "refused: ", $e->getMessage(); }');
        $send = proc_open(
            [PHP_BINARY, '-d', 'xdebug.mode=off', $script, dirname(__DIR__, 2) . '/vendor/autoload.php', (string) json_encode(self::$config), $second['id']],
            [1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
            $pipes
        );
        self::assertIsResource($send);
        try {
            // Until the second is waiting on the lock, or has finished without waiting.
            $waiting = $other->prepare("SELECT COUNT(*) FROM information_schema.processlist WHERE db = DATABASE() AND info LIKE 'SELECT id FROM users WHERE id = % FOR UPDATE'");
            for ($i = 0; $i < 600; $i++) { // up to 30 s for the process to start
                usleep(50000);
                $waiting->execute();
                if ((int) $waiting->fetchColumn() > 0 || !proc_get_status($send)['running']) {
                    break;
                }
            }
            $other->commit();
            $out = stream_get_contents($pipes[1]);
            $err = stream_get_contents($pipes[2]);
            self::assertSame(0, proc_close($send), $err);
            $send = null;
        } finally {
            if ($other->inTransaction()) {
                $other->rollBack();
            }
            if (is_resource($send)) {
                proc_terminate($send);
                proc_close($send);
            }
            @unlink($script);
        }
        self::assertStringContainsString('refused: Your last check is still being looked at', $out, 'both were sent');
        self::assertSame('started', self::$pdo->query('SELECT status FROM camera_checks WHERE id = ' . self::$pdo->quote($second['id']))->fetchColumn(), 'and not claimed');
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
    private function check(\Closure $twist, ?string $raw = null, bool $ask = true, ?\Closure $readings = null, bool $trial = false): array
    {
        $who = $trial ? $this->adminId : $this->memberId;
        $started = $trial
            ? $this->checks->startTrial($this->adminId, 'formlogic.age-gate', 18)
            : $this->checks->start($this->memberId, 'formlogic.age-gate', $this->slug, 'age');
        self::assertSame('started', $started['status']);
        $steps = $started['steps'];
        self::assertSame('center', $steps[0]['hint']);
        $frames = array_map(fn () => 'data:image/jpeg;base64,' . base64_encode("\xFF\xD8\xFF\xE0" . random_bytes(40000)), $steps);
        $this->checks->submit($who, $started['id'], $frames);

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
                ? ['image' => count($images) + 1, 'kind' => 'control', 'digit' => $digit, 'faces' => 0, 'facing' => null, 'screen_or_print' => false, 'held_writing' => false]
                : ['image' => count($images) + 1, 'kind' => 'camera', 'digit' => null, 'faces' => 1, 'facing' => self::IN_PICTURE[$steps[$camera++]['hint']], 'screen_or_print' => false, 'held_writing' => false];
        }
        $honest = ['images' => $images, 'same_person' => true, 'age_estimate' => 34, 'age_low' => 29];
        $content = $raw ?? "```json\n" . json_encode($twist($honest)) . "\n```";
        $this->relay->appendFrame($claimed['requestId'], $this->adminId, SiteDesktopAi::seal(['kind' => 'delta', 'delta' => $content], 1, 0, $pair), 'inst-camera');
        // OAIY's age model, where the test gives it readings: for the pictures the turn named, as OAIY answers.
        $final = ['kind' => 'final'];
        if ($readings !== null) {
            $final['verification'] = $readings($turn['verify'] ?? null, count($steps), array_column($steps, 'hint'));
        }
        $this->relay->appendFrame($claimed['requestId'], $this->adminId, SiteDesktopAi::seal($final, 1, 1, $pair), 'inst-camera');
        $this->relay->complete($claimed['requestId'], $this->adminId, ['status' => 'done', 'instanceId' => 'inst-camera']);
        if (!$ask) {
            return [null, $turn, $started['id']];
        }

        $status = $this->checks->status($who, $started['id']);
        self::assertSame('done', $status['status']);
        if (!$trial) {
            self::assertArrayNotHasKey('answer', $status, 'a member never sees the model\'s answer');
        }
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

    private static function setAll(array $answer, string $field, mixed $value): array
    {
        foreach ($answer['images'] as $i => $image) {
            if ($image['kind'] === 'camera') {
                $answer['images'][$i][$field] = $value;
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

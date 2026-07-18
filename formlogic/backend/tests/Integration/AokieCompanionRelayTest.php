<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\AokieCompanionRelayController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AokieCompanionAdmissionSigner;
use FormLogic\Services\AokieCompanionRelayService;
use FormLogic\Services\AppService;
use FormLogic\Services\FormService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Factory\StreamFactory;

/**
 * Hosted Companion relay (pack services wave 2): admission-bearer auth, opaque
 * frame store-and-forward, targeted delivery, cursor semantics, TTL sweep,
 * backpressure, and the wave-1 service-toggle gate.
 */
final class AokieCompanionRelayTest extends TestCase
{
    private const BASE = 'http://localhost';
    private const SECRET = '0123456789abcdef0123456789abcdef';
    private const PLUGIN_THUMBPRINT = 'FtIu-VbGrfe_KB6CH7GNwODB72MNxj_ml11dEvO-7kk';

    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static AppService $apps;
    private static SQLiteConnection $sqlite;
    private static AokieCompanionAdmissionSigner $signer;
    private static AokieCompanionRelayService $relay;
    private static AokieCompanionRelayController $controller;

    private string $userId = '';
    private string $appId = '';

    public static function setUpBeforeClass(): void
    {
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) {
            \Dotenv\Dotenv::createImmutable($root)->safeLoad();
        }
        $_ENV['APP_ENV'] = 'development';
        putenv('APP_ENV=development');
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
            $connection = new MySQLConnection($config);
            $connection->getConnection()->query('SELECT 1');
            $connection->initializeSchema();
            $connection->runMigrations();
        } catch (\Throwable $error) {
            self::markTestSkipped('No test database available: ' . $error->getMessage());
        }
        self::$mysql = $connection;
        self::$pdo = $connection->getConnection();
        self::$sqlite = new SQLiteConnection(sys_get_temp_dir() . '/formlogic-aokie-relay-' . bin2hex(random_bytes(4)));
        self::$apps = new AppService($connection, new FormService($connection, self::$sqlite));
        self::$signer = new AokieCompanionAdmissionSigner(self::SECRET, 'ws://127.0.0.1:39000/v2/realtime');
        self::$relay = new AokieCompanionRelayService($connection);
        self::$controller = new AokieCompanionRelayController(self::$signer, self::$apps, self::$relay);
    }

    protected function setUp(): void
    {
        if (self::$pdo === null) {
            $this->markTestSkipped('No test database');
        }
        $suffix = bin2hex(random_bytes(8));
        $this->userId = 'u-' . $suffix;
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'Owner')")
            ->execute([$this->userId, $suffix . '@relay.test']);
        $app = self::$apps->createApp([
            'name' => 'Relay Test ' . $suffix,
            'slug' => 'relay-test-' . $suffix,
            'status' => 'published',
        ], $this->userId);
        $this->appId = (string) $app['id'];
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null || $this->userId === '') {
            return;
        }
        // aokie_companion_relay_frames cascades on the app delete.
        self::$pdo->prepare('DELETE FROM app_users WHERE user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM apps WHERE owner_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
    }

    private static function decode(ResponseInterface $response): array
    {
        $response->getBody()->rewind();
        return json_decode((string) $response->getBody(), true) ?: [];
    }

    private function mobileThumbprint(string $deviceId): string
    {
        $publicKey = rtrim(strtr(base64_encode(hash('sha256', 'mobile:' . $deviceId, true)), '+/', '-_'), '=');
        return AokieCompanionAdmissionSigner::endpointThumbprint($publicKey);
    }

    /** @param list<string> $approvedMobileThumbprints */
    private function pluginToken(array $approvedMobileThumbprints, ?int $now = null): string
    {
        sort($approvedMobileThumbprints, SORT_STRING);
        return (string) self::$signer->issue(
            $this->appId,
            'aokie',
            'plugin',
            ['state_read', 'rtc_signal'],
            self::PLUGIN_THUMBPRINT,
            null,
            $approvedMobileThumbprints,
            1,
            AokieCompanionAdmissionSigner::peerRosterHash(1, $approvedMobileThumbprints),
            90,
            $now,
        )['accessToken'];
    }

    private function mobileToken(string $deviceId, ?int $now = null): string
    {
        return (string) self::$signer->issue(
            $this->appId,
            $deviceId,
            'mobile',
            ['state_read', 'rtc_signal'],
            $this->mobileThumbprint($deviceId),
            self::PLUGIN_THUMBPRINT,
            [],
            null,
            null,
            90,
            $now,
        )['accessToken'];
    }

    private function request(string $method, string $path, ?string $bearer): ServerRequestInterface
    {
        $request = (new ServerRequestFactory())->createServerRequest($method, self::BASE . $path);
        return $bearer === null ? $request : $request->withHeader('Authorization', 'Bearer ' . $bearer);
    }

    private function postRaw(?string $bearer, string $json): ResponseInterface
    {
        return self::$controller->postFrames(
            $this->request('POST', '/api/aokie-companion/relay/frames', $bearer)
                ->withHeader('Content-Type', 'application/json')
                ->withBody((new StreamFactory())->createStream($json)),
            (new ResponseFactory())->createResponse(),
        );
    }

    private function post(?string $bearer, array $body): ResponseInterface
    {
        return $this->postRaw($bearer, (string) json_encode($body, JSON_UNESCAPED_SLASHES));
    }

    private function poll(?string $bearer, array $query = [], string $lastEventId = ''): ResponseInterface
    {
        $request = $this->request('GET', '/api/aokie-companion/relay/frames', $bearer)
            ->withQueryParams($query);
        if ($lastEventId !== '') {
            $request = $request->withHeader('Last-Event-ID', $lastEventId);
        }
        return self::$controller->pollFrames($request, (new ResponseFactory())->createResponse());
    }

    private function setRelayService(bool $enabled): void
    {
        $app = self::$apps->getApp($this->appId);
        $settings = is_array($app['settings'] ?? null) ? $app['settings'] : [];
        $settings['services'] = ['companion-relay' => [
            'enabled' => $enabled,
            'title' => 'Companion app relay',
            'description' => 'Relay for the Companion app',
        ]];
        self::$apps->updateApp($this->appId, ['settings' => $settings]);
    }

    public function testMobileToPluginDeliveryWithAdvancingSinceCursor(): void
    {
        $deviceId = 'device_' . bin2hex(random_bytes(4));
        $mobile = $this->mobileToken($deviceId);
        $plugin = $this->pluginToken([$this->mobileThumbprint($deviceId)]);

        $posted = $this->post($mobile, ['to' => 'plugin', 'frames' => [
            ['v' => 2, 'kind' => 'hello', 'n' => 1],
            ['v' => 2, 'kind' => 'sdp-offer', 'n' => 2],
            ['v' => 2, 'kind' => 'ice', 'n' => 3],
        ]]);
        $postedBody = self::decode($posted);
        $this->assertSame(200, $posted->getStatusCode(), json_encode($postedBody));
        $this->assertSame(3, $postedBody['accepted']);
        $this->assertIsInt($postedBody['seq']);

        $polled = $this->poll($plugin, ['since' => 0]);
        $body = self::decode($polled);
        $this->assertSame(200, $polled->getStatusCode(), json_encode($body));
        $this->assertCount(3, $body['frames']);
        $mobileParty = 'mobile:' . $this->mobileThumbprint($deviceId);
        $seqs = [];
        foreach ($body['frames'] as $index => $frame) {
            $this->assertSame($mobileParty, $frame['from']);
            $this->assertSame($index + 1, $frame['frame']['n']);
            $seqs[] = $frame['seq'];
        }
        $sorted = $seqs;
        sort($sorted);
        $this->assertSame($sorted, $seqs, 'frames arrive oldest-first');
        $this->assertSame($postedBody['seq'], $body['lastSeq']);
        $this->assertSame(max($seqs), $body['lastSeq']);

        // The since cursor consumes: a second poll from lastSeq is empty.
        $again = self::decode($this->poll($plugin, ['since' => $body['lastSeq']]));
        $this->assertSame([], $again['frames']);
        $this->assertSame($body['lastSeq'], $again['lastSeq']);

        // Last-Event-ID (SSE reconnect) takes precedence over ?since=.
        $viaHeader = self::decode($this->poll($plugin, ['since' => 0], (string) $body['lastSeq']));
        $this->assertSame([], $viaHeader['frames']);
    }

    public function testPluginToMobileDeliveryIsTargetedPerParty(): void
    {
        $deviceA = 'device_a_' . bin2hex(random_bytes(4));
        $deviceB = 'device_b_' . bin2hex(random_bytes(4));
        $thumbA = $this->mobileThumbprint($deviceA);
        $thumbB = $this->mobileThumbprint($deviceB);
        $plugin = $this->pluginToken([$thumbA, $thumbB]);

        $posted = $this->post($plugin, [
            'to' => 'mobile:' . $thumbA,
            'frames' => [['v' => 2, 'kind' => 'takeover-offer']],
        ]);
        $this->assertSame(200, $posted->getStatusCode(), (string) $posted->getBody());

        $forA = self::decode($this->poll($this->mobileToken($deviceA), ['since' => 0]));
        $this->assertCount(1, $forA['frames']);
        $this->assertSame('plugin', $forA['frames'][0]['from']);
        $this->assertSame('takeover-offer', $forA['frames'][0]['frame']['kind']);

        // The second mobile party must NOT receive the targeted frame.
        $forB = self::decode($this->poll($this->mobileToken($deviceB), ['since' => 0]));
        $this->assertSame([], $forB['frames']);
    }

    public function testFramesStayOpaqueIncludingEmptyJsonObjects(): void
    {
        $deviceId = 'device_' . bin2hex(random_bytes(4));
        $mobile = $this->mobileToken($deviceId);
        $plugin = $this->pluginToken([$this->mobileThumbprint($deviceId)]);

        // Raw JSON keeps {} an OBJECT end to end — PHP assoc parsing would
        // silently rewrite it as []; the relay must never do that to a frame
        // the endpoints signed.
        $posted = $this->postRaw(
            $mobile,
            '{"to":"plugin","frames":[{"sig":"abc","payload":{},"list":[],"nested":{"empty":{}}}, "bare-string", 17]}',
        );
        $this->assertSame(200, $posted->getStatusCode(), (string) $posted->getBody());

        $polled = $this->poll($plugin, ['since' => 0]);
        $polled->getBody()->rewind();
        $raw = (string) $polled->getBody();
        $this->assertStringContainsString('"payload":{}', $raw);
        $this->assertStringContainsString('"list":[]', $raw);
        $this->assertStringContainsString('"empty":{}', $raw);
        $this->assertStringContainsString('"frame":"bare-string"', $raw);
        $this->assertStringContainsString('"frame":17', $raw);
    }

    public function testAuthRefusalsAreTypedAndFailClosed(): void
    {
        $deviceId = 'device_' . bin2hex(random_bytes(4));
        $frames = ['to' => 'plugin', 'frames' => [['v' => 2]]];

        $missing = $this->post(null, $frames);
        $this->assertSame(401, $missing->getStatusCode());
        $this->assertSame('invalid_token', self::decode($missing)['code']);

        $garbage = $this->post('not-an-admission-token', $frames);
        $this->assertSame(401, $garbage->getStatusCode());
        $this->assertSame('invalid_token', self::decode($garbage)['code']);

        // Expired admission (minted in the past, beyond the skew allowance).
        $expired = $this->post($this->mobileToken($deviceId, time() - 4000), $frames);
        $this->assertSame(401, $expired->getStatusCode());
        $this->assertSame('invalid_token', self::decode($expired)['code']);

        $pollMissing = $this->poll(null);
        $this->assertSame(401, $pollMissing->getStatusCode());
        $this->assertSame('invalid_token', self::decode($pollMissing)['code']);

        // A token for a DELETED (unpublished) app fails on the app gate.
        self::$apps->updateApp($this->appId, ['status' => 'draft']);
        try {
            $unpublished = $this->post($this->mobileToken($deviceId), $frames);
            $this->assertSame(403, $unpublished->getStatusCode());
            $this->assertSame('forbidden', self::decode($unpublished)['code']);
        } finally {
            self::$apps->updateApp($this->appId, ['status' => 'published']);
        }

        // No configured signer = the relay is unavailable, never open.
        $unconfigured = new AokieCompanionRelayController(null, self::$apps, self::$relay);
        $response = $unconfigured->postFrames(
            $this->request('POST', '/api/aokie-companion/relay/frames', $this->mobileToken($deviceId))
                ->withBody((new StreamFactory())->createStream((string) json_encode($frames))),
            (new ResponseFactory())->createResponse(),
        );
        $this->assertSame(503, $response->getStatusCode());
        $this->assertSame('companion_unavailable', self::decode($response)['code']);
    }

    public function testServiceToggleGatesEveryRelayEndpoint(): void
    {
        $deviceId = 'device_' . bin2hex(random_bytes(4));
        $mobile = $this->mobileToken($deviceId);
        $this->setRelayService(false);
        try {
            $posted = $this->post($mobile, ['to' => 'plugin', 'frames' => [['v' => 2]]]);
            $this->assertSame(403, $posted->getStatusCode());
            $this->assertSame('service_disabled', self::decode($posted)['code']);

            $polled = $this->poll($mobile);
            $this->assertSame(403, $polled->getStatusCode());
            $this->assertSame('service_disabled', self::decode($polled)['code']);
        } finally {
            $this->setRelayService(true);
        }
        $restored = $this->post($mobile, ['to' => 'plugin', 'frames' => [['v' => 2]]]);
        $this->assertSame(200, $restored->getStatusCode(), (string) $restored->getBody());
    }

    public function testDirectionAndPayloadValidation(): void
    {
        $deviceId = 'device_' . bin2hex(random_bytes(4));
        $otherThumb = $this->mobileThumbprint('device_other');
        $mobile = $this->mobileToken($deviceId);
        $plugin = $this->pluginToken([$this->mobileThumbprint($deviceId), $otherThumb]);

        // A mobile may only send to the plugin.
        $mobileToMobile = $this->post($mobile, [
            'to' => 'mobile:' . $otherThumb,
            'frames' => [['v' => 2]],
        ]);
        $this->assertSame(403, $mobileToMobile->getStatusCode());
        $this->assertSame('relay_target_forbidden', self::decode($mobileToMobile)['code']);

        // The plugin never sends to itself.
        $pluginToPlugin = $this->post($plugin, ['to' => 'plugin', 'frames' => [['v' => 2]]]);
        $this->assertSame(403, $pluginToPlugin->getStatusCode());
        $this->assertSame('relay_target_forbidden', self::decode($pluginToPlugin)['code']);

        // Malformed target party / body shapes.
        foreach ([
            ['to' => 'operator', 'frames' => [['v' => 2]]],
            ['to' => 'mobile:junk', 'frames' => [['v' => 2]]],
            ['frames' => [['v' => 2]]],
            ['to' => 'plugin'],
            ['to' => 'plugin', 'frames' => []],
            ['to' => 'plugin', 'frames' => array_fill(0, 65, ['v' => 2])],
        ] as $body) {
            $invalid = $this->post($mobile, $body);
            $this->assertSame(400, $invalid->getStatusCode(), json_encode($body));
            $this->assertSame('invalid_request', self::decode($invalid)['code']);
        }
        $notJson = $this->postRaw($mobile, 'not json');
        $this->assertSame(400, $notJson->getStatusCode());

        // Oversize frame: >32KB serialized is refused with a typed 413.
        $oversize = $this->post($mobile, ['to' => 'plugin', 'frames' => [
            ['blob' => str_repeat('x', AokieCompanionRelayService::MAX_FRAME_BYTES + 1)],
        ]]);
        $this->assertSame(413, $oversize->getStatusCode());
        $this->assertSame('relay_frame_too_large', self::decode($oversize)['code']);
    }

    public function testBackpressureRefusesOverCapWithTyped429(): void
    {
        $deviceId = 'device_' . bin2hex(random_bytes(4));
        $mobile = $this->mobileToken($deviceId);
        $batch = array_fill(0, AokieCompanionRelayService::MAX_FRAMES_PER_POST, ['v' => 2, 'kind' => 'flood']);
        $posts = intdiv(
            AokieCompanionRelayService::MAX_LIVE_FRAMES_PER_APP,
            AokieCompanionRelayService::MAX_FRAMES_PER_POST,
        );
        for ($i = 0; $i < $posts; $i++) {
            $ok = $this->post($mobile, ['to' => 'plugin', 'frames' => $batch]);
            $this->assertSame(200, $ok->getStatusCode(), (string) $ok->getBody());
        }
        $over = $this->post($mobile, ['to' => 'plugin', 'frames' => [['v' => 2]]]);
        $this->assertSame(429, $over->getStatusCode());
        $this->assertSame('relay_backpressure', self::decode($over)['code']);
    }

    public function testExpiredFramesAreSweptAndNeverServed(): void
    {
        $deviceId = 'device_' . bin2hex(random_bytes(4));
        $mobile = $this->mobileToken($deviceId);
        $plugin = $this->pluginToken([$this->mobileThumbprint($deviceId)]);

        $stale = $this->post($mobile, ['to' => 'plugin', 'frames' => [['v' => 2, 'kind' => 'stale']]]);
        $this->assertSame(200, $stale->getStatusCode());
        self::$pdo->prepare(
            'UPDATE aokie_companion_relay_frames
             SET created_at = NOW(3) - INTERVAL 600 SECOND
             WHERE app_id = ?',
        )->execute([$this->appId]);

        // Even before any sweep runs, reads exclude expired rows.
        $unswept = self::decode($this->poll($plugin, ['since' => 0]));
        $this->assertSame([], $unswept['frames']);

        // The next POST sweeps them from storage entirely.
        $fresh = $this->post($mobile, ['to' => 'plugin', 'frames' => [['v' => 2, 'kind' => 'fresh']]]);
        $this->assertSame(200, $fresh->getStatusCode());
        $count = self::$pdo->prepare('SELECT COUNT(*) FROM aokie_companion_relay_frames WHERE app_id = ?');
        $count->execute([$this->appId]);
        $this->assertSame(1, (int) $count->fetchColumn(), 'expired rows are deleted by the sweep');

        $polled = self::decode($this->poll($plugin, ['since' => 0]));
        $this->assertCount(1, $polled['frames']);
        $this->assertSame('fresh', $polled['frames'][0]['frame']['kind']);
    }
}

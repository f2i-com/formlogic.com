<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Constants\AppPermissions;
use FormLogic\Controllers\AokieCompanionRelayController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AokieCompanionAdmissionSigner;
use FormLogic\Services\AokieCompanionDeviceService;
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
    private static AokieCompanionDeviceService $devices;
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
        self::$devices = new AokieCompanionDeviceService($connection);
        self::$relay = new AokieCompanionRelayService($connection);
        self::$controller = new AokieCompanionRelayController(
            self::$signer,
            self::$apps,
            self::$relay,
            self::$devices,
        );
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
            'settings' => [
                'aokieCompanion' => [
                    'remoteConsent' => [
                        'remoteMonitoring' => true,
                        'remoteConsult' => true,
                        'remoteTakeover' => true,
                        'remoteCaptions' => true,
                        'remoteAssistance' => true,
                    ],
                ],
            ],
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
    private function pluginToken(
        array $approvedMobileThumbprints,
        ?int $now = null,
        ?array $scopes = null,
    ): string
    {
        sort($approvedMobileThumbprints, SORT_STRING);
        return (string) self::$signer->issue(
            $this->appId,
            'aokie',
            'plugin',
            $scopes ?? ['state_read', 'rtc_signal'],
            self::PLUGIN_THUMBPRINT,
            null,
            $approvedMobileThumbprints,
            1,
            AokieCompanionAdmissionSigner::peerRosterHash(1, $approvedMobileThumbprints),
            90,
            $now,
        )['accessToken'];
    }

    private function mobileToken(
        string $deviceId,
        ?int $now = null,
        ?array $scopes = null,
    ): string
    {
        return (string) self::$signer->issue(
            $this->appId,
            $deviceId,
            'mobile',
            $scopes ?? ['state_read', 'rtc_signal'],
            $this->mobileThumbprint($deviceId),
            self::PLUGIN_THUMBPRINT,
            [],
            null,
            null,
            90,
            $now,
        )['accessToken'];
    }

    /**
     * Mint a correctly SIGNED token over arbitrary claims.
     *
     * issue() structurally cannot produce a mobile admission without a valid
     * expectedPeerKeyThumbprint, and verify() does not inspect that claim — so
     * this is the only way to exercise the controller's own re-validation of
     * it. It stands for software that holds the signing secret but composes a
     * claim set issue() would refuse.
     *
     * @param array<string,mixed> $claims
     */
    private function forgedToken(array $claims): string
    {
        $payload = (string) json_encode($claims, JSON_UNESCAPED_SLASHES);
        return AokieCompanionAdmissionSigner::TOKEN_PREFIX
            . '.' . bin2hex($payload)
            . '.' . bin2hex(hash_hmac('sha256', $payload, self::SECRET, true));
    }

    /**
     * The claim set issue() emits for a mobile, as a mutable starting point.
     *
     * @return array<string,mixed>
     */
    private function mobileClaims(string $deviceId): array
    {
        return [
            'aud' => AokieCompanionAdmissionSigner::AUDIENCE,
            'appId' => $this->appId,
            'subjectId' => $deviceId,
            'role' => 'mobile',
            'holderKeyThumbprint' => $this->mobileThumbprint($deviceId),
            'expectedPeerKeyThumbprint' => self::PLUGIN_THUMBPRINT,
            'scopes' => ['state_read'],
            'exp' => time() + 90,
            'jti' => 'adm_' . bin2hex(random_bytes(8)),
        ];
    }

    /**
     * The claim set issue() emits for a plugin, as a mutable starting point.
     *
     * @param list<string> $approvedMobileThumbprints
     * @return array<string,mixed>
     */
    private function pluginClaims(array $approvedMobileThumbprints): array
    {
        sort($approvedMobileThumbprints, SORT_STRING);
        return [
            'aud' => AokieCompanionAdmissionSigner::AUDIENCE,
            'appId' => $this->appId,
            'subjectId' => 'aokie',
            'role' => 'plugin',
            'holderKeyThumbprint' => self::PLUGIN_THUMBPRINT,
            'approvedPeerKeyThumbprints' => $approvedMobileThumbprints,
            'peerRosterRevision' => 1,
            'peerRosterHash' => AokieCompanionAdmissionSigner::peerRosterHash(1, $approvedMobileThumbprints),
            'scopes' => ['state_read'],
            'exp' => time() + 90,
            'jti' => 'adm_' . bin2hex(random_bytes(8)),
        ];
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

    private function challenge(?string $bearer): ResponseInterface
    {
        return self::$controller->getChallenge(
            $this->request('GET', '/api/aokie-companion/relay/challenge', $bearer),
            (new ResponseFactory())->createResponse(),
        );
    }

    /** @return array<string,mixed> the claims carried inside an admission token */
    private static function claimsOf(string $token): array
    {
        [, $payloadHex] = explode('.', $token);
        return json_decode((string) hex2bin($payloadHex), true) ?: [];
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

    private function setRemoteAssistanceConsent(bool $assistance, bool $takeover): void
    {
        $app = self::$apps->getApp($this->appId);
        $settings = is_array($app['settings'] ?? null) ? $app['settings'] : [];
        $settings['aokieCompanion']['remoteConsent'] = [
            'remoteMonitoring' => true,
            'remoteConsult' => true,
            'remoteTakeover' => $takeover,
            'remoteCaptions' => true,
            'remoteAssistance' => $assistance,
        ];
        self::$apps->updateApp($this->appId, ['settings' => $settings]);
    }

    /** @param list<string> $grants @return array{device:array<string,mixed>,group:array<string,mixed>} */
    private function enrollRoutedMobile(string $deviceId, array $grants): array
    {
        $device = self::$devices->enrollOrTouch(
            $this->userId,
            $this->appId,
            $deviceId,
            'mobile',
            'Relay recipient',
            $grants,
            ['holderKeyThumbprint' => $this->mobileThumbprint($deviceId)],
        );
        $group = self::$devices->saveRoutingGroup($this->userId, $this->appId, [
            'name' => 'Relay routing ' . bin2hex(random_bytes(5)),
            'policy' => 'all',
            'members' => [['deviceId' => $device['id'], 'priority' => 10]],
        ]);
        return ['device' => $device, 'group' => $group];
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

    public function testEveryEnvelopeCarriesVerifiedAdmissionMetadataAndLegacyRowsFailClosed(): void
    {
        $deviceId = 'device_' . bin2hex(random_bytes(4));
        $thumbprint = $this->mobileThumbprint($deviceId);
        $mobileGrants = ['state_read', 'caller_read', 'monitor', 'rtc_signal'];
        $pluginGrants = ['state_read', 'caller_read', 'takeover', 'rtc_signal'];
        $mobile = $this->mobileToken($deviceId, null, $mobileGrants);
        $plugin = $this->pluginToken([$thumbprint], null, $pluginGrants);

        // Caller-supplied top-level authority metadata is intentionally
        // ignored; the outer envelope is stamped from the verified admission.
        $posted = $this->post($mobile, [
            'to' => 'plugin',
            'subjectId' => 'spoofed_device',
            'grants' => ['takeover'],
            'frames' => [
                [
                    'kind' => 'mobile_hello',
                    'deviceId' => 'spoofed_inner_device',
                    'subjectId' => 'spoofed_inner_subject',
                    'grants' => ['takeover'],
                ],
                ['kind' => 'lease_request'],
            ],
        ]);
        $postedBody = self::decode($posted);
        $this->assertSame(200, $posted->getStatusCode(), json_encode($postedBody));

        $pluginInbox = self::decode($this->poll($plugin, ['since' => 0]));
        $this->assertCount(2, $pluginInbox['frames']);
        foreach ($pluginInbox['frames'] as $envelope) {
            $this->assertSame($deviceId, $envelope['subjectId']);
            $this->assertSame($mobileGrants, $envelope['grants']);
        }
        // The relay still does not interpret or rewrite the inner document.
        $this->assertSame('spoofed_inner_device', $pluginInbox['frames'][0]['frame']['deviceId']);
        $this->assertSame('spoofed_inner_subject', $pluginInbox['frames'][0]['frame']['subjectId']);
        $this->assertSame(['takeover'], $pluginInbox['frames'][0]['frame']['grants']);

        $stored = self::$pdo->prepare(
            'SELECT admission_subject_id, admission_grants FROM aokie_companion_relay_frames
             WHERE app_id = ? ORDER BY seq ASC',
        );
        $stored->execute([$this->appId]);
        foreach ($stored->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $this->assertSame($deviceId, $row['admission_subject_id']);
            $this->assertSame($mobileGrants, json_decode((string) $row['admission_grants'], true));
        }

        // The same metadata exists in the opposite direction and describes
        // the plugin bearer that POSTed the frame, not the mobile polling it.
        $pluginPost = $this->post($plugin, [
            'to' => 'mobile:' . $thumbprint,
            'frames' => [['kind' => 'plugin_snapshot']],
        ]);
        $this->assertSame(200, $pluginPost->getStatusCode(), (string) $pluginPost->getBody());
        $mobileInbox = self::decode($this->poll($mobile, ['since' => 0]));
        $this->assertCount(1, $mobileInbox['frames']);
        $this->assertSame('aokie', $mobileInbox['frames'][0]['subjectId']);
        $this->assertSame($pluginGrants, $mobileInbox['frames'][0]['grants']);

        // Migration compatibility: an old row has no authority metadata. The
        // nullable columns let it remain readable, while explicit null/empty
        // wire values ensure consumers fail closed.
        $legacy = self::$pdo->prepare(
            'INSERT INTO aokie_companion_relay_frames
                (app_id, to_party, from_party, frame)
             VALUES (?, ?, ?, ?)',
        );
        $legacy->execute([
            $this->appId,
            'plugin',
            'mobile:' . $thumbprint,
            '{"kind":"pre_grants_schema"}',
        ]);
        $legacySeq = (int) self::$pdo->lastInsertId();
        $legacyInbox = self::decode($this->poll($plugin, [
            'since' => $postedBody['seq'],
        ]));
        $this->assertCount(1, $legacyInbox['frames']);
        $this->assertSame($legacySeq, $legacyInbox['frames'][0]['seq']);
        $this->assertNull($legacyInbox['frames'][0]['subjectId']);
        $this->assertSame([], $legacyInbox['frames'][0]['grants']);

        // Corrupt stored metadata also cannot acquire an authenticated
        // identity merely because from_party names an approved endpoint.
        $corrupt = self::$pdo->prepare(
            'INSERT INTO aokie_companion_relay_frames
                (app_id, to_party, from_party, admission_subject_id, admission_grants, frame)
             VALUES (?, ?, ?, ?, ?, ?)',
        );
        $corrupt->execute([
            $this->appId,
            'plugin',
            'mobile:' . $thumbprint,
            'not a safe subject',
            '["state_read","state_read"]',
            '{"kind":"corrupt_metadata"}',
        ]);
        $corruptInbox = self::decode($this->poll($plugin, ['since' => $legacySeq]));
        $this->assertCount(1, $corruptInbox['frames']);
        $this->assertNull($corruptInbox['frames'][0]['subjectId']);
        $this->assertSame([], $corruptInbox['frames'][0]['grants']);

        foreach (['admission_subject_id', 'admission_grants'] as $columnName) {
            $column = self::$pdo->query(
                "SHOW COLUMNS FROM aokie_companion_relay_frames LIKE '{$columnName}'",
            )->fetch(PDO::FETCH_ASSOC);
            $this->assertIsArray($column);
            $this->assertSame(
                'YES',
                $column['Null'],
                "legacy rows must remain representable as fail-closed {$columnName}=NULL",
            );
        }
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

    public function testPluginAdmissionCannotAddressAnOutOfRosterRoutedMobile(): void
    {
        $approvedDeviceId = 'approved_device_' . bin2hex(random_bytes(4));
        $targetDeviceId = 'out_of_roster_' . bin2hex(random_bytes(4));
        $targetThumbprint = $this->mobileThumbprint($targetDeviceId);
        $target = $this->enrollRoutedMobile(
            $targetDeviceId,
            ['state_read', 'assistance_read', 'assistance_respond'],
        )['device'];
        $this->assertTrue(
            self::$devices->canReceiveRelayAssistance($this->appId, $targetThumbprint),
            'control: target is otherwise a live, Available assistance member',
        );

        $plugin = $this->pluginToken([$this->mobileThumbprint($approvedDeviceId)]);
        $refused = $this->post($plugin, [
            'to' => 'mobile:' . $targetThumbprint,
            'frames' => [
                ['kind' => 'plugin_idle'],
                [
                    'kind' => 'assistance_request',
                    'requestId' => 'private_out_of_roster',
                    'question' => 'Private caller context',
                    'transferOffered' => true,
                ],
            ],
        ]);
        $body = self::decode($refused);
        $this->assertSame(403, $refused->getStatusCode(), json_encode($body));
        $this->assertSame('relay_target_forbidden', $body['code']);

        $inbox = self::decode($this->poll(
            $this->mobileToken($targetDeviceId, null, $target['grants']),
            ['since' => 0],
        ));
        $this->assertSame([], $inbox['frames']);
        $persisted = self::$pdo->prepare(
            "SELECT COUNT(*) FROM aokie_companion_relay_frames
             WHERE app_id = ? AND to_party = ?
               AND JSON_UNQUOTE(JSON_EXTRACT(frame, '$.requestId')) = 'private_out_of_roster'",
        );
        $persisted->execute([$this->appId, 'mobile:' . $targetThumbprint]);
        $this->assertSame(0, (int) $persisted->fetchColumn());
    }

    public function testAssistanceFanoutRequiresFreshAvailableRoutingWithoutNarrowingDeviceGrants(): void
    {
        $deviceId = 'assistance_device_' . bin2hex(random_bytes(4));
        $thumbprint = $this->mobileThumbprint($deviceId);
        $deviceGrants = [
            'state_read',
            'caller_read',
            'captions_read',
            'rtc_signal',
            'takeover',
            'assistance_read',
            'assistance_respond',
        ];
        $routing = $this->enrollRoutedMobile($deviceId, $deviceGrants);
        $device = $routing['device'];
        $group = $routing['group'];
        $plugin = $this->pluginToken([$thumbprint], null, ['state_read', 'assistance_read']);
        $mobile = $this->mobileToken(
            $deviceId,
            null,
            ['state_read', 'rtc_signal', 'takeover', 'assistance_read', 'assistance_respond'],
        );
        $target = 'mobile:' . $thumbprint;
        $assistance = static fn (string $id): array => [
            'kind' => 'assistance_request',
            'schemaVersion' => 2,
            'appId' => 'opaque-to-the-relay',
            'requestId' => $id,
            'question' => 'Can you take this caller?',
            'transferOffered' => true,
        ];

        // Default Available delivers the request. The hello in the same batch
        // locks the important mixed-batch behavior used for a newly connected
        // endpoint: policy filtering may not suppress its transport handshake.
        $available = $this->post($plugin, [
            'to' => $target,
            'frames' => [
                ['kind' => 'plugin_hello', 'schemaVersion' => 2],
                $assistance('assistance_available'),
            ],
        ]);
        $availableBody = self::decode($available);
        $this->assertSame(200, $available->getStatusCode(), json_encode($availableBody));
        $this->assertSame(2, $availableBody['accepted']);
        $inbox = self::decode($this->poll($mobile, ['since' => 0]));
        $this->assertSame(
            ['plugin_hello', 'assistance_request'],
            array_column(array_column($inbox['frames'], 'frame'), 'kind'),
        );
        $cursor = $inbox['lastSeq'];
        $suppressedRequestIds = [
            'assistance_consent_off',
            'assistance_transfer_consent_off',
            'assistance_transfer_malformed',
            'assistance_busy',
        ];

        // A still-valid plugin admission cannot preserve stale app consent.
        // Suppression remains per-frame so ordinary state/control traffic in
        // the same post continues across the relay.
        $this->setRemoteAssistanceConsent(false, true);
        $consentOff = self::decode($this->post($plugin, [
            'to' => $target,
            'frames' => [
                ['kind' => 'plugin_idle', 'schemaVersion' => 2, 'session' => 'consent_refresh'],
                array_replace(
                    $assistance('assistance_consent_off'),
                    ['transferOffered' => false],
                ),
            ],
        ]));
        $this->assertSame(1, $consentOff['accepted']);
        $consentOffInbox = self::decode($this->poll($mobile, ['since' => $cursor]));
        $this->assertSame(
            ['plugin_idle'],
            array_column(array_column($consentOffInbox['frames'], 'frame'), 'kind'),
        );
        $cursor = $consentOffInbox['lastSeq'];

        // Assistance without a transfer remains allowed when only takeover
        // consent is disabled. An actual transfer offer requires both flags.
        $this->setRemoteAssistanceConsent(true, false);
        $plainAssistance = self::decode($this->post($plugin, [
            'to' => $target,
            'frames' => [array_replace(
                $assistance('assistance_without_transfer'),
                ['transferOffered' => false],
            )],
        ]));
        $this->assertSame(1, $plainAssistance['accepted']);
        $plainInbox = self::decode($this->poll($mobile, ['since' => $cursor]));
        $this->assertSame('assistance_without_transfer', $plainInbox['frames'][0]['frame']['requestId']);
        $cursor = $plainInbox['lastSeq'];

        $transferConsentOff = self::decode($this->post($plugin, [
            'to' => $target,
            'frames' => [$assistance('assistance_transfer_consent_off')],
        ]));
        $this->assertSame(['accepted' => 0, 'seq' => 0], $transferConsentOff);
        $this->assertSame([], self::decode($this->poll($mobile, ['since' => $cursor]))['frames']);

        // A malformed transfer flag is never silently downgraded into an
        // ordinary assistance request for policy purposes.
        $malformedTransfer = self::decode($this->post($plugin, [
            'to' => $target,
            'frames' => [array_replace(
                $assistance('assistance_transfer_malformed'),
                ['transferOffered' => 'false'],
            )],
        ]));
        $this->assertSame(['accepted' => 0, 'seq' => 0], $malformedTransfer);
        $this->assertSame([], self::decode($this->poll($mobile, ['since' => $cursor]))['frames']);
        $this->setRemoteAssistanceConsent(true, true);

        // The real first-delivery shape is mixed: RelayChannel prepends its
        // hello to a newly learned party. Busy must remove only the private
        // assistance request, report one accepted frame, and preserve the
        // handshake so availability never becomes a transport outage.
        $this->assertTrue(self::$devices->setAvailability($this->appId, $device['id'], 'busy'));
        $this->assertFalse(self::$devices->canReceiveRelayAssistance($this->appId, $thumbprint));
        $busyMixed = $this->post($plugin, [
            'to' => $target,
            'frames' => [
                ['kind' => 'plugin_hello', 'schemaVersion' => 2, 'session' => 'busy_refresh'],
                $assistance('assistance_busy'),
            ],
        ]);
        $busyMixedBody = self::decode($busyMixed);
        $this->assertSame(200, $busyMixed->getStatusCode(), json_encode($busyMixedBody));
        $this->assertSame(1, $busyMixedBody['accepted']);
        $busyInbox = self::decode($this->poll($mobile, ['since' => $cursor]));
        $this->assertSame(
            ['plugin_hello'],
            array_column(array_column($busyInbox['frames'], 'frame'), 'kind'),
        );
        $this->assertSame('busy_refresh', $busyInbox['frames'][0]['frame']['session']);
        $cursor = $busyInbox['lastSeq'];

        $assertSuppressed = function (string $requestId, string $label) use (
            $plugin,
            $target,
            $assistance,
            $mobile,
            &$cursor,
            &$suppressedRequestIds,
        ): void {
            $suppressedRequestIds[] = $requestId;
            $response = $this->post($plugin, [
                'to' => $target,
                'frames' => [$assistance($requestId)],
            ]);
            $body = self::decode($response);
            $this->assertSame(200, $response->getStatusCode(), $label);
            $this->assertSame(['accepted' => 0, 'seq' => 0], $body, $label);
            $empty = self::decode($this->poll($mobile, ['since' => $cursor]));
            $this->assertSame([], $empty['frames'], $label);
            $this->assertSame($cursor, $empty['lastSeq'], $label);
        };

        foreach (['do_not_disturb', 'offline'] as $status) {
            $this->assertTrue(self::$devices->setAvailability($this->appId, $device['id'], $status));
            $this->assertFalse(self::$devices->canReceiveRelayAssistance($this->appId, $thumbprint));
            $assertSuppressed('assistance_' . $status, $status);
        }

        // An Available status with an expired TTL is effectively Offline and
        // must not leave a request queued to appear if availability changes.
        $this->assertTrue(self::$devices->setAvailability(
            $this->appId,
            $device['id'],
            'available',
            time() + 60,
        ));
        self::$pdo->prepare(
            'UPDATE aokie_companion_routing_members
             SET availability_expires_at = DATE_SUB(NOW(), INTERVAL 1 SECOND)
             WHERE device_id = ?',
        )->execute([$device['id']]);
        $this->assertFalse(self::$devices->canReceiveRelayAssistance($this->appId, $thumbprint));
        $assertSuppressed('assistance_expired', 'expired availability');

        // Non-assistance state and an existing lease's safety/control traffic
        // remain routable while unavailable. Availability governs fresh
        // assistance fanout; it must not strand a call by cutting live control.
        $idle = self::decode($this->post($plugin, [
            'to' => $target,
            'frames' => [
                ['kind' => 'plugin_idle', 'schemaVersion' => 2],
                [
                    'kind' => 'plugin_lease_revoke',
                    'schemaVersion' => 2,
                    'deviceId' => $deviceId,
                    'leaseId' => 'existing_lease',
                ],
            ],
        ]));
        $this->assertSame(2, $idle['accepted']);
        $idleInbox = self::decode($this->poll($mobile, ['since' => $cursor]));
        $this->assertSame(
            ['plugin_idle', 'plugin_lease_revoke'],
            array_column(array_column($idleInbox['frames'], 'frame'), 'kind'),
        );
        $cursor = $idleInbox['lastSeq'];

        $this->assertTrue(self::$devices->setAvailability($this->appId, $device['id'], 'available'));
        $this->assertTrue(self::$devices->canReceiveRelayAssistance($this->appId, $thumbprint));

        self::$pdo->prepare(
            'UPDATE aokie_companion_routing_members SET enabled = 0
             WHERE group_id = ? AND device_id = ?',
        )->execute([$group['id'], $device['id']]);
        $this->assertFalse(self::$devices->canReceiveRelayAssistance($this->appId, $thumbprint));
        $assertSuppressed('assistance_member_disabled', 'disabled routing member');
        self::$pdo->prepare(
            'UPDATE aokie_companion_routing_members SET enabled = 1
             WHERE group_id = ? AND device_id = ?',
        )->execute([$group['id'], $device['id']]);
        $this->assertTrue(self::$devices->canReceiveRelayAssistance($this->appId, $thumbprint));

        self::$pdo->prepare('UPDATE aokie_companion_routing_groups SET enabled = 0 WHERE id = ?')
            ->execute([$group['id']]);
        $this->assertFalse(self::$devices->canReceiveRelayAssistance($this->appId, $thumbprint));
        $assertSuppressed('assistance_group_disabled', 'disabled routing group');
        self::$pdo->prepare('UPDATE aokie_companion_routing_groups SET enabled = 1 WHERE id = ?')
            ->execute([$group['id']]);
        $this->assertTrue(self::$devices->canReceiveRelayAssistance($this->appId, $thumbprint));

        $withoutAssistance = array_values(array_diff($deviceGrants, ['assistance_read']));
        self::$pdo->prepare('UPDATE aokie_companion_devices SET grants = ? WHERE id = ?')
            ->execute([json_encode($withoutAssistance, JSON_THROW_ON_ERROR), $device['id']]);
        $this->assertFalse(self::$devices->canReceiveRelayAssistance($this->appId, $thumbprint));
        $assertSuppressed('assistance_grant_removed', 'missing assistance_read');
        self::$pdo->prepare('UPDATE aokie_companion_devices SET grants = ? WHERE id = ?')
            ->execute([json_encode($deviceGrants, JSON_THROW_ON_ERROR), $device['id']]);
        $this->assertTrue(self::$devices->canReceiveRelayAssistance($this->appId, $thumbprint));

        self::$pdo->prepare('UPDATE aokie_companion_devices SET revoked_at = NOW() WHERE id = ?')
            ->execute([$device['id']]);
        $this->assertFalse(self::$devices->canReceiveRelayAssistance($this->appId, $thumbprint));
        $assertSuppressed('assistance_device_revoked', 'revoked endpoint');
        self::$pdo->prepare('UPDATE aokie_companion_devices SET revoked_at = NULL WHERE id = ?')
            ->execute([$device['id']]);
        $this->assertTrue(self::$devices->canReceiveRelayAssistance($this->appId, $thumbprint));

        $restored = self::decode($this->post($plugin, [
            'to' => $target,
            'frames' => [$assistance('assistance_restored')],
        ]));
        $this->assertSame(1, $restored['accepted']);
        $restoredInbox = self::decode($this->poll($mobile, ['since' => $cursor]));
        $this->assertSame(
            ['assistance_request'],
            array_column(array_column($restoredInbox['frames'], 'frame'), 'kind'),
        );

        $placeholders = implode(',', array_fill(0, count($suppressedRequestIds), '?'));
        $persistedSuppressed = self::$pdo->prepare(
            "SELECT COUNT(*) FROM aokie_companion_relay_frames
             WHERE app_id = ?
               AND JSON_UNQUOTE(JSON_EXTRACT(frame, '$.requestId')) IN ({$placeholders})",
        );
        $persistedSuppressed->execute([$this->appId, ...$suppressedRequestIds]);
        $this->assertSame(
            0,
            (int) $persistedSuppressed->fetchColumn(),
            'Filtered questions, context, and transfer scripts must be removed before mailbox persistence',
        );

        $stored = self::$pdo->prepare('SELECT grants FROM aokie_companion_devices WHERE id = ?');
        $stored->execute([$device['id']]);
        $this->assertSame(
            $deviceGrants,
            json_decode((string) $stored->fetchColumn(), true),
            'Availability is transient routing state and must never persistently narrow endpoint capabilities',
        );
    }

    public function testAssistanceFanoutRejectsASuspendedNonOwnerWithPreviouslyGrantedAccess(): void
    {
        $memberId = 'relay_member_' . bin2hex(random_bytes(6));
        self::$pdo->prepare(
            "INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'Relay Member')",
        )->execute([$memberId, $memberId . '@relay.test']);
        try {
            $role = self::$pdo->prepare(
                "SELECT id FROM app_roles WHERE app_id = ? AND name = 'Member' LIMIT 1",
            );
            $role->execute([$this->appId]);
            $roleId = $role->fetchColumn();
            $this->assertIsString($roleId);
            foreach ([
                AppPermissions::AOKIE_COMPANION_STATE,
                AppPermissions::AOKIE_COMPANION_ASSISTANCE,
            ] as $permission) {
                self::$pdo->prepare(
                    'INSERT IGNORE INTO app_role_permissions
                        (id, role_id, form_id, permission) VALUES (?, ?, NULL, ?)',
                )->execute(['perm_' . bin2hex(random_bytes(8)), $roleId, $permission]);
            }
            $appUserId = 'app_user_' . bin2hex(random_bytes(7));
            self::$pdo->prepare(
                "INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at)
                 VALUES (?, ?, ?, ?, 'active', NOW())",
            )->execute([$appUserId, $this->appId, $memberId, $roleId]);

            $deviceId = 'member_device_' . bin2hex(random_bytes(5));
            $thumbprint = $this->mobileThumbprint($deviceId);
            $deviceGrants = ['state_read', 'assistance_read', 'assistance_respond'];
            $device = self::$devices->enrollOrTouch(
                $memberId,
                $this->appId,
                $deviceId,
                'mobile',
                'Member endpoint',
                $deviceGrants,
                ['holderKeyThumbprint' => $thumbprint],
            );
            self::$devices->saveRoutingGroup($this->userId, $this->appId, [
                'name' => 'Member assistance ' . bin2hex(random_bytes(4)),
                'policy' => 'all',
                'members' => [['deviceId' => $device['id'], 'priority' => 10]],
            ]);
            $plugin = $this->pluginToken([$thumbprint], null, ['state_read', 'assistance_read']);
            $mobile = $this->mobileToken($deviceId, null, $deviceGrants);
            $target = 'mobile:' . $thumbprint;

            $this->assertTrue(self::$devices->canReceiveRelayAssistance($this->appId, $thumbprint));
            $allowed = self::decode($this->post($plugin, [
                'to' => $target,
                'frames' => [[
                    'kind' => 'assistance_request',
                    'requestId' => 'member_before_suspension',
                    'transferOffered' => true,
                ]],
            ]));
            $this->assertSame(1, $allowed['accepted']);
            $allowedInbox = self::decode($this->poll($mobile, ['since' => 0]));
            $this->assertCount(1, $allowedInbox['frames']);
            $cursor = $allowedInbox['lastSeq'];

            self::$pdo->prepare("UPDATE app_users SET status = 'suspended' WHERE id = ?")
                ->execute([$appUserId]);
            $this->assertFalse(self::$devices->canReceiveRelayAssistance($this->appId, $thumbprint));
            $suppressedResponse = $this->post($plugin, [
                'to' => $target,
                'frames' => [[
                    'kind' => 'assistance_request',
                    'requestId' => 'member_after_suspension',
                    'transferOffered' => true,
                ]],
            ]);
            $this->assertSame(200, $suppressedResponse->getStatusCode());
            $this->assertSame(['accepted' => 0, 'seq' => 0], self::decode($suppressedResponse));
            $suppressedInbox = self::decode($this->poll($mobile, ['since' => $cursor]));
            $this->assertSame([], $suppressedInbox['frames']);
            $this->assertSame($cursor, $suppressedInbox['lastSeq']);

            $stored = self::$pdo->prepare('SELECT grants FROM aokie_companion_devices WHERE id = ?');
            $stored->execute([$device['id']]);
            $this->assertSame($deviceGrants, json_decode((string) $stored->fetchColumn(), true));
        } finally {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$memberId]);
        }
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
        $unconfigured = new AokieCompanionRelayController(null, self::$apps, self::$relay, self::$devices);
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

    public function testChallengeIsDerivedOnlyFromThePresentedBearersOwnClaims(): void
    {
        $deviceId = 'device_' . bin2hex(random_bytes(4));
        $thumbprint = $this->mobileThumbprint($deviceId);
        $token = $this->pluginToken([$thumbprint]);
        $claims = self::claimsOf($token);

        $before = time();
        $response = $this->challenge($token);
        $body = self::decode($response);
        $after = time();
        $this->assertSame(200, $response->getStatusCode(), json_encode($body));
        $this->assertSame('no-store', $response->getHeaderLine('Cache-Control'));
        $this->assertSame('no-cache', $response->getHeaderLine('Pragma'));

        $this->assertSame('endpoint_challenge', $body['kind']);
        $this->assertSame(2, $body['schemaVersion'], 'must match aokie_protocol::v2::SCHEMA_VERSION');
        $this->assertSame('plugin', $body['role']);
        // Every non-random field is the bearer's OWN verified claim, echoed.
        $this->assertSame($this->appId, $body['appId']);
        $this->assertSame($claims['appId'], $body['appId']);
        $this->assertSame($claims['subjectId'], $body['subjectId']);
        $this->assertSame($claims['jti'], $body['admissionJti']);
        $this->assertSame(self::PLUGIN_THUMBPRINT, $body['holderKeyThumbprint']);
        $this->assertSame($claims['holderKeyThumbprint'], $body['holderKeyThumbprint']);
        $this->assertSame([$thumbprint], $body['approvedPeerKeyThumbprints']);
        $this->assertSame($claims['approvedPeerKeyThumbprints'], $body['approvedPeerKeyThumbprints']);
        $this->assertSame($claims['peerRosterRevision'], $body['peerRosterRevision']);
        $this->assertSame($claims['peerRosterHash'], $body['peerRosterHash']);

        // ⚠️ A plugin-role challenge must NOT carry expectedPeerKeyThumbprint:
        // the endpoint reads its presence as an identity mismatch and refuses
        // the socket. Absent — not null, not empty string.
        $this->assertFalse(
            array_key_exists('expectedPeerKeyThumbprint', $body),
            'expectedPeerKeyThumbprint must be omitted entirely for role plugin',
        );

        // ⚠️ PROTOCOL BOUND, not a preference: EndpointChallengeFrame::validate()
        // refuses an expiry already past AND one more than
        // ENDPOINT_PROOF_MAX_LIFETIME (30s) ahead of the verifier's clock. A
        // longer window fails EVERY handshake with `Expired`, so the lifetime
        // itself is locked here, not just the value it produced.
        $lifetime = AokieCompanionRelayController::CHALLENGE_LIFETIME_SECONDS;
        $this->assertGreaterThan(0, $lifetime);
        $this->assertLessThanOrEqual(30, $lifetime, 'exceeds ENDPOINT_PROOF_MAX_LIFETIME — every handshake would fail');
        $this->assertGreaterThan($after, $body['expiresAt'], 'a challenge must not arrive already expired');
        $this->assertGreaterThanOrEqual($before + $lifetime, $body['expiresAt']);
        $this->assertLessThanOrEqual($after + $lifetime, $body['expiresAt']);

        // connectionId/challengeNonce must satisfy the protocol's safe-id rule
        // (ASCII alphanumeric plus - _ . :) or the frame is rejected outright.
        foreach (['connectionId' => 'relay_', 'challengeNonce' => 'challenge_'] as $field => $prefix) {
            $this->assertStringStartsWith($prefix, $body[$field]);
            $this->assertMatchesRegularExpression('/^[A-Za-z0-9_.:-]{1,200}$/D', $body[$field], $field);
        }
    }

    public function testMobileChallengeCarriesThePeerShapeAndNeverTheRoster(): void
    {
        $deviceId = 'device_' . bin2hex(random_bytes(4));
        $token = $this->mobileToken($deviceId);
        $claims = self::claimsOf($token);

        $before = time();
        $response = $this->challenge($token);
        $body = self::decode($response);
        $after = time();
        $this->assertSame(200, $response->getStatusCode(), json_encode($body));
        $this->assertSame('no-store', $response->getHeaderLine('Cache-Control'));
        $this->assertSame('no-cache', $response->getHeaderLine('Pragma'));

        $this->assertSame('endpoint_challenge', $body['kind']);
        $this->assertSame(2, $body['schemaVersion'], 'must match aokie_protocol::v2::SCHEMA_VERSION');
        $this->assertSame('mobile', $body['role']);
        // Same invariant as the plugin branch: every non-random field is the
        // bearer's OWN verified claim, echoed. No request input is consulted.
        $this->assertSame($this->appId, $body['appId']);
        $this->assertSame($claims['appId'], $body['appId']);
        $this->assertSame($claims['subjectId'], $body['subjectId']);
        $this->assertSame($claims['jti'], $body['admissionJti']);
        $this->assertSame($this->mobileThumbprint($deviceId), $body['holderKeyThumbprint']);
        $this->assertSame($claims['holderKeyThumbprint'], $body['holderKeyThumbprint']);

        // ⚠️ THE MOBILE SHAPE: expectedPeerKeyThumbprint REQUIRED and DISTINCT
        // from the holder. aokie_protocol::v2::validate_peer_policy refuses the
        // frame when it is absent, and refuses it again when it equals the
        // holder — a self-referential peer is read as an identity mismatch.
        $this->assertSame($claims['expectedPeerKeyThumbprint'], $body['expectedPeerKeyThumbprint']);
        $this->assertSame(self::PLUGIN_THUMBPRINT, $body['expectedPeerKeyThumbprint']);
        $this->assertNotSame(
            $body['holderKeyThumbprint'],
            $body['expectedPeerKeyThumbprint'],
            'expectedPeerKeyThumbprint must name the PEER, never the holder itself',
        );

        // ⚠️ And the roster keys must be ABSENT — not null, not empty. Any one
        // of them present makes validate_peer_policy refuse a mobile frame
        // outright. EndpointChallengeFrame defaults all three, so omitting them
        // decodes cleanly to (empty vec, None, None).
        foreach (['approvedPeerKeyThumbprints', 'peerRosterRevision', 'peerRosterHash'] as $rosterKey) {
            $this->assertFalse(
                array_key_exists($rosterKey, $body),
                $rosterKey . ' must be omitted entirely for role mobile',
            );
        }

        $lifetime = AokieCompanionRelayController::CHALLENGE_LIFETIME_SECONDS;
        $this->assertGreaterThan($after, $body['expiresAt'], 'a challenge must not arrive already expired');
        $this->assertGreaterThanOrEqual($before + $lifetime, $body['expiresAt']);
        $this->assertLessThanOrEqual($after + $lifetime, $body['expiresAt']);

        foreach (['connectionId' => 'relay_', 'challengeNonce' => 'challenge_'] as $field => $prefix) {
            $this->assertStringStartsWith($prefix, $body[$field]);
            $this->assertMatchesRegularExpression('/^[A-Za-z0-9_.:-]{1,200}$/D', $body[$field], $field);
        }
    }

    public function testTheTwoChallengeShapesAreMutuallyExclusive(): void
    {
        // The protocol does not merely allow different shapes per role, it
        // REFUSES each role carrying the other's peer fields. Asserting the two
        // documents side by side locks the disjointness itself, so neither
        // branch can drift toward the other.
        $deviceId = 'device_' . bin2hex(random_bytes(4));
        $thumbprint = $this->mobileThumbprint($deviceId);
        $plugin = self::decode($this->challenge($this->pluginToken([$thumbprint])));
        $mobile = self::decode($this->challenge($this->mobileToken($deviceId)));

        $this->assertSame('plugin', $plugin['role']);
        $this->assertSame('mobile', $mobile['role']);

        $shared = ['kind', 'schemaVersion', 'appId', 'subjectId', 'role', 'connectionId',
            'challengeNonce', 'admissionJti', 'holderKeyThumbprint', 'expiresAt'];
        $rosterOnly = ['approvedPeerKeyThumbprints', 'peerRosterRevision', 'peerRosterHash'];

        $this->assertSame($shared, array_values(array_diff(array_keys($plugin), $rosterOnly)));
        $this->assertSame($shared, array_values(array_diff(array_keys($mobile), ['expectedPeerKeyThumbprint'])));
        // Exactly one peer-policy vocabulary each, with no overlap.
        $this->assertSame($rosterOnly, array_values(array_intersect(array_keys($plugin), $rosterOnly)));
        $this->assertArrayNotHasKey('expectedPeerKeyThumbprint', $plugin);
        $this->assertSame([], array_values(array_intersect(array_keys($mobile), $rosterOnly)));
        $this->assertArrayHasKey('expectedPeerKeyThumbprint', $mobile);
    }

    public function testMobileChallengeRefusesAMalformedEndpointIdentity(): void
    {
        // verify() checks only what every role shares, so a token that passed
        // the HMAC can still carry a peer claim issue() would never emit. The
        // controller re-validates rather than echoing a frame the endpoint
        // would refuse only after a full round trip.
        $deviceId = 'device_' . bin2hex(random_bytes(4));
        $holder = $this->mobileThumbprint($deviceId);
        foreach ([
            'absent' => null,
            'empty' => '',
            'not-a-thumbprint' => 'nope',
            'wrong-length' => substr($holder, 0, 42),
            // The protocol refuses a peer that names the holder itself.
            'self-referential' => $holder,
        ] as $label => $expectedPeer) {
            $claims = $this->mobileClaims($deviceId);
            if ($expectedPeer === null) {
                unset($claims['expectedPeerKeyThumbprint']);
            } else {
                $claims['expectedPeerKeyThumbprint'] = $expectedPeer;
            }
            $response = $this->challenge($this->forgedToken($claims));
            $body = self::decode($response);
            $this->assertSame(401, $response->getStatusCode(), $label);
            $this->assertSame('invalid_token', $body['code'], $label);
            // A refusal is an error envelope only: no identity material at all.
            $keys = array_keys($body);
            sort($keys);
            $this->assertSame(['code', 'error', 'message'], $keys, $label);
        }

        // Control: the same forging path with an untouched claim set succeeds,
        // proving the refusals above are the peer check and not the forgery.
        $ok = $this->challenge($this->forgedToken($this->mobileClaims($deviceId)));
        $this->assertSame(200, $ok->getStatusCode(), (string) $ok->getBody());
    }

    public function testPluginChallengeRefusesARosterThatApprovesItsOwnKey(): void
    {
        // ⚠️ THE MIRROR OF THE MOBILE SELF-REFERENCE CASE, and the one roster
        // rule validatePluginPeerPolicy structurally cannot make: it is never
        // handed the holder. aokie_protocol::v2::validate_peer_policy refuses a
        // plugin frame whose roster approves the endpoint's OWN key — so
        // echoing one would mint a challenge the plugin rejects only after a
        // full round trip, and since a roster revision may only ever advance,
        // that failure would be STICKY rather than self-correcting.
        $deviceId = 'device_' . bin2hex(random_bytes(4));
        $claims = $this->pluginClaims([$this->mobileThumbprint($deviceId), self::PLUGIN_THUMBPRINT]);
        $response = $this->challenge($this->forgedToken($claims));
        $body = self::decode($response);
        $this->assertSame(401, $response->getStatusCode(), json_encode($body));
        $this->assertSame('invalid_token', $body['code']);
        // A refusal stays an error envelope only — no roster material leaks.
        $keys = array_keys($body);
        sort($keys);
        $this->assertSame(['code', 'error', 'message'], $keys);

        // Control: the same forging path with a roster that excludes the holder
        // succeeds, proving the refusal is the holder rule and not the forgery.
        $ok = $this->challenge($this->forgedToken($this->pluginClaims([$this->mobileThumbprint($deviceId)])));
        $this->assertSame(200, $ok->getStatusCode(), (string) $ok->getBody());
    }

    public function testPluginChallengeNeverEchoesAMobilePeerClaim(): void
    {
        // The plugin half of the disjointness the mobile branch already locks.
        // validate_peer_policy refuses a plugin frame carrying
        // expectedPeerKeyThumbprint AT ALL — reading its mere presence as an
        // identity mismatch — so a token that smuggles one (issue() refuses to
        // mint it, but verify() does not inspect it) must not have it copied
        // through. The branch composes its peer policy from scratch rather than
        // filtering the claims, which is what makes that structural.
        $deviceId = 'device_' . bin2hex(random_bytes(4));
        $claims = $this->pluginClaims([$this->mobileThumbprint($deviceId)]);
        $claims['expectedPeerKeyThumbprint'] = $this->mobileThumbprint($deviceId);
        $response = $this->challenge($this->forgedToken($claims));
        $body = self::decode($response);
        $this->assertSame(200, $response->getStatusCode(), json_encode($body));
        $this->assertSame('plugin', $body['role']);
        $this->assertArrayNotHasKey(
            'expectedPeerKeyThumbprint',
            $body,
            'a plugin challenge must never carry the mobile peer field, whatever the token claims',
        );
        $this->assertSame([$this->mobileThumbprint($deviceId)], $body['approvedPeerKeyThumbprints']);
    }

    public function testEveryChallengeMintsFreshConnectionAndNonceValues(): void
    {
        $token = $this->pluginToken([$this->mobileThumbprint('device_' . bin2hex(random_bytes(4)))]);
        $first = self::decode($this->challenge($token));
        $second = self::decode($this->challenge($token));

        $this->assertNotSame($first['connectionId'], $second['connectionId']);
        $this->assertNotSame($first['challengeNonce'], $second['challengeNonce']);
        // The same bearer still describes the same identity both times.
        $this->assertSame($first['admissionJti'], $second['admissionJti']);
        $this->assertSame($first['holderKeyThumbprint'], $second['holderKeyThumbprint']);
    }

    public function testChallengeRefusalsAreTypedAndNeverLeakIdentity(): void
    {
        $deviceId = 'device_' . bin2hex(random_bytes(4));

        // A mobile bearer now opens its OWN session, but it still cannot obtain
        // a PLUGIN handshake: the role and every peer field come from the token,
        // never from the request — and the mailbox derives its party the same
        // way, so a stolen plugin challenge would buy nothing either.
        $mobile = self::decode($this->challenge($this->mobileToken($deviceId)));
        $this->assertSame('mobile', $mobile['role']);
        foreach (['approvedPeerKeyThumbprints', 'peerRosterRevision', 'peerRosterHash'] as $rosterKey) {
            $this->assertArrayNotHasKey($rosterKey, $mobile, 'a mobile bearer must never receive plugin roster material');
        }

        $valid = $this->pluginToken([$this->mobileThumbprint($deviceId)]);
        foreach ([
            'missing' => null,
            'garbage' => 'not-an-admission-token',
            // Deterministically flip the last signature nibble.
            'tampered' => substr($valid, 0, -1) . (str_ends_with($valid, 'a') ? 'b' : 'a'),
            'expired' => $this->pluginToken([$this->mobileThumbprint($deviceId)], time() - 4000),
        ] as $label => $bearer) {
            $response = $this->challenge($bearer);
            $body = self::decode($response);
            $this->assertSame(401, $response->getStatusCode(), $label);
            $this->assertSame('invalid_token', $body['code'], $label);
            // A refusal is an error envelope only: no identity material at all.
            $keys = array_keys($body);
            sort($keys);
            $this->assertSame(['code', 'error', 'message'], $keys, $label);
        }

        // No configured signer = unavailable, never open.
        $unconfigured = new AokieCompanionRelayController(null, self::$apps, self::$relay, self::$devices);
        $response = $unconfigured->getChallenge(
            $this->request('GET', '/api/aokie-companion/relay/challenge', $this->pluginToken([
                $this->mobileThumbprint($deviceId),
            ])),
            (new ResponseFactory())->createResponse(),
        );
        $this->assertSame(503, $response->getStatusCode());
        $this->assertSame('companion_unavailable', self::decode($response)['code']);
    }

    public function testServiceToggleGatesTheChallengeToo(): void
    {
        $deviceId = 'device_' . bin2hex(random_bytes(4));
        // Both parties, including a bearer minted while the service was still
        // on: the gate is re-checked on every relay request, so turning the
        // service off closes an ALREADY-ISSUED session within one poll.
        $tokens = [
            'plugin' => $this->pluginToken([$this->mobileThumbprint($deviceId)]),
            'mobile' => $this->mobileToken($deviceId),
        ];
        $this->setRelayService(false);
        try {
            foreach ($tokens as $role => $token) {
                $denied = $this->challenge($token);
                $this->assertSame(403, $denied->getStatusCode(), $role);
                $this->assertSame('service_disabled', self::decode($denied)['code'], $role);
            }
        } finally {
            $this->setRelayService(true);
        }
        foreach ($tokens as $role => $token) {
            $restored = $this->challenge($token);
            $this->assertSame(200, $restored->getStatusCode(), $role . ': ' . (string) $restored->getBody());
        }
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

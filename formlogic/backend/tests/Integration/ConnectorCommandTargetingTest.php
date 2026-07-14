<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\ConnectorCommandController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\DesktopCommandService;
use FormLogic\Services\FlowService;
use FormLogic\Services\FormService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * ROUTE-001: relay commands are TARGETED at one desktop instance. Covers target
 * resolution (explicit assignment pin → implicit single fresh connection →
 * untargeted when none → ambiguous refusal on 2+), targeted visibility (only the
 * target sees/claims the row; siblings never race it), the api-key-bound
 * heartbeat (OAuth placeholder absorption, one install = one row), and the
 * device-name decoration on command read-backs. Skipped without a test database.
 */
class ConnectorCommandTargetingTest extends TestCase
{
    private const BASE = 'http://localhost';

    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static DesktopCommandService $commands;
    private static FlowService $flows;
    private static ConnectorCommandController $ctrl;

    private string $ownerId = '';
    private string $appId = '';
    private string $slug = '';

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
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/formlogic-cmd-target-' . bin2hex(random_bytes(4)));
        $forms = new FormService($conn, $sqlite);
        $apps = new AppService($conn, $forms);
        self::$commands = new DesktopCommandService($conn);
        self::$flows = new FlowService($conn);
        self::$ctrl = new ConnectorCommandController(self::$commands, $apps, new AppUserService($conn));
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->ownerId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$this->ownerId, $this->ownerId . '@test.local']);
        $this->appId = 'app-' . bin2hex(random_bytes(12));
        $this->slug = 'target-' . bin2hex(random_bytes(5));
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status) VALUES (?, ?, 'T', ?, 'published')")
            ->execute([$this->appId, $this->ownerId, $this->slug]);
        // The owner enqueues in these tests (hasPermission short-circuits on
        // apps.owner_id) — it still needs an active membership row for the gate.
        $roleId = 'role-' . bin2hex(random_bytes(10));
        self::$pdo->prepare("INSERT INTO app_roles (id, app_id, name, is_system, sort_order) VALUES (?, ?, 'Owner', 1, 0)")
            ->execute([$roleId, $this->appId]);
        self::$pdo->prepare("INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at) VALUES (?, ?, ?, ?, 'active', NOW())")
            ->execute(['au-' . bin2hex(random_bytes(10)), $this->appId, $this->ownerId, $roleId]);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        self::$pdo->prepare('DELETE FROM desktop_commands WHERE owner_user_id = ?')->execute([$this->ownerId]);
        self::$pdo->prepare('DELETE FROM connector_assignments WHERE owner_user_id = ?')->execute([$this->ownerId]);
        self::$pdo->prepare('DELETE FROM desktop_connections WHERE owner_user_id = ?')->execute([$this->ownerId]);
        self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$this->appId]);
        self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$this->appId]);
        self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$this->appId]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->ownerId]);
    }

    // ── helpers ──

    private static function decode(ResponseInterface $resp): array
    {
        $resp->getBody()->rewind();
        return json_decode((string) $resp->getBody(), true) ?: [];
    }

    /** Register a desktop connection (heartbeat) and return its formatted row. */
    private function connect(string $instanceId, string $deviceName, ?string $apiKeyId = null): array
    {
        return self::$flows->upsertDesktopConnection(
            $this->ownerId,
            ['desktopInstanceId' => $instanceId, 'deviceName' => $deviceName],
            $apiKeyId,
        );
    }

    /** Age a connection's heartbeat past the 90s freshness window. */
    private function makeStale(string $instanceId): void
    {
        self::$pdo->prepare(
            "UPDATE desktop_connections SET last_seen_at = (NOW() - INTERVAL 600 SECOND)
             WHERE owner_user_id = ? AND desktop_instance_id = ?"
        )->execute([$this->ownerId, $instanceId]);
    }

    private function enqueueWeb(array $body): array
    {
        $req = (new ServerRequestFactory())->createServerRequest('POST', self::BASE . '/api/app/' . $this->slug . '/connector-commands')
            ->withParsedBody($body)
            ->withAttribute('userId', $this->ownerId);
        $resp = self::$ctrl->enqueue($req, (new ResponseFactory())->createResponse(), ['slug' => $this->slug]);
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    private function readWeb(string $id): array
    {
        $req = (new ServerRequestFactory())->createServerRequest('GET', self::BASE . '/api/app/' . $this->slug . '/connector-commands/' . $id)
            ->withAttribute('userId', $this->ownerId);
        $resp = self::$ctrl->getCommand($req, (new ResponseFactory())->createResponse(), ['slug' => $this->slug, 'id' => $id]);
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    private function claimHttp(string $id, array $body = []): array
    {
        $req = (new ServerRequestFactory())->createServerRequest('POST', self::BASE . '/api/v1/connector-commands/' . $id . '/claim')
            ->withParsedBody($body)
            ->withAttribute('userId', $this->ownerId);
        $resp = self::$ctrl->claim($req, (new ResponseFactory())->createResponse(), ['id' => $id]);
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    // ── target resolution ──

    public function testResolutionWithNoConnectionsIsUntargeted(): void
    {
        $r = self::$commands->resolveTargetInstance($this->ownerId, 'aokie');
        $this->assertNull($r['target']);
        $this->assertNull($r['error']);
    }

    public function testResolutionWithOneFreshConnectionTargetsIt(): void
    {
        $this->connect('inst-solo', 'Front desk PC');
        $r = self::$commands->resolveTargetInstance($this->ownerId, 'aokie');
        $this->assertSame('inst-solo', $r['target']);
        $this->assertNull($r['error']);
    }

    public function testStaleConnectionsDoNotCountTowardResolution(): void
    {
        $this->connect('inst-live', 'Live PC');
        $this->connect('inst-old', 'Old laptop');
        $this->makeStale('inst-old');
        $r = self::$commands->resolveTargetInstance($this->ownerId, 'aokie');
        $this->assertSame('inst-live', $r['target'], 'the stale sibling must not make this ambiguous');
    }

    public function testTwoFreshConnectionsWithoutAssignmentIsAmbiguous(): void
    {
        $this->connect('inst-a', 'Machine A');
        $this->connect('inst-b', 'Machine B');
        $r = self::$commands->resolveTargetInstance($this->ownerId, 'aokie');
        $this->assertNull($r['target']);
        $this->assertSame('ambiguous_desktop', $r['error']);
        $this->assertCount(2, $r['desktops']);
    }

    public function testAssignmentPinWinsEvenWhenPinnedMachineIsOffline(): void
    {
        $a = $this->connect('inst-a', 'Machine A');
        $this->connect('inst-b', 'Machine B');
        self::$flows->setConnectorAssignment($this->ownerId, 'aokie', $this->appId, ['set' => $a['id']]);
        // The pinned machine going quiet must NOT silently fail over to the
        // sibling — the command targets it and expires visibly (no implicit failover).
        $this->makeStale('inst-a');
        $r = self::$commands->resolveTargetInstance($this->ownerId, 'aokie');
        $this->assertSame('inst-a', $r['target']);
        $this->assertNull($r['error']);
    }

    // ── targeted visibility + claim ──

    public function testTargetedCommandIsInvisibleAndUnclaimableToNonTargets(): void
    {
        $enq = self::$commands->enqueue($this->ownerId, $this->ownerId, $this->appId, [
            'connectorId' => 'aokie', 'command' => 'phone.status', 'targetInstanceId' => 'inst-a',
        ]);
        $id = $enq['command']['commandId'];

        // Visibility: only the target (or nobody, for an anonymous poller) sees it.
        $this->assertCount(1, self::$commands->listPending($this->ownerId, null, 50, 'inst-a'));
        $this->assertCount(0, self::$commands->listPending($this->ownerId, null, 50, 'inst-b'), 'a sibling must IGNORE (never see) the command');
        $this->assertCount(0, self::$commands->listPending($this->ownerId, null, 50, null), 'an unidentified poller sees only untargeted rows');

        // Claim: the sibling and the anonymous claimer are refused with a typed 409.
        $resp = $this->claimHttp($id, ['instanceId' => 'inst-b']);
        $this->assertSame(409, $resp['status']);
        $this->assertSame('targeted_elsewhere', $resp['body']['code'] ?? null);
        $resp = $this->claimHttp($id, []);
        $this->assertSame(409, $resp['status']);

        // The row is still pending — the failed claims changed nothing.
        $this->assertSame('pending', self::$commands->get($id, $this->ownerId)['status']);

        // The target claims it normally.
        $resp = $this->claimHttp($id, ['instanceId' => 'inst-a']);
        $this->assertSame(200, $resp['status']);
        $this->assertSame('inst-a', $resp['body']['command']['claimedBy']);
    }

    public function testUntargetedCommandKeepsLegacyFanOut(): void
    {
        $enq = self::$commands->enqueue($this->ownerId, $this->ownerId, $this->appId, [
            'connectorId' => 'aokie', 'command' => 'phone.status',
        ]);
        $id = $enq['command']['commandId'];
        $this->assertCount(1, self::$commands->listPending($this->ownerId, null, 50, 'inst-b'));
        $resp = $this->claimHttp($id, ['instanceId' => 'inst-b']);
        $this->assertSame(200, $resp['status']);
    }

    // ── web enqueue integration ──

    public function testWebEnqueueTargetsTheSingleFreshDesktopAndIgnoresClientTarget(): void
    {
        $this->connect('inst-solo', 'Front desk PC');
        // A member-supplied target must be DISCARDED — routing is the owner's.
        $r = $this->enqueueWeb([
            'connectorId' => 'aokie', 'command' => 'phone.status',
            'targetInstanceId' => 'inst-evil',
        ]);
        $this->assertSame(201, $r['status']);
        $this->assertSame('inst-solo', $r['body']['targetInstanceId'] ?? null);
    }

    public function testWebEnqueueRefusesAmbiguousSiblingsWithTheMachineList(): void
    {
        $this->connect('inst-a', 'Machine A');
        $this->connect('inst-b', 'Machine B');
        $r = $this->enqueueWeb(['connectorId' => 'aokie', 'command' => 'phone.status']);
        $this->assertSame(409, $r['status']);
        $this->assertSame('ambiguous_desktop', $r['body']['code'] ?? null);
        $this->assertCount(2, $r['body']['desktops'] ?? []);
    }

    public function testWebReadBackNamesTheMachines(): void
    {
        $this->connect('inst-solo', 'Front desk PC');
        $enq = $this->enqueueWeb(['connectorId' => 'aokie', 'command' => 'phone.status']);
        $id = $enq['body']['commandId'];
        $this->claimHttp($id, ['instanceId' => 'inst-solo']);
        $r = $this->readWeb($id);
        $this->assertSame(200, $r['status']);
        $this->assertSame('inst-solo', $r['body']['command']['targetInstanceId']);
        $this->assertSame('Front desk PC', $r['body']['command']['targetDeviceName'] ?? null);
        $this->assertSame('Front desk PC', $r['body']['command']['claimedByDeviceName'] ?? null);
    }

    // ── heartbeat binding + placeholder absorption ──

    public function testHeartbeatAbsorbsTheOAuthPlaceholderRow(): void
    {
        // The OAuth link mints a placeholder row under a synthetic 'oauth-…'
        // instance id, bound to the flk_ key…
        $keyId = 'key-' . bin2hex(random_bytes(10));
        $placeholder = self::$flows->createOAuthDesktopConnection($this->ownerId, 'TESTBOX', $keyId);
        $this->assertStringStartsWith('oauth-', $placeholder['desktopInstanceId']);

        // …and the desktop's first real heartbeat (same key, stable instance id)
        // ABSORBS it: one install, one row — no ghost sibling to trip ambiguity.
        $real = $this->connect('inst-real', 'TESTBOX', $keyId);
        $this->assertSame('inst-real', $real['desktopInstanceId']);
        $this->assertSame($placeholder['id'], $real['id'], 'the placeholder row was reused, not duplicated');
        $this->assertCount(1, self::$flows->listDesktopConnections($this->ownerId));
    }

    public function testHeartbeatSweepsAStrayRowStillHoldingItsKey(): void
    {
        $keyId = 'key-' . bin2hex(random_bytes(10));
        // Steady state exists already (same instance id)…
        $this->connect('inst-real', 'TESTBOX', $keyId);
        // …plus a stray placeholder that somehow still holds the key.
        self::$flows->createOAuthDesktopConnection($this->ownerId, 'TESTBOX', $keyId);
        $this->assertCount(2, self::$flows->listDesktopConnections($this->ownerId));

        // The next heartbeat sweeps the stray: the key identifies ONE install.
        $this->connect('inst-real', 'TESTBOX', $keyId);
        $rows = self::$flows->listDesktopConnections($this->ownerId);
        $this->assertCount(1, $rows);
        $this->assertSame('inst-real', $rows[0]['desktopInstanceId']);
    }

    // ── assignment pin management ──

    public function testAssignmentPinValidatesOwnershipAndClearsExplicitly(): void
    {
        $mine = $this->connect('inst-mine', 'Mine');

        // A connection the owner doesn't hold is refused.
        try {
            self::$flows->setConnectorAssignment($this->ownerId, 'aokie', $this->appId, ['set' => 'not-a-connection']);
            $this->fail('expected InvalidArgumentException');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('Desktop connection not found', $e->getMessage());
        }

        // Pin, then re-PUT withOUT the key: the pin survives (absent ≠ clear).
        self::$flows->setConnectorAssignment($this->ownerId, 'aokie', $this->appId, ['set' => $mine['id']]);
        $result = self::$flows->setConnectorAssignment($this->ownerId, 'aokie', $this->appId);
        $this->assertSame($mine['id'], $result['assignments'][0]['desktopConnectionId']);
        $this->assertSame('Mine', $result['assignments'][0]['desktopDeviceName']);

        // Explicit null clears it.
        $result = self::$flows->setConnectorAssignment($this->ownerId, 'aokie', $this->appId, ['set' => null]);
        $this->assertNull($result['assignments'][0]['desktopConnectionId']);
        // And the desktops list rides along for pickers.
        $this->assertNotEmpty($result['desktops']);
    }
}

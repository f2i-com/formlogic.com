<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\ConnectorCommandController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\DesktopCommandService;
use FormLogic\Services\FormService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * Remote command relay: a web member enqueues a connector command (member + connector.<id>.<command>
 * grant gated) for the owner's paired desktop runtime, which long-polls, claims (pending→claimed
 * exactly-once) and completes it. Covers the permission gate, reserve-first idempotency, claim
 * exactly-once, complete transitions, and pending-expiry. Skipped without a test database.
 */
class ConnectorCommandRelayTest extends TestCase
{
    private const BASE = 'http://localhost';

    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static DesktopCommandService $commands;
    private static ConnectorCommandController $ctrl;
    private static AppUserService $appUsers;

    private string $ownerId = '';
    private string $memberId = '';
    private string $appId = '';
    private string $slug = '';
    private string $roleId = '';

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
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/formlogic-connector-cmd-' . bin2hex(random_bytes(4)));
        $forms = new FormService($conn, $sqlite);
        $apps = new AppService($conn, $forms);
        self::$commands = new DesktopCommandService($conn);
        self::$appUsers = new AppUserService($conn);
        self::$ctrl = new ConnectorCommandController(self::$commands, $apps, self::$appUsers);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->ownerId = 'u-' . bin2hex(random_bytes(12));
        $this->memberId = 'u-' . bin2hex(random_bytes(12));
        foreach ([$this->ownerId, $this->memberId] as $uid) {
            self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
                ->execute([$uid, $uid . '@test.local']);
        }
        $this->appId = 'app-' . bin2hex(random_bytes(12));
        $this->slug = 'relay-' . bin2hex(random_bytes(5));
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status) VALUES (?, ?, 'Relay', ?, 'published')")
            ->execute([$this->appId, $this->ownerId, $this->slug]);
        $this->roleId = 'role-' . bin2hex(random_bytes(10));
        self::$pdo->prepare("INSERT INTO app_roles (id, app_id, name, is_system, sort_order) VALUES (?, ?, 'Member', 0, 0)")
            ->execute([$this->roleId, $this->appId]);
        self::$pdo->prepare("INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at) VALUES (?, ?, ?, ?, 'active', NOW())")
            ->execute(['au-' . bin2hex(random_bytes(10)), $this->appId, $this->memberId, $this->roleId]);
        // The owner is a member too (as AppService::createApp seeds in production) via a separate
        // Owner role — hasPermission short-circuits on apps.owner_id, so its grants don't matter, but
        // the membership row is what makes the owner pass the runtime member gate.
        $ownerRole = 'role-' . bin2hex(random_bytes(10));
        self::$pdo->prepare("INSERT INTO app_roles (id, app_id, name, is_system, sort_order) VALUES (?, ?, 'Owner', 1, 0)")
            ->execute([$ownerRole, $this->appId]);
        self::$pdo->prepare("INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at) VALUES (?, ?, ?, ?, 'active', NOW())")
            ->execute(['au-' . bin2hex(random_bytes(10)), $this->appId, $this->ownerId, $ownerRole]);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        self::$pdo->prepare('DELETE FROM desktop_commands WHERE owner_user_id = ?')->execute([$this->ownerId]);
        self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$this->appId]);
        self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id = ?')->execute([$this->roleId]);
        self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$this->appId]);
        self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$this->appId]);
        foreach ([$this->ownerId, $this->memberId] as $uid) {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
        }
    }

    // ── helpers ──

    private static function decode(ResponseInterface $resp): array
    {
        $resp->getBody()->rewind();
        return json_decode((string) $resp->getBody(), true) ?: [];
    }

    private function grant(string $permission): void
    {
        self::$pdo->prepare("INSERT INTO app_role_permissions (id, role_id, form_id, permission) VALUES (?, ?, NULL, ?)")
            ->execute(['arp-' . bin2hex(random_bytes(10)), $this->roleId, $permission]);
    }

    /** POST /api/app/{slug}/connector-commands as $userId. */
    private function enqueue(string $userId, array $body): array
    {
        $req = (new ServerRequestFactory())->createServerRequest('POST', self::BASE . '/api/app/' . $this->slug . '/connector-commands')
            ->withParsedBody($body)
            ->withAttribute('userId', $userId);
        $resp = self::$ctrl->enqueue($req, (new ResponseFactory())->createResponse(), ['slug' => $this->slug]);
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    /** GET /api/app/{slug}/connector-commands/{id} as $userId. */
    private function read(string $userId, string $id): array
    {
        $req = (new ServerRequestFactory())->createServerRequest('GET', self::BASE . '/api/app/' . $this->slug . '/connector-commands/' . $id)
            ->withAttribute('userId', $userId);
        $resp = self::$ctrl->getCommand($req, (new ResponseFactory())->createResponse(), ['slug' => $this->slug, 'id' => $id]);
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    /** Desktop (api-key) claim. userId == owner. */
    private function claim(string $id, array $body = []): array
    {
        $req = (new ServerRequestFactory())->createServerRequest('POST', self::BASE . '/api/v1/connector-commands/' . $id . '/claim')
            ->withParsedBody($body)
            ->withAttribute('userId', $this->ownerId);
        $resp = self::$ctrl->claim($req, (new ResponseFactory())->createResponse(), ['id' => $id]);
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    private function complete(string $id, array $body): array
    {
        $req = (new ServerRequestFactory())->createServerRequest('POST', self::BASE . '/api/v1/connector-commands/' . $id . '/complete')
            ->withParsedBody($body)
            ->withAttribute('userId', $this->ownerId);
        $resp = self::$ctrl->complete($req, (new ResponseFactory())->createResponse(), ['id' => $id]);
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    private function pending(array $query = []): array
    {
        $req = (new ServerRequestFactory())->createServerRequest('GET', self::BASE . '/api/v1/connector-commands/pending')
            ->withQueryParams($query)
            ->withAttribute('userId', $this->ownerId);
        $resp = self::$ctrl->pending($req, (new ResponseFactory())->createResponse());
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    // ── the permission gate ──

    public function testMemberWithoutConnectorGrantIs403(): void
    {
        $r = $this->enqueue($this->memberId, ['connectorId' => 'aokie', 'command' => 'call']);
        $this->assertSame(403, $r['status'], 'a member without the connector grant cannot enqueue');
    }

    public function testMemberWithConnectorGrantCanEnqueue(): void
    {
        $this->grant('connector.aokie.call');
        $r = $this->enqueue($this->memberId, ['connectorId' => 'aokie', 'command' => 'call', 'payload' => ['to' => '+15550001']]);
        $this->assertSame(201, $r['status'], json_encode($r['body']));
        $this->assertSame('pending', $r['body']['status']);
        $this->assertNotEmpty($r['body']['commandId']);
    }

    public function testWildcardConnectorGrantIsAccepted(): void
    {
        $this->grant('connector.aokie.*');
        $r = $this->enqueue($this->memberId, ['connectorId' => 'aokie', 'command' => 'hangup']);
        $this->assertSame(201, $r['status'], json_encode($r['body']));
    }

    public function testOwnerAlwaysMayEnqueue(): void
    {
        $r = $this->enqueue($this->ownerId, ['connectorId' => 'aokie', 'command' => 'call']);
        $this->assertSame(201, $r['status'], 'the app owner is not gated by role grants');
    }

    public function testNonMemberIs403(): void
    {
        $stranger = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$stranger, $stranger . '@test.local']);
        try {
            $r = $this->enqueue($stranger, ['connectorId' => 'aokie', 'command' => 'call']);
            $this->assertSame(403, $r['status']);
        } finally {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$stranger]);
        }
    }

    // ── owner-only connector grants (the write path packs use) ──

    public function testOwnerGrantsConnectorCapabilityToMemberRoleThenMemberCanEnqueue(): void
    {
        // Grant through the owner-only service path (what a pack import uses), mixing in a non-connector
        // string that must be ignored. Previously connector grants were silently dropped by the
        // AppPermissions::ALL filter, so a member could never be granted connector access.
        self::$appUsers->setConnectorGrants($this->roleId, [
            ['permission' => 'connector.aokie.call.hangup'],
            ['permission' => 'view_analytics'], // not a connector grant → ignored here
        ], true);

        $this->assertTrue(self::$appUsers->hasPermission($this->appId, $this->memberId, 'connector.aokie.call.hangup'));
        $r = $this->enqueue($this->memberId, ['connectorId' => 'aokie', 'command' => 'call.hangup']);
        $this->assertSame(201, $r['status'], json_encode($r['body']));

        // Only the connector grant landed on the role.
        $stmt = self::$pdo->prepare("SELECT permission FROM app_role_permissions WHERE role_id = ?");
        $stmt->execute([$this->roleId]);
        $this->assertSame(['connector.aokie.call.hangup'], $stmt->fetchAll(PDO::FETCH_COLUMN));
    }

    public function testConnectorGrantsAreOwnerOnlyAndSurviveARoleEditorSave(): void
    {
        self::$appUsers->setConnectorGrants($this->roleId, [['permission' => 'connector.aokie.sms.send']], true);

        // A delegate (non-owner) may not grant connector capabilities.
        try {
            self::$appUsers->setConnectorGrants($this->roleId, [['permission' => 'connector.aokie.call.answer']], false);
            $this->fail('expected the owner-only guard to throw');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('owner', strtolower($e->getMessage()));
        }

        // A normal role-editor save (built-ins only) must NOT wipe the connector grant.
        self::$appUsers->setRolePermissions($this->roleId, [['formId' => null, 'permission' => 'view_analytics']], true);
        $this->assertTrue(self::$appUsers->hasPermission($this->appId, $this->memberId, 'connector.aokie.sms.send'), 'connector grant survives a role save');
        $this->assertTrue(self::$appUsers->hasPermission($this->appId, $this->memberId, 'view_analytics'), 'the built-in was applied');
    }

    public function testMalformedOrOverlongConnectorGrantsAreRejected(): void
    {
        self::$appUsers->setConnectorGrants($this->roleId, [
            ['permission' => 'connector.aokie.call.hangup'],                 // valid
            ['permission' => 'connector.'],                                  // no connector id
            ['permission' => 'connector.AOKIE.x'],                           // uppercase id
            ['permission' => 'connector.aokie.' . str_repeat('x', 200)],     // exceeds the 191 column
            ['permission' => 'manage_app'],                                  // not a connector grant
        ], true);
        $stmt = self::$pdo->prepare("SELECT permission FROM app_role_permissions WHERE role_id = ? AND permission LIKE 'connector.%'");
        $stmt->execute([$this->roleId]);
        $this->assertSame(['connector.aokie.call.hangup'], $stmt->fetchAll(PDO::FETCH_COLUMN));
    }

    // ── reserve-first idempotency ──

    public function testReserveFirstIdempotency(): void
    {
        $key = 'call-' . bin2hex(random_bytes(8));
        $first = $this->enqueue($this->ownerId, ['connectorId' => 'aokie', 'command' => 'call', 'idempotencyKey' => $key]);
        $this->assertSame(201, $first['status']);
        $second = $this->enqueue($this->ownerId, ['connectorId' => 'aokie', 'command' => 'call', 'idempotencyKey' => $key]);
        $this->assertSame(200, $second['status'], 'duplicate key returns the existing row, not a new one');
        $this->assertTrue($second['body']['idempotent'] ?? false);
        $this->assertSame($first['body']['commandId'], $second['body']['commandId']);
    }

    // ── claim exactly-once ──

    public function testClaimExactlyOnce(): void
    {
        $enq = $this->enqueue($this->ownerId, ['connectorId' => 'aokie', 'command' => 'call']);
        $id = $enq['body']['commandId'];

        // It shows up in the desktop long-poll (wait=0 → immediate).
        $pending = $this->pending(['wait' => 0]);
        $this->assertSame(200, $pending['status']);
        $ids = array_map(static fn ($c) => $c['commandId'], $pending['body']['commands']);
        $this->assertContains($id, $ids);

        $first = $this->claim($id, ['instanceId' => 'desk-1']);
        $this->assertSame(200, $first['status'], json_encode($first['body']));
        $this->assertSame('claimed', $first['body']['command']['status']);
        $this->assertSame('desk-1', $first['body']['command']['claimedBy']);

        $second = $this->claim($id, ['instanceId' => 'desk-2']);
        $this->assertSame(409, $second['status'], 'a second claim must lose');

        // Once claimed it no longer appears as pending.
        $after = $this->pending(['wait' => 0]);
        $this->assertNotContains($id, array_map(static fn ($c) => $c['commandId'], $after['body']['commands']));
    }

    // ── complete transitions ──

    public function testCompleteRequiresClaimThenIsTerminal(): void
    {
        $enq = $this->enqueue($this->ownerId, ['connectorId' => 'aokie', 'command' => 'call']);
        $id = $enq['body']['commandId'];

        // Completing a still-PENDING (unclaimed) command is a 409.
        $early = $this->complete($id, ['status' => 'done']);
        $this->assertSame(409, $early['status'], 'cannot complete before claim');

        $this->assertSame(200, $this->claim($id)['status']);
        $done = $this->complete($id, ['status' => 'done', 'result' => ['callId' => 'c-1', 'duration' => 42]]);
        $this->assertSame(200, $done['status'], json_encode($done['body']));
        $this->assertSame('done', $done['body']['command']['status']);
        $this->assertSame('c-1', $done['body']['command']['result']['callId']);

        // Web reads the outcome back.
        $read = $this->read($this->ownerId, $id);
        $this->assertSame(200, $read['status']);
        $this->assertSame('done', $read['body']['command']['status']);

        // A second completion is a 409 (already terminal).
        $again = $this->complete($id, ['status' => 'failed']);
        $this->assertSame(409, $again['status']);
    }

    // ── expiry ──

    public function testPendingExpires(): void
    {
        $enq = $this->enqueue($this->ownerId, ['connectorId' => 'aokie', 'command' => 'call']);
        $id = $enq['body']['commandId'];

        // Force the command past its expiry, then a poll sweeps it to 'expired'.
        self::$pdo->prepare("UPDATE desktop_commands SET expires_at = DATE_SUB(NOW(), INTERVAL 5 SECOND) WHERE id = ?")->execute([$id]);
        $pending = $this->pending(['wait' => 0]);
        $this->assertNotContains($id, array_map(static fn ($c) => $c['commandId'], $pending['body']['commands']), 'expired commands are not pending');

        // It can no longer be claimed, and its status is expired.
        $this->assertSame(409, $this->claim($id)['status']);
        $this->assertSame('expired', $this->read($this->ownerId, $id)['body']['command']['status']);
    }
}

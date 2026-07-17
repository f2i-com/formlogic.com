<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\ServiceInvokeController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AokieCompanionDeviceService;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FlowService;
use FormLogic\Services\FormService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * Typed service.invoke for pack-owned sandboxed screens (plan §8.3, APP-503):
 * POST /api/app/{slug}/service-invoke/{operationId}. Locks the registry gate
 * (unknown op = 404, no generic passthrough), the per-op permission +
 * connector-binding gates, the input byte cap, and — the load-bearing part —
 * that each response is a PROJECTION (companion device key material and
 * desktop-connection api key/instance ids never reach the sandbox).
 * Skipped without a test database.
 */
class ServiceInvokeTest extends TestCase
{
    private const BASE = 'http://localhost';

    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static ServiceInvokeController $ctrl;

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
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/formlogic-service-invoke-' . bin2hex(random_bytes(4)));
        $forms = new FormService($conn, $sqlite);
        $apps = new AppService($conn, $forms);
        self::$ctrl = new ServiceInvokeController(
            $apps,
            new AppUserService($conn),
            new FlowService($conn),
            new AokieCompanionDeviceService($conn)
        );
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
        $this->slug = 'svc-' . bin2hex(random_bytes(5));
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status) VALUES (?, ?, 'Svc', ?, 'published')")
            ->execute([$this->appId, $this->ownerId, $this->slug]);
        $this->roleId = 'role-' . bin2hex(random_bytes(10));
        self::$pdo->prepare("INSERT INTO app_roles (id, app_id, name, is_system, sort_order) VALUES (?, ?, 'Member', 0, 0)")
            ->execute([$this->roleId, $this->appId]);
        self::$pdo->prepare("INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at) VALUES (?, ?, ?, ?, 'active', NOW())")
            ->execute(['au-' . bin2hex(random_bytes(10)), $this->appId, $this->memberId, $this->roleId]);
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
        self::$pdo->prepare('DELETE FROM aokie_companion_devices WHERE app_id = ?')->execute([$this->appId]);
        self::$pdo->prepare('DELETE FROM desktop_connections WHERE owner_user_id = ?')->execute([$this->ownerId]);
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

    private function invoke(string $userId, string $operationId, array $input = []): array
    {
        $req = (new ServerRequestFactory())
            ->createServerRequest('POST', self::BASE . '/api/app/' . $this->slug . '/service-invoke/' . $operationId)
            ->withParsedBody(['input' => $input])
            ->withAttribute('userId', $userId);
        $resp = self::$ctrl->invoke($req, (new ResponseFactory())->createResponse(), [
            'slug' => $this->slug,
            'operationId' => $operationId,
        ]);
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    private function grant(string $permission): void
    {
        self::$pdo->prepare("INSERT INTO app_role_permissions (id, role_id, form_id, permission) VALUES (?, ?, NULL, ?)")
            ->execute(['arp-' . bin2hex(random_bytes(10)), $this->roleId, $permission]);
    }

    // ── the registry gate ──

    public function testUnknownOperationIs404NeverAPassthrough(): void
    {
        $r = $this->invoke($this->ownerId, 'admin.users.list');
        $this->assertSame(404, $r['status']);
        $this->assertSame('unknown_operation', $r['body']['code'] ?? null);
    }

    public function testOversizedInputIs400(): void
    {
        $r = $this->invoke($this->ownerId, 'desktop.connections.list', ['blob' => str_repeat('x', 3000)]);
        $this->assertSame(400, $r['status']);
        $this->assertSame('input_too_large', $r['body']['code'] ?? null);
    }

    // ── desktop.connections.list (owner-only, projected) ──

    public function testDesktopConnectionsListIsOwnerOnlyAndProjected(): void
    {
        self::$pdo->prepare(
            "INSERT INTO desktop_connections
                (id, owner_user_id, device_name, desktop_instance_id, api_key_id, last_seen_at, capabilities_json, trusted_origins_json)
             VALUES (?, ?, 'DESKTOP-HOME', 'desktop-abc123', 'key-SECRET', NOW(), '[\"flows:read\"]', '[\"http://formlogic.local\"]')"
        )->execute(['dc-' . bin2hex(random_bytes(10)), $this->ownerId]);

        // A plain member (no owner rights) is refused.
        $member = $this->invoke($this->memberId, 'desktop.connections.list');
        $this->assertSame(403, $member['status']);

        $r = $this->invoke($this->ownerId, 'desktop.connections.list');
        $this->assertSame(200, $r['status']);
        $connections = $r['body']['result']['connections'] ?? [];
        $this->assertCount(1, $connections);
        $this->assertSame('DESKTOP-HOME', $connections[0]['deviceName']);
        $this->assertNotEmpty($connections[0]['lastSeenAt']);
        // The projection must NOT leak key material, instance ids, capabilities
        // or trusted origins into the sandbox.
        $this->assertSame(['id', 'deviceName', 'lastSeenAt', 'createdAt'], array_keys($connections[0]));
    }

    // ── aokie.companion.devices.list (companion audit + connector binding) ──

    public function testCompanionDevicesRequireAuditPermissionAndConnectorBinding(): void
    {
        self::$pdo->prepare(
            "INSERT INTO aokie_companion_devices
                (id, user_id, app_id, subject_id, role, display_name, grants, holder_key_thumbprint, endpoint_public_key)
             VALUES (?, ?, ?, 'subject-1', 'mobile', 'Pixel 9', '{\"sms\":true}', 'THUMBPRINT-SECRET', '{\"kty\":\"OKP\"}')"
        )->execute(['acd-' . bin2hex(random_bytes(10)), $this->ownerId, $this->appId]);

        // Member without any grant: refused.
        $this->assertSame(403, $this->invoke($this->memberId, 'aokie.companion.devices.list')['status']);

        // Audit permission alone is NOT enough — the op is bound to the aokie
        // connector, so the role must also hold a connector.aokie grant.
        $this->grant(\FormLogic\Constants\AppPermissions::AOKIE_COMPANION_AUDIT);
        $this->assertSame(403, $this->invoke($this->memberId, 'aokie.companion.devices.list')['status']);

        $this->grant('connector.aokie.settings.get');
        $r = $this->invoke($this->memberId, 'aokie.companion.devices.list');
        $this->assertSame(200, $r['status']);
        $devices = $r['body']['result']['devices'] ?? [];
        $this->assertCount(1, $devices);
        $this->assertSame('Pixel 9', $devices[0]['displayName']);
        // Identity/key columns are DELIBERATELY not projected.
        $this->assertSame(
            ['id', 'role', 'displayName', 'grants', 'approvedAt', 'lastSeenAt', 'revokedAt'],
            array_keys($devices[0])
        );

        // The owner always passes (hasPermission short-circuits + grants → ['*']).
        $this->assertSame(200, $this->invoke($this->ownerId, 'aokie.companion.devices.list')['status']);
    }

    // ── mutating companion ops (revoke / approve / policy.update) ──

    /** @return string the inserted device id */
    private function insertDevice(string $ownerUserId, string $displayName = 'Pixel 9'): string
    {
        $id = 'acd-' . bin2hex(random_bytes(10));
        self::$pdo->prepare(
            "INSERT INTO aokie_companion_devices
                (id, user_id, app_id, subject_id, role, display_name, grants)
             VALUES (?, ?, ?, ?, 'mobile', ?, '{\"sms\":true}')"
        )->execute([$id, $ownerUserId, $this->appId, 'subject-' . $id, $displayName]);
        return $id;
    }

    public function testDeviceRevokeAllowsSelfAndManagerButNeverAStranger(): void
    {
        // The member owns their own endpoint; a second device belongs to the owner.
        $own = $this->insertDevice($this->memberId, 'Member phone');
        $theirs = $this->insertDevice($this->ownerId, 'Owner phone');
        $this->grant('connector.aokie.settings.get'); // connector binding only — no manage

        // Self-revoke works without the manage permission…
        $r = $this->invoke($this->memberId, 'aokie.companion.devices.revoke', ['deviceId' => $own]);
        $this->assertSame(200, $r['status']);
        $this->assertTrue($r['body']['result']['success']);

        // …but another user's device reads as not-found (never a permission oracle).
        $r2 = $this->invoke($this->memberId, 'aokie.companion.devices.revoke', ['deviceId' => $theirs]);
        $this->assertSame(404, $r2['status']);
        $this->assertSame('device_not_found', $r2['body']['code'] ?? null);

        // The owner (manage implied) can revoke anyone's.
        $r3 = $this->invoke($this->ownerId, 'aokie.companion.devices.revoke', ['deviceId' => $theirs]);
        $this->assertSame(200, $r3['status']);
    }

    public function testDeviceApproveNeedsManageAndStaysAppScoped(): void
    {
        $id = $this->insertDevice($this->ownerId);
        self::$pdo->prepare('UPDATE aokie_companion_devices SET revoked_at = NOW() WHERE id = ?')->execute([$id]);

        // Member with connector binding but no manage permission: 403 at the registry gate.
        $this->grant('connector.aokie.settings.get');
        $this->assertSame(403, $this->invoke($this->memberId, 'aokie.companion.devices.approve', ['deviceId' => $id])['status']);

        // With MANAGE_AOKIE_COMPANION it succeeds and requires re-authorization.
        $this->grant(\FormLogic\Constants\AppPermissions::MANAGE_AOKIE_COMPANION);
        $r = $this->invoke($this->memberId, 'aokie.companion.devices.approve', ['deviceId' => $id]);
        $this->assertSame(200, $r['status']);
        $this->assertTrue($r['body']['result']['reauthorizationRequired']);

        // A device from ANOTHER app must read as not-found even for a manager.
        $foreignApp = 'app-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status) VALUES (?, ?, 'Other', ?, 'published')")
            ->execute([$foreignApp, $this->ownerId, 'other-' . bin2hex(random_bytes(5))]);
        $foreignId = 'acd-' . bin2hex(random_bytes(10));
        self::$pdo->prepare(
            "INSERT INTO aokie_companion_devices (id, user_id, app_id, subject_id, role, display_name, grants)
             VALUES (?, ?, ?, 'subject-x', 'mobile', 'Foreign', '{}')"
        )->execute([$foreignId, $this->ownerId, $foreignApp]);
        try {
            $r2 = $this->invoke($this->ownerId, 'aokie.companion.devices.approve', ['deviceId' => $foreignId]);
            $this->assertSame(404, $r2['status']);
        } finally {
            self::$pdo->prepare('DELETE FROM aokie_companion_devices WHERE id = ?')->execute([$foreignId]);
            self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$foreignApp]);
        }
    }

    public function testPolicyUpdateValidatesShapeAndRoundTrips(): void
    {
        $this->grant('connector.aokie.settings.get');
        $this->grant(\FormLogic\Constants\AppPermissions::MANAGE_AOKIE_COMPANION);

        // A partial policy object is refused outright.
        $bad = $this->invoke($this->memberId, 'aokie.companion.policy.update', ['remoteConsent' => ['remoteMonitoring' => true]]);
        $this->assertSame(400, $bad['status']);
        $this->assertSame('invalid_remote_consent', $bad['body']['code'] ?? null);

        $policy = [
            'remoteMonitoring' => true,
            'remoteConsult' => true,
            'remoteTakeover' => false,
            'remoteCaptions' => true,
            'remoteAssistance' => false,
        ];
        $r = $this->invoke($this->memberId, 'aokie.companion.policy.update', ['remoteConsent' => $policy]);
        $this->assertSame(200, $r['status']);
        $this->assertTrue($r['body']['result']['configured']);
        $this->assertFalse($r['body']['result']['remoteTakeover']);

        // …and the READ op sees exactly what was written.
        $read = $this->invoke($this->memberId, 'aokie.companion.policy.get');
        $this->assertSame(200, $read['status']);
        $this->assertTrue($read['body']['result']['remoteMonitoring']);
        $this->assertFalse($read['body']['result']['remoteAssistance']);
    }

    // ── aokie.companion.policy.get (member + connector binding) ──

    public function testCompanionPolicyClosedByDefaultAndReadableByConnectorMembers(): void
    {
        // Member without a connector.aokie grant: refused (binding).
        $this->assertSame(403, $this->invoke($this->memberId, 'aokie.companion.policy.get')['status']);

        $this->grant('connector.aokie.settings.get');
        $r = $this->invoke($this->memberId, 'aokie.companion.policy.get');
        $this->assertSame(200, $r['status']);
        $this->assertFalse($r['body']['result']['configured']);
        $this->assertFalse($r['body']['result']['remoteTakeover']);

        // A configured policy round-trips its booleans.
        $settings = json_encode(['aokieCompanion' => ['remoteConsent' => [
            'remoteMonitoring' => true,
            'remoteConsult' => false,
            'remoteTakeover' => false,
            'remoteCaptions' => true,
            'remoteAssistance' => false,
        ]]]);
        self::$pdo->prepare('UPDATE apps SET settings = ? WHERE id = ?')->execute([$settings, $this->appId]);
        $r2 = $this->invoke($this->memberId, 'aokie.companion.policy.get');
        $this->assertSame(200, $r2['status']);
        $this->assertTrue($r2['body']['result']['configured']);
        $this->assertTrue($r2['body']['result']['remoteMonitoring']);
        $this->assertTrue($r2['body']['result']['remoteCaptions']);
        $this->assertFalse($r2['body']['result']['remoteTakeover']);
    }
}

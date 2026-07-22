<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\DesktopOpsController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Services\DesktopCommandService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * Desktop ops relay (docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md §5.3, Phase 3): the op
 * allow-list, per-op target-id validation, the linked-desktop and lifecycle tier gates,
 * enqueue into desktop_commands under the reserved connector_id 'desktop' with server-side
 * target resolution (incl. 409 ambiguous_desktop), idempotent re-enqueue, and the GET
 * read-back being truthful about a claimed-but-unreported op ('uncertain'). Skipped
 * without a test database.
 */
class DesktopOpsTest extends TestCase
{
    private const BASE = 'http://localhost';

    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static DesktopOpsController $ctrl;

    private string $userId = '';

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
        self::$ctrl = new DesktopOpsController(new DesktopCommandService($conn));
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->userId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$this->userId, $this->userId . '@test.local']);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null || $this->userId === '') {
            return;
        }
        self::$pdo->prepare('DELETE FROM desktop_commands WHERE owner_user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM desktop_connections WHERE owner_user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
    }

    // ── helpers ──

    private static function decode(ResponseInterface $resp): array
    {
        $resp->getBody()->rewind();
        return json_decode((string) $resp->getBody(), true) ?: [];
    }

    private function enqueue(?string $userId, array $body): array
    {
        $req = (new ServerRequestFactory())->createServerRequest('POST', self::BASE . '/api/desktop/ops')
            ->withParsedBody($body);
        if ($userId !== null) {
            $req = $req->withAttribute('userId', $userId);
        }
        $resp = self::$ctrl->enqueue($req, (new ResponseFactory())->createResponse());
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    private function getOp(?string $userId, string $id): array
    {
        $req = (new ServerRequestFactory())->createServerRequest('GET', self::BASE . '/api/desktop/ops/' . $id);
        if ($userId !== null) {
            $req = $req->withAttribute('userId', $userId);
        }
        $resp = self::$ctrl->getOp($req, (new ResponseFactory())->createResponse(), ['id' => $id]);
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    private function addConnection(string $instanceId, bool $fresh = true): void
    {
        self::$pdo->prepare(
            "INSERT INTO desktop_connections (id, owner_user_id, device_name, desktop_instance_id, last_seen_at)
             VALUES (?, ?, 'TestBox', ?, " . ($fresh ? 'NOW()' : 'NULL') . ')'
        )->execute(['dc-' . bin2hex(random_bytes(8)), $this->userId, $instanceId]);
    }

    private function commandRow(string $id): ?array
    {
        $stmt = self::$pdo->prepare('SELECT connector_id, command, payload_json, app_id, status, target_instance_id FROM desktop_commands WHERE id = ?');
        $stmt->execute([$id]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row ?: null;
    }

    // ── validation + gates ──

    public function testOpAllowListAndTargetValidation(): void
    {
        $this->addConnection('inst-a');

        $bad = $this->enqueue($this->userId, ['op' => 'desktop.services.nuke']);
        $this->assertSame(400, $bad['status']);
        $this->assertSame('unknown_op', $bad['body']['code']);

        $missing = $this->enqueue($this->userId, ['op' => 'desktop.services.restart']);
        $this->assertSame(400, $missing['status']);
        $this->assertStringContainsString('serviceId', (string) $missing['body']['message']);

        $badId = $this->enqueue($this->userId, ['op' => 'desktop.services.restart', 'serviceId' => 'bad id!']);
        $this->assertSame(400, $badId['status']);

        $missingPlugin = $this->enqueue($this->userId, ['op' => 'desktop.plugins.health']);
        $this->assertSame(400, $missingPlugin['status']);
        $this->assertStringContainsString('pluginId', (string) $missingPlugin['body']['message']);

        $noAuth = $this->enqueue(null, ['op' => 'desktop.services.list']);
        $this->assertSame(401, $noAuth['status']);
    }

    public function testLinkedDesktopGate(): void
    {
        // No desktop_connections row at all → honest no_linked_desktop, even for read ops.
        $out = $this->enqueue($this->userId, ['op' => 'desktop.services.list']);
        $this->assertSame(404, $out['status']);
        $this->assertSame('no_linked_desktop', $out['body']['code']);
    }

    // ── enqueue ──

    public function testEnqueueLifecycleOpUnderReservedConnector(): void
    {
        $this->addConnection('inst-a');
        $out = $this->enqueue($this->userId, ['op' => 'desktop.services.restart', 'serviceId' => 'llama-cpp']);
        $this->assertSame(201, $out['status']);
        $this->assertSame('pending', $out['body']['data']['status']);
        $this->assertSame('inst-a', $out['body']['data']['targetInstanceId']);

        $row = $this->commandRow($out['body']['data']['commandId']);
        $this->assertNotNull($row);
        $this->assertSame('desktop', $row['connector_id']);
        // Cross-side seam pin: the stored command is the SHORT verb — the desktop's
        // DesktopOp::from_command rejects prefixed names ('desktop.' = connector id).
        $this->assertSame('services.restart', $row['command']);
        // Cross-side seam pin: the target rides the payload as `id` (never serviceId /
        // pluginId — those are HTTP-body keys only). desktop_ops::execute reads payload.id.
        $this->assertSame(['id' => 'llama-cpp'], json_decode((string) $row['payload_json'], true));
        $this->assertNull($row['app_id']); // account-scoped, never app-scoped
        $this->assertSame('inst-a', $row['target_instance_id']);
    }

    public function testEnqueueReadOps(): void
    {
        $this->addConnection('inst-a');
        $list = $this->enqueue($this->userId, ['op' => 'desktop.services.list']);
        $this->assertSame(201, $list['status']);
        $health = $this->enqueue($this->userId, ['op' => 'desktop.plugins.health', 'pluginId' => 'aokie']);
        $this->assertSame(201, $health['status']);
        $row = $this->commandRow($health['body']['data']['commandId']);
        $this->assertSame('plugins.health', $row['command']);
        $this->assertSame(['id' => 'aokie'], json_decode((string) $row['payload_json'], true));
    }

    public function testEnqueueIsIdempotentOnKey(): void
    {
        $this->addConnection('inst-a');
        $body = ['op' => 'desktop.plugins.restart', 'pluginId' => 'aokie', 'idempotencyKey' => 'op-' . bin2hex(random_bytes(8))];
        $first = $this->enqueue($this->userId, $body);
        $this->assertSame(201, $first['status']);
        $second = $this->enqueue($this->userId, $body);
        $this->assertSame(200, $second['status']);
        $this->assertTrue($second['body']['data']['idempotent']);
        $this->assertSame($first['body']['data']['commandId'], $second['body']['data']['commandId']);
    }

    public function testAmbiguousDesktopIsA409(): void
    {
        $this->addConnection('inst-a');
        $this->addConnection('inst-b');
        $out = $this->enqueue($this->userId, ['op' => 'desktop.services.list']);
        $this->assertSame(409, $out['status']);
        $this->assertSame('ambiguous_desktop', $out['body']['code']);
        $this->assertCount(2, $out['body']['details']['desktops']);
    }

    // ── read-back + truthful uncertain ──

    public function testGetOpReturnsTheCommand(): void
    {
        $this->addConnection('inst-a');
        $enq = $this->enqueue($this->userId, ['op' => 'desktop.services.stop', 'serviceId' => 'aokie-voice']);
        $id = $enq['body']['data']['commandId'];
        $got = $this->getOp($this->userId, $id);
        $this->assertSame(200, $got['status']);
        $this->assertSame($id, $got['body']['data']['commandId']);
        $this->assertSame('pending', $got['body']['data']['status']);
        $this->assertSame('TestBox', $got['body']['data']['targetDeviceName']);
    }

    public function testClaimedButUnreportedReadsAsUncertain(): void
    {
        $this->addConnection('inst-a');
        $enq = $this->enqueue($this->userId, ['op' => 'desktop.services.start', 'serviceId' => 'llama-cpp']);
        $id = $enq['body']['data']['commandId'];

        // The desktop claimed it, then vanished past the command's TTL without completing.
        self::$pdo->prepare("UPDATE desktop_commands SET status = 'claimed', claimed_by = 'inst-a', claimed_at = (NOW() - INTERVAL 5 MINUTE), expires_at = (NOW() - INTERVAL 4 MINUTE) WHERE id = ?")
            ->execute([$id]);
        $got = $this->getOp($this->userId, $id);
        $this->assertSame('claimed', $got['body']['data']['status']);
        $this->assertTrue($got['body']['data']['uncertain']);

        // Same truth after the stale-claim sweep marked it 'expired'.
        self::$pdo->prepare("UPDATE desktop_commands SET status = 'expired' WHERE id = ?")->execute([$id]);
        $expiredClaimed = $this->getOp($this->userId, $id)['body']['data'];
        $this->assertSame('expired', $expiredClaimed['status']);
        $this->assertTrue($expiredClaimed['uncertain']);

        // A genuinely completed op stays done (with its result).
        self::$pdo->prepare("UPDATE desktop_commands SET status = 'done', finished_at = NOW(), result_json = '{\"ok\":true}' WHERE id = ?")
            ->execute([$id]);
        $done = $this->getOp($this->userId, $id)['body']['data'];
        $this->assertSame('done', $done['status']);
        $this->assertSame(['ok' => true], $done['result']);

        // A never-claimed expiry is a plain 'expired', not 'uncertain'.
        $enq2 = $this->enqueue($this->userId, ['op' => 'desktop.services.list']);
        $id2 = $enq2['body']['data']['commandId'];
        self::$pdo->prepare("UPDATE desktop_commands SET status = 'expired', expires_at = (NOW() - INTERVAL 1 MINUTE) WHERE id = ?")
            ->execute([$id2]);
        $expiredUnclaimed = $this->getOp($this->userId, $id2)['body']['data'];
        $this->assertSame('expired', $expiredUnclaimed['status']);
        $this->assertArrayNotHasKey('uncertain', $expiredUnclaimed);
    }

    public function testGetOpRefusesForeignAndNonOpsCommands(): void
    {
        $this->addConnection('inst-a');
        $enq = $this->enqueue($this->userId, ['op' => 'desktop.services.list']);
        $id = $enq['body']['data']['commandId'];

        $this->assertSame(401, $this->getOp(null, $id)['status']);

        // Another user's read of the same id → 404 (no cross-account visibility).
        $other = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$other, $other . '@test.local']);
        try {
            $this->assertSame(404, $this->getOp($other, $id)['status']);
        } finally {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$other]);
        }

        // A connector command (not an ops command) must not leak through this surface.
        self::$pdo->prepare("INSERT INTO desktop_commands
                (id, owner_user_id, app_id, connector_id, command, payload_json, idempotency_key, status, requested_by_user_id, expires_at)
            VALUES (?, ?, NULL, 'aokie', 'phone.status', NULL, ?, 'pending', ?, (NOW() + INTERVAL 1 MINUTE))")
            ->execute(['cmd-' . bin2hex(random_bytes(8)), $this->userId, 'idem-' . bin2hex(random_bytes(8)), $this->userId]);
        $connId = self::$pdo->query("SELECT id FROM desktop_commands WHERE connector_id = 'aokie' AND owner_user_id = " . self::$pdo->quote($this->userId))->fetchColumn();
        $this->assertSame(404, $this->getOp($this->userId, (string) $connId)['status']);
    }
}

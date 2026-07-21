<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\DesktopFlowRelayController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Services\DesktopCommandService;
use FormLogic\Services\DesktopFlowRelayService;
use FormLogic\Services\FlowService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * E2E flow-run relay (docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md Phase 5 §5.7): the
 * sealed-envelope queue between a web member and their linked desktop for 'desktop'
 * execution-location flows. Covers the full lifecycle (enqueue → poll → claim → progress
 * frames → complete with a sealed result), reserve-first idempotency, the single-flight
 * claim (lane_busy), FIFO order + live queue position, the per-user/per-target caps (2/4),
 * the 15-minute TTL, content purge on complete AND on expiry, the READ-ONCE result
 * envelope (first GET returns it, later GETs show resultAvailable=false), result retention
 * GC, flk_ scope acceptance (flows:relay plus the grandfathered connector:relay),
 * requesting-user enforcement on the web {id} routes (incl. SSE auth), and flow ownership
 * validation at enqueue. Skipped without a test database.
 */
class DesktopFlowRelayTest extends TestCase
{
    private const BASE = 'http://localhost';

    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static DesktopFlowRelayService $relay;
    private static DesktopFlowRelayController $ctrl;
    private static FlowService $flows;

    private string $ownerId = '';
    private string $otherId = '';
    private string $flowId = '';

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
        self::$relay = new DesktopFlowRelayService($conn);
        self::$flows = new FlowService($conn);
        self::$ctrl = new DesktopFlowRelayController(self::$relay, new DesktopCommandService($conn), self::$flows);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->ownerId = $this->addUser();
        $this->otherId = $this->addUser();
        $this->flowId = self::$flows->createWorkspaceFlow($this->ownerId, [
            'name' => 'Relay test flow',
            'flowJson' => ['nodes' => [['id' => 'in', 'type' => 'input']], 'edges' => []],
        ])['id'];
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        foreach ([$this->ownerId, $this->otherId] as $uid) {
            if ($uid === '') {
                continue;
            }
            self::$pdo->prepare('DELETE f FROM desktop_flow_run_frames f JOIN desktop_flow_runs r ON f.request_id = r.id WHERE r.owner_user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM desktop_flow_runs WHERE owner_user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM desktop_connections WHERE owner_user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM flow_definitions WHERE owner_user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
        }
    }

    // ── helpers ──

    private static function decode(ResponseInterface $resp): array
    {
        $resp->getBody()->rewind();
        return json_decode((string) $resp->getBody(), true) ?: [];
    }

    private function addUser(): string
    {
        $uid = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$uid, $uid . '@test.local']);
        return $uid;
    }

    private function addConnection(string $instanceId, bool $fresh = true): void
    {
        self::$pdo->prepare(
            "INSERT INTO desktop_connections (id, owner_user_id, device_name, desktop_instance_id, last_seen_at)
             VALUES (?, ?, 'TestBox', ?, " . ($fresh ? 'NOW()' : 'NULL') . ')'
        )->execute(['dc-' . bin2hex(random_bytes(8)), $this->ownerId, $instanceId]);
    }

    /** A valid sealed-run body (the backend never interprets the opaque bytes). */
    private function sealedBody(array $extra = []): array
    {
        return $extra + [
            'flowId' => $this->flowId,
            'ephPub' => base64_encode(random_bytes(32)),
            'envelope' => base64_encode('sealed-run-inputs'),
        ];
    }

    /** POST /api/desktop/flows/run as $userId. */
    private function webEnqueue(string $userId, array $body): array
    {
        $req = (new ServerRequestFactory())->createServerRequest('POST', self::BASE . '/api/desktop/flows/run')
            ->withParsedBody($body)
            ->withAttribute('userId', $userId);
        $resp = self::$ctrl->enqueue($req, (new ResponseFactory())->createResponse());
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    /** GET /api/desktop/flows/runs/{id} as $userId. */
    private function webGet(string $userId, string $id): array
    {
        $req = (new ServerRequestFactory())->createServerRequest('GET', self::BASE . '/api/desktop/flows/runs/' . $id)
            ->withAttribute('userId', $userId);
        $resp = self::$ctrl->getRun($req, (new ResponseFactory())->createResponse(), ['id' => $id]);
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    /**
     * GET /api/desktop/flows/runs/{id}/stream as $userId — ERROR PATHS ONLY: an authorized
     * call enters the raw SSE loop, which never returns to PHPUnit.
     */
    private function webStream(?string $userId, string $id): array
    {
        $req = (new ServerRequestFactory())->createServerRequest('GET', self::BASE . '/api/desktop/flows/runs/' . $id . '/stream');
        if ($userId !== null) {
            $req = $req->withAttribute('userId', $userId);
        }
        $resp = self::$ctrl->stream($req, (new ResponseFactory())->createResponse(), ['id' => $id]);
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    /** Desktop (flk_) request shape: userId == owner, explicit apiKeyScopes like ApiKeyMiddleware sets. */
    private function v1Request(string $method, string $path, array $scopes, array $body = [], array $query = []): \Psr\Http\Message\ServerRequestInterface
    {
        return (new ServerRequestFactory())->createServerRequest($method, self::BASE . $path)
            ->withParsedBody($body)
            ->withQueryParams($query)
            ->withAttribute('userId', $this->ownerId)
            ->withAttribute('apiKeyScopes', $scopes);
    }

    private function v1Pending(array $scopes, array $query = []): array
    {
        $resp = self::$ctrl->pendingV1($this->v1Request('GET', '/api/v1/desktop-flows/pending', $scopes, [], $query), (new ResponseFactory())->createResponse());
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    private function v1Claim(string $id, array $scopes, array $body = []): array
    {
        $resp = self::$ctrl->claimV1($this->v1Request('POST', '/api/v1/desktop-flows/' . $id . '/claim', $scopes, $body), (new ResponseFactory())->createResponse(), ['id' => $id]);
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    private function v1Frame(string $id, array $scopes, array $body): array
    {
        $resp = self::$ctrl->postFrameV1($this->v1Request('POST', '/api/v1/desktop-flows/' . $id . '/frames', $scopes, $body), (new ResponseFactory())->createResponse(), ['id' => $id]);
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    private function v1Complete(string $id, array $scopes, array $body): array
    {
        $resp = self::$ctrl->completeV1($this->v1Request('POST', '/api/v1/desktop-flows/' . $id . '/complete', $scopes, $body), (new ResponseFactory())->createResponse(), ['id' => $id]);
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    /** Raw column reads for purge assertions (the API deliberately hides purged content). */
    private function rawRunRow(string $id): ?array
    {
        $stmt = self::$pdo->prepare('SELECT * FROM desktop_flow_runs WHERE id = ?');
        $stmt->execute([$id]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    private function frameCount(string $id): int
    {
        $stmt = self::$pdo->prepare('SELECT COUNT(*) FROM desktop_flow_run_frames WHERE request_id = ?');
        $stmt->execute([$id]);
        return (int) $stmt->fetchColumn();
    }

    // ── lifecycle ──

    public function testFullLifecycleEnqueueClaimStreamCompleteResultReadOnce(): void
    {
        $enq = $this->webEnqueue($this->ownerId, $this->sealedBody());
        $this->assertSame(201, $enq['status'], json_encode($enq['body']));
        $this->assertSame('pending', $enq['body']['status']);
        $this->assertSame(0, $enq['body']['queuePos']);
        $id = $enq['body']['requestId'];

        // The desktop long-poll (wait=0 → immediate) sees it.
        $pending = $this->v1Pending(['flows:relay'], ['wait' => 0, 'instanceId' => 'desk-1']);
        $this->assertSame(200, $pending['status']);
        $ids = array_map(static fn ($r) => $r['requestId'], $pending['body']['requests']);
        $this->assertContains($id, $ids);
        $row = $pending['body']['requests'][array_search($id, $ids, true)];
        $this->assertSame($this->flowId, $row['flowId']);

        // Claim single-flight, then stream sealed progress frames back.
        $claim = $this->v1Claim($id, ['flows:relay'], ['instanceId' => 'desk-1']);
        $this->assertSame(200, $claim['status'], json_encode($claim['body']));
        $this->assertSame('claimed', $claim['body']['request']['status']);
        $this->assertSame('desk-1', $claim['body']['request']['claimedBy']);
        $this->assertNotEmpty($claim['body']['request']['envelope'], 'the claimant receives the sealed envelope');

        $frame = $this->v1Frame($id, ['flows:relay'], ['instanceId' => 'desk-1', 'envelope' => base64_encode('sealed-progress-1')]);
        $this->assertSame(201, $frame['status'], json_encode($frame['body']));
        $this->assertSame('streaming', $frame['body']['status']);
        // A second frame inside the same second must still append (no changed-rows trap).
        $frame2 = $this->v1Frame($id, ['flows:relay'], ['instanceId' => 'desk-1', 'envelope' => base64_encode('sealed-progress-2')]);
        $this->assertSame(201, $frame2['status']);

        // The web SSE feed source sees both sealed frames in order.
        $out = self::$relay->fetchOutput($id, $this->ownerId, 0);
        $this->assertCount(2, $out);
        $this->assertSame(base64_encode('sealed-progress-1'), $out[0]['envelope']);
        $this->assertSame(base64_encode('sealed-progress-2'), $out[1]['envelope']);
        $this->assertGreaterThan($out[0]['seq'], $out[1]['seq']);

        // Complete with a sealed result: envelope + frames purge, the result is kept for one read.
        $done = $this->v1Complete($id, ['flows:relay'], ['instanceId' => 'desk-1', 'status' => 'done', 'resultEnvelope' => base64_encode('sealed-result')]);
        $this->assertSame(200, $done['status'], json_encode($done['body']));
        $this->assertSame('done', $done['body']['request']['status']);
        $this->assertNull($done['body']['request']['envelope']);
        $raw = $this->rawRunRow($id);
        $this->assertNull($raw['envelope'], 'complete() purges the request envelope');
        $this->assertSame(0, $this->frameCount($id), 'complete() purges the frames');
        $this->assertNotNull($raw['result_envelope'], 'complete() keeps the sealed result for the read-once');

        // First web read returns the sealed result — and consumes it.
        $read = $this->webGet($this->ownerId, $id);
        $this->assertSame(200, $read['status']);
        $this->assertSame(base64_encode('sealed-result'), $read['body']['request']['resultEnvelope']);
        $this->assertTrue($read['body']['request']['resultAvailable']);
        $this->assertSame(0, $read['body']['request']['queuePos']);

        // Second read: the result is gone (read-once-then-purge).
        $again = $this->webGet($this->ownerId, $id);
        $this->assertNull($again['body']['request']['resultEnvelope']);
        $this->assertFalse($again['body']['request']['resultAvailable']);
        $this->assertNull($this->rawRunRow($id)['result_envelope'], 'the first read purged the result');
    }

    public function testCompleteFailedAlsoKeepsTheResultForOneRead(): void
    {
        $id = $this->webEnqueue($this->ownerId, $this->sealedBody())['body']['requestId'];
        $this->assertSame(200, $this->v1Claim($id, ['flows:relay'], ['instanceId' => 'desk-1'])['status']);
        $failed = $this->v1Complete($id, ['flows:relay'], ['instanceId' => 'desk-1', 'status' => 'failed', 'resultEnvelope' => base64_encode('sealed-error')]);
        $this->assertSame(200, $failed['status'], json_encode($failed['body']));
        $read = $this->webGet($this->ownerId, $id);
        $this->assertSame('failed', $read['body']['request']['status']);
        $this->assertSame(base64_encode('sealed-error'), $read['body']['request']['resultEnvelope']);
        $this->assertFalse($this->webGet($this->ownerId, $id)['body']['request']['resultAvailable']);
    }

    // ── reserve-first idempotency ──

    public function testReserveFirstIdempotency(): void
    {
        $key = 'flowrun-' . bin2hex(random_bytes(8));
        $first = $this->webEnqueue($this->ownerId, $this->sealedBody(['idempotencyKey' => $key]));
        $this->assertSame(201, $first['status']);
        $second = $this->webEnqueue($this->ownerId, $this->sealedBody(['idempotencyKey' => $key]));
        $this->assertSame(200, $second['status'], 'duplicate key returns the existing row, not a new one');
        $this->assertTrue($second['body']['idempotent'] ?? false);
        $this->assertSame($first['body']['requestId'], $second['body']['requestId']);
    }

    public function testEnqueueValidation(): void
    {
        $bad = $this->webEnqueue($this->ownerId, $this->sealedBody(['envelope' => '!!!not-base64!!!']));
        $this->assertSame(400, $bad['status']);
        $missing = $this->webEnqueue($this->ownerId, ['flowId' => $this->flowId]);
        $this->assertSame(400, $missing['status']);
        $badKey = $this->webEnqueue($this->ownerId, $this->sealedBody(['ephPub' => base64_encode('too-short')]));
        $this->assertSame(400, $badKey['status']);
    }

    public function testEnqueueRequiresAnOwnedFlow(): void
    {
        $unknown = $this->webEnqueue($this->ownerId, $this->sealedBody(['flowId' => 'no-such-flow']));
        $this->assertSame(404, $unknown['status']);
        // A flow owned by someone else is equally invisible (no existence oracle).
        $foreign = $this->webEnqueue($this->otherId, $this->sealedBody());
        $this->assertSame(404, $foreign['status']);
    }

    // ── claim: exactly-once + single-flight ──

    public function testClaimExactlyOnce(): void
    {
        $enq = $this->webEnqueue($this->ownerId, $this->sealedBody());
        $id = $enq['body']['requestId'];

        $first = $this->v1Claim($id, ['flows:relay'], ['instanceId' => 'desk-1']);
        $this->assertSame(200, $first['status'], json_encode($first['body']));
        $second = $this->v1Claim($id, ['flows:relay'], ['instanceId' => 'desk-2']);
        $this->assertSame(409, $second['status'], 'a second claim of the same run must lose');

        $after = $this->v1Pending(['flows:relay'], ['wait' => 0]);
        $this->assertNotContains($id, array_map(static fn ($r) => $r['requestId'], $after['body']['requests']));
    }

    public function testSingleFlightLaneBusyUntilSiblingCompletes(): void
    {
        $a = $this->webEnqueue($this->ownerId, $this->sealedBody())['body']['requestId'];
        $b = $this->webEnqueue($this->ownerId, $this->sealedBody())['body']['requestId'];

        $this->assertSame(200, $this->v1Claim($a, ['flows:relay'], ['instanceId' => 'desk-1'])['status']);
        $busy = $this->v1Claim($b, ['flows:relay'], ['instanceId' => 'desk-1']);
        $this->assertSame(409, $busy['status'], 'the lane is single-flight per target');
        $this->assertSame('lane_busy', $busy['body']['code'] ?? null);

        $this->assertSame(200, $this->v1Complete($a, ['flows:relay'], ['instanceId' => 'desk-1', 'status' => 'done'])['status']);
        $freed = $this->v1Claim($b, ['flows:relay'], ['instanceId' => 'desk-1']);
        $this->assertSame(200, $freed['status'], 'completing the sibling frees the lane');
    }

    public function testClaimantBindingOnFramesAndComplete(): void
    {
        $id = $this->webEnqueue($this->ownerId, $this->sealedBody())['body']['requestId'];
        $this->assertSame(200, $this->v1Claim($id, ['flows:relay'], ['instanceId' => 'desk-1'])['status']);

        $frame = $this->v1Frame($id, ['flows:relay'], ['instanceId' => 'desk-2', 'envelope' => base64_encode('x')]);
        $this->assertSame(409, $frame['status']);
        $this->assertSame('claimed_elsewhere', $frame['body']['code'] ?? null);

        $complete = $this->v1Complete($id, ['flows:relay'], ['instanceId' => 'desk-2', 'status' => 'done']);
        $this->assertSame(409, $complete['status']);
        $this->assertSame('claimed_elsewhere', $complete['body']['code'] ?? null);

        // The real claimant is unaffected.
        $this->assertSame(200, $this->v1Complete($id, ['flows:relay'], ['instanceId' => 'desk-1', 'status' => 'done'])['status']);
    }

    // ── FIFO + queue position ──

    public function testFifoOrderAndLiveQueuePosition(): void
    {
        // Three pending runs for the same lane. The per-user cap (≤ 2) means they can't
        // all come from one requester — member-delegated rows keep the test honest.
        $extraUsers = [$this->addUser(), $this->addUser()];
        try {
            $ids = [];
            $ids[] = self::$relay->enqueue($this->ownerId, $extraUsers[0], $this->sealedBody())['request']['requestId'];
            $ids[] = self::$relay->enqueue($this->ownerId, $extraUsers[1], $this->sealedBody())['request']['requestId'];
            $ids[] = $this->webEnqueue($this->ownerId, $this->sealedBody())['body']['requestId'];
            // created_at has second resolution — spread the rows so FIFO order is deterministic.
            foreach ($ids as $i => $id) {
                self::$pdo->prepare('UPDATE desktop_flow_runs SET created_at = DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id = ?')
                    ->execute([$i, $id]);
            }

            $pending = self::$relay->pollPending($this->ownerId, null, 0);
            $this->assertSame($ids, array_map(static fn ($r) => $r['requestId'], $pending), 'oldest first');

            $this->assertSame(0, self::$relay->queuePosition($ids[0], $this->ownerId));
            $this->assertSame(1, self::$relay->queuePosition($ids[1], $this->ownerId));
            $this->assertSame(2, self::$relay->queuePosition($ids[2], $this->ownerId));

            $read = $this->webGet($this->ownerId, $ids[2]);
            $this->assertSame(2, $read['body']['request']['queuePos']);
        } finally {
            foreach ($extraUsers as $uid) {
                self::$pdo->prepare('DELETE FROM desktop_flow_runs WHERE requesting_user_id = ?')->execute([$uid]);
                self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
            }
        }
    }

    // ── caps ──

    public function testPerUserCap(): void
    {
        $this->assertSame(201, $this->webEnqueue($this->ownerId, $this->sealedBody())['status']);
        $this->assertSame(201, $this->webEnqueue($this->ownerId, $this->sealedBody())['status']);
        $third = $this->webEnqueue($this->ownerId, $this->sealedBody());
        $this->assertSame(429, $third['status']);
        $this->assertSame('queue_full_user', $third['body']['code'] ?? null);
    }

    public function testPerTargetCap(): void
    {
        // 2 requesters × 2 in flight (each under their own per-user cap) fill the lane's 4.
        $requesters = [$this->addUser(), $this->addUser()];
        try {
            foreach ($requesters as $rid) {
                for ($j = 0; $j < 2; $j++) {
                    self::$relay->enqueue($this->ownerId, $rid, $this->sealedBody());
                }
            }
            try {
                self::$relay->enqueue($this->ownerId, $this->otherId, $this->sealedBody());
                $this->fail('the 5th in-flight run for the lane should have been refused');
            } catch (\RuntimeException $e) {
                $this->assertSame('queue_full_desktop', $e->getMessage());
            }
        } finally {
            foreach ($requesters as $rid) {
                self::$pdo->prepare('DELETE FROM desktop_flow_runs WHERE requesting_user_id = ?')->execute([$rid]);
                self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$rid]);
            }
        }
    }

    // ── expiry ──

    public function testPendingExpiresAndPurges(): void
    {
        $id = $this->webEnqueue($this->ownerId, $this->sealedBody())['body']['requestId'];

        self::$pdo->prepare('UPDATE desktop_flow_runs SET expires_at = DATE_SUB(NOW(), INTERVAL 5 SECOND) WHERE id = ?')->execute([$id]);
        $pending = $this->v1Pending(['flows:relay'], ['wait' => 0]);
        $this->assertNotContains($id, array_map(static fn ($r) => $r['requestId'], $pending['body']['requests']), 'expired runs are not pending');

        $this->assertSame(409, $this->v1Claim($id, ['flows:relay'], ['instanceId' => 'desk-1'])['status']);
        $this->assertSame('expired', $this->webGet($this->ownerId, $id)['body']['request']['status']);
        $this->assertNull($this->rawRunRow($id)['envelope'], 'expiry purges the sealed envelope');
    }

    public function testStaleClaimedRowIsReapedAndPurged(): void
    {
        $id = $this->webEnqueue($this->ownerId, $this->sealedBody())['body']['requestId'];
        $this->assertSame(200, $this->v1Claim($id, ['flows:relay'], ['instanceId' => 'desk-1'])['status']);
        $this->assertSame(201, $this->v1Frame($id, ['flows:relay'], ['instanceId' => 'desk-1', 'envelope' => base64_encode('d')])['status']);

        // The claiming desktop crashes mid-run: backdate the activity anchor past the threshold.
        $stale = DesktopFlowRelayService::CLAIMED_STALE_SECONDS + 5;
        self::$pdo->prepare("UPDATE desktop_flow_runs SET claimed_at = DATE_SUB(NOW(), INTERVAL {$stale} SECOND) WHERE id = ?")->execute([$id]);

        $reaped = self::$relay->expireStale($this->ownerId);
        $this->assertGreaterThanOrEqual(1, $reaped);
        $this->assertSame('expired', $this->webGet($this->ownerId, $id)['body']['request']['status']);
        $this->assertNull($this->rawRunRow($id)['envelope']);
        $this->assertSame(0, $this->frameCount($id), 'expiry purges the frames too');
        $this->assertSame(409, $this->v1Complete($id, ['flows:relay'], ['instanceId' => 'desk-1', 'status' => 'done'])['status']);
    }

    public function testActivelyStreamingRunIsNeverReaped(): void
    {
        $id = $this->webEnqueue($this->ownerId, $this->sealedBody())['body']['requestId'];
        $this->assertSame(200, $this->v1Claim($id, ['flows:relay'], ['instanceId' => 'desk-1'])['status']);
        // Frames keep refreshing claimed_at, so a live run survives the sweep.
        $this->assertSame(201, $this->v1Frame($id, ['flows:relay'], ['instanceId' => 'desk-1', 'envelope' => base64_encode('d')])['status']);
        self::$relay->expireStale($this->ownerId);
        $this->assertSame('streaming', $this->webGet($this->ownerId, $id)['body']['request']['status']);
        $this->assertSame(200, $this->v1Complete($id, ['flows:relay'], ['instanceId' => 'desk-1', 'status' => 'done'])['status']);
    }

    public function testUnreadResultIsPurgedAfterRetention(): void
    {
        $id = $this->webEnqueue($this->ownerId, $this->sealedBody())['body']['requestId'];
        $this->assertSame(200, $this->v1Claim($id, ['flows:relay'], ['instanceId' => 'desk-1'])['status']);
        $this->assertSame(200, $this->v1Complete($id, ['flows:relay'], ['instanceId' => 'desk-1', 'status' => 'done', 'resultEnvelope' => base64_encode('r')])['status']);
        $this->assertNotNull($this->rawRunRow($id)['result_envelope']);

        $stale = DesktopFlowRelayService::RESULT_RETENTION_SECONDS + 60;
        self::$pdo->prepare("UPDATE desktop_flow_runs SET finished_at = DATE_SUB(NOW(), INTERVAL {$stale} SECOND) WHERE id = ?")->execute([$id]);
        self::$relay->expireStale($this->ownerId);
        $this->assertNull($this->rawRunRow($id)['result_envelope'], 'an unread result is bounded by retention');
        $this->assertFalse($this->webGet($this->ownerId, $id)['body']['request']['resultAvailable']);
    }

    // ── scope acceptance (flows:relay + grandfathered connector:relay) ──

    public function testDesktopScopeAcceptance(): void
    {
        $a = $this->webEnqueue($this->ownerId, $this->sealedBody())['body']['requestId'];
        $this->assertSame(200, $this->v1Claim($a, ['flows:relay'], ['instanceId' => 'desk-1'])['status'], 'the dedicated scope works');
        $this->assertSame(200, $this->v1Complete($a, ['flows:relay'], ['instanceId' => 'desk-1', 'status' => 'done'])['status']);

        $b = $this->webEnqueue($this->ownerId, $this->sealedBody())['body']['requestId'];
        $legacy = $this->v1Claim($b, ['connector:relay'], ['instanceId' => 'desk-1']);
        $this->assertSame(200, $legacy['status'], 'grandfathered connector:relay keys keep working (plan §7)');
        $this->assertSame(200, $this->v1Complete($b, ['connector:relay'], ['instanceId' => 'desk-1', 'status' => 'done'])['status']);

        $c = $this->webEnqueue($this->ownerId, $this->sealedBody())['body']['requestId'];
        $denied = $this->v1Claim($c, ['flows:read'], ['instanceId' => 'desk-1']);
        $this->assertSame(403, $denied['status']);
        $this->assertSame('insufficient_scope', $denied['body']['code'] ?? null);
        $this->assertSame(403, $this->v1Pending(['flows:read'], ['wait' => 0])['status']);
        $this->assertSame(403, $this->v1Frame($c, ['flows:read'], ['instanceId' => 'desk-1', 'envelope' => base64_encode('x')])['status']);
        $this->assertSame(403, $this->v1Complete($c, ['flows:read'], ['status' => 'done'])['status']);
    }

    // ── requesting-user enforcement (incl. SSE auth) ──

    public function testRequestingUserEnforcement(): void
    {
        $id = $this->webEnqueue($this->ownerId, $this->sealedBody())['body']['requestId'];

        // A stranger (different owner scope) can't even see the run exists.
        $this->assertSame(404, $this->webGet($this->otherId, $id)['status']);
        $this->assertSame(404, $this->webStream($this->otherId, $id)['status']);

        // Within the owner scope but not the requester (member-delegated row): explicit 403.
        $delegated = self::$relay->enqueue($this->ownerId, $this->otherId, $this->sealedBody())['request'];
        $foreign = $this->webGet($this->ownerId, $delegated['requestId']);
        $this->assertSame(403, $foreign['status']);
        $this->assertSame('forbidden', $foreign['body']['code'] ?? null);
        $this->assertSame(403, $this->webStream($this->ownerId, $delegated['requestId'])['status']);
        // ...while the actual requester passes the same gate.
        $this->assertSame(200, $this->webGet($this->otherId, $delegated['requestId'])['status']);

        // No session at all → 401 before anything streams.
        $this->assertSame(401, $this->webStream(null, $id)['status']);
    }

    // ── SSE wire format ──

    public function testSseEventEncoding(): void
    {
        $frame = DesktopFlowRelayController::sseFrameEvent(['seq' => 7, 'envelope' => 'c2VhbGVk']);
        $this->assertSame("id: 7\nevent: frame\ndata: {\"seq\":7,\"envelope\":\"c2VhbGVk\"}\n\n", $frame);
        $status = DesktopFlowRelayController::sseStatusEvent('done');
        $this->assertSame("event: status\ndata: {\"status\":\"done\"}\n\n", $status);
    }

    // ── targeting ──

    public function testTargetedRunVisibilityAndClaim(): void
    {
        $this->addConnection('desk-1');
        $enq = $this->webEnqueue($this->ownerId, $this->sealedBody());
        $this->assertSame(201, $enq['status'], json_encode($enq['body']));
        $this->assertSame('desk-1', $enq['body']['targetInstanceId'] ?? null, 'implicit single fresh desktop is targeted');
        $id = $enq['body']['requestId'];

        // Another instance never even sees it; the target does.
        $this->assertCount(0, $this->v1Pending(['flows:relay'], ['wait' => 0, 'instanceId' => 'desk-2'])['body']['requests']);
        $this->assertCount(1, $this->v1Pending(['flows:relay'], ['wait' => 0, 'instanceId' => 'desk-1'])['body']['requests']);

        $wrong = $this->v1Claim($id, ['flows:relay'], ['instanceId' => 'desk-2']);
        $this->assertSame(409, $wrong['status']);
        $this->assertSame('targeted_elsewhere', $wrong['body']['code'] ?? null);

        $this->assertSame(200, $this->v1Claim($id, ['flows:relay'], ['instanceId' => 'desk-1'])['status']);
    }

    public function testAmbiguousDesktopRefused(): void
    {
        $this->addConnection('desk-1');
        $this->addConnection('desk-2');
        $r = $this->webEnqueue($this->ownerId, $this->sealedBody());
        $this->assertSame(409, $r['status']);
        $this->assertSame('ambiguous_desktop', $r['body']['code'] ?? null);
        $this->assertCount(2, $r['body']['details']['desktops'] ?? []);
    }
}

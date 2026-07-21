<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\DesktopAiRelayController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Services\DesktopAiRelayService;
use FormLogic\Services\DesktopCommandService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * E2E AI relay (docs/SITE_AI_CHAT_DESKTOP_TUNNEL_PLAN.md Phase 1): the sealed-envelope queue
 * between a web member and their linked desktop. Covers the full lifecycle (enqueue → poll →
 * claim → stream frames → input → complete), reserve-first idempotency, the single-flight
 * claim (lane_busy), FIFO order + live queue position, the per-user/per-target caps, TTL
 * expiry, content purge on complete AND on expiry, flk_ scope acceptance (ai:relay plus the
 * grandfathered connector:relay), requesting-user enforcement on the web {id} routes
 * (incl. SSE), and pubkey publish/read-back. Skipped without a test database.
 */
class DesktopAiRelayTest extends TestCase
{
    private const BASE = 'http://localhost';

    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static DesktopAiRelayService $relay;
    private static DesktopAiRelayController $ctrl;

    private string $ownerId = '';
    private string $otherId = '';

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
        self::$relay = new DesktopAiRelayService($conn);
        self::$ctrl = new DesktopAiRelayController(self::$relay, new DesktopCommandService($conn));
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->ownerId = $this->addUser();
        $this->otherId = $this->addUser();
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
            self::$pdo->prepare('DELETE f FROM desktop_ai_frames f JOIN desktop_ai_requests r ON f.request_id = r.id WHERE r.owner_user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM desktop_ai_requests WHERE owner_user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM desktop_connections WHERE owner_user_id = ?')->execute([$uid]);
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

    /** A valid sealed-request body (the backend never interprets the opaque bytes). */
    private function sealedBody(array $extra = []): array
    {
        return $extra + [
            'kind' => 'chat',
            'providerId' => 'openai-codex-agent',
            'ephPub' => base64_encode(random_bytes(32)),
            'envelope' => base64_encode('sealed-request-body'),
        ];
    }

    /** POST /api/desktop/ai/requests as $userId. */
    private function webEnqueue(string $userId, array $body): array
    {
        $req = (new ServerRequestFactory())->createServerRequest('POST', self::BASE . '/api/desktop/ai/requests')
            ->withParsedBody($body)
            ->withAttribute('userId', $userId);
        $resp = self::$ctrl->enqueue($req, (new ResponseFactory())->createResponse());
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    /** GET /api/desktop/ai/requests/{id} as $userId. */
    private function webGet(string $userId, string $id): array
    {
        $req = (new ServerRequestFactory())->createServerRequest('GET', self::BASE . '/api/desktop/ai/requests/' . $id)
            ->withAttribute('userId', $userId);
        $resp = self::$ctrl->getRequest($req, (new ResponseFactory())->createResponse(), ['id' => $id]);
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    /**
     * GET /api/desktop/ai/requests/{id}/stream as $userId — ERROR PATHS ONLY: an authorized
     * call enters the raw SSE loop, which never returns to PHPUnit.
     */
    private function webStream(?string $userId, string $id): array
    {
        $req = (new ServerRequestFactory())->createServerRequest('GET', self::BASE . '/api/desktop/ai/requests/' . $id . '/stream');
        if ($userId !== null) {
            $req = $req->withAttribute('userId', $userId);
        }
        $resp = self::$ctrl->stream($req, (new ResponseFactory())->createResponse(), ['id' => $id]);
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    /** POST /api/desktop/ai/requests/{id}/input as $userId. */
    private function webInput(string $userId, string $id, array $body): array
    {
        $req = (new ServerRequestFactory())->createServerRequest('POST', self::BASE . '/api/desktop/ai/requests/' . $id . '/input')
            ->withParsedBody($body)
            ->withAttribute('userId', $userId);
        $resp = self::$ctrl->postInput($req, (new ResponseFactory())->createResponse(), ['id' => $id]);
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    /** GET /api/desktop/ai/pubkey?instanceId= as $userId. */
    private function webPubkey(string $userId, string $instanceId): array
    {
        $req = (new ServerRequestFactory())->createServerRequest('GET', self::BASE . '/api/desktop/ai/pubkey')
            ->withQueryParams(['instanceId' => $instanceId])
            ->withAttribute('userId', $userId);
        $resp = self::$ctrl->getPubkey($req, (new ResponseFactory())->createResponse());
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
        $resp = self::$ctrl->pendingV1($this->v1Request('GET', '/api/v1/desktop-ai/pending', $scopes, [], $query), (new ResponseFactory())->createResponse());
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    private function v1Claim(string $id, array $scopes, array $body = []): array
    {
        $resp = self::$ctrl->claimV1($this->v1Request('POST', '/api/v1/desktop-ai/' . $id . '/claim', $scopes, $body), (new ResponseFactory())->createResponse(), ['id' => $id]);
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    private function v1Frame(string $id, array $scopes, array $body): array
    {
        $resp = self::$ctrl->postFrameV1($this->v1Request('POST', '/api/v1/desktop-ai/' . $id . '/frames', $scopes, $body), (new ResponseFactory())->createResponse(), ['id' => $id]);
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    private function v1Input(string $id, array $scopes, array $query): array
    {
        $resp = self::$ctrl->inputV1($this->v1Request('GET', '/api/v1/desktop-ai/' . $id . '/input', $scopes, [], $query), (new ResponseFactory())->createResponse(), ['id' => $id]);
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    private function v1Complete(string $id, array $scopes, array $body): array
    {
        $resp = self::$ctrl->completeV1($this->v1Request('POST', '/api/v1/desktop-ai/' . $id . '/complete', $scopes, $body), (new ResponseFactory())->createResponse(), ['id' => $id]);
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    private function v1Pubkey(array $scopes, array $body): array
    {
        $resp = self::$ctrl->publishPubkeyV1($this->v1Request('POST', '/api/v1/desktop-ai/pubkey', $scopes, $body), (new ResponseFactory())->createResponse());
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    /** Raw column reads for purge assertions (the API deliberately hides purged content). */
    private function rawRequestRow(string $id): ?array
    {
        $stmt = self::$pdo->prepare('SELECT * FROM desktop_ai_requests WHERE id = ?');
        $stmt->execute([$id]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    private function frameCount(string $id, ?string $direction = null): int
    {
        $sql = 'SELECT COUNT(*) FROM desktop_ai_frames WHERE request_id = ?';
        $params = [$id];
        if ($direction !== null) {
            $sql .= ' AND direction = ?';
            $params[] = $direction;
        }
        $stmt = self::$pdo->prepare($sql);
        $stmt->execute($params);
        return (int) $stmt->fetchColumn();
    }

    // ── lifecycle ──

    public function testFullLifecycleEnqueueClaimStreamInputComplete(): void
    {
        $enq = $this->webEnqueue($this->ownerId, $this->sealedBody());
        $this->assertSame(201, $enq['status'], json_encode($enq['body']));
        $this->assertSame('pending', $enq['body']['status']);
        $this->assertSame(0, $enq['body']['queuePos']);
        $id = $enq['body']['requestId'];

        // The desktop long-poll (wait=0 → immediate) sees it.
        $pending = $this->v1Pending(['ai:relay'], ['wait' => 0, 'instanceId' => 'desk-1']);
        $this->assertSame(200, $pending['status']);
        $ids = array_map(static fn ($r) => $r['requestId'], $pending['body']['requests']);
        $this->assertContains($id, $ids);

        // Claim single-flight, then stream sealed frames back.
        $claim = $this->v1Claim($id, ['ai:relay'], ['instanceId' => 'desk-1']);
        $this->assertSame(200, $claim['status'], json_encode($claim['body']));
        $this->assertSame('claimed', $claim['body']['request']['status']);
        $this->assertSame('desk-1', $claim['body']['request']['claimedBy']);
        $this->assertNotEmpty($claim['body']['request']['envelope'], 'the claimant receives the sealed envelope');

        $frame = $this->v1Frame($id, ['ai:relay'], ['instanceId' => 'desk-1', 'envelope' => base64_encode('sealed-delta-1')]);
        $this->assertSame(201, $frame['status'], json_encode($frame['body']));
        $this->assertSame('streaming', $frame['body']['status']);
        // A second frame inside the same second must still append (no changed-rows trap).
        $frame2 = $this->v1Frame($id, ['ai:relay'], ['instanceId' => 'desk-1', 'envelope' => base64_encode('sealed-delta-2')]);
        $this->assertSame(201, $frame2['status']);

        // The web SSE feed source sees both sealed deltas in order.
        $out = self::$relay->fetchOutput($id, $this->ownerId, 0);
        $this->assertCount(2, $out);
        $this->assertSame(base64_encode('sealed-delta-1'), $out[0]['envelope']);
        $this->assertSame(base64_encode('sealed-delta-2'), $out[1]['envelope']);
        $this->assertGreaterThan($out[0]['seq'], $out[1]['seq']);

        // Confirm-mode input: browser → request row → desktop's claimant-bound poll.
        $in = $this->webInput($this->ownerId, $id, ['envelope' => base64_encode('sealed-confirm-yes')]);
        $this->assertSame(201, $in['status'], json_encode($in['body']));
        $desktopInput = $this->v1Input($id, ['ai:relay'], ['since' => 0, 'instanceId' => 'desk-1']);
        $this->assertSame(200, $desktopInput['status']);
        $this->assertCount(1, $desktopInput['body']['frames']);
        $this->assertSame(base64_encode('sealed-confirm-yes'), $desktopInput['body']['frames'][0]['envelope']);
        $since = (int) $desktopInput['body']['frames'][0]['seq'];
        $this->assertCount(0, $this->v1Input($id, ['ai:relay'], ['since' => $since, 'instanceId' => 'desk-1'])['body']['frames']);

        // Complete purges the request envelope + IN frames immediately; OUT frames get a
        // FRAME_GRACE_SECONDS drain window (an instant completion must not beat the SSE
        // reader to its own reply — found live 2026-07-22), then expireStale() reaps them.
        $done = $this->v1Complete($id, ['ai:relay'], ['instanceId' => 'desk-1', 'status' => 'done']);
        $this->assertSame(200, $done['status'], json_encode($done['body']));
        $this->assertSame('done', $done['body']['request']['status']);
        $this->assertNull($done['body']['request']['envelope']);
        $raw = $this->rawRequestRow($id);
        $this->assertNull($raw['envelope'], 'complete() purges the request envelope');
        $this->assertSame(0, $this->frameCount($id, 'in'), 'complete() purges inbound frames');
        $this->assertSame(2, $this->frameCount($id, 'out'), 'OUT frames survive completion for the drain window');

        // The reply stream can still read them after completion…
        $late = self::$relay->fetchOutput($id, $this->ownerId, 0);
        $this->assertCount(2, $late, 'the reply remains drainable within the grace window');

        // …and once the grace passes, the next expireStale() pass reaps every sealed byte.
        self::$pdo->prepare('UPDATE desktop_ai_requests SET finished_at = (NOW() - INTERVAL 120 SECOND) WHERE id = ?')
            ->execute([$id]);
        self::$relay->expireStale();
        $this->assertSame(0, $this->frameCount($id), 'graced OUT frames are reaped after FRAME_GRACE_SECONDS');

        $read = $this->webGet($this->ownerId, $id);
        $this->assertSame(200, $read['status']);
        $this->assertSame('done', $read['body']['request']['status']);
        $this->assertSame(0, $read['body']['request']['queuePos']);
    }

    // ── reserve-first idempotency ──

    public function testReserveFirstIdempotency(): void
    {
        $key = 'aireq-' . bin2hex(random_bytes(8));
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
        $missing = $this->webEnqueue($this->ownerId, ['kind' => 'chat']);
        $this->assertSame(400, $missing['status']);
        $badKey = $this->webEnqueue($this->ownerId, $this->sealedBody(['ephPub' => base64_encode('too-short')]));
        $this->assertSame(400, $badKey['status']);
    }

    // ── claim: exactly-once + single-flight ──

    public function testClaimExactlyOnce(): void
    {
        $enq = $this->webEnqueue($this->ownerId, $this->sealedBody());
        $id = $enq['body']['requestId'];

        $first = $this->v1Claim($id, ['ai:relay'], ['instanceId' => 'desk-1']);
        $this->assertSame(200, $first['status'], json_encode($first['body']));
        $second = $this->v1Claim($id, ['ai:relay'], ['instanceId' => 'desk-2']);
        $this->assertSame(409, $second['status'], 'a second claim of the same request must lose');

        $after = $this->v1Pending(['ai:relay'], ['wait' => 0]);
        $this->assertNotContains($id, array_map(static fn ($r) => $r['requestId'], $after['body']['requests']));
    }

    public function testSingleFlightLaneBusyUntilSiblingCompletes(): void
    {
        $a = $this->webEnqueue($this->ownerId, $this->sealedBody())['body']['requestId'];
        $b = $this->webEnqueue($this->ownerId, $this->sealedBody())['body']['requestId'];

        $this->assertSame(200, $this->v1Claim($a, ['ai:relay'], ['instanceId' => 'desk-1'])['status']);
        $busy = $this->v1Claim($b, ['ai:relay'], ['instanceId' => 'desk-1']);
        $this->assertSame(409, $busy['status'], 'the lane is single-flight per target');
        $this->assertSame('lane_busy', $busy['body']['code'] ?? null);

        $this->assertSame(200, $this->v1Complete($a, ['ai:relay'], ['instanceId' => 'desk-1', 'status' => 'done'])['status']);
        $freed = $this->v1Claim($b, ['ai:relay'], ['instanceId' => 'desk-1']);
        $this->assertSame(200, $freed['status'], 'completing the sibling frees the lane');
    }

    public function testClaimantBindingOnFramesInputAndComplete(): void
    {
        $id = $this->webEnqueue($this->ownerId, $this->sealedBody())['body']['requestId'];
        $this->assertSame(200, $this->v1Claim($id, ['ai:relay'], ['instanceId' => 'desk-1'])['status']);

        $frame = $this->v1Frame($id, ['ai:relay'], ['instanceId' => 'desk-2', 'envelope' => base64_encode('x')]);
        $this->assertSame(409, $frame['status']);
        $this->assertSame('claimed_elsewhere', $frame['body']['code'] ?? null);

        $input = $this->v1Input($id, ['ai:relay'], ['since' => 0, 'instanceId' => 'desk-2']);
        $this->assertSame(409, $input['status']);
        $this->assertSame('claimed_elsewhere', $input['body']['code'] ?? null);

        $complete = $this->v1Complete($id, ['ai:relay'], ['instanceId' => 'desk-2', 'status' => 'done']);
        $this->assertSame(409, $complete['status']);
        $this->assertSame('claimed_elsewhere', $complete['body']['code'] ?? null);

        // The real claimant is unaffected.
        $this->assertSame(200, $this->v1Complete($id, ['ai:relay'], ['instanceId' => 'desk-1', 'status' => 'done'])['status']);
    }

    // ── FIFO + queue position ──

    public function testFifoOrderAndLiveQueuePosition(): void
    {
        // Three pending requests for the same lane. The per-user cap (≤ 2) means they can't
        // all come from one requester — member-delegated rows keep the test honest.
        $extraUsers = [$this->addUser(), $this->addUser()];
        try {
            $ids = [];
            $ids[] = self::$relay->enqueue($this->ownerId, $extraUsers[0], $this->sealedBody())['request']['requestId'];
            $ids[] = self::$relay->enqueue($this->ownerId, $extraUsers[1], $this->sealedBody())['request']['requestId'];
            $ids[] = $this->webEnqueue($this->ownerId, $this->sealedBody())['body']['requestId'];
            // created_at has second resolution — spread the rows so FIFO order is deterministic.
            foreach ($ids as $i => $id) {
                self::$pdo->prepare('UPDATE desktop_ai_requests SET created_at = DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id = ?')
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
                self::$pdo->prepare('DELETE FROM desktop_ai_requests WHERE requesting_user_id = ?')->execute([$uid]);
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
        // 4 requesters × 2 in flight (each under their own per-user cap) fill the lane's 8.
        $requesters = [];
        for ($i = 0; $i < 4; $i++) {
            $requesters[] = $this->addUser();
        }
        try {
            foreach ($requesters as $rid) {
                for ($j = 0; $j < 2; $j++) {
                    self::$relay->enqueue($this->ownerId, $rid, $this->sealedBody());
                }
            }
            try {
                self::$relay->enqueue($this->ownerId, $this->otherId, $this->sealedBody());
                $this->fail('the 9th in-flight request for the lane should have been refused');
            } catch (\RuntimeException $e) {
                $this->assertSame('queue_full_desktop', $e->getMessage());
            }
        } finally {
            foreach ($requesters as $rid) {
                self::$pdo->prepare('DELETE FROM desktop_ai_requests WHERE requesting_user_id = ?')->execute([$rid]);
                self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$rid]);
            }
        }
    }

    // ── expiry ──

    public function testPendingExpiresAndPurges(): void
    {
        $id = $this->webEnqueue($this->ownerId, $this->sealedBody())['body']['requestId'];

        self::$pdo->prepare('UPDATE desktop_ai_requests SET expires_at = DATE_SUB(NOW(), INTERVAL 5 SECOND) WHERE id = ?')->execute([$id]);
        $pending = $this->v1Pending(['ai:relay'], ['wait' => 0]);
        $this->assertNotContains($id, array_map(static fn ($r) => $r['requestId'], $pending['body']['requests']), 'expired requests are not pending');

        $this->assertSame(409, $this->v1Claim($id, ['ai:relay'], ['instanceId' => 'desk-1'])['status']);
        $this->assertSame('expired', $this->webGet($this->ownerId, $id)['body']['request']['status']);
        $this->assertNull($this->rawRequestRow($id)['envelope'], 'expiry purges the sealed envelope');
    }

    public function testStaleClaimedRowIsReapedAndPurged(): void
    {
        $id = $this->webEnqueue($this->ownerId, $this->sealedBody())['body']['requestId'];
        $this->assertSame(200, $this->v1Claim($id, ['ai:relay'], ['instanceId' => 'desk-1'])['status']);
        $this->assertSame(201, $this->v1Frame($id, ['ai:relay'], ['instanceId' => 'desk-1', 'envelope' => base64_encode('d')])['status']);

        // The claiming desktop crashes mid-stream: backdate the activity anchor past the threshold.
        $stale = DesktopAiRelayService::CLAIMED_STALE_SECONDS + 5;
        self::$pdo->prepare("UPDATE desktop_ai_requests SET claimed_at = DATE_SUB(NOW(), INTERVAL {$stale} SECOND) WHERE id = ?")->execute([$id]);

        $reaped = self::$relay->expireStale($this->ownerId);
        $this->assertGreaterThanOrEqual(1, $reaped);
        $this->assertSame('expired', $this->webGet($this->ownerId, $id)['body']['request']['status']);
        $this->assertNull($this->rawRequestRow($id)['envelope']);
        $this->assertSame(0, $this->frameCount($id), 'expiry purges the frames too');
        $this->assertSame(409, $this->v1Complete($id, ['ai:relay'], ['instanceId' => 'desk-1', 'status' => 'done'])['status']);
    }

    public function testActivelyStreamingRequestIsNeverReaped(): void
    {
        $id = $this->webEnqueue($this->ownerId, $this->sealedBody())['body']['requestId'];
        $this->assertSame(200, $this->v1Claim($id, ['ai:relay'], ['instanceId' => 'desk-1'])['status']);
        // Frames keep refreshing claimed_at, so a live stream survives the sweep.
        $this->assertSame(201, $this->v1Frame($id, ['ai:relay'], ['instanceId' => 'desk-1', 'envelope' => base64_encode('d')])['status']);
        self::$relay->expireStale($this->ownerId);
        $this->assertSame('streaming', $this->webGet($this->ownerId, $id)['body']['request']['status']);
        $this->assertSame(200, $this->v1Complete($id, ['ai:relay'], ['instanceId' => 'desk-1', 'status' => 'done'])['status']);
    }

    // ── scope acceptance (ai:relay + grandfathered connector:relay) ──

    public function testDesktopScopeAcceptance(): void
    {
        $a = $this->webEnqueue($this->ownerId, $this->sealedBody())['body']['requestId'];
        $this->assertSame(200, $this->v1Claim($a, ['ai:relay'], ['instanceId' => 'desk-1'])['status'], 'the dedicated scope works');
        $this->assertSame(200, $this->v1Complete($a, ['ai:relay'], ['instanceId' => 'desk-1', 'status' => 'done'])['status']);

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
        $this->assertSame(403, $this->v1Input($c, ['flows:read'], ['since' => 0])['status']);
        $this->assertSame(403, $this->v1Complete($c, ['flows:read'], ['status' => 'done'])['status']);
        $this->assertSame(403, $this->v1Pubkey(['flows:read'], ['instanceId' => 'desk-1', 'publicKey' => base64_encode(random_bytes(32))])['status']);
    }

    // ── requesting-user enforcement (incl. SSE auth) ──

    public function testRequestingUserEnforcement(): void
    {
        $id = $this->webEnqueue($this->ownerId, $this->sealedBody())['body']['requestId'];

        // A stranger (different owner scope) can't even see the request exists.
        $this->assertSame(404, $this->webGet($this->otherId, $id)['status']);
        $this->assertSame(404, $this->webStream($this->otherId, $id)['status']);
        $this->assertSame(404, $this->webInput($this->otherId, $id, ['envelope' => base64_encode('x')])['status']);

        // Within the owner scope but not the requester (member-delegated row): explicit 403.
        $delegated = self::$relay->enqueue($this->ownerId, $this->otherId, $this->sealedBody())['request'];
        $foreign = $this->webGet($this->ownerId, $delegated['requestId']);
        $this->assertSame(403, $foreign['status']);
        $this->assertSame('forbidden', $foreign['body']['code'] ?? null);
        $this->assertSame(403, $this->webStream($this->ownerId, $delegated['requestId'])['status']);
        $this->assertSame(403, $this->webInput($this->ownerId, $delegated['requestId'], ['envelope' => base64_encode('x')])['status']);
        // ...while the actual requester passes the same gate.
        $this->assertSame(200, $this->webGet($this->otherId, $delegated['requestId'])['status']);

        // No session at all → 401 before anything streams.
        $this->assertSame(401, $this->webStream(null, $id)['status']);
    }

    // ── SSE wire format ──

    public function testSseEventEncoding(): void
    {
        $frame = DesktopAiRelayController::sseFrameEvent(['seq' => 7, 'envelope' => 'c2VhbGVk']);
        $this->assertSame("id: 7\nevent: frame\ndata: {\"seq\":7,\"envelope\":\"c2VhbGVk\"}\n\n", $frame);
        $status = DesktopAiRelayController::sseStatusEvent('done');
        $this->assertSame("event: status\ndata: {\"status\":\"done\"}\n\n", $status);
    }

    // ── pubkey ──

    public function testPubkeyPublishAndReadBack(): void
    {
        $key = base64_encode(random_bytes(32));
        // Unknown instance → the desktop must heartbeat its connection row first.
        $unknown = $this->v1Pubkey(['ai:relay'], ['instanceId' => 'desk-x', 'publicKey' => $key]);
        $this->assertSame(404, $unknown['status']);
        $this->assertSame('unknown_desktop_instance', $unknown['body']['code'] ?? null);

        $this->addConnection('desk-1');
        $published = $this->v1Pubkey(['ai:relay'], ['instanceId' => 'desk-1', 'publicKey' => $key]);
        $this->assertSame(200, $published['status'], json_encode($published['body']));

        $read = $this->webPubkey($this->ownerId, 'desk-1');
        $this->assertSame(200, $read['status']);
        $this->assertSame($key, $read['body']['publicKey']);

        // Re-publishing the same key is idempotent (the desktop publishes on every boot).
        $again = $this->v1Pubkey(['connector:relay'], ['instanceId' => 'desk-1', 'publicKey' => $key]);
        $this->assertSame(200, $again['status']);

        $missing = $this->webPubkey($this->ownerId, 'desk-never');
        $this->assertSame(404, $missing['status']);
        $this->assertSame('e2e_key_unknown', $missing['body']['code'] ?? null);
    }

    public function testPubkeyDefaultTargetWhenInstanceIdOmitted(): void
    {
        $key = base64_encode(random_bytes(32));
        $this->addConnection('desk-1');
        $this->assertSame(200, $this->v1Pubkey(['ai:relay'], ['instanceId' => 'desk-1', 'publicKey' => $key])['status']);

        // Omitted instanceId resolves the implicit single fresh desktop, exactly like enqueue.
        $read = $this->webPubkey($this->ownerId, '');
        $this->assertSame(200, $read['status'], json_encode($read['body']));
        $this->assertSame('desk-1', $read['body']['instanceId'] ?? null);
        $this->assertSame($key, $read['body']['publicKey']);

        // Two fresh desktops with no assignment pin → the caller must pick explicitly.
        $this->addConnection('desk-2');
        $ambiguous = $this->webPubkey($this->ownerId, '');
        $this->assertSame(409, $ambiguous['status']);
        $this->assertSame('ambiguous_desktop', $ambiguous['body']['code'] ?? null);
    }

    // ── targeting ──

    public function testTargetedRequestVisibilityAndClaim(): void
    {
        $this->addConnection('desk-1');
        $enq = $this->webEnqueue($this->ownerId, $this->sealedBody());
        $this->assertSame(201, $enq['status'], json_encode($enq['body']));
        $this->assertSame('desk-1', $enq['body']['targetInstanceId'] ?? null, 'implicit single fresh desktop is targeted');
        $id = $enq['body']['requestId'];

        // Another instance never even sees it; the target does.
        $this->assertCount(0, $this->v1Pending(['ai:relay'], ['wait' => 0, 'instanceId' => 'desk-2'])['body']['requests']);
        $this->assertCount(1, $this->v1Pending(['ai:relay'], ['wait' => 0, 'instanceId' => 'desk-1'])['body']['requests']);

        $wrong = $this->v1Claim($id, ['ai:relay'], ['instanceId' => 'desk-2']);
        $this->assertSame(409, $wrong['status']);
        $this->assertSame('targeted_elsewhere', $wrong['body']['code'] ?? null);

        $this->assertSame(200, $this->v1Claim($id, ['ai:relay'], ['instanceId' => 'desk-1'])['status']);
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

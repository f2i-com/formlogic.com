<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\FlowController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FlowService;
use FormLogic\Services\Flows\DesktopEngineUnavailableException;
use FormLogic\Services\Flows\LogicLanguageUnsupportedException;
use FormLogic\Services\FormService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * formlogic-python/1 server gate: runtimes built before Python ignore data.language and would
 * run a Python block as JavaScript. Reserve and claim therefore refuse (409
 * language_unsupported, nothing written) a caller whose `logicLanguages` lack a language the
 * flow's code needs — absent means JavaScript only — and the queued listings leave out runs
 * such a caller cannot take, before the LIMIT, so a Python run never holds a JavaScript-only
 * Desktop's queue head. JavaScript flows and idempotent replays behave exactly as before.
 *
 * A caller that is a linked Desktop (its API key's connection binding, FL-01) is also judged on
 * the capabilities its last heartbeat stored (docs/FORMLOGIC_DESKTOP.md §8): a ZIPP-era Desktop
 * (any `logic-language:*` token) whose heartbeat lacks `logic-engine:zipp` runs nothing — 409
 * engine_unavailable on reserve and claim, and empty listings — while a legacy Desktop (no
 * tokens) is judged on its `logicLanguages` alone, as before. Skipped without a test DB.
 */
class FlowLogicLanguageGateTest extends TestCase
{
    private const BOTH = ['javascript', 'python'];
    private const ENGINE = 'logic-engine:zipp';

    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static FlowService $flows;
    private static FlowController $ctrl;

    private string $ownerId = '';
    private string $appId = '';
    private string $slug = '';
    /** @var array<string, array> flows by slug */
    private array $made = [];

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
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/formlogic-flow-lang-' . bin2hex(random_bytes(4)));
        self::$flows = new FlowService($conn);
        self::$ctrl = new FlowController(self::$flows, new AppService($conn, new FormService($conn, $sqlite)), new AppUserService($conn), null);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->ownerId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$this->ownerId, $this->ownerId . '@test.local']);
        $this->appId = 'a-' . bin2hex(random_bytes(12));
        $this->slug = 'flowlang-' . bin2hex(random_bytes(6));
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status) VALUES (?, ?, 'Lang App', ?, 'published')")
            ->execute([$this->appId, $this->ownerId, $this->slug]);
        // resolveRuntime needs an active membership even for the owner.
        $roleId = 'r-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO app_roles (id, app_id, name, is_system, sort_order) VALUES (?, ?, 'Owner-x', 0, 9)")
            ->execute([$roleId, $this->appId]);
        self::$pdo->prepare("INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at) VALUES (UUID(), ?, ?, ?, 'active', NOW())")
            ->execute([$this->appId, $this->ownerId, $roleId]);

        $this->made = [];
        $this->made['js-flow'] = self::$flows->createFlow($this->appId, $this->ownerId, [
            'name' => 'JS', 'slug' => 'js-flow', 'flowJson' => $this->graph('logic_block', null),
        ]);
        $this->made['py-flow'] = self::$flows->createFlow($this->appId, $this->ownerId, [
            'name' => 'Py', 'slug' => 'py-flow', 'flowJson' => $this->graph('logic_block', 'python'),
        ]);
        $this->made['py-ws'] = self::$flows->createWorkspaceFlow($this->ownerId, [
            'name' => 'Py condition', 'slug' => 'py-ws', 'flowJson' => $this->graph('condition', 'python'),
        ]);
        $this->made['js-ws'] = self::$flows->createWorkspaceFlow($this->ownerId, [
            'name' => 'JS condition', 'slug' => 'js-ws', 'flowJson' => $this->graph('condition', 'javascript'),
        ]);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null || $this->ownerId === '') {
            return;
        }
        self::$pdo->prepare('DELETE r FROM flow_run_logs r JOIN flow_definitions f ON f.id = r.flow_definition_id WHERE f.owner_user_id = ?')
            ->execute([$this->ownerId]);
        self::$pdo->prepare('DELETE v FROM flow_definition_versions v JOIN flow_definitions f ON f.id = v.flow_definition_id WHERE f.owner_user_id = ?')
            ->execute([$this->ownerId]);
        self::$pdo->prepare('DELETE FROM flow_definitions WHERE owner_user_id = ?')->execute([$this->ownerId]);
        self::$pdo->prepare('DELETE FROM desktop_connections WHERE owner_user_id = ?')->execute([$this->ownerId]);
        self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$this->appId]);
        self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$this->appId]);
        self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$this->appId]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->ownerId]);
    }

    // ── Fixtures ────────────────────────────────────────────────────────────────────────────

    private function graph(string $codeType, mixed $language): array
    {
        $data = ['expr' => $codeType === 'condition' ? 'True' : 'result = 1'];
        if ($language !== null) {
            $data['language'] = $language;
        }
        return [
            'nodes' => [['id' => 'in', 'type' => 'input'], ['id' => 'code', 'type' => $codeType, 'data' => $data]],
            'edges' => [['source' => 'in', 'target' => 'code']],
        ];
    }

    private function reservePayload(string $flowSlug, ?array $languages, ?string $key = null): array
    {
        $data = [
            'flowSlug' => $flowSlug,
            'triggerEvent' => 'manual',
            'correlationId' => 'c-' . bin2hex(random_bytes(4)),
            'idempotencyKey' => $key ?? 'k-' . bin2hex(random_bytes(8)),
        ];
        if ($languages !== null) {
            $data['logicLanguages'] = $languages;
        }
        return $data;
    }

    private function enqueue(string $flowSlug, string $createdAt): array
    {
        $run = self::$flows->enqueueRun($this->made[$flowSlug], [
            'triggerEvent' => 'manual',
            'correlationId' => 'c-' . bin2hex(random_bytes(4)),
            'idempotencyKey' => 'q-' . bin2hex(random_bytes(8)),
        ])['run'];
        // Deterministic queue order (created_at has one-second resolution).
        self::$pdo->prepare('UPDATE flow_run_logs SET created_at = ? WHERE id = ?')->execute([$createdAt, $run['runId']]);
        return $run;
    }

    /** @return array{runs: int, versions: int} */
    private function rowsFor(string $flowSlug): array
    {
        $id = $this->made[$flowSlug]['id'];
        $runs = self::$pdo->prepare('SELECT COUNT(*) FROM flow_run_logs WHERE flow_definition_id = ?');
        $runs->execute([$id]);
        $versions = self::$pdo->prepare('SELECT COUNT(*) FROM flow_definition_versions WHERE flow_definition_id = ?');
        $versions->execute([$id]);
        return ['runs' => (int) $runs->fetchColumn(), 'versions' => (int) $versions->fetchColumn()];
    }

    private function runRow(string $runId): array
    {
        $stmt = self::$pdo->prepare('SELECT status, runtime, claimed_by, started_at FROM flow_run_logs WHERE id = ?');
        $stmt->execute([$runId]);
        return $stmt->fetch();
    }

    private function refused(callable $call): LogicLanguageUnsupportedException
    {
        try {
            $call();
        } catch (LogicLanguageUnsupportedException $e) {
            $this->assertSame('language_unsupported', $e->getMessage(), 'controllers match on the bare code');
            return $e;
        }
        $this->fail('expected language_unsupported');
    }

    /**
     * A linked Desktop as its heartbeat left it: the row the FL-01 identity resolves the API key
     * `key-<instanceId>` to, carrying `$capabilities` (null: a heartbeat that sent none).
     */
    private function linkDesktop(string $instanceId, ?array $capabilities): string
    {
        $apiKeyId = 'key-' . $instanceId;
        self::$pdo->prepare(
            "INSERT INTO desktop_connections (id, owner_user_id, device_name, desktop_instance_id, api_key_id, capabilities_json, last_seen_at)
             VALUES (?, ?, 'TestBox', ?, ?, ?, NOW())"
        )->execute(['dc-' . bin2hex(random_bytes(8)), $this->ownerId, $instanceId, $apiKeyId, $capabilities === null ? null : json_encode($capabilities)]);
        return $apiKeyId;
    }

    private function refusedForEngine(callable $call): void
    {
        try {
            $call();
        } catch (DesktopEngineUnavailableException $e) {
            $this->assertSame('engine_unavailable', $e->getMessage(), 'controllers match on the bare code');
            return;
        }
        $this->fail('expected engine_unavailable');
    }

    /** @param array<string, mixed>|null $body */
    private function call(string $method, callable $handler, ?array $body = null, array $query = [], ?string $apiKeyId = null): array
    {
        $req = (new ServerRequestFactory())->createServerRequest($method, 'http://localhost/api/test')
            ->withAttribute('userId', $this->ownerId);
        if ($apiKeyId !== null) {
            $req = $req->withAttribute('apiKeyId', $apiKeyId);
        }
        if ($body !== null) {
            $req = $req->withParsedBody($body);
        }
        if ($query !== []) {
            $req = $req->withQueryParams($query);
        }
        /** @var ResponseInterface $res */
        $res = $handler($req, new Response());
        return [$res->getStatusCode(), json_decode((string) $res->getBody(), true) ?? []];
    }

    // ── Reserve ─────────────────────────────────────────────────────────────────────────────

    public function testReserveOfAPythonFlowWithoutPythonIsRefusedBeforeAnythingIsWritten(): void
    {
        $before = $this->rowsFor('py-flow');
        $beforeWs = $this->rowsFor('py-ws');

        $e = $this->refused(fn () => self::$flows->reserveRun($this->appId, $this->ownerId, $this->reservePayload('py-flow', null)));
        $this->assertSame(['python'], $e->languages);
        // A caller that declares only JavaScript is refused the same way.
        $this->refused(fn () => self::$flows->reserveRun($this->appId, $this->ownerId, $this->reservePayload('py-flow', ['javascript'])));
        $this->refused(fn () => self::$flows->reserveOwnerRun($this->ownerId, $this->reservePayload('py-ws', null)));

        $this->assertSame($before, $this->rowsFor('py-flow'), 'no run row and no revision row');
        $this->assertSame($beforeWs, $this->rowsFor('py-ws'));
        $this->assertSame(0, $beforeWs['runs']);
    }

    public function testReserveWithPythonDeclaredSucceedsAndReplaysStayIdempotent(): void
    {
        $key = 'k-' . bin2hex(random_bytes(8));
        $first = self::$flows->reserveRun($this->appId, $this->ownerId, $this->reservePayload('py-flow', self::BOTH, $key));
        $this->assertTrue($first['created']);
        $this->assertSame('running', $first['run']['status']);

        // Same key, same caller: the existing run comes back, nothing new is written.
        $replay = self::$flows->reserveRun($this->appId, $this->ownerId, $this->reservePayload('py-flow', self::BOTH, $key));
        $this->assertFalse($replay['created']);
        $this->assertSame($first['run']['runId'], $replay['run']['runId']);
        $this->assertSame(1, $this->rowsFor('py-flow')['runs']);

        // A JavaScript-only caller replaying that key is still refused, and still writes nothing.
        $this->refused(fn () => self::$flows->reserveRun($this->appId, $this->ownerId, $this->reservePayload('py-flow', null, $key)));
        $this->assertSame(1, $this->rowsFor('py-flow')['runs']);

        $owner = self::$flows->reserveOwnerRun($this->ownerId, $this->reservePayload('py-ws', self::BOTH));
        $this->assertTrue($owner['created']);
        // A comma-separated value (what a listing query carries) is accepted too.
        $this->assertTrue(self::$flows->reserveOwnerRun($this->ownerId, $this->reservePayload('py-ws', null) + ['logicLanguages' => 'javascript,python'])['created']);
    }

    public function testJavaScriptFlowsAreUnaffectedForCallersThatSayNothing(): void
    {
        $app = self::$flows->reserveRun($this->appId, $this->ownerId, $this->reservePayload('js-flow', null));
        $this->assertTrue($app['created']);
        $ws = self::$flows->reserveOwnerRun($this->ownerId, $this->reservePayload('js-ws', null));
        $this->assertTrue($ws['created']);
        // An explicit 'javascript' on the node is the same as none.
        $this->assertSame('javascript', $this->made['js-ws']['flowJson']['nodes'][1]['data']['language']);
    }

    /**
     * A queued reserve only records work; whoever claims it runs it, and claim and the queued
     * listings are gated. OAIY plugin events always reserve queued runs, so gating the reserve
     * lost a Desktop event bound to a Python flow whenever no FormLogic tab was open.
     */
    public function testQueuedReservesAreNotGatedBecauseTheReserverDoesNotRunThem(): void
    {
        $app = self::$flows->reserveRun($this->appId, $this->ownerId, ['queued' => true] + $this->reservePayload('py-flow', null));
        $this->assertTrue($app['created']);
        $this->assertSame('queued', $app['run']['status']);
        $ws = self::$flows->reserveOwnerRun($this->ownerId, ['queued' => true] + $this->reservePayload('py-ws', ['javascript']));
        $this->assertTrue($ws['created']);
        $this->assertSame('queued', $ws['run']['status']);

        // Only a runtime that runs Python sees and takes them.
        $this->assertNotContains($app['run']['runId'], array_column(self::$flows->listQueuedRuns($this->appId, 50), 'runId'));
        $this->assertContains($app['run']['runId'], array_column(self::$flows->listQueuedRuns($this->appId, 50, self::BOTH), 'runId'));
        $this->assertNotContains($ws['run']['runId'], array_column(self::$flows->listOwnerQueuedRuns($this->ownerId, 50), 'runId'));
        $this->refused(fn () => self::$flows->claimOwnerRun($this->ownerId, $ws['run']['runId'], ['runtime' => 'desktop']));
        $this->assertSame('running', self::$flows->claimOwnerRun($this->ownerId, $ws['run']['runId'], ['runtime' => 'browser', 'logicLanguages' => self::BOTH])['status']);

        // A malformed declaration is still bad input, queued or not.
        try {
            self::$flows->reserveRun($this->appId, $this->ownerId, ['queued' => true, 'logicLanguages' => 42] + $this->reservePayload('py-flow', null));
            $this->fail('malformed logicLanguages must be refused');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('logicLanguages', $e->getMessage());
        }

        // Over HTTP: the Desktop's queued reserve of a Python flow is accepted.
        [$code, $body] = $this->call('POST', fn ($rq, $rs) => self::$ctrl->reserveOwnerRun($rq, $rs), ['queued' => true] + $this->reservePayload('py-ws', null));
        $this->assertSame(201, $code);
        $this->assertSame('queued', $body['run']['status']);
        [$code] = $this->call('POST', fn ($rq, $rs) => self::$ctrl->reserveRun($rq, $rs, ['slug' => $this->slug]), ['queued' => true] + $this->reservePayload('py-flow', null));
        $this->assertSame(201, $code);
    }

    /**
     * GET /api/v1/flows is where a Desktop fetches the graph it runs. A Desktop from before
     * Python sends no logicLanguages and would run a Python block as JavaScript, so it never
     * receives a flow that needs a language it did not declare: its fetch fails closed.
     */
    public function testDesktopFlowListLeavesOutFlowsWithCodeTheCallerCannotRun(): void
    {
        $slugs = function (array $query): array {
            [$code, $body] = $this->call('GET', fn ($rq, $rs) => self::$ctrl->listOwnerFlows($rq, $rs), null, $query);
            $this->assertSame(200, $code);
            $out = array_column($body['flows'], 'slug');
            sort($out);
            return $out;
        };
        $this->assertSame(['js-flow', 'js-ws'], $slugs([]));
        $this->assertSame(['js-flow', 'js-ws'], $slugs(['logicLanguages' => 'javascript']));
        $this->assertSame(['js-flow', 'js-ws', 'py-flow', 'py-ws'], $slugs(['logicLanguages' => 'javascript,python']));
        // The narrowing filters still apply.
        $this->assertSame(['js-ws'], $slugs(['workspace' => '1']));
        $this->assertSame(['js-flow'], $slugs(['appId' => $this->appId]));
        $this->assertSame(['js-flow', 'py-flow'], $slugs(['appId' => $this->appId, 'logicLanguages' => 'python']));

        // Each flow says what it needs, so a Desktop can tell why.
        [, $body] = $this->call('GET', fn ($rq, $rs) => self::$ctrl->listOwnerFlows($rq, $rs), null, ['logicLanguages' => 'javascript,python']);
        $needs = array_column($body['flows'], 'logicLanguages', 'slug');
        $this->assertSame(['python'], $needs['py-flow']);
        $this->assertSame(['javascript'], $needs['js-flow']);

        [$code] = $this->call('GET', fn ($rq, $rs) => self::$ctrl->listOwnerFlows($rq, $rs), null, ['logicLanguages' => 'python,,javascript']);
        $this->assertSame(400, $code);
    }

    /** The app runtime reads each flow's languages from the server, which sees through packages. */
    public function testRuntimeFlowsCarryTheLanguagesEachFlowNeeds(): void
    {
        $needs = array_column(self::$flows->getRuntimeFlows($this->appId)['flows'], 'logicLanguages', 'slug');
        $this->assertSame(['javascript'], $needs['js-flow']);
        $this->assertSame(['python'], $needs['py-flow']);
    }

    public function testMalformedLogicLanguagesIsRefusedAsBadInput(): void
    {
        foreach ([['python' => true], [7], [''], [str_repeat('x', 33)], array_fill(0, 17, 'python'), 42] as $bad) {
            try {
                self::$flows->reserveRun($this->appId, $this->ownerId, ['logicLanguages' => $bad] + $this->reservePayload('js-flow', null));
                $this->fail('malformed logicLanguages must be refused: ' . json_encode($bad));
            } catch (\InvalidArgumentException $e) {
                $this->assertStringContainsString('logicLanguages', $e->getMessage());
            }
        }
        // Ids this server does not know are ignored rather than refused (a newer runtime may run more).
        $this->assertTrue(self::$flows->reserveRun($this->appId, $this->ownerId, $this->reservePayload('js-flow', ['javascript', 'lua']))['created']);
    }

    // ── Claim ───────────────────────────────────────────────────────────────────────────────

    public function testClaimOfAPythonRunWithoutPythonIsRefusedAndLeavesTheRunQueued(): void
    {
        $run = $this->enqueue('py-flow', '2026-01-01 00:00:00');

        $e = $this->refused(fn () => self::$flows->claimRun($this->appId, $run['runId'], ['runtime' => 'desktop', 'instanceId' => 'desk-1']));
        $this->assertSame(['python'], $e->languages);
        $row = $this->runRow($run['runId']);
        $this->assertSame('queued', $row['status']);
        $this->assertNull($row['runtime']);
        $this->assertNull($row['claimed_by']);
        $this->assertNull($row['started_at']);

        $claimed = self::$flows->claimRun($this->appId, $run['runId'], ['runtime' => 'browser', 'logicLanguages' => self::BOTH]);
        $this->assertSame('running', $claimed['status']);

        $ws = $this->enqueue('py-ws', '2026-01-01 00:00:00');
        $this->refused(fn () => self::$flows->claimOwnerRun($this->ownerId, $ws['runId'], ['runtime' => 'desktop', 'logicLanguages' => ['javascript']]));
        $this->assertSame('queued', $this->runRow($ws['runId'])['status']);
        $this->assertSame('running', self::$flows->claimOwnerRun($this->ownerId, $ws['runId'], ['runtime' => 'browser', 'logicLanguages' => self::BOTH])['status']);

        // Unknown runs keep their not-found answer; JavaScript runs claim as before.
        $this->assertNull(self::$flows->claimRun($this->appId, 'no-such-run', ['runtime' => 'desktop']));
        $js = $this->enqueue('js-flow', '2026-01-01 00:00:00');
        $this->assertSame('running', self::$flows->claimRun($this->appId, $js['runId'], ['runtime' => 'desktop'])['status']);
    }

    // ── Queued listings ─────────────────────────────────────────────────────────────────────

    public function testQueuedListingsLeaveOutRunsTheCallerCannotTakeBeforeTheLimit(): void
    {
        $py = $this->enqueue('py-flow', '2026-01-01 00:00:00');   // oldest: the queue head
        $js = $this->enqueue('js-flow', '2026-01-01 00:01:00');
        $pyWs = $this->enqueue('py-ws', '2026-01-01 00:02:00');
        $jsWs = $this->enqueue('js-ws', '2026-01-01 00:03:00');

        // A JavaScript-only Desktop polling one run at a time gets the JavaScript run, not an empty page.
        $this->assertSame([$js['runId']], array_column(self::$flows->listQueuedRuns($this->appId, 1), 'runId'));
        $this->assertSame([$js['runId']], array_column(self::$flows->listQueuedRuns($this->appId, 50, ['javascript']), 'runId'));
        $this->assertSame([$js['runId'], $jsWs['runId']], array_column(self::$flows->listOwnerQueuedRuns($this->ownerId, 50), 'runId'));
        $this->assertSame([$js['runId']], array_column(self::$flows->listOwnerQueuedRuns($this->ownerId, 1), 'runId'));

        // A caller that runs Python sees the whole queue, in order.
        $this->assertSame([$py['runId'], $js['runId']], array_column(self::$flows->listQueuedRuns($this->appId, 50, self::BOTH), 'runId'));
        $this->assertSame(
            [$py['runId'], $js['runId'], $pyWs['runId'], $jsWs['runId']],
            array_column(self::$flows->listOwnerQueuedRuns($this->ownerId, 50, self::BOTH), 'runId')
        );
    }

    public function testARowSavedBeforeTheCheckWithAnUnknownLanguageRunsNowhereItWouldBeMisread(): void
    {
        // Saving refuses unknown languages, so only an older row can hold one: write it directly.
        self::$pdo->prepare('UPDATE flow_definitions SET flow_json = ? WHERE id = ?')
            ->execute([json_encode($this->graph('logic_block', 'ruby')), $this->made['js-flow']['id']]);

        // A runtime from before Python would run it as JavaScript: refused and hidden.
        $this->refused(fn () => self::$flows->reserveRun($this->appId, $this->ownerId, $this->reservePayload('js-flow', null)));
        $run = $this->enqueue('js-flow', '2026-01-01 00:00:00');
        $this->assertSame([], self::$flows->listQueuedRuns($this->appId, 50));
        // One that declares its languages reads data.language and fails the run itself
        // (invalid_flow, visible in the run log), so it may take it.
        $this->assertSame([$run['runId']], array_column(self::$flows->listQueuedRuns($this->appId, 50, self::BOTH), 'runId'));
        $this->assertSame('running', self::$flows->claimRun($this->appId, $run['runId'], ['runtime' => 'browser', 'logicLanguages' => self::BOTH])['status']);
        $this->assertTrue(self::$flows->reserveRun($this->appId, $this->ownerId, $this->reservePayload('js-flow', self::BOTH))['created']);
    }

    // ── Saving ──────────────────────────────────────────────────────────────────────────────

    public function testSavingRefusesALanguageNoRuntimeRunsAndKeepsNodeDataVerbatim(): void
    {
        foreach (['ruby', 'Python', 'js', 5] as $bad) {
            try {
                self::$flows->createFlow($this->appId, $this->ownerId, ['name' => 'Bad', 'slug' => 'bad-flow', 'flowJson' => $this->graph('logic_block', $bad)]);
                $this->fail('an unsupported language must not save: ' . json_encode($bad));
            } catch (\InvalidArgumentException $e) {
                $this->assertStringContainsString("Flow node 'code' has an unsupported language", $e->getMessage());
            }
        }
        try {
            self::$flows->updateWorkspaceFlow($this->ownerId, $this->made['py-ws']['id'], ['flowJson' => $this->graph('condition', 'ruby')]);
            $this->fail('updates are checked too');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('unsupported language', $e->getMessage());
        }

        $stored = self::$flows->getFlow($this->appId, $this->made['py-flow']['id']);
        $this->assertSame(['expr' => 'result = 1', 'language' => 'python'], $stored['flowJson']['nodes'][1]['data']);
    }

    // ── HTTP surface ────────────────────────────────────────────────────────────────────────

    // ── Engine health (the heartbeat's stored capabilities) ─────────────────────────────────

    public function testAnEngineDownDesktopReservesAndClaimsNothingWhileALegacyOneIsUnchanged(): void
    {
        $this->linkDesktop('desk-legacy', null);
        $this->linkDesktop('desk-down', ['logic-language:javascript', 'logic-language:python']);
        $this->linkDesktop('desk-up', ['logic-language:javascript', 'logic-language:python', self::ENGINE]);

        // Reserve to run now: refused before anything is written, whatever the body declares —
        // for a JavaScript flow too, which the language gate alone would have let through.
        $this->refusedForEngine(fn () => self::$flows->reserveOwnerRun($this->ownerId, $this->reservePayload('js-ws', self::BOTH) + ['instanceId' => 'desk-down']));
        $this->refusedForEngine(fn () => self::$flows->reserveOwnerRun($this->ownerId, $this->reservePayload('js-ws', null) + ['instanceId' => 'desk-down']));
        $this->assertSame(['runs' => 0, 'versions' => 0], $this->rowsFor('js-ws'));
        // Reserving queued runs nothing, so the event is not lost: whoever claims it is judged.
        $this->assertTrue(self::$flows->reserveOwnerRun($this->ownerId, $this->reservePayload('js-ws', self::BOTH) + ['instanceId' => 'desk-down', 'queued' => true])['created']);
        // The legacy Desktop, and one with its engine up, reserve as before.
        $this->assertTrue(self::$flows->reserveOwnerRun($this->ownerId, $this->reservePayload('js-ws', null) + ['instanceId' => 'desk-legacy'])['created']);
        $this->assertTrue(self::$flows->reserveOwnerRun($this->ownerId, $this->reservePayload('py-ws', self::BOTH) + ['instanceId' => 'desk-up'])['created']);

        // Claim: the run stays queued, then the legacy Desktop takes it.
        $js = $this->enqueue('js-ws', '2026-01-01 00:00:00');
        $this->refusedForEngine(fn () => self::$flows->claimOwnerRun($this->ownerId, $js['runId'], ['runtime' => 'desktop', 'instanceId' => 'desk-down', 'logicLanguages' => self::BOTH]));
        $row = $this->runRow($js['runId']);
        $this->assertSame('queued', $row['status']);
        $this->assertNull($row['claimed_by']);
        $this->assertSame('running', self::$flows->claimOwnerRun($this->ownerId, $js['runId'], ['runtime' => 'desktop', 'instanceId' => 'desk-legacy'])['status']);
        // An unknown run keeps its not-found answer even for an engine-down claimant.
        $this->assertNull(self::$flows->claimOwnerRun($this->ownerId, 'no-such-run', ['runtime' => 'desktop', 'instanceId' => 'desk-down']));
    }

    public function testQueuedListingsAndTheFlowListAreEmptyForAnEngineDownDesktop(): void
    {
        $legacyKey = $this->linkDesktop('desk-legacy', null);
        $downKey = $this->linkDesktop('desk-down', ['logic-language:javascript', 'logic-language:python']);
        $upKey = $this->linkDesktop('desk-up', ['logic-language:javascript', 'logic-language:python', self::ENGINE]);
        $py = $this->enqueue('py-ws', '2026-01-01 00:00:00');
        $js = $this->enqueue('js-ws', '2026-01-01 00:01:00');

        // Service: the instance's stored heartbeat decides, over the declared languages.
        $this->assertSame([], self::$flows->listOwnerQueuedRuns($this->ownerId, 50, self::BOTH, 'desk-down'));
        $this->assertSame([$js['runId']], array_column(self::$flows->listOwnerQueuedRuns($this->ownerId, 50, null, 'desk-legacy'), 'runId'));
        $this->assertSame([$py['runId'], $js['runId']], array_column(self::$flows->listOwnerQueuedRuns($this->ownerId, 50, self::BOTH, 'desk-legacy'), 'runId'));
        $this->assertSame([$py['runId'], $js['runId']], array_column(self::$flows->listOwnerQueuedRuns($this->ownerId, 50, self::BOTH, 'desk-up'), 'runId'));
        // No instance (a session caller): the declaration alone, as before.
        $this->assertSame([$js['runId']], array_column(self::$flows->listOwnerQueuedRuns($this->ownerId, 50, null), 'runId'));

        // Controllers: the API key's connection binding is the identity (FL-01).
        $queued = fn (?string $key): array => array_column(
            $this->call('GET', fn ($rq, $rs) => self::$ctrl->listOwnerQueuedRuns($rq, $rs), null, ['logicLanguages' => 'javascript,python'], $key)[1]['runs'],
            'runId'
        );
        $this->assertSame([], $queued($downKey));
        $this->assertSame([$py['runId'], $js['runId']], $queued($legacyKey));
        $this->assertSame([$py['runId'], $js['runId']], $queued($upKey));
        $this->assertSame([$py['runId'], $js['runId']], $queued(null));

        $flows = function (?string $key, array $query = ['logicLanguages' => 'javascript,python']): array {
            [$code, $body] = $this->call('GET', fn ($rq, $rs) => self::$ctrl->listOwnerFlows($rq, $rs), null, $query, $key);
            $this->assertSame(200, $code);
            $out = array_column($body['flows'], 'slug');
            sort($out);
            return $out;
        };
        $this->assertSame([], $flows($downKey), 'its graph fetch fails closed: it runs nothing');
        $this->assertSame([], $flows($downKey, []));
        $this->assertSame(['js-flow', 'js-ws', 'py-flow', 'py-ws'], $flows($legacyKey));
        $this->assertSame(['js-flow', 'js-ws'], $flows($legacyKey, []));
        $this->assertSame(['js-flow', 'js-ws', 'py-flow', 'py-ws'], $flows($upKey));
        $this->assertSame(['js-flow', 'js-ws'], $flows($upKey, []), 'the body never widens beyond what it declared');

        // A key bound to no connection, or a claimed instance the key does not own, behave as the
        // write surface does: unbound is judged on the declaration, impersonation is 403.
        $this->assertSame([$py['runId'], $js['runId']], $queued('key-unbound'));
        [$code, $body] = $this->call('GET', fn ($rq, $rs) => self::$ctrl->listOwnerQueuedRuns($rq, $rs), null, ['instanceId' => 'desk-up'], $downKey);
        $this->assertSame(403, $code);
        $this->assertSame('instance_mismatch', $body['code']);
    }

    public function testControllersAnswer409EngineUnavailable(): void
    {
        $downKey = $this->linkDesktop('desk-down', ['logic-language:javascript']);
        $legacyKey = $this->linkDesktop('desk-legacy', null);

        [$code, $body] = $this->call('POST', fn ($rq, $rs) => self::$ctrl->reserveOwnerRun($rq, $rs), $this->reservePayload('js-ws', null), [], $downKey);
        $this->assertSame(409, $code);
        $this->assertSame('engine_unavailable', $body['code']);
        $this->assertStringContainsString('not reporting healthy', $body['message']);
        $this->assertArrayNotHasKey('languages', $body);
        $this->assertSame(['runs' => 0, 'versions' => 0], $this->rowsFor('js-ws'));
        [$code] = $this->call('POST', fn ($rq, $rs) => self::$ctrl->reserveOwnerRun($rq, $rs), $this->reservePayload('js-ws', null), [], $legacyKey);
        $this->assertSame(201, $code);

        $js = $this->enqueue('js-ws', '2026-01-01 00:00:00');
        [$code, $body] = $this->call('POST', fn ($rq, $rs) => self::$ctrl->claimOwnerRun($rq, $rs, ['runId' => $js['runId']]), ['runtime' => 'desktop', 'logicLanguages' => self::BOTH], [], $downKey);
        $this->assertSame(409, $code);
        $this->assertSame('engine_unavailable', $body['code']);
        $this->assertSame('queued', $this->runRow($js['runId'])['status']);
        [$code] = $this->call('POST', fn ($rq, $rs) => self::$ctrl->claimOwnerRun($rq, $rs, ['runId' => $js['runId']]), ['runtime' => 'desktop'], [], $legacyKey);
        $this->assertSame(200, $code);
        $this->assertSame('desk-legacy', $this->runRow($js['runId'])['claimed_by'], 'the key-bound identity, as before');
    }

    /**
     * The stored heartbeat against the body's `logicLanguages` when they disagree: the heartbeat
     * alone says whether the engine is up; a language runs only when both name it.
     */
    public function testTheStoredHeartbeatIsReconciledWithTheDeclaredLanguages(): void
    {
        $this->linkDesktop('desk-legacy', null);
        $this->linkDesktop('desk-js', ['logic-language:javascript', self::ENGINE]);
        $this->linkDesktop('desk-py', ['logic-language:javascript', 'logic-language:python', self::ENGINE]);
        $run = fn (): array => $this->enqueue('py-ws', '2026-01-01 00:00:00');

        // The heartbeat names JavaScript only: declaring Python in the body does not widen it.
        $py = $run();
        $e = $this->refused(fn () => self::$flows->claimOwnerRun($this->ownerId, $py['runId'], ['runtime' => 'desktop', 'instanceId' => 'desk-js', 'logicLanguages' => self::BOTH]));
        $this->assertSame(['python'], $e->languages);
        $this->assertSame('queued', $this->runRow($py['runId'])['status']);
        $this->refused(fn () => self::$flows->reserveOwnerRun($this->ownerId, $this->reservePayload('py-ws', self::BOTH) + ['instanceId' => 'desk-js']));

        // The heartbeat names Python, the body does not (or says nothing): never handed Python.
        $this->refused(fn () => self::$flows->claimOwnerRun($this->ownerId, $py['runId'], ['runtime' => 'desktop', 'instanceId' => 'desk-py', 'logicLanguages' => ['javascript']]));
        $this->refused(fn () => self::$flows->claimOwnerRun($this->ownerId, $py['runId'], ['runtime' => 'desktop', 'instanceId' => 'desk-py']));
        // Both agree: claimed.
        $this->assertSame('running', self::$flows->claimOwnerRun($this->ownerId, $py['runId'], ['runtime' => 'desktop', 'instanceId' => 'desk-py', 'logicLanguages' => self::BOTH])['status']);

        // A legacy heartbeat leaves the body in charge — today's OAIY declares its languages in
        // the body and sends no tokens, and keeps claiming Python exactly as before.
        $py = $run();
        $this->assertSame('running', self::$flows->claimOwnerRun($this->ownerId, $py['runId'], ['runtime' => 'desktop', 'instanceId' => 'desk-legacy', 'logicLanguages' => self::BOTH])['status']);
        $this->assertTrue(self::$flows->reserveOwnerRun($this->ownerId, $this->reservePayload('py-ws', self::BOTH) + ['instanceId' => 'desk-legacy'])['created']);
        // Listings follow the same reconciliation.
        $py = $run();
        $this->assertSame([], array_column(self::$flows->listOwnerQueuedRuns($this->ownerId, 50, self::BOTH, 'desk-js'), 'runId'));
        $this->assertSame([], array_column(self::$flows->listOwnerQueuedRuns($this->ownerId, 50, null, 'desk-py'), 'runId'));
        $this->assertSame([$py['runId']], array_column(self::$flows->listOwnerQueuedRuns($this->ownerId, 50, self::BOTH, 'desk-py'), 'runId'));
        $this->assertSame([$py['runId']], array_column(self::$flows->listOwnerQueuedRuns($this->ownerId, 50, self::BOTH, 'desk-legacy'), 'runId'));
    }

    public function testControllersAnswer409LanguageUnsupportedAnd400ForMalformedLists(): void
    {
        $slugArgs = ['slug' => $this->slug];

        [$code, $body] = $this->call('POST', fn ($rq, $rs) => self::$ctrl->reserveRun($rq, $rs, $slugArgs), $this->reservePayload('py-flow', null));
        $this->assertSame(409, $code);
        $this->assertSame('language_unsupported', $body['code']);
        $this->assertSame(['python'], $body['languages']);

        [$code] = $this->call('POST', fn ($rq, $rs) => self::$ctrl->reserveRun($rq, $rs, $slugArgs), $this->reservePayload('py-flow', self::BOTH));
        $this->assertSame(201, $code);

        [$code, $body] = $this->call('POST', fn ($rq, $rs) => self::$ctrl->reserveOwnerRun($rq, $rs), $this->reservePayload('py-ws', null));
        $this->assertSame(409, $code);
        $this->assertSame('language_unsupported', $body['code']);

        $queued = $this->enqueue('py-flow', '2026-01-01 00:00:00');
        [$code, $body] = $this->call('POST', fn ($rq, $rs) => self::$ctrl->claimRun($rq, $rs, $slugArgs + ['runId' => $queued['runId']]), ['runtime' => 'desktop']);
        $this->assertSame(409, $code);
        $this->assertSame('language_unsupported', $body['code']);

        $ws = $this->enqueue('py-ws', '2026-01-01 00:01:00');
        [$code, $body] = $this->call('POST', fn ($rq, $rs) => self::$ctrl->claimOwnerRun($rq, $rs, ['runId' => $ws['runId']]), ['runtime' => 'desktop']);
        $this->assertSame(409, $code);
        $this->assertSame('language_unsupported', $body['code']);

        // Listings read ?logicLanguages=: absent hides Python runs, declared shows them.
        [, $body] = $this->call('GET', fn ($rq, $rs) => self::$ctrl->queuedRuns($rq, $rs, $slugArgs));
        $this->assertNotContains($queued['runId'], array_column($body['runs'], 'runId'));
        [, $body] = $this->call('GET', fn ($rq, $rs) => self::$ctrl->queuedRuns($rq, $rs, $slugArgs), null, ['logicLanguages' => 'javascript,python']);
        $this->assertContains($queued['runId'], array_column($body['runs'], 'runId'));
        [, $body] = $this->call('GET', fn ($rq, $rs) => self::$ctrl->listOwnerQueuedRuns($rq, $rs));
        $this->assertNotContains($ws['runId'], array_column($body['runs'], 'runId'));
        [, $body] = $this->call('GET', fn ($rq, $rs) => self::$ctrl->listOwnerQueuedRuns($rq, $rs), null, ['logicLanguages' => 'javascript,python']);
        $this->assertContains($ws['runId'], array_column($body['runs'], 'runId'));

        [$code] = $this->call('GET', fn ($rq, $rs) => self::$ctrl->queuedRuns($rq, $rs, $slugArgs), null, ['logicLanguages' => 'python,,javascript']);
        $this->assertSame(400, $code);
        [$code] = $this->call('GET', fn ($rq, $rs) => self::$ctrl->listOwnerQueuedRuns($rq, $rs), null, ['logicLanguages' => str_repeat('p', 40)]);
        $this->assertSame(400, $code);
        [$code] = $this->call('POST', fn ($rq, $rs) => self::$ctrl->claimRun($rq, $rs, $slugArgs + ['runId' => $queued['runId']]), ['runtime' => 'browser', 'logicLanguages' => [['python']]]);
        $this->assertSame(400, $code);
        $this->assertSame('queued', $this->runRow($queued['runId'])['status']);
    }
}

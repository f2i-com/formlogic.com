<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\FlowController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FlowService;
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
 * Skipped without a test DB.
 */
class FlowLogicLanguageGateTest extends TestCase
{
    private const BOTH = ['javascript', 'python'];

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

    /** @param array<string, mixed>|null $body */
    private function call(string $method, callable $handler, ?array $body = null, array $query = []): array
    {
        $req = (new ServerRequestFactory())->createServerRequest($method, 'http://localhost/api/test')
            ->withAttribute('userId', $this->ownerId);
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

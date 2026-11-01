<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\AppPublicController;
use FormLogic\Controllers\ExternalApiController;
use FormLogic\Controllers\ResponseController;
use FormLogic\Controllers\ServiceInvokeController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppDomainService;
use FormLogic\Services\AppResponseService;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\ChatToolsContext;
use FormLogic\Services\ChatToolsService;
use FormLogic\Services\DataOperationLogService;
use FormLogic\Services\FormLogicRuntime;
use FormLogic\Services\FormQuotaRefused;
use FormLogic\Services\FormService;
use FormLogic\Services\ResponseService;
use FormLogic\Services\ResponseVersionConflict;
use FormLogic\Services\ScriptResult;
use FormLogic\Services\WebhookService;
use PDO;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response as SlimResponse;

/**
 * What parallel requests do to each other. The tests named "processes" run real PHP processes
 * against the real files, because SQLite's locks are the thing being tested and a second
 * connection in this process would not meet them the same way.
 */
final class ParallelWritesTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    /** @var array<string, string> */
    private static array $config = [];
    private static string $sqlitePath = '';
    private static SQLiteConnection $sqlite;
    private static FormService $forms;
    private static AppService $apps;

    private string $userId = '';
    private string $formId = '';
    /** @var string[] */
    private array $appIds = [];
    /** @var string[] */
    private array $formIds = [];

    public static function setUpBeforeClass(): void
    {
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) {
            \Dotenv\Dotenv::createImmutable($root)->safeLoad();
        }
        self::$config = [
            'host' => $_ENV['DB_HOST'] ?? '127.0.0.1',
            'port' => $_ENV['DB_PORT'] ?? '3306',
            'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
            'username' => $_ENV['DB_USERNAME'] ?? 'root',
            'password' => $_ENV['DB_PASSWORD'] ?? '',
            'charset' => 'utf8mb4',
            'collation' => 'utf8mb4_unicode_ci',
        ];
        try {
            $conn = new MySQLConnection(self::$config);
            $conn->getConnection()->query('SELECT 1');
            $conn->initializeSchema();
            $conn->runMigrations();
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
        self::$mysql = $conn;
        self::$pdo = $conn->getConnection();
        self::$sqlitePath = sys_get_temp_dir() . '/fl-parallel-' . bin2hex(random_bytes(5));
        self::$sqlite = new SQLiteConnection(self::$sqlitePath);
        self::$forms = new FormService($conn, self::$sqlite);
        self::$apps = new AppService($conn, self::$forms);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->userId = 'u' . bin2hex(random_bytes(10));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$this->userId, $this->userId . '@test.local']);
        $this->formId = $this->newForm();
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        foreach ($this->appIds as $appId) {
            self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$appId]);
        }
        foreach ($this->formIds as $formId) {
            self::$pdo->prepare('DELETE FROM response_metadata WHERE form_id = ?')->execute([$formId]);
            self::$pdo->prepare('DELETE FROM forms WHERE id = ?')->execute([$formId]);
        }
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
    }

    /** MySQLConnection keeps one connection per process, and these tests need someone else. */
    private function anotherConnection(): PDO
    {
        return new PDO(
            sprintf('mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4', self::$config['host'], self::$config['port'], self::$config['database']),
            self::$config['username'],
            self::$config['password'],
            [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
        );
    }

    private function newForm(array $settings = []): string
    {
        $form = self::$forms->createForm([
            'userId' => $this->userId,
            'title' => 'Parallel',
            'status' => 'published',
            'settings' => $settings,
            'fields' => [
                ['id' => 'a', 'type' => 'short_text', 'label' => 'A', 'order' => 0, 'properties' => []],
                ['id' => 'b', 'type' => 'short_text', 'label' => 'B', 'order' => 1, 'properties' => []],
                ['id' => 'who', 'type' => 'short_text', 'label' => 'Who', 'order' => 2, 'properties' => []],
            ],
        ]);
        $this->formIds[] = (string) $form['id'];
        return (string) $form['id'];
    }

    private function newRecord(ResponseService $responses): string
    {
        $created = $responses->createResponse($this->formId, ['answers' => ['a' => 'old', 'b' => 'old']]);
        self::assertIsArray($created);
        return (string) $created['id'];
    }

    /** A published app holding this form, and a role that may edit it. @return array{slug:string, id:string} */
    private function newApp(): array
    {
        $app = self::$apps->createApp(['name' => 'Parallel', 'status' => 'published', 'formIds' => [$this->formId]], $this->userId);
        $this->appIds[] = (string) $app['id'];
        return ['slug' => (string) $app['slug'], 'id' => (string) $app['id']];
    }

    /**
     * Starts $count workers on one job at one moment, and waits for them.
     *
     * @return list<array{done:int, errors:list<string>, errorCount:int}>
     */
    private function runWorkers(string $mode, array $job, int $count): array
    {
        if (!is_dir(self::$sqlitePath . '-uploads')) {
            mkdir(self::$sqlitePath . '-uploads', 0700, true);
        }
        // Long enough that every process is up and waiting before it passes.
        $job['startAt'] = microtime(true) + 1.5;
        $running = [];
        for ($i = 0; $i < $count; $i++) {
            $running[] = $this->start($mode, $job + ['who' => 'w' . $i]);
        }
        $reports = [];
        foreach ($running as [$process, $pipes]) {
            $out = stream_get_contents($pipes[1]);
            $err = stream_get_contents($pipes[2]);
            fclose($pipes[1]);
            fclose($pipes[2]);
            self::assertSame(0, proc_close($process), "worker failed: {$out}{$err}");
            $report = json_decode((string) $out, true);
            self::assertIsArray($report, "worker said: {$out}{$err}");
            $reports[] = $report;
        }
        return $reports;
    }

    /** @return array{0: resource, 1: array<int, resource>} */
    private function start(string $mode, array $job): array
    {
        $job += ['mysql' => self::$config, 'sqlite' => self::$sqlitePath, 'uploads' => self::$sqlitePath . '-uploads'];
        $pipes = [];
        $process = proc_open(
            [PHP_BINARY, '-d', 'xdebug.mode=off', dirname(__DIR__) . '/Support/ParallelWorker.php', $mode, json_encode($job, JSON_THROW_ON_ERROR)],
            [1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
            $pipes
        );
        self::assertIsResource($process);
        return [$process, $pipes];
    }

    // ── two edits of one record ───────────────────────────────────────────────

    public function testTwoProcessesEditingOneRecordKeepEveryEdit(): void
    {
        $responses = new ResponseService(self::$mysql, self::$sqlite);
        $id = $this->newRecord($responses);

        $reports = $this->runWorkers('edit', ['formId' => $this->formId, 'responseId' => $id, 'rounds' => 40], 2);

        foreach ($reports as $report) {
            self::assertSame(0, $report['errorCount'], implode("\n", $report['errors']));
        }
        $answers = $responses->getResponse($this->formId, $id)['answers'];
        for ($i = 0; $i < 40; $i++) {
            self::assertArrayHasKey('w0_' . $i, $answers);
            self::assertArrayHasKey('w1_' . $i, $answers);
        }
    }

    public function testTwoProcessesDeletingRecordsNeverMeetALockTheyCannotWaitFor(): void
    {
        $reports = $this->runWorkers('churn', ['formId' => $this->formId, 'rounds' => 40], 2);

        foreach ($reports as $report) {
            self::assertSame(0, $report['errorCount'], implode("\n", $report['errors']));
        }
        self::assertSame(0, (new ResponseService(self::$mysql, self::$sqlite))->getResponseCount($this->formId));
    }

    /** A ResponseService that lets another edit land just before this one writes. */
    private function responsesWithAnEditInBetween(callable $other, bool $everyTime = false): ResponseService
    {
        return new class ($other, $everyTime, self::$mysql, self::$sqlite) extends ResponseService {
            private bool $landed = false;

            public function __construct(private $other, private bool $everyTime, MySQLConnection $mysql, SQLiteConnection $sqlite)
            {
                parent::__construct($mysql, $sqlite);
            }

            public function updateResponse(string $formId, string $responseId, array $data, ?string $ifMatch = null): ?array
            {
                if (!$this->landed || $this->everyTime) {
                    $this->landed = true;
                    ($this->other)($formId, $responseId);
                }
                return parent::updateResponse($formId, $responseId, $data, $ifMatch);
            }
        };
    }

    /** The other editor, who changes field a. */
    private function otherEditorSetsA(): callable
    {
        $plain = new ResponseService(self::$mysql, self::$sqlite);
        return static function (string $formId, string $responseId) use ($plain): void {
            $answers = $plain->getResponse($formId, $responseId)['answers'];
            $plain->updateResponse($formId, $responseId, ['answers' => ['a' => 'from-the-other'] + $answers]);
        };
    }

    private function appController(ResponseService $responses): AppPublicController
    {
        return new AppPublicController(
            self::$apps,
            new AppUserService(self::$mysql),
            new AppResponseService(self::$mysql, self::$sqlite, $responses, null, self::$forms),
            self::$forms,
            $responses,
            self::$mysql,
            self::$sqlite,
            new AppDomainService(self::$mysql)
        );
    }

    private function appPut(AppPublicController $controller, string $slug, string $id, array $body): SlimResponse
    {
        $request = (new ServerRequestFactory())->createServerRequest('PUT', "/api/app/{$slug}/forms/{$this->formId}/responses/{$id}")
            ->withAttribute('userId', $this->userId)
            ->withParsedBody($body);
        $response = $controller->updateResponseById($request, new SlimResponse(), ['slug' => $slug, 'formId' => $this->formId, 'id' => $id]);
        self::assertInstanceOf(SlimResponse::class, $response);
        return $response;
    }

    public function testTheAppRouteKeepsAnEditThatLandsWhileItMerges(): void
    {
        $app = $this->newApp();
        $responses = $this->responsesWithAnEditInBetween($this->otherEditorSetsA());
        $id = $this->newRecord($responses);

        $answer = $this->appPut($this->appController($responses), $app['slug'], $id, ['answers' => ['b' => 'mine']]);

        self::assertSame(200, $answer->getStatusCode(), (string) $answer->getBody());
        $stored = (new ResponseService(self::$mysql, self::$sqlite))->getResponse($this->formId, $id)['answers'];
        self::assertSame('from-the-other', $stored['a']);
        self::assertSame('mine', $stored['b']);
    }

    public function testTheAppRouteSaysToTryAgainWhenItLosesEveryAttempt(): void
    {
        $app = $this->newApp();
        $responses = $this->responsesWithAnEditInBetween($this->otherEditorSetsAndBumps(), true);
        $id = $this->newRecord($responses);

        $answer = $this->appPut($this->appController($responses), $app['slug'], $id, ['answers' => ['b' => 'mine']]);

        self::assertSame(503, $answer->getStatusCode());
        self::assertSame('2', $answer->getHeaderLine('Retry-After'));
        self::assertStringNotContainsString('version_conflict', (string) $answer->getBody());
    }

    /** Another editor who changes something every time, so that this one never wins. */
    private function otherEditorSetsAndBumps(): callable
    {
        $plain = new ResponseService(self::$mysql, self::$sqlite);
        return static function (string $formId, string $responseId) use ($plain): void {
            $answers = $plain->getResponse($formId, $responseId)['answers'];
            $plain->updateResponse($formId, $responseId, ['answers' => ['a' => bin2hex(random_bytes(4))] + $answers]);
        };
    }

    private function externalPut(ResponseService $responses, string $id, array $body, array $headers = []): SlimResponse
    {
        $controller = new ExternalApiController(self::$forms, $responses, new WebhookService(self::$mysql));
        $request = (new ServerRequestFactory())->createServerRequest('PUT', "/api/v1/forms/{$this->formId}/responses/{$id}")
            ->withAttribute('userId', $this->userId)
            ->withAttribute('apiKeyScopes', ['responses:read', 'responses:manage'])
            ->withParsedBody($body);
        foreach ($headers as $name => $value) {
            $request = $request->withHeader($name, $value);
        }
        $response = $controller->updateResponse($request, new SlimResponse(), ['formId' => $this->formId, 'id' => $id]);
        self::assertInstanceOf(SlimResponse::class, $response);
        return $response;
    }

    public function testTheExternalApiKeepsAnEditThatLandsWhileItMerges(): void
    {
        $responses = $this->responsesWithAnEditInBetween($this->otherEditorSetsA());
        $id = $this->newRecord($responses);

        $answer = $this->externalPut($responses, $id, ['answers' => ['b' => 'mine']]);

        self::assertSame(200, $answer->getStatusCode(), (string) $answer->getBody());
        $stored = (new ResponseService(self::$mysql, self::$sqlite))->getResponse($this->formId, $id)['answers'];
        self::assertSame('from-the-other', $stored['a']);
        self::assertSame('mine', $stored['b']);
    }

    public function testAClientsOwnIfMatchIsStillAConflictForThem(): void
    {
        $responses = new ResponseService(self::$mysql, self::$sqlite);
        $id = $this->newRecord($responses);
        $version = ResponseService::etagOf($responses->getResponse($this->formId, $id));
        $responses->updateResponse($this->formId, $id, ['answers' => ['a' => 'someone-else', 'b' => 'old']]);

        $answer = $this->externalPut($responses, $id, ['answers' => ['b' => 'mine']], ['If-Match' => '"' . $version . '"']);

        self::assertSame(412, $answer->getStatusCode(), (string) $answer->getBody());
        self::assertSame('old', $responses->getResponse($this->formId, $id)['answers']['b'], 'nothing was written');
    }

    public function testAClientsIfMatchIsNotRetriedOverANewerRecord(): void
    {
        $responses = new ResponseService(self::$mysql, self::$sqlite);
        $id = $this->newRecord($responses);
        $runs = 0;
        try {
            $responses->mergeEdit($this->formId, $id, static function () use (&$runs, $responses, $id) {
                $runs++;
                throw new ResponseVersionConflict($responses->getResponse('x', $id) ?? []);
            }, 'a-version-the-client-holds');
            self::fail('The conflict is the client\'s to see');
        } catch (ResponseVersionConflict) {
            self::assertSame(1, $runs);
        }
    }

    public function testTheChatToolKeepsAnEditThatLandsWhileItMerges(): void
    {
        $responses = $this->responsesWithAnEditInBetween($this->otherEditorSetsA());
        $id = $this->newRecord($responses);
        $tools = new ChatToolsService(self::$forms, self::$apps, $responses);

        $tools->call('update_response', ['formId' => $this->formId, 'responseId' => $id, 'answers' => ['b' => 'mine']], new ChatToolsContext($this->userId));

        $stored = (new ResponseService(self::$mysql, self::$sqlite))->getResponse($this->formId, $id)['answers'];
        self::assertSame('from-the-other', $stored['a']);
        self::assertSame('mine', $stored['b']);
    }

    // ── the write lock ────────────────────────────────────────────────────────

    public function testBeginWriteHoldsTheLockFromTheStartAndCommitsThroughPdo(): void
    {
        $path = self::$sqlite->getFormDbPath($this->formId);
        $other = new PDO('sqlite:' . $path, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $other->exec('PRAGMA busy_timeout = 0');
        $db = self::$sqlite->getFormDatabase($this->formId);

        SQLiteConnection::beginWrite($db);
        self::assertTrue($db->inTransaction());
        try {
            $other->exec("INSERT INTO form_data (key, value) VALUES ('not-yet', '1')");
            self::fail('The lock is taken before anything has been written');
        } catch (\PDOException $e) {
            self::assertStringContainsString('database is locked', $e->getMessage());
        }
        $db->commit();

        $other->exec("INSERT INTO form_data (key, value) VALUES ('now', '1')");
        self::assertFalse($db->inTransaction());
    }

    // ── the app's documents ───────────────────────────────────────────────────

    public function testParallelCreateReportCallsAllLand(): void
    {
        $app = $this->newApp();

        $reports = $this->runWorkers('report', ['appId' => $app['id'], 'formId' => $this->formId, 'userId' => $this->userId, 'rounds' => 12], 2);

        foreach ($reports as $report) {
            self::assertSame(0, $report['errorCount'], implode("\n", $report['errors']));
        }
        self::assertCount(24, self::$apps->getApp($app['id'])['reports']);
    }

    public function testUpdateAppLockedHoldsTheRowAcrossTheReadAndTheWrite(): void
    {
        $app = $this->newApp();
        $other = $this->anotherConnection();
        $other->exec('SET innodb_lock_wait_timeout = 1');

        $blocked = false;
        self::$apps->updateAppLocked($app['id'], function (array $current) use ($other, $app, &$blocked): array {
            try {
                $other->prepare('UPDATE apps SET description = ? WHERE id = ?')->execute(['in between', $app['id']]);
            } catch (\PDOException $e) {
                $blocked = str_contains($e->getMessage(), 'Lock wait timeout');
            }
            return ['settings' => ['kept' => true] + (is_array($current['settings'] ?? null) ? $current['settings'] : [])];
        });

        self::assertTrue($blocked, 'nobody writes the row between the read and the write');
        self::assertTrue(self::$apps->getApp($app['id'])['settings']['kept']);
    }

    public function testEveryToolThatRewritesAnAppsDocumentHoldsTheRow(): void
    {
        $app = $this->newApp();
        $apps = new class (self::$mysql, self::$forms) extends AppService {
            public int $held = 0;

            public function updateAppLocked(string $appId, callable $change): ?array
            {
                $this->held++;
                return parent::updateAppLocked($appId, $change);
            }
        };
        $tools = new ChatToolsService(self::$forms, $apps, new ResponseService(self::$mysql, self::$sqlite));
        $ctx = new ChatToolsContext($this->userId);

        $tools->call('update_app', ['appId' => $app['id'], 'hideNav' => true], $ctx);
        self::assertSame(1, $apps->held);
        self::assertTrue(self::$apps->getApp($app['id'])['settings']['hideNav']);

        $report = $tools->call('create_report', ['appId' => $app['id'], 'spec' => ['formId' => $this->formId, 'viz' => 'kpi']], $ctx);
        self::assertSame(2, $apps->held);

        $tools->call('create_document', ['appId' => $app['id'], 'blocks' => [['kind' => 'report', 'reportId' => $report['id']]]], $ctx);
        self::assertSame(3, $apps->held);

        $invoke = (new \ReflectionClass(ServiceInvokeController::class))->newInstanceWithoutConstructor();
        (new \ReflectionProperty(ServiceInvokeController::class, 'appService'))->setValue($invoke, $apps);
        (new \ReflectionProperty(ServiceInvokeController::class, 'audit'))->setValue($invoke, null);
        $policy = array_fill_keys(['remoteMonitoring', 'remoteConsult', 'remoteTakeover', 'remoteCaptions', 'remoteAssistance'], true);
        (new \ReflectionMethod(ServiceInvokeController::class, 'companionPolicyUpdate'))
            ->invoke($invoke, self::$apps->getApp($app['id']), $this->userId, ['remoteConsent' => $policy], '127.0.0.1');
        self::assertSame(4, $apps->held);
        $settings = self::$apps->getApp($app['id'])['settings'];
        self::assertTrue($settings['aokieCompanion']['remoteConsent']['remoteTakeover']);
        self::assertTrue($settings['hideNav'], 'the rest of the settings stay');
    }

    public function testUpdateAppLockedLetsGoWhenTheChangeRefuses(): void
    {
        $app = $this->newApp();
        try {
            self::$apps->updateAppLocked($app['id'], static function (): array {
                throw new \RuntimeException('Reports exceed the 256KB limit');
            });
            self::fail('The refusal reaches the caller');
        } catch (\RuntimeException $e) {
            self::assertSame('Reports exceed the 256KB limit', $e->getMessage());
        }
        self::assertFalse(self::$pdo->inTransaction());
    }

    public function testACreatedDocumentSeesAReportMadeInTheSameRequestOrder(): void
    {
        $app = $this->newApp();
        $responses = new ResponseService(self::$mysql, self::$sqlite);
        $tools = new ChatToolsService(self::$forms, self::$apps, $responses);
        $ctx = new ChatToolsContext($this->userId);
        $report = $tools->call('create_report', ['appId' => $app['id'], 'spec' => ['formId' => $this->formId, 'viz' => 'kpi']], $ctx);
        $document = $tools->call('create_document', ['appId' => $app['id'], 'blocks' => [['kind' => 'report', 'reportId' => $report['id']]]], $ctx);

        self::assertCount(2, self::$apps->getApp($app['id'])['reports']);
        self::assertSame('document', $document['type']);
    }

    // ── the quota ─────────────────────────────────────────────────────────────

    public function testTheQuotaHoldsAcrossProcesses(): void
    {
        $reports = $this->runWorkers('submit', ['formId' => $this->formId, 'limit' => 5, 'rounds' => 8], 2);

        foreach ($reports as $report) {
            self::assertSame(0, $report['errorCount'], implode("\n", $report['errors']));
        }
        self::assertSame(5, (new ResponseService(self::$mysql, self::$sqlite))->getResponseCount($this->formId));
    }

    public function testAFullFormRefusesAndAFormWithRoomDoesNot(): void
    {
        $responses = new ResponseService(self::$mysql, self::$sqlite);
        self::assertIsArray($responses->createResponse($this->formId, ['answers' => []], null, null, 1));
        try {
            $responses->createResponse($this->formId, ['answers' => []], null, null, 1);
            self::fail('The second submission is over the limit');
        } catch (FormQuotaRefused $e) {
            self::assertFalse($e->busy);
        }
        self::assertSame(1, $responses->getResponseCount($this->formId));
    }

    public function testAFormWhoseLockIsHeldSaysItIsBusy(): void
    {
        $name = 'fl_form_submit_' . substr(hash('sha256', $this->formId), 0, 40);
        $other = $this->anotherConnection();
        $other->query("SELECT GET_LOCK('{$name}', 0)")->fetchAll();
        $responses = new class (self::$mysql, self::$sqlite) extends ResponseService {
            public function acquireFormLock(string $formId, int $timeoutSeconds = 5): ?string
            {
                return parent::acquireFormLock($formId, 0);
            }
        };
        try {
            $responses->createResponse($this->formId, ['answers' => []], null, null, 3);
            self::fail('Without the lock nobody can say that there is room');
        } catch (FormQuotaRefused $e) {
            self::assertTrue($e->busy);
        } finally {
            $other->query("SELECT RELEASE_LOCK('{$name}')")->fetchAll();
        }
        self::assertSame(0, $responses->getResponseCount($this->formId));
    }

    public function testTheQuotaLockIsNotHeldWhileWebhooksRun(): void
    {
        $name = 'fl_form_submit_' . substr(hash('sha256', $this->formId), 0, 40);
        $other = $this->anotherConnection();
        $free = null;
        $webhooks = new class (self::$mysql, static function () use ($other, $name, &$free): void {
            $free = (int) $other->query("SELECT IS_FREE_LOCK('{$name}')")->fetchColumn();
        }) extends WebhookService {
            public function __construct(MySQLConnection $mysql, private $check)
            {
                parent::__construct($mysql);
            }

            public function dispatch(string $formId, string $event, array $data): void
            {
                ($this->check)();
            }
        };
        $responses = new ResponseService(self::$mysql, self::$sqlite, null, null, $webhooks);

        self::assertIsArray($responses->createResponse($this->formId, ['answers' => []], null, null, 3));

        self::assertSame(1, $free, 'the webhook is sent after the lock has gone');
    }

    public function testTheQuotaLockIsNotHeldWhileTheScriptRuns(): void
    {
        $name = 'fl_form_submit_' . substr(hash('sha256', $this->formId), 0, 40);
        $other = $this->anotherConnection();
        $free = null;
        $runtime = $this->createMock(FormLogicRuntime::class);
        $runtime->method('execute')->willReturnCallback(static function () use ($other, $name, &$free): ScriptResult {
            $free = (int) $other->query("SELECT IS_FREE_LOCK('{$name}')")->fetchColumn();
            return new ScriptResult(true);
        });
        $responses = new ResponseService(self::$mysql, self::$sqlite, $runtime);

        self::assertIsArray($responses->createResponse($this->formId, ['answers' => []], 'function onSubmit() {}', null, 3));

        self::assertSame(1, $free, 'one slow script used to hold up every other submission');
    }

    public function testEveryRouteLetsTheInsertCountTheQuota(): void
    {
        $seen = new \ArrayObject();
        $responses = new class ($seen, self::$mysql, self::$sqlite) extends ResponseService {
            public function __construct(private \ArrayObject $seen, MySQLConnection $mysql, SQLiteConnection $sqlite)
            {
                parent::__construct($mysql, $sqlite);
            }

            public function createResponse(string $formId, array $data, ?string $script = null, ?string $sourceRunId = null, ?int $quotaLimit = null): array|\FormLogic\Services\ScriptRejection
            {
                $this->seen->append($quotaLimit);
                return parent::createResponse($formId, $data, $script, $sourceRunId, $quotaLimit);
            }
        };
        $this->formId = $this->newForm(['quotaLimit' => 9]);

        $request = (new ServerRequestFactory())->createServerRequest('POST', '/api/v1/forms/' . $this->formId . '/responses')
            ->withAttribute('userId', $this->userId)
            ->withAttribute('apiKeyScopes', ['responses:read', 'responses:manage'])
            ->withParsedBody(['answers' => ['a' => 'x']]);
        $external = (new ExternalApiController(self::$forms, $responses, new WebhookService(self::$mysql)))
            ->submitResponse($request, new SlimResponse(), ['formId' => $this->formId]);
        self::assertSame(201, $external->getStatusCode(), (string) $external->getBody());

        $tools = new ChatToolsService(self::$forms, self::$apps, $responses);
        $tools->call('add_response', ['formId' => $this->formId, 'answers' => ['a' => 'y']], new ChatToolsContext($this->userId));

        // The public route serves a form that is in no app, so this comes before the app has it.
        $request = (new ServerRequestFactory())->createServerRequest('POST', "/api/forms/{$this->formId}/responses")
            ->withParsedBody(['answers' => ['a' => 'w']]);
        $public = (new ResponseController($responses, self::$forms, self::$sqlite, null, null, null, self::$apps, self::$mysql))
            ->create($request, new SlimResponse(), ['formId' => $this->formId]);
        self::assertSame(201, $public->getStatusCode(), (string) $public->getBody());

        $app = $this->newApp();
        $request = (new ServerRequestFactory())->createServerRequest('POST', "/api/app/{$app['slug']}/forms/{$this->formId}/responses")
            ->withAttribute('userId', $this->userId)
            ->withParsedBody(['answers' => ['a' => 'z']]);
        $runtime = $this->appController($responses)->createResponse($request, new SlimResponse(), ['slug' => $app['slug'], 'formId' => $this->formId]);
        self::assertSame(201, $runtime->getStatusCode(), (string) $runtime->getBody());

        self::assertSame([9, 9, 9, 9], $seen->getArrayCopy());
    }

    // ── two creations of one thing ────────────────────────────────────────────

    /** Waits for a worker that has an uncommitted row. @return array{0: resource, 1: array<int, resource>} */
    private function holdRow(string $mode, array $job): array
    {
        $worker = $this->start($mode, $job + ['userId' => $this->userId, 'holdMs' => 900]);
        self::assertSame("holding\n", fgets($worker[1][1]));
        return $worker;
    }

    /** @param array{0: resource, 1: array<int, resource>} $worker */
    private function finish(array $worker): void
    {
        [$process, $pipes] = $worker;
        fclose($pipes[1]);
        fclose($pipes[2]);
        self::assertSame(0, proc_close($process));
    }

    public function testAppsRacingForOneSlugBothGetCreated(): void
    {
        $slug = 'race-' . bin2hex(random_bytes(5));
        $held = 'held' . bin2hex(random_bytes(8));
        $this->appIds[] = $held;
        $worker = $this->holdRow('hold-app', ['id' => $held, 'slug' => $slug]);

        // It can't see the other's row, so the slug looks free until the key refuses it.
        $app = self::$apps->createApp(['name' => 'Second', 'slug' => $slug], $this->userId);

        $this->finish($worker);
        $this->appIds[] = (string) $app['id'];
        self::assertNotSame($slug, $app['slug']);
        self::assertStringStartsWith('second-', (string) $app['slug']);
    }

    public function testAFormIdLostInARaceIsTheFormTheSequentialPathWouldFind(): void
    {
        $id = 'race-' . bin2hex(random_bytes(5));
        $this->formIds[] = $id;
        $worker = $this->holdRow('hold-form', ['id' => $id]);

        $form = self::$forms->createForm(['id' => $id, 'userId' => $this->userId, 'title' => 'Mine', 'fields' => [
            ['id' => 'a', 'type' => 'short_text', 'label' => 'A', 'order' => 0, 'properties' => []],
        ]]);

        $this->finish($worker);
        self::assertSame($id, $form['id']);
        self::assertSame('Mine', $form['title'], 'it updates the form it found, as a second sync does');
        self::assertSame(['a'], array_column($form['fields'], 'id'));
    }

    public function testAFormIdLostToSomeoneElseIsPlainlyTaken(): void
    {
        $id = 'race-' . bin2hex(random_bytes(5));
        $this->formIds[] = $id;
        $worker = $this->holdRow('hold-form', ['id' => $id]);
        $stranger = 'u' . bin2hex(random_bytes(10));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")->execute([$stranger, $stranger . '@test.local']);

        try {
            self::$forms->createForm(['id' => $id, 'userId' => $stranger, 'title' => 'Theirs']);
            self::fail('Someone else has this id');
        } catch (\RuntimeException $e) {
            self::assertSame('A form with this ID already exists', $e->getMessage());
        } finally {
            $this->finish($worker);
            self::$pdo->prepare('DELETE FROM forms WHERE id = ?')->execute([$id]);
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$stranger]);
        }
    }

    // ── per-form migrations ───────────────────────────────────────────────────

    public function testAColumnAddedBetweenTheCheckAndTheAlterIsNotAnError(): void
    {
        $path = sys_get_temp_dir() . '/fl-oplog-' . bin2hex(random_bytes(5)) . '.sqlite';
        $db = new class ('sqlite:' . $path) extends PDO {
            /** Answers as a request that read the columns before the other's ALTER would. */
            public function query(string $statement, ?int $fetchMode = null, mixed ...$args): \PDOStatement|false
            {
                if ($statement === 'PRAGMA table_info(responses)') {
                    $this->exec("ALTER TABLE responses ADD COLUMN row_version INTEGER NOT NULL DEFAULT 1");
                    return parent::query("SELECT 'id' AS name");
                }
                return parent::query($statement, ...array_filter([$fetchMode]));
            }
        };
        $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $db->exec('CREATE TABLE responses (id TEXT PRIMARY KEY, answers TEXT)');

        (new \ReflectionClass(DataOperationLogService::class))->newInstanceWithoutConstructor()->ensureLogSchema($db);

        $names = (new PDO('sqlite:' . $path))->query("SELECT name FROM pragma_table_info('responses')")->fetchAll(PDO::FETCH_COLUMN);
        self::assertContains('row_version', $names);
        self::assertContains('trashed_at', $names, 'the run carried on after the column it found added');
        $db = null;
        @unlink($path);
    }

    public function testRequestsWaitForAFormsMigrationInsteadOfRunningTheirOwn(): void
    {
        $path = self::$sqlite->getFormDbPath($this->formId);
        $direct = new PDO('sqlite:' . $path);
        $direct->exec("UPDATE form_data SET value = '4' WHERE key = 'schema_version'");
        $direct = null;

        // As if another request were part way through migrating this form.
        $lock = fopen($path . '.migrate', 'c');
        self::assertTrue(flock($lock, LOCK_EX));

        $script = 'require ' . var_export(dirname(__DIR__, 2) . '/vendor/autoload.php', true) . ';'
            . '(new FormLogic\Database\SQLiteConnection(' . var_export(self::$sqlitePath, true) . '))->getFormDatabase(' . var_export($this->formId, true) . ');';
        $pipes = [];
        $process = proc_open([PHP_BINARY, '-d', 'xdebug.mode=off', '-r', $script], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        self::assertIsResource($process);

        usleep(900000);
        $version = static fn (): string => (string) (new PDO('sqlite:' . $path))->query("SELECT value FROM form_data WHERE key = 'schema_version'")->fetchColumn();
        self::assertTrue(proc_get_status($process)['running'], 'it waits');
        self::assertSame('4', $version());

        flock($lock, LOCK_UN);
        fclose($lock);
        $out = stream_get_contents($pipes[1]) . stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        self::assertSame(0, proc_close($process), $out);
        self::assertSame('5', $version(), 'the lock came free, and it did the migration itself');
        self::assertFileDoesNotExist($path . '.migrate');
    }
}

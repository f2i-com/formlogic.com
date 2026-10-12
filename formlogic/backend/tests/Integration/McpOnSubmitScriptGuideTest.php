<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\AppPublicController;
use FormLogic\Controllers\ExternalApiController;
use FormLogic\Controllers\McpController;
use FormLogic\Controllers\ResponseController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppDomainService;
use FormLogic\Services\AppReportService;
use FormLogic\Services\AppResponseService;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FormLogicRuntime;
use FormLogic\Services\FormService;
use FormLogic\Services\McpTokenService;
use FormLogic\Services\ResponseService;
use FormLogic\Services\SandboxRunner;
use FormLogic\Services\ScriptRejection;
use FormLogic\Services\WebhookService;
use FormLogic\Tests\Unit\McpOnSubmitGuideTextTest;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Factory\StreamFactory;
use Slim\Psr7\Response as SlimResponse;

/**
 * What the MCP server tells an AI about a form's onSubmit script is what that AI writes. The guide
 * once listed `ctx.setField`, `ctx.reject`, `ctx.setStatus` and `ctx.addTag`, none of which the
 * sandbox defines (they live under ctx.db, and a refusal is a return value): a script written from
 * it throws on its first such call, and from then on every submission to the form is refused.
 *
 * These tests run the guide's example in the sandbox (McpOnSubmitGuideTextTest holds every text
 * that describes the script to the guest's own ctx, with no sandbox) and pin who is told why a
 * broken script refuses a submission: the form's owner gets the script's error, the person
 * submitting does not.
 *
 * Runs the real launcher (skipped where it is not built) and a test database.
 */
class McpOnSubmitScriptGuideTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static SQLiteConnection $sqlite;
    private static FormService $forms;
    private static ResponseService $responses;
    private static McpTokenService $tokens;
    private static McpController $mcp;
    private static ResponseController $public;
    private static ExternalApiController $external;
    private static AppService $apps;

    private string $userId = '';
    private string $formId = '';

    public static function setUpBeforeClass(): void
    {
        if (!(new SandboxRunner())->isAvailable()) {
            self::markTestSkipped('FormLogic script runtime unavailable');
        }
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) {
            \Dotenv\Dotenv::createImmutable($root)->safeLoad();
        }
        try {
            $conn = new MySQLConnection([
                'host' => $_ENV['DB_HOST'] ?? '127.0.0.1',
                'port' => $_ENV['DB_PORT'] ?? '3306',
                'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
                'username' => $_ENV['DB_USERNAME'] ?? 'root',
                'password' => $_ENV['DB_PASSWORD'] ?? '',
                'charset' => 'utf8mb4',
                'collation' => 'utf8mb4_unicode_ci',
            ]);
            $conn->getConnection()->query('SELECT 1');
            $conn->initializeSchema();
            $conn->runMigrations();
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
        self::$mysql = $conn;
        self::$pdo = $conn->getConnection();
        self::$sqlite = new SQLiteConnection(sys_get_temp_dir() . '/fl-onsubmit-guide-' . bin2hex(random_bytes(5)));
        self::$forms = new FormService($conn, self::$sqlite);
        self::$responses = new ResponseService($conn, self::$sqlite, new FormLogicRuntime());
        $apps = self::$apps = new AppService($conn, self::$forms);
        self::$tokens = new McpTokenService($conn);
        self::$mcp = new McpController(self::$tokens, self::$forms, $apps, self::$responses, null, null, new AppReportService($apps, self::$forms));
        self::$public = new ResponseController(self::$responses, self::$forms, self::$sqlite, null, null, null, $apps, $conn);
        self::$external = new ExternalApiController(self::$forms, self::$responses, new WebhookService($conn));
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->userId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan, cloud_until) VALUES (?, ?, 'x', 'T', 'personal', DATE_ADD(NOW(), INTERVAL 30 DAY))")
            ->execute([$this->userId, $this->userId . '@test.local']);
        $form = self::$forms->createForm([
            'title' => 'Expenses', 'userId' => $this->userId, 'status' => 'published',
            'fields' => [
                ['id' => 'amount', 'type' => 'number', 'label' => 'Amount', 'required' => false],
                ['id' => 'note', 'type' => 'short_text', 'label' => 'Note', 'required' => false],
            ],
        ]);
        $this->formId = (string) $form['id'];
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null || $this->userId === '') {
            return;
        }
        self::$pdo->prepare('DELETE FROM mcp_sessions WHERE user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM response_metadata WHERE form_id = ?')->execute([$this->formId]);
        self::$pdo->prepare('DELETE FROM forms WHERE user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
    }

    // ── harness ──────────────────────────────────────────────────────────────

    private function token(): string
    {
        return self::$tokens->create($this->userId, null, 3600, 900, McpTokenService::ALL_SCOPES)['token'];
    }

    private function rpc(string $token, array $payload): array
    {
        $req = (new ServerRequestFactory())->createServerRequest('POST', '/api/mcp')
            ->withHeader('Authorization', 'Bearer ' . $token)
            ->withBody((new StreamFactory())->createStream(json_encode($payload)));
        $resp = self::$mcp->handle($req, (new ResponseFactory())->createResponse());
        $resp->getBody()->rewind();
        return json_decode((string) $resp->getBody(), true) ?: [];
    }

    /** @return array{isError:bool, data:mixed, text:string} */
    private function tool(string $token, string $name, array $args = []): array
    {
        $r = $this->rpc($token, ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'tools/call', 'params' => ['name' => $name, 'arguments' => $args]]);
        $txt = $r['result']['content'][0]['text'] ?? '';
        return ['isError' => $r['result']['isError'] ?? false, 'data' => json_decode($txt, true), 'text' => $txt];
    }

    /** @return array{status:int, body:array<string, mixed>} */
    private static function outcome(ResponseInterface $response): array
    {
        $response->getBody()->rewind();
        return ['status' => $response->getStatusCode(), 'body' => (array) json_decode((string) $response->getBody(), true)];
    }

    private function guide(): string
    {
        $r = $this->tool($this->token(), 'get_started');
        $this->assertFalse($r['isError'], $r['text']);
        return $r['text'];
    }

    // ── the defect, as an AI client meets it ─────────────────────────────────

    /**
     * The script the old guide described, attached over MCP, refuses every submission: the
     * sandbox has no ctx.setField. This is the harm the guide caused.
     */
    public function testAScriptWrittenFromTheOldGuideRefusesEverySubmission(): void
    {
        $tok = $this->token();
        $set = $this->tool($tok, 'update_form', ['formId' => $this->formId, 'logicScript' => 'function onSubmit(ctx) { ctx.setField("doubled", ctx.answers.amount * 2); }']);
        $this->assertFalse($set['isError'], $set['text']);

        $add = $this->tool($tok, 'add_response', ['formId' => $this->formId, 'answers' => ['amount' => 3]]);
        $this->assertTrue($add['isError'], 'the record is refused');
        $this->assertSame(0, (int) self::$sqlite->getFormDatabase($this->formId)->query('SELECT COUNT(*) FROM responses')->fetchColumn());
    }

    // ── the guide's example, run (its text is checked by McpOnSubmitGuideTextTest) ──

    /** The guide's own example is a working script: it stores, tags, sets the status, and refuses. */
    public function testTheGuideExampleRunsInTheSandbox(): void
    {
        $section = McpOnSubmitGuideTextTest::onSubmitSection($this->guide());
        $this->assertSame(1, preg_match('/^function onSubmit\(ctx\) \{\n.*?^\}$/ms', $section, $m), 'the section carries an example script');
        $script = $m[0];

        $tok = $this->token();
        $set = $this->tool($tok, 'update_form', ['formId' => $this->formId, 'logicScript' => $script]);
        $this->assertFalse($set['isError'], $set['text']);

        $refused = $this->tool($tok, 'add_response', ['formId' => $this->formId, 'answers' => ['amount' => 0]]);
        $this->assertTrue($refused['isError']);
        $this->assertStringContainsString('above zero', $refused['text'], 'the example refuses with its own message');

        $added = $this->tool($tok, 'add_response', ['formId' => $this->formId, 'answers' => ['amount' => 600]]);
        $this->assertFalse($added['isError'], $added['text']);
        $id = (string) ($added['data']['id'] ?? '');
        $db = self::$sqlite->getFormDatabase($this->formId);
        $computed = $db->prepare('SELECT field_name, field_value FROM computed WHERE response_id = ?');
        $computed->execute([$id]);
        $this->assertSame(['amount_with_tax' => '660'], $computed->fetchAll(PDO::FETCH_KEY_PAIR));
        $tags = $db->prepare('SELECT tag FROM tags WHERE response_id = ?');
        $tags->execute([$id]);
        $this->assertSame(['large'], $tags->fetchAll(PDO::FETCH_COLUMN));
        $this->assertSame('reviewed', $db->query("SELECT status FROM responses WHERE id = " . $db->quote($id))->fetchColumn());
    }

    /** The Expense sample's script called a top-level ctx.addTag: every expense over 500 was refused. */
    public function testTheExpenseSampleStoresALargeExpense(): void
    {
        $expense = json_decode((string) file_get_contents(dirname(__DIR__, 2) . '/resources/sample-apps/expense.json'), true);
        $script = (string) ($expense['forms'][0]['logicScript'] ?? '');
        $result = self::$responses->createResponse($this->formId, ['answers' => ['amount' => 600]], $script);
        $this->assertIsArray($result, 'a large expense is stored: ' . ($result instanceof ScriptRejection ? (string) $result->detail : ''));
        $tags = self::$sqlite->getFormDatabase($this->formId)->prepare('SELECT tag FROM tags WHERE response_id = ?');
        $tags->execute([$result['id']]);
        $this->assertSame(['high-value'], $tags->fetchAll(PDO::FETCH_COLUMN));
    }

    // ── who is told why ──────────────────────────────────────────────────────

    public function testTheOwnerIsToldWhyAndThePersonSubmittingIsNot(): void
    {
        self::$forms->updateForm($this->formId, ['logicScript' => 'function onSubmit(ctx) { ctx.setField("doubled", 1); }']);

        // Anyone submitting the public form: refused, nothing stored, and not shown the script's
        // internals or told that trying again will help.
        $anon = self::outcome(self::$public->create(
            (new ServerRequestFactory())->createServerRequest('POST', 'http://api.test/api/forms/x/responses')->withParsedBody(['answers' => ['amount' => 1]]),
            new SlimResponse(),
            ['formId' => $this->formId]
        ));
        $this->assertSame(503, $anon['status'], json_encode($anon['body']));
        $this->assertSame(ScriptRejection::CODE_UNAVAILABLE, $anon['body']['code'] ?? null);
        $this->assertStringNotContainsString('setField', (string) ($anon['body']['message'] ?? ''));
        $this->assertStringNotContainsString('try again', strtolower((string) ($anon['body']['message'] ?? '')));
        $this->assertArrayNotHasKey('detail', $anon['body']);

        // The owner testing their own public link sees the reason.
        $owner = self::outcome(self::$public->create(
            (new ServerRequestFactory())->createServerRequest('POST', 'http://api.test/api/forms/x/responses')
                ->withParsedBody(['answers' => ['amount' => 1]])->withAttribute('userId', $this->userId),
            new SlimResponse(),
            ['formId' => $this->formId]
        ));
        $this->assertSame(503, $owner['status']);
        $this->assertStringContainsString('setField', (string) ($owner['body']['detail'] ?? ''), json_encode($owner['body']));

        // The owner's own API key and the owner's AI are told too.
        $api = self::outcome(self::$external->submitResponse(
            (new ServerRequestFactory())->createServerRequest('POST', 'http://api.test/api/v1/forms/x/responses')
                ->withParsedBody(['answers' => ['amount' => 1]])->withAttribute('userId', $this->userId),
            new SlimResponse(),
            ['formId' => $this->formId]
        ));
        $this->assertSame(503, $api['status']);
        $this->assertStringContainsString('setField', (string) ($api['body']['detail'] ?? ''), json_encode($api['body']));

        $mcp = $this->tool($this->token(), 'add_response', ['formId' => $this->formId, 'answers' => ['amount' => 1]]);
        $this->assertTrue($mcp['isError']);
        $this->assertStringContainsString('setField', $mcp['text']);
        $this->assertStringContainsString('logicScript', $mcp['text'], 'and what to fix');

        $this->assertSame(0, (int) self::$sqlite->getFormDatabase($this->formId)->query('SELECT COUNT(*) FROM responses')->fetchColumn());
    }

    /**
     * In an app the form is not on the public link, so the app runtime is where its owner tries
     * it: the owner is told why, a member submitting is not.
     */
    public function testInTheAppRuntimeTheOwnerIsToldWhyAndAMemberIsNot(): void
    {
        self::$forms->updateForm($this->formId, ['logicScript' => 'function onSubmit(ctx) { ctx.setField("doubled", 1); }']);
        $member = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'M')")->execute([$member, $member . '@test.local']);
        $appId = 'app-' . bin2hex(random_bytes(10));
        $slug = 'osg' . bin2hex(random_bytes(6));
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status) VALUES (?, ?, 'T', ?, 'published')")->execute([$appId, $this->userId, $slug]);
        self::$pdo->prepare("INSERT INTO app_forms (id, app_id, form_id, display_name, sort_order, is_visible, settings) VALUES (?, ?, ?, 'T', 0, 1, '{}')")
            ->execute(['af-' . bin2hex(random_bytes(10)), $appId, $this->formId]);
        $roles = [];
        foreach (['Owner' => $this->userId, 'Member' => $member] as $name => $uid) {
            $roles[$name] = 'role-' . bin2hex(random_bytes(10));
            self::$pdo->prepare('INSERT INTO app_roles (id, app_id, name, is_system, sort_order) VALUES (?, ?, ?, 1, 0)')->execute([$roles[$name], $appId, $name]);
            self::$pdo->prepare("INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at) VALUES (?, ?, ?, ?, 'active', NOW())")
                ->execute(['au-' . bin2hex(random_bytes(10)), $appId, $uid, $roles[$name]]);
        }
        self::$pdo->prepare('INSERT INTO app_role_permissions (id, role_id, form_id, permission) VALUES (?, ?, ?, ?)')
            ->execute(['arp-' . bin2hex(random_bytes(10)), $roles['Member'], $this->formId, \FormLogic\Constants\AppPermissions::SUBMIT_RESPONSES]);
        $runtime = new AppPublicController(
            self::$apps,
            new AppUserService(self::$mysql),
            new AppResponseService(self::$mysql, self::$sqlite, self::$responses, null, self::$forms),
            self::$forms,
            self::$responses,
            self::$mysql,
            self::$sqlite,
            new AppDomainService(self::$mysql)
        );
        $submitAs = fn (string $uid): array => self::outcome($runtime->createResponse(
            (new ServerRequestFactory())->createServerRequest('POST', 'http://api.test/api/app/x/forms/y/responses')
                ->withParsedBody(['answers' => ['amount' => 1]])->withAttribute('userId', $uid),
            new SlimResponse(),
            ['slug' => $slug, 'formId' => $this->formId]
        ));

        try {
            $asMember = $submitAs($member);
            $this->assertSame(503, $asMember['status'], json_encode($asMember['body']));
            $this->assertArrayNotHasKey('detail', $asMember['body']);
            $this->assertStringNotContainsString('setField', (string) ($asMember['body']['message'] ?? ''));

            $asOwner = $submitAs($this->userId);
            $this->assertSame(503, $asOwner['status']);
            $this->assertStringContainsString('setField', (string) ($asOwner['body']['detail'] ?? ''), json_encode($asOwner['body']));
        } finally {
            self::$pdo->prepare('DELETE FROM app_submission_idempotency WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?)')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_forms WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$member]);
        }
    }

    public function testTheReasonIsNotPrefixedTwice(): void
    {
        $result = self::$responses->createResponse($this->formId, ['answers' => ['amount' => 1]], 'function onSubmit(ctx) { throw new Error("boom"); }');
        $this->assertInstanceOf(ScriptRejection::class, $result);
        $this->assertSame(1, substr_count((string) $result->detail, 'Script execution error'), (string) $result->detail);
        $this->assertStringContainsString('boom', (string) $result->detail);
    }

    /** A script that never ran to a verdict (the engine stopped it) still says a retry may work. */
    public function testAScriptTheEngineStoppedStillAsksForARetry(): void
    {
        $result = self::$responses->createResponse($this->formId, ['answers' => ['amount' => 1]], 'function onSubmit(ctx) { while (true) {} }');
        $this->assertInstanceOf(ScriptRejection::class, $result);
        $this->assertSame(503, $result->status);
        $this->assertStringContainsString('try again', strtolower($result->message));
    }
}

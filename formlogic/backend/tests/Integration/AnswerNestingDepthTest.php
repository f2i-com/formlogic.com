<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\AppPublicController;
use FormLogic\Controllers\ResponseController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppDomainService;
use FormLogic\Services\AppResponseService;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FormService;
use FormLogic\Services\ResponseService;
use FormLogic\Services\SandboxRunner;
use FormLogic\Services\ScriptRejection;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response as SlimResponse;

/**
 * A form's conditional rules and calculated fields are evaluated in the sandbox, in one batch,
 * over the submitted answers. The sandbox refuses a job whose JSON nests too deep, and it
 * refuses the whole batch; the callers then treat every rule as "could not be evaluated", which
 * for a required-if rule means not required. An answer's VALUE was never looked at (only its
 * field id), and a location, a signature or a file item may carry any extra keys, so one answer
 * nested deep enough switched a form's server-side conditional validation off for whoever sent
 * it, and dropped its calculated fields.
 *
 * No field type stores anything deeper than a list of objects of plain values (a file upload:
 * [{id, storedFilename, ...}], two levels; a location is one object, one level), nor more than
 * a few hundred values. An answer nested deeper than ResponseService::MAX_ANSWER_DEPTH, or
 * holding more than MAX_ANSWER_VALUES values (width exhausts the sandbox's memory as depth
 * exhausts its parser), is not an answer: it is refused by name and never handed to the
 * sandbox, on every path that takes answers.
 *
 * Runs the real launcher (skipped where it is not built) and a test database.
 */
class AnswerNestingDepthTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static SQLiteConnection $sqlite;
    private static FormService $forms;
    private static ResponseService $responses;
    private static AppService $apps;
    private static ResponseController $public;
    private static AppPublicController $runtime;

    /** @var string[] */ private array $userIds = [];
    /** @var string[] */ private array $formIds = [];
    /** @var string[] */ private array $appIds = [];

    public static function setUpBeforeClass(): void
    {
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
        self::$sqlite = new SQLiteConnection(sys_get_temp_dir() . '/fl-answerdepth-' . bin2hex(random_bytes(5)));
        self::$forms = new FormService($conn, self::$sqlite);
        self::$responses = new ResponseService($conn, self::$sqlite);
        self::$apps = new AppService($conn, self::$forms);
        $appUsers = new AppUserService($conn);
        self::$public = new ResponseController(self::$responses, self::$forms, self::$sqlite, null, null, null, self::$apps, $conn);
        self::$runtime = new AppPublicController(
            self::$apps,
            $appUsers,
            new AppResponseService($conn, self::$sqlite, self::$responses, null, self::$forms),
            self::$forms,
            self::$responses,
            $conn,
            self::$sqlite,
            new AppDomainService($conn)
        );
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        if (!(new SandboxRunner())->isAvailable()) {
            $this->markTestSkipped('The sandbox launcher is not built here');
        }
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        foreach ($this->appIds as $appId) {
            self::$pdo->prepare('DELETE FROM app_submission_idempotency WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_forms WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?)')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$appId]);
        }
        foreach ($this->formIds as $formId) {
            self::$pdo->prepare('DELETE FROM response_metadata WHERE form_id = ?')->execute([$formId]);
            self::$pdo->prepare('DELETE FROM forms WHERE id = ?')->execute([$formId]);
        }
        foreach ($this->userIds as $userId) {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$userId]);
        }
    }

    // ── fixtures ─────────────────────────────────────────────────────────────

    /** $levels lists, one inside the other, around a plain value. */
    private static function nested(int $levels): mixed
    {
        $value = 'leaf';
        for ($i = 0; $i < $levels; $i++) {
            $value = [$value];
        }
        return $value;
    }

    /** A valid location that carries one more key, nested $levels deep in all. */
    private static function location(int $levels): array
    {
        // The location is level one; the value under `pad` supplies the rest.
        return ['latitude' => 1.5, 'longitude' => 2.5, 'pad' => self::nested($levels - 1)];
    }

    private function makeUser(): string
    {
        $id = 'u' . bin2hex(random_bytes(10));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$id, $id . '@test.local']);
        $this->userIds[] = $id;
        return $id;
    }

    /**
     * "Details" is required when Kind is "other"; "Total" is Qty doubled; "Where" is a location,
     * one of the types whose value may carry keys nobody checks.
     *
     * @return array<string, mixed> the form
     */
    private function makeForm(string $ownerId): array
    {
        $form = self::$forms->createForm([
            'title' => 'Depth ' . bin2hex(random_bytes(3)),
            'userId' => $ownerId,
            'status' => 'published',
            'fields' => [
                ['id' => 'kind', 'type' => 'short_text', 'label' => 'Kind', 'required' => false],
                ['id' => 'details', 'type' => 'short_text', 'label' => 'Details', 'required' => false,
                    'conditionalLogic' => ['action' => 'require', 'expression' => "kind == 'other'"]],
                ['id' => 'qty', 'type' => 'number', 'label' => 'Qty', 'required' => false],
                ['id' => 'total', 'type' => 'calculated', 'label' => 'Total', 'properties' => ['calculationExpression' => 'qty * 2']],
                ['id' => 'where', 'type' => 'location', 'label' => 'Where', 'required' => false],
                ['id' => 'files', 'type' => 'file_upload', 'label' => 'Files', 'required' => false],
            ],
        ]);
        $this->formIds[] = (string) $form['id'];
        return $form;
    }

    /** A published app over the form, with $ownerId its owner. @return array{id:string, slug:string} */
    private function makeApp(string $ownerId, string $formId): array
    {
        $id = 'app' . bin2hex(random_bytes(10));
        $slug = 'dep' . bin2hex(random_bytes(6));
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status) VALUES (?, ?, 'T', ?, 'published')")->execute([$id, $ownerId, $slug]);
        $this->appIds[] = $id;
        self::$pdo->prepare("INSERT INTO app_forms (id, app_id, form_id, display_name, sort_order, is_visible, settings) VALUES (?, ?, ?, 'T', 0, 1, '{}')")
            ->execute(['af' . bin2hex(random_bytes(10)), $id, $formId]);
        $role = 'role' . bin2hex(random_bytes(10));
        self::$pdo->prepare("INSERT INTO app_roles (id, app_id, name, is_system, sort_order) VALUES (?, ?, 'Owner', 1, 0)")->execute([$role, $id]);
        self::$pdo->prepare("INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at) VALUES (?, ?, ?, ?, 'active', NOW())")
            ->execute(['au' . bin2hex(random_bytes(10)), $id, $ownerId, $role]);
        return ['id' => $id, 'slug' => $slug];
    }

    private function request(string $method, array $body, ?string $userId = null): ServerRequestInterface
    {
        $request = (new ServerRequestFactory())->createServerRequest($method, 'http://api.test/api/x')->withParsedBody($body);
        return $userId !== null ? $request->withAttribute('userId', $userId) : $request;
    }

    /** @return array{status:int, body:array<string, mixed>} */
    private function outcome(ResponseInterface $response): array
    {
        $response->getBody()->rewind();
        return ['status' => $response->getStatusCode(), 'body' => (array) json_decode((string) $response->getBody(), true)];
    }

    /** @return list<array<string, mixed>> the stored answers of every record of the form */
    private function stored(string $formId): array
    {
        return array_map(
            static fn (string $json): array => (array) json_decode($json, true),
            self::$sqlite->getFormDatabase($formId)->query('SELECT answers FROM responses')->fetchAll(PDO::FETCH_COLUMN)
        );
    }

    /** @return array{status:int, body:array<string, mixed>} */
    private function submitPublicly(string $formId, array $answers): array
    {
        return $this->outcome(self::$public->create($this->request('POST', ['answers' => $answers]), new SlimResponse(), ['formId' => $formId]));
    }

    // ── the public form ──────────────────────────────────────────────────────

    public function testTheRulesHoldForAnOrdinarySubmission(): void
    {
        $form = $this->makeForm($this->makeUser());
        $formId = (string) $form['id'];

        $missing = $this->submitPublicly($formId, ['kind' => 'other', 'qty' => 3]);
        $this->assertSame(400, $missing['status']);
        $this->assertArrayHasKey('details', $missing['body']['errors'] ?? []);

        // The deepest shape a field stores (a file upload's list of objects is two levels;
        // this location is two as well) is far inside the limit.
        $ok = $this->submitPublicly($formId, ['kind' => 'other', 'details' => 'because', 'qty' => 3, 'where' => self::location(2)]);
        $this->assertSame(201, $ok['status'], json_encode($ok['body']));
        $this->assertSame(6, $this->stored($formId)[0]['total'] ?? null, 'the calculated field is computed on the server');
    }

    public function testADeeplyNestedAnswerDoesNotSwitchTheRulesOff(): void
    {
        $form = $this->makeForm($this->makeUser());
        $formId = (string) $form['id'];
        $deep = self::location(130);

        // "Details" is required because Kind is "other", and is not sent.
        $skipped = $this->submitPublicly($formId, ['kind' => 'other', 'qty' => 3, 'where' => $deep]);
        $this->assertNotSame(201, $skipped['status'], 'the submission that skips the required-if field must not be accepted');
        $this->assertSame([], $this->stored($formId), 'and nothing is stored');
        $this->assertArrayHasKey('details', $skipped['body']['errors'] ?? [], 'the rule is still evaluated: the deep answer is kept from the sandbox');

        // With the rule met, the answer itself is what is refused, by name.
        $refused = $this->submitPublicly($formId, ['kind' => 'other', 'details' => 'because', 'qty' => 3, 'where' => $deep]);
        $this->assertSame(422, $refused['status'], json_encode($refused['body']));
        $this->assertSame('answer_too_deep', $refused['body']['code'] ?? null);
        $this->assertStringContainsString('where', (string) ($refused['body']['message'] ?? ''));
        $this->assertSame([], $this->stored($formId));
    }

    /**
     * Depth is one way to make the sandbox refuse a batch; width is another. 650,000 empty
     * lists in one answer are 1.95 MB of JSON, inside the 2 MB answer cap, and the sandbox runs
     * out of its memory budget parsing them ("script exceeded its memory budget"), for the whole
     * batch again. No field stores more than a few hundred values (the options ticked, the
     * files attached, the records linked), so an answer of more than
     * ResponseService::MAX_ANSWER_VALUES is refused and withheld the same way.
     */
    public function testAVeryWideAnswerDoesNotSwitchTheRulesOffEither(): void
    {
        $form = $this->makeForm($this->makeUser());
        $formId = (string) $form['id'];
        $wide = ['latitude' => 1.5, 'longitude' => 2.5, 'pad' => array_fill(0, 650000, [])];
        $this->assertLessThan(ResponseService::MAX_ANSWER_BYTES, strlen((string) json_encode(['kind' => 'other', 'details' => 'because', 'qty' => 3, 'where' => $wide])));

        $skipped = $this->submitPublicly($formId, ['kind' => 'other', 'qty' => 3, 'where' => $wide]);
        $this->assertNotSame(201, $skipped['status'], 'the submission that skips the required-if field must not be accepted');
        $this->assertSame([], $this->stored($formId));
        $this->assertArrayHasKey('details', $skipped['body']['errors'] ?? [], 'the rule is still evaluated');

        $refused = $this->submitPublicly($formId, ['kind' => 'other', 'details' => 'because', 'qty' => 3, 'where' => $wide]);
        $this->assertSame(422, $refused['status'], json_encode($refused['body']));
        $this->assertSame('answer_too_many_values', $refused['body']['code'] ?? null);
        $this->assertStringContainsString('where', (string) ($refused['body']['message'] ?? ''));
        $this->assertSame([], $this->stored($formId));

        // The count is of everything the answer holds, plain values and lists alike.
        $max = ResponseService::MAX_ANSWER_VALUES;
        $fields = [['id' => 'tags', 'type' => 'checkboxes', 'label' => 'Tags']];
        $this->assertSame([], self::$responses->answerShapeErrors($fields, ['tags' => array_fill(0, $max, 'x')]), 'exactly the limit is allowed');
        $tooMany = self::$responses->answerShapeErrors($fields, ['tags' => array_fill(0, $max + 1, 'x')]);
        $this->assertStringContainsString('Tags', $tooMany['tags'] ?? '');
        $this->assertGreaterThanOrEqual(5000, $max, 'far more than a field stores');
    }

    // ── the limit itself ─────────────────────────────────────────────────────

    public function testTheLimitIsCountedInLevelsOfListsAndObjects(): void
    {
        $max = ResponseService::MAX_ANSWER_DEPTH;
        $fields = [['id' => 'where', 'type' => 'location', 'label' => 'Where'], ['id' => 'name', 'type' => 'short_text', 'label' => 'Name']];

        $this->assertSame([], self::$responses->answerShapeErrors($fields, ['name' => 'plain', 'where' => self::location(2)]));
        $this->assertSame([], self::$responses->answerShapeErrors($fields, ['where' => self::location($max)]), 'exactly the limit is allowed');
        $errors = self::$responses->answerShapeErrors($fields, ['name' => 'plain', 'where' => self::location($max + 1)]);
        $this->assertSame(['where'], array_keys($errors));
        $this->assertStringContainsString('Where', $errors['where'], 'the message names the field by its label');

        // A file upload as it is stored: a list of objects of plain values, two levels.
        $files = [['id' => 'f1', 'storedFilename' => 'a.pdf', 'originalFilename' => 'a.pdf', 'mimeType' => 'application/pdf', 'size' => 10, 'url' => '/api/files/x/f1/a.pdf']];
        $this->assertSame([], self::$responses->answerShapeErrors([['id' => 'files', 'type' => 'file_upload', 'label' => 'Files']], ['files' => $files]));
        $this->assertGreaterThanOrEqual(8, $max, 'several times what any field stores');
        $this->assertLessThan(60, $max, 'and far below what the sandbox will parse (63 levels with the launcher of ZIPP v0.0.22)');
    }

    /**
     * The check runs on every submission, on the public path too, so measuring an answer must
     * cost nothing the answer does not already cost: 600,000 empty lists are about 1.8 MB of
     * JSON, inside the body limit, and a walk that queued an entry per list held over 100 MB
     * for them, past PHP's default memory limit.
     */
    public function testMeasuringAWideAnswerAllocatesNothingPerItem(): void
    {
        $wide = ['where' => ['latitude' => 1, 'longitude' => 2, 'pad' => array_fill(0, 600000, [])]];
        $this->assertLessThan(2_000_000, strlen((string) json_encode($wide)), 'a body the server accepts');

        memory_reset_peak_usage();
        $before = memory_get_usage();
        $errors = self::$responses->answerShapeErrors([], $wide);
        $held = memory_get_peak_usage() - $before;

        $this->assertSame(['where'], array_keys($errors), 'refused for its width');
        $this->assertLessThan(1024 * 1024, $held, 'measuring the answer held ' . round($held / 1048576, 1) . ' MB');
    }

    // ── the service every path goes through ──────────────────────────────────

    public function testTheSharedValidationNamesTheFieldAndStillAppliesTheRules(): void
    {
        $form = $this->makeForm($this->makeUser());
        $fields = $form['fields'];
        $answers = ['kind' => 'other', 'qty' => 3, 'where' => self::location(130)];

        // External API, MCP and CSV import validate with this.
        $errors = self::$responses->validateSubmittedAnswers($fields, $answers);
        $this->assertArrayHasKey('where', $errors);
        $this->assertStringContainsString('nested', $errors['where']);
        $this->assertArrayHasKey('details', $errors, 'the required-if rule is evaluated over the other answers');

        // The two evaluations themselves: the deep answer is withheld, the rest is evaluated.
        $this->assertTrue(self::$responses->computeFieldVisibility($fields, $answers)['details']['required']);
        $this->assertSame(6, self::$responses->applyCalculatedFields($fields, $answers)['total'] ?? null);
    }

    public function testNothingStoresADeeplyNestedAnswerAsANewRecord(): void
    {
        $form = $this->makeForm($this->makeUser());
        $formId = (string) $form['id'];

        // Whatever path leads here (public form, API, MCP, a flow), this is where a record is made.
        $result = self::$responses->createResponse($formId, ['answers' => ['kind' => 'x', 'where' => self::location(130)]]);
        $this->assertInstanceOf(ScriptRejection::class, $result);
        $this->assertSame(422, $result->status);
        $this->assertSame('answer_too_deep', $result->code);
        $this->assertStringContainsString('where', $result->message);
        $this->assertSame([], $this->stored($formId));
    }

    // ── the app runtime: submit, offline batch, record edit ──────────────────

    public function testTheAppRuntimeRefusesTheAnswerBeforeEvaluatingAnything(): void
    {
        $owner = $this->makeUser();
        $form = $this->makeForm($owner);
        $formId = (string) $form['id'];
        $app = $this->makeApp($owner, $formId);
        $deep = self::location(130);

        // Submit: refused for the nested answer, although the required-if field is missing too.
        $submit = $this->outcome(self::$runtime->createResponse(
            $this->request('POST', ['answers' => ['kind' => 'other', 'qty' => 3, 'where' => $deep]], $owner),
            new SlimResponse(),
            ['slug' => $app['slug'], 'formId' => $formId]
        ));
        $this->assertSame(422, $submit['status'], json_encode($submit['body']));
        $this->assertSame('answer_too_deep', $submit['body']['code'] ?? null);
        $this->assertSame(['where'], array_keys($submit['body']['errors'] ?? []));
        $this->assertStringContainsString('Where', $submit['body']['errors']['where']);
        $this->assertSame([], $this->stored($formId));

        // Offline batch: the item is refused the same way; its neighbour is stored.
        $batch = $this->outcome(self::$runtime->syncBatch(
            $this->request('POST', ['items' => [
                ['formId' => $formId, 'answers' => ['kind' => 'other', 'qty' => 3, 'where' => $deep], 'idempotencyKey' => 'k-' . bin2hex(random_bytes(6))],
                ['formId' => $formId, 'answers' => ['kind' => 'plain', 'qty' => 4], 'idempotencyKey' => 'k-' . bin2hex(random_bytes(6))],
            ]], $owner),
            new SlimResponse(),
            ['slug' => $app['slug']]
        ));
        $this->assertSame(200, $batch['status'], json_encode($batch['body']));
        $statuses = array_column($batch['body']['results'] ?? [], 'status');
        $this->assertSame([422, 201], $statuses, json_encode($batch['body']));
        $stored = $this->stored($formId);
        $this->assertCount(1, $stored);
        $this->assertSame(8, $stored[0]['total'] ?? null);

        // Record edit: the nested answer in the change is refused, the record stays as it was.
        $recordId = (string) self::$sqlite->getFormDatabase($formId)->query('SELECT id FROM responses')->fetchColumn();
        $edit = $this->outcome(self::$runtime->updateResponseById(
            $this->request('PUT', ['answers' => ['kind' => 'other', 'where' => $deep]], $owner),
            new SlimResponse(),
            ['slug' => $app['slug'], 'formId' => $formId, 'id' => $recordId]
        ));
        $this->assertSame(422, $edit['status'], json_encode($edit['body']));
        $this->assertSame(['where'], array_keys($edit['body']['errors'] ?? []));
        $this->assertSame('plain', $this->stored($formId)[0]['kind'] ?? null);

        // An edit that is in order still has its rules applied: Kind "other" needs Details.
        $ruled = $this->outcome(self::$runtime->updateResponseById(
            $this->request('PUT', ['answers' => ['kind' => 'other']], $owner),
            new SlimResponse(),
            ['slug' => $app['slug'], 'formId' => $formId, 'id' => $recordId]
        ));
        $this->assertSame(400, $ruled['status']);
        $this->assertArrayHasKey('details', $ruled['body']['errors'] ?? []);
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\ExternalApiController;
use FormLogic\Controllers\ResponseController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\FormService;
use FormLogic\Services\ResponseService;
use FormLogic\Services\WebhookService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Response as SlimResponse;

/**
 * A 'custom' validation rule (an expression in rule.expression) is not checked on any write path,
 * as no screen a form is filled in checks one (the public form and the app runtime skip it, and
 * the builder marks a saved one "not checked"). This pins that decision: the server agrees with
 * what the person filling the form sees. The other builder rules still apply beside it.
 * Skipped without a test database.
 */
class CustomValidationRuleTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static SQLiteConnection $sqlite;
    private static FormService $forms;
    private static ResponseService $responses;

    /** @var string[] */ private array $userIds = [];
    /** @var string[] */ private array $formIds = [];

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
        self::$sqlite = new SQLiteConnection(sys_get_temp_dir() . '/fl-customrule-' . bin2hex(random_bytes(5)));
        self::$forms = new FormService($conn, self::$sqlite);
        self::$responses = new ResponseService($conn, self::$sqlite);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        foreach ($this->formIds as $fid) {
            self::$pdo->prepare('DELETE FROM response_metadata WHERE form_id = ?')->execute([$fid]);
            self::$pdo->prepare('DELETE FROM forms WHERE id = ?')->execute([$fid]);
        }
        foreach ($this->userIds as $uid) {
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
        }
    }

    /** A field with a custom rule that would refuse every answer, beside a minLength rule. */
    private function field(): array
    {
        return [
            'id' => 'code', 'type' => 'short_text', 'label' => 'Code', 'required' => false, 'order' => 0, 'properties' => [],
            'validation' => [
                ['id' => 'c1', 'type' => 'custom', 'message' => 'Refused by the custom rule', 'expression' => '"Refused by the custom rule"'],
                ['id' => 'm1', 'type' => 'minLength', 'value' => 3, 'message' => 'At least 3'],
            ],
        ];
    }

    private function makeForm(): array
    {
        $owner = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$owner, $owner . '@test.local']);
        $this->userIds[] = $owner;
        $form = self::$forms->createForm(['userId' => $owner, 'title' => 'Codes', 'status' => 'published', 'fields' => [$this->field()]]);
        $this->formIds[] = (string) $form['id'];
        return [$owner, (string) $form['id']];
    }

    private function request(?string $userId, array $body): ServerRequestInterface
    {
        $req = $this->createMock(ServerRequestInterface::class);
        $req->method('getAttribute')->willReturnCallback(fn ($n) => $n === 'userId' ? $userId : null);
        $req->method('getParsedBody')->willReturn($body);
        return $req;
    }

    public function testTheSharedRuleCheckLeavesACustomRuleAlone(): void
    {
        $this->assertNull(self::$responses->validateFieldRules($this->field(), 'abc'));
        $this->assertSame('At least 3', self::$responses->validateFieldRules($this->field(), 'ab'));
        $this->assertSame([], self::$responses->validateSubmittedAnswers([$this->field()], ['code' => 'abc']));
    }

    public function testThePublicFormAndTheExternalApiStoreAnAnswerACustomRuleWouldRefuse(): void
    {
        [$owner, $formId] = $this->makeForm();

        $public = (new ResponseController(self::$responses, self::$forms, self::$sqlite))
            ->create($this->request(null, ['answers' => ['code' => 'abc']]), new SlimResponse(), ['formId' => $formId]);
        $this->assertSame(201, $public->getStatusCode(), (string) $public->getBody());

        $api = (new ExternalApiController(self::$forms, self::$responses, new WebhookService(self::$mysql)))
            ->submitResponse($this->request($owner, ['answers' => ['code' => 'xyz']]), new SlimResponse(), ['formId' => $formId]);
        $this->assertSame(201, $api->getStatusCode(), (string) $api->getBody());

        // The rules every path does check still refuse.
        $short = (new ResponseController(self::$responses, self::$forms, self::$sqlite))
            ->create($this->request(null, ['answers' => ['code' => 'ab']]), new SlimResponse(), ['formId' => $formId]);
        $this->assertSame(400, $short->getStatusCode());
        $this->assertSame(2, self::$responses->getResponseCount($formId));
    }
}

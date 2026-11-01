<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\AppPublicController;
use FormLogic\Controllers\FormController;
use FormLogic\Controllers\ResponseController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppDomainService;
use FormLogic\Services\AppResponseService;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FlowService;
use FormLogic\Services\FormService;
use FormLogic\Services\ResponseService;
use FormLogic\Services\WebhookService;
use PDO;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * Limits written in characters have to count characters, and a cut has to land between them. In
 * bytes, a Japanese description failed with a 500 at the cut, and a Chinese answer of 334
 * characters was refused as over 1000. A title past its column gets a message, not a 500.
 *
 * Skipped unless a test database is reachable.
 */
class TextLengthLimitsTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static FlowService $flows;
    private static FormService $forms;
    private static ResponseService $responses;
    private static AppService $apps;
    private static SQLiteConnection $sqlite;

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
        self::$sqlite = new SQLiteConnection(sys_get_temp_dir() . '/fl-textlimits-' . bin2hex(random_bytes(5)));
        self::$forms = new FormService($conn, self::$sqlite);
        self::$responses = new ResponseService($conn, self::$sqlite);
        self::$apps = new AppService($conn, self::$forms);
        self::$flows = new FlowService($conn);
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
        self::$pdo?->prepare('DELETE FROM flow_definitions WHERE owner_user_id = ?')->execute([$this->userId]);
        self::$pdo?->prepare('DELETE FROM app_forms WHERE app_id IN (SELECT id FROM apps WHERE owner_id = ?)')->execute([$this->userId]);
        self::$pdo?->prepare('DELETE FROM app_users WHERE app_id IN (SELECT id FROM apps WHERE owner_id = ?)')->execute([$this->userId]);
        self::$pdo?->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT r.id FROM app_roles r JOIN apps a ON a.id = r.app_id WHERE a.owner_id = ?)')->execute([$this->userId]);
        self::$pdo?->prepare('DELETE FROM app_roles WHERE app_id IN (SELECT id FROM apps WHERE owner_id = ?)')->execute([$this->userId]);
        self::$pdo?->prepare('DELETE FROM apps WHERE owner_id = ?')->execute([$this->userId]);
        self::$pdo?->prepare('DELETE FROM forms WHERE user_id = ?')->execute([$this->userId]);
        self::$pdo?->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
    }

    private function appId(): string
    {
        return (string) self::$apps->createApp(['name' => 'Limits ' . bin2hex(random_bytes(3))], $this->userId)['id'];
    }

    public function testADescriptionInAnyScriptSavesWhole(): void
    {
        $text = str_repeat('語', 700); // 2,100 bytes, past where the byte cut fell
        $appFlow = self::$flows->createFlow($this->appId(), $this->userId, ['name' => 'A', 'slug' => 'aa', 'description' => $text]);
        $this->assertSame($text, $appFlow['description']);
        $ownFlow = self::$flows->createWorkspaceFlow($this->userId, ['name' => 'B', 'slug' => 'bb', 'description' => $text]);
        $this->assertSame($text, $ownFlow['description']);
    }

    public function testADescriptionIsCutAtTwoThousandCharacters(): void
    {
        $flow = self::$flows->createWorkspaceFlow($this->userId, ['name' => 'C', 'slug' => 'cc', 'description' => str_repeat('語', 2500)]);
        $this->assertSame(2000, mb_strlen((string) $flow['description']));

        $updated = self::$flows->updateWorkspaceFlow($this->userId, (string) $flow['id'], ['description' => 'é' . str_repeat('語', 2500)]);
        $this->assertSame(2000, mb_strlen((string) $updated['description']));
        $this->assertSame(1, preg_match('//u', (string) $updated['description']), 'whole characters');
    }

    public function testANameCountsCharactersLikeItsColumn(): void
    {
        $name = str_repeat('流', 255);
        $this->assertSame($name, self::$flows->createWorkspaceFlow($this->userId, ['name' => $name, 'slug' => 'dd'])['name']);
        $this->expectException(\InvalidArgumentException::class);
        self::$flows->createWorkspaceFlow($this->userId, ['name' => $name . '流', 'slug' => 'ee']);
    }

    public function testAnAppFlowNameCountsCharactersToo(): void
    {
        $name = str_repeat('流', 255);
        $appId = $this->appId();
        $this->assertSame($name, self::$flows->createFlow($appId, $this->userId, ['name' => $name, 'slug' => 'ff'])['name']);
        $this->expectException(\InvalidArgumentException::class);
        self::$flows->createFlow($appId, $this->userId, ['name' => $name . '流', 'slug' => 'gg']);
    }

    public static function shortAnswers(): array
    {
        return [
            'Chinese' => [str_repeat('中', 334), true],
            'Arabic' => [str_repeat('ع', 600), true],
            'emoji' => [str_repeat('😀', 300), true],
            'the limit, in Chinese' => [str_repeat('中', 1000), true],
            'past it, in Chinese' => [str_repeat('中', 1001), false],
            'past it, in English' => [str_repeat('a', 1001), false],
        ];
    }

    private const SHORT = ['id' => 's1', 'type' => 'short_text', 'label' => 'Short'];

    /** @dataProvider shortAnswers */
    public function testAShortAnswerHasItsThousandCharactersInEverySubmitPath(string $text, bool $accepted): void
    {
        $this->assertSame($accepted, self::$responses->validateSubmittedAnswers([self::SHORT], ['s1' => $text]) === [], 'the shared check');

        $public = new ResponseController(self::$responses, self::$forms, self::$sqlite, null, null, null, self::$apps, self::$mysql);
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
        foreach ([$public, $runtime] as $controller) {
            $check = new \ReflectionMethod($controller, 'validateFieldType');
            $this->assertSame($accepted, $check->invoke($controller, self::SHORT, $text) === null, $controller::class);
        }
    }

    public function testALongFileNameInAnyScriptIsAName(): void
    {
        $field = ['id' => 'f1', 'type' => 'file_upload', 'label' => 'File', 'properties' => []];
        $file = ['id' => 'x', 'originalFilename' => str_repeat('写', 200) . '.pdf'];
        $errors = self::$responses->validateSubmittedAnswers([$field], ['f1' => [$file]]);
        $this->assertArrayNotHasKey('f1', $errors);
    }

    /** @return array{0:int, 1:array} */
    private function send(string $method, callable $handler, array $args, array $body): array
    {
        $request = (new ServerRequestFactory())->createServerRequest($method, 'http://localhost/api/forms')
            ->withAttribute('userId', $this->userId)
            ->withParsedBody($body);
        $response = $handler($request, new Response(), $args);
        return [$response->getStatusCode(), json_decode((string) $response->getBody(), true) ?? []];
    }

    public function testATitlePastItsColumnGetsAMessage(): void
    {
        $controller = new FormController(self::$forms);
        foreach ([str_repeat('T', 256), str_repeat('題', 256), str_repeat('T', 500)] as $title) {
            [$status, $body] = $this->send('POST', $controller->create(...), [], ['title' => $title]);
            $this->assertSame(422, $status);
            $this->assertSame('Title must be 255 characters or fewer', $body['message']);
        }
        [$status] = $this->send('POST', $controller->create(...), [], ['title' => str_repeat('題', 255)]);
        $this->assertSame(201, $status);

        $form = self::$forms->createForm(['title' => 'Short', 'userId' => $this->userId, 'fields' => []]);
        [$status, $body] = $this->send('PUT', $controller->update(...), ['id' => $form['id']], ['title' => str_repeat('題', 256)]);
        $this->assertSame(422, $status);
        $this->assertSame('Title must be 255 characters or fewer', $body['message']);
    }

    public function testACopyOfALongTitleStillFitsItsColumn(): void
    {
        $form = self::$forms->createForm(['title' => str_repeat('題', 255), 'userId' => $this->userId, 'fields' => []]);
        $copy = self::$forms->duplicateForm((string) $form['id'], $this->userId);
        $this->assertSame(str_repeat('題', 248) . ' (Copy)', $copy['title']);
    }

    public function testAWebhookReplyIsKeptAsWholeCharacters(): void
    {
        $body = new \ReflectionMethod(WebhookService::class, 'storableBody');
        $cut = $body->invoke(null, 'a' . str_repeat('語', 1000));
        $this->assertSame(1, preg_match('//u', $cut), 'no character cut in half');
        $this->assertLessThanOrEqual(2000, strlen($cut));
        $this->assertSame(1, preg_match('//u', $body->invoke(null, "caf\xE9")), 'a reply that is not UTF-8 can be stored');
    }
}

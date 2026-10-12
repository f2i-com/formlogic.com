<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\AppController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\FormService;
use PDO;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response as SlimResponse;

/**
 * An app's name and a form's display name in it are VARCHAR(255) and its description TEXT
 * (65,535 bytes). Longer text was handed to the database, which refused it, and the caller got
 * the database's own error ("SQLSTATE[22001] … Data too long for column") or a generic failure.
 * It is refused with a 400 that states the limit, on create and update, and on attaching a form.
 */
class AppTextLimitsTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static AppService $apps;
    private static FormService $forms;
    private static AppController $ctrl;

    private string $userId = '';

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
        self::$forms = new FormService($conn, new SQLiteConnection(sys_get_temp_dir() . '/fl-applimits-' . bin2hex(random_bytes(5))));
        self::$apps = new AppService($conn, self::$forms);
        self::$ctrl = new AppController(self::$apps);
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
        $owned = self::$pdo->prepare('SELECT id FROM apps WHERE owner_id = ?');
        $owned->execute([$this->userId]);
        foreach ($owned->fetchAll(PDO::FETCH_COLUMN) as $aid) {
            self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?)')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$aid]);
            self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$aid]);
        }
        self::$pdo->prepare('DELETE FROM forms WHERE user_id = ?')->execute([$this->userId]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->userId]);
    }

    /** @return array{status:int, body:array<string, mixed>} */
    private function call(string $method, array $body, array $args = []): array
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', 'http://api.test/api/apps')
            ->withParsedBody($body)->withAttribute('userId', $this->userId);
        /** @var ResponseInterface $response */
        $response = self::$ctrl->{$method}($request, new SlimResponse(), $args);
        $response->getBody()->rewind();
        return ['status' => $response->getStatusCode(), 'body' => (array) json_decode((string) $response->getBody(), true)];
    }

    private function assertRefusedWithTheLimit(array $out, string $limit): void
    {
        $this->assertSame(400, $out['status'], json_encode($out['body']));
        $message = (string) ($out['body']['message'] ?? '');
        $this->assertStringContainsString($limit, $message);
        $this->assertStringNotContainsString('SQLSTATE', $message);
    }

    public function testAnAppsNameAndDescriptionAreHeldToWhatTheyAreStoredIn(): void
    {
        // Characters, not bytes: 255 two-byte characters fit a VARCHAR(255) column.
        $made = $this->call('create', ['name' => str_repeat('é', 255)]);
        $this->assertSame(201, $made['status'], json_encode($made['body']));
        $appId = (string) $made['body']['app']['id'];

        $this->assertRefusedWithTheLimit($this->call('create', ['name' => str_repeat('é', 256)]), '255');
        $this->assertRefusedWithTheLimit($this->call('create', ['name' => 'Fine', 'description' => str_repeat('x', 65536)]), '65,535');

        $this->assertRefusedWithTheLimit($this->call('update', ['name' => str_repeat('a', 256)], ['id' => $appId]), '255');
        $this->assertRefusedWithTheLimit($this->call('update', ['description' => str_repeat('é', 32768)], ['id' => $appId]), '65,535');
        $this->assertSame(str_repeat('é', 255), self::$apps->getApp($appId)['name'] ?? null, 'nothing was changed');

        $this->assertSame(200, $this->call('update', ['description' => str_repeat('x', 65535)], ['id' => $appId])['status'], 'exactly the limit fits');
    }

    public function testAFormsDisplayNameInAnAppIsHeldToItsColumn(): void
    {
        $app = self::$apps->createApp(['name' => 'Shop'], $this->userId);
        $form = self::$forms->createForm(['title' => 'Orders', 'userId' => $this->userId, 'fields' => []]);

        $this->assertRefusedWithTheLimit(
            $this->call('addForm', ['formId' => $form['id'], 'displayName' => str_repeat('a', 256)], ['id' => $app['id']]),
            '255'
        );
        $this->assertFalse(self::$apps->formBelongsToApp((string) $app['id'], (string) $form['id']));

        // Without a display name the form's own title is used, as before.
        $added = $this->call('addForm', ['formId' => $form['id']], ['id' => $app['id']]);
        $this->assertSame(201, $added['status'], json_encode($added['body']));
        $this->assertSame('Orders', $added['body']['forms'][0]['displayName'] ?? null);
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\AppController;
use FormLogic\Controllers\FormController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FormService;
use FormLogic\Services\PackService;
use PDO;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * formlogic-python/1 for app logic, on save: a script's language is exactly 'javascript' or
 * 'python' (absent, null or '' is JavaScript), the rule flows follow. Every other value is refused
 * with the script named, where the author sees it, instead of being relabelled: JavaScript would
 * run a Python script as JavaScript, and any guess would hide the author's mistake. Covers the
 * owner's app and form PUTs, a pack's app logic, a pack envelope's logic and an app copy.
 * Skipped without a test DB.
 */
class AppLogicLanguageSaveTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static AppService $apps;
    private static FormService $forms;
    private static PackService $packs;
    private static AppController $appCtrl;
    private static FormController $formCtrl;

    private string $ownerId = '';

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
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/formlogic-applogic-save-' . bin2hex(random_bytes(4)));
        self::$forms = new FormService($conn, $sqlite);
        self::$apps = new AppService($conn, self::$forms);
        self::$packs = new PackService($conn, self::$forms, self::$apps, new AppUserService($conn));
        self::$appCtrl = new AppController(self::$apps);
        self::$formCtrl = new FormController(self::$forms);
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->ownerId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")
            ->execute([$this->ownerId, $this->ownerId . '@test.local']);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null || $this->ownerId === '') {
            return;
        }
        self::$pdo->prepare('DELETE FROM app_forms WHERE app_id IN (SELECT id FROM apps WHERE owner_id = ?)')->execute([$this->ownerId]);
        self::$pdo->prepare('DELETE FROM app_users WHERE app_id IN (SELECT id FROM apps WHERE owner_id = ?)')->execute([$this->ownerId]);
        self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT r.id FROM app_roles r JOIN apps a ON a.id = r.app_id WHERE a.owner_id = ?)')->execute([$this->ownerId]);
        self::$pdo->prepare('DELETE FROM app_roles WHERE app_id IN (SELECT id FROM apps WHERE owner_id = ?)')->execute([$this->ownerId]);
        self::$pdo->prepare('DELETE FROM apps WHERE owner_id = ?')->execute([$this->ownerId]);
        self::$pdo->prepare('DELETE FROM forms WHERE user_id = ?')->execute([$this->ownerId]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->ownerId]);
    }

    private static function bundle(mixed $language): array
    {
        $script = ['id' => 'fuel-check', 'hook' => 'onBeforeSubmit', 'source' => "def run(ctx):\n    return {}"];
        if ($language !== '__absent__') {
            $script['language'] = $language;
        }
        return ['version' => 1, 'scripts' => [$script]];
    }

    /** @return array{0: int, 1: array} */
    private function put(callable $handler, string $id, array $body): array
    {
        $req = (new ServerRequestFactory())->createServerRequest('PUT', 'http://localhost/api/test/' . $id)
            ->withAttribute('userId', $this->ownerId)
            ->withParsedBody($body);
        $res = $handler($req, new Response(), ['id' => $id]);
        return [$res->getStatusCode(), json_decode((string) $res->getBody(), true) ?? []];
    }

    private function storedLogic(string $table, string $id): mixed
    {
        $stmt = self::$pdo->prepare("SELECT custom_logic FROM {$table} WHERE id = ?");
        $stmt->execute([$id]);
        $raw = $stmt->fetchColumn();
        return is_string($raw) ? json_decode($raw, true) : null;
    }

    public function testAppSaveRefusesALanguageNoRuntimeRunsAndStoresNothing(): void
    {
        $app = self::$apps->createApp(['name' => 'Logic save'], $this->ownerId);
        foreach (['py', 'python3', 'Python', 5] as $bad) {
            [$status, $body] = $this->put(fn ($rq, $rs, $a) => self::$appCtrl->update($rq, $rs, $a), $app['id'], ['customLogic' => self::bundle($bad)]);
            $this->assertSame(400, $status, json_encode($bad));
            $this->assertStringContainsString("script 'fuel-check' has an unsupported language", $body['message'] ?? '');
            $this->assertStringContainsString('javascript or python', $body['message']);
        }
        $this->assertNull($this->storedLogic('apps', $app['id']), 'nothing was stored');

        // The two languages save as written; absent, null and '' save as JavaScript.
        [$status] = $this->put(fn ($rq, $rs, $a) => self::$appCtrl->update($rq, $rs, $a), $app['id'], ['customLogic' => self::bundle('python')]);
        $this->assertSame(200, $status);
        $this->assertSame('python', $this->storedLogic('apps', $app['id'])['scripts'][0]['language']);
        foreach (['__absent__', null, ''] as $javascript) {
            [$status] = $this->put(fn ($rq, $rs, $a) => self::$appCtrl->update($rq, $rs, $a), $app['id'], ['customLogic' => self::bundle($javascript)]);
            $this->assertSame(200, $status);
            $this->assertArrayNotHasKey('language', $this->storedLogic('apps', $app['id'])['scripts'][0]);
        }
    }

    public function testFormSaveRefusesALanguageNoRuntimeRuns(): void
    {
        $form = self::$forms->createForm(['userId' => $this->ownerId, 'title' => 'Logic form', 'fields' => []]);
        [$status, $body] = $this->put(fn ($rq, $rs, $a) => self::$formCtrl->update($rq, $rs, $a), $form['id'], ['customLogic' => self::bundle('py')]);
        $this->assertSame(422, $status);
        $this->assertStringContainsString("script 'fuel-check' has an unsupported language 'py'", $body['message'] ?? '');
        $this->assertNull($this->storedLogic('forms', $form['id']));

        [$status] = $this->put(fn ($rq, $rs, $a) => self::$formCtrl->update($rq, $rs, $a), $form['id'], ['customLogic' => self::bundle('python')]);
        $this->assertSame(200, $status);
        $this->assertSame('python', $this->storedLogic('forms', $form['id'])['scripts'][0]['language']);
    }

    /** POST /api/apps and POST /api/forms store a body's customLogic too: the same rule applies. */
    public function testCreatingAnAppOrFormRefusesALanguageNoRuntimeRuns(): void
    {
        $post = function (callable $handler, array $body): array {
            $req = (new ServerRequestFactory())->createServerRequest('POST', 'http://localhost/api/test')
                ->withAttribute('userId', $this->ownerId)
                ->withParsedBody($body);
            $res = $handler($req, new Response());
            return [$res->getStatusCode(), json_decode((string) $res->getBody(), true) ?? []];
        };
        $apps = static fn (): int => (int) self::$pdo->query('SELECT COUNT(*) FROM apps')->fetchColumn();
        $before = $apps();
        [$status, $body] = $post(fn ($rq, $rs) => self::$appCtrl->create($rq, $rs), ['name' => 'Typo app', 'customLogic' => self::bundle('py')]);
        $this->assertSame(400, $status);
        $this->assertStringContainsString("script 'fuel-check' has an unsupported language 'py'", $body['message'] ?? '');
        $this->assertSame($before, $apps(), 'no app was created');

        [$status, $body] = $post(fn ($rq, $rs) => self::$formCtrl->create($rq, $rs), ['title' => 'Typo form', 'customLogic' => self::bundle('python3')]);
        $this->assertSame(422, $status);
        $this->assertStringContainsString("unsupported language 'python3'", $body['message'] ?? '');

        [$status, $body] = $post(fn ($rq, $rs) => self::$appCtrl->create($rq, $rs), ['name' => 'Python app', 'customLogic' => self::bundle('python')]);
        $this->assertSame(201, $status);
        $this->assertSame('python', $this->storedLogic('apps', $body['app']['id'])['scripts'][0]['language']);
    }

    /** A pack's app logic is stored as the pack carries it, so its languages are checked first. */
    public function testPackImportRefusesAppLogicInALanguageNoRuntimeRuns(): void
    {
        $pack = [
            'formatVersion' => 1,
            'packMeta' => ['name' => 'Pack logic', 'version' => '1.0.0', 'description' => 'x'],
            'forms' => [
                ['packFormId' => 'intake', 'title' => 'Intake', 'fields' => [['id' => 'a', 'type' => 'short_text', 'label' => 'A']]],
            ],
            'apps' => [[
                'packAppId' => 'logic-app',
                'name' => 'Pack logic',
                'forms' => [['packFormId' => 'intake', 'sortOrder' => 0]],
                'customLogic' => self::bundle('py'),
            ]],
        ];
        $before = (int) self::$pdo->query('SELECT COUNT(*) FROM apps')->fetchColumn();
        $refused = null;
        try {
            self::$packs->importPack($pack, $this->ownerId);
        } catch (\RuntimeException $e) {
            $refused = $e;
        }
        $this->assertNotNull($refused, 'a pack with an unsupported app-logic language must not import');
        $this->assertStringContainsString("script 'fuel-check' has an unsupported language 'py'", $refused->getMessage());
        $this->assertSame($before, (int) self::$pdo->query('SELECT COUNT(*) FROM apps')->fetchColumn(), 'nothing was created');

        $pack['apps'][0]['customLogic'] = self::bundle('python');
        $result = self::$packs->importPack($pack, $this->ownerId);
        $this->assertSame('python', self::$apps->getApp($result['apps'][0]['id'])['customLogic']['scripts'][0]['language']);
    }

    /**
     * Envelope logic is applied after the pack's atomic import has committed, so a script it
     * cannot store is reported rather than half-failing the import.
     */
    public function testPackEnvelopeLogicInALanguageNoRuntimeRunsIsNotAppliedAndSaysWhy(): void
    {
        $app = self::$apps->createApp(['name' => 'Envelope target'], $this->ownerId);
        $warnings = self::$packs->applyPackageMetadata(['customLogic' => self::bundle('python3')], [['id' => $app['id']]], $this->ownerId, []);
        $this->assertNull($this->storedLogic('apps', $app['id']));
        $this->assertNotEmpty(array_filter($warnings, static fn (string $w): bool => str_contains($w, "unsupported language 'python3'")), json_encode($warnings));
    }

    public function testCopyingAnAppWithAStoredUnknownLanguageIsRefused(): void
    {
        $app = self::$apps->createApp(['name' => 'Legacy logic'], $this->ownerId);
        // Only a row stored before this check can hold one: write it directly.
        self::$pdo->prepare('UPDATE apps SET custom_logic = ? WHERE id = ?')->execute([json_encode(self::bundle('ruby')), $app['id']]);
        $refused = null;
        try {
            self::$apps->createCompanionApp($app['id'], $this->ownerId, 'Copy', ['copyLogic' => true]);
        } catch (\InvalidArgumentException $e) {
            $refused = $e;
        }
        $this->assertNotNull($refused, 'the copy must not relabel the script');
        $this->assertStringContainsString("unsupported language 'ruby'", $refused->getMessage());
    }
}

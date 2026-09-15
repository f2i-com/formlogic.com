<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\AppPublicController;
use FormLogic\Controllers\FlowController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Helpers\CustomLogicSanitizer;
use FormLogic\Services\AppDomainService;
use FormLogic\Services\AppResponseService;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\FlowService;
use FormLogic\Services\FormService;
use FormLogic\Services\ResponseService;
use PDO;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * formlogic-python/1 for app logic: GET /api/v1/app-logic is how a Desktop fetches the
 * onConnectorEvent scripts it runs headless. A Desktop built before Python ignores a script's
 * language and would run a Python script as JavaScript, so the catalogue lists only the
 * languages the caller declares in `?languages=` — absent means JavaScript only. The browser
 * runs the scripts a Desktop does not receive. The app runtime's own config (GET
 * /api/app/{slug}) follows the same rule, for a browser tab still on a bundle from before
 * Python. Skipped without a test DB.
 */
class AppLogicLanguageCatalogueTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    private static FlowController $ctrl;
    private static AppPublicController $public;

    private string $ownerId = '';
    private string $appId = '';
    private string $slug = '';
    private string $formId = '';

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
        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/formlogic-applogic-lang-' . bin2hex(random_bytes(4)));
        $forms = new FormService($conn, $sqlite);
        self::$ctrl = new FlowController(new FlowService($conn), new AppService($conn, $forms), new AppUserService($conn), null);
        $responses = new ResponseService($conn, $sqlite);
        self::$public = new AppPublicController(
            new AppService($conn, $forms),
            new AppUserService($conn),
            new AppResponseService($conn, $sqlite, $responses, null, $forms),
            $forms,
            $responses,
            $conn,
            $sqlite,
            new AppDomainService($conn)
        );
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
        // Saved the way the owner's PUT saves it: through the sanitizer.
        $logic = CustomLogicSanitizer::sanitize([
            'scripts' => [
                ['id' => 'js-call', 'hook' => 'onConnectorEvent', 'source' => 'function run(ctx) { return {}; }'],
                ['id' => 'py-call', 'hook' => 'onConnectorEvent', 'language' => 'python', 'source' => "def run(ctx):\n    return {}"],
                ['id' => 'js-explicit', 'hook' => 'onAppStart', 'language' => 'javascript', 'source' => 'function run(ctx) { return {}; }'],
            ],
            'permissions' => ['ui.toast'],
        ]);
        // A language no runtime implements can only arrive through a path that skipped the
        // sanitizer (a verbatim pack or backup restore); it must never reach a Desktop.
        $logic['scripts'][] = ['id' => 'odd', 'hook' => 'onAppStart', 'runtime' => 'quickjs', 'language' => 'ruby', 'source' => 'function run(ctx) { return {}; }'];
        $this->slug = 'applogic-' . bin2hex(random_bytes(6));
        self::$pdo->prepare("INSERT INTO apps (id, owner_id, name, slug, status, custom_logic) VALUES (?, ?, 'Logic App', ?, 'published', ?)")
            ->execute([$this->appId, $this->ownerId, $this->slug, json_encode($logic)]);

        // The owner's membership, and one form with form-level scripts, for the runtime config.
        $roleId = 'r-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO app_roles (id, app_id, name, is_system, sort_order) VALUES (?, ?, 'Owner-x', 0, 9)")
            ->execute([$roleId, $this->appId]);
        self::$pdo->prepare("INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at) VALUES (UUID(), ?, ?, ?, 'active', NOW())")
            ->execute([$this->appId, $this->ownerId, $roleId]);
        $this->formId = 'f-' . bin2hex(random_bytes(12));
        $formLogic = CustomLogicSanitizer::sanitize(['scripts' => [
            ['id' => 'form-js', 'hook' => 'onBeforeSubmit', 'source' => 'function run(ctx) { return {}; }'],
            ['id' => 'form-py', 'hook' => 'onBeforeSubmit', 'language' => 'python', 'source' => "def run(ctx):\n    return {}"],
        ]]);
        self::$pdo->prepare("INSERT INTO forms (id, user_id, title, status, custom_logic) VALUES (?, ?, 'Logic form', 'published', ?)")
            ->execute([$this->formId, $this->ownerId, json_encode($formLogic)]);
        self::$pdo->prepare("INSERT INTO app_forms (id, app_id, form_id, display_name, sort_order, is_visible, settings) VALUES (UUID(), ?, ?, 'Logic form', 0, 1, '{}')")
            ->execute([$this->appId, $this->formId]);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null || $this->ownerId === '') {
            return;
        }
        self::$pdo->prepare('DELETE FROM app_forms WHERE app_id = ?')->execute([$this->appId]);
        self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$this->appId]);
        self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$this->appId]);
        self::$pdo->prepare('DELETE FROM forms WHERE user_id = ?')->execute([$this->ownerId]);
        self::$pdo->prepare('DELETE FROM apps WHERE owner_id = ?')->execute([$this->ownerId]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->ownerId]);
    }

    /** @return array{0: int, 1: array} GET /api/app/{slug} as the owner */
    private function runtimeConfig(array $query): array
    {
        $req = (new ServerRequestFactory())->createServerRequest('GET', 'http://localhost/api/app/' . $this->slug)
            ->withAttribute('userId', $this->ownerId)
            ->withQueryParams($query);
        $res = self::$public->getApp($req, new Response(), ['slug' => $this->slug]);
        return [$res->getStatusCode(), json_decode((string) $res->getBody(), true)];
    }

    /** @return array{0: list<string>, 1: list<string>} app-level and form-level script ids */
    private function runtimeScriptIds(array $query): array
    {
        [$status, $body] = $this->runtimeConfig($query);
        $this->assertSame(200, $status, json_encode($body));
        $forms = array_values(array_filter($body['forms'], fn (array $f): bool => $f['formId'] === $this->formId));
        $this->assertCount(1, $forms);
        return [
            array_column($body['app']['customLogic']['scripts'], 'id'),
            array_column($forms[0]['customLogic']['scripts'], 'id'),
        ];
    }

    public function testAppRuntimeConfigListsOnlyTheLanguagesTheClientRuns(): void
    {
        // A tab on a bundle from before Python sends nothing: JavaScript only.
        $this->assertSame([['js-call', 'js-explicit'], ['form-js']], $this->runtimeScriptIds([]));
        // The current client declares both.
        $this->assertSame(
            [['js-call', 'py-call', 'js-explicit'], ['form-js', 'form-py']],
            $this->runtimeScriptIds(['languages' => 'javascript,python'])
        );
        // The rest of the bundle is untouched.
        [, $body] = $this->runtimeConfig([]);
        $this->assertSame(['ui.toast'], $body['app']['customLogic']['permissions']);
        [$status] = $this->runtimeConfig(['languages' => 'javascript,,python']);
        $this->assertSame(400, $status);
    }

    /** GET /api/app/{slug}/forms/{formId}: where the runtime reads the form-level scripts it runs. */
    public function testAppRuntimeFormListsOnlyTheLanguagesTheClientRuns(): void
    {
        $scriptIds = function (array $query): array {
            $req = (new ServerRequestFactory())->createServerRequest('GET', 'http://localhost/api/app/' . $this->slug . '/forms/' . $this->formId)
                ->withAttribute('userId', $this->ownerId)
                ->withQueryParams($query);
            $res = self::$public->getForm($req, new Response(), ['slug' => $this->slug, 'formId' => $this->formId]);
            $body = json_decode((string) $res->getBody(), true);
            $this->assertSame(200, $res->getStatusCode(), json_encode($body));
            return array_column($body['form']['customLogic']['scripts'], 'id');
        };
        $this->assertSame(['form-js'], $scriptIds([]));
        $this->assertSame(['form-js', 'form-py'], $scriptIds(['languages' => 'javascript,python']));
        $req = (new ServerRequestFactory())->createServerRequest('GET', 'http://localhost/api/app/x')
            ->withAttribute('userId', $this->ownerId)
            ->withQueryParams(['languages' => str_repeat('p', 40)]);
        $this->assertSame(400, self::$public->getForm($req, new Response(), ['slug' => $this->slug, 'formId' => $this->formId])->getStatusCode());
    }

    /** @return array{0: int, 1: array} status and decoded body */
    private function catalogue(array $query): array
    {
        $req = (new ServerRequestFactory())->createServerRequest('GET', 'http://localhost/api/v1/app-logic')
            ->withAttribute('userId', $this->ownerId)
            ->withQueryParams($query);
        $res = self::$ctrl->ownerAppLogic($req, new Response());
        return [$res->getStatusCode(), json_decode((string) $res->getBody(), true)];
    }

    /** @return list<string> the script ids the catalogue lists for the test app */
    private function scriptIds(array $query): array
    {
        [$status, $body] = $this->catalogue($query);
        $this->assertSame(200, $status);
        $apps = array_values(array_filter($body['apps'], fn (array $a): bool => $a['app']['id'] === $this->appId));
        $this->assertCount(1, $apps);
        return array_column($apps[0]['customLogic']['scripts'], 'id');
    }

    public function testACallerThatDeclaresNoLanguagesGetsJavaScriptOnly(): void
    {
        $this->assertSame(['js-call', 'js-explicit'], $this->scriptIds([]));
        $this->assertSame(['js-call', 'js-explicit'], $this->scriptIds(['app' => $this->appId]));
    }

    public function testACallerThatRunsPythonGetsItsScriptsToo(): void
    {
        $this->assertSame(['js-call', 'py-call', 'js-explicit'], $this->scriptIds(['languages' => 'javascript,python']));
        // JavaScript is always implied; a language the server does not know adds nothing.
        $this->assertSame(['js-call', 'py-call', 'js-explicit'], $this->scriptIds(['languages' => 'python,ruby']));
        $this->assertSame(['js-call', 'js-explicit'], $this->scriptIds(['languages' => '']));
    }

    public function testTheRestOfTheBundleIsUnchanged(): void
    {
        [, $body] = $this->catalogue(['app' => $this->appId]);
        $logic = $body['apps'][0]['customLogic'];
        $this->assertSame(['ui.toast'], $logic['permissions']);
        $this->assertSame('quickjs', $logic['runtime']);
        [, $full] = $this->catalogue(['app' => $this->appId, 'languages' => 'javascript,python']);
        $python = array_values(array_filter($full['apps'][0]['customLogic']['scripts'], static fn (array $s): bool => $s['id'] === 'py-call'));
        $this->assertSame('python', $python[0]['language']);
        $this->assertSame("def run(ctx):\n    return {}", $python[0]['source']);
    }

    public function testAMalformedLanguagesValueIs400(): void
    {
        [$status, $body] = $this->catalogue(['languages' => implode(',', array_fill(0, 17, 'python'))]);
        $this->assertSame(400, $status);
        $this->assertStringContainsString('languages', $body['message']);
        [$status] = $this->catalogue(['languages' => 'javascript,,python']);
        $this->assertSame(400, $status);
    }
}

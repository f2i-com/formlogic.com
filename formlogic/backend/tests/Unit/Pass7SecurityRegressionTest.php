<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Constants\AppPermissions;
use FormLogic\Controllers\ResponseController;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Helpers\PackCapabilities;
use FormLogic\Services\AppUserService;
use FormLogic\Services\CloudFlowNodeError;
use FormLogic\Services\CloudFlowRunner;
use FormLogic\Services\FlowService;
use FormLogic\Services\FormEncryptionService;
use FormLogic\Services\FormService;
use FormLogic\Services\NativeAppService;
use FormLogic\Services\NativeAppUploadsService;
use FormLogic\Services\NativeTableFormBridge;
use FormLogic\Services\PlanService;
use FormLogic\Services\ResponseService;
use PDO;
use PHPUnit\Framework\TestCase;
use ReflectionClass;
use ReflectionMethod;
use ReflectionProperty;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response as SlimResponse;

final class Pass7SecurityRegressionTest extends TestCase
{
    public function testPackCapabilitiesDetectsConnectorAliasOnConnectorRequestNodes(): void
    {
        $summary = PackCapabilities::describe([
            'flows' => [
                [
                    'slug' => 'notify',
                    'flowJson' => [
                        'nodes' => [
                            [
                                'id' => 'n1',
                                'type' => 'connector_request',
                                'data' => [
                                    'connector' => 'aokie',
                                    'command' => 'speak',
                                ],
                            ],
                        ],
                    ],
                ],
            ],
        ]);

        $this->assertContains('aokie', $summary['connectors']);
        $this->assertContains('connector.aokie.speak', $summary['connectorGrants']);
        $this->assertContains('connector.aokie.speak', $summary['permissions']);
    }

    public function testNativeTableFormBridgeRefusesPrivateFormsAndDeletesAllRows(): void
    {
        $pdo = new PDO('sqlite::memory:');
        $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $pdo->exec('CREATE TABLE form_encryption (form_id TEXT PRIMARY KEY, state TEXT NOT NULL)');
        $pdo->exec('CREATE TABLE forms (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, settings TEXT)');
        $pdo->exec('CREATE TABLE apps (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL)');

        $settings = json_encode([
            'nativeTableBinding' => [
                'appId' => 'app-1',
                'table' => 'orders',
                'columns' => ['f_name' => 'customer_name'],
                'primaryKey' => ['id'],
            ],
        ], JSON_THROW_ON_ERROR);
        $pdo->exec("INSERT INTO apps (id, owner_id) VALUES ('app-1', 'owner-1')");
        $pdo->exec("INSERT INTO forms (id, user_id, settings) VALUES ('form-1', 'owner-1', " . $pdo->quote($settings) . ')');
        $pdo->exec("INSERT INTO form_encryption (form_id, state) VALUES ('form-1', 'active')");

        $appDb = new PDO('sqlite::memory:');
        $appDb->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $appDb->exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_name TEXT)');
        $appDb->exec("INSERT INTO orders (customer_name) VALUES ('Alice'), ('Bob'), ('Cara')");

        $native = $this->createStub(NativeAppService::class);
        $native->method('databaseAppId')->willReturn('app-1');
        $native->method('withDatabase')->willReturnCallback(static fn (string $appId, callable $use): mixed => $use($appDb));

        $bridge = new NativeTableFormBridge($pdo, $native);

        // Private form must never route through plaintext native table bindings.
        $this->assertNull($bridge->resolveBinding('form-1'));

        // Once not private, the same form resolves its binding and deleteAllResponses clears all rows.
        $pdo->exec("DELETE FROM form_encryption WHERE form_id = 'form-1'");
        $binding = $bridge->resolveBinding('form-1');
        $this->assertNotNull($binding);
        $this->assertSame('orders', $binding['table']);

        $deleted = $bridge->deleteAllResponses($binding);
        $this->assertSame(3, $deleted);
        $this->assertSame(0, (int) $appDb->query('SELECT COUNT(*) FROM orders')->fetchColumn());
    }

    public function testFormEncryptionPreflightBlocksNativeTableBoundForms(): void
    {
        $pdo = new PDO('sqlite::memory:');
        $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $pdo->exec('CREATE TABLE forms (id TEXT PRIMARY KEY, user_id TEXT, ever_published_at TEXT, settings TEXT, custom_screen TEXT)');
        $pdo->exec('CREATE TABLE form_encryption (form_id TEXT PRIMARY KEY, state TEXT)');
        $pdo->exec('CREATE TABLE response_metadata (id TEXT PRIMARY KEY, form_id TEXT)');
        $pdo->exec('CREATE TABLE webhooks (id TEXT PRIMARY KEY, form_id TEXT)');
        $pdo->exec('CREATE TABLE app_flow_bindings (id TEXT PRIMARY KEY, form_id TEXT, flow_definition_id TEXT, output_actions_json TEXT, input_map_json TEXT)');
        $pdo->exec('CREATE TABLE flow_definitions (id TEXT PRIMARY KEY, owner_user_id TEXT, flow_json TEXT)');
        $pdo->exec('CREATE TABLE apps (id TEXT PRIMARY KEY, owner_id TEXT, reports TEXT, custom_screen TEXT)');
        $pdo->exec('CREATE TABLE response_links (id TEXT PRIMARY KEY, source_form_id TEXT, target_form_id TEXT)');
        $pdo->exec('CREATE TABLE app_forms (app_id TEXT, form_id TEXT)');

        $settings = json_encode(['nativeTableBinding' => ['appId' => 'app-1', 'table' => 'orders']], JSON_THROW_ON_ERROR);
        $pdo->exec("INSERT INTO forms (id, user_id, ever_published_at, settings, custom_screen) VALUES ('form-bound', 'user-1', NULL, " . $pdo->quote($settings) . ', NULL)');

        $tmpUploads = sys_get_temp_dir() . '/fl-pass7-up-' . bin2hex(random_bytes(4));
        $enc = new FormEncryptionService($pdo, null, $tmpUploads);
        $method = new ReflectionMethod(FormEncryptionService::class, 'preflightReasons');
        $method->setAccessible(true);

        /** @var list<string> $reasons */
        $reasons = $method->invoke($enc, 'form-bound', 'user-1', true);
        $this->assertContains('has_native_table_binding', $reasons);
    }

    public function testAppUserServiceBlocksDelegatedRecordPermissionEscalation(): void
    {
        $pdo = new PDO('sqlite::memory:');
        $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $pdo->exec('CREATE TABLE apps (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL)');
        $pdo->exec('CREATE TABLE app_roles (id TEXT PRIMARY KEY, app_id TEXT NOT NULL, name TEXT NOT NULL, is_system INTEGER NOT NULL DEFAULT 0)');
        $pdo->exec('CREATE TABLE app_role_permissions (id INTEGER PRIMARY KEY AUTOINCREMENT, role_id TEXT NOT NULL, form_id TEXT, permission TEXT NOT NULL)');
        $pdo->exec('CREATE TABLE app_users (id TEXT PRIMARY KEY, app_id TEXT NOT NULL, user_id TEXT NOT NULL, role_id TEXT NOT NULL, status TEXT NOT NULL)');

        $pdo->exec("INSERT INTO apps (id, owner_id) VALUES ('app-1', 'owner-1')");
        $pdo->exec("INSERT INTO app_roles (id, app_id, name, is_system) VALUES
            ('role-mgr', 'app-1', 'People Manager', 0),
            ('role-mgr-form-a', 'app-1', 'Form A Manager', 0),
            ('role-clerk', 'app-1', 'Clerk', 0),
            ('role-reviewer', 'app-1', 'Reviewer', 0),
            ('role-reviewer-a', 'app-1', 'Reviewer A', 0),
            ('role-reviewer-b', 'app-1', 'Reviewer B', 0)
        ");
        $pdo->exec("INSERT INTO app_role_permissions (role_id, form_id, permission) VALUES
            ('role-mgr', NULL, '" . AppPermissions::MANAGE_USERS . "'),
            ('role-mgr-form-a', NULL, '" . AppPermissions::MANAGE_USERS . "'),
            ('role-mgr-form-a', 'form-a', '" . AppPermissions::VIEW_ALL_RESPONSES . "'),
            ('role-clerk', NULL, '" . AppPermissions::SUBMIT_RESPONSES . "'),
            ('role-clerk', NULL, '" . AppPermissions::VIEW_OWN_RESPONSES . "'),
            ('role-reviewer', NULL, '" . AppPermissions::VIEW_ALL_RESPONSES . "'),
            ('role-reviewer-a', 'form-a', '" . AppPermissions::VIEW_ALL_RESPONSES . "'),
            ('role-reviewer-b', 'form-b', '" . AppPermissions::VIEW_ALL_RESPONSES . "')
        ");
        $pdo->exec("INSERT INTO app_users (id, app_id, user_id, role_id, status) VALUES
            ('au-mgr', 'app-1', 'mgr-1', 'role-mgr', 'active'),
            ('au-mgr-a', 'app-1', 'mgr-a', 'role-mgr-form-a', 'active'),
            ('au-target', 'app-1', 'target-1', 'role-clerk', 'active')
        ");

        $ref = new ReflectionClass(AppUserService::class);
        /** @var AppUserService $svc */
        $svc = $ref->newInstanceWithoutConstructor();
        $prop = new ReflectionProperty(AppUserService::class, 'mysql');
        $prop->setAccessible(true);
        $prop->setValue($svc, $pdo);

        // 1. Delegated MANAGE_USERS holder without record permissions MUST NOT assign Reviewer role.
        try {
            $svc->updateAppUser('au-target', ['roleId' => 'role-reviewer'], 'mgr-1', 'app-1');
            $this->fail('Expected delegated manager to be blocked from assigning view_all_responses role');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('record permissions you do not hold', $e->getMessage());
        }

        // 2. Delegated MANAGE_USERS holder CAN assign basic Clerk role (submit_responses + view_own_responses).
        $this->assertTrue($svc->updateAppUser('au-target', ['roleId' => 'role-clerk'], 'mgr-1', 'app-1'));

        // 3. Manager with view_all_responses on form-a CAN assign Reviewer A, but CANNOT assign Reviewer B or app-wide Reviewer.
        $this->assertTrue($svc->updateAppUser('au-target', ['roleId' => 'role-reviewer-a'], 'mgr-a', 'app-1'));
        foreach (['role-reviewer-b', 'role-reviewer'] as $forbiddenRole) {
            $refused = false;
            try {
                $svc->updateAppUser('au-target', ['roleId' => $forbiddenRole], 'mgr-a', 'app-1');
            } catch (\RuntimeException $e) {
                $refused = str_contains($e->getMessage(), 'record permissions you do not hold');
            }
            $this->assertTrue($refused, "Expected {$forbiddenRole} to be rejected for form-a manager");
        }

        // 4. App owner CAN assign any non-Owner role, including app-wide Reviewer.
        $this->assertTrue($svc->updateAppUser('au-target', ['roleId' => 'role-reviewer'], 'owner-1', 'app-1'));
    }

    public function testCloudFlowRunnerCallStackDetectsCaseVariantUuidCycle(): void
    {
        $flowService = $this->createStub(FlowService::class);
        $flowService->method('getFlow')->willReturn([
            'id' => 'flow-abc-123',
            'slug' => 'self-caller',
            'enabled' => true,
            'version' => 1,
            'flowJson' => ['nodes' => [], 'edges' => []],
        ]);
        $flowService->method('compiledIrForCurrentVersion')->willReturn(null);

        $ref = new ReflectionClass(CloudFlowRunner::class);
        /** @var CloudFlowRunner $runner */
        $runner = $ref->newInstanceWithoutConstructor();
        $prop = new ReflectionProperty(CloudFlowRunner::class, 'flowService');
        $prop->setAccessible(true);
        $prop->setValue($runner, $flowService);

        $method = new ReflectionMethod(CloudFlowRunner::class, 'runFlowCall');
        $method->setAccessible(true);

        $node = [
            'id' => 'call-1',
            'type' => 'flow_call',
        ];
        $data = [
            'flowId' => 'FLOW-ABC-123',
            'failureMode' => 'fail-parent',
        ];
        $parentFlow = ['id' => 'flow-abc-123', 'appId' => 'app-1'];
        $runCtx = [
            'runId' => 'run-1',
            'deadline' => microtime(true) + 30.0,
            'callStack' => ['flow-abc-123'],
        ];

        $this->expectException(CloudFlowNodeError::class);
        $this->expectExceptionMessage('recursion_detected');
        $method->invoke($runner, $node, $data, [], $parentFlow, 'user-1', $runCtx);
    }

    public function testNativeAppUploadsServiceRefusesInactiveCloudPlanWith402(): void
    {
        $pdo = new PDO('sqlite::memory:');
        $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $pdo->exec('CREATE TABLE native_app_uploads (id TEXT PRIMARY KEY, app_id TEXT NOT NULL, size_bytes INTEGER NOT NULL, status TEXT NOT NULL)');

        $plans = $this->createStub(PlanService::class);
        $plans->method('isEnforced')->willReturn(true);
        $plans->method('isCloudActive')->willReturn(false);

        $tmpDir = sys_get_temp_dir() . '/fl-pass7-uploads-' . bin2hex(random_bytes(4));
        mkdir($tmpDir, 0700, true);
        try {
            $svc = new NativeAppUploadsService($pdo, $plans, $tmpDir);
            try {
                $svc->storeBytes(
                    ['id' => 'app-1', 'slug' => 'demo', 'ownerId' => 'owner-lapsed', 'settings' => ['nativeUploads' => ['access' => 'anyone']]],
                    'note.txt',
                    'hello world',
                    '',
                    'visitor-1',
                    'Visitor',
                    false,
                );
                $this->fail('Expected RuntimeException(402) for inactive cloud plan');
            } catch (\RuntimeException $e) {
                $this->assertSame(402, $e->getCode());
            }
        } finally {
            $this->removeDir($tmpDir);
        }
    }

    public function testResponseControllerExportJsonPaginatesNativeTableBoundFormsPast250Rows(): void
    {
        $formService = $this->createStub(FormService::class);
        $formService->method('getForm')->willReturn([
            'id' => 'form-bound',
            'userId' => 'owner-1',
            'title' => 'Bound Orders',
            'description' => '',
            'status' => 'published',
            'fields' => [['id' => 'f1', 'type' => 'short_text', 'label' => 'Name']],
            'settings' => [],
            'theme' => [],
            'createdAt' => '2026-01-01 00:00:00',
            'updatedAt' => '2026-01-01 00:00:00',
        ]);

        $makeRows = static function (int $start, int $count): array {
            $rows = [];
            for ($i = 0; $i < $count; $i++) {
                $n = $start + $i;
                $rows[] = ['id' => 'row-' . $n, 'answers' => ['f1' => 'Item ' . $n], 'status' => 'submitted', 'submittedAt' => '2026-01-01 00:00:00'];
            }
            return $rows;
        };

        $responseService = $this->createStub(ResponseService::class);
        $responseService->method('isNativeTableBound')->willReturn(true);
        $responseService->method('getFormResponses')->willReturnCallback(
            static function (string $formId, array $options) use ($makeRows): array {
                $offset = (int) ($options['offset'] ?? 0);
                if ($offset === 0) {
                    return $makeRows(1, 250);
                }
                if ($offset === 250) {
                    return $makeRows(251, 12);
                }
                return [];
            }
        );

        $sqlite = new SQLiteConnection(sys_get_temp_dir() . '/fl-pass7-sqlite-' . bin2hex(random_bytes(4)));
        $controller = new ResponseController($responseService, $formService, $sqlite);

        $req = (new ServerRequestFactory())
            ->createServerRequest('GET', '/api/forms/form-bound/export/json')
            ->withAttribute('userId', 'owner-1');
        $res = $controller->exportJson($req, new SlimResponse(), ['formId' => 'form-bound']);

        $this->assertSame(200, $res->getStatusCode());
        $payload = json_decode((string) $res->getBody(), true);
        $this->assertIsArray($payload);
        $this->assertSame(262, $payload['meta']['totalResponses']);
        $this->assertFalse($payload['meta']['truncated']);
        $this->assertCount(262, $payload['responses']);
    }

    private function removeDir(string $dir): void
    {
        if (!is_dir($dir)) {
            return;
        }
        foreach (scandir($dir) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            $path = $dir . DIRECTORY_SEPARATOR . $entry;
            if (is_dir($path)) {
                $this->removeDir($path);
            } else {
                @unlink($path);
            }
        }
        @rmdir($dir);
    }
}

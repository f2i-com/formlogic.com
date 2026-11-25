<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\ExternalAppApiController;
use FormLogic\Controllers\MarketplaceController;
use FormLogic\Controllers\ResponseController;
use FormLogic\Services\{
    AppService,
    ChatToolDeniedException,
    ChatToolsContext,
    ChatToolsService,
    CloudFlowRunner,
    FlowService,
    FormEncryptionService,
    FormService,
    MarketplaceCommerceService,
    MarketplaceSandboxService,
    McpDeviceAuthService,
    MemberPluginService,
    NativeAppService,
    NativeRecordEventRouter,
    NativeTableFormBridge,
    PackCatalogService,
    PlanService,
    PublicFormDraftService,
    PublicFormMcpService,
    ResponseService
};
use FormLogic\Support\AdminActingLimits;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response as SlimResponse;

final class Pass5SecurityRegressionTest extends TestCase
{
    public function testAdminActingLimitsRefusesOpenSelfRegAndPublicNativePublish(): void
    {
        $draftApp = ['status' => 'draft', 'settings' => []];

        // Publishing a draft app whose open self-registration grants record viewing is refused.
        $this->assertNotNull(AdminActingLimits::appPublishRefusal(
            'published',
            $draftApp,
            null,
            true,
            'members'
        ));

        // Publishing a draft app with public native access ('application' / 'public') is refused.
        $this->assertNotNull(AdminActingLimits::appPublishRefusal(
            'published',
            $draftApp,
            null,
            false,
            'application'
        ));

        // Publishing a members-only draft app with no public external API or record-viewing self-reg is allowed.
        $this->assertNull(AdminActingLimits::appPublishRefusal(
            'published',
            $draftApp,
            null,
            false,
            'members'
        ));
    }

    public function testExternalAppApiRejectsQueryFragmentSmugglingAndAccessGatedPublicRoutes(): void
    {
        $app = [
            'id' => 'app-ext-p5',
            'ownerId' => 'owner-1',
            'name' => 'Gated API',
            'slug' => 'gated-api',
            'status' => 'published',
            'settings' => [
                'softnApp' => true,
                'externalApi' => [
                    'enabled' => true,
                    'authMode' => 'both',
                    'allowedMethods' => ['GET'],
                    'allowedPaths' => ['/api/public'],
                    'blockedPaths' => ['/api/public/secret'],
                    'defaultPrefix' => '/api',
                ],
            ],
        ];

        $apps = $this->createMock(AppService::class);
        $apps->method('getApp')->willReturnCallback(function (string $id) use (&$app) { return $id === 'app-ext-p5' ? $app : null; });
        $apps->method('getAppBySlug')->willReturnCallback(function (string $s) use (&$app) { return $s === 'gated-api' ? $app : null; });
        $apps->method('sharedDatabaseGroupAppIds')->willReturn(['app-ext-p5']);

        $native = $this->createMock(NativeAppService::class);
        $native->method('project')->willReturn([
            'version' => 1,
            'files' => [
                'manifest.json' => json_encode([
                    'name' => 'Gated API',
                    'backend' => ['runtime' => 'php', 'entry' => 'server/index.php', 'routes' => ['/api']],
                ]),
            ],
        ]);
        $native->expects($this->never())->method('containerRequest');

        $flows = $this->createMock(FlowService::class);
        $flows->method('nativeRecordSubscriptionsForApps')->willReturn([]);
        $plans = $this->createMock(PlanService::class);
        $plans->method('isEnforced')->willReturn(false);

        $controller = new ExternalAppApiController(
            $apps,
            $native,
            $flows,
            $this->createMock(CloudFlowRunner::class),
            $plans,
            $this->createMock(NativeRecordEventRouter::class),
        );
        $rf = new ServerRequestFactory();

        // Raw ?, #, ;, encoded %3f / %23 / %252e, backslash must all be refused (400).
        foreach ([
            '/api/public?x=1',
            '/api/public#frag',
            '/api/public;matrix=1',
            '/api/public%3Ffoo=1',
            '/api/public%23frag',
            '/api/public/%252e%252e/admin',
            '/api/public\\secret',
        ] as $smuggledPath) {
            $req = $rf->createServerRequest('POST', '/api/v1/apps/gated-api/invoke')
                ->withAttribute('userId', 'owner-1')
                ->withParsedBody(['method' => 'GET', 'path' => $smuggledPath]);
            $res = $controller->invokeApp($req, new SlimResponse(), ['appId' => 'gated-api']);
            $this->assertSame(400, $res->getStatusCode(), "Path should be rejected: {$smuggledPath}");
        }

        // Public API routes must refuse when the app configures access-gate requirements.
        $app['settings']['requires'] = [[
            'plugin' => 'formlogic.age-gate',
            'kind' => 'age',
            'min' => 18,
            'strength' => 'verified',
        ]];
        $reqPub = $rf->createServerRequest('GET', '/api/public/apps/gated-api/routes/api/public');
        $resPub = $controller->publicRouteApp($reqPub, new SlimResponse(), ['appId' => 'gated-api', 'path' => 'api/public']);
        $this->assertSame(403, $resPub->getStatusCode());
        $payload = json_decode((string) $resPub->getBody(), true);
        $this->assertSame('access_gate_required', $payload['code'] ?? null);
    }

    public function testNativeRecordEventRouterRedactsHiddenCredentialColumns(): void
    {
        $dirty = [
            'table' => 'members',
            'record' => [
                'id' => 1,
                'name' => 'Alice',
                'password_hash' => 'secret-hash',
                'api_secret' => 'sk_live_123',
                'session_token' => 'tok_xyz',
            ],
            'before' => ['id' => 1, 'auth_token' => 'old-tok', 'email' => 'a@example.com'],
            'after' => ['id' => 1, 'refresh_token' => 'new-tok', 'email' => 'a@example.com'],
            'previous' => ['id' => 1, 'private_key' => 'pem', 'role' => 'member'],
        ];

        $clean = NativeRecordEventRouter::redactHiddenRecordColumns($dirty);

        $this->assertSame(['id' => 1, 'name' => 'Alice'], $clean['record']);
        $this->assertSame(['id' => 1, 'email' => 'a@example.com'], $clean['before']);
        $this->assertSame(['id' => 1, 'email' => 'a@example.com'], $clean['after']);
        $this->assertSame(['id' => 1, 'role' => 'member'], $clean['previous']);
    }

    public function testNativeTableFormBridgeProtectsSubmitterColumns(): void
    {
        $pdo = new \PDO('sqlite::memory:');
        $native = $this->createMock(NativeAppService::class);
        $bridge = new NativeTableFormBridge($pdo, $native);

        $schema = [
            'primaryKey' => ['id'],
            'fields' => [
                ['name' => 'id', 'type' => 'INTEGER', 'auto' => true, 'readOnly' => true, 'required' => false],
                ['name' => 'title', 'type' => 'TEXT', 'auto' => false, 'readOnly' => false, 'required' => true],
                ['name' => 'status', 'type' => 'TEXT', 'auto' => false, 'readOnly' => false, 'required' => false],
                ['name' => '_submitted_by_user_id', 'type' => 'TEXT', 'auto' => false, 'readOnly' => false, 'required' => false],
                ['name' => 'submitted_by_user_id', 'type' => 'TEXT', 'auto' => false, 'readOnly' => false, 'required' => false],
            ],
            'canCreate' => true,
        ];

        $def = NativeTableFormBridge::buildFormDefinitionFromTable('app-1', 'tickets', $schema);
        $fieldIds = array_column($def['fields'], 'id');
        $this->assertContains('title', $fieldIds);
        $this->assertNotContains('_submitted_by_user_id', $fieldIds);
        $this->assertNotContains('submitted_by_user_id', $fieldIds);

        // Even if a crafted binding maps submitter columns, mapAnswersToColumns always strips them.
        $binding = [
            'appId' => 'app-1',
            'table' => 'tickets',
            'primaryKey' => ['id'],
            'columns' => [
                'title' => 'title',
                '_submitted_by_user_id' => '_submitted_by_user_id',
                'submitted_by_user_id' => 'submitted_by_user_id',
            ],
            'statusColumn' => 'status',
            'createdAtColumn' => null,
            'updatedAtColumn' => null,
        ];
        $fieldsByName = [];
        foreach ($schema['fields'] as $f) {
            $fieldsByName[$f['name']] = $f;
        }
        $ref = new \ReflectionMethod(NativeTableFormBridge::class, 'mapAnswersToColumns');
        $ref->setAccessible(true);

        $createMapped = $ref->invoke($bridge, $binding, [
            'title' => 'Hello',
            '_submitted_by_user_id' => 'victim-id',
            'submitted_by_user_id' => 'victim-id',
        ], $fieldsByName, false);
        $this->assertSame(['title' => 'Hello'], $createMapped);

        $updateMapped = $ref->invoke($bridge, $binding, [
            'title' => 'Updated',
            '_submitted_by_user_id' => 'victim-id',
            'submitted_by_user_id' => 'victim-id',
        ], $fieldsByName, true);
        $this->assertSame(['title' => 'Updated'], $updateMapped);
    }

    public function testChatToolsServiceBlocksDynamicNativeRecordOpAndUnscopedFormNodes(): void
    {
        $svc = (new \ReflectionClass(ChatToolsService::class))->newInstanceWithoutConstructor();
        $ctx = new ChatToolsContext(
            userId: 'user-1',
            scopedAppId: 'app-1',
            creatorMode: false,
            requireScope: static function (string $scope): void {
                if (!in_array($scope, ['flows:write'], true)) {
                    throw new ChatToolDeniedException("Missing scope: {$scope}", 'insufficient_scope');
                }
            },
        );

        // 1. Dynamic operation expression in native_record_action is blocked from chat.
        try {
            $svc->callChatTool('create_flow', [
                'appId' => 'app-1',
                'flowJson' => [
                    'nodes' => [
                        ['id' => 'n1', 'type' => 'native_record_action', 'data' => ['operation' => '{{input.op}}']],
                    ],
                ],
            ], $ctx);
            $this->fail('Expected ChatToolDeniedException for dynamic native_record_action operation');
        } catch (ChatToolDeniedException $e) {
            $this->assertSame('delete_refused', $e->getReasonCode());
        }

        // 2. Flow with formlogic_list_responses requires responses:read scope.
        $assertGraph = new \ReflectionMethod(ChatToolsService::class, 'assertFlowGraphPermitted');
        $assertGraph->setAccessible(true);
        try {
            $assertGraph->invoke($svc, [
                'flowJson' => [
                    'nodes' => [
                        ['id' => 'n1', 'type' => 'formlogic_list_responses', 'data' => ['formId' => 'f1']],
                    ],
                ],
            ], 'app-1', $ctx);
            $this->fail('Expected ChatToolDeniedException when token lacks responses:read');
        } catch (ChatToolDeniedException $e) {
            $this->assertSame('insufficient_scope', $e->getReasonCode());
        }

        // 3. Flow declaring nodeCapabilities formlogic.responses.write requires responses:write scope.
        try {
            $assertGraph->invoke($svc, [
                'nodeCapabilities' => ['formlogic.responses.write'],
                'flowJson' => ['nodes' => []],
            ], 'app-1', $ctx);
            $this->fail('Expected ChatToolDeniedException when token lacks responses:write');
        } catch (ChatToolDeniedException $e) {
            $this->assertSame('insufficient_scope', $e->getReasonCode());
        }
    }

    public function testMarketplaceDemoUiEventSanitizesInputsBeforeForwarding(): void
    {
        $catalog = $this->createMock(PackCatalogService::class);
        $catalog->method('getCatalogBySlug')->willReturn([
            'id' => 'cat-1',
            'slug' => 'demo-pack',
            'visibility' => 'public',
            'status' => 'published',
        ]);

        $captured = null;
        $sandbox = $this->createMock(MarketplaceSandboxService::class);
        $sandbox->method('handleUiEvent')->willReturnCallback(function (array $cat, string $token, array $event) use (&$captured) {
            $captured = $event;
            return ['ok' => true];
        });

        $controller = new MarketplaceController(
            $catalog,
            $this->createMock(AppService::class),
            $this->createMock(NativeAppService::class),
            $sandbox,
            $this->createMock(MarketplaceCommerceService::class),
            $this->createMock(MemberPluginService::class),
        );
        $rf = new ServerRequestFactory();
        $req = $rf->createServerRequest('POST', '/api/packs/catalog/demo-pack/demo/ui-event')
            ->withParsedBody([
                'token' => 'tok-123',
                'type' => 'click',
                'actionId' => 'submit',
                'value' => ['nested' => 'object'],
                'inputs' => [
                    'name' => 'Alice',
                    'count' => 3,
                    'flag' => true,
                    '__proto__' => 'bad',
                    'constructor' => 'bad',
                    'prototype' => 'bad',
                    'nested' => ['a' => 1],
                ],
            ]);

        $res = $controller->demoUiEvent($req, new SlimResponse(), ['slug' => 'demo-pack']);
        $this->assertSame(200, $res->getStatusCode());
        $this->assertIsArray($captured);
        $this->assertSame('', $captured['value']);
        $this->assertSame(['name' => 'Alice', 'count' => 3, 'flag' => true], $captured['inputs']);
    }

    public function testPublicFormMcpServiceRefusesPlaintextDraftAndValidationForPrivateForms(): void
    {
        $privateForm = [
            'id' => 'priv-form-1',
            'title' => 'Private Intake',
            'status' => 'published',
            'fields' => [
                ['id' => 'secret', 'type' => 'short_text', 'label' => 'Secret', 'required' => true],
            ],
            'settings' => [],
        ];

        $forms = $this->createMock(FormService::class);
        $forms->method('getForm')->with('priv-form-1')->willReturn($privateForm);
        $apps = $this->createMock(AppService::class);
        $apps->method('isFormInAnyApp')->with('priv-form-1')->willReturn(false);

        $pdo = new \PDO('sqlite::memory:');
        $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
        $pdo->exec('CREATE TABLE form_encryption (form_id TEXT PRIMARY KEY, state TEXT NOT NULL)');
        $pdo->exec("INSERT INTO form_encryption (form_id, state) VALUES ('priv-form-1', 'active')");
        FormEncryptionService::invalidateCache('priv-form-1');
        $encryption = new FormEncryptionService($pdo);

        $drafts = $this->createMock(PublicFormDraftService::class);
        $drafts->expects($this->never())->method('saveDraft');
        $drafts->expects($this->never())->method('getDraft');

        $svc = new PublicFormMcpService(
            $forms,
            $apps,
            $this->createMock(ResponseService::class),
            $drafts,
            $this->createMock(McpDeviceAuthService::class),
            $this->createMock(ResponseController::class),
            $encryption,
        );

        $req = (new ServerRequestFactory())->createServerRequest('POST', '/api/mcp/public');
        try {
            try {
                $svc->validateAnswersPayload('priv-form-1', ['secret' => 'ssn-123']);
                $this->fail('Expected RuntimeException for private form validateAnswersPayload');
            } catch (\RuntimeException $e) {
                $this->assertStringContainsString('end-to-end encrypted', strtolower($e->getMessage()));
            }

            try {
                $svc->saveDraftPayload('priv-form-1', ['secret' => 'ssn-123'], 0, null, null, $req);
                $this->fail('Expected RuntimeException for private form saveDraftPayload');
            } catch (\RuntimeException $e) {
                $this->assertStringContainsString('end-to-end encrypted', strtolower($e->getMessage()));
            }

            try {
                $svc->getDraftPayload('priv-form-1', 'draft-tok-1', $req);
                $this->fail('Expected RuntimeException for private form getDraftPayload');
            } catch (\RuntimeException $e) {
                $this->assertStringContainsString('end-to-end encrypted', strtolower($e->getMessage()));
            }
        } finally {
            FormEncryptionService::invalidateCache('priv-form-1');
        }
    }
}

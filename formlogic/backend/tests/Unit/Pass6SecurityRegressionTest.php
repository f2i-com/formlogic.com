<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\MarketplaceController;
use FormLogic\Helpers\PackCapabilities;
use FormLogic\Services\{
    AppReportService,
    AppService,
    ChatToolDeniedException,
    ChatToolsContext,
    ChatToolsService,
    FileStorageService,
    FormLogicService,
    FormService,
    MarketplaceCommerceService,
    MarketplaceSandboxService,
    MemberPluginService,
    NativeAppService,
    PackCatalogService,
    PackFileService,
    PackService
};
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response as SlimResponse;

final class Pass6SecurityRegressionTest extends TestCase
{
    public function testFileStorageRejectsUnderscoreOnlyFormIds(): void
    {
        $tmpDir = sys_get_temp_dir() . '/fl-pass6-files-' . bin2hex(random_bytes(4));
        mkdir($tmpDir, 0700, true);
        $sampleFile = $tmpDir . '/sample.txt';
        file_put_contents($sampleFile, 'hello world');
        try {
            $svc = new FileStorageService([
                'storagePath' => $tmpDir,
                'allowedTypes' => ['text/plain'],
                'maxFileSize' => 1024 * 1024,
            ]);
            try {
                $svc->storeFile('___', [
                    'tmp_name' => $sampleFile,
                    'name' => 'sample.txt',
                    'size' => 11,
                    'error' => UPLOAD_ERR_OK,
                ]);
                $this->fail('Expected InvalidArgumentException for underscore-only formId');
            } catch (\InvalidArgumentException $e) {
                $this->assertStringContainsString('Invalid form id', $e->getMessage());
            }
            $this->assertSame(0, $svc->bytesForForms(['_', '___']));
        } finally {
            @unlink($sampleFile);
            @rmdir($tmpDir);
        }
    }

    public function testPackFileServiceReadEntryBoundedRejectsOversizedInflatedEntry(): void
    {
        $zipPath = sys_get_temp_dir() . '/fl-pass6-zip-' . bin2hex(random_bytes(4)) . '.zip';
        $zip = new \ZipArchive();
        $this->assertTrue($zip->open($zipPath, \ZipArchive::CREATE | \ZipArchive::OVERWRITE) === true);
        $zip->addFromString('small.txt', 'ok');
        $zip->addFromString('big.txt', str_repeat('A', 4096));
        $zip->close();

        try {
            $reader = new \ZipArchive();
            $this->assertTrue($reader->open($zipPath) === true);
            $this->assertSame('ok', PackFileService::readEntryBounded($reader, 'small.txt', 100));
            $this->assertNull(PackFileService::readEntryBounded($reader, 'missing.txt', 100));
            try {
                PackFileService::readEntryBounded($reader, 'big.txt', 1024, 'big.txt');
                $this->fail('Expected RuntimeException when inflated entry exceeds cap');
            } catch (\RuntimeException $e) {
                $this->assertStringContainsString('exceeds the maximum allowed size', $e->getMessage());
            } finally {
                $reader->close();
            }
        } finally {
            @unlink($zipPath);
        }
    }

    public function testPackCapabilitiesSurfacesFlowNodesCallSpeakAndFormLogicScript(): void
    {
        $caps = PackCapabilities::describe([
            'forms' => [
                ['packFormId' => 'f1', 'title' => 'T', 'logicScript' => 'function onSubmit(ctx) { return {}; }'],
            ],
            'apps' => [['packAppId' => 'a1', 'name' => 'App']],
            'flows' => [[
                'slug' => 'notify',
                'flowJson' => [
                    'nodes' => [
                        ['id' => 'n1', 'type' => 'connector_request', 'data' => ['connectorId' => 'aokie', 'command' => 'sms.send']],
                        ['id' => 'n2', 'type' => 'aokie_speak', 'data' => ['text' => 'hi']],
                    ],
                ],
            ]],
            'flowBindings' => [[
                'flow' => 'notify',
                'outputActions' => [
                    ['type' => 'call.speak', 'message' => 'hello'],
                ],
            ]],
        ]);

        $this->assertSame(1, $caps['logicScripts']);
        $this->assertTrue($caps['hasCustomLogic']);
        $this->assertContains('connector.aokie.sms.send', $caps['connectorGrants']);
        $this->assertContains('connector.aokie.speak', $caps['connectorGrants']);
        $this->assertContains('aokie', $caps['connectors']);
    }

    public function testResolveFlowJsonFormRefsDropsRawUuidsAndKeepsSelectors(): void
    {
        $packs = (new \ReflectionClass(PackService::class))->newInstanceWithoutConstructor();
        $resolved = $packs->resolveFlowJsonFormRefs([
            'nodes' => [
                ['id' => 'n1', 'type' => 'formlogic_list_responses', 'data' => ['formId' => '@pack:leads']],
                ['id' => 'n2', 'type' => 'formlogic_list_responses', 'data' => ['form' => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee']],
                ['id' => 'n3', 'type' => 'formlogic_list_responses', 'data' => ['formId' => '$inputs.formId']],
            ],
            'edges' => [],
        ], ['leads' => 'new-form-uuid'], 'sync-leads');

        $this->assertSame('new-form-uuid', $resolved['nodes'][0]['data']['formId']);
        $this->assertArrayNotHasKey('form', $resolved['nodes'][1]['data']);
        $this->assertSame('$inputs.formId', $resolved['nodes'][2]['data']['formId']);
    }

    public function testAppReportServiceFormFieldMapExcludesCrossTenantTargetForms(): void
    {
        $forms = $this->createMock(FormService::class);
        $forms->method('getForm')->with('form-owner-a')->willReturn([
            'id' => 'form-owner-a',
            'userId' => 'user-a',
            'fields' => [
                ['id' => 'link_own', 'type' => 'linked_record', 'properties' => ['targetFormId' => 'form-own-2']],
                ['id' => 'link_foreign', 'type' => 'linked_record', 'properties' => ['targetFormId' => 'form-owner-b']],
            ],
        ]);
        $forms->method('getFormsByIds')->with(['form-own-2', 'form-owner-b'])->willReturn([
            'form-own-2' => [
                'id' => 'form-own-2',
                'userId' => 'user-a',
                'fields' => [['id' => 'own_field', 'type' => 'short_text']],
            ],
            'form-owner-b' => [
                'id' => 'form-owner-b',
                'userId' => 'user-b',
                'fields' => [['id' => 'secret_field', 'type' => 'short_text']],
            ],
        ]);

        $svc = (new \ReflectionClass(AppReportService::class))->newInstanceWithoutConstructor();
        $prop = new \ReflectionProperty(AppReportService::class, 'formService');
        $prop->setAccessible(true);
        $prop->setValue($svc, $forms);

        $map = $svc->formFieldMap('form-owner-a');
        $this->assertArrayHasKey('form-owner-a', $map);
        $this->assertArrayHasKey('form-own-2', $map);
        $this->assertArrayNotHasKey('form-owner-b', $map);
    }

    public function testMarketplaceDemoBackendRequestSanitizesActiveContentTypes(): void
    {
        $catalog = $this->createMock(PackCatalogService::class);
        $catalog->method('getCatalogBySlug')->willReturn([
            'id' => 'cat-1',
            'slug' => 'demo-pack',
            'visibility' => 'public',
            'status' => 'published',
        ]);
        $sandbox = $this->createMock(MarketplaceSandboxService::class);
        $sandbox->method('handleBackendRequest')->willReturn([
            'isRaw' => true,
            'status' => 200,
            'contentType' => "text/html; charset=utf-8\r\nX-Injected: 1",
            'body' => '<html><script>alert(1)</script></html>',
        ]);

        $controller = new MarketplaceController(
            $catalog,
            $this->createMock(AppService::class),
            $this->createMock(NativeAppService::class),
            $sandbox,
            $this->createMock(MarketplaceCommerceService::class),
            $this->createMock(MemberPluginService::class),
        );
        $rf = new ServerRequestFactory();
        $req = $rf->createServerRequest('POST', '/api/packs/catalog/demo-pack/demo/request')
            ->withParsedBody(['token' => 'tok-123', 'method' => 'GET', 'path' => '/api/hello']);

        $res = $controller->demoBackendRequest($req, new SlimResponse(), ['slug' => 'demo-pack']);
        $this->assertSame(200, $res->getStatusCode());
        $this->assertSame('application/octet-stream', $res->getHeaderLine('Content-Type'));
        $this->assertSame('nosniff', $res->getHeaderLine('X-Content-Type-Options'));
        $this->assertStringContainsString('attachment', $res->getHeaderLine('Content-Disposition'));
    }

    public function testChatToolsBlocksNativeAppDeleteDynamicFlowCallAndReadViaWrite(): void
    {
        $svc = (new \ReflectionClass(ChatToolsService::class))->newInstanceWithoutConstructor();
        $ctx = new ChatToolsContext(
            userId: 'user-1',
            scopedAppId: 'app-1',
            creatorMode: false,
            requireScope: static function (string $scope): void {
                if (!in_array($scope, ['apps:write', 'responses:write'], true)) {
                    throw new ChatToolDeniedException("Missing scope: {$scope}", 'insufficient_scope');
                }
            },
        );

        // 1. Site chat blocks DELETE native_app_request.
        try {
            $svc->callChatTool('create_flow', [
                'appId' => 'app-1',
                'flowJson' => [
                    'nodes' => [
                        ['id' => 'n1', 'type' => 'native_app_request', 'data' => ['method' => 'DELETE', 'path' => '/api/items/1']],
                    ],
                ],
            ], $ctx);
            $this->fail('Expected ChatToolDeniedException for DELETE native_app_request in chat');
        } catch (ChatToolDeniedException $e) {
            $this->assertSame('delete_refused', $e->getReasonCode());
        }

        // 2. Site chat blocks dynamic flow_call target.
        try {
            $svc->callChatTool('create_flow', [
                'appId' => 'app-1',
                'flowJson' => [
                    'nodes' => [
                        ['id' => 'n1', 'type' => 'flow_call', 'data' => ['flowId' => '{{input.target}}']],
                    ],
                ],
            ], $ctx);
            $this->fail('Expected ChatToolDeniedException for dynamic flow_call target in chat');
        } catch (ChatToolDeniedException $e) {
            $this->assertSame('delete_refused', $e->getReasonCode());
        }

        // 3. Write-only token (has responses:write, lacks responses:read) cannot author native_record_action(update).
        $assertGraph = new \ReflectionMethod(ChatToolsService::class, 'assertFlowGraphPermitted');
        $assertGraph->setAccessible(true);
        try {
            $assertGraph->invoke($svc, [
                'flowJson' => [
                    'nodes' => [
                        ['id' => 'n1', 'type' => 'native_record_action', 'data' => ['operation' => 'update', 'table' => 'orders']],
                    ],
                ],
            ], 'app-1', $ctx);
            $this->fail('Expected ChatToolDeniedException when token lacks responses:read for update');
        } catch (ChatToolDeniedException $e) {
            $this->assertSame('insufficient_scope', $e->getReasonCode());
        }

        // 4. Write-only token cannot author POST native_app_request (returns backend response body).
        try {
            $assertGraph->invoke($svc, [
                'flowJson' => [
                    'nodes' => [
                        ['id' => 'n1', 'type' => 'native_app_request', 'data' => ['method' => 'POST', 'path' => '/api/orders']],
                    ],
                ],
            ], 'app-1', $ctx);
            $this->fail('Expected ChatToolDeniedException when token lacks responses:read for POST native_app_request');
        } catch (ChatToolDeniedException $e) {
            $this->assertSame('insufficient_scope', $e->getReasonCode());
        }
    }

    public function testSandboxEvaluateBatchHandlesLoneUtf16SurrogateWithoutFailingBatch(): void
    {
        $service = new FormLogicService();
        $results = $service->evaluateBatch([
            ['id' => 'safe', 'expression' => '1 + 1'],
            ['id' => 'sliced', 'expression' => '"\uD83D\uDE00".slice(0, 1)'],
        ], []);
        if ($results === []) {
            $this->markTestSkipped('ZIPP sandbox runtime not available on this host');
        }
        $this->assertTrue($results['safe']['ok'] ?? false);
        $this->assertSame(2, $results['safe']['value'] ?? null);
        $this->assertTrue($results['sliced']['ok'] ?? false);
        $this->assertSame("\u{FFFD}", $results['sliced']['value'] ?? null);
    }
}

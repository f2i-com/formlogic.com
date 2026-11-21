<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\PackCatalogController;
use FormLogic\Middleware\SecurityHeadersMiddleware;
use FormLogic\Services\MarketplaceSandboxService;
use FormLogic\Services\NativeAppService;
use FormLogic\Services\PackCatalogService;
use FormLogic\Services\PackFileService;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response as SlimResponse;

final class MarketplaceSandboxAndPluginsTest extends TestCase
{
    private string $tmpRoot;
    private NativeAppService $native;
    private MarketplaceSandboxService $sandbox;

    protected function setUp(): void
    {
        $this->tmpRoot = sys_get_temp_dir() . '/fl-mkt-test-' . bin2hex(random_bytes(8));
        mkdir($this->tmpRoot . '/native', 0700, true);
        mkdir($this->tmpRoot . '/sandboxes', 0700, true);
        $this->native = new NativeAppService($this->tmpRoot . '/native');
        $this->sandbox = new MarketplaceSandboxService($this->native, $this->tmpRoot . '/sandboxes', 'test-secret-key-for-unit-tests');
    }

    protected function tearDown(): void
    {
        if (is_dir($this->tmpRoot)) {
            $it = new \RecursiveIteratorIterator(
                new \RecursiveDirectoryIterator($this->tmpRoot, \FilesystemIterator::SKIP_DOTS),
                \RecursiveIteratorIterator::CHILD_FIRST
            );
            foreach ($it as $entry) {
                if ($entry->isLink() || !$entry->isDir()) {
                    @unlink($entry->getPathname());
                } else {
                    @rmdir($entry->getPathname());
                }
            }
            @rmdir($this->tmpRoot);
        }
    }

    public function testExtractProjectFromSoftnArchiveStripsWrapperFolderAndValidates(): void
    {
        $zipPath = $this->tmpRoot . '/sample.softn';
        $starter = NativeAppService::starterProject('Archive Notes', 'arch-1', 'classic');
        $zip = new \ZipArchive();
        self::assertTrue($zip->open($zipPath, \ZipArchive::CREATE) === true);
        foreach ($starter['files'] as $rel => $content) {
            $zip->addFromString('archive-notes/' . $rel, $content);
        }
        $zip->close();

        $extracted = NativeAppService::extractProjectFromArchive($zipPath);
        self::assertArrayHasKey('manifest.json', $extracted['files']);
        self::assertArrayHasKey('ui/main.ui', $extracted['files']);
        self::assertArrayHasKey('server/main.logic', $extracted['files']);
    }

    public function testClassicSoftnDomSsrHidesAllSourceAndIsolatesVisitorBackends(): void
    {
        if (!$this->native->available()) {
            self::markTestSkipped('Native SoftN runtime not prepared in this environment.');
        }

        $starter = NativeAppService::starterProject('Private Notes Pro', 'cat-classic-1', 'classic');
        $installed = $this->sandbox->installPrivateBundle('cat-classic-1', $starter);
        self::assertSame('dom_ssr', $installed['meta']['renderMode']);
        self::assertTrue($installed['meta']['hasBackend']);
        self::assertSame('logic', $installed['meta']['backendRuntime']);

        $catalog = [
            'id' => 'cat-classic-1',
            'slug' => 'private-notes-pro',
            'source_visibility' => 'private',
            'demo_enabled' => 1,
            'demo_app_id' => $installed['demoAppId'],
        ];

        $sessionA = $this->sandbox->createSession($catalog);
        $sessionB = $this->sandbox->createSession($catalog);
        self::assertSame('dom_ssr', $sessionA['renderMode']);
        self::assertTrue($sessionA['sourceProtected']);
        self::assertNotSame($sessionA['token'], $sessionB['token']);

        // Render initial DOM for visitor A — ZERO source code may leak
        $frame = $this->sandbox->renderFrame($catalog, $sessionA['token'], '', 'http://localhost:5173');
        self::assertSame(200, $frame['status']);
        self::assertStringContainsString('Private Notes Pro', $frame['body']);
        self::assertStringContainsString('Save example item', $frame['body']);
        self::assertStringContainsString('Ready to save your first item', $frame['body']);
        self::assertStringContainsString('data-fl-click="a0"', $frame['body']);

        // Strict zero-source-leak assertions
        foreach (['<App>', '<Stack', '<logic>', 'saveItem', 'createItem', 'softn.net.fetch', 'softn.sql.execute', 'CREATE TABLE items', 'server/main.logic'] as $secret) {
            self::assertStringNotContainsString($secret, $frame['body'], "Rendered DOM leaked private source token: {$secret}");
        }

        // Direct requests for raw project files inside the demo frame must 404
        foreach (['manifest.json', 'ui/main.ui', 'server/main.logic', 'server/migrations/001.sql'] as $blocked) {
            $denied = $this->sandbox->renderFrame($catalog, $sessionA['token'], $blocked, 'http://localhost:5173');
            self::assertSame(404, $denied['status'], "Private file {$blocked} must not be served by demo frame");
        }

        // Visitor A clicks the server-registered opaque action a0 -> invokes isolated backend SQLite DB!
        $ev = $this->sandbox->handleUiEvent($catalog, $sessionA['token'], [
            'type' => 'click',
            'actionId' => 'a0',
            'inputs' => [],
        ]);
        self::assertSame(1, $ev['backendCalls']);
        self::assertStringContainsString('Item saved in your app database', $ev['html']);
        self::assertStringNotContainsString('saveItem', $ev['html']);

        // Visitor A sees the saved row via backend; Visitor B's isolated DB is still empty!
        $listA = $this->sandbox->handleBackendRequest($catalog, $sessionA['token'], ['method' => 'GET', 'path' => '/api/items']);
        self::assertSame(200, $listA['status']);
        self::assertCount(1, $listA['body']['items']);
        self::assertSame('My first item', $listA['body']['items'][0]['title']);

        $listB = $this->sandbox->handleBackendRequest($catalog, $sessionB['token'], ['method' => 'GET', 'path' => '/api/items']);
        self::assertSame(200, $listB['status']);
        self::assertCount(0, $listB['body']['items']);

        // Resetting Visitor A wipes ephemeral SQLite rows and UI state cleanly
        $reset = $this->sandbox->resetSession($catalog, $sessionA['token']);
        self::assertTrue($reset['reset']);
        $listAfterReset = $this->sandbox->handleBackendRequest($catalog, $sessionA['token'], ['method' => 'GET', 'path' => '/api/items']);
        self::assertSame(200, $listAfterReset['status']);
        self::assertCount(0, $listAfterReset['body']['items']);
    }

    public function testWebAppSandboxWithholdsBackendFilesStripsSourceMapsAndRunsBackend(): void
    {
        if (!$this->native->available()) {
            self::markTestSkipped('Native SoftN runtime not prepared in this environment.');
        }

        $starter = NativeAppService::starterProject('Web Inventory', 'cat-web-1', 'javascript');
        $starter['files']['app.js'] .= "\n//# sourceMappingURL=app.js.map\n";
        $installed = $this->sandbox->installPrivateBundle('cat-web-1', $starter);
        self::assertSame('sandbox_web', $installed['meta']['renderMode']);

        $catalog = [
            'id' => 'cat-web-1',
            'slug' => 'web-inventory',
            'source_visibility' => 'private',
            'demo_enabled' => 1,
            'demo_app_id' => $installed['demoAppId'],
        ];

        $session = $this->sandbox->createSession($catalog);
        $html = $this->sandbox->renderFrame($catalog, $session['token'], '', 'http://localhost:5173');
        self::assertSame(200, $html['status']);
        self::assertStringContainsString('"softn:api"', $html['body']);
        self::assertStringContainsString('__fl_softn_api.mjs', $html['body']);

        // Virtual softn:api bridge module works
        $shim = $this->sandbox->renderFrame($catalog, $session['token'], '__fl_softn_api.mjs', 'http://localhost:5173');
        self::assertSame(200, $shim['status']);
        self::assertStringContainsString('/api/packs/catalog/web-inventory/demo/request', $shim['body']);

        // sourceMappingURL is stripped from served JS
        $js = $this->sandbox->renderFrame($catalog, $session['token'], 'app.js', 'http://localhost:5173');
        self::assertSame(200, $js['status']);
        self::assertStringNotContainsString('sourceMappingURL', $js['body']);

        // Backend & manifest files are strictly blocked
        foreach (['manifest.json', 'server/main.logic', 'server/migrations/001.sql', 'app.js.map'] as $blocked) {
            $res = $this->sandbox->renderFrame($catalog, $session['token'], $blocked, 'http://localhost:5173');
            self::assertSame(404, $res['status'], "{$blocked} must never be served");
        }

        // Live backend write + read works against isolated ephemeral SQLite
        $create = $this->sandbox->handleBackendRequest($catalog, $session['token'], [
            'method' => 'POST',
            'path' => '/api/items',
            'body' => ['title' => 'Sandbox widget'],
        ]);
        self::assertSame(201, $create['status']);
        $list = $this->sandbox->handleBackendRequest($catalog, $session['token'], [
            'method' => 'GET',
            'path' => '/api/items',
        ]);
        self::assertSame(200, $list['status']);
        self::assertCount(1, $list['body']['items']);
        self::assertSame('Sandbox widget', $list['body']['items'][0]['title']);
    }

    public function testDemoFramePolicyIsStrictOpaqueSandboxAndPreservedByMiddleware(): void
    {
        $slug = 'demo-app';
        $token = 'sbx0123456789abcdef01234567-1999999999-0123456789abcdef0123456789abcdef';
        $demoApiPrefix = "/api/packs/catalog/{$slug}/demo/";
        $framePrefix = "{$demoApiPrefix}frame/{$token}/";
        $policy = MarketplaceSandboxService::demoFramePolicy('http://localhost:5173', $framePrefix, $demoApiPrefix);

        self::assertStringContainsString('sandbox allow-scripts allow-forms', $policy);
        self::assertStringNotContainsString('allow-same-origin', $policy);
        self::assertStringNotContainsString('allow-downloads', $policy);
        self::assertStringContainsString("connect-src http://localhost:5173{$demoApiPrefix} https://localhost:5173{$demoApiPrefix}", $policy);

        $request = (new ServerRequestFactory())
            ->createServerRequest('GET', "http://localhost:5173{$framePrefix}")
            ->withHeader('Host', 'localhost:5173');
        $handler = new class($policy) implements RequestHandlerInterface {
            public function __construct(private string $policy) {}
            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                return (new SlimResponse(200))->withHeader('Content-Security-Policy', $this->policy);
            }
        };

        $mw = new SecurityHeadersMiddleware(false);
        $response = $mw->process($request, $handler);
        self::assertSame($policy, $response->getHeaderLine('Content-Security-Policy'));
        self::assertFalse($response->hasHeader('X-Frame-Options'));
        self::assertSame('no-referrer', $response->getHeaderLine('Referrer-Policy'));
    }

    public function testPrivateSourceListingRefusesDownloadToNonPublisher(): void
    {
        $catalogService = $this->createMock(PackCatalogService::class);
        $catalogService->method('getCatalogBySlug')->with('paid-private-app')->willReturn([
            'id' => 'cat-priv-1',
            'slug' => 'paid-private-app',
            'publisher_id' => 'seller-1',
            'visibility' => 'public',
            'source_visibility' => 'private',
        ]);
        $fileService = $this->createMock(PackFileService::class);
        $controller = new PackCatalogController($catalogService, $fileService);

        $req = (new ServerRequestFactory())
            ->createServerRequest('GET', 'http://localhost:5173/api/packs/catalog/paid-private-app/download')
            ->withAttribute('userId', 'buyer-2');
        $res = $controller->download($req, new SlimResponse(), ['slug' => 'paid-private-app']);

        self::assertSame(403, $res->getStatusCode());
        $payload = json_decode((string) $res->getBody(), true);
        self::assertSame('source_private', $payload['code'] ?? null);
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\AppService;
use FormLogic\Services\CloudFlowRunner;
use FormLogic\Services\FlowService;
use FormLogic\Services\MarketplaceSandboxService;
use FormLogic\Services\MemberPluginService;
use FormLogic\Services\NativeAppService;
use FormLogic\Services\SoftnPackCatalog;
use PHPUnit\Framework\TestCase;

/**
 * A container backend is told the name and scheme its site is reached by on every way in, not only
 * from the app's own page and its API (NativeAppControllerTest, ExternalAppApiPolicyTest): a flow
 * that calls the backend from the cloud and a member's plugin say them too. Left out, the runner
 * tells a PHP backend it is http://localhost, and every absolute link it writes says so.
 */
final class ContainerRequestAddressTest extends TestCase
{
    private const CONTAINER = ['version' => 3, 'files' => ['manifest.json' => '{"name":"Shop","backend":{"runtime":"php","entry":"server/index.php"}}']];

    public function testTheAddressIsTheSitesNameAndWhetherItIsHttps(): void
    {
        $this->assertSame(['host' => 'forms.example.test', 'https' => true], NativeAppService::containerAddress('https://forms.example.test'));
        $this->assertSame(['host' => 'forms.example.test', 'https' => true], NativeAppService::containerAddress(' https://Forms.Example.test:443/app/ '));
        $this->assertSame(['host' => 'forms.example.test:8443', 'https' => true], NativeAppService::containerAddress('https://forms.example.test:8443'));
        $this->assertSame(['host' => 'localhost:5173', 'https' => false], NativeAppService::containerAddress('http://localhost:5173'));
        $this->assertSame(['host' => 'localhost', 'https' => false], NativeAppService::containerAddress('http://localhost:80'));
        $this->assertSame(['host' => '[::1]:8080', 'https' => false], NativeAppService::containerAddress('http://[::1]:8080'));
        // No address, or none a backend could be reached by: the request is left as it was.
        foreach (['', 'forms.example.test', 'ftp://forms.example.test', 'https://', 'https:///path', "https://forms.example.test\r\nx: y"] as $none) {
            $this->assertSame([], NativeAppService::containerAddress($none), $none);
        }
    }

    /** @return array{0: CloudFlowRunner, 1: \ArrayObject<int, array<string, mixed>>} */
    private function runner(string $siteBaseUrl): array
    {
        $sent = new \ArrayObject();
        $apps = $this->createMock(AppService::class);
        $apps->method('getApp')->willReturn(['id' => 'app-1', 'ownerId' => 'owner-1']);
        $apps->method('sharedDatabaseGroupAppIds')->willReturn(['app-1']);
        $native = $this->createMock(NativeAppService::class);
        $native->method('project')->willReturn(self::CONTAINER);
        // The call asks for a worker, and says first whose app it is (the account's share of them).
        $native->expects($this->atLeastOnce())->method('ownedBy')->with('app-1', 'owner-1');
        $native->method('containerRequest')->willReturnCallback(static function (string $appId, array $request) use ($sent): array {
            $sent[] = $request;
            return ['status' => 200, 'headers' => [['content-type', 'application/json']], 'bodyBase64' => base64_encode('{"ok":true}')];
        });
        $flows = $this->createMock(FlowService::class);
        $flows->method('nativeRecordSubscriptionsForApps')->willReturn([]);
        $runner = (new \ReflectionClass(CloudFlowRunner::class))->newInstanceWithoutConstructor();
        foreach (['apps' => $apps, 'nativeApps' => $native, 'flowService' => $flows, 'siteBaseUrl' => $siteBaseUrl] as $name => $value) {
            (new \ReflectionProperty(CloudFlowRunner::class, $name))->setValue($runner, $value);
        }
        return [$runner, $sent];
    }

    private static function call(CloudFlowRunner $runner): array
    {
        $node = ['id' => 'call', 'type' => 'native_app_request'];
        $data = ['appId' => 'app-1', 'method' => 'POST', 'path' => '/api/orders', 'body' => ['item' => 7]];
        return (new \ReflectionMethod(CloudFlowRunner::class, 'runNativeAppRequest'))->invoke($runner, $node, $data, [], ['id' => 'flow-1', 'appId' => 'app-1', 'ownerUserId' => 'owner-1'], 'owner-1');
    }

    public function testAFlowsCallTellsAContainerBackendTheSitesConfiguredAddress(): void
    {
        [$runner, $sent] = $this->runner('https://forms.example.test');
        $this->assertSame(200, self::call($runner)['status']);
        $this->assertSame('forms.example.test', $sent[0]['host'] ?? null);
        $this->assertTrue($sent[0]['https'] ?? null);
        $this->assertSame(['POST', '/api/orders', '127.0.0.1'], [$sent[0]['method'], $sent[0]['path'], $sent[0]['client_ip']]);

        [$local, $sentLocally] = $this->runner('http://localhost:8080');
        self::call($local);
        $this->assertSame(['localhost:8080', false], [$sentLocally[0]['host'] ?? null, $sentLocally[0]['https'] ?? null]);

        // A site with no address configured sends neither, as before.
        [$unnamed, $sentUnnamed] = $this->runner('');
        self::call($unnamed);
        $this->assertArrayNotHasKey('host', $sentUnnamed[0]);
        $this->assertArrayNotHasKey('https', $sentUnnamed[0]);
    }

    public function testAMembersPluginTellsItsContainerBackendTheAddressTheMemberCameBy(): void
    {
        $statement = $this->createMock(\PDOStatement::class);
        $statement->method('execute')->willReturn(true);
        $statement->method('fetch')->willReturn(['id' => 'plugin-1', 'user_id' => 'member-1', 'enabled' => 1, 'runtime_app_id' => 'mplg_plugin-1', 'settings_json' => '{}']);
        $pdo = $this->createMock(\PDO::class);
        $pdo->method('prepare')->willReturn($statement);
        $sent = [];
        $native = $this->createMock(NativeAppService::class);
        $native->method('project')->willReturn(self::CONTAINER);
        // A member's plugin runs for that member: its workers are counted in their share.
        $native->expects($this->exactly(2))->method('ownedBy')->with('mplg_plugin-1', 'member-1');
        $native->method('containerRequest')->willReturnCallback(static function (string $appId, array $request) use (&$sent): array {
            $sent[] = $request;
            return ['status' => 200, 'headers' => [], 'bodyBase64' => base64_encode('{"ok":true}')];
        });
        $service = (new \ReflectionClass(MemberPluginService::class))->newInstanceWithoutConstructor();
        (new \ReflectionProperty(MemberPluginService::class, 'pdo'))->setValue($service, $pdo);
        (new \ReflectionProperty(MemberPluginService::class, 'native'))->setValue($service, $native);

        $payload = ['method' => 'GET', 'path' => '/api/items'];
        $this->assertSame(['status' => 200, 'body' => ['ok' => true]], $service->invokePluginBackend('member-1', 'plugin-1', $payload, null, 'https://forms.example.test'));
        $this->assertSame(['forms.example.test', true], [$sent[0]['host'] ?? null, $sent[0]['https'] ?? null]);
        $this->assertSame(['GET', '/api/items'], [$sent[0]['method'], $sent[0]['path']]);

        // A caller that names no address (as every caller did) sends neither.
        $service->invokePluginBackend('member-1', 'plugin-1', $payload);
        $this->assertArrayNotHasKey('host', $sent[1]);
        $this->assertArrayNotHasKey('https', $sent[1]);
    }

    // ------------------------------------------------------------------ the marketplace's demos

    private string $sandboxes = '';

    protected function tearDown(): void
    {
        if ($this->sandboxes !== '' && is_dir($this->sandboxes)) {
            $it = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($this->sandboxes, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
            foreach ($it as $entry) {
                $entry->isDir() && !$entry->isLink() ? @rmdir($entry->getPathname()) : @unlink($entry->getPathname());
            }
            @rmdir($this->sandboxes);
        }
    }

    /**
     * The demos over a host that writes down, in order, each account it is told an app is for and
     * each call that asks for a worker: [what, appId, owner or request].
     *
     * @return array{0: MarketplaceSandboxService, 1: \ArrayObject<int, array{0: string, 1: string, 2: mixed}>}
     */
    private function demos(array $project): array
    {
        $this->sandboxes = sys_get_temp_dir() . '/fl-demo-address-' . bin2hex(random_bytes(6));
        mkdir($this->sandboxes, 0700, true);
        $calls = new \ArrayObject();
        $answer = ['status' => 200, 'headers' => [['content-type', 'application/json']], 'bodyBase64' => base64_encode('{"ok":true}')];
        $native = $this->createMock(NativeAppService::class);
        $native->method('project')->willReturnCallback(static fn (string $appId): ?array => $calls->count() === 0 && str_starts_with($appId, 'mkt_sbp_') ? null : $project);
        $native->method('ownedBy')->willReturnCallback(static function (string $appId, string $owner) use ($calls): void {
            $calls[] = ['ownedBy', $appId, $owner];
        });
        $native->method('install')->willReturnCallback(static function (string $appId) use ($calls): array {
            $calls[] = ['install', $appId, null];
            return ['version' => 1];
        });
        foreach (['containerRequest', 'sandboxRequest', 'sandboxContainerRequest'] as $method) {
            $native->method($method)->willReturnCallback(static function (string $appId, ...$rest) use ($calls, $method, $answer): array {
                $calls[] = [$method, $appId, array_values(array_filter($rest, 'is_array'))[0]];
                return $method === 'sandboxRequest' ? ['status' => 200, 'body' => ['ok' => true]] : $answer;
            });
        }
        $native->method('withSlots')->willReturnCallback(static function (string $appId) use ($calls): array {
            $calls[] = ['withSlots', $appId, null];
            return ['title' => 'Notes', 'html' => '<p>Notes</p>', 'css' => '', 'backendCalls' => 0];
        });
        return [new MarketplaceSandboxService($native, $this->sandboxes, 'demo-address-test-secret'), $calls];
    }

    /**
     * Every demo is the same account's app (MarketplaceSandboxService::DEMO_OWNER), named before
     * each call that asks for a worker, so all the site's demos together are held to one account's
     * share of the workers, as a member's apps are. Its container backend is told the address the
     * visitor came by, as an app's page tells it. Neither was said, and a demo's PHP backend wrote
     * http://localhost into every absolute link.
     */
    public function testADemosBackendIsToldTheVisitorsAddressAndCountedAsTheDemosAccount(): void
    {
        [$sandbox, $calls] = $this->demos(self::CONTAINER);
        $catalog = ['slug' => 'shop', 'demo_app_id' => 'mkt_shop', 'demo_enabled' => 1];
        $token = $sandbox->createSession($catalog)['token'];

        $this->assertSame(['ok' => true], $sandbox->handleBackendRequest($catalog, $token, ['method' => 'GET', 'path' => '/api/items'], 'https://forms.example.test')['body']);
        $this->assertSame(['ownedBy', 'mkt_shop', MarketplaceSandboxService::DEMO_OWNER], $calls[0]);
        $this->assertSame(['sandboxContainerRequest', 'mkt_shop'], [$calls[1][0], $calls[1][1]]);
        $this->assertSame(['forms.example.test', true, 'GET', '/api/items'], [$calls[1][2]['host'] ?? null, $calls[1][2]['https'] ?? null, $calls[1][2]['method'], $calls[1][2]['path']]);

        // A classic `.logic` demo is counted the same way.
        [$logic, $logicCalls] = $this->demos(['version' => 3, 'files' => ['manifest.json' => '{"name":"Notes","main":"index.html","server":{"routes":[{"path":"/api/items","method":"GET"}]}}']]);
        $logicToken = $logic->createSession($catalog)['token'];
        $this->assertSame(['ok' => true], $logic->handleBackendRequest($catalog, $logicToken, ['method' => 'GET', 'path' => '/api/items'])['body']);
        $this->assertSame([['ownedBy', 'mkt_shop', MarketplaceSandboxService::DEMO_OWNER], 'sandboxRequest'], [$logicCalls[0], $logicCalls[1][0]]);
    }

    public function testABundledDemosSetUpIsToldTheAddressAndCountedAsTheDemosAccount(): void
    {
        [$sandbox, $calls] = $this->demos(self::CONTAINER);
        $archive = $this->sandboxes . '/shop.softn';
        $zip = new \ZipArchive();
        $this->assertTrue($zip->open($archive, \ZipArchive::CREATE) === true);
        $files = [
            'manifest.json' => '{"name":"Shop","main":"index.html","backend":{"runtime":"php","entry":"server/index.php"}}',
            'index.html' => '<!doctype html><p>Shop</p>',
            'server/index.php' => '<?php echo "{}";',
        ];
        foreach ($files as $path => $text) {
            $zip->addFromString($path, $text);
        }
        $zip->close();

        $demoAppId = $sandbox->ensureBundledDemoInstalled('shop', $archive, 'Shop', 'http://localhost:8080');
        $this->assertSame(SoftnPackCatalog::demoAppIdFor('shop'), $demoAppId);
        // Named before the install, whose own check runs the backend, and before both set-up calls.
        $this->assertSame([['ownedBy', $demoAppId, MarketplaceSandboxService::DEMO_OWNER], ['install', $demoAppId, null]], [$calls[0], $calls[1]]);
        $this->assertSame(['containerRequest', 'containerRequest'], [$calls[2][0], $calls[3][0]]);
        foreach ([$calls[2][2], $calls[3][2]] as $setUp) {
            $this->assertSame(['localhost:8080', false], [$setUp['host'] ?? null, $setUp['https'] ?? null]);
        }
        $this->assertSame(['/api/setup', '/api/sample/load'], [$calls[2][2]['path'], $calls[3][2]['path']]);
    }

    /**
     * A classic demo is drawn on the server by a renderer that runs the app and its backend itself,
     * outside this site's host: it holds one of the demos' account's workers while it runs. It held
     * none, so any number of visitors drew pages at once.
     */
    public function testADemoDrawnOnTheServerHoldsAWorkerOfTheDemosAccount(): void
    {
        [$sandbox, $calls] = $this->demos(['version' => 3, 'files' => ['manifest.json' => '{"name":"Notes","main":"ui/main.ui","server":{"routes":[]}}', 'ui/main.ui' => '<App/>']]);
        $catalog = ['slug' => 'notes', 'demo_app_id' => 'mkt_notes', 'demo_enabled' => 1];
        $token = $sandbox->createSession($catalog)['token'];

        $page = $sandbox->renderFrame($catalog, $token, '', 'https://forms.example.test');
        $this->assertSame(200, $page['status']);
        $this->assertStringContainsString('<p>Notes</p>', $page['body']);
        $this->assertSame([['ownedBy', 'mkt_notes', MarketplaceSandboxService::DEMO_OWNER], ['withSlots', 'mkt_notes', null]], iterator_to_array($calls));

        $calls->exchangeArray([]);
        $this->assertSame('<p>Notes</p>', $sandbox->handleUiEvent($catalog, $token, ['type' => 'click', 'actionId' => 'save'])['html']);
        $this->assertSame([['ownedBy', 'mkt_notes', MarketplaceSandboxService::DEMO_OWNER], ['withSlots', 'mkt_notes', null]], iterator_to_array($calls));
    }
}

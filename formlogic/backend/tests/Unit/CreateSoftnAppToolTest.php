<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Services\{AppService, ChatToolDeniedException, ChatToolsContext, ChatToolsService, FormService, NativeAppService, ResponseService};
use PHPUnit\Framework\TestCase;

/**
 * create_softn_app: a hosted SoftN app in one step — an app marked as a SoftN app, its starter
 * installed as version 1 — and the person's request handed back so the chat can take them to
 * AI Studio to watch it being built.
 */
final class CreateSoftnAppToolTest extends TestCase
{
    /** @return array{0: ChatToolsService, 1: array<string, mixed>, 2: array<int, array<string, mixed>>} */
    private function tools(?\Throwable $installFails = null): array
    {
        $created = new \ArrayObject();
        $installs = new \ArrayObject();
        $apps = $this->createMock(AppService::class);
        $apps->method('createApp')->willReturnCallback(function (array $input, string $owner) use ($created): array {
            $created['input'] = $input; $created['owner'] = $owner;
            return ['id' => 'app-1', 'name' => $input['name'], 'slug' => 'recipe-box'];
        });
        $native = $this->createMock(NativeAppService::class);
        $native->method('install')->willReturnCallback(function (string $appId, array $project, int $expected) use ($installs, $installFails): array {
            if ($installFails) throw $installFails;
            $installs[] = ['appId' => $appId, 'project' => $project, 'expected' => $expected];
            return ['version' => 1] + $project;
        });
        $service = new ChatToolsService($this->createMock(FormService::class), $apps, $this->createMock(ResponseService::class), native: $native);
        return [$service, $created, $installs];
    }

    public function testItCreatesAMarkedAppWithTheStarterAndHandsTheRequestBack(): void
    {
        [$tools, $created, $installs] = $this->tools();
        $audits = [];
        $ctx = new ChatToolsContext('owner', audit: static function (string $action, array $detail) use (&$audits): void { $audits[] = [$action, $detail]; });
        $data = $tools->callChatTool('create_softn_app', ['name' => ' Recipe box ', 'request' => 'A recipe box with favourites and a shopping list.'], $ctx);

        $this->assertSame('owner', $created['owner']);
        $this->assertSame('Recipe box', $created['input']['name']);
        $this->assertSame(['softnApp' => true], $created['input']['settings']);
        $this->assertCount(1, $installs);
        $this->assertSame(0, $installs[0]['expected']);
        $this->assertSame('Recipe box', json_decode($installs[0]['project']['files']['manifest.json'], true)['name']);
        $this->assertSame(['id' => 'app-1', 'name' => 'Recipe box', 'slug' => 'recipe-box'], $data['app']);
        $this->assertSame(1, $data['version']);
        $this->assertSame('A recipe box with favourites and a shopping list.', $data['request']);
        $this->assertSame('/apps/app-1/softn', $data['workspaceUrl']);
        $this->assertStringContainsString('AI Studio', $data['next']);
        $this->assertSame([['create_softn_app', ['appId' => 'app-1', 'version' => 1]]], $audits);
    }

    public function testAnMcpClientIsToldToBuildItItselfOrSendThePersonToTheWorkspace(): void
    {
        [$tools] = $this->tools();
        $data = $tools->call('create_softn_app', ['name' => 'Recipes', 'request' => 'A recipe box.'], new ChatToolsContext('owner', source: 'mcp'));
        $this->assertStringContainsString('update_native_app_files', $data['next']);
        $this->assertStringContainsString('/apps/app-1/softn', $data['next']);
        $this->assertStringNotContainsString('do not change its files yourself', $data['next']);
    }

    public function testTheNativeProjectToolsRefuseTorchWhereItIsOffBeforeInstalling(): void
    {
        $apps = $this->createMock(AppService::class);
        $apps->method('getApp')->willReturn(['id' => 'app-1', 'ownerId' => 'owner', 'settings' => ['torch' => false]]);
        $native = $this->createMock(NativeAppService::class);
        $native->method('get')->willReturn(['version' => 1, 'files' => ['manifest.json' => '{}'], 'assets' => [], 'access' => 'members']);
        $native->expects($this->never())->method('install');
        $engines = $this->createMock(\FormLogic\Services\RuntimeEngineService::class);
        $engines->method('torchRefusal')->willReturn('This app uses torch, which its settings turn off.');
        $tools = new ChatToolsService($this->createMock(FormService::class), $apps, $this->createMock(ResponseService::class), native: $native, engines: $engines);
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('torch');
        $tools->call('update_native_app_files', ['appId' => 'app-1', 'expectedVersion' => 1, 'files' => ['manifest.json' => '{"config":{"python":{"packages":["torch"]}}}']], new ChatToolsContext('owner', source: 'mcp'));
    }

    public function testAnAppIsStillReturnedWhenItsStarterCannotBeInstalled(): void
    {
        [$tools] = $this->tools(new \RuntimeException('The native app runtime is not installed on this server.'));
        $data = $tools->callChatTool('create_softn_app', ['name' => 'Recipes', 'request' => 'x'], new ChatToolsContext('owner'));
        $this->assertSame('app-1', $data['app']['id']);
        $this->assertNull($data['version']);
        $this->assertStringContainsString('The native app runtime is not installed on this server.', $data['next']);
    }

    public function testNamesRequestsTokensAndScopesAreHeldToTheirLimits(): void
    {
        [$tools] = $this->tools();
        foreach ([['name' => '  '], ['name' => str_repeat('n', 121)], ['name' => 'Ok', 'request' => str_repeat('r', 8001)]] as $args) {
            try {
                $tools->callChatTool('create_softn_app', $args, new ChatToolsContext('owner'));
                $this->fail('Accepted ' . json_encode(array_map(static fn ($v) => strlen((string) $v), $args)));
            } catch (\InvalidArgumentException $e) {
                $this->assertNotSame('', $e->getMessage());
            }
        }
        try {
            $tools->call('create_softn_app', ['name' => 'Ok'], new ChatToolsContext('owner', scopedAppId: 'other'));
            $this->fail('An app-scoped token created an app.');
        } catch (\Exception $e) {
            $this->assertStringContainsString('scoped to one app', $e->getMessage());
        }
        $noScreens = new ChatToolsContext('owner', requireScope: static function (string $scope): void { if ($scope === 'screens:write') throw new ChatToolDeniedException('Scope denied', 'scope'); });
        $this->expectException(ChatToolDeniedException::class);
        $tools->call('create_softn_app', ['name' => 'Ok'], $noScreens);
    }
}

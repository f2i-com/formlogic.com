<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\NativeAppController;
use FormLogic\Services\{AppService, AppUserService, NativeAppService, PlanService, FlowService};
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

final class NativeAppControllerTest extends TestCase
{
    private function fixture(string $access): array
    {
        $apps = $this->createMock(AppService::class);
        $apps->method('getAppBySlug')->willReturn(['id' => 'notes', 'ownerId' => 'owner', 'name' => 'Notes', 'status' => 'published']);
        $apps->method('isRuntimeVisible')->willReturn(true);
        $users = $this->createMock(AppUserService::class);
        $native = $this->createMock(NativeAppService::class);
        $native->method('get')->willReturn(['access' => $access, 'version' => 1, 'assets' => [], 'files' => [
            'manifest.json' => '{"id":"notes","server":{"entry":"server/main.logic"}}',
            'ui/main.ui' => '<Text>Notes</Text>', 'server/main.logic' => 'private source',
        ]]);
        return [new NativeAppController($apps, $users, $native, $this->createMock(PlanService::class), $this->createMock(FlowService::class)), $users, $native];
    }

    public function testPublishedApplicationKeepsItsOwnSignInAndPrivateBackend(): void
    {
        [$controller] = $this->fixture('application');
        $request = (new ServerRequestFactory())->createServerRequest('GET', '/');
        $response = $controller->runtime($request, new Response(), ['slug' => 'notes']);
        $this->assertSame(200, $response->getStatusCode());
        $data = json_decode((string) $response->getBody(), true);
        $this->assertArrayNotHasKey('server/main.logic', $data['project']['client']);
        $this->assertArrayNotHasKey('server', json_decode($data['project']['client']['manifest.json'], true));
    }

    public function testMemberAppRequiresAnActiveMembership(): void
    {
        [$controller, $users, $native] = $this->fixture('members');
        $users->method('getAppUser')->willReturn(['status' => 'pending']);
        $native->expects($this->never())->method('request');
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/');
        $this->assertSame(403, $controller->runtime($request, new Response(), ['slug' => 'notes'])->getStatusCode());
        $this->assertSame(403, $controller->runtime($request->withAttribute('userId', 'new-member'), new Response(), ['slug' => 'notes'])->getStatusCode());
    }

    public function testActiveMembershipSuppliesIdentityFromFormLogic(): void
    {
        [$controller, $users, $native] = $this->fixture('members');
        $users->method('getAppUser')->with('notes', 'member')->willReturn(['status' => 'active', 'roleId' => 'editor']);
        $native->expects($this->once())->method('request')->with('notes', $this->callback(static fn($input) => $input['body']['title'] === 'My note'), [
            'formlogic' => ['appId' => 'notes', 'userId' => 'member', 'roleId' => 'editor'],
        ])->willReturn(['status' => 201, 'body' => ['saved' => true]]);
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/', ['REMOTE_ADDR' => '127.0.0.1'])
            ->withAttribute('userId', 'member')->withParsedBody(['method' => 'POST', 'path' => '/api/notes', 'body' => ['title' => 'My note']]);
        $this->assertSame(200, $controller->runtime($request, new Response(), ['slug' => 'notes'])->getStatusCode());
    }
}

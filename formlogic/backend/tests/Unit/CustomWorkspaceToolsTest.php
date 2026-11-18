<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\ChatToolsController;
use FormLogic\Services\ChatToolGrantService;
use FormLogic\Services\ChatToolsService;
use FormLogic\Services\DesktopCommandService;
use FormLogic\Services\UserAiSettingsService;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

final class CustomWorkspaceToolsTest extends TestCase
{
    public function testSessionConsentAndApprovalAreCheckedBeforeDispatch(): void
    {
        $connection = str_repeat('a', 64);
        $settings = $this->createMock(UserAiSettingsService::class);
        $settings->method('get')->willReturnCallback(static fn () => ['aiSource' => 'custom', 'chatToolMode' => 'confirm', 'customToolConnection' => $connection]);
        $tools = $this->createMock(ChatToolsService::class);
        $calls = [];
        $tools->method('callChatTool')->willReturnCallback(static function ($name, $args, $ctx) use (&$calls) {
            $calls[] = [$name, $args, $ctx->userId];
            return ['ok' => true];
        });
        $controller = new ChatToolsController($this->createStub(ChatToolGrantService::class), $tools, $this->createStub(DesktopCommandService::class), preferences: $settings);
        $run = static function (array $body, bool $signed = true, bool $demo = false) use ($controller) {
            $request = (new ServerRequestFactory())->createServerRequest('POST', '/api/ai/chat-tools/custom')->withParsedBody($body);
            if ($signed) $request = $request->withAttribute('userId', 'owner');
            if ($demo) $request = $request->withAttribute('user', (object) ['email' => $_ENV['DEMO_EMAIL'] ?? 'demo@formlogic.local']);
            return $controller->executeCustom($request, (new ResponseFactory())->createResponse())->getStatusCode();
        };
        $action = ['connection' => $connection, 'tool' => 'create_softn_app', 'input' => ['template' => 'vue']];
        $this->assertSame(401, $run($action, false));
        $this->assertSame(403, $run($action, true, true));
        $this->assertSame(403, $run(array_replace($action, ['connection' => 'changed'])));
        $this->assertSame(409, $run($action));
        $this->assertSame(409, $run(array_replace($action, ['input' => ['approved' => true]])));
        $this->assertSame([], $calls);
        $this->assertSame(200, $run(['tool' => 'list_apps', 'connection' => $connection]));
        $this->assertSame(200, $run($action + ['approved' => true]));
        $this->assertSame([['list_apps', [], 'owner'], ['create_softn_app', ['template' => 'vue'], 'owner']], $calls);
    }
}

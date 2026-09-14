<?php
declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\DesktopAiRelayController;
use FormLogic\Services\DesktopAiRelayService;
use FormLogic\Services\DesktopCommandService;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

final class DesktopRelayKeySelectionTest extends TestCase
{
    public function testFlowKeyUsesTheFlowAssignmentInsteadOfTheAiAssignment(): void
    {
        $commands = $this->createMock(DesktopCommandService::class);
        $commands->expects($this->once())->method('resolveTargetInstance')->with('owner', 'desktop-flow')
            ->willReturn(['target' => 'flow-computer', 'error' => null, 'desktops' => []]);
        $relay = $this->createMock(DesktopAiRelayService::class);
        $key = base64_encode(str_repeat('k', 32));
        $relay->expects($this->once())->method('getPubkey')->with('owner', 'flow-computer')->willReturn($key);
        $controller = new DesktopAiRelayController($relay, $commands);
        $request = (new ServerRequestFactory())->createServerRequest('GET', '/api/desktop/ai/pubkey')
            ->withAttribute('userId', 'owner')->withQueryParams(['lane' => 'flow']);
        $response = $controller->getPubkey($request, (new ResponseFactory())->createResponse());
        $this->assertSame(200, $response->getStatusCode());
        $body = json_decode((string) $response->getBody(), true);
        $this->assertSame('flow-computer', $body['instanceId']);
        $this->assertSame($key, $body['publicKey']);
    }
}

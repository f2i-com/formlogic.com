<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\DesktopAiRelayController;
use FormLogic\Services\DesktopCommandService;
use FormLogic\Tests\Support\InMemoryAiRelay;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * POST /api/desktop/ai/requests/{id}/cancel (DesktopAiRelayController::cancelRequest): the person
 * whose browser stopped a turn on their own computer cancels it there too, and the computer is told
 * `cancelled` on its next frame. Nobody else can, and a request that is not theirs is answered as
 * one that does not exist.
 */
final class DesktopAiCancelRouteTest extends TestCase
{
    private InMemoryAiRelay $relay;
    private DesktopAiRelayController $controller;

    protected function setUp(): void
    {
        $this->relay = new InMemoryAiRelay();
        $this->controller = new DesktopAiRelayController($this->relay, $this->createMock(DesktopCommandService::class));
    }

    private function cancel(?string $user, string $id): array
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', 'http://127.0.0.1/api/desktop/ai/requests/' . $id . '/cancel');
        if ($user !== null) $request = $request->withAttribute('userId', $user);
        $response = $this->controller->cancelRequest($request, new Response(), ['id' => $id]);
        return [$response->getStatusCode(), json_decode((string) $response->getBody(), true)];
    }

    private function queue(string $owner, string $requester): string
    {
        return $this->relay->enqueue($owner, $requester, ['kind' => 'chat', 'providerId' => 'oaiy-engine', 'ephPub' => base64_encode(random_bytes(32)), 'envelope' => base64_encode(random_bytes(64))])['request']['requestId'];
    }

    public function testTheRequesterCancelsTheirTurnAndTheComputerIsToldToStop(): void
    {
        $id = $this->queue('u-member', 'u-member');
        $this->relay->take($id);
        $this->assertSame([200, ['cancelled' => true]], $this->cancel('u-member', $id));
        $this->assertSame('expired', $this->relay->requests[$id]['status'], 'the lane answers its next frame `cancelled`');
        $this->assertSame([200, ['cancelled' => false]], $this->cancel('u-member', $id), 'once');
    }

    public function testNobodyElseCanAndAnotherPersonsRequestIsAnsweredAsOneThatDoesNotExist(): void
    {
        // A member's turn on the administrator's computer: the administrator owns the lane, not the turn.
        $id = $this->queue('u-admin', 'u-member');
        $unknown = $this->cancel('u-member', 'no-such-request');
        $this->assertSame([404, ['error' => true, 'message' => 'Request not found']], $unknown);
        $this->assertSame($unknown, $this->cancel('u-admin', $id), 'its computer\'s owner');
        $this->assertSame($unknown, $this->cancel('u-stranger', $id), 'a stranger');
        $this->assertSame(401, $this->cancel(null, $id)[0]);
        $this->assertSame([], $this->relay->cancelled, 'nothing was cancelled');
        $this->assertSame('pending', $this->relay->requests[$id]['status']);
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\ChatToolDeniedException;
use FormLogic\Services\ChatToolsContext;
use FormLogic\Services\ChatToolsService;
use FormLogic\Services\FlowService;
use PHPUnit\Framework\TestCase;

/**
 * How ChatToolsService walks a flow and the flows it calls (flow_call), for the three checks made
 * before an automation is stored or armed: the token's scopes, the chat's refusals, and whether
 * anything in the tree sends connector commands. Each flow is walked once however many flows call
 * it, a call is followed as deep as a runner follows one, and a flow reached twice is not a loop.
 * The flow store is a double that counts what it is asked.
 */
final class ChatToolsFlowCallWalkTest extends TestCase
{
    /** @var array{getFlow: int, listFlows: int, listWorkspaceFlows: int} */
    private array $asked = ['getFlow' => 0, 'listFlows' => 0, 'listWorkspaceFlows' => 0];

    /** @param array<string, list<array<string, mixed>>> $graphs each flow's nodes, by its id */
    private function service(array $graphs): ChatToolsService
    {
        $flows = [];
        foreach ($graphs as $id => $nodes) {
            $flows[$id] = ['id' => $id, 'slug' => 'slug-' . $id, 'appId' => 'app-1', 'ownerUserId' => 'user-1', 'flowJson' => ['nodes' => $nodes, 'edges' => []]];
        }
        $this->asked = ['getFlow' => 0, 'listFlows' => 0, 'listWorkspaceFlows' => 0];
        $store = $this->createMock(FlowService::class);
        $store->method('getFlow')->willReturnCallback(function (string $appId, string $id) use ($flows): ?array {
            $this->asked['getFlow']++;
            return $flows[$id] ?? null;
        });
        $store->method('listFlows')->willReturnCallback(function () use ($flows): array {
            $this->asked['listFlows']++;
            return array_values($flows);
        });
        $store->method('listWorkspaceFlows')->willReturnCallback(function (): array {
            $this->asked['listWorkspaceFlows']++;
            return [];
        });
        $service = (new \ReflectionClass(ChatToolsService::class))->newInstanceWithoutConstructor();
        (new \ReflectionProperty(ChatToolsService::class, 'flowService'))->setValue($service, $store);
        return $service;
    }

    private static function call(string $target): array
    {
        return ['id' => 'call-' . $target, 'type' => 'flow_call', 'data' => ['flowId' => $target]];
    }

    private const READS = ['id' => 'read', 'type' => 'formlogic_list_responses', 'data' => []];
    private const SPEAKS = ['id' => 'say', 'type' => 'aokie_speak', 'data' => ['text' => 'Hi']];

    /** A token holding $scopes; any other scope asked of it is refused by name. */
    private static function token(string ...$scopes): ChatToolsContext
    {
        return new ChatToolsContext(userId: 'user-1', requireScope: static function (string $scope) use ($scopes): void {
            if (!in_array($scope, $scopes, true)) {
                throw new ChatToolDeniedException("Missing scope: {$scope}", 'insufficient_scope');
            }
        });
    }

    private static function permitted(ChatToolsService $service, array $nodes, ChatToolsContext $ctx): ?string
    {
        try {
            (new \ReflectionMethod(ChatToolsService::class, 'assertFlowGraphPermitted'))->invoke($service, ['flowJson' => ['nodes' => $nodes]], 'app-1', $ctx);
            return null;
        } catch (ChatToolDeniedException $refused) {
            return $refused->getMessage();
        }
    }

    private static function sendsCommands(ChatToolsService $service, array $nodes): bool
    {
        return (new \ReflectionMethod(ChatToolsService::class, 'flowTreeSendsConnectorCommands'))->invoke($service, ['flowJson' => ['nodes' => $nodes]], 'app-1', 'user-1');
    }

    private static function chatRefuses(ChatToolsService $service, array $nodes): ?string
    {
        try {
            (new \ReflectionMethod(ChatToolsService::class, 'assertChatFlowSafe'))->invoke($service, ['flowJson' => ['nodes' => $nodes]], 'app-1', 'user-1');
            return null;
        } catch (ChatToolDeniedException $refused) {
            return $refused->getReasonCode();
        }
    }

    /**
     * Twelve flows that each call the other eleven. Walked once for every chain of calls that
     * reaches a flow, that is more walks than there is time for, each one several queries; walked
     * once each, it is twelve lookups and one listing.
     */
    public function testFlowsThatAllCallEachOtherAreEachWalkedOnce(): void
    {
        $ids = array_map(static fn (int $n): string => 'f' . $n, range(1, 12));
        $graphs = [];
        foreach ($ids as $id) {
            $graphs[$id] = array_map(self::call(...), array_values(array_diff($ids, [$id])));
        }
        $root = array_map(self::call(...), $ids);

        $service = $this->service($graphs);
        $this->assertNull(self::permitted($service, $root, self::token()));
        $this->assertSame(['getFlow' => 12, 'listFlows' => 0, 'listWorkspaceFlows' => 0], $this->asked);

        $service = $this->service($graphs);
        $this->assertFalse(self::sendsCommands($service, $root));
        $this->assertSame(12, $this->asked['getFlow']);

        $service = $this->service($graphs);
        $this->assertNull(self::chatRefuses($service, $root));
        $this->assertSame(12, $this->asked['getFlow']);

        // What one of them does is still found, wherever it sits among them.
        $graphs['f12'][] = self::READS;
        $graphs['f12'][] = self::SPEAKS;
        $this->assertSame('Missing scope: responses:read', self::permitted($this->service($graphs), $root, self::token('connector:command')));
        $this->assertSame('Missing scope: connector:command', self::permitted($this->service($graphs), $root, self::token('responses:read')));
        $this->assertNull(self::permitted($this->service($graphs), $root, self::token('responses:read', 'connector:command')));
        $this->assertTrue(self::sendsCommands($this->service($graphs), $root));
        $this->assertSame('connector_permission_refused', self::chatRefuses($this->service($graphs), $root));
    }

    /** A names B and C, and both name D: D is walked once, checked, and is no loop. */
    public function testTwoFlowsThatCallTheSameThirdAreNotALoop(): void
    {
        $graphs = ['b' => [self::call('d')], 'c' => [self::call('d')], 'd' => []];
        $root = [self::call('b'), self::call('c')];
        $service = $this->service($graphs);
        $this->assertNull(self::permitted($service, $root, self::token()));
        $this->assertSame(3, $this->asked['getFlow'], 'b, c and d, each once');
        $this->assertFalse(self::sendsCommands($this->service($graphs), $root));
        $this->assertNull(self::chatRefuses($this->service($graphs), $root));

        $graphs['d'] = [self::READS];
        $this->assertSame('Missing scope: responses:read', self::permitted($this->service($graphs), $root, self::token()));
        $this->assertNull(self::permitted($this->service($graphs), $root, self::token('responses:read')));
        // A flow that calls itself, and two that call each other, end.
        $loops = ['a' => [self::call('a'), self::call('b')], 'b' => [self::call('a'), self::READS]];
        $this->assertSame('Missing scope: responses:read', self::permitted($this->service($loops), [self::call('a')], self::token()));
        $this->assertFalse(self::sendsCommands($this->service($loops), [self::call('a')]));
    }

    /**
     * A target named in every node is looked up once, and one that is not a flow's id costs one
     * listing of the app's flows for the whole walk, not one for each node that names it.
     */
    public function testATargetIsLookedUpOnceAndTheAppsFlowsListedOnce(): void
    {
        $graphs = ['b' => []];
        $root = [];
        for ($n = 0; $n < 40; $n++) {
            $root[] = ['id' => 'by-slug-' . $n, 'type' => 'flow_call', 'data' => ['flow' => 'slug-b']];
            $root[] = ['id' => 'gone-' . $n, 'type' => 'flow_call', 'data' => ['flowId' => 'gone-' . ($n % 4)]];
        }
        $service = $this->service($graphs);
        $this->assertNull(self::permitted($service, $root, self::token()));
        $this->assertSame(['getFlow' => 5, 'listFlows' => 1, 'listWorkspaceFlows' => 1], $this->asked, 'slug-b and four that are gone');
    }

    /**
     * A runner calls eight flows deep, the first counted, and refuses the ninth: the walk goes as
     * far. A flow met at the end of a long chain is walked again when a shorter chain reaches it,
     * so what it calls is not left unread for having first been met too deep.
     */
    public function testAChainIsFollowedAsDeepAsARunnerFollowsOne(): void
    {
        // root(1) → c2 → c3 → … → c8 → c9 → c10, and only the last of them reads records.
        $chain = [];
        for ($n = 2; $n <= 9; $n++) {
            $chain['c' . $n] = [self::call('c' . ($n + 1))];
        }
        $chain['c10'] = [];
        $deep = $chain;
        $deep['c9'][] = self::READS;
        $this->assertNull(self::permitted($this->service($deep), [self::call('c2')], self::token()), 'the ninth flow is never called');
        $within = $chain;
        $within['c8'][] = self::READS;
        $this->assertSame('Missing scope: responses:read', self::permitted($this->service($within), [self::call('c2')], self::token()));

        // c8 is first met eight deep, where its call to c9 is not followed; the root also calls it directly.
        $service = $this->service($deep);
        $this->assertSame('Missing scope: responses:read', self::permitted($service, [self::call('c2'), self::call('c8')], self::token()));
        $speaks = $chain;
        $speaks['c9'][] = self::SPEAKS;
        $this->assertFalse(self::sendsCommands($this->service($speaks), [self::call('c2')]));
        $this->assertTrue(self::sendsCommands($this->service($speaks), [self::call('c2'), self::call('c8')]));
        $this->assertNull(self::chatRefuses($this->service($speaks), [self::call('c2')]));
        $this->assertSame('connector_permission_refused', self::chatRefuses($this->service($speaks), [self::call('c2'), self::call('c8')]));
    }
}

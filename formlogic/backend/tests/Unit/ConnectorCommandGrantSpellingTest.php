<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\ConnectorCommandController;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\DesktopCommandService;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * A member's connector command is queued as the grant that allows it spells it. The database
 * matches a grant without regard to case, and the owner's computer matches a command's name
 * exactly (its relay policy, and the plugin's own list), so `call.HANGUP` is there another command
 * than the `call.hangup` a member was granted: one nobody granted them. No database: the
 * permission check is a double that compares as the column's collation does.
 */
final class ConnectorCommandGrantSpellingTest extends TestCase
{
    /** @var list<array<string, mixed>> what reached the queue */
    private array $queued = [];
    /** @var array<string, array<string, mixed>> the commands that can be read back, by id */
    private array $stored = [];

    /** @param list<string> $grants the member's role's grants, as stored */
    private function controller(array $grants): ConnectorCommandController
    {
        $this->queued = [];
        $apps = $this->createMock(AppService::class);
        $apps->method('getAppBySlug')->willReturn(['id' => 'app-1', 'ownerId' => 'owner-1', 'status' => 'published']);
        $users = $this->createMock(AppUserService::class);
        $users->method('getAppUser')->willReturn(['status' => 'active']);
        // utf8mb4_unicode_ci: equal without regard to case. The owner holds everything.
        $users->method('hasPermission')->willReturnCallback(static function (string $appId, string $userId, string $permission) use ($grants): bool {
            return $userId === 'owner-1' || in_array(strtolower($permission), array_map('strtolower', $grants), true);
        });
        $users->method('getUserConnectorGrants')->willReturnCallback(static function (string $appId, string $userId, string $connectorId) use ($grants): array {
            if ($userId === 'owner-1') return ['*'];
            return array_values(array_filter($grants, static fn (string $grant): bool => stripos($grant, 'connector.' . $connectorId) === 0));
        });
        $commands = $this->createMock(DesktopCommandService::class);
        $commands->method('resolveTargetInstance')->willReturn(['target' => null, 'error' => null, 'desktops' => []]);
        $commands->method('enqueue')->willReturnCallback(function (string $owner, string $by, ?string $appId, array $data): array {
            $this->queued[] = $data;
            return ['command' => ['commandId' => 'c-' . count($this->queued), 'status' => 'pending'], 'created' => true];
        });
        $commands->method('get')->willReturnCallback(fn (string $id): ?array => $this->stored[$id] ?? null);
        $commands->method('describeInstances')->willReturn([]);
        return new ConnectorCommandController($commands, $apps, $users);
    }

    private function enqueue(ConnectorCommandController $controller, string $userId, string $command, string $connector = 'aokie'): int
    {
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/api/app/shop/connector-commands')
            ->withAttribute('userId', $userId)->withParsedBody(['connectorId' => $connector, 'command' => $command, 'payload' => ['callId' => 'c1']]);
        return $controller->enqueue($request, new Response(), ['slug' => 'shop'])->getStatusCode();
    }

    public function testACommandIsQueuedAsTheGrantThatAllowsItSpellsIt(): void
    {
        $controller = $this->controller(['connector.aokie.call.hangup', 'connector.aokie.call.operatorSpeak']);

        foreach (['call.hangup', 'call.HANGUP', 'Call.Hangup'] as $sent) {
            $this->assertSame(201, $this->enqueue($controller, 'member-1', $sent), $sent);
        }
        $this->assertSame(['call.hangup', 'call.hangup', 'call.hangup'], array_column($this->queued, 'command'));
        // A grant written with capitals is that command, however the member writes it.
        $this->assertSame(201, $this->enqueue($controller, 'member-1', 'call.operatorspeak'));
        $this->assertSame('call.operatorSpeak', $this->queued[3]['command']);
        // The rest of what was sent is queued as it was.
        $this->assertSame(['connectorId' => 'aokie', 'command' => 'call.operatorSpeak', 'payload' => ['callId' => 'c1']], $this->queued[3]);

        // No grant, no command: in any case.
        $this->assertSame(403, $this->enqueue($controller, 'member-1', 'call.answer'));
        $this->assertSame(403, $this->enqueue($controller, 'member-1', 'CALL.ANSWER'));
        $this->assertCount(4, $this->queued);
    }

    public function testTheOwnerAndAGrantOfEveryCommandQueueACommandAsItWasWritten(): void
    {
        foreach ([['connector.aokie.*'], ['connector.aokie'], ['connector.aokie.*', 'connector.aokie.call.hangup']] as $grants) {
            $controller = $this->controller($grants);
            $this->assertSame(201, $this->enqueue($controller, 'member-1', 'call.HANGUP'), implode(' ', $grants));
            $this->assertSame('call.HANGUP', $this->queued[0]['command']);
        }
        $controller = $this->controller([]);
        $this->assertSame(201, $this->enqueue($controller, 'owner-1', 'call.HANGUP'));
        $this->assertSame('call.HANGUP', $this->queued[0]['command']);
    }

    public function testAGrantTheDatabaseMatchedInSomeOtherWayQueuesNothing(): void
    {
        // The collation folds accents as well as case; no spelling of the grant is this command.
        $users = ['connector.aokie.call.hängup'];
        $controller = $this->controller($users);
        $accents = $this->createMock(AppUserService::class);
        $accents->method('getAppUser')->willReturn(['status' => 'active']);
        $accents->method('hasPermission')->willReturn(true);
        $accents->method('getUserConnectorGrants')->willReturn($users);
        (new \ReflectionProperty(ConnectorCommandController::class, 'appUserService'))->setValue($controller, $accents);
        $this->assertSame(403, $this->enqueue($controller, 'member-1', 'call.hangup'));
        $this->assertSame([], $this->queued);
    }

    public function testACommandsOutcomeIsReadByTheGrantForThatVeryCommand(): void
    {
        $controller = $this->controller(['connector.aokie.call.hangup']);
        $row = static fn (string $command, string $by): array => ['commandId' => 'x', 'appId' => 'app-1', 'connectorId' => 'aokie', 'command' => $command, 'requestedByUserId' => $by, 'status' => 'done'];
        $this->stored = ['same' => $row('call.hangup', 'owner-1'), 'other' => $row('call.HANGUP', 'owner-1'), 'mine' => $row('call.HANGUP', 'member-1')];
        $read = static fn (string $userId, string $id): int => $controller->getCommand(
            (new ServerRequestFactory())->createServerRequest('GET', '/api/app/shop/connector-commands/' . $id)->withAttribute('userId', $userId),
            new Response(),
            ['slug' => 'shop', 'id' => $id]
        )->getStatusCode();

        $this->assertSame(200, $read('member-1', 'same'));
        // Spelled otherwise it is another command, which this member holds no grant for.
        $this->assertSame(403, $read('member-1', 'other'));
        // Whoever queued a command reads its outcome, and so does the owner.
        $this->assertSame(200, $read('member-1', 'mine'));
        $this->assertSame(200, $read('owner-1', 'other'));
    }
}

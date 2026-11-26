<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\DesktopCommandService;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

class DesktopCommandRelayPolicyTest extends TestCase
{
    public static function privateAokieCommands(): array
    {
        return [
            ['remote.bootstrap'],
            ['remote.session.refresh'],
            ['call.remoteStatus'],
            ['call.assistance.respond'],
            ['call.takeOver'],
            ['call.resumeBot'],
            ['call.endCaller'],
            ['call.declineWaiting'],
        ];
    }

    #[DataProvider('privateAokieCommands')]
    public function testPrivateAokieCommandsAreClassifiedOutsideThePublicRelay(string $command): void
    {
        $this->assertTrue(DesktopCommandService::isPrivateAokieRelayCommand('aokie', $command));
        $this->assertTrue(DesktopCommandService::isPrivateAokieRelayCommand(' AOKIE ', " {$command} "));
    }

    public function testOnlyTheNamedAokieCommandNamespaceIsDenied(): void
    {
        $this->assertFalse(DesktopCommandService::isPrivateAokieRelayCommand('other', 'remote.bootstrap'));
        $this->assertFalse(DesktopCommandService::isPrivateAokieRelayCommand('aokie', 'remote'));
        $this->assertFalse(DesktopCommandService::isPrivateAokieRelayCommand('aokie', 'call.remoteStatus.extra'));
        $this->assertFalse(DesktopCommandService::isPrivateAokieRelayCommand('aokie', 'call.hangup'));
        $this->assertFalse(DesktopCommandService::isPrivateAokieRelayCommand('aokie', 'call.operatorSpeak'));
    }

    /**
     * A member's grant is matched without regard to case (the permission column's collation), so
     * a private command is private in any case: `call.takeover` is `call.takeOver`.
     */
    #[DataProvider('privateAokieCommands')]
    public function testAPrivateAokieCommandIsPrivateInAnyCase(string $command): void
    {
        foreach ([strtolower($command), strtoupper($command), ucfirst($command)] as $spelling) {
            $this->assertTrue(DesktopCommandService::isPrivateAokieRelayCommand('aokie', $spelling), $spelling);
            $this->assertTrue(DesktopCommandService::isPrivateAokieRelayCommand('Aokie', $spelling), $spelling);
            try {
                DesktopCommandService::assertPublicRelayCommand('aokie', $spelling);
                $this->fail($spelling . ' passed as a public command');
            } catch (\InvalidArgumentException $e) {
                $this->assertSame(DesktopCommandService::PRIVATE_AOKIE_RELAY_MESSAGE, $e->getMessage());
            }
        }
    }

    /** A command service over a database that keeps what it is asked to insert, and has no rows. */
    private function service(array &$inserted): DesktopCommandService
    {
        $statement = $this->createMock(\PDOStatement::class);
        $statement->method('execute')->willReturnCallback(static function (?array $params = null) use (&$inserted): bool {
            if (isset($params['connector'])) $inserted[] = [$params['connector'], $params['command']];
            return true;
        });
        $statement->method('fetch')->willReturn(false);
        $pdo = $this->createMock(\PDO::class);
        $pdo->method('prepare')->willReturn($statement);
        $service = (new \ReflectionClass(DesktopCommandService::class))->newInstanceWithoutConstructor();
        (new \ReflectionProperty(DesktopCommandService::class, 'mysql'))->setValue($service, $pdo);
        return $service;
    }

    /** Only the names a grant can be written for are queued: a lowercase slug, and a dotted command. */
    public function testOnlyAConnectorSlugAndADottedCommandAreQueued(): void
    {
        $inserted = [];
        $service = $this->service($inserted);
        $real = [['aokie', 'call.operatorSpeak'], ['aokie', 'dongle.installDriver'], ['aokie', 'sms.send'], ['aokie', 'call'], ['test-connector', 'phone.status'], ['my_printer2', 'print.label-4x6']];
        foreach ($real as [$connector, $command]) {
            try {
                $service->enqueue('owner-1', 'member-1', 'app-1', ['connectorId' => $connector, 'command' => $command]);
            } catch (\RuntimeException $e) {
                // The double has no row to read back; the insert is what is looked at.
                $this->assertSame('Command enqueue failed', $e->getMessage());
            }
        }
        $this->assertSame($real, $inserted);

        $inserted = [];
        foreach ([
            ['Aokie', 'call'], [' aokie', 'call'], ['aokie.call', 'x'], ['-aokie', 'call'], ["aokie\n", 'call'], ['aokíe', 'call'],
            ['aokie', 'call hangup'], ['aokie', ' call'], ['aokie', "call\n"], ['aokie', '.call'], ['aokie', 'call/../x'], ['aokie', 'call:hangup'], ['aokie', "call\0"],
        ] as [$connector, $command]) {
            try {
                $service->enqueue('owner-1', 'member-1', 'app-1', ['connectorId' => $connector, 'command' => $command]);
                $this->fail(json_encode([$connector, $command]) . ' was queued');
            } catch (\InvalidArgumentException $e) {
                $this->assertMatchesRegularExpression('/^(connectorId|command) must be /', $e->getMessage());
            }
        }
        $this->assertSame([], $inserted);

        // A private or reserved name is refused as that, whatever its case, before its shape is looked at.
        foreach ([['aokie', 'Call.TakeOver', DesktopCommandService::PRIVATE_AOKIE_RELAY_MESSAGE], ['aokie', 'Remote.bootstrap', DesktopCommandService::PRIVATE_AOKIE_RELAY_MESSAGE], [' Desktop ', 'services.stop', DesktopCommandService::RESERVED_CONNECTOR_MESSAGE]] as [$connector, $command, $said]) {
            try {
                $service->enqueue('owner-1', 'member-1', 'app-1', ['connectorId' => $connector, 'command' => $command]);
                $this->fail(json_encode([$connector, $command]) . ' was queued');
            } catch (\InvalidArgumentException $e) {
                $this->assertSame($said, $e->getMessage());
            }
        }
        $this->assertSame([], $inserted);
    }
}

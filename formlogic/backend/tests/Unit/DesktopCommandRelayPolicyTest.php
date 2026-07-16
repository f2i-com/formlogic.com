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
    }
}

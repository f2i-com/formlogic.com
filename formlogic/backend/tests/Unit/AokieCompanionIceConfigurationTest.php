<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\AokieCompanionIceConfiguration;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The ICE bootstrap every Companion discovery and admission carries. The native Companion parses
 * it with unknown-field rejection and re-checks every TURN expiry against its own clock, so the
 * shape, the order of the members and the `expiresAt` arithmetic are all part of the contract.
 */
final class AokieCompanionIceConfigurationTest extends TestCase
{
    private const NOW = 1_784_160_000;
    private const TURN_URL = 'turns:turn.example.test:5349?transport=tcp';

    /**
     * A configuration holding this static list. Whatever it logs is appended to $log, so a test can
     * read what an operator would.
     *
     * @param list<string>|null $log
     */
    private static function withList(array $servers, string $relayOnly = '', ?array &$log = null): AokieCompanionIceConfiguration
    {
        $log = [];
        return new AokieCompanionIceConfiguration(
            $relayOnly,
            json_encode($servers, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR),
            static function (string $line) use (&$log): void {
                $log[] = $line;
            },
        );
    }

    private static function turn(int $expiresAt, array $override = []): array
    {
        return $override + [
            'urls' => [self::TURN_URL],
            'username' => 'temporary-user',
            'credential' => 'temporary-secret',
            'expiresAt' => $expiresAt,
        ];
    }

    // ── what an unconfigured or valid deployment gets ──

    public function testNothingConfiguredIsAnEmptyDirectOnlyBootstrap(): void
    {
        $this->assertSame(
            ['servers' => [], 'relayOnly' => false, 'expiresAt' => null],
            (new AokieCompanionIceConfiguration())->resolve(self::NOW),
        );
        $this->assertSame(
            ['servers' => [], 'relayOnly' => false, 'expiresAt' => null],
            (new AokieCompanionIceConfiguration('false'))->resolve(self::NOW),
        );
    }

    public function testEntriesKeepTheExactShapeAndOrderTheCompanionParses(): void
    {
        $result = self::withList([
            ['urls' => ['stun:stun.example.test:3478']],
            self::turn(self::NOW + 3600),
        ])->resolve(self::NOW);

        $this->assertSame([
            ['urls' => ['stun:stun.example.test:3478'], 'username' => '', 'credential' => ''],
            [
                'urls' => [self::TURN_URL],
                'username' => 'temporary-user',
                'credential' => 'temporary-secret',
                'expiresAt' => self::NOW + 3600,
            ],
        ], $result['servers']);
        $this->assertSame(['urls', 'username', 'credential', 'expiresAt'], array_keys($result['servers'][1]));
        $this->assertFalse($result['relayOnly']);
    }

    public function testTheReportedExpiryIsTheEarliestTurnExpiry(): void
    {
        $result = self::withList([
            self::turn(self::NOW + 7200),
            ['urls' => ['stun:stun.example.test']],
            self::turn(self::NOW + 600, ['urls' => ['turn:turn.example.test:3478?transport=udp']]),
        ])->resolve(self::NOW);

        $this->assertSame(self::NOW + 600, $result['expiresAt']);
        $this->assertCount(3, $result['servers']);
    }

    public function testAStunOnlyListHasNoExpiry(): void
    {
        $result = self::withList([['urls' => ['stun:stun.example.test'], 'username' => '', 'credential' => '']])->resolve(self::NOW);

        $this->assertNull($result['expiresAt']);
        $this->assertCount(1, $result['servers']);
    }

    public function testEnvironmentValuesAreTrimmedAndRead(): void
    {
        $values = [
            'AOKIE_COMPANION_RELAY_ONLY' => ' true ',
            'AOKIE_COMPANION_ICE_SERVERS_JSON' => ' ' . json_encode([self::turn(self::NOW + 600)]) . "\n",
        ];
        $config = AokieCompanionIceConfiguration::fromEnvironment(static fn (string $name): string => $values[$name] ?? '');

        $result = $config->resolve(self::NOW);

        $this->assertTrue($result['relayOnly']);
        $this->assertSame(self::NOW + 600, $result['expiresAt']);
    }

    // ── relay-only needs TURN ──

    public function testRelayOnlyNeedsATurnServer(): void
    {
        $this->expectException(\UnexpectedValueException::class);
        (new AokieCompanionIceConfiguration('true'))->resolve(self::NOW);
    }

    public function testRelayOnlyWithOnlyStunIsRefused(): void
    {
        $this->expectException(\UnexpectedValueException::class);
        self::withList([['urls' => ['stun:stun.example.test']]], 'true')->resolve(self::NOW);
    }

    public function testRelayOnlyWithTurnIsRelayOnly(): void
    {
        $result = self::withList([self::turn(self::NOW + 600)], 'true')->resolve(self::NOW);

        $this->assertTrue($result['relayOnly']);
    }

    public function testRelayOnlyMustBeTrueOrFalse(): void
    {
        $this->expectException(\UnexpectedValueException::class);
        (new AokieCompanionIceConfiguration('yes'))->resolve(self::NOW);
    }

    // ── malformed configuration stays refused ──

    /** @return array<string, array{string}> */
    public static function malformedLists(): array
    {
        return [
            'not JSON' => ['{nope'],
            'not a list' => [json_encode(['urls' => ['stun:a.example.test']])],
            'more than eight entries' => [json_encode(array_fill(0, 9, ['urls' => ['stun:stun.example.test']]))],
            'an entry that is not an object' => [json_encode(['stun:a.example.test'])],
            'an unknown member' => [json_encode([['urls' => ['stun:a.example.test'], 'ttl' => 5]])],
            'no urls' => [json_encode([['urls' => []]])],
            'urls that are not a list' => [json_encode([['urls' => ['a' => 'stun:a.example.test']]])],
            'more than eight urls' => [json_encode([['urls' => array_fill(0, 9, 'stun:a.example.test')]])],
            'a URL that is not stun/turn' => [json_encode([['urls' => ['https://a.example.test']]])],
            'an empty URL' => [json_encode([['urls' => ['']]])],
            'a URL with a control character' => [json_encode([['urls' => ["stun:a.example.test\n"]]])],
            'a URL with a line separator' => [json_encode([['urls' => ["stun:a.example.test\u{2028}"]]], JSON_UNESCAPED_UNICODE)],
            'a username with a paragraph separator' => [json_encode([self::turn(self::NOW + 600, ['username' => "a\u{2029}b"])], JSON_UNESCAPED_UNICODE)],
            'a credential that is not a string' => [json_encode([['urls' => [self::TURN_URL], 'username' => 'u', 'credential' => 7, 'expiresAt' => self::NOW + 600]])],
            'STUN carrying a credential' => [json_encode([['urls' => ['stun:a.example.test'], 'username' => 'u', 'credential' => 'c']])],
            'STUN carrying an expiry' => [json_encode([['urls' => ['stun:a.example.test'], 'expiresAt' => self::NOW + 600]])],
            'TURN without a username' => [json_encode([['urls' => [self::TURN_URL], 'credential' => 'c', 'expiresAt' => self::NOW + 600]])],
            'TURN without a credential' => [json_encode([['urls' => [self::TURN_URL], 'username' => 'u', 'expiresAt' => self::NOW + 600]])],
            'TURN without an expiry' => [json_encode([['urls' => [self::TURN_URL], 'username' => 'u', 'credential' => 'c']])],
            'TURN with an expiry that is a string' => [json_encode([['urls' => [self::TURN_URL], 'username' => 'u', 'credential' => 'c', 'expiresAt' => (string) (self::NOW + 600)]])],
        ];
    }

    #[DataProvider('malformedLists')]
    public function testMalformedConfigurationIsRefused(string $json): void
    {
        $this->expectException(\UnexpectedValueException::class);
        (new AokieCompanionIceConfiguration('', $json))->resolve(self::NOW);
    }

    public function testAnExpiryMoreThanADayAheadIsAMistakeAndRefused(): void
    {
        $this->expectException(\UnexpectedValueException::class);
        self::withList([self::turn(self::NOW + 86401)])->resolve(self::NOW);
    }

    public function testAnExpiryExactlyADayAheadIsAccepted(): void
    {
        $this->assertSame(self::NOW + 86400, self::withList([self::turn(self::NOW + 86400)])->resolve(self::NOW)['expiresAt']);
    }

    public function testEveryRefusalIsLoggedWithItsReason(): void
    {
        $log = [];
        try {
            self::withList([self::turn(self::NOW + 86401)], '', $log)->resolve(self::NOW);
            $this->fail('a credential a day and a second ahead should be refused');
        } catch (\UnexpectedValueException) {
        }

        $this->assertCount(1, $log);
        $this->assertStringContainsString('ice_configuration_invalid', $log[0]);
        $this->assertStringContainsString('expiresAt', $log[0]);
        $this->assertStringNotContainsString('temporary-secret', $log[0], 'a credential never reaches the log');
        $this->assertStringNotContainsString('temporary-user', $log[0]);
    }

    // ── a lapsed TURN credential is left out; it no longer takes the deployment down ──

    public function testALapsedTurnEntryIsLeftOutAndEverythingElseStillApplies(): void
    {
        $log = [];
        $result = self::withList([
            ['urls' => ['stun:stun.example.test:3478']],
            self::turn(self::NOW - 86_400, ['urls' => ['turns:old.example.test:5349?transport=tcp'], 'username' => 'lapsed-user', 'credential' => 'lapsed-secret']),
            self::turn(self::NOW + 3600, ['urls' => ['turn:turn.example.test:3478?transport=udp']]),
        ], '', $log)->resolve(self::NOW);

        $this->assertSame(['stun:stun.example.test:3478'], $result['servers'][0]['urls']);
        $this->assertSame(['turn:turn.example.test:3478?transport=udp'], $result['servers'][1]['urls']);
        $this->assertCount(2, $result['servers']);
        $this->assertSame(self::NOW + 3600, $result['expiresAt'], 'the reported expiry is the earliest of the entries that remain');
        $this->assertFalse($result['relayOnly']);

        $this->assertCount(1, $log);
        $this->assertStringContainsString('1 TURN entry', $log[0]);
        $this->assertStringContainsString('AOKIE_COMPANION_ICE_SERVERS_JSON', $log[0]);
        $this->assertStringContainsString('entry 2, turns:old.example.test:5349?transport=tcp', $log[0], 'it names which entry, by position and URL');
        $this->assertStringContainsString(gmdate('Y-m-d\TH:i:s\Z', self::NOW - 86_400), $log[0], 'and when its credential ran out');
        $this->assertStringNotContainsString('lapsed-user', $log[0]);
        $this->assertStringNotContainsString('lapsed-secret', $log[0], 'a credential never reaches the log');
    }

    public function testWhenEveryTurnEntryHasLapsedStunAloneRemains(): void
    {
        $log = [];
        $result = self::withList([
            ['urls' => ['stun:stun.example.test:3478']],
            self::turn(self::NOW - 1),
            self::turn(self::NOW + 5, ['urls' => ['turn:turn.example.test:3478']]),
        ], '', $log)->resolve(self::NOW);

        $this->assertSame([['urls' => ['stun:stun.example.test:3478'], 'username' => '', 'credential' => '']], $result['servers']);
        $this->assertNull($result['expiresAt'], 'no TURN entry is left to expire');
        $this->assertFalse($result['relayOnly']);
        $this->assertCount(1, $log);
        $this->assertStringContainsString('2 TURN entries', $log[0]);
    }

    public function testWhenTheWholeListHasLapsedThisIsTheUnconfiguredBootstrap(): void
    {
        $result = self::withList([self::turn(self::NOW - 3600)])->resolve(self::NOW);

        $this->assertSame(['servers' => [], 'relayOnly' => false, 'expiresAt' => null], $result);
    }

    public function testACredentialWithThirtySecondsLeftHasLapsedForTheCompanion(): void
    {
        // The Companion refuses one with 30 seconds or fewer to live, so forwarding it would just move the failure to the phone.
        $this->assertSame([], self::withList([self::turn(self::NOW + 30)])->resolve(self::NOW)['servers']);
        $this->assertCount(1, self::withList([self::turn(self::NOW + 31)])->resolve(self::NOW)['servers']);
    }

    public function testNothingIsLoggedWhenNothingHasLapsed(): void
    {
        $log = [];
        self::withList([['urls' => ['stun:stun.example.test']], self::turn(self::NOW + 600)], '', $log)->resolve(self::NOW);

        $this->assertSame([], $log);
    }

    public function testRelayOnlyKeepsWorkingWhileOneTurnEntryStillHasItsCredential(): void
    {
        $result = self::withList([
            self::turn(self::NOW - 10),
            self::turn(self::NOW + 1200, ['urls' => ['turn:turn.example.test:3478']]),
        ], 'true')->resolve(self::NOW);

        $this->assertTrue($result['relayOnly']);
        $this->assertCount(1, $result['servers']);
        $this->assertSame(self::NOW + 1200, $result['expiresAt']);
    }

    public function testRelayOnlyCannotWorkWithoutTurnSoItStillFailsOnceEveryEntryHasLapsed(): void
    {
        $log = [];
        try {
            self::withList([['urls' => ['stun:stun.example.test']], self::turn(self::NOW - 10)], 'true', $log)->resolve(self::NOW);
            $this->fail('relay-only with no unexpired TURN entry must not be served');
        } catch (\UnexpectedValueException) {
        }

        $this->assertCount(2, $log, 'the lapse, and the refusal that follows from it');
        $this->assertStringContainsString('lapsed', $log[0]);
        $this->assertStringContainsString('ice_configuration_invalid', $log[1]);
        $this->assertStringContainsString('relayOnly requires', $log[1]);
    }
}

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

    private static function withList(array $servers, string $relayOnly = ''): AokieCompanionIceConfiguration
    {
        return new AokieCompanionIceConfiguration($relayOnly, json_encode($servers, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR));
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

    // ── the expiry window: 31 seconds to 24 hours ahead ──

    public function testTheExpiryWindowIsThirtyOneSecondsToTwentyFourHours(): void
    {
        foreach ([self::NOW + 31, self::NOW + 86400] as $inside) {
            $this->assertSame($inside, self::withList([self::turn($inside)])->resolve(self::NOW)['expiresAt']);
        }
        foreach ([self::NOW + 30, self::NOW - 1, self::NOW + 86401] as $outside) {
            try {
                self::withList([self::turn($outside)])->resolve(self::NOW);
                $this->fail("an expiresAt of {$outside} should be refused");
            } catch (\UnexpectedValueException) {
                $this->addToAssertionCount(1);
            }
        }
    }
}

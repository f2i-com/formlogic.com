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
            relayOnly: $relayOnly,
            staticServersJson: json_encode($servers, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR),
            log: static function (string $line) use (&$log): void {
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
            (new AokieCompanionIceConfiguration())->forDiscovery(self::NOW),
        );
        $this->assertSame(
            ['servers' => [], 'relayOnly' => false, 'expiresAt' => null],
            (new AokieCompanionIceConfiguration('false'))->forDiscovery(self::NOW),
        );
    }

    public function testEntriesKeepTheExactShapeAndOrderTheCompanionParses(): void
    {
        $result = self::withList([
            ['urls' => ['stun:stun.example.test:3478']],
            self::turn(self::NOW + 3600),
        ])->forDiscovery(self::NOW);

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
        ])->forDiscovery(self::NOW);

        $this->assertSame(self::NOW + 600, $result['expiresAt']);
        $this->assertCount(3, $result['servers']);
    }

    public function testAStunOnlyListHasNoExpiry(): void
    {
        $result = self::withList([['urls' => ['stun:stun.example.test'], 'username' => '', 'credential' => '']])->forDiscovery(self::NOW);

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

        $result = $config->forDiscovery(self::NOW);

        $this->assertTrue($result['relayOnly']);
        $this->assertSame(self::NOW + 600, $result['expiresAt']);
    }

    // ── relay-only needs TURN ──

    public function testRelayOnlyNeedsATurnServer(): void
    {
        $this->expectException(\UnexpectedValueException::class);
        (new AokieCompanionIceConfiguration('true'))->forDiscovery(self::NOW);
    }

    public function testRelayOnlyWithOnlyStunIsRefused(): void
    {
        $this->expectException(\UnexpectedValueException::class);
        self::withList([['urls' => ['stun:stun.example.test']]], 'true')->forDiscovery(self::NOW);
    }

    public function testRelayOnlyWithTurnIsRelayOnly(): void
    {
        $result = self::withList([self::turn(self::NOW + 600)], 'true')->forDiscovery(self::NOW);

        $this->assertTrue($result['relayOnly']);
    }

    public function testRelayOnlyMustBeTrueOrFalse(): void
    {
        $this->expectException(\UnexpectedValueException::class);
        (new AokieCompanionIceConfiguration('yes'))->forDiscovery(self::NOW);
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
        (new AokieCompanionIceConfiguration('', $json))->forDiscovery(self::NOW);
    }

    public function testAnExpiryMoreThanADayAheadIsAMistakeAndRefused(): void
    {
        $this->expectException(\UnexpectedValueException::class);
        self::withList([self::turn(self::NOW + 86401)])->forDiscovery(self::NOW);
    }

    public function testAnExpiryExactlyADayAheadIsAccepted(): void
    {
        $this->assertSame(self::NOW + 86400, self::withList([self::turn(self::NOW + 86400)])->forDiscovery(self::NOW)['expiresAt']);
    }

    public function testEveryRefusalIsLoggedWithItsReason(): void
    {
        $log = [];
        try {
            self::withList([self::turn(self::NOW + 86401)], '', $log)->forDiscovery(self::NOW);
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
        ], '', $log)->forDiscovery(self::NOW);

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
        ], '', $log)->forDiscovery(self::NOW);

        $this->assertSame([['urls' => ['stun:stun.example.test:3478'], 'username' => '', 'credential' => '']], $result['servers']);
        $this->assertNull($result['expiresAt'], 'no TURN entry is left to expire');
        $this->assertFalse($result['relayOnly']);
        $this->assertCount(1, $log);
        $this->assertStringContainsString('2 TURN entries', $log[0]);
    }

    public function testWhenTheWholeListHasLapsedThisIsTheUnconfiguredBootstrap(): void
    {
        $result = self::withList([self::turn(self::NOW - 3600)])->forDiscovery(self::NOW);

        $this->assertSame(['servers' => [], 'relayOnly' => false, 'expiresAt' => null], $result);
    }

    public function testACredentialWithThirtySecondsLeftHasLapsedForTheCompanion(): void
    {
        // The Companion refuses one with 30 seconds or fewer to live, so forwarding it would just move the failure to the phone.
        $this->assertSame([], self::withList([self::turn(self::NOW + 30)])->forDiscovery(self::NOW)['servers']);
        $this->assertCount(1, self::withList([self::turn(self::NOW + 31)])->forDiscovery(self::NOW)['servers']);
    }

    public function testNothingIsLoggedWhenNothingHasLapsed(): void
    {
        $log = [];
        self::withList([['urls' => ['stun:stun.example.test']], self::turn(self::NOW + 600)], '', $log)->forDiscovery(self::NOW);

        $this->assertSame([], $log);
    }

    public function testRelayOnlyKeepsWorkingWhileOneTurnEntryStillHasItsCredential(): void
    {
        $result = self::withList([
            self::turn(self::NOW - 10),
            self::turn(self::NOW + 1200, ['urls' => ['turn:turn.example.test:3478']]),
        ], 'true')->forDiscovery(self::NOW);

        $this->assertTrue($result['relayOnly']);
        $this->assertCount(1, $result['servers']);
        $this->assertSame(self::NOW + 1200, $result['expiresAt']);
    }

    public function testRelayOnlyCannotWorkWithoutTurnSoItStillFailsOnceEveryEntryHasLapsed(): void
    {
        $log = [];
        try {
            self::withList([['urls' => ['stun:stun.example.test']], self::turn(self::NOW - 10)], 'true', $log)->forDiscovery(self::NOW);
            $this->fail('relay-only with no unexpired TURN entry must not be served');
        } catch (\UnexpectedValueException) {
        }

        $this->assertCount(2, $log, 'the lapse, and the refusal that follows from it');
        $this->assertStringContainsString('lapsed', $log[0]);
        $this->assertStringContainsString('ice_configuration_invalid', $log[1]);
        $this->assertStringContainsString('relayOnly requires', $log[1]);
    }

    // ── TURN REST minting: the bytes coturn's use-auth-secret expects ──

    private const REST_SECRET = 'turn-rest-test-secret-not-a-real-key-0123456789';
    private const REST_URLS = 'stun:turn.example.com:3478,turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp';

    /**
     * A configuration that mints, with anything a test needs to vary passed by name.
     *
     * @param list<string>|null $log
     */
    private static function minting(
        string $urls = self::REST_URLS,
        string $ttl = '',
        string $relayOnly = '',
        string $secret = self::REST_SECRET,
        string $staticJson = '',
        ?array &$log = null,
    ): AokieCompanionIceConfiguration {
        $log = [];
        return new AokieCompanionIceConfiguration(
            relayOnly: $relayOnly,
            staticServersJson: $staticJson,
            turnRestSecret: $secret,
            turnRestUrls: $urls,
            turnRestTtlSeconds: $ttl,
            log: static function (string $line) use (&$log): void {
                $log[] = $line;
            },
        );
    }

    /** The two entries minting produces, given the TURN entry's credential. */
    private static function mintedServers(int $expiresAt, string $username, string $credential): array
    {
        return [
            ['urls' => ['stun:turn.example.com:3478'], 'username' => '', 'credential' => ''],
            [
                'urls' => ['turn:turn.example.com:3478?transport=udp', 'turns:turn.example.com:5349?transport=tcp'],
                'username' => $username,
                'credential' => $credential,
                'expiresAt' => $expiresAt,
            ],
        ];
    }

    public function testTheMintedCredentialIsWhatCoturnsUseAuthSecretComputes(): void
    {
        // Known answer, computed three independent ways: Python's hmac module, `openssl dgst -sha1 -hmac
        // <secret> -binary | openssl base64`, and Aokie's own reference minter (deploy/companion-self-host/
        // examples/mint_credentials.py, mint_turn with now = expiry - 600), which agree byte for byte.
        $minted = AokieCompanionIceConfiguration::mintTurnRestCredential(self::REST_SECRET, 1_784_160_600, 'aokie-test-opaque-id');

        $this->assertSame('1784160600:aokie-test-opaque-id', $minted['username']);
        $this->assertSame('JuQT1eNWDk2Eq9jjZeoF16I/xks=', $minted['credential']);
    }

    public function testTheOpaqueIdIsAKeyedHashOfTheEndpoint(): void
    {
        // Known answers: HMAC-SHA256(secret, "aokie-turn-id" NUL subject), first 32 hex characters (Python hmac).
        $this->assertSame('b76588edf0d149e1075b69631e94cc91', AokieCompanionIceConfiguration::opaqueId(self::REST_SECRET, "mobile\0app_test\0device_test"));
        $this->assertSame('9ad5b440809a76e58520fa0d14e32626', AokieCompanionIceConfiguration::opaqueId(self::REST_SECRET, "plugin\0app_test\0aokie"));
        $this->assertSame('2ff4bc309023ce8c082c27e0881ef28b', AokieCompanionIceConfiguration::opaqueId(self::REST_SECRET, 'discovery'));
        $this->assertNotSame(
            AokieCompanionIceConfiguration::opaqueId(self::REST_SECRET, "mobile\0app_test\0device_test"),
            AokieCompanionIceConfiguration::opaqueId('another-secret-of-at-least-thirty-two-bytes', "mobile\0app_test\0device_test"),
            'keyed: the same endpoint under another secret is another id',
        );
    }

    public function testAMobileAdmissionCarriesItsOwnMintedCredential(): void
    {
        $result = self::minting()->forAdmission('mobile', 'app_test', 'device_test', self::NOW);

        // Known answer for now = 1784160000 and the default 600 second lifetime (Python hmac and openssl).
        $this->assertSame(
            self::mintedServers(1_784_160_600, '1784160600:b76588edf0d149e1075b69631e94cc91', 'KHqzx1+wW92HnynGzGgLw5mZgwo='),
            $result['servers'],
        );
        $this->assertSame(1_784_160_600, $result['expiresAt'], 'the Companion checks this equals the earliest TURN expiry');
        $this->assertFalse($result['relayOnly']);
        $this->assertSame(['urls', 'username', 'credential', 'expiresAt'], array_keys($result['servers'][1]), 'the exact member order the Companion parses');
    }

    public function testAPluginAdmissionGetsAnotherCredentialFromTheSameSecret(): void
    {
        $result = self::minting()->forAdmission('plugin', 'app_test', 'aokie', self::NOW);

        $this->assertSame(
            self::mintedServers(1_784_160_600, '1784160600:9ad5b440809a76e58520fa0d14e32626', 'Stdmtt53cR4OkoTsqwXpKqEeWas='),
            $result['servers'],
        );
    }

    public function testMintingIsDeterministicForOneEndpointAndOneInstant(): void
    {
        $a = self::minting()->forAdmission('mobile', 'app_test', 'device_test', self::NOW);
        $b = self::minting()->forAdmission('mobile', 'app_test', 'device_test', self::NOW);
        $later = self::minting()->forAdmission('mobile', 'app_test', 'device_test', self::NOW + 1);
        $another = self::minting()->forAdmission('mobile', 'app_test', 'device_other', self::NOW);

        $this->assertSame($a, $b);
        $this->assertNotSame($a['servers'][1]['credential'], $later['servers'][1]['credential'], 'a fresh credential per admission');
        $this->assertNotSame($a['servers'][1]['username'], $another['servers'][1]['username'], 'and one identity per endpoint');
        $this->assertStringEndsWith(substr($a['servers'][1]['username'], strpos($a['servers'][1]['username'], ':')), $later['servers'][1]['username'], 'the same endpoint keeps the same id, so a coturn per-user quota holds');
    }

    public function testTheLifetimeIsConfigurableWithinCoturnsAllocationLimit(): void
    {
        foreach ([60, 1800, 3600] as $seconds) {
            $result = self::minting(ttl: (string) $seconds)->forAdmission('mobile', 'app_test', 'device_test', self::NOW);
            $this->assertSame(self::NOW + $seconds, $result['expiresAt'], "a lifetime of {$seconds}");
        }
    }

    /** @return array<string, array{string}> */
    public static function badLifetimes(): array
    {
        return [
            'too short' => ['59'],
            'too long' => ['3601'],
            'zero' => ['0'],
            'negative' => ['-5'],
            'fractional' => ['600.5'],
            'exponent' => ['6e2'],
            'words' => ['ten minutes'],
        ];
    }

    #[DataProvider('badLifetimes')]
    public function testALifetimeOutsideTheBoundsIsAConfigurationError(string $ttl): void
    {
        $this->expectException(\UnexpectedValueException::class);
        self::minting(ttl: $ttl)->forAdmission('mobile', 'app_test', 'device_test', self::NOW);
    }

    public function testRelayOnlyAndMintingTogether(): void
    {
        $result = self::minting(relayOnly: 'true')->forAdmission('plugin', 'app_test', 'aokie', self::NOW);

        $this->assertTrue($result['relayOnly']);
        $this->assertSame(self::NOW + 600, $result['expiresAt']);
    }

    public function testMintingWinsOverTheStaticListAndNeverLooksAtIt(): void
    {
        $log = [];
        // A static list that would be refused outright (and one lapsed entry that would be logged) is simply not read.
        $result = self::minting(staticJson: '{not json', log: $log)->forAdmission('mobile', 'app_test', 'device_test', self::NOW);

        $this->assertSame(1_784_160_600, $result['expiresAt']);
        $this->assertSame([], $log);
    }

    // ── discovery is public: it never mints per request ──

    public function testDiscoveryOfAMintingDeploymentListsStunOnlyAndNoCredential(): void
    {
        $result = self::minting()->forDiscovery(self::NOW);

        $this->assertSame([['urls' => ['stun:turn.example.com:3478'], 'username' => '', 'credential' => '']], $result['servers']);
        $this->assertNull($result['expiresAt']);
        $this->assertFalse($result['relayOnly']);
        $this->assertStringNotContainsString(self::REST_SECRET, json_encode($result));
    }

    public function testDiscoveryOfAMintingDeploymentWithoutStunUrlsIsEmpty(): void
    {
        $result = self::minting(urls: 'turn:turn.example.com:3478')->forDiscovery(self::NOW);

        $this->assertSame(['servers' => [], 'relayOnly' => false, 'expiresAt' => null], $result);
    }

    public function testARelayOnlyDiscoveryCarriesOneSharedCredentialPerWindow(): void
    {
        // The Companion refuses a relay-only document that has no TURN entry, so this one credential is
        // unavoidable; it is the same for every caller in a window instead of one per request.
        $config = self::minting(relayOnly: 'true');
        $first = $config->forDiscovery(self::NOW);
        $sameWindow = $config->forDiscovery(self::NOW + 599);
        $nextWindow = $config->forDiscovery(self::NOW + 600);

        // Known answer for now = 1784160000, lifetime 600: expiry (now / 600 + 2) * 600 = 1784161200 (Python hmac).
        $this->assertSame(
            self::mintedServers(1_784_161_200, '1784161200:2ff4bc309023ce8c082c27e0881ef28b', 'kpPsrDefpa6x6xTJTBgVS4wjKRI='),
            $first['servers'],
        );
        $this->assertSame(1_784_161_200, $first['expiresAt']);
        $this->assertTrue($first['relayOnly']);
        $this->assertSame($first, $sameWindow, 'every anonymous caller in a window sees the same credential');
        $this->assertSame(1_784_161_800, $nextWindow['expiresAt']);
        $this->assertNotSame($first['servers'][1]['credential'], $nextWindow['servers'][1]['credential']);
        foreach ([self::NOW => $first, self::NOW + 599 => $sameWindow, self::NOW + 600 => $nextWindow] as $now => $result) {
            $this->assertGreaterThanOrEqual($now + 600, $result['expiresAt'], 'never closer than a full lifetime to lapsing');
            $this->assertLessThanOrEqual($now + 1200, $result['expiresAt']);
        }
    }

    public function testTheSharedDiscoveryCredentialIsNeverWithinTheCompanionsThirtySecondFloor(): void
    {
        $config = self::minting(relayOnly: 'true', ttl: '60');
        for ($second = 0; $second < 130; $second++) {
            $expiresAt = $config->forDiscovery(self::NOW + $second)['expiresAt'];
            $this->assertGreaterThan(self::NOW + $second + 30, $expiresAt, "at second {$second}");
            $this->assertLessThanOrEqual(self::NOW + $second + 120, $expiresAt);
        }
    }

    // ── incomplete or unsafe minting configuration fails closed, and the log says why ──

    /** @return array<string, array{array<string,string>}> */
    public static function badMintingSettings(): array
    {
        return [
            'a secret with no URLs' => [['urls' => '']],
            'URLs with no secret' => [['secret' => '']],
            'a secret under 32 bytes' => [['secret' => 'too-short']],
            'a secret over 4096 bytes' => [['secret' => str_repeat('a', 4097)]],
            'a placeholder secret' => [['secret' => 'REPLACE_WITH_A_THIRD_INDEPENDENT_32_BYTE_OR_LONGER_RANDOM_VALUE']],
            'a placeholder secret, second form' => [['secret' => 'CHANGE_ME_change_me_change_me_change_me_change_me']],
            'no TURN URL among the URLs' => [['urls' => 'stun:turn.example.com:3478']],
            'a URL that is not an ICE URL' => [['urls' => 'turn:turn.example.com:3478,https://turn.example.com']],
            'more than eight URLs' => [['urls' => implode(',', array_fill(0, 9, 'turn:turn.example.com:3478'))]],
            'URLs pasted as JSON' => [['urls' => '["turn:turn.example.com:3478"]']],
            'relay-only with STUN only' => [['urls' => 'stun:turn.example.com:3478', 'relayOnly' => 'true']],
        ];
    }

    /** @param array<string,string> $settings */
    #[DataProvider('badMintingSettings')]
    public function testUnsafeMintingConfigurationIsRefusedOnEverySurface(array $settings): void
    {
        $config = static function (array &$log) use ($settings): AokieCompanionIceConfiguration {
            return self::minting(
                urls: $settings['urls'] ?? self::REST_URLS,
                relayOnly: $settings['relayOnly'] ?? '',
                secret: $settings['secret'] ?? self::REST_SECRET,
                log: $log,
            );
        };
        foreach ([
            'discovery' => static fn (AokieCompanionIceConfiguration $c) => $c->forDiscovery(self::NOW),
            'mobile admission' => static fn (AokieCompanionIceConfiguration $c) => $c->forAdmission('mobile', 'app_test', 'device_test', self::NOW),
            'plugin admission' => static fn (AokieCompanionIceConfiguration $c) => $c->forAdmission('plugin', 'app_test', 'aokie', self::NOW),
        ] as $surface => $ask) {
            $log = [];
            try {
                $ask($config($log));
                $this->fail("{$surface} should have been refused");
            } catch (\UnexpectedValueException) {
                $this->assertCount(1, $log, $surface);
                $this->assertStringContainsString('ice_configuration_invalid', $log[0]);
                $this->assertStringNotContainsString(self::REST_SECRET, $log[0], 'the secret never reaches the log');
            }
        }
    }
}

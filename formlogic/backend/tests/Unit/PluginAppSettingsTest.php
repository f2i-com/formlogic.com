<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\NativeAppService;
use FormLogic\Services\PluginAppSettings;
use FormLogic\Services\PluginService;
use FormLogic\Support\DataEncryption;
use PHPUnit\Framework\TestCase;

/**
 * What a plugin asks each app's owner for (appSettings): declared in its manifest and checked there,
 * each value held to its field, kept per app and plugin in the app's private folder, a secret sealed
 * for its app, plugin and key, never shown again and never among what the plugin's code is handed.
 */
final class PluginAppSettingsTest extends TestCase
{
    /** @var array<string, array<string, string>> each app's private files */
    private array $files = [];
    private array $saved = [];

    protected function setUp(): void
    {
        $this->saved = ['env' => getenv('DATA_ENCRYPTION_KEY'), 'ENV' => $_ENV['DATA_ENCRYPTION_KEY'] ?? null];
        putenv('DATA_ENCRYPTION_KEY');
        unset($_ENV['DATA_ENCRYPTION_KEY']);
    }

    protected function tearDown(): void
    {
        if ($this->saved['env'] === false) putenv('DATA_ENCRYPTION_KEY'); else putenv('DATA_ENCRYPTION_KEY=' . $this->saved['env']);
        if ($this->saved['ENV'] === null) unset($_ENV['DATA_ENCRYPTION_KEY']); else $_ENV['DATA_ENCRYPTION_KEY'] = $this->saved['ENV'];
    }

    /** @var list<string> the locks taken, by app and file, in order; and whether one is held now */
    private array $locks = [];
    private bool $holding = false;

    private function store(?DataEncryption $encryption = null): PluginAppSettings
    {
        $native = $this->createMock(NativeAppService::class);
        $native->method('readPrivateFile')->willReturnCallback(fn (string $app, string $name) => $this->files[$app][$name] ?? null);
        $native->method('writePrivateFile')->willReturnCallback(function (string $app, string $name, string $text) {
            $this->assertTrue($this->holding, 'written only under the lock');
            $this->files[$app][$name] = $text;
        });
        $native->method('removePrivateFile')->willReturnCallback(function (string $app, string $name) { unset($this->files[$app][$name]); });
        $native->method('privateFileNames')->willReturnCallback(fn (string $app, string $prefix) => array_values(array_filter(array_keys($this->files[$app] ?? []), fn (string $name) => str_starts_with($name, $prefix))));
        $native->method('withPrivateFileLock')->willReturnCallback(function (string $app, string $name, callable $work) {
            $this->assertFalse($this->holding, 'never a second lock within one');
            $this->locks[] = $app . '/' . $name;
            $this->holding = true;
            try {
                return $work();
            } finally {
                $this->holding = false;
            }
        });
        return new PluginAppSettings($native, $encryption);
    }

    /** A plugin's manifest with $plugin merged into its formlogicPlugin section. */
    private static function manifest(array $plugin = [], array $routes = []): array
    {
        return [
            'id' => 'example.codes', 'version' => '1.0.0', 'main' => 'ui/main.ui',
            'server' => ['entry' => 'server/main.logic', 'requires' => ['apiVersion' => 1, 'capabilities' => []], 'database' => ['kind' => 'private-sqlite', 'migrations' => []],
                'routes' => $routes ?: [
                    ['path' => '/api/site/codes/send', 'method' => 'POST', 'handler' => 'send'],
                    ['path' => '/api/site/codes/check', 'method' => 'POST', 'handler' => 'check'],
                    ['path' => '/api/own', 'method' => 'POST', 'handler' => 'own'],
                ]],
            'formlogicPlugin' => $plugin + ['id' => 'example.codes', 'name' => 'Example codes', 'passes' => []],
        ];
    }

    /** The schema an example plugin asks for: an id, a secret and a choice. */
    private static function schema(): array
    {
        return PluginService::pluginManifest(self::manifest(['appSettings' => [
            ['key' => 'account', 'label' => 'Account', 'type' => 'text', 'pattern' => 'AC[0-9a-f]{4}', 'message' => 'Enter the account: AC and four digits.', 'importFrom' => 'sms.ACCOUNT'],
            ['key' => 'note', 'label' => 'Note', 'type' => 'text', 'optional' => true],
            ['key' => 'token', 'label' => 'Token', 'type' => 'secret', 'pattern' => '[\x21-\x7e]{1,16}', 'message' => 'That token is not one we give.', 'missing' => 'Enter the token.'],
            ['key' => 'channel', 'label' => 'Channel', 'type' => 'choice', 'options' => [['value' => 'sms'], ['value' => 'call']], 'default' => 'sms'],
        ]]))['appSettings'];
    }

    private function refusal(callable $act): string
    {
        try {
            $act();
        } catch (\InvalidArgumentException $e) {
            return $e->getMessage();
        }
        return 'taken';
    }

    public function testAPluginsManifestSaysWhatItAsksOwnersForWhereItReachesAndWhichCodesItSends(): void
    {
        $read = PluginService::pluginManifest(self::manifest([
            'network' => ['api.sms.example'],
            'signInCodes' => ['provider' => 'example-sms', 'label' => 'By text', 'sendRoute' => '/api/site/codes/send', 'checkRoute' => '/api/site/codes/check'],
        ]));
        $this->assertSame(['api.sms.example'], $read['network']);
        $this->assertSame(['provider' => 'example-sms', 'label' => 'By text', 'sendRoute' => '/api/site/codes/send', 'checkRoute' => '/api/site/codes/check'], $read['signInCodes']);
        $this->assertSame(['/api/site/codes/send', '/api/site/codes/check'], $read['siteRoutes']);
        $this->assertSame(['network' => ['api.sms.example'], 'signInCodes' => ['provider' => 'example-sms', 'label' => 'By text'], 'appSettings' => []], PluginService::grantedView($read));
        // An update that adds a host says it apart.
        $this->assertSame(['api2.sms.example'], PluginService::review(['network' => ['api.sms.example', 'api2.sms.example']] + $read, ['network' => ['api.sms.example']])['networkAdded']);

        foreach ([
            ['network' => ['http://api.sms.example']], ['network' => ['api.sms.example:443']], ['network' => ['93.184.216.34']], ['network' => ['localhost']],
            ['network' => ['API.sms.example']], ['network' => ['*.sms.example']], ['network' => ['a.example', 'b.example', 'c.example', 'd.example', 'e.example']],
            ['signInCodes' => ['provider' => 'Example SMS', 'sendRoute' => '/api/site/codes/send', 'checkRoute' => '/api/site/codes/check']],
            ['signInCodes' => ['provider' => 'example-sms', 'sendRoute' => '/api/own', 'checkRoute' => '/api/site/codes/check']],
            ['signInCodes' => ['provider' => 'example-sms', 'sendRoute' => '/api/site/codes/send', 'checkRoute' => '/api/site/elsewhere']],
            ['appSettings' => [['key' => 'k', 'label' => 'K', 'type' => 'password']]],
            ['appSettings' => [['key' => 'k', 'label' => 'K', 'type' => 'text', 'pattern' => '(unclosed']]],
            ['appSettings' => [['key' => 'k', 'label' => 'K', 'type' => 'text', 'importFrom' => '../config']]],
            ['appSettings' => [['key' => 'k', 'label' => 'K', 'type' => 'text'], ['key' => 'k', 'label' => 'Again', 'type' => 'secret']]],
            ['appSettings' => array_fill(0, 11, ['key' => 'k', 'label' => 'K', 'type' => 'text'])],
        ] as $bad) {
            $this->assertNotSame('taken', $this->refusal(fn () => PluginService::pluginManifest(self::manifest($bad))), json_encode($bad));
        }
    }

    /**
     * A secret is sent only to hosts of the plugin's network: the one host by default, and with
     * several the ones it names, which must be. The administrator reads where each secret goes, and
     * where each setting is read from an earlier host's key file.
     */
    public function testASecretSaysWhereItMayGoAndASettingWhereItIsReadFrom(): void
    {
        $secret = ['key' => 'token', 'label' => 'Token', 'type' => 'secret', 'importFrom' => 'sms.TOKEN'];
        $one = PluginService::pluginManifest(self::manifest(['network' => ['api.sms.example'], 'appSettings' => [$secret]]));
        $this->assertSame(['api.sms.example'], $one['appSettings'][0]['sendTo'], 'the one host, said or not');
        $this->assertSame([['key' => 'token', 'label' => 'Token', 'type' => 'secret', 'sendTo' => ['api.sms.example'], 'importFrom' => 'sms.TOKEN']], PluginService::grantedView($one)['appSettings']);
        $two = PluginService::pluginManifest(self::manifest(['network' => ['api.sms.example', 'cdn.sms.example'], 'appSettings' => [$secret + ['sendTo' => ['api.sms.example']]]]));
        $this->assertSame(['api.sms.example'], $two['appSettings'][0]['sendTo']);
        $this->assertStringContainsString('names the hosts it may be sent to', $this->refusal(fn () => PluginService::pluginManifest(self::manifest(['network' => ['api.sms.example', 'cdn.sms.example'], 'appSettings' => [$secret]]))));
        $this->assertStringContainsString('only to hosts the plugin names in its network', $this->refusal(fn () => PluginService::pluginManifest(self::manifest(['network' => ['api.sms.example'], 'appSettings' => [$secret + ['sendTo' => ['evil.example']]]]))));
        $this->assertNotSame('taken', $this->refusal(fn () => PluginService::pluginManifest(self::manifest(['network' => ['api.sms.example'], 'appSettings' => [$secret + ['sendTo' => []]]]))));
        $this->assertNotSame('taken', $this->refusal(fn () => PluginService::pluginManifest(self::manifest(['network' => ['api.sms.example'], 'appSettings' => [$secret + ['sendTo' => 'api.sms.example']]]))));
        // A setting other than a secret is handed to the plugin's code: it goes nowhere of its own.
        $text = PluginService::pluginManifest(self::manifest(['network' => ['api.sms.example'], 'appSettings' => [['key' => 'account', 'label' => 'Account', 'type' => 'text']]]));
        $this->assertArrayNotHasKey('sendTo', $text['appSettings'][0]);

        // What a key file holds for the app itself is never a plugin's to take, however it is written.
        foreach (['keyHex', 'KEYHEX', 'cryptoDomains.seal', 'CryptoDomains', 'appId', 'appid.x'] as $from) {
            $this->assertStringContainsString('may not read the app\'s key', $this->refusal(fn () => PluginService::pluginManifest(self::manifest(['appSettings' => [['key' => 'k', 'label' => 'K', 'type' => 'text', 'importFrom' => $from]]]))), $from);
        }
        $this->assertSame('sms.keyHex', PluginService::pluginManifest(self::manifest(['appSettings' => [['key' => 'k', 'label' => 'K', 'type' => 'text', 'importFrom' => 'sms.keyHex']]]))['appSettings'][0]['importFrom'], 'its own name, further down, is the host\'s setting');
    }

    /**
     * A save reads, changes and writes holding the app's lock for the plugin (once, however it is
     * called); an owner may forget every plugin's settings their app keeps, a long-removed one's too.
     */
    public function testASaveHoldsItsLockAndEveryPluginsSettingsCanBeForgotten(): void
    {
        $store = $this->store();
        $schema = self::schema();
        $store->locked('app', 'example.codes', fn () => $store->save('app', 'example.codes', $schema, ['account' => 'AC1234', 'token' => 'tok']));
        $store->save('app', 'other.codes', [], []);
        $this->assertSame(['app/' . PluginAppSettings::fileName('example.codes'), 'app/' . PluginAppSettings::fileName('other.codes')], $this->locks);
        $this->assertTrue($store->has('app', 'example.codes'));
        $this->assertTrue($store->keptAny('app'));
        $this->files['app']['verify.json'] = '{}';
        $this->files['app']['plugin-other.json'] = '{}';
        $store->forgetAll('app');
        $this->assertSame(['verify.json', 'plugin-other.json'], array_keys($this->files['app']), 'only what is a plugin\'s settings by its name');
        $this->assertFalse($store->keptAny('app'));
        $this->assertFalse($store->has('app', 'example.codes'));
    }

    public function testEachValueIsHeldToItsFieldInThePluginsOwnWords(): void
    {
        $store = $this->store();
        $schema = self::schema();
        $this->assertSame('Enter the account: AC and four digits.', $this->refusal(fn () => $store->save('app', 'example.codes', $schema, ['token' => 'tok'])), 'empty, and no missing words of its own');
        $this->assertSame('Enter the account: AC and four digits.', $this->refusal(fn () => $store->save('app', 'example.codes', $schema, ['account' => 'AC12345', 'token' => 'tok'])), 'all of the pattern, not a part');
        $this->assertSame('Enter the token.', $this->refusal(fn () => $store->save('app', 'example.codes', $schema, ['account' => 'AC1234'])));
        $this->assertSame('That token is not one we give.', $this->refusal(fn () => $store->save('app', 'example.codes', $schema, ['account' => 'AC1234', 'token' => 'with space'])));
        $this->assertSame('Channel: that is not a value this setting takes.', $this->refusal(fn () => $store->save('app', 'example.codes', $schema, ['account' => 'AC1234', 'token' => 'tok', 'channel' => 'fax'])));
        $this->assertSame('This plugin has no setting of that name.', $this->refusal(fn () => $store->save('app', 'example.codes', $schema, ['account' => 'AC1234', 'token' => 'tok', 'other' => 1])));
        $this->assertSame([], $this->files, 'nothing was kept');

        $store->save('app', 'example.codes', $schema, ['account' => ' AC1234 ', 'token' => 'tok', 'channel' => 'call']);
        $this->assertSame(['values' => ['account' => 'AC1234', 'note' => '', 'channel' => 'call'], 'kept' => ['token' => true], 'configured' => true], $store->describe('app', 'example.codes', $schema));
        $this->assertSame(['account' => 'AC1234', 'note' => '', 'channel' => 'call'], $store->values('app', 'example.codes', $schema), 'what its code is handed: never a secret');
        $this->assertSame(['token' => 'tok'], $store->secrets('app', 'example.codes', $schema));
        $this->assertArrayHasKey(PluginAppSettings::fileName('example.codes'), $this->files['app']);
        $this->assertMatchesRegularExpression('/^plugin-[0-9a-f]{24}\.json$/D', PluginAppSettings::fileName('example.codes'));
    }

    public function testAnEmptySecretKeepsTheOneKeptAndASecretIsNeverShownAgain(): void
    {
        $store = $this->store();
        $schema = self::schema();
        $store->save('app', 'example.codes', $schema, ['account' => 'AC1234', 'token' => 'first-token']);
        $shown = $store->describe('app', 'example.codes', $schema);
        $this->assertStringNotContainsString('first-token', json_encode($shown));
        // A new id, and the token left empty: it keeps the one kept.
        $store->save('app', 'example.codes', $schema, ['account' => 'AC9999', 'token' => '']);
        $this->assertSame(['token' => 'first-token'], $store->secrets('app', 'example.codes', $schema));
        $this->assertSame('AC9999', $store->values('app', 'example.codes', $schema)['account']);
        // A setting left out keeps what it was.
        $store->save('app', 'example.codes', $schema, ['note' => 'hello']);
        $this->assertSame(['account' => 'AC9999', 'note' => 'hello', 'channel' => 'sms'], $store->values('app', 'example.codes', $schema));
        $store->clear('app', 'example.codes');
        $this->assertFalse($store->configured('app', 'example.codes', $schema));
        $this->assertSame(['token' => false], $store->describe('app', 'example.codes', $schema)['kept']);
    }

    public function testASecretIsSealedForItsAppPluginAndKeyWhereTheSiteHasADataKey(): void
    {
        $key = DataEncryption::generateKey();
        putenv('DATA_ENCRYPTION_KEY=' . $key);
        $_ENV['DATA_ENCRYPTION_KEY'] = $key;
        $store = $this->store();
        $schema = self::schema();
        $store->save('app', 'example.codes', $schema, ['account' => 'AC1234', 'token' => 'sealed-token']);
        $text = $this->files['app'][PluginAppSettings::fileName('example.codes')];
        $this->assertStringNotContainsString('sealed-token', $text);
        $this->assertTrue(json_decode($text, true)['secrets']['token']['sealed']);
        $this->assertSame(['token' => 'sealed-token'], $store->secrets('app', 'example.codes', $schema));

        // Moved to another app, it reads nothing: the owner of that one has given no token.
        $this->files['other'][PluginAppSettings::fileName('example.codes')] = $text;
        $this->assertSame([], $store->secrets('other', 'example.codes', $schema));
        $this->assertFalse($store->configured('other', 'example.codes', $schema));
        // And under another plugin's name, nothing at all.
        $this->assertSame([], $store->secrets('app', 'other.codes', $schema));
    }

    public function testWithoutADataKeyASecretIsKeptAsItWasGivenAndSaidToBe(): void
    {
        $store = $this->store();
        $schema = self::schema();
        // A token that looks like a sealed value is still the owner's token.
        $store->save('app', 'example.codes', $schema, ['account' => 'AC1234', 'token' => 'fle1.abc']);
        $this->assertFalse(json_decode($this->files['app'][PluginAppSettings::fileName('example.codes')], true)['secrets']['token']['sealed']);
        $this->assertSame(['token' => 'fle1.abc'], $store->secrets('app', 'example.codes', $schema));
    }

    public function testASiteWhoseDataKeyCannotBeUsedKeepsNoSecret(): void
    {
        putenv('DATA_ENCRYPTION_KEY=not-a-key');
        $_ENV['DATA_ENCRYPTION_KEY'] = 'not-a-key';
        $store = $this->store();
        $this->assertStringContainsString('data key cannot be used', $this->refusal(fn () => $store->save('app', 'example.codes', self::schema(), ['account' => 'AC1234', 'token' => 'tok'])));
        $this->assertSame([], $this->files);
    }
}

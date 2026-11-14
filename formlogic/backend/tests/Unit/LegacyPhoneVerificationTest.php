<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\AppService;
use FormLogic\Services\LegacyPhoneVerification;
use FormLogic\Services\NativeAppService;
use FormLogic\Services\NativePhoneVerification;
use FormLogic\Services\PluginAppSettings;
use FormLogic\Services\PluginNetwork;
use FormLogic\Services\PluginService;
use FormLogic\Support\DataEncryption;
use FormLogic\Tests\Support\PluginsOnSqlite;
use PHPUnit\Framework\TestCase;

/**
 * The upgrade from FormLogic sending Twilio Verify codes itself to the plugin that ships for them:
 * an app that kept its owner's details in private/verify.json keeps sending codes with nobody doing
 * anything. The plugin is installed for the site once, the details move into its app settings (a
 * sealed token sealed again for the plugin, never written in the clear), and the file goes; a token
 * that does not open here moves nowhere and its file stays; and nothing overrules an owner's save or
 * an administrator's removal of the plugin.
 */
final class LegacyPhoneVerificationTest extends TestCase
{
    private const PLUGIN_APP = 'plugin-app-1';
    private const TOKEN = 'legacy-auth-token';
    private const MARKER = 'plugin_upgrade:formlogic.twilio-verify';

    private PluginsOnSqlite $db;
    /** @var array<string, array<string, string>> */
    private array $files = [];
    /** @var list<string> the apps a project was installed into */
    private array $installs = [];
    private bool $installFails = false;
    private string $account = '';
    private string $service = '';
    private array $saved = [];

    protected function setUp(): void
    {
        $this->saved = ['env' => getenv('DATA_ENCRYPTION_KEY'), 'ENV' => $_ENV['DATA_ENCRYPTION_KEY'] ?? null];
        $this->useKey(null);
        $this->db = new PluginsOnSqlite();
        $this->account = 'A' . 'C' . bin2hex(random_bytes(16));
        $this->service = 'V' . 'A' . bin2hex(random_bytes(16));
    }

    protected function tearDown(): void
    {
        if ($this->saved['env'] === false) putenv('DATA_ENCRYPTION_KEY'); else putenv('DATA_ENCRYPTION_KEY=' . $this->saved['env']);
        if ($this->saved['ENV'] === null) unset($_ENV['DATA_ENCRYPTION_KEY']); else $_ENV['DATA_ENCRYPTION_KEY'] = $this->saved['ENV'];
    }

    private function useKey(?string $key): void
    {
        if ($key === null) {
            putenv('DATA_ENCRYPTION_KEY');
            unset($_ENV['DATA_ENCRYPTION_KEY']);
        } else {
            putenv('DATA_ENCRYPTION_KEY=' . $key);
            $_ENV['DATA_ENCRYPTION_KEY'] = $key;
        }
    }

    private function native(): NativeAppService
    {
        $manifest = json_decode((string) file_get_contents(dirname(__DIR__, 2) . '/resources/plugins/twilio-verify/manifest.json'), true);
        $native = $this->createMock(NativeAppService::class);
        $native->method('readPrivateFile')->willReturnCallback(fn (string $app, string $name) => $this->files[$app][$name] ?? null);
        $native->method('writePrivateFile')->willReturnCallback(function (string $app, string $name, string $text) { $this->files[$app][$name] = $text; });
        $native->method('removePrivateFile')->willReturnCallback(function (string $app, string $name) { unset($this->files[$app][$name]); });
        $native->method('withPrivateFileLock')->willReturnCallback(fn (string $app, string $name, callable $work) => $work());
        $native->method('privateFileNames')->willReturnCallback(fn (string $app, string $prefix) => array_values(array_filter(array_keys($this->files[$app] ?? []), fn (string $name) => str_starts_with($name, $prefix))));
        $native->method('install')->willReturnCallback(function (string $appId, array $project) {
            if ($this->installFails) throw new \RuntimeException('The SoftN runtime refused it');
            $this->installs[] = $appId;
            return $project;
        });
        $native->method('installedManifest')->willReturnCallback(fn (string $appId) => $appId === self::PLUGIN_APP
            ? ((int) $this->db->getConnection()->query('SELECT COUNT(*) FROM plugins')->fetchColumn() > 0 ? $manifest : [])
            : ['config' => ['app' => ['verificationProvider' => 'twilio-verify']]]);
        return $native;
    }

    private function plugins(NativeAppService $native): PluginService
    {
        $apps = $this->createMock(AppService::class);
        $apps->method('createApp')->willReturn(['id' => self::PLUGIN_APP]);
        return new PluginService($this->db, $apps, $native);
    }

    /** @return array{0: LegacyPhoneVerification, 1: PluginService, 2: PluginAppSettings, 3: NativePhoneVerification} the pieces, wired as the site wires them */
    private function wired(): array
    {
        $native = $this->native();
        $plugins = $this->plugins($native);
        $settings = new PluginAppSettings($native);
        $legacy = new LegacyPhoneVerification($native, $plugins, $settings);
        return [$legacy, $plugins, $settings, new NativePhoneVerification($native, $plugins, $settings, new PluginNetwork($native), $legacy)];
    }

    /** What FormLogic kept before, as it wrote it: the token sealed for the app where the site had a data key. */
    private function keptBefore(string $appId, ?string $key): void
    {
        $sealed = $key !== null;
        $this->files[$appId]['verify.json'] = json_encode(['provider' => 'twilio-verify', 'accountSid' => $this->account, 'serviceSid' => $this->service,
            'authToken' => $sealed ? DataEncryption::fromEnvironment()->seal(self::TOKEN, 'native-app-verify:' . $appId) : self::TOKEN, 'sealed' => $sealed]);
    }

    private function schema(PluginService $plugins): array
    {
        return $plugins->granted($plugins->find(LegacyPhoneVerification::PLUGIN))['appSettings'];
    }

    private function marker(): ?array
    {
        $value = $this->db->getConnection()->query("SELECT meta_value FROM system_meta WHERE meta_key = '" . self::MARKER . "'")->fetchColumn();
        return $value === false ? null : json_decode((string) $value, true);
    }

    public function testAnAppsDetailsMoveIntoTheBuiltInPluginWhichIsInstalledForTheSiteOnce(): void
    {
        $key = DataEncryption::generateKey();
        $this->useKey($key);
        $this->keptBefore('app', $key);
        $this->keptBefore('other', $key);
        [$legacy, $plugins, $settings] = $this->wired();

        $legacy->upgrade('app');
        $plugin = $plugins->find(LegacyPhoneVerification::PLUGIN);
        $this->assertNotNull($plugin);
        $this->assertSame(['builtin', true, self::PLUGIN_APP], [$plugin['source'], $plugin['enabled'], $plugin['appId']]);
        $this->assertSame(PluginService::SYSTEM_USER_ID, $this->db->getConnection()->query('SELECT installed_by FROM plugins')->fetchColumn());
        $this->assertSame([self::PLUGIN_APP], $this->installs);
        $this->assertSame('done', $this->marker()['state']);
        $this->assertArrayNotHasKey('verify.json', $this->files['app']);
        $schema = $this->schema($plugins);
        $this->assertSame(['accountSid' => $this->account, 'serviceSid' => $this->service], $settings->values('app', LegacyPhoneVerification::PLUGIN, $schema));
        $this->assertSame(['authToken' => self::TOKEN], $settings->secrets('app', LegacyPhoneVerification::PLUGIN, $schema));
        $kept = $this->files['app'][PluginAppSettings::fileName(LegacyPhoneVerification::PLUGIN)];
        $this->assertStringNotContainsString(self::TOKEN, $kept, 'sealed again, never written in the clear');
        $this->assertTrue(json_decode($kept, true)['secrets']['authToken']['sealed']);

        // The next app's move finds the plugin there, and installs nothing.
        $legacy->upgrade('other');
        $this->assertSame([self::PLUGIN_APP], $this->installs);
        $this->assertTrue($settings->configured('other', LegacyPhoneVerification::PLUGIN, $schema));
        $this->assertArrayNotHasKey('verify.json', $this->files['other']);
        $legacy->upgrade('app');
        $this->assertSame([self::PLUGIN_APP], $this->installs, 'nothing to move twice');
    }

    public function testAnAdministratorWhoRemovedThePluginAfterTheUpgradeIsNotOverruled(): void
    {
        $this->keptBefore('app', null);
        $this->db->getConnection()->exec("INSERT INTO system_meta (meta_key, meta_value) VALUES ('" . self::MARKER . "', '2026-11-14 00:00:00')");
        [$legacy] = $this->wired();
        $legacy->upgrade('app');
        $this->assertSame([], $this->installs);
        $this->assertArrayHasKey('verify.json', $this->files['app'], 'left for an administrator who installs it again');
    }

    /**
     * An upgrade that finds the plugin installed already (an administrator installed it) writes that
     * down too: the administrator who later removes it is not overruled by the next app's move.
     */
    public function testAPluginTheUpgradeFoundInstalledIsNotPutBackOnceRemoved(): void
    {
        $this->db->plugin(LegacyPhoneVerification::PLUGIN, self::PLUGIN_APP);
        $this->keptBefore('app', null);
        $this->keptBefore('later', null);
        [$legacy] = $this->wired();
        $legacy->upgrade('app');
        $this->assertSame('done', $this->marker()['state']);
        $this->assertArrayNotHasKey('verify.json', $this->files['app']);
        $this->db->getConnection()->exec('DELETE FROM plugins');
        [$legacy] = $this->wired();
        $legacy->upgrade('later');
        $this->assertSame([], $this->installs);
        $this->assertArrayHasKey('verify.json', $this->files['later']);
    }

    /** An install that failed is not tried on every request: an hour later at the soonest. */
    public function testAFailedInstallIsTriedAgainAnHourLaterAtTheSoonest(): void
    {
        $this->keptBefore('app', null);
        $this->installFails = true;
        [$legacy] = $this->wired();
        $legacy->upgrade('app');
        $this->assertSame('failed', $this->marker()['state']);
        $this->installFails = false;
        [$legacy] = $this->wired();
        $legacy->upgrade('app');
        $this->assertSame([], $this->installs, 'not within the hour');
        $this->assertArrayHasKey('verify.json', $this->files['app']);
        $this->db->getConnection()->exec("UPDATE system_meta SET meta_value = '" . json_encode(['state' => 'failed', 'at' => time() - 3601]) . "'");
        [$legacy] = $this->wired();
        $legacy->upgrade('app');
        $this->assertSame([self::PLUGIN_APP], $this->installs);
        $this->assertSame('done', $this->marker()['state']);
        $this->assertArrayNotHasKey('verify.json', $this->files['app']);
    }

    /**
     * A plain token moves. One sealed under a key that is not here (gone, or mistyped where this
     * runs), or any token while the site's data key cannot be used, moves nowhere: the file is kept
     * as it was, its token in it, and moves on a later request once the key is right.
     */
    public function testAPlainTokenMovesAndOneThatDoesNotOpenStaysWhereItIs(): void
    {
        $this->keptBefore('plain', null);
        $key = DataEncryption::generateKey();
        $this->useKey($key);
        $this->keptBefore('sealed', $key);
        $this->useKey(null);
        $before = $this->files['sealed']['verify.json'];
        [$legacy, $plugins, $settings] = $this->wired();
        $legacy->upgrade('plain');
        $legacy->upgrade('sealed');
        $schema = $this->schema($plugins);
        $this->assertSame(['authToken' => self::TOKEN], $settings->secrets('plain', LegacyPhoneVerification::PLUGIN, $schema));
        $this->assertSame($before, $this->files['sealed']['verify.json'], 'kept as it was');
        $this->assertFalse($settings->has('sealed', LegacyPhoneVerification::PLUGIN), 'and nothing moved');

        // A key set but unusable moves nothing, not even a plain token.
        $this->keptBefore('plain2', null);
        $this->useKey('not-a-key');
        $legacy->upgrade('plain2');
        $this->assertArrayHasKey('verify.json', $this->files['plain2']);
        $this->assertFalse($settings->has('plain2', LegacyPhoneVerification::PLUGIN));

        // The key back where this runs: a later request moves the sealed one.
        $this->useKey($key);
        $legacy->upgrade('sealed');
        $this->assertArrayNotHasKey('verify.json', $this->files['sealed']);
        $this->assertSame(['authToken' => self::TOKEN], $settings->secrets('sealed', LegacyPhoneVerification::PLUGIN, $schema));
    }

    /**
     * The move comes before an owner's save, never after: their new details stand. Where the old
     * token could not be moved before they saved, their save wins, and the old file only goes.
     */
    public function testAnOwnersSaveIsNeverOverwrittenByTheMove(): void
    {
        $this->keptBefore('app', null);
        [, $plugins, $settings, $verification] = $this->wired();
        $newAccount = 'A' . 'C' . bin2hex(random_bytes(16));
        $verification->save('app', ['accountSid' => $newAccount]);
        $schema = $this->schema($plugins);
        $this->assertSame($newAccount, $settings->values('app', LegacyPhoneVerification::PLUGIN, $schema)['accountSid'], 'theirs, over the old one moved first');
        $this->assertSame(['authToken' => self::TOKEN], $settings->secrets('app', LegacyPhoneVerification::PLUGIN, $schema), 'the old token, which they kept');
        $this->assertArrayNotHasKey('verify.json', $this->files['app']);

        // The old token sealed under a key that is not here: their save stands, and later the old file goes.
        $key = DataEncryption::generateKey();
        $this->useKey($key);
        $this->keptBefore('other', $key);
        $this->useKey(null);
        $verification->save('other', ['accountSid' => $newAccount, 'serviceSid' => $this->service, 'authToken' => 'their-new-token']);
        $this->assertArrayHasKey('verify.json', $this->files['other']);
        $this->useKey($key);
        [$legacy] = $this->wired();
        $legacy->upgrade('other');
        $this->assertArrayNotHasKey('verify.json', $this->files['other']);
        $this->assertSame(['authToken' => 'their-new-token'], $settings->secrets('other', LegacyPhoneVerification::PLUGIN, $schema));
        $this->assertSame($newAccount, $settings->values('other', LegacyPhoneVerification::PLUGIN, $schema)['accountSid']);
    }

    public function testTheOwnersPanelAfterTheUpgradeShowsTheCodesStillOn(): void
    {
        $this->keptBefore('app', null);
        [, , , $verification] = $this->wired();
        $shown = json_decode(json_encode($verification->describe('app')), true);
        $this->assertSame(['id' => 'formlogic.twilio-verify', 'name' => 'Sign-in codes by text (Twilio Verify)', 'label' => 'By text message, through Twilio Verify', 'enabled' => true], $shown['plugin']);
        $this->assertTrue($shown['configured']);
        $this->assertSame(['accountSid' => $this->account, 'serviceSid' => $this->service], $shown['values']);
        $this->assertSame(['authToken' => true], $shown['kept']);
        $this->assertSame(['verify.twilio.com'], $shown['fields'][2]['sendTo'], 'where the token may go, for the owner to see');
        $this->assertStringNotContainsString(self::TOKEN, json_encode($shown));
    }
}

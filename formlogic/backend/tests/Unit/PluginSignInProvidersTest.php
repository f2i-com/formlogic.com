<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\AppService;
use FormLogic\Services\NativeAppService;
use FormLogic\Services\PluginAppSettings;
use FormLogic\Services\PluginService;
use FormLogic\Tests\Support\PluginsOnSqlite;
use PHPUnit\Framework\TestCase;

/**
 * One provider of sign-in codes, one plugin that is on: a plugin that would send the codes another
 * plugin that is on sends already is refused as it is installed, updated or turned on, and the
 * refusal names the other. A plugin removed takes every app's settings for it along.
 */
final class PluginSignInProvidersTest extends TestCase
{
    private PluginsOnSqlite $db;
    /** @var array<string, array> each plugin app's manifest */
    private array $manifests = [];
    /** @var list<string> the private files removed from every app */
    private array $removedEverywhere = [];

    protected function setUp(): void
    {
        $this->db = new PluginsOnSqlite();
    }

    /** An uploaded plugin's project that sends codes for $provider. */
    private static function project(string $id, string $version, string $provider): array
    {
        $routes = [];
        foreach (['send', 'check'] as $handler) {
            $routes[] = ['path' => '/api/site/codes/' . $handler, 'method' => 'POST', 'handler' => $handler, 'transaction' => 'read', 'authorization' => 'anonymous'];
        }
        $manifest = [
            'id' => $id, 'name' => 'Codes', 'version' => $version, 'main' => 'ui/main.ui',
            'server' => ['entry' => 'server/main.logic', 'requires' => ['apiVersion' => 1, 'capabilities' => []], 'database' => ['kind' => 'private-sqlite', 'migrations' => []], 'routes' => $routes],
            'formlogicPlugin' => ['id' => $id, 'name' => 'Codes from ' . $id, 'passes' => [],
                'signInCodes' => ['provider' => $provider, 'sendRoute' => '/api/site/codes/send', 'checkRoute' => '/api/site/codes/check']],
        ];
        return ['files' => ['manifest.json' => json_encode($manifest), 'ui/main.ui' => '<Text>Codes</Text>', 'server/main.logic' => 'function send(req) { return {status: 200, body: {}}; }']];
    }

    private function plugins(): PluginService
    {
        $native = $this->createMock(NativeAppService::class);
        $native->method('installedManifest')->willReturnCallback(fn (string $appId) => $this->manifests[$appId] ?? []);
        $native->method('install')->willReturnCallback(function (string $appId, array $project) {
            $this->manifests[$appId] = json_decode($project['files']['manifest.json'], true);
            return $project;
        });
        $native->method('project')->willReturn(['version' => 1]);
        $native->method('removePrivateFileEverywhere')->willReturnCallback(function (string $name) {
            $this->removedEverywhere[] = $name;
            return 2;
        });
        $apps = $this->createMock(AppService::class);
        $apps->method('createApp')->willReturnCallback(fn (array $data) => ['id' => 'app-' . substr(md5($data['slug']), 0, 8)]);
        return new PluginService($this->db, $apps, $native);
    }

    /** An installed plugin that sends codes for $provider, its manifest as an install keeps it. */
    private function installed(string $id, string $provider, bool $enabled = true): void
    {
        $appId = 'app-' . $id;
        $this->manifests[$appId] = json_decode(self::project($id, '1.0.0', $provider)['files']['manifest.json'], true);
        $this->db->plugin($id, $appId, $enabled);
    }

    private function refusal(callable $act): string
    {
        try {
            $act();
        } catch (\InvalidArgumentException $e) {
            return $e->getMessage();
        }
        return 'done';
    }

    public function testAPluginThatWouldSendCodesAnotherSendsIsNotInstalled(): void
    {
        $this->installed('someone.codes', 'twilio-verify');
        $plugins = $this->plugins();
        $this->assertSame('The plugin "Plugin someone.codes" sends the sign-in codes for "twilio-verify" already. Turn it off or remove it first.',
            $this->refusal(fn () => $plugins->installBuiltin('formlogic.twilio-verify', 'admin')));
        $this->assertNull($plugins->find('formlogic.twilio-verify'));
        $this->assertStringContainsString('sends the sign-in codes for "twilio-verify" already', $this->refusal(fn () => $plugins->installUpload(self::project('another.codes', '1.0.0', 'twilio-verify'), 'admin')));
        $this->assertStringContainsString('sends the sign-in codes for "twilio-verify" already', $this->refusal(fn () => $plugins->inspect(self::project('another.codes', '1.0.0', 'twilio-verify'), 'upload')), 'said as it is read, before anything is installed');
        // A plugin for another provider is no matter.
        $this->assertSame('done', $this->refusal(fn () => $plugins->installUpload(self::project('another.codes', '1.0.0', 'other-sms'), 'admin')));
    }

    public function testOneTurnedOffIsNoClaimUntilItIsTurnedOnAgain(): void
    {
        $this->installed('someone.codes', 'twilio-verify', false);
        $plugins = $this->plugins();
        $this->assertNotNull($plugins->installBuiltin('formlogic.twilio-verify', 'admin'));
        $this->assertStringContainsString('The plugin "Sign-in codes by text (Twilio Verify)" sends the sign-in codes for "twilio-verify" already', $this->refusal(fn () => $plugins->setEnabled('someone.codes', true)));
        $this->assertFalse($plugins->find('someone.codes')['enabled']);
        $plugins->setEnabled('formlogic.twilio-verify', false);
        $this->assertTrue($plugins->setEnabled('someone.codes', true)['enabled']);
        $this->assertSame('someone.codes', $plugins->signInCodesProvider('twilio-verify')['manifestId']);
        // Turning one off is never refused.
        $this->assertFalse($plugins->setEnabled('someone.codes', false)['enabled']);
    }

    public function testAnUpdateThatWouldSendCodesAnotherSendsIsRefused(): void
    {
        $this->installed('formlogic.twilio-verify', 'twilio-verify');
        $plugins = $this->plugins();
        $this->assertSame('done', $this->refusal(fn () => $plugins->installUpload(self::project('someone.codes', '1.0.0', 'other-sms'), 'admin')));
        $this->assertStringContainsString('sends the sign-in codes for "twilio-verify" already', $this->refusal(fn () => $plugins->installUpload(self::project('someone.codes', '2.0.0', 'twilio-verify'), 'admin')));
        $this->assertSame('1.0.0', $plugins->find('someone.codes')['version']);
        // Its own update, for its own provider, is its own.
        $this->assertSame('done', $this->refusal(fn () => $plugins->installUpload(self::project('someone.codes', '2.0.0', 'other-sms'), 'admin')));
    }

    public function testARemovedPluginTakesEveryAppsSettingsForItAlong(): void
    {
        $this->installed('someone.codes', 'other-sms');
        $plugins = $this->plugins();
        $plugins->remove('someone.codes');
        $this->assertSame([PluginAppSettings::fileName('someone.codes')], $this->removedEverywhere);
        $this->assertNull($plugins->find('someone.codes'));
    }
}

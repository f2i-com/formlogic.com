<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Support\DataEncryption;

/**
 * The one place that remembers FormLogic once sent Twilio Verify codes itself, before sign-in codes
 * were a plugin's (docs/PLUGINS.md, "Sign-in codes"). An app's owner kept their details in the app's
 * private folder (`verify.json`: accountSid, serviceSid, authToken, the token sealed for
 * `native-app-verify:{appId}` where the site had a data key).
 *
 * The first time anything asks about such an app's sign-in codes (a sign-in, or its owner's
 * settings, before any save of theirs), the details are moved into the app settings of the plugin
 * that ships for them, `formlogic.twilio-verify`, and the file is removed. A sealed token is opened
 * under its old context and sealed again under the plugin's (PluginAppSettings), never written in
 * the clear. Where it does not open here (the data key missing or mistyped where this runs, or
 * unusable), nothing moves and the file is kept as it is, for a later request. The plugin is
 * installed for the site first when it is not installed (PluginService::installForUpgrade: once, so
 * an administrator who removes it afterwards is not overruled). The move holds the app's lock on the
 * plugin's settings, and settings its owner saved meanwhile win: the old file is then only removed.
 * So an app that sent codes before keeps sending them, and no administrator has anything to do.
 *
 * Delete this class, and its calls in NativePhoneVerification, once no site keeps a verify.json.
 */
final class LegacyPhoneVerification
{
    public const PLUGIN = 'formlogic.twilio-verify';
    private const FILE = 'verify.json';
    private const CONTEXT = 'native-app-verify:';

    public function __construct(private NativeAppService $native, private PluginService $plugins, private PluginAppSettings $settings)
    {
    }

    public function upgrade(string $appId): void
    {
        $text = $this->native->readPrivateFile($appId, self::FILE);
        if ($text === null) {
            return;
        }
        $kept = json_decode($text, true);
        if (!is_array($kept) || !is_string($kept['accountSid'] ?? null) || !is_string($kept['serviceSid'] ?? null) || !is_string($kept['authToken'] ?? null)) {
            return;
        }
        // The token as the site kept it. One that does not open here is not moved, and the file stays
        // as it is: it may be its only copy, and a later request (or a fixed key) moves it.
        $encryption = DataEncryption::fromEnvironment();
        if (!$encryption->usable()) {
            return;
        }
        $token = $kept['authToken'];
        if (($kept['sealed'] ?? false) === true) {
            try {
                $token = $encryption->open($token, self::CONTEXT . $appId);
            } catch (\Throwable) {
                return;
            }
        }
        try {
            $plugin = $this->plugins->installForUpgrade(self::PLUGIN);
        } catch (\Throwable $e) {
            error_log('Sign-in codes: ' . self::PLUGIN . ' could not be installed for app ' . $appId . ': ' . get_class($e));
            return;
        }
        if ($plugin === null) {
            return;
        }
        $schema = $this->plugins->granted($plugin)['appSettings'];
        try {
            $this->settings->locked($appId, self::PLUGIN, function () use ($appId, $kept, $token, $schema): void {
                if ($this->native->readPrivateFile($appId, self::FILE) === null) {
                    return;
                }
                // What its owner saved for the plugin since is theirs: the old details only go.
                if (!$this->settings->has($appId, self::PLUGIN)) {
                    $this->settings->save($appId, self::PLUGIN, $schema, ['accountSid' => $kept['accountSid'], 'serviceSid' => $kept['serviceSid'], 'authToken' => $token]);
                }
                $this->native->removePrivateFile($appId, self::FILE);
            });
        } catch (\Throwable $e) {
            error_log('Sign-in codes: the Twilio details of app ' . $appId . ' were not moved to ' . self::PLUGIN . ': ' . get_class($e));
        }
    }

    /** Whether the app still keeps details from before codes were a plugin's. */
    public function kept(string $appId): bool
    {
        return $this->native->readPrivateFile($appId, self::FILE) !== null;
    }

    /** Its owner turns the codes off, or forgets what is kept: the old details go too. */
    public function forget(string $appId): void
    {
        $this->native->removePrivateFile($appId, self::FILE);
    }
}

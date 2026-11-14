<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Support\DataEncryption;

/**
 * What a plugin asks each app's owner for (`formlogicPlugin.appSettings`, docs/PLUGINS.md), as the
 * owner set it for one app. Nothing here knows what any plugin does with it.
 *
 * Kept per app and per plugin in the app's private folder (`plugin-<24 hex of the plugin id's
 * SHA-256>.json`, NativeAppService's private files), never among the app's own files or in the
 * configuration its runner reads. A `secret` is sealed with the site's data key (DataEncryption)
 * where one is set, for this app, plugin and key; it is never shown again (an empty value on a save
 * keeps the one kept), and never handed to the plugin's code, a log or an answer: the site fills it
 * into a request the plugin asks it to make (PluginNetwork), and only to the hosts that secret may
 * go to (its `sendTo`). Every other setting is handed to the plugin's code as `appSettings`.
 *
 * A save reads, changes and writes them holding a lock of the app's for that plugin (a lock file
 * beside them), as the upgrade's move does (LegacyPhoneVerification): none is lost to another.
 */
final class PluginAppSettings
{
    private const CONTEXT = 'plugin-app-settings:';
    /** The name of a plugin's settings file, as fileName() makes it. */
    private const FILE_PATTERN = '/^plugin-[0-9a-f]{24}\.json$/D';

    /** @var array<string, true> the locks this request holds now, by app and plugin: within one, no second is taken */
    private array $holding = [];

    public function __construct(private NativeAppService $native, private ?DataEncryption $encryption = null)
    {
    }

    /**
     * Run $work holding the app's lock on its settings for the plugin, so a read-modify-write of
     * them is never interleaved with another's. A save within it takes no second one.
     *
     * @template T
     * @param callable(): T $work
     * @return T
     */
    public function locked(string $appId, string $pluginId, callable $work): mixed
    {
        $held = $appId . "\0" . $pluginId;
        if (isset($this->holding[$held])) {
            return $work();
        }
        return $this->native->withPrivateFileLock($appId, self::fileName($pluginId), function () use ($held, $work) {
            $this->holding[$held] = true;
            try {
                return $work();
            } finally {
                unset($this->holding[$held]);
            }
        });
    }

    private function encryption(): DataEncryption
    {
        return $this->encryption ??= DataEncryption::fromEnvironment();
    }

    /** The private file an app keeps a plugin's settings in. */
    public static function fileName(string $pluginId): string
    {
        return 'plugin-' . substr(hash('sha256', $pluginId), 0, 24) . '.json';
    }

    /** A field's pattern as PHP matches it: the whole value, as UTF-8. */
    public static function pattern(string $pattern): string
    {
        return '~^(?:' . str_replace('~', '\~', $pattern) . ')$~Du';
    }

    /**
     * What the owner sees: every setting but a secret as kept (or its default), which secrets are
     * kept, and whether everything the plugin needs is there.
     *
     * @return array{values: array<string, mixed>, kept: array<string, bool>, configured: bool}
     */
    public function describe(string $appId, string $pluginId, array $schema): array
    {
        $kept = $this->read($appId, $pluginId);
        $secrets = $this->opened($appId, $pluginId, $schema, $kept);
        $shown = [];
        foreach ($schema as $field) {
            if ($field['type'] === 'secret') {
                $shown[$field['key']] = isset($secrets[$field['key']]);
            }
        }
        return ['values' => self::valuesOf($schema, $kept), 'kept' => $shown, 'configured' => self::complete($schema, $kept['values'], $secrets)];
    }

    /** The settings the plugin's code is handed: every one but a secret, as kept, or its default. */
    public function values(string $appId, string $pluginId, array $schema): array
    {
        return self::valuesOf($schema, $this->read($appId, $pluginId));
    }

    /**
     * The owner's secrets, opened, by key: for the site to fill into the requests the plugin asks
     * for, and never for its code. One that cannot be opened (its data key is gone) is not there.
     */
    public function secrets(string $appId, string $pluginId, array $schema): array
    {
        return $this->opened($appId, $pluginId, $schema, $this->read($appId, $pluginId));
    }

    /** Whether every setting the plugin needs is there: each required text, and each required secret, which opens. */
    public function configured(string $appId, string $pluginId, array $schema): bool
    {
        $kept = $this->read($appId, $pluginId);
        return self::complete($schema, $kept['values'], $this->opened($appId, $pluginId, $schema, $kept));
    }

    /**
     * Keep the owner's settings for the app. $input names some or all of them: one it leaves out
     * keeps what is kept, and so does an empty secret (the owner never sees one again). Each is held
     * to its field (all of its pattern, its range, its choices), and then every one required must be
     * there, unless !$complete (an upgrade moves what it has, and the owner adds the rest).
     */
    public function save(string $appId, string $pluginId, array $schema, mixed $input, bool $complete = true): void
    {
        $this->locked($appId, $pluginId, function () use ($appId, $pluginId, $schema, $input, $complete): void {
            $kept = $this->read($appId, $pluginId);
            [$values, $secrets] = $this->merged($appId, $pluginId, $schema, $input, $kept, $complete);
            $stored = [];
            foreach ($secrets as $key => $plain) {
                if ($plain === null) {
                    $stored[$key] = $kept['secrets'][$key];
                    continue;
                }
                try {
                    $sealed = $this->encryption()->seal($plain, self::context($pluginId, $appId, $key));
                } catch (\Throwable) {
                    throw new \InvalidArgumentException('This site\'s data key cannot be used, so no secret can be kept. Ask the site\'s administrator.');
                }
                // Said, not guessed from the text: a secret kept plain (no data key) may look like a sealed one.
                $stored[$key] = ['value' => $sealed, 'sealed' => $this->encryption()->enabled()];
            }
            $this->native->writePrivateFile($appId, self::fileName($pluginId), json_encode(
                ['plugin' => $pluginId, 'values' => (object) $values, 'secrets' => (object) $stored],
                JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
            ));
        });
    }

    /** Whether save() would take $input, without keeping anything: throws as it would. */
    public function check(string $appId, string $pluginId, array $schema, mixed $input): void
    {
        $this->merged($appId, $pluginId, $schema, $input, $this->read($appId, $pluginId), true);
    }

    public function clear(string $appId, string $pluginId): void
    {
        $this->locked($appId, $pluginId, fn () => $this->native->removePrivateFile($appId, self::fileName($pluginId)));
    }

    /** Whether the app keeps settings for this plugin, whatever they hold. */
    public function has(string $appId, string $pluginId): bool
    {
        return $this->native->readPrivateFile($appId, self::fileName($pluginId)) !== null;
    }

    /** Whether the app keeps any plugin's settings: a plugin's, whichever it was. */
    public function keptAny(string $appId): bool
    {
        return $this->kept($appId) !== [];
    }

    /** Forget every plugin's settings the app keeps, for any plugin (one long removed among them). */
    public function forgetAll(string $appId): void
    {
        foreach ($this->kept($appId) as $name) {
            $this->native->removePrivateFile($appId, $name);
        }
    }

    /** @return list<string> the app's plugin settings files, by name */
    private function kept(string $appId): array
    {
        return array_values(array_filter($this->native->privateFileNames($appId, 'plugin-'), static fn (string $name): bool => preg_match(self::FILE_PATTERN, $name) === 1));
    }

    /**
     * $input held to $schema, over what is kept: [values (every setting but a secret), secrets (a new
     * one's text, or null where the kept one stays)].
     *
     * @return array{0: array<string, mixed>, 1: array<string, ?string>}
     */
    private function merged(string $appId, string $pluginId, array $schema, mixed $input, array $kept, bool $complete): array
    {
        if (!is_array($input) || ($input !== [] && array_is_list($input))) {
            throw new \InvalidArgumentException('Send the settings by name.');
        }
        $fields = array_column($schema, null, 'key');
        foreach (array_keys($input) as $key) {
            if (!isset($fields[$key])) {
                throw new \InvalidArgumentException('This plugin has no setting of that name.');
            }
        }
        $values = self::valuesOf($schema, $kept);
        $opened = $this->opened($appId, $pluginId, $schema, $kept);
        $secrets = [];
        foreach ($schema as $field) {
            $key = $field['key'];
            $given = array_key_exists($key, $input) ? $input[$key] : null;
            if ($field['type'] === 'secret') {
                $text = is_string($given) ? trim($given) : '';
                if ($given !== null && !is_string($given)) {
                    throw new \InvalidArgumentException(self::refusal($field));
                }
                if ($text === '') {
                    $secrets[$key] = isset($kept['secrets'][$key]) ? null : '';
                } else {
                    self::assertText($field, $text);
                    $secrets[$key] = $text;
                }
                continue;
            }
            if ($given === null) {
                continue;
            }
            if ($field['type'] === 'text') {
                if (!is_string($given)) {
                    throw new \InvalidArgumentException(self::refusal($field));
                }
                $text = trim($given);
                if ($text !== '') {
                    self::assertText($field, $text);
                }
                $values[$key] = $text;
                continue;
            }
            $fits = PluginService::settingsValues([$field], [$key => $given])[$key];
            if ($fits !== $given) {
                throw new \InvalidArgumentException("{$field['label']}: that is not a value this setting takes.");
            }
            $values[$key] = $given;
        }
        if ($complete) {
            foreach ($schema as $field) {
                $key = $field['key'];
                $missing = $field['type'] === 'secret'
                    ? ($secrets[$key] === '' || ($secrets[$key] === null && !isset($opened[$key])))
                    : ($field['type'] === 'text' && ($values[$key] ?? '') === '');
                if ($missing && !($field['optional'] ?? false)) {
                    throw new \InvalidArgumentException(self::missing($field));
                }
            }
        }
        foreach ($secrets as $key => $plain) {
            if ($plain === '') {
                unset($secrets[$key]);
            }
        }
        return [$values, $secrets];
    }

    /** A line of text a field takes: within its length, of printable characters, all of its pattern. */
    private static function assertText(array $field, string $text): void
    {
        if (mb_strlen($text) > ($field['maxLength'] ?? 256) || preg_match('/[\x00-\x1f\x7f]/', $text)
            || (is_string($field['pattern'] ?? null) && @preg_match(self::pattern($field['pattern']), $text) !== 1)) {
            throw new \InvalidArgumentException(self::refusal($field));
        }
    }

    private static function refusal(array $field): string
    {
        return ($field['message'] ?? '') !== '' ? $field['message'] : "{$field['label']}: that is not a value this plugin takes.";
    }

    private static function missing(array $field): string
    {
        foreach (['missing', 'message'] as $words) {
            if (($field[$words] ?? '') !== '') {
                return $field[$words];
            }
        }
        return "Enter the {$field['label']}.";
    }

    /** Every setting but a secret: as kept where it still fits its field, its default (or empty text) otherwise. */
    private static function valuesOf(array $schema, array $kept): array
    {
        $out = [];
        foreach ($schema as $field) {
            $key = $field['key'];
            $value = $kept['values'][$key] ?? null;
            if ($field['type'] === 'secret') {
                continue;
            }
            $out[$key] = $field['type'] === 'text'
                ? (is_string($value) ? $value : '')
                : PluginService::settingsValues([$field], [$key => $value])[$key];
        }
        return $out;
    }

    private static function complete(array $schema, array $values, array $secrets): bool
    {
        foreach ($schema as $field) {
            if ($field['optional'] ?? false) {
                continue;
            }
            if ($field['type'] === 'secret' && !isset($secrets[$field['key']])) {
                return false;
            }
            if ($field['type'] === 'text' && (!is_string($values[$field['key']] ?? null) || $values[$field['key']] === '')) {
                return false;
            }
        }
        return true;
    }

    /** @return array<string, string> each kept secret of $schema that opens */
    private function opened(string $appId, string $pluginId, array $schema, array $kept): array
    {
        $out = [];
        foreach ($schema as $field) {
            $stored = $kept['secrets'][$field['key']] ?? null;
            if ($field['type'] !== 'secret' || !is_array($stored) || !is_string($stored['value'] ?? null)) {
                continue;
            }
            try {
                $out[$field['key']] = ($stored['sealed'] ?? false) === true
                    ? $this->encryption()->open($stored['value'], self::context($pluginId, $appId, $field['key']))
                    : $stored['value'];
            } catch (\Throwable) {
                // Its data key is gone: as though it were not kept.
            }
        }
        return $out;
    }

    /** @return array{values: array<string, mixed>, secrets: array<string, array>} what is kept for the plugin, or nothing */
    private function read(string $appId, string $pluginId): array
    {
        $text = $this->native->readPrivateFile($appId, self::fileName($pluginId));
        $kept = is_string($text) ? json_decode($text, true) : null;
        if (!is_array($kept) || ($kept['plugin'] ?? null) !== $pluginId) {
            return ['values' => [], 'secrets' => []];
        }
        return [
            'values' => is_array($kept['values'] ?? null) ? $kept['values'] : [],
            'secrets' => is_array($kept['secrets'] ?? null) ? $kept['secrets'] : [],
        ];
    }

    /** What a secret is sealed for: this app, this plugin and this setting, so one moved to another reads nothing. */
    private static function context(string $pluginId, string $appId, string $key): string
    {
        return self::CONTEXT . $pluginId . ':' . $appId . ':' . $key;
    }
}

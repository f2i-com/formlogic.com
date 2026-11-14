<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use PDO;

/**
 * Plugins (docs/AGE_GATE_AND_SITE_AI.md, "Plugins and passes"). Nothing here knows what any
 * plugin does.
 *
 * A plugin is a SoftN project whose manifest has a `formlogicPlugin` section. Its code is ZIPP
 * code in the SoftN runner's sandbox (its backend) and in the sandboxed frame (its pages), as any
 * SoftN app's is: no network, no files, nothing of the site but what this hands it. What it may do
 * is what its manifest asks and the administrator granted at install, shown to them first:
 *  - `passes`: the kinds of pass it may issue, each with a value range, its strengths, the route
 *    of its backend that issues it, and the words the site shows for it;
 *  - `uses`: what else of the site it may use (`camera`: CameraCheckService);
 *  - `settings`: what the administrator can set for it, handed to its code;
 *  - `network`: the hosts the site may make HTTPS requests to for it, from the routes the site
 *    calls (PluginNetwork); its sandbox itself never has a network;
 *  - `signInCodes`: the provider of apps' sign-in codes it is, and its two routes the site calls
 *    to send and check one (NativePhoneVerification);
 *  - `appSettings`: what it asks each app's owner for, secrets among them (PluginAppSettings);
 *  - its sandbox's own permissions (its records, randomness, the time), from the SoftN manifest.
 *
 * Plugins come from FormLogic (resources/plugins, `source` builtin) or from an administrator's
 * upload (`upload`), and are installed, updated, turned off and removed the same way. Each one's
 * project is held as an app of the system Plugins account, which nobody can sign in as, act as or
 * be a member of: its files change only by installing it, and it is in no person's apps, backups
 * or erasure. `scope` is 'site' today; owners installing a plugin for one app use it later.
 */
final class PluginService
{
    public const SYSTEM_USER_ID = 'formlogic-system-plugins';
    private const SYSTEM_EMAIL = 'plugins@formlogic.invalid';
    public const ID_PATTERN = '/^[a-z0-9][a-z0-9.-]{2,63}$/D';
    /** Ids only the plugins that ship with FormLogic may have: an upload cannot pose as one. */
    public const RESERVED_PREFIX = 'formlogic.';
    /** What a plugin may ask to use besides issuing passes. */
    public const USES = ['camera'];
    /**
     * Routes under /api/site/ are the site's to call on a plugin's backend; a plugin's own page
     * asking for one is refused (NativeAppController). A plugin that uses the camera answers these.
     */
    public const SITE_ROUTE_PREFIX = '/api/site/';
    public const CAMERA_ROUTES = ['start' => '/api/site/camera/start', 'decide' => '/api/site/camera/decide'];
    /** The sandbox permissions a plugin may ask of the SoftN runner, as the administrator reads them. */
    public const SANDBOX = [
        'sql' => 'Keep its own records, in a database only it can read',
        'crypto' => 'Make random numbers and seal its own data',
        'time' => 'Read the time and dates',
        'transaction-scope' => 'Group its own record changes',
    ];
    private const KIND_PATTERN = '/^[a-z][a-z0-9_-]{0,15}$/D';
    private const SETTING_KEY = '/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/D';
    /** How many hosts a plugin may ask the site to reach for it (`network`). */
    public const NETWORK_MOST = 4;
    /** A host as a plugin names it: a lowercase DNS name with a dot, never an address, a port or a scheme. */
    private const HOST_PATTERN = '/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/D';
    /** A provider of sign-in codes, as an app's manifest names one (`config.app.verificationProvider`). */
    public const PROVIDER_PATTERN = '/^[a-z0-9][a-z0-9.-]{0,63}$/D';
    /** Where an app's earlier SoftN host kept an app setting, in its private/config.json (`importFrom`). */
    private const IMPORT_PATH = '/^[A-Za-z0-9_-]{1,64}(?:\.[A-Za-z0-9_-]{1,64}){0,3}$/D';
    /** What of such a file is the app's own, and never a plugin's to take (lower case). */
    private const IMPORT_NEVER = ['keyhex', 'cryptodomains', 'appid'];
    /** How long after an upgrade's install of a plugin failed before it is tried again (installForUpgrade). */
    private const UPGRADE_RETRY_SECONDS = 3600;

    private PDO $pdo;
    /** @var array<string, ?array> rows looked up in this request, by manifest id */
    private array $rows = [];
    /** @var array<string, array> what each installed plugin was granted beyond its passes (granted()), by its app id */
    private array $granted = [];

    public function __construct(
        MySQLConnection $mysql,
        private AppService $apps,
        private NativeAppService $native,
        private ?string $builtinPath = null,
    ) {
        $this->pdo = $mysql->getConnection();
        $this->builtinPath ??= dirname(__DIR__, 2) . '/resources/plugins';
    }

    /**
     * A project's manifest read as a plugin, checked: its id, name, description, version, the passes
     * it may issue, what it uses, its settings and its sandbox permissions. Throws on anything else.
     */
    public static function pluginManifest(array $manifest): array
    {
        $plugin = $manifest['formlogicPlugin'] ?? null;
        if (!is_array($plugin)) {
            throw new \InvalidArgumentException('This project is not a plugin: its manifest has no formlogicPlugin section.');
        }
        $id = $plugin['id'] ?? null;
        $name = $plugin['name'] ?? null;
        if (!is_string($id) || !preg_match(self::ID_PATTERN, $id) || !is_string($name) || trim($name) === '' || mb_strlen($name) > 120) {
            throw new \InvalidArgumentException('A plugin needs an id (lowercase letters, digits, dots and hyphens) and a name.');
        }
        $routes = [];
        foreach ($manifest['server']['routes'] ?? [] as $route) {
            if (is_array($route) && ($route['method'] ?? null) === 'POST' && is_string($route['path'] ?? null)) {
                $routes[] = $route['path'];
            }
        }
        $sandbox = $manifest['server']['requires']['capabilities'] ?? [];
        if (!is_array($sandbox) || array_diff($sandbox, array_keys(self::SANDBOX)) !== []) {
            throw new \InvalidArgumentException('A plugin\'s backend may ask only for: ' . implode(', ', array_keys(self::SANDBOX)) . '.');
        }
        $passes = $plugin['passes'] ?? [];
        if (!is_array($passes) || !array_is_list($passes) || count($passes) > 4) {
            throw new \InvalidArgumentException('A plugin declares at most four passes.');
        }
        $out = [];
        foreach ($passes as $pass) {
            $out[] = self::passOf($pass, $routes, array_column($out, 'kind'));
        }
        $uses = $plugin['uses'] ?? [];
        if (!is_array($uses) || !array_is_list($uses) || array_diff($uses, self::USES) !== []) {
            throw new \InvalidArgumentException('A plugin may ask to use only: ' . implode(', ', self::USES) . '.');
        }
        if (in_array('camera', $uses, true)) {
            foreach (self::CAMERA_ROUTES as $route) {
                if (!in_array($route, $routes, true)) {
                    throw new \InvalidArgumentException("A plugin that uses the camera answers POST {$route} in its backend.");
                }
            }
        }
        $network = $plugin['network'] ?? [];
        if (!is_array($network) || !array_is_list($network) || count($network) > self::NETWORK_MOST) {
            throw new \InvalidArgumentException('A plugin names at most ' . self::NETWORK_MOST . ' hosts for the site to reach for it (network).');
        }
        foreach ($network as $host) {
            if (!is_string($host) || !preg_match(self::HOST_PATTERN, $host)) {
                throw new \InvalidArgumentException('Each host a plugin needs reached is a name such as api.example.com: lowercase, with no scheme, port or path.');
            }
        }
        $codes = $plugin['signInCodes'] ?? null;
        $network = array_values(array_unique($network));
        return [
            'id' => $id,
            'name' => trim($name),
            'description' => mb_substr(self::text($plugin['description'] ?? null), 0, 600),
            'version' => is_string($manifest['version'] ?? null) ? mb_substr($manifest['version'], 0, 40) : '0',
            'passes' => $out,
            'uses' => array_values(array_unique($uses)),
            'settings' => self::settingsSchema($plugin['settings'] ?? []),
            'sandbox' => array_values(array_unique($sandbox)),
            'network' => $network,
            'signInCodes' => $codes === null ? null : self::signInCodesOf($codes, $routes),
            'appSettings' => self::appSettingsSchema($plugin['appSettings'] ?? [], $network),
            // The routes of its backend the site calls (and its own page never may): where a request the
            // site makes for it may continue (PluginNetwork).
            'siteRoutes' => array_values(array_unique(array_filter($routes, static fn (string $route) => str_starts_with($route, self::SITE_ROUTE_PREFIX)))),
        ];
    }

    /**
     * The sign-in codes a plugin sends (`signInCodes`): the provider apps name for them, the words the
     * site shows for it, and the two routes of its backend the site calls, under /api/site/.
     */
    private static function signInCodesOf(mixed $codes, array $routes): array
    {
        $provider = is_array($codes) ? ($codes['provider'] ?? null) : null;
        $site = static fn (mixed $route): bool => is_string($route) && in_array($route, $routes, true) && str_starts_with($route, self::SITE_ROUTE_PREFIX);
        if (!is_string($provider) || !preg_match(self::PROVIDER_PATTERN, $provider) || !$site($codes['sendRoute'] ?? null) || !$site($codes['checkRoute'] ?? null)) {
            throw new \InvalidArgumentException('A plugin that sends sign-in codes names the provider apps ask for (lowercase letters, digits, dots and hyphens), and two POST routes of its backend under ' . self::SITE_ROUTE_PREFIX . ' that the site calls: sendRoute and checkRoute.');
        }
        return [
            'provider' => $provider,
            'label' => mb_substr(self::text($codes['label'] ?? null), 0, 80) ?: $provider,
            'sendRoute' => $codes['sendRoute'],
            'checkRoute' => $codes['checkRoute'],
        ];
    }

    /**
     * What a plugin asks each app's owner for (`appSettings`, kept by PluginAppSettings): at most ten
     * fields. An `integer`, `choice` or `boolean` is as an administrator's setting is. A `text` or a
     * `secret` is a line of text, required unless `optional`, which must match all of `pattern` where
     * the plugin gives one (refused with its `message`, or with `missing` when it is left empty);
     * `importFrom` names where an app's earlier SoftN host kept it (a dotted path in that host's
     * private/config.json, never its key, crypto domains or app id), for an owner who brings the
     * app's data with that file. A `secret` names the hosts of $network it may be sent to
     * (`sendTo`): the one host, when the plugin has one and says nothing.
     */
    private static function appSettingsSchema(mixed $fields, array $network): array
    {
        if (!is_array($fields) || !array_is_list($fields) || count($fields) > 10) {
            throw new \InvalidArgumentException('A plugin asks an app\'s owner for at most ten settings (appSettings).');
        }
        $out = [];
        foreach ($fields as $field) {
            $type = is_array($field) ? ($field['type'] ?? null) : null;
            if (in_array($type, ['integer', 'choice', 'boolean'], true)) {
                $item = self::settingsSchema([$field])[0];
            } else {
                $key = is_array($field) ? ($field['key'] ?? null) : null;
                $label = is_array($field) ? self::text($field['label'] ?? null) : '';
                if (!in_array($type, ['text', 'secret'], true) || !is_string($key) || !preg_match(self::SETTING_KEY, $key) || $label === '') {
                    throw new \InvalidArgumentException('Each app setting a plugin asks for needs a key, a label and a type: text, secret, integer, choice or boolean.');
                }
                $pattern = $field['pattern'] ?? null;
                if ($pattern !== null && (!is_string($pattern) || $pattern === '' || strlen($pattern) > 300 || @preg_match(PluginAppSettings::pattern($pattern), '') === false)) {
                    throw new \InvalidArgumentException("App setting {$key}'s pattern is not a regular expression this site can use.");
                }
                $from = $field['importFrom'] ?? null;
                if ($from !== null && (!is_string($from) || !preg_match(self::IMPORT_PATH, $from))) {
                    throw new \InvalidArgumentException("App setting {$key}'s importFrom is a dotted path, such as sms.API_KEY.");
                }
                // What a key file holds for the app itself is never a plugin's: its key, the domains it
                // is used with, and the app's id.
                if (is_string($from) && in_array(strtolower(explode('.', $from)[0]), self::IMPORT_NEVER, true)) {
                    throw new \InvalidArgumentException("App setting {$key}'s importFrom may not read the app's key, its crypto domains or its id from a key file.");
                }
                $most = $field['maxLength'] ?? 256;
                $item = [
                    'key' => $key, 'label' => mb_substr($label, 0, 80), 'help' => mb_substr(self::text($field['help'] ?? null), 0, 200), 'type' => $type,
                    'optional' => ($field['optional'] ?? false) === true,
                    'maxLength' => is_int($most) && $most >= 1 && $most <= 1024 ? $most : 256,
                    'placeholder' => mb_substr(self::text($field['placeholder'] ?? null), 0, 60),
                    'pattern' => $pattern,
                    'message' => mb_substr(self::text($field['message'] ?? null), 0, 200),
                    'missing' => mb_substr(self::text($field['missing'] ?? null), 0, 200),
                    'importFrom' => $from,
                ];
                if ($type === 'secret') {
                    $item['sendTo'] = self::sendToOf($key, $field['sendTo'] ?? null, $network);
                }
            }
            if (isset($out[$item['key']])) {
                throw new \InvalidArgumentException("A plugin asks an app's owner for {$item['key']} twice.");
            }
            $out[$item['key']] = $item;
        }
        return array_values($out);
    }

    /**
     * The hosts an owner's secret may be sent to: those it names, each one of the plugin's $network;
     * the one host when the plugin has one and it names none; with several, it must name them.
     *
     * @return list<string>
     */
    private static function sendToOf(string $key, mixed $sendTo, array $network): array
    {
        if ($sendTo === null) {
            if (count($network) > 1) {
                throw new \InvalidArgumentException("Secret {$key} names the hosts it may be sent to (sendTo): the plugin reaches more than one.");
            }
            return $network;
        }
        if (!is_array($sendTo) || !array_is_list($sendTo) || $sendTo === []) {
            throw new \InvalidArgumentException("Secret {$key}'s sendTo is a list of the hosts it may be sent to, among the plugin's network.");
        }
        foreach ($sendTo as $host) {
            if (!is_string($host) || !in_array($host, $network, true)) {
                throw new \InvalidArgumentException("Secret {$key} may be sent only to hosts the plugin names in its network.");
            }
        }
        return array_values(array_unique($sendTo));
    }

    /** One pass a plugin may issue, with the words the site shows for it. */
    private static function passOf(mixed $pass, array $routes, array $taken): array
    {
        $kind = is_array($pass) ? ($pass['kind'] ?? null) : null;
        $min = $pass['min'] ?? null;
        $max = $pass['max'] ?? null;
        $strengths = $pass['strengths'] ?? null;
        $route = $pass['issueRoute'] ?? null;
        if (!is_string($kind) || !preg_match(self::KIND_PATTERN, $kind) || in_array($kind, $taken, true)
            || !is_int($min) || !is_int($max) || $min < 0 || $max > 1000000 || $min > $max
            || !is_array($strengths) || $strengths === [] || array_diff($strengths, array_keys(AccessGateService::ASSURANCE)) !== []
            || !is_string($route) || !in_array($route, $routes, true) || str_starts_with(strtolower($route), self::SITE_ROUTE_PREFIX)) {
            throw new \InvalidArgumentException('Each pass a plugin issues needs a kind, a value range, its strengths, and a POST route of its own backend that issues it.');
        }
        $label = mb_substr(self::text($pass['label'] ?? null) ?: $kind, 0, 40);
        $labels = [];
        foreach (is_array($pass['strengthLabels'] ?? null) ? $pass['strengthLabels'] : [] as $strength => $words) {
            if (isset(AccessGateService::ASSURANCE[$strength]) && self::text($words) !== '') {
                $labels[$strength] = mb_substr(self::text($words), 0, 60);
            }
        }
        return [
            'kind' => $kind,
            'label' => $label,
            'unit' => mb_substr(self::text($pass['unit'] ?? null), 0, 20),
            'min' => $min,
            'max' => $max,
            // The value an owner starts from when they turn the requirement on.
            'default' => is_int($pass['default'] ?? null) && $pass['default'] >= $min && $pass['default'] <= $max ? $pass['default'] : $min,
            'strengths' => array_values(array_unique($strengths)),
            'issueRoute' => $route,
            // The site's words for it: who an app that asks it is for ("{min}" is the app's value),
            // what the button to get it says, the owner's switch and field, and each strength.
            'asks' => mb_substr(self::text($pass['asks'] ?? null), 0, 120),
            'action' => mb_substr(self::text($pass['action'] ?? null), 0, 40),
            'require' => mb_substr(self::text($pass['require'] ?? null), 0, 60),
            'minLabel' => mb_substr(self::text($pass['minLabel'] ?? null), 0, 40),
            'strengthLabels' => $labels,
        ];
    }

    /**
     * What the administrator can set for a plugin: at most ten settings, each a whole number in a
     * range, one of a few choices, or on/off, with a default. Handed to its code as set.
     */
    private static function settingsSchema(mixed $settings): array
    {
        if (!is_array($settings) || !array_is_list($settings) || count($settings) > 10) {
            throw new \InvalidArgumentException('A plugin has at most ten settings.');
        }
        $out = [];
        foreach ($settings as $setting) {
            $key = is_array($setting) ? ($setting['key'] ?? null) : null;
            $type = $setting['type'] ?? null;
            $label = self::text($setting['label'] ?? null);
            if (!is_string($key) || !preg_match(self::SETTING_KEY, $key) || isset($out[$key]) || $label === '' || !in_array($type, ['integer', 'choice', 'boolean'], true)) {
                throw new \InvalidArgumentException('Each plugin setting needs a key, a label and a type: integer, choice or boolean.');
            }
            $item = ['key' => $key, 'label' => mb_substr($label, 0, 80), 'help' => mb_substr(self::text($setting['help'] ?? null), 0, 200), 'type' => $type];
            if ($type === 'integer') {
                $min = $setting['min'] ?? null;
                $max = $setting['max'] ?? null;
                $default = $setting['default'] ?? null;
                if (!is_int($min) || !is_int($max) || $min > $max || !is_int($default) || $default < $min || $default > $max) {
                    throw new \InvalidArgumentException("Plugin setting {$key} needs a range and a default in it.");
                }
                $item += ['min' => $min, 'max' => $max, 'default' => $default];
            } elseif ($type === 'choice') {
                $options = [];
                foreach (is_array($setting['options'] ?? null) ? array_slice($setting['options'], 0, 8) : [] as $option) {
                    if (is_array($option) && is_string($option['value'] ?? null) && preg_match('/^[a-zA-Z0-9_-]{1,32}$/D', $option['value'])) {
                        $options[] = ['value' => $option['value'], 'label' => mb_substr(self::text($option['label'] ?? null) ?: $option['value'], 0, 60)];
                    }
                }
                if ($options === [] || !in_array($setting['default'] ?? null, array_column($options, 'value'), true)) {
                    throw new \InvalidArgumentException("Plugin setting {$key} needs choices and a default among them.");
                }
                $item += ['options' => $options, 'default' => $setting['default']];
            } else {
                if (!is_bool($setting['default'] ?? null)) {
                    throw new \InvalidArgumentException("Plugin setting {$key} needs a default of true or false.");
                }
                $item += ['default' => $setting['default']];
            }
            $out[$key] = $item;
        }
        return array_values($out);
    }

    /** Settings as a plugin's code gets them: each from $values when it fits its schema, its default otherwise. */
    public static function settingsValues(array $schema, mixed $values): array
    {
        $values = is_array($values) ? $values : [];
        $out = [];
        foreach ($schema as $setting) {
            $value = $values[$setting['key']] ?? null;
            $out[$setting['key']] = match ($setting['type']) {
                'integer' => is_int($value) && $value >= $setting['min'] && $value <= $setting['max'] ? $value : $setting['default'],
                'choice' => in_array($value, array_column($setting['options'], 'value'), true) ? $value : $setting['default'],
                default => is_bool($value) ? $value : $setting['default'],
            };
        }
        return $out;
    }

    private static function text(mixed $value): string
    {
        return is_string($value) ? trim((string) preg_replace('/[\x00-\x1f\x7f]+/', ' ', $value)) : '';
    }

    /** The plugins that ship with FormLogic, by id, with what each would be granted. */
    public function builtins(): array
    {
        $found = [];
        foreach (glob($this->builtinPath . '/*/manifest.json') ?: [] as $file) {
            try {
                $plugin = self::pluginManifest(json_decode((string) file_get_contents($file), true, 64, JSON_THROW_ON_ERROR));
            } catch (\Throwable) {
                continue;
            }
            if (str_starts_with($plugin['id'], self::RESERVED_PREFIX)) {
                $found[$plugin['id']] = $plugin + ['dir' => dirname($file)];
            }
        }
        ksort($found);
        return $found;
    }

    /**
     * What installing a project would grant, for the administrator to read before they choose: the
     * plugin's manifest read, and whether it updates one installed now. Throws on a project that is
     * not a plugin, or not a SoftN project this site runs, or one that would send the sign-in codes
     * another plugin that is on sends already (so installing and updating are refused alike).
     */
    public function inspect(array $project, string $source): array
    {
        [$files, , $manifest] = NativeAppService::validateProject(self::normalProject($project, 0));
        unset($files);
        $plugin = self::pluginManifest($manifest);
        if ($source === 'upload' && str_starts_with($plugin['id'], self::RESERVED_PREFIX)) {
            throw new \InvalidArgumentException('Plugin ids starting "' . self::RESERVED_PREFIX . '" are for the plugins that ship with FormLogic.');
        }
        $installed = $this->find($plugin['id']);
        if ($installed !== null && $installed['source'] !== $source) {
            throw new \InvalidArgumentException('A plugin with this id is already installed from elsewhere. Remove it first.');
        }
        $this->assertProviderFree($plugin['signInCodes'], $plugin['id']);
        return $plugin + ['updates' => $installed === null ? null : ['version' => $installed['version']]];
    }

    /**
     * One provider of sign-in codes, one plugin that is on: refused when another installed plugin
     * that is on (not $except) sends codes for the same provider, naming it.
     */
    private function assertProviderFree(?array $codes, string $except): void
    {
        if ($codes === null) {
            return;
        }
        foreach ($this->installed() as $other) {
            if ($other['manifestId'] === $except || !$other['enabled'] || $other['scope'] !== 'site') {
                continue;
            }
            if (($this->granted($other)['signInCodes']['provider'] ?? null) === $codes['provider']) {
                throw new \InvalidArgumentException('The plugin "' . $other['name'] . '" sends the sign-in codes for "' . $codes['provider'] . '" already. Turn it off or remove it first.');
            }
        }
    }

    /** Every installed plugin, with its grants and settings. */
    public function installed(): array
    {
        $rows = $this->pdo->query('SELECT * FROM plugins ORDER BY name')->fetchAll(PDO::FETCH_ASSOC);
        return array_map(fn(array $row) => $this->format($row), $rows);
    }

    /** One installed site plugin, or null. */
    public function find(string $manifestId): ?array
    {
        if (!array_key_exists($manifestId, $this->rows)) {
            $stmt = $this->pdo->prepare("SELECT * FROM plugins WHERE manifest_id = ? AND scope = 'site'");
            $stmt->execute([$manifestId]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            $this->rows[$manifestId] = $row ? $this->format($row) : null;
        }
        return $this->rows[$manifestId];
    }

    /** The plugin an app is, when it is one: the app holding a plugin's project, owned by the Plugins account. */
    public function forApp(array $app): ?array
    {
        $manifestId = $app['settings']['plugin'] ?? null;
        if (!is_string($manifestId) || ($app['ownerId'] ?? null) !== self::SYSTEM_USER_ID) {
            return null;
        }
        $plugin = $this->find($manifestId);
        return $plugin !== null && $plugin['appId'] === ($app['id'] ?? null) ? $plugin : null;
    }

    /**
     * What an app owner can require: each pass kind of each enabled site plugin, with the
     * strengths this site can issue now (`offered`).
     */
    public function passKinds(bool $cameraReady = false): array
    {
        $kinds = [];
        foreach ($this->installed() as $plugin) {
            if (!$plugin['enabled'] || $plugin['scope'] !== 'site') {
                continue;
            }
            foreach ($plugin['grants'] as $pass) {
                $kinds[] = ['plugin' => $plugin['manifestId'], 'pluginName' => $plugin['name']] + $pass
                    + ['offered' => self::offered($plugin, $pass, $cameraReady)];
            }
        }
        return $kinds;
    }

    /**
     * The strengths of a granted pass this site can issue now: a declaration from the plugin's own
     * backend; anything stronger only through what the plugin uses and the site has set up (the
     * camera check), as its own backend may not issue more than a declaration then.
     */
    public static function offered(array $plugin, array $pass, bool $cameraReady): array
    {
        $camera = in_array('camera', $plugin['uses'] ?? [], true);
        return array_values(array_filter($pass['strengths'], fn (string $strength) => $strength === 'declared' || ($camera ? $cameraReady : true)));
    }

    /** The grant for one kind of pass, from an enabled plugin, or null. */
    public function grant(string $manifestId, string $kind): ?array
    {
        $plugin = $this->find($manifestId);
        if ($plugin === null || !$plugin['enabled']) {
            return null;
        }
        foreach ($plugin['grants'] as $pass) {
            if ($pass['kind'] === $kind) {
                return $pass;
            }
        }
        return null;
    }

    /** A plugin's folder as a SoftN project: media under assets/, the rest its source. */
    private static function projectFromDir(string $dir): array
    {
        $files = [];
        $assets = [];
        $iterator = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS));
        foreach ($iterator as $file) {
            $relative = str_replace('\\', '/', substr((string) $file, strlen($dir) + 1));
            if (str_starts_with($relative, 'assets/')) {
                $assets[$relative] = base64_encode((string) file_get_contents((string) $file));
            } else {
                $files[$relative] = (string) file_get_contents((string) $file);
            }
        }
        return ['files' => $files, 'assets' => $assets];
    }

    /** A project as installed: its files and media in order, a members' app with its own page. */
    private static function normalProject(array $project, int $version): array
    {
        $files = is_array($project['files'] ?? null) ? $project['files'] : [];
        $assets = is_array($project['assets'] ?? null) ? $project['assets'] : [];
        ksort($files);
        ksort($assets);
        return ['home' => true, 'version' => $version, 'files' => $files, 'assets' => $assets, 'access' => 'members'];
    }

    /** What would change for an installed plugin that ships with FormLogic: the new version and its grants. Null otherwise. */
    public function pendingUpdate(array $plugin): ?array
    {
        $builtin = $plugin['source'] === 'builtin' ? ($this->builtins()[$plugin['manifestId']] ?? null) : null;
        if ($builtin === null) {
            return null;
        }
        try {
            $installed = $this->native->get($plugin['appId']);
        } catch (\Throwable) {
            $installed = null;
        }
        $now = self::normalProject($installed ?? [], 0);
        $shipped = self::normalProject(self::projectFromDir($builtin['dir']), 0);
        $same = $builtin['version'] === $plugin['version'] && $now['files'] === $shipped['files'] && $now['assets'] === $shipped['assets']
            && self::canon($builtin['passes']) === self::canon($plugin['grants']) && $builtin['uses'] === $plugin['uses']
            && self::canon($builtin['settings']) === self::canon($plugin['settingsSchema']);
        return $same ? null : self::review($builtin, $this->granted($plugin));
    }

    /** What installing or updating to $read would grant, for the administrator to read: with the hosts an update adds. */
    public function reviewFor(array $read): array
    {
        $installed = $this->find($read['id']);
        return self::review($read, $installed === null ? null : $this->granted($installed));
    }

    /**
     * What an installed plugin was granted beyond its passes, read from its manifest as installed,
     * which only an administrator's install or update changes (an upload is read to them first, and
     * a new version that ships is shown to them before they take it): the hosts the site reaches for
     * it, the sign-in codes it sends, what it asks apps' owners for, and its routes the site calls.
     * Nothing, for one whose manifest cannot be read as this plugin's.
     *
     * @return array{network: list<string>, signInCodes: ?array, appSettings: list<array>, siteRoutes: list<string>}
     */
    public function granted(array $plugin): array
    {
        $appId = is_string($plugin['appId'] ?? null) ? $plugin['appId'] : '';
        if (!array_key_exists($appId, $this->granted)) {
            try {
                $read = $appId === '' ? [] : self::pluginManifest($this->native->installedManifest($appId));
            } catch (\Throwable) {
                $read = [];
            }
            if (($read['id'] ?? null) !== ($plugin['manifestId'] ?? null)) {
                $read = [];
            }
            $this->granted[$appId] = [
                'network' => $read['network'] ?? [],
                'signInCodes' => $read['signInCodes'] ?? null,
                'appSettings' => $read['appSettings'] ?? [],
                'siteRoutes' => $read['siteRoutes'] ?? [],
            ];
        }
        return $this->granted[$appId];
    }

    /**
     * A plugin's network, sign-in codes and app settings as the administrator reads them: each
     * secret with the hosts it may be sent to, and each setting it takes from an earlier host's key
     * file with where it is read.
     */
    public static function grantedView(array $read): array
    {
        $codes = is_array($read['signInCodes'] ?? null) ? $read['signInCodes'] : null;
        return [
            'network' => array_values($read['network'] ?? []),
            'signInCodes' => $codes === null ? null : ['provider' => $codes['provider'], 'label' => $codes['label']],
            'appSettings' => array_map(static fn (array $field): array => ['key' => $field['key'], 'label' => $field['label'], 'type' => $field['type']]
                + ($field['type'] === 'secret' ? ['sendTo' => array_values($field['sendTo'] ?? [])] : [])
                + (is_string($field['importFrom'] ?? null) ? ['importFrom' => $field['importFrom']] : []), $read['appSettings'] ?? []),
        ];
    }

    /**
     * The installed plugin that sends sign-in codes for $provider, the name an app gives in its
     * manifest, with what it was granted (`granted`): an enabled one before one turned off, then the
     * one installed first. Null when no plugin here does ($enabledOnly: or none that is on).
     */
    public function signInCodesProvider(string $provider, bool $enabledOnly = true): ?array
    {
        if (!preg_match(self::PROVIDER_PATTERN, $provider)) {
            return null;
        }
        $found = [];
        foreach ($this->installed() as $plugin) {
            if ($plugin['scope'] !== 'site' || ($enabledOnly && !$plugin['enabled'])) {
                continue;
            }
            $granted = $this->granted($plugin);
            if (($granted['signInCodes']['provider'] ?? null) === $provider) {
                $found[] = $plugin + ['granted' => $granted];
            }
        }
        usort($found, static fn (array $a, array $b): int => [$b['enabled'], (string) $a['installedAt'], $a['id']] <=> [$a['enabled'], (string) $b['installedAt'], $b['id']]);
        return $found[0] ?? null;
    }

    /**
     * Install a plugin that ships with FormLogic because an upgrade moves into it what FormLogic once
     * did itself (LegacyPhoneVerification), with no administrator there to do it: once for this site.
     * Once it has been installed this way, or found installed already, an administrator who removes
     * it afterwards is not overruled: null then. An install that failed is tried again an hour later
     * at the soonest, never on every request: null meanwhile. The installed plugin when it is there.
     */
    public function installForUpgrade(string $manifestId): ?array
    {
        $marker = substr('plugin_upgrade:' . $manifestId, 0, 64);
        $was = $this->upgradeMark($marker);
        $installed = $this->find($manifestId);
        if ($installed !== null) {
            if (($was['state'] ?? null) !== 'done') {
                $this->markUpgrade($marker, 'done');
            }
            return $installed;
        }
        if (($was['state'] ?? null) === 'done' || (($was['state'] ?? null) === 'failed' && $was['at'] > time() - self::UPGRADE_RETRY_SECONDS)) {
            return null;
        }
        try {
            $plugin = $this->installBuiltin($manifestId, self::SYSTEM_USER_ID);
        } catch (\Throwable $e) {
            // Another request installed it meanwhile, or it cannot be installed here.
            unset($this->rows[$manifestId]);
            $plugin = $this->find($manifestId);
            if ($plugin === null) {
                error_log('Plugin ' . $manifestId . ' was not installed for an upgrade: ' . $e->getMessage());
                $this->markUpgrade($marker, 'failed');
                return null;
            }
        }
        $this->markUpgrade($marker, 'done');
        return $plugin;
    }

    /** @return ?array{state: string, at: int} what installForUpgrade() wrote down for a plugin, or null */
    private function upgradeMark(string $marker): ?array
    {
        $read = $this->pdo->prepare('SELECT meta_value FROM system_meta WHERE meta_key = ?');
        $read->execute([$marker]);
        $value = $read->fetchColumn();
        if ($value === false) {
            return null;
        }
        $mark = json_decode((string) $value, true);
        // Anything else written there is an install that was done.
        return is_array($mark) && in_array($mark['state'] ?? null, ['done', 'failed'], true) && is_int($mark['at'] ?? null)
            ? ['state' => $mark['state'], 'at' => $mark['at']] : ['state' => 'done', 'at' => 0];
    }

    private function markUpgrade(string $marker, string $state): void
    {
        $value = json_encode(['state' => $state, 'at' => time()], JSON_THROW_ON_ERROR);
        try {
            $update = $this->pdo->prepare('UPDATE system_meta SET meta_value = ? WHERE meta_key = ?');
            $update->execute([$value, $marker]);
            if ($update->rowCount() === 0) {
                $this->pdo->prepare('INSERT INTO system_meta (meta_key, meta_value) VALUES (?, ?)')->execute([$marker, $value]);
            }
        } catch (\PDOException) {
            // Written meanwhile by another request.
        }
    }

    /** Keys in order at every level: MySQL's JSON columns give an object back with its keys reordered. */
    private static function canon(mixed $value): mixed
    {
        if (!is_array($value)) {
            return $value;
        }
        $value = array_map(fn (mixed $item) => self::canon($item), $value);
        if (!array_is_list($value)) {
            ksort($value);
        }
        return $value;
    }

    /**
     * What a plugin asks, as the administrator reads it before granting it. $was: what the version
     * installed now was granted (granted()), for an update: the hosts it adds are said apart.
     */
    public static function review(array $plugin, ?array $was = null): array
    {
        return [
            'version' => $plugin['version'],
            'passes' => $plugin['passes'],
            'uses' => $plugin['uses'],
            'settings' => $plugin['settings'],
            'sandbox' => array_map(fn (string $permission) => self::SANDBOX[$permission], $plugin['sandbox']),
        ] + self::grantedView($plugin) + [
            'networkAdded' => $was === null ? [] : array_values(array_diff($plugin['network'] ?? [], $was['network'] ?? [])),
        ];
    }

    /** Install a plugin that ships with FormLogic, granting what its manifest asks. */
    public function installBuiltin(string $manifestId, string $adminUserId): array
    {
        $builtin = $this->builtins()[$manifestId] ?? throw new \InvalidArgumentException('There is no such plugin.');
        return $this->install(self::projectFromDir($builtin['dir']), $adminUserId, 'builtin');
    }

    /** Update a plugin that ships with FormLogic to the version this FormLogic has. */
    public function updateBuiltin(string $manifestId): array
    {
        $plugin = $this->find($manifestId);
        $builtin = $this->builtins()[$manifestId] ?? null;
        if ($plugin === null || $builtin === null || $plugin['source'] !== 'builtin') {
            throw new \InvalidArgumentException('That plugin is not installed, or does not ship with FormLogic.');
        }
        if ($this->pendingUpdate($plugin) === null) {
            throw new \InvalidArgumentException('That plugin is up to date.');
        }
        return $this->update($plugin, self::projectFromDir($builtin['dir']));
    }

    /**
     * Install an uploaded plugin, or update the uploaded plugin of the same id, granting what its
     * manifest asks: the administrator read it first (inspect).
     */
    public function installUpload(array $project, string $adminUserId): array
    {
        $plugin = $this->inspect($project, 'upload');
        $installed = $this->find($plugin['id']);
        return $installed === null ? $this->install($project, $adminUserId, 'upload') : $this->update($installed, $project);
    }

    /** Install a project as a plugin: its app on the Plugins account, its project in the runner, and its grants. */
    private function install(array $project, string $adminUserId, string $source): array
    {
        $project = self::normalProject($project, 0);
        $plugin = $this->inspect($project, $source);
        if ($plugin['updates'] !== null) {
            throw new \InvalidArgumentException('That plugin is already installed.');
        }
        $this->ensureSystemUser();
        $slug = 'plugin-' . substr(preg_replace('/[^a-z0-9-]/', '-', $plugin['id']) ?? 'x', 0, 40) . '-' . bin2hex(random_bytes(3));
        $app = $this->apps->createApp([
            'name' => 'Plugin: ' . $plugin['name'],
            'slug' => $slug,
            'settings' => ['softnApp' => true, 'plugin' => $plugin['id']],
        ], self::SYSTEM_USER_ID);
        $appId = (string) $app['id'];
        try {
            $this->native->install($appId, $project, 0, null, ['by' => $adminUserId, 'how' => 'plugin']);
            $this->apps->publishApp($appId, 'Installed', self::SYSTEM_USER_ID);
            $now = gmdate('Y-m-d H:i:s');
            $this->pdo->prepare(
                "INSERT INTO plugins (id, manifest_id, scope, source, app_id, name, version, enabled, grants, uses, settings_schema, settings, installed_by, installed_at, updated_at)
                 VALUES (?, ?, 'site', ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)"
            )->execute([bin2hex(random_bytes(16)), $plugin['id'], $source, $appId, $plugin['name'], $plugin['version'],
                json_encode($plugin['passes'], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE), json_encode($plugin['uses'], JSON_THROW_ON_ERROR),
                json_encode($plugin['settings'], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE), json_encode(self::settingsValues($plugin['settings'], []), JSON_THROW_ON_ERROR),
                $adminUserId, $now, $now]);
        } catch (\Throwable $e) {
            try { $this->native->remove($appId); } catch (\Throwable) {}
            $this->apps->deleteApp($appId);
            throw $e;
        }
        unset($this->rows[$plugin['id']], $this->granted[$appId]);
        return $this->find($plugin['id']) ?? throw new \RuntimeException('The plugin was not recorded.');
    }

    /**
     * A new version of an installed plugin, granted what its manifest now asks. Its passes stay (a
     * kind it no longer issues stops counting, as its grant is gone), and its settings keep the
     * values that still fit.
     */
    private function update(array $plugin, array $project): array
    {
        $current = $this->native->project($plugin['appId']);
        $version = (int) ($current['version'] ?? 0);
        $project = self::normalProject($project, $version);
        $read = $this->inspect($project, $plugin['source']);
        if ($read['id'] !== $plugin['manifestId']) {
            throw new \InvalidArgumentException('That is another plugin.');
        }
        $this->native->install($plugin['appId'], $project, $version, null, ['how' => 'plugin', 'summary' => 'Updated to ' . $read['version']]);
        $this->apps->publishApp($plugin['appId'], 'Updated to ' . $read['version'], self::SYSTEM_USER_ID);
        $this->pdo->prepare('UPDATE plugins SET name = ?, version = ?, grants = ?, uses = ?, settings_schema = ?, settings = ?, updated_at = ? WHERE id = ?')
            ->execute([$read['name'], $read['version'], json_encode($read['passes'], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE),
                json_encode($read['uses'], JSON_THROW_ON_ERROR), json_encode($read['settings'], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE),
                json_encode(self::settingsValues($read['settings'], $plugin['settings']), JSON_THROW_ON_ERROR), gmdate('Y-m-d H:i:s'), $plugin['id']]);
        unset($this->rows[$plugin['manifestId']], $this->granted[$plugin['appId']]);
        return $this->find($plugin['manifestId']) ?? $plugin;
    }

    /** Set a plugin's settings; each must fit its schema. */
    public function setSettings(string $manifestId, mixed $values): array
    {
        $plugin = $this->find($manifestId) ?? throw new \InvalidArgumentException('That plugin is not installed.');
        if (!is_array($values)) {
            throw new \InvalidArgumentException('Send the settings.');
        }
        $saved = self::settingsValues($plugin['settingsSchema'], array_merge($plugin['settings'], $values));
        foreach ($values as $key => $value) {
            if (!array_key_exists((string) $key, $saved) || $saved[$key] !== $value) {
                throw new \InvalidArgumentException("The setting {$key} does not take that value.");
            }
        }
        $this->pdo->prepare('UPDATE plugins SET settings = ?, updated_at = ? WHERE id = ?')
            ->execute([json_encode($saved, JSON_THROW_ON_ERROR), gmdate('Y-m-d H:i:s'), $plugin['id']]);
        unset($this->rows[$manifestId]);
        return $this->find($manifestId) ?? $plugin;
    }

    /** Turn a plugin on or off; on, it may not send the sign-in codes another plugin that is on sends. */
    public function setEnabled(string $manifestId, bool $enabled): array
    {
        $plugin = $this->find($manifestId) ?? throw new \InvalidArgumentException('That plugin is not installed.');
        if ($enabled) {
            $this->assertProviderFree($this->granted($plugin)['signInCodes'], $manifestId);
        }
        $this->pdo->prepare('UPDATE plugins SET enabled = ?, updated_at = ? WHERE id = ?')->execute([$enabled ? 1 : 0, gmdate('Y-m-d H:i:s'), $plugin['id']]);
        unset($this->rows[$manifestId]);
        return $this->find($manifestId) ?? $plugin;
    }

    /**
     * Remove a plugin: its project and app, and every pass it issued, so the apps that require it
     * are closed until another is chosen. Apps keep their setting and say the plugin is not here.
     * What each app's owner set for it (PluginAppSettings) goes too, from every app.
     */
    public function remove(string $manifestId): void
    {
        $plugin = $this->find($manifestId) ?? throw new \InvalidArgumentException('That plugin is not installed.');
        $this->pdo->prepare('UPDATE passes SET revoked_at = ? WHERE plugin_id = ? AND revoked_at IS NULL')->execute([gmdate('Y-m-d H:i:s'), $manifestId]);
        try {
            $this->native->remove($plugin['appId']);
        } catch (\Throwable) {
            // Its files may already be gone; the record below is what installs it.
        }
        $this->apps->deleteApp($plugin['appId']);
        $this->pdo->prepare('DELETE FROM plugins WHERE id = ?')->execute([$plugin['id']]);
        unset($this->rows[$manifestId], $this->granted[$plugin['appId']]);
        try {
            $this->native->removePrivateFileEverywhere(PluginAppSettings::fileName($manifestId));
        } catch (\Throwable $e) {
            error_log('Plugin ' . $manifestId . ' was removed, and its apps\' settings for it were not: ' . get_class($e));
        }
    }

    /** The account plugins' projects belong to: no password opens it, and nobody may act as it. */
    private function ensureSystemUser(): void
    {
        $exists = $this->pdo->prepare('SELECT 1 FROM users WHERE id = ?');
        $exists->execute([self::SYSTEM_USER_ID]);
        if ($exists->fetchColumn() !== false) {
            return;
        }
        try {
            $this->pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, '!', 'Plugins')")
                ->execute([self::SYSTEM_USER_ID, self::SYSTEM_EMAIL]);
        } catch (\PDOException) {
            // Made meanwhile by another install.
        }
    }

    private function format(array $row): array
    {
        $decode = static fn (mixed $json): array => is_array($value = json_decode((string) $json, true)) ? $value : [];
        $schema = $decode($row['settings_schema'] ?? '[]');
        return [
            'id' => (string) $row['id'],
            'manifestId' => (string) $row['manifest_id'],
            'scope' => (string) $row['scope'],
            'source' => (string) ($row['source'] ?? 'builtin'),
            'appId' => (string) $row['app_id'],
            'name' => (string) $row['name'],
            'version' => (string) $row['version'],
            'enabled' => (bool) $row['enabled'],
            'grants' => $decode($row['grants']),
            'uses' => array_values(array_intersect($decode($row['uses'] ?? '[]'), self::USES)),
            'settingsSchema' => $schema,
            'settings' => self::settingsValues($schema, $decode($row['settings'] ?? '{}')),
            'installedAt' => $row['installed_at'],
        ];
    }
}

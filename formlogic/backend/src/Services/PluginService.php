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

    private PDO $pdo;
    /** @var array<string, ?array> rows looked up in this request, by manifest id */
    private array $rows = [];

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
        return [
            'id' => $id,
            'name' => trim($name),
            'description' => mb_substr(self::text($plugin['description'] ?? null), 0, 600),
            'version' => is_string($manifest['version'] ?? null) ? mb_substr($manifest['version'], 0, 40) : '0',
            'passes' => $out,
            'uses' => array_values(array_unique($uses)),
            'settings' => self::settingsSchema($plugin['settings'] ?? []),
            'sandbox' => array_values(array_unique($sandbox)),
        ];
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
     * not a plugin, or not a SoftN project this site runs.
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
        return $plugin + ['updates' => $installed === null ? null : ['version' => $installed['version']]];
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
        return $same ? null : self::review($builtin);
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

    /** What a plugin asks, as the administrator reads it before granting it. */
    public static function review(array $plugin): array
    {
        return [
            'version' => $plugin['version'],
            'passes' => $plugin['passes'],
            'uses' => $plugin['uses'],
            'settings' => $plugin['settings'],
            'sandbox' => array_map(fn (string $permission) => self::SANDBOX[$permission], $plugin['sandbox']),
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
        unset($this->rows[$plugin['id']]);
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
        unset($this->rows[$plugin['manifestId']]);
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

    public function setEnabled(string $manifestId, bool $enabled): array
    {
        $plugin = $this->find($manifestId) ?? throw new \InvalidArgumentException('That plugin is not installed.');
        $this->pdo->prepare('UPDATE plugins SET enabled = ?, updated_at = ? WHERE id = ?')->execute([$enabled ? 1 : 0, gmdate('Y-m-d H:i:s'), $plugin['id']]);
        unset($this->rows[$manifestId]);
        return $this->find($manifestId) ?? $plugin;
    }

    /**
     * Remove a plugin: its project and app, and every pass it issued, so the apps that require it
     * are closed until another is chosen. Apps keep their setting and say the plugin is not here.
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
        unset($this->rows[$manifestId]);
    }

    /** The account plugins' projects belong to: no password opens it, and nobody may act as it. */
    private function ensureSystemUser(): void
    {
        $this->pdo->prepare(
            "INSERT IGNORE INTO users (id, email, password_hash, name) VALUES (?, ?, '!', 'Plugins')"
        )->execute([self::SYSTEM_USER_ID, self::SYSTEM_EMAIL]);
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

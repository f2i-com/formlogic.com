<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use PDO;

/**
 * Plugins (docs/AGE_GATE_AND_SITE_AI.md, "Plugins"). A plugin is a SoftN project whose manifest
 * has a `formlogicPlugin` section saying where it plugs in. Its backend runs in the SoftN runner
 * and its pages in the sandboxed frame, as any SoftN app's do: it reaches nothing of the site but
 * what FormLogic hands it. What it may do is what its manifest declares and the administrator
 * granted at install; today, issuing passes of the kinds and strengths it declares
 * (AccessGateService), which apps choose to require.
 *
 * Its project is held as an app of the system Plugins account, which nobody can sign in as or act
 * as: so its files change only by installing it, and it is in no person's apps, backups or
 * account erasure. This first version installs the plugins that ship with FormLogic
 * (resources/plugins); uploads and plugins an owner adds to one app come later, and `scope` is
 * ready for them.
 */
final class PluginService
{
    public const SYSTEM_USER_ID = 'formlogic-system-plugins';
    private const SYSTEM_EMAIL = 'plugins@formlogic.invalid';
    public const ID_PATTERN = '/^[a-z0-9][a-z0-9.-]{2,63}$/D';
    private const KIND_PATTERN = '/^[a-z][a-z0-9_-]{0,15}$/D';

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
     * The plugin section of a project manifest, checked: an id, a name, and up to four passes it
     * may issue, each with its kind, label, unit, value range, strengths and the POST route of its
     * own backend that issues it. Throws on anything else.
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
        $passes = $plugin['passes'] ?? [];
        if (!is_array($passes) || count($passes) > 4) {
            throw new \InvalidArgumentException('A plugin declares at most four passes.');
        }
        $out = [];
        foreach ($passes as $pass) {
            $kind = $pass['kind'] ?? null;
            $min = $pass['min'] ?? null;
            $max = $pass['max'] ?? null;
            $strengths = $pass['strengths'] ?? null;
            $route = $pass['issueRoute'] ?? null;
            if (!is_string($kind) || !preg_match(self::KIND_PATTERN, $kind) || isset($out[$kind])
                || !is_int($min) || !is_int($max) || $min < 0 || $max > 65535 || $min > $max
                || !is_array($strengths) || $strengths === [] || array_diff($strengths, array_keys(AccessGateService::ASSURANCE)) !== []
                || !is_string($route) || !in_array($route, $routes, true)) {
                throw new \InvalidArgumentException('Each pass a plugin issues needs a kind, a value range, its strengths, and a POST route of its own backend that issues it.');
            }
            $out[$kind] = [
                'kind' => $kind,
                'label' => mb_substr(is_string($pass['label'] ?? null) ? $pass['label'] : $kind, 0, 40),
                'unit' => mb_substr(is_string($pass['unit'] ?? null) ? $pass['unit'] : '', 0, 20),
                'min' => $min,
                'max' => $max,
                'strengths' => array_values(array_unique($strengths)),
                'issueRoute' => $route,
            ];
        }
        return [
            'id' => $id,
            'name' => trim($name),
            'description' => mb_substr(is_string($plugin['description'] ?? null) ? $plugin['description'] : '', 0, 600),
            'version' => is_string($manifest['version'] ?? null) ? mb_substr($manifest['version'], 0, 40) : '0',
            'passes' => array_values($out),
        ];
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
            $found[$plugin['id']] = $plugin + ['dir' => dirname($file)];
        }
        ksort($found);
        return $found;
    }

    /** Every installed plugin, with its grants. */
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

    /** What an app owner can require: each pass kind of each enabled site plugin. */
    public function passKinds(): array
    {
        $kinds = [];
        foreach ($this->installed() as $plugin) {
            if (!$plugin['enabled'] || $plugin['scope'] !== 'site') {
                continue;
            }
            foreach ($plugin['grants'] as $pass) {
                $kinds[] = ['plugin' => $plugin['manifestId'], 'pluginName' => $plugin['name']] + $pass;
            }
        }
        return $kinds;
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

    /** A built-in plugin's files as a SoftN project, checked. */
    private static function builtinProject(array $builtin, int $version): array
    {
        $files = [];
        $iterator = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($builtin['dir'], \FilesystemIterator::SKIP_DOTS));
        foreach ($iterator as $file) {
            $relative = str_replace('\\', '/', substr((string) $file, strlen($builtin['dir']) + 1));
            $files[$relative] = (string) file_get_contents((string) $file);
        }
        ksort($files);
        $project = ['home' => true, 'version' => $version, 'files' => $files, 'assets' => [], 'access' => 'members'];
        NativeAppService::validateProject($project);
        return $project;
    }

    /**
     * What an update would bring an installed plugin, when this FormLogic ships it in another
     * version or with other files: the version and the passes it would be granted. Null otherwise.
     */
    public function pendingUpdate(array $plugin): ?array
    {
        $builtin = $this->builtins()[$plugin['manifestId']] ?? null;
        if ($builtin === null) {
            return null;
        }
        $installed = null;
        try {
            $installed = $this->native->get($plugin['appId']);
        } catch (\Throwable) {
            // Unreadable: offered, so the administrator can put it right.
        }
        $files = is_array($installed['files'] ?? null) ? $installed['files'] : [];
        ksort($files);
        $same = $builtin['version'] === $plugin['version'] && $files === self::builtinProject($builtin, 0)['files'];
        return $same ? null : ['version' => $builtin['version'], 'passes' => $builtin['passes']];
    }

    /**
     * Update an installed plugin to the version that ships with this FormLogic, granting what the
     * new manifest declares: the administrator saw it on Admin → Plugins and chose to. Its passes
     * stay; a kind the new version no longer issues stops counting, as its grant is gone.
     */
    public function updateBuiltin(string $manifestId): array
    {
        $builtin = $this->builtins()[$manifestId] ?? null;
        $plugin = $this->find($manifestId);
        if ($builtin === null || $plugin === null) {
            throw new \InvalidArgumentException('That plugin is not installed, or does not ship with FormLogic.');
        }
        if ($this->pendingUpdate($plugin) === null) {
            throw new \InvalidArgumentException('That plugin is up to date.');
        }
        $current = $this->native->project($plugin['appId']);
        $version = (int) ($current['version'] ?? 0);
        $this->native->install($plugin['appId'], self::builtinProject($builtin, $version), $version);
        $this->apps->publishApp($plugin['appId'], 'Updated to ' . $builtin['version'], self::SYSTEM_USER_ID);
        $this->pdo->prepare('UPDATE plugins SET name = ?, version = ?, grants = ?, updated_at = ? WHERE id = ?')
            ->execute([$builtin['name'], $builtin['version'], json_encode($builtin['passes'], JSON_THROW_ON_ERROR), gmdate('Y-m-d H:i:s'), $plugin['id']]);
        unset($this->rows[$manifestId]);
        return $this->find($manifestId) ?? $plugin;
    }

    /** Install a plugin that ships with FormLogic, granting what its manifest declares. */
    public function installBuiltin(string $manifestId, string $adminUserId): array
    {
        $builtin = $this->builtins()[$manifestId] ?? null;
        if ($builtin === null) {
            throw new \InvalidArgumentException('There is no such plugin.');
        }
        if ($this->find($manifestId) !== null) {
            throw new \InvalidArgumentException('That plugin is already installed.');
        }
        $project = self::builtinProject($builtin, 0);

        $this->ensureSystemUser();
        $slug = 'plugin-' . substr(preg_replace('/[^a-z0-9-]/', '-', $manifestId) ?? 'x', 0, 40) . '-' . bin2hex(random_bytes(3));
        $app = $this->apps->createApp([
            'name' => 'Plugin: ' . $builtin['name'],
            'slug' => $slug,
            'settings' => ['softnApp' => true, 'plugin' => $manifestId],
        ], self::SYSTEM_USER_ID);
        $appId = (string) $app['id'];
        try {
            $this->native->install($appId, $project, 0);
            $this->apps->publishApp($appId, 'Installed', self::SYSTEM_USER_ID);
            $now = gmdate('Y-m-d H:i:s');
            $this->pdo->prepare(
                "INSERT INTO plugins (id, manifest_id, scope, app_id, name, version, enabled, grants, installed_by, installed_at, updated_at)
                 VALUES (?, ?, 'site', ?, ?, ?, 1, ?, ?, ?, ?)"
            )->execute([bin2hex(random_bytes(16)), $manifestId, $appId, $builtin['name'], $builtin['version'],
                json_encode($builtin['passes'], JSON_THROW_ON_ERROR), $adminUserId, $now, $now]);
        } catch (\Throwable $e) {
            try { $this->native->remove($appId); } catch (\Throwable) {}
            $this->apps->deleteApp($appId);
            throw $e;
        }
        unset($this->rows[$manifestId]);
        return $this->find($manifestId) ?? throw new \RuntimeException('The plugin was not recorded.');
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
        $this->pdo->prepare('UPDATE access_receipts SET revoked_at = ? WHERE plugin_id = ? AND revoked_at IS NULL')->execute([gmdate('Y-m-d H:i:s'), $manifestId]);
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
        $grants = json_decode((string) $row['grants'], true);
        return [
            'id' => (string) $row['id'],
            'manifestId' => (string) $row['manifest_id'],
            'scope' => (string) $row['scope'],
            'appId' => (string) $row['app_id'],
            'name' => (string) $row['name'],
            'version' => (string) $row['version'],
            'enabled' => (bool) $row['enabled'],
            'grants' => is_array($grants) ? $grants : [],
            'installedAt' => $row['installed_at'],
        ];
    }
}

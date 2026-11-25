<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use InvalidArgumentException;
use PDO;
use RuntimeException;

/**
 * Modular member-level & per-app plugins (including SoftN apps packaged as plugins).
 *
 * Members can install plugins from the Marketplace (free or purchased, open or source-protected),
 * toggle or configure them, attach them to any of their Forms or SoftN apps, optionally link a
 * plugin to share an app's SQLite database, and invoke the plugin's sandboxed SoftN backend.
 */
class MemberPluginService
{
    private PDO $pdo;

    public function __construct(
        MySQLConnection $mysql,
        private AppService $apps,
        private NativeAppService $native
    ) {
        $this->pdo = $mysql->getConnection();
    }

    /** Internal NativeAppService app id for a member's installed SoftN plugin. */
    public static function runtimeAppIdFor(string $memberPluginId): string
    {
        $clean = preg_replace('/[^a-zA-Z0-9_-]/', '', $memberPluginId) ?? '';
        if ($clean === '') {
            throw new InvalidArgumentException('Invalid member plugin identifier');
        }
        return 'mplg_' . substr($clean, 0, 56);
    }

    /**
     * Install or upgrade a modular plugin for a member from a Marketplace listing.
     *
     * @param array<string, mixed> $catalog
     * @param array<string, mixed> $project
     * @return array<string, mixed>
     */
    public function installFromMarketplace(string $userId, array $catalog, ?string $licenseId, array $project): array
    {
        $info = MarketplaceSandboxService::inspectProject($project);
        $slug = (string) ($catalog['slug'] ?? '');
        if ($slug === '') {
            throw new InvalidArgumentException('Plugin slug is required.');
        }

        // Check if already installed by this member (upgrade in place)
        $existingStmt = $this->pdo->prepare(
            'SELECT * FROM member_plugins WHERE user_id = :user_id AND plugin_slug = :slug LIMIT 1'
        );
        $existingStmt->execute(['user_id' => $userId, 'slug' => $slug]);
        $existing = $existingStmt->fetch() ?: null;

        $pluginId = $existing ? (string) $existing['id'] : $this->generateUuid();
        $runtimeAppId = self::runtimeAppIdFor($pluginId);

        $existingRuntime = $this->native->get($runtimeAppId);
        $expectedVersion = is_array($existingRuntime) ? (int) ($existingRuntime['version'] ?? 0) : 0;

        $normalizedProject = [
            'home' => true,
            'version' => $expectedVersion,
            'access' => 'members',
            'files' => is_array($project['files'] ?? null) ? $project['files'] : [],
            'assets' => is_array($project['assets'] ?? null) ? $project['assets'] : [],
        ];

        $this->native->install($runtimeAppId, $normalizedProject, $expectedVersion, null, [
            'by' => $userId,
            'how' => 'upload',
            'summary' => 'Installed modular plugin from marketplace: ' . $slug,
        ]);

        $sourceProtected = (($catalog['source_visibility'] ?? 'open') === 'private') ? 1 : 0;
        $version = (string) ($catalog['latest_version'] ?? $info['version'] ?? '1.0.0');
        $manifestSummary = [
            'name' => (string) ($catalog['name'] ?? $info['name']),
            'version' => $version,
            'renderMode' => $info['renderMode'],
            'hasBackend' => $info['hasBackend'],
            'backendRuntime' => $info['backendRuntime'],
            'routes' => $info['routes'],
            'formlogicPlugin' => $info['pluginMeta']['formlogicPlugin'] ?? null,
        ];
        $capabilities = $info['pluginMeta']['capabilities'] ?? [];

        if ($existing) {
            $upd = $this->pdo->prepare(
                'UPDATE member_plugins
                 SET catalog_id = :catalog_id,
                     license_id = COALESCE(:license_id, license_id),
                     name = :name,
                     description = :description,
                     version = :version,
                     runtime_app_id = :runtime_app_id,
                     source_protected = :source_protected,
                     compatible_with = :compatible_with,
                     manifest_json = :manifest_json,
                     capabilities_json = :capabilities_json,
                     enabled = 1
                 WHERE id = :id AND user_id = :user_id'
            );
            $upd->execute([
                'catalog_id' => $catalog['id'] ?? null,
                'license_id' => $licenseId,
                'name' => (string) ($catalog['name'] ?? $info['name']),
                'description' => (string) ($catalog['description'] ?? $info['description']),
                'version' => $version,
                'runtime_app_id' => $runtimeAppId,
                'source_protected' => $sourceProtected,
                'compatible_with' => $catalog['compatible_with'] ?? null,
                'manifest_json' => json_encode($manifestSummary, JSON_THROW_ON_ERROR),
                'capabilities_json' => json_encode($capabilities, JSON_THROW_ON_ERROR),
                'id' => $pluginId,
                'user_id' => $userId,
            ]);
        } else {
            $ins = $this->pdo->prepare(
                'INSERT INTO member_plugins
                    (id, user_id, catalog_id, license_id, plugin_slug, name, description, version,
                     runtime_app_id, source_protected, compatible_with, manifest_json, capabilities_json, settings_json, enabled)
                 VALUES
                    (:id, :user_id, :catalog_id, :license_id, :plugin_slug, :name, :description, :version,
                     :runtime_app_id, :source_protected, :compatible_with, :manifest_json, :capabilities_json, :settings_json, 1)'
            );
            $ins->execute([
                'id' => $pluginId,
                'user_id' => $userId,
                'catalog_id' => $catalog['id'] ?? null,
                'license_id' => $licenseId,
                'plugin_slug' => $slug,
                'name' => (string) ($catalog['name'] ?? $info['name']),
                'description' => (string) ($catalog['description'] ?? $info['description']),
                'version' => $version,
                'runtime_app_id' => $runtimeAppId,
                'source_protected' => $sourceProtected,
                'compatible_with' => $catalog['compatible_with'] ?? null,
                'manifest_json' => json_encode($manifestSummary, JSON_THROW_ON_ERROR),
                'capabilities_json' => json_encode($capabilities, JSON_THROW_ON_ERROR),
                'settings_json' => json_encode((object) [], JSON_THROW_ON_ERROR),
            ]);
        }

        return $this->getMemberPlugin($userId, $pluginId) ?? [];
    }

    /** @return list<array<string, mixed>> */
    public function listMemberPlugins(string $userId): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT mp.*,
                    (SELECT COUNT(*) FROM app_plugins ap WHERE ap.member_plugin_id = mp.id) AS attached_app_count,
                    pc.slug AS catalog_slug,
                    pc.icon AS catalog_icon
             FROM member_plugins mp
             LEFT JOIN pack_catalog pc ON pc.id = mp.catalog_id
             WHERE mp.user_id = :user_id
             ORDER BY mp.installed_at DESC'
        );
        $stmt->execute(['user_id' => $userId]);
        return array_map(fn(array $row): array => $this->formatMemberPlugin($row), $stmt->fetchAll());
    }

    /** @return array<string, mixed>|null */
    public function getMemberPlugin(string $userId, string $pluginId): ?array
    {
        $stmt = $this->pdo->prepare(
            'SELECT mp.*,
                    (SELECT COUNT(*) FROM app_plugins ap WHERE ap.member_plugin_id = mp.id) AS attached_app_count,
                    pc.slug AS catalog_slug,
                    pc.icon AS catalog_icon
             FROM member_plugins mp
             LEFT JOIN pack_catalog pc ON pc.id = mp.catalog_id
             WHERE mp.id = :id AND mp.user_id = :user_id
             LIMIT 1'
        );
        $stmt->execute(['id' => $pluginId, 'user_id' => $userId]);
        $row = $stmt->fetch();
        return $row ? $this->formatMemberPlugin($row) : null;
    }

    /**
     * Update a member's installed plugin (enable/disable or settings).
     *
     * @param array<string, mixed> $data
     * @return array<string, mixed>
     */
    public function updateMemberPlugin(string $userId, string $pluginId, array $data): array
    {
        $existing = $this->getMemberPlugin($userId, $pluginId);
        if (!$existing) {
            throw new RuntimeException('Plugin not found.', 404);
        }
        $fields = [];
        $params = ['id' => $pluginId, 'user_id' => $userId];
        if (array_key_exists('enabled', $data)) {
            $fields[] = 'enabled = :enabled';
            $params['enabled'] = !empty($data['enabled']) ? 1 : 0;
        }
        if (array_key_exists('settings', $data) && is_array($data['settings'])) {
            $fields[] = 'settings_json = :settings_json';
            $params['settings_json'] = json_encode($data['settings'], JSON_THROW_ON_ERROR);
        }
        if ($fields !== []) {
            $stmt = $this->pdo->prepare(
                'UPDATE member_plugins SET ' . implode(', ', $fields) . ' WHERE id = :id AND user_id = :user_id'
            );
            $stmt->execute($params);
        }
        return $this->getMemberPlugin($userId, $pluginId) ?? $existing;
    }

    /** Uninstall a member's plugin and remove its runtime storage. */
    public function uninstallMemberPlugin(string $userId, string $pluginId): void
    {
        $stmt = $this->pdo->prepare('SELECT id, runtime_app_id FROM member_plugins WHERE id = :id AND user_id = :user_id LIMIT 1');
        $stmt->execute(['id' => $pluginId, 'user_id' => $userId]);
        $row = $stmt->fetch();
        if (!$row) {
            throw new RuntimeException('Plugin not found.', 404);
        }
        $runtimeAppId = is_string($row['runtime_app_id'] ?? null) ? $row['runtime_app_id'] : '';
        $del = $this->pdo->prepare('DELETE FROM member_plugins WHERE id = :id AND user_id = :user_id');
        $del->execute(['id' => $pluginId, 'user_id' => $userId]);
        if ($runtimeAppId !== '') {
            try {
                $this->native->remove($runtimeAppId);
            } catch (\Throwable) {
                // Ignore if already removed
            }
        }
    }

    /**
     * List all modular plugins attached to an app owned by `$userId`.
     *
     * @return list<array<string, mixed>>
     */
    public function listAppPlugins(string $userId, string $appId): array
    {
        $this->assertOwnsApp($userId, $appId);
        $stmt = $this->pdo->prepare(
            'SELECT ap.*,
                    mp.plugin_slug,
                    mp.name AS plugin_name,
                    mp.description AS plugin_description,
                    mp.version AS plugin_version,
                    mp.runtime_app_id,
                    mp.source_protected,
                    mp.compatible_with,
                    mp.manifest_json,
                    mp.capabilities_json,
                    mp.enabled AS plugin_global_enabled,
                    pc.slug AS catalog_slug,
                    pc.icon AS catalog_icon
             FROM app_plugins ap
             JOIN member_plugins mp ON mp.id = ap.member_plugin_id
             LEFT JOIN pack_catalog pc ON pc.id = mp.catalog_id
             WHERE ap.app_id = :app_id AND ap.user_id = :user_id
             ORDER BY ap.created_at ASC'
        );
        $stmt->execute(['app_id' => $appId, 'user_id' => $userId]);
        return array_map(fn(array $row): array => $this->formatAppPlugin($row), $stmt->fetchAll());
    }

    /**
     * Attach an installed modular plugin to one of the member's apps.
     *
     * @param array<string, mixed> $options
     * @return array<string, mixed>
     */
    public function attachPluginToApp(string $userId, string $appId, string $memberPluginId, array $options = []): array
    {
        $this->assertOwnsApp($userId, $appId);
        $plugin = $this->getMemberPlugin($userId, $memberPluginId);
        if (!$plugin) {
            throw new RuntimeException('Installed plugin not found.', 404);
        }

        $enabled = array_key_exists('enabled', $options) ? (!empty($options['enabled']) ? 1 : 0) : 1;
        $shareDatabase = !empty($options['shareDatabase']) ? 1 : 0;
        $mountPoint = is_string($options['mountPoint'] ?? null) && preg_match('/^[a-z0-9_-]{1,40}$/', $options['mountPoint']) === 1
            ? $options['mountPoint']
            : 'panel';
        $config = is_array($options['config'] ?? null) ? $options['config'] : [];

        $existingStmt = $this->pdo->prepare(
            'SELECT id FROM app_plugins WHERE app_id = :app_id AND member_plugin_id = :plugin_id LIMIT 1'
        );
        $existingStmt->execute(['app_id' => $appId, 'plugin_id' => $memberPluginId]);
        $existingId = $existingStmt->fetchColumn();

        if (is_string($existingId) && $existingId !== '') {
            $upd = $this->pdo->prepare(
                'UPDATE app_plugins
                 SET enabled = :enabled, share_database = :share_database, mount_point = :mount_point, config_json = :config_json
                 WHERE id = :id AND user_id = :user_id'
            );
            $upd->execute([
                'enabled' => $enabled,
                'share_database' => $shareDatabase,
                'mount_point' => $mountPoint,
                'config_json' => json_encode($config, JSON_THROW_ON_ERROR),
                'id' => $existingId,
                'user_id' => $userId,
            ]);
        } else {
            $ins = $this->pdo->prepare(
                'INSERT INTO app_plugins (id, app_id, member_plugin_id, user_id, enabled, share_database, mount_point, config_json)
                 VALUES (:id, :app_id, :member_plugin_id, :user_id, :enabled, :share_database, :mount_point, :config_json)'
            );
            $ins->execute([
                'id' => $this->generateUuid(),
                'app_id' => $appId,
                'member_plugin_id' => $memberPluginId,
                'user_id' => $userId,
                'enabled' => $enabled,
                'share_database' => $shareDatabase,
                'mount_point' => $mountPoint,
                'config_json' => json_encode($config, JSON_THROW_ON_ERROR),
            ]);
        }

        $attached = $this->listAppPlugins($userId, $appId);
        foreach ($attached as $item) {
            if ($item['memberPluginId'] === $memberPluginId) {
                return $item;
            }
        }
        throw new RuntimeException('Could not load attached plugin.');
    }

    /**
     * Update an attached app plugin configuration.
     *
     * @param array<string, mixed> $options
     * @return array<string, mixed>
     */
    public function updateAppPlugin(string $userId, string $appId, string $memberPluginId, array $options): array
    {
        $this->assertOwnsApp($userId, $appId);
        $existingStmt = $this->pdo->prepare(
            'SELECT * FROM app_plugins WHERE app_id = :app_id AND member_plugin_id = :plugin_id AND user_id = :user_id LIMIT 1'
        );
        $existingStmt->execute(['app_id' => $appId, 'plugin_id' => $memberPluginId, 'user_id' => $userId]);
        $existing = $existingStmt->fetch();
        if (!$existing) {
            throw new RuntimeException('Plugin is not attached to this app.', 404);
        }

        $fields = [];
        $params = ['id' => $existing['id'], 'user_id' => $userId];
        if (array_key_exists('enabled', $options)) {
            $fields[] = 'enabled = :enabled';
            $params['enabled'] = !empty($options['enabled']) ? 1 : 0;
        }
        if (array_key_exists('shareDatabase', $options)) {
            $fields[] = 'share_database = :share_database';
            $params['share_database'] = !empty($options['shareDatabase']) ? 1 : 0;
        }
        if (isset($options['mountPoint']) && is_string($options['mountPoint']) && preg_match('/^[a-z0-9_-]{1,40}$/', $options['mountPoint']) === 1) {
            $fields[] = 'mount_point = :mount_point';
            $params['mount_point'] = $options['mountPoint'];
        }
        if (array_key_exists('config', $options) && is_array($options['config'])) {
            $fields[] = 'config_json = :config_json';
            $params['config_json'] = json_encode($options['config'], JSON_THROW_ON_ERROR);
        }
        if ($fields !== []) {
            $upd = $this->pdo->prepare('UPDATE app_plugins SET ' . implode(', ', $fields) . ' WHERE id = :id AND user_id = :user_id');
            $upd->execute($params);
        }

        $attached = $this->listAppPlugins($userId, $appId);
        foreach ($attached as $item) {
            if ($item['memberPluginId'] === $memberPluginId) {
                return $item;
            }
        }
        throw new RuntimeException('Could not load updated plugin.');
    }

    /** Detach a modular plugin from an app. */
    public function detachPluginFromApp(string $userId, string $appId, string $memberPluginId): void
    {
        $this->assertOwnsApp($userId, $appId);
        $stmt = $this->pdo->prepare(
            'DELETE FROM app_plugins WHERE app_id = :app_id AND member_plugin_id = :plugin_id AND user_id = :user_id'
        );
        $stmt->execute(['app_id' => $appId, 'plugin_id' => $memberPluginId, 'user_id' => $userId]);
        if ($stmt->rowCount() === 0) {
            throw new RuntimeException('Plugin attachment not found.', 404);
        }
    }

    /**
     * Invoke an enabled modular SoftN plugin's backend route (`/api/...`).
     * When `$appId` is provided and the attachment has `shareDatabase = true`, routes the plugin's
     * SQLite data directory directly to `$appId`'s canonical shared SQLite database!
     *
     * @param array<string, mixed> $payload
     * @return array{status: int, body: mixed}
     */
    public function invokePluginBackend(string $userId, string $memberPluginId, array $payload, ?string $appId = null): array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM member_plugins WHERE id = :id AND user_id = :user_id LIMIT 1');
        $stmt->execute(['id' => $memberPluginId, 'user_id' => $userId]);
        $plugin = $stmt->fetch();
        if (!$plugin) {
            throw new RuntimeException('Plugin not found.', 404);
        }
        if (empty($plugin['enabled'])) {
            throw new RuntimeException('This plugin is disabled.', 403);
        }
        $runtimeAppId = (string) ($plugin['runtime_app_id'] ?? '');
        if ($runtimeAppId === '') {
            throw new RuntimeException('This plugin does not include a SoftN runtime backend.', 404);
        }

        $sharedDataDir = null;
        $pluginConfig = json_decode((string) ($plugin['settings_json'] ?? '{}'), true);
        if (!is_array($pluginConfig)) {
            $pluginConfig = [];
        }

        if ($appId !== null && $appId !== '') {
            $this->assertOwnsApp($userId, $appId);
            $attStmt = $this->pdo->prepare(
                'SELECT * FROM app_plugins WHERE app_id = :app_id AND member_plugin_id = :plugin_id AND user_id = :user_id LIMIT 1'
            );
            $attStmt->execute(['app_id' => $appId, 'plugin_id' => $memberPluginId, 'user_id' => $userId]);
            $att = $attStmt->fetch();
            if (!$att || empty($att['enabled'])) {
                throw new RuntimeException('This plugin is not enabled on the selected app.', 403);
            }
            $attConfig = json_decode((string) ($att['config_json'] ?? '{}'), true);
            if (is_array($attConfig)) {
                $pluginConfig = array_merge($pluginConfig, $attConfig);
            }
            if (!empty($att['share_database'])) {
                $canonicalDbAppId = $this->native->databaseAppId($appId);
                $dbPaths = $this->native->internalPaths($canonicalDbAppId);
                if ($dbPaths !== null) {
                    $sharedDataDir = $dbPaths['root'] . '/private/data';
                }
            }
        }

        $method = strtoupper(trim((string) ($payload['method'] ?? 'GET')));
        if (!in_array($method, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], true)) {
            throw new InvalidArgumentException('Unsupported HTTP method.');
        }
        $path = trim((string) ($payload['path'] ?? ''));
        if ($path === '' || !str_starts_with($path, '/api/') || str_starts_with(strtolower($path), '/api/site/') || str_contains($path, '..')) {
            throw new InvalidArgumentException('Plugin API path must start with /api/.');
        }

        $project = $this->native->project($runtimeAppId);
        if (!$project) {
            throw new RuntimeException('Plugin runtime bundle not found.', 404);
        }

        $identity = [
            'authenticated' => true,
            'userId' => $userId,
            'roleId' => 'owner',
            'pluginId' => $memberPluginId,
            'pluginConfig' => $pluginConfig,
            'hostAppId' => $appId,
            'formlogic' => [
                'appId' => $appId ?? $runtimeAppId,
                'userId' => $userId,
                'roleId' => 'owner',
            ],
        ];

        $query = is_array($payload['query'] ?? null) ? $payload['query'] : [];
        $body = $payload['body'] ?? null;

        if (NativeAppService::hasContainerBackend($project)) {
            $bodyRaw = is_string($body) ? $body : ($body !== null ? json_encode($body, JSON_THROW_ON_ERROR) : '');
            $req = [
                'method' => $method,
                'path' => $path,
                'query' => $query === [] ? '' : '?' . http_build_query($query),
                'headers' => [['content-type', 'application/json']],
                'bodyBase64' => base64_encode($bodyRaw),
            ];
            $res = $sharedDataDir !== null
                ? $this->native->sandboxContainerRequest($runtimeAppId, $sharedDataDir, $req, $identity)
                : $this->native->containerRequest($runtimeAppId, $req, $identity);
            $raw = base64_decode($res['bodyBase64'], true);
            $decoded = is_string($raw) ? json_decode($raw, true) : null;
            return [
                'status' => $res['status'],
                'body' => json_last_error() === JSON_ERROR_NONE ? $decoded : (string) $raw,
            ];
        }

        $req = [
            'method' => $method,
            'path' => $path,
            'query' => $query === [] ? (object) [] : $query,
            'body' => is_array($body) ? $body : (object) [],
            'headers' => (object) [],
            'client_ip' => '127.0.0.1',
            'rate_key' => 'member-plugin:' . $runtimeAppId . ':' . ($appId ?? 'workspace') . ':' . $userId,
            'photos' => false,
        ];
        $res = $sharedDataDir !== null
            ? $this->native->sandboxRequest($runtimeAppId, $sharedDataDir, $req, $identity, false)
            : $this->native->request($runtimeAppId, $req, $identity, [], null, false, 'plugin');

        return [
            'status' => (int) ($res['status'] ?? 200),
            'body' => $res['body'] ?? null,
        ];
    }

    private function assertOwnsApp(string $userId, string $appId): array
    {
        $app = $this->apps->getApp($appId);
        if (!$app || ($app['ownerId'] ?? null) !== $userId) {
            throw new RuntimeException('App not found or access denied.', 404);
        }
        return $app;
    }

    /** @return array<string, mixed> */
    private function formatMemberPlugin(array $row): array
    {
        $manifest = json_decode((string) ($row['manifest_json'] ?? '{}'), true);
        $capabilities = json_decode((string) ($row['capabilities_json'] ?? '[]'), true);
        $settings = json_decode((string) ($row['settings_json'] ?? '{}'), true);
        return [
            'id' => (string) $row['id'],
            'userId' => (string) $row['user_id'],
            'catalogId' => $row['catalog_id'] ?? null,
            'catalogSlug' => $row['catalog_slug'] ?? $row['plugin_slug'],
            'catalogIcon' => $row['catalog_icon'] ?? null,
            'licenseId' => $row['license_id'] ?? null,
            'pluginSlug' => (string) $row['plugin_slug'],
            'name' => (string) $row['name'],
            'description' => (string) ($row['description'] ?? ''),
            'version' => (string) ($row['version'] ?? '1.0.0'),
            'hasRuntime' => !empty($row['runtime_app_id']),
            'sourceProtected' => !empty($row['source_protected']),
            'compatibleWith' => $row['compatible_with'] ?? null,
            'manifest' => is_array($manifest) ? $manifest : [],
            'capabilities' => is_array($capabilities) ? $capabilities : [],
            'settings' => is_array($settings) ? $settings : [],
            'enabled' => !empty($row['enabled']),
            'attachedAppCount' => (int) ($row['attached_app_count'] ?? 0),
            'installedAt' => $row['installed_at'] ?? null,
            'updatedAt' => $row['updated_at'] ?? null,
        ];
    }

    /** @return array<string, mixed> */
    private function formatAppPlugin(array $row): array
    {
        $manifest = json_decode((string) ($row['manifest_json'] ?? '{}'), true);
        $capabilities = json_decode((string) ($row['capabilities_json'] ?? '[]'), true);
        $config = json_decode((string) ($row['config_json'] ?? '{}'), true);
        return [
            'id' => (string) $row['id'],
            'appId' => (string) $row['app_id'],
            'memberPluginId' => (string) $row['member_plugin_id'],
            'pluginSlug' => (string) $row['plugin_slug'],
            'catalogSlug' => $row['catalog_slug'] ?? $row['plugin_slug'],
            'catalogIcon' => $row['catalog_icon'] ?? null,
            'name' => (string) $row['plugin_name'],
            'description' => (string) ($row['plugin_description'] ?? ''),
            'version' => (string) ($row['plugin_version'] ?? '1.0.0'),
            'hasRuntime' => !empty($row['runtime_app_id']),
            'sourceProtected' => !empty($row['source_protected']),
            'compatibleWith' => $row['compatible_with'] ?? null,
            'manifest' => is_array($manifest) ? $manifest : [],
            'capabilities' => is_array($capabilities) ? $capabilities : [],
            'enabled' => !empty($row['enabled']) && !empty($row['plugin_global_enabled']),
            'attachmentEnabled' => !empty($row['enabled']),
            'pluginGlobalEnabled' => !empty($row['plugin_global_enabled']),
            'shareDatabase' => !empty($row['share_database']),
            'mountPoint' => (string) ($row['mount_point'] ?? 'panel'),
            'config' => is_array($config) ? $config : [],
            'createdAt' => $row['created_at'] ?? null,
            'updatedAt' => $row['updated_at'] ?? null,
        ];
    }

    private function generateUuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}

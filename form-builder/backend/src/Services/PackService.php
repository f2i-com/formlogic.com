<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use PDO;

class PackService
{
    private PDO $mysql;
    private FormService $formService;
    private AppService $appService;
    private AppUserService $appUserService;

    public function __construct(
        MySQLConnection $mysql,
        FormService $formService,
        AppService $appService,
        AppUserService $appUserService
    ) {
        $this->mysql = $mysql->getConnection();
        $this->formService = $formService;
        $this->appService = $appService;
        $this->appUserService = $appUserService;
    }

    /**
     * Import a pack: create forms, apps, roles, and permissions.
     * Records the installation for future management/uninstall.
     *
     * @param array  $packData Full pack JSON structure
     * @param string $userId   Authenticated user importing the pack
     * @return array { installationId, forms: [{id, title}], apps: [{id, name}] }
     */
    public function importPack(array $packData, string $userId, ?string $catalogId = null, ?string $versionId = null): array
    {
        // Validate structure
        $this->validatePack($packData);

        $createdFormIds = [];
        $createdAppIds = [];

        // Prevent duplicate imports of the same pack. A plain SELECT does not lock a
        // not-yet-existing row, so a named lock (per user+pack) serializes concurrent
        // imports — the check-then-insert is otherwise a TOCTOU race (no UNIQUE key).
        $meta = $packData['packMeta'];
        // Marketplace installs dedup on the trusted catalog_id (a community pack
        // may have no packMeta.id, which would otherwise fall back to matching by
        // name); direct JSON imports fall back to the embedded id/name.
        $dedupeKey = $catalogId ?? ($meta['id'] ?? $meta['name'] ?? 'custom');
        $installLock = ($dedupeKey !== 'custom') ? $this->acquireInstallLock($dedupeKey, $userId) : null;

        $this->mysql->beginTransaction();

        $alreadyInstalled = $catalogId !== null
            ? $this->isCatalogPackInstalled($catalogId, $userId)
            : ($dedupeKey !== 'custom' ? $this->isPackInstalled($dedupeKey, $userId) : null);
        if ($alreadyInstalled) {
            $this->mysql->rollBack();
            $this->releaseInstallLock($installLock);
            throw new \RuntimeException('This pack is already installed');
        }

        try {
            // 1. Build form ID map: packFormId → new UUID
            $formIdMap = [];
            foreach ($packData['forms'] as $packForm) {
                $formIdMap[$packForm['packFormId']] = $this->generateUuid();
            }

            // 2. Create each form
            $formSummary = [];
            foreach ($packData['forms'] as $packForm) {
                $newFormId = $formIdMap[$packForm['packFormId']];

                // Remap @pack: references in linked_record fields
                $fields = $this->remapFieldReferences($packForm['fields'] ?? [], $formIdMap);

                // Strip the pack author's private notification settings (e.g.
                // notificationEmail) so installs don't silently route the installer's
                // response notifications to the author. (Mirrors the output-side
                // stripping; this is the untrusted-input vector.)
                $importSettings = $packForm['settings'] ?? [];
                if (is_array($importSettings)) {
                    unset($importSettings['notifications']);
                }

                $formData = [
                    'id' => $newFormId,
                    'userId' => $userId,
                    'title' => $packForm['title'],
                    'description' => $packForm['description'] ?? null,
                    'status' => 'draft',
                    'settings' => $importSettings,
                    'theme' => $packForm['theme'] ?? [],
                    'logicScript' => $packForm['logicScript'] ?? null,
                    'customScreen' => !empty($packForm['customScreen']) ? $packForm['customScreen'] : null,
                    'icon' => $packForm['icon'] ?? null,
                    'fields' => $fields,
                ];

                $this->formService->createForm($formData);
                $createdFormIds[] = $newFormId;
                $formSummary[] = ['id' => $newFormId, 'title' => $packForm['title']];
            }

            // 3. Create each app
            $appSummary = [];
            foreach ($packData['apps'] ?? [] as $packApp) {
                $appData = [
                    'name' => $packApp['name'],
                    'description' => $packApp['description'] ?? null,
                    'settings' => $packApp['settings'] ?? [],
                    'theme' => $packApp['theme'] ?? [],
                ];
                $app = $this->appService->createApp($appData, $userId);
                $appId = $app['id'];
                $createdAppIds[] = $appId;

                // 4. Add forms to app with remapped IDs
                foreach ($packApp['forms'] ?? [] as $appForm) {
                    $realFormId = $formIdMap[$appForm['packFormId']] ?? null;
                    if ($realFormId) {
                        $this->appService->addFormToApp(
                            $appId,
                            $realFormId,
                            $appForm['displayName'] ?? null
                        );
                    }
                }

                // 5. Create custom roles and set permissions
                foreach ($packApp['roles'] ?? [] as $packRole) {
                    $role = $this->appUserService->createRole($appId, [
                        'name' => $packRole['name'],
                        'description' => $packRole['description'] ?? null,
                    ]);

                    $permissions = [];
                    foreach ($packRole['permissions'] ?? [] as $perm) {
                        if (isset($perm['packFormId']) && $perm['packFormId'] !== null) {
                            $realFormId = $formIdMap[$perm['packFormId']] ?? null;
                            if ($realFormId) {
                                $permissions[] = [
                                    'formId' => $realFormId,
                                    'permission' => $perm['permission'],
                                ];
                            }
                        } else {
                            $permissions[] = [
                                'formId' => null,
                                'permission' => $perm['permission'],
                            ];
                        }
                    }

                    if (!empty($permissions)) {
                        // The importer is the owner of the freshly created app, so they
                        // are allowed to grant app-level permissions the pack defines.
                        // Without this flag, any pack containing an admin-style role
                        // (e.g. one with view_analytics/manage_users) would be
                        // uninstallable for everyone.
                        $this->appUserService->setRolePermissions($role['id'], $permissions, true);
                    }
                }

                $appSummary[] = ['id' => $appId, 'name' => $packApp['name']];
            }

            // 6. Record the installation
            $installationId = $this->generateUuid();
            $meta = $packData['packMeta'];
            $stmt = $this->mysql->prepare("
                INSERT INTO pack_installations (id, user_id, pack_id, catalog_id, version_id, pack_name, pack_version, pack_description, form_ids, app_ids)
                VALUES (:id, :user_id, :pack_id, :catalog_id, :version_id, :pack_name, :pack_version, :pack_description, :form_ids, :app_ids)
            ");
            $stmt->execute([
                'id' => $installationId,
                'user_id' => $userId,
                'pack_id' => $meta['id'] ?? $meta['name'] ?? 'custom',
                'catalog_id' => $catalogId,
                'version_id' => $versionId,
                'pack_name' => $meta['name'] ?? 'Unknown Pack',
                'pack_version' => $meta['version'] ?? '1.0.0',
                'pack_description' => $meta['description'] ?? null,
                'form_ids' => json_encode($createdFormIds),
                'app_ids' => json_encode($createdAppIds),
            ]);

            $this->mysql->commit();
            $this->releaseInstallLock($installLock);

            return [
                'installationId' => $installationId,
                'forms' => $formSummary,
                'apps' => $appSummary,
            ];

        } catch (\Exception $e) {
            $this->mysql->rollBack();
            $this->releaseInstallLock($installLock);

            // Clean up any created forms (SQLite databases)
            foreach ($createdFormIds as $fid) {
                try {
                    $this->formService->deleteForm($fid);
                } catch (\Exception $cleanupError) {
                    // Ignore cleanup errors
                }
            }

            throw $e;
        }
    }

    /**
     * Get all pack installations for a user.
     *
     * @return array List of installation records
     */
    public function getInstalledPacks(string $userId): array
    {
        $stmt = $this->mysql->prepare("
            SELECT id, pack_id, catalog_id, version_id, pack_name, pack_version, pack_description,
                   form_ids, app_ids, installed_at
            FROM pack_installations
            WHERE user_id = :user_id
            ORDER BY installed_at DESC
        ");
        $stmt->execute(['user_id' => $userId]);
        $rows = $stmt->fetchAll();

        // Batch-fetch the latest version per catalog (one query, not N+1) so we
        // can flag updates. Keyed by catalog_id => ['id','version','changelog'].
        $latestByCatalog = [];
        $catalogIds = array_values(array_unique(array_filter(array_map(fn ($r) => $r['catalog_id'] ?? null, $rows))));
        if (!empty($catalogIds)) {
            $placeholders = implode(',', array_fill(0, count($catalogIds), '?'));
            $vStmt = $this->mysql->prepare("
                SELECT pv.catalog_id, pv.id, pv.version, pv.changelog
                FROM pack_versions pv
                JOIN (
                    SELECT catalog_id, MAX(created_at) AS mc
                    FROM pack_versions
                    WHERE catalog_id IN ($placeholders)
                    GROUP BY catalog_id
                ) m ON m.catalog_id = pv.catalog_id AND m.mc = pv.created_at
            ");
            $vStmt->execute($catalogIds);
            foreach ($vStmt->fetchAll() as $v) {
                // Keep the first per catalog (guards the rare same-second tie).
                $latestByCatalog[$v['catalog_id']] ??= $v;
            }
        }

        // Batch existence checks: one query for all forms, one for all apps,
        // instead of 2 COUNT(*) per installation row (N+1).
        $allFormIds = [];
        $allAppIds = [];
        foreach ($rows as $row) {
            foreach (json_decode($row['form_ids'], true) ?? [] as $fid) { $allFormIds[$fid] = true; }
            foreach (json_decode($row['app_ids'], true) ?? [] as $aid) { $allAppIds[$aid] = true; }
        }
        $existingFormIds = $this->existingIds('forms', array_keys($allFormIds));
        $existingAppIds = $this->existingIds('apps', array_keys($allAppIds));

        $installations = [];
        foreach ($rows as $row) {
            $formIds = json_decode($row['form_ids'], true) ?? [];
            $appIds = json_decode($row['app_ids'], true) ?? [];

            // Count which forms/apps still exist (from the batched sets above)
            $existingForms = count(array_intersect_key(array_flip($formIds), $existingFormIds));
            $existingApps = count(array_intersect_key(array_flip($appIds), $existingAppIds));

            // Flag an update by VERSION IDENTITY (latest version row vs the
            // installed version_id), not version strings — the embedded
            // packMeta.version often differs from the catalog version, which
            // produced false "update available" badges right after install.
            $updateAvailable = null;
            $latest = (!empty($row['catalog_id']) && isset($latestByCatalog[$row['catalog_id']]))
                ? $latestByCatalog[$row['catalog_id']] : null;
            if ($latest && !empty($row['version_id']) && (string) $latest['id'] !== (string) $row['version_id']) {
                $updateAvailable = ['version' => $latest['version'], 'changelog' => $latest['changelog']];
            }

            $installations[] = [
                'id' => $row['id'],
                'packId' => $row['pack_id'],
                'catalogId' => $row['catalog_id'] ?? null,
                'versionId' => $row['version_id'] ?? null,
                'packName' => $row['pack_name'],
                'packVersion' => $row['pack_version'],
                'packDescription' => $row['pack_description'],
                'formCount' => count($formIds),
                'appCount' => count($appIds),
                'existingFormCount' => $existingForms,
                'existingAppCount' => $existingApps,
                'formIds' => $formIds,
                'appIds' => $appIds,
                'installedAt' => $row['installed_at'],
                'updateAvailable' => $updateAvailable,
            ];
        }

        return $installations;
    }

    /**
     * Uninstall a pack: delete all forms and apps created by it.
     *
     * @return array { formsDeleted: int, appsDeleted: int }
     */
    public function uninstallPack(string $installationId, string $userId): array
    {
        // Verify the installation belongs to this user
        $stmt = $this->mysql->prepare("
            SELECT id, form_ids, app_ids
            FROM pack_installations
            WHERE id = :id AND user_id = :user_id
        ");
        $stmt->execute(['id' => $installationId, 'user_id' => $userId]);
        $installation = $stmt->fetch();

        if (!$installation) {
            throw new \RuntimeException('Installation not found');
        }

        $formIds = json_decode($installation['form_ids'], true) ?? [];
        $appIds = json_decode($installation['app_ids'], true) ?? [];

        $formsDeleted = 0;
        $appsDeleted = 0;

        // Delete apps first (they reference forms via app_forms)
        // Verify ownership before deleting to prevent deletion of other users' resources
        foreach ($appIds as $appId) {
            try {
                $checkStmt = $this->mysql->prepare("SELECT id FROM apps WHERE id = :id AND owner_id = :owner_id");
                $checkStmt->execute(['id' => $appId, 'owner_id' => $userId]);
                if (!$checkStmt->fetch()) continue; // Skip if not owned or already deleted
                $this->appService->deleteApp($appId);
                $appsDeleted++;
            } catch (\Exception $e) {
                // App may have been manually deleted already
            }
        }

        // Delete forms (and their SQLite databases)
        // Verify ownership before deleting
        foreach ($formIds as $formId) {
            try {
                $checkStmt = $this->mysql->prepare("SELECT id FROM forms WHERE id = :id AND user_id = :user_id");
                $checkStmt->execute(['id' => $formId, 'user_id' => $userId]);
                if (!$checkStmt->fetch()) continue; // Skip if not owned or already deleted
                $this->formService->deleteForm($formId);
                $formsDeleted++;
            } catch (\Exception $e) {
                // Form may have been manually deleted already
            }
        }

        // Remove the installation record
        $stmt = $this->mysql->prepare("DELETE FROM pack_installations WHERE id = :id");
        $stmt->execute(['id' => $installationId]);

        return [
            'formsDeleted' => $formsDeleted,
            'appsDeleted' => $appsDeleted,
        ];
    }

    /**
     * Adopt an existing (pre-tracking) pack installation.
     * Matches pack form titles against user's existing forms and creates
     * an installation record without creating new forms/apps.
     *
     * @param array  $packData Full pack JSON structure
     * @param string $userId   Authenticated user
     * @return array { installationId, formsMatched, appsMatched }
     */
    public function adoptExistingPack(array $packData, string $userId): array
    {
        $this->validatePack($packData);

        $meta = $packData['packMeta'];
        $packId = $meta['id'] ?? $meta['name'] ?? 'custom';

        // Serialize against concurrent adopt/import of the same pack by this user.
        $installLock = $this->acquireInstallLock($packId, $userId);
        try {
            // Don't adopt if already tracked
            if ($this->isPackInstalled($packId, $userId)) {
                throw new \RuntimeException('Pack is already tracked');
            }

            return $this->adoptExistingPackLocked($packData, $userId, $packId, $meta);
        } finally {
            $this->releaseInstallLock($installLock);
        }
    }

    private function adoptExistingPackLocked(array $packData, string $userId, string $packId, array $meta): array
    {
        // Match forms by title
        $formIds = [];
        foreach ($packData['forms'] as $packForm) {
            $stmt = $this->mysql->prepare("
                SELECT id FROM forms
                WHERE user_id = :user_id AND title = :title
                ORDER BY created_at DESC
                LIMIT 1
            ");
            $stmt->execute(['user_id' => $userId, 'title' => $packForm['title']]);
            $row = $stmt->fetch();
            if ($row) {
                $formIds[] = $row['id'];
            }
        }

        // Match apps by name
        $appIds = [];
        foreach ($packData['apps'] ?? [] as $packApp) {
            $stmt = $this->mysql->prepare("
                SELECT id FROM apps
                WHERE owner_id = :user_id AND name = :name
                ORDER BY created_at DESC
                LIMIT 1
            ");
            $stmt->execute(['user_id' => $userId, 'name' => $packApp['name']]);
            $row = $stmt->fetch();
            if ($row) {
                $appIds[] = $row['id'];
            }
        }

        // Must match at least some forms to consider it an existing install
        if (empty($formIds)) {
            throw new \RuntimeException('No matching forms found for this pack');
        }

        // Create installation record
        $installationId = $this->generateUuid();
        $stmt = $this->mysql->prepare("
            INSERT INTO pack_installations (id, user_id, pack_id, pack_name, pack_version, pack_description, form_ids, app_ids)
            VALUES (:id, :user_id, :pack_id, :pack_name, :pack_version, :pack_description, :form_ids, :app_ids)
        ");
        $stmt->execute([
            'id' => $installationId,
            'user_id' => $userId,
            'pack_id' => $packId,
            'pack_name' => $meta['name'] ?? 'Unknown Pack',
            'pack_version' => $meta['version'] ?? '1.0.0',
            'pack_description' => $meta['description'] ?? null,
            'form_ids' => json_encode($formIds),
            'app_ids' => json_encode($appIds),
        ]);

        return [
            'installationId' => $installationId,
            'formsMatched' => count($formIds),
            'appsMatched' => count($appIds),
        ];
    }

    /**
     * Serialize concurrent install/adopt of the same pack by the same user so the
     * isPackInstalled() check-then-insert cannot race into duplicate installations
     * (there is no UNIQUE constraint on pack_installations). Mirrors the audit-chain
     * GET_LOCK pattern. Fails open (returns null) so a lock-server hiccup never
     * blocks legitimate installs.
     */
    private function acquireInstallLock(string $packId, string $userId): ?string
    {
        // GET_LOCK names are capped at 64 chars; hash to stay well within that.
        $name = 'fl_pack_install_' . hash('sha256', $packId . '|' . $userId);
        $name = substr($name, 0, 60);
        try {
            $stmt = $this->mysql->prepare("SELECT GET_LOCK(:n, 5)");
            $stmt->execute(['n' => $name]);
            return ((int) $stmt->fetchColumn() === 1) ? $name : null;
        } catch (\Exception $e) {
            return null;
        }
    }

    private function releaseInstallLock(?string $name): void
    {
        if ($name === null) {
            return;
        }
        try {
            $stmt = $this->mysql->prepare("SELECT RELEASE_LOCK(:n)");
            $stmt->execute(['n' => $name]);
        } catch (\Exception $e) {
            // best-effort; the lock also releases on connection close
        }
    }

    /**
     * Check if a pack (by pack_id) is installed for a user.
     */
    public function isPackInstalled(string $packId, string $userId): ?array
    {
        $stmt = $this->mysql->prepare("
            SELECT id, installed_at
            FROM pack_installations
            WHERE pack_id = :pack_id AND user_id = :user_id
            ORDER BY installed_at DESC
            LIMIT 1
        ");
        $stmt->execute(['pack_id' => $packId, 'user_id' => $userId]);
        $row = $stmt->fetch();

        return $row ?: null;
    }

    /**
     * Check if a marketplace pack (by catalog_id) is installed for a user.
     */
    public function isCatalogPackInstalled(string $catalogId, string $userId): ?array
    {
        $stmt = $this->mysql->prepare("
            SELECT id, installed_at
            FROM pack_installations
            WHERE catalog_id = :catalog_id AND user_id = :user_id
            ORDER BY installed_at DESC
            LIMIT 1
        ");
        $stmt->execute(['catalog_id' => $catalogId, 'user_id' => $userId]);
        return $stmt->fetch() ?: null;
    }

    /**
     * Validate pack data structure
     */
    private function validatePack(array $packData): void
    {
        if (($packData['formatVersion'] ?? null) !== 1) {
            throw new \RuntimeException('Unsupported pack format version');
        }

        if (!isset($packData['packMeta']) || !is_array($packData['packMeta'])) {
            throw new \RuntimeException('Pack is missing packMeta');
        }

        if (empty($packData['forms']) || !is_array($packData['forms'])) {
            throw new \RuntimeException('Pack must contain at least one form');
        }

        // Enforce size limits to prevent resource exhaustion
        if (count($packData['forms']) > 50) {
            throw new \RuntimeException('Pack cannot contain more than 50 forms');
        }
        if (isset($packData['apps']) && is_array($packData['apps']) && count($packData['apps']) > 20) {
            throw new \RuntimeException('Pack cannot contain more than 20 apps');
        }

        // Check for duplicate packFormIds
        $seenFormIds = [];
        foreach ($packData['forms'] as $i => $form) {
            if (!isset($form['packFormId']) || $form['packFormId'] === '') {
                throw new \RuntimeException("Form at index {$i} is missing packFormId");
            }
            if (empty($form['title'])) {
                throw new \RuntimeException("Form '{$form['packFormId']}' is missing title");
            }
            if (isset($form['fields']) && is_array($form['fields']) && count($form['fields']) > 200) {
                throw new \RuntimeException("Form '{$form['packFormId']}' has too many fields (max 200)");
            }
            // Enforce per-form field size limits (same as FormController)
            if (isset($form['logicScript']) && is_string($form['logicScript']) && strlen($form['logicScript']) > 102400) {
                throw new \RuntimeException("Form '{$form['packFormId']}' logic script exceeds 100KB limit");
            }
            if (isset($form['fields']) && is_array($form['fields'])) {
                $fieldsJson = json_encode($form['fields']);
                if ($fieldsJson !== false && strlen($fieldsJson) > 512000) {
                    throw new \RuntimeException("Form '{$form['packFormId']}' fields data exceeds 500KB limit");
                }
            }
            if (isset($form['settings'])) {
                $settingsJson = json_encode($form['settings']);
                if ($settingsJson !== false && strlen($settingsJson) > 10240) {
                    throw new \RuntimeException("Form '{$form['packFormId']}' settings exceeds 10KB limit");
                }
            }
            if (isset($form['theme'])) {
                $themeJson = json_encode($form['theme']);
                if ($themeJson !== false && strlen($themeJson) > 10240) {
                    throw new \RuntimeException("Form '{$form['packFormId']}' theme exceeds 10KB limit");
                }
            }
            if (isset($form['customScreen'])) {
                $screenJson = json_encode($form['customScreen']);
                if ($screenJson !== false && strlen($screenJson) > 524288) {
                    throw new \RuntimeException("Form '{$form['packFormId']}' custom screen exceeds 512KB limit");
                }
            }
            if (isset($seenFormIds[$form['packFormId']])) {
                throw new \RuntimeException("Duplicate packFormId: '{$form['packFormId']}'");
            }
            $seenFormIds[$form['packFormId']] = true;
        }

        foreach ($packData['apps'] ?? [] as $i => $app) {
            if (!isset($app['packAppId']) || $app['packAppId'] === '') {
                throw new \RuntimeException("App at index {$i} is missing packAppId");
            }
            if (empty($app['name'])) {
                throw new \RuntimeException("App '{$app['packAppId']}' is missing name");
            }
        }
    }

    /**
     * Remap @pack: prefixed targetFormId references in linked_record fields
     */
    private function remapFieldReferences(array $fields, array $formIdMap): array
    {
        foreach ($fields as &$field) {
            if (($field['type'] ?? '') === 'linked_record') {
                $targetFormId = $field['properties']['targetFormId'] ?? null;
                if (is_string($targetFormId) && str_starts_with($targetFormId, '@pack:')) {
                    $packFormId = substr($targetFormId, 6);
                    if (!isset($formIdMap[$packFormId])) {
                        throw new \RuntimeException(
                            "Linked record field '{$field['id']}' references unknown packFormId '{$packFormId}'"
                        );
                    }
                    $field['properties']['targetFormId'] = $formIdMap[$packFormId];
                }
            }
        }
        unset($field);
        return $fields;
    }

    /**
     * Return a set (id => true) of which of the given ids exist in $table.
     * $table is a fixed internal value ('forms' | 'apps'), never user input.
     */
    private function existingIds(string $table, array $ids): array
    {
        if (empty($ids)) {
            return [];
        }
        $placeholders = implode(',', array_fill(0, count($ids), '?'));
        $stmt = $this->mysql->prepare("SELECT id FROM {$table} WHERE id IN ($placeholders)");
        $stmt->execute(array_values($ids));
        return array_fill_keys($stmt->fetchAll(\PDO::FETCH_COLUMN), true);
    }

    private function generateUuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}

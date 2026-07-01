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
                // App settings: strip the author's notifications, remap landingPage (@pack:->UUID),
                // and defer defaultRoleId until roles exist (carried as defaultRoleName).
                $appSettings = is_array($packApp['settings'] ?? null) ? $packApp['settings'] : [];
                unset($appSettings['notifications']);
                $lp = $appSettings['landingPage'] ?? null;
                if (is_string($lp) && str_starts_with($lp, '@pack:')) {
                    $appSettings['landingPage'] = $formIdMap[substr($lp, 6)] ?? 'dashboard';
                }
                $defaultRoleName = $appSettings['defaultRoleName'] ?? null;
                unset($appSettings['defaultRoleName'], $appSettings['defaultRoleId']);

                // navConfig: remap each item.formId (@pack:->UUID); drop items pointing at a missing form.
                $navConfig = [];
                foreach ((is_array($packApp['navConfig'] ?? null) ? $packApp['navConfig'] : []) as $item) {
                    $fid = $item['formId'] ?? null;
                    if (is_string($fid) && str_starts_with($fid, '@pack:')) {
                        $key = substr($fid, 6);
                        if (!isset($formIdMap[$key])) {
                            continue;
                        }
                        $item['formId'] = $formIdMap[$key];
                    }
                    $navConfig[] = $item;
                }

                $appData = [
                    'name' => $packApp['name'],
                    'description' => $packApp['description'] ?? null,
                    'settings' => $appSettings,
                    'theme' => $packApp['theme'] ?? [],
                    'logoUrl' => $packApp['logoUrl'] ?? null,
                    'navConfig' => $navConfig,
                    'customScreen' => !empty($packApp['customScreen']) ? $packApp['customScreen'] : null,
                ];
                $app = $this->appService->createApp($appData, $userId);
                $appId = $app['id'];
                $createdAppIds[] = $appId;

                // 4. Add forms to app with remapped IDs, preserving order + visibility + per-form settings.
                $memberForms = $packApp['forms'] ?? [];
                usort($memberForms, fn ($a, $b) => ($a['sortOrder'] ?? 0) <=> ($b['sortOrder'] ?? 0));
                foreach ($memberForms as $appForm) {
                    $realFormId = $formIdMap[$appForm['packFormId']] ?? null;
                    if ($realFormId) {
                        $this->appService->addFormToApp(
                            $appId,
                            $realFormId,
                            $appForm['displayName'] ?? null
                        );
                        $meta = [];
                        if (array_key_exists('isVisible', $appForm)) {
                            $meta['isVisible'] = (bool) $appForm['isVisible'];
                        }
                        if (isset($appForm['settings'])) {
                            $meta['settings'] = $appForm['settings'];
                        }
                        if (!empty($meta)) {
                            $this->appService->updateAppForm($appId, $realFormId, $meta);
                        }
                    }
                }

                // 5. Roles: custom roles are created; a `system` role (Admin/Member) applies its permission
                //    overrides to the same-named system role createApp already made (so customizations
                //    round-trip). Owner is never in the pack (recreated with all permissions).
                $sysRolesByName = null; // lazily fetched map name => role
                foreach ($packApp['roles'] ?? [] as $packRole) {
                    $permissions = [];
                    foreach ($packRole['permissions'] ?? [] as $perm) {
                        if (isset($perm['packFormId']) && $perm['packFormId'] !== null) {
                            $realFormId = $formIdMap[$perm['packFormId']] ?? null;
                            if ($realFormId) {
                                $permissions[] = ['formId' => $realFormId, 'permission' => $perm['permission']];
                            }
                        } else {
                            $permissions[] = ['formId' => null, 'permission' => $perm['permission']];
                        }
                    }

                    if (!empty($packRole['system'])) {
                        if ($sysRolesByName === null) {
                            $sysRolesByName = [];
                            foreach ($this->appUserService->getRoles($appId) as $sr) {
                                if (!empty($sr['isSystem'])) {
                                    $sysRolesByName[$sr['name']] = $sr;
                                }
                            }
                        }
                        $target = $sysRolesByName[$packRole['name'] ?? ''] ?? null;
                        // Never let an import escalate Owner; only Admin/Member overrides apply.
                        if ($target && ($target['name'] ?? '') !== 'Owner' && !empty($permissions)) {
                            $this->appUserService->setRolePermissions($target['id'], $permissions, true);
                        }
                        continue;
                    }

                    $role = $this->appUserService->createRole($appId, [
                        'name' => $packRole['name'],
                        'description' => $packRole['description'] ?? null,
                    ]);
                    if (!empty($permissions)) {
                        // The importer owns the freshly created app, so they may grant the app-level
                        // permissions the pack defines (else an admin-style role would be uninstallable).
                        $this->appUserService->setRolePermissions($role['id'], $permissions, true);
                    }
                }

                // Resolve the default role (carried by name) to the new role id now that roles exist.
                if ($defaultRoleName !== null && $defaultRoleName !== '') {
                    foreach ($this->appUserService->getRoles($appId) as $rn) {
                        if (($rn['name'] ?? null) === $defaultRoleName) {
                            $appSettings['defaultRoleId'] = $rn['id'];
                            $this->appService->updateApp($appId, ['settings' => $appSettings]);
                            break;
                        }
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
     * Export a whole app as a self-contained Pack (the app + ALL its member forms incl. fields,
     * logicScript and customScreen, the app's custom home screen / settings / theme / navConfig,
     * membership metadata, and custom roles). The result round-trips through importPack().
     *
     * Portable + safe by construction: this WHITELISTS fields and emits only local pack keys and
     * @pack: references — never real UUIDs, owner ids, members, responses, or secrets.
     *
     * @return array PackData
     */
    public function exportApp(string $appId, string $userId): array
    {
        $app = $this->appService->getApp($appId);
        if (!$app || ($app['ownerId'] ?? null) !== $userId) {
            throw new \RuntimeException('App not found');
        }

        $appForms = $this->appService->getAppForms($appId); // ordered by sort_order

        // Stable real-formId -> packFormId (slug) map, built first so cross-form links resolve.
        $realToPackKey = [];
        $usedKeys = [];
        $loadedForms = [];
        foreach ($appForms as $af) {
            $form = $this->formService->getForm($af['formId']);
            if (!$form) {
                continue;
            }
            $loadedForms[$af['formId']] = $form;
            $realToPackKey[$af['formId']] = $this->uniqueSlug((string) ($form['title'] ?? 'form'), $usedKeys);
        }

        // Build pack forms (whitelist; strip the author's notification settings).
        $packForms = [];
        foreach ($appForms as $af) {
            $form = $loadedForms[$af['formId']] ?? null;
            if (!$form) {
                continue;
            }
            $settings = is_array($form['settings'] ?? null) ? $form['settings'] : [];
            unset($settings['notifications']);
            $entry = [
                'packFormId' => $realToPackKey[$af['formId']],
                'title' => $form['title'] ?? 'Untitled',
                'description' => $form['description'] ?? null,
                'icon' => $form['icon'] ?? null,
                'settings' => $this->jsonObject($settings),
                'theme' => $this->jsonObject($form['theme'] ?? []),
                'fields' => $this->packifyFieldReferences($form['fields'] ?? [], $realToPackKey),
            ];
            if (!empty($form['logicScript'])) {
                $entry['logicScript'] = $form['logicScript'];
            }
            if (!empty($form['customScreen'])) {
                $entry['customScreen'] = $form['customScreen'];
            }
            $packForms[] = $entry;
        }

        if (empty($packForms)) {
            throw new \RuntimeException('This app has no forms to export');
        }

        // Roles (for default-role name mapping + exporting custom roles).
        $roles = $this->appUserService->getRoles($appId);
        $roleNameById = [];
        foreach ($roles as $r) {
            $roleNameById[$r['id']] = $r['name'] ?? null;
        }

        // App settings: drop PII + remap instance ids to portable references.
        $appSettings = is_array($app['settings'] ?? null) ? $app['settings'] : [];
        unset($appSettings['notifications'], $appSettings['notificationEmail']);
        if (!empty($appSettings['defaultRoleId']) && isset($roleNameById[$appSettings['defaultRoleId']])) {
            $appSettings['defaultRoleName'] = $roleNameById[$appSettings['defaultRoleId']];
        }
        unset($appSettings['defaultRoleId']);
        $lp = $appSettings['landingPage'] ?? null;
        if (is_string($lp) && $lp !== '' && $lp !== 'dashboard') {
            $appSettings['landingPage'] = isset($realToPackKey[$lp]) ? '@pack:' . $realToPackKey[$lp] : 'dashboard';
        }

        // navConfig: remap each item.formId to @pack:<key>; drop items pointing outside the app.
        $navConfig = [];
        foreach ((is_array($app['navConfig'] ?? null) ? $app['navConfig'] : []) as $item) {
            $fid = $item['formId'] ?? null;
            if ($fid !== null && $fid !== '') {
                if (!isset($realToPackKey[$fid])) {
                    continue;
                }
                $item['formId'] = '@pack:' . $realToPackKey[$fid];
            }
            $navConfig[] = $item;
        }

        // Membership metadata.
        $packAppForms = [];
        foreach ($appForms as $af) {
            if (!isset($realToPackKey[$af['formId']])) {
                continue;
            }
            $packAppForms[] = [
                'packFormId' => $realToPackKey[$af['formId']],
                'displayName' => $af['displayName'] ?? null,
                'sortOrder' => $af['sortOrder'] ?? 0,
                'isVisible' => $af['isVisible'] ?? true,
                'settings' => $this->jsonObject($af['settings'] ?? []),
            ];
        }

        // Custom roles + non-Owner system roles (Admin/Member) so permission customizations round-trip.
        // Owner is skipped (recreated with all permissions; never an import-escalation path).
        $packRoles = [];
        foreach ($roles as $r) {
            if (!empty($r['isSystem']) && ($r['name'] ?? '') === 'Owner') {
                continue;
            }
            $perms = [];
            foreach ($r['permissions'] ?? [] as $p) {
                $fid = $p['formId'] ?? null;
                if ($fid !== null && $fid !== '') {
                    if (!isset($realToPackKey[$fid])) {
                        continue; // permission on a form outside the app
                    }
                    $perms[] = ['packFormId' => $realToPackKey[$fid], 'permission' => $p['permission']];
                } else {
                    $perms[] = ['packFormId' => null, 'permission' => $p['permission']];
                }
            }
            $packRoles[] = [
                'name' => $r['name'] ?? 'Role',
                'description' => $r['description'] ?? null,
                'system' => !empty($r['isSystem']),
                'permissions' => $perms,
            ];
        }

        $packApp = [
            'packAppId' => $this->slugify((string) ($app['name'] ?? 'app')),
            'name' => $app['name'] ?? 'App',
            'description' => $app['description'] ?? null,
            'logoUrl' => $app['logoUrl'] ?? null,
            'settings' => $this->jsonObject($appSettings),
            'theme' => $this->jsonObject($app['theme'] ?? []),
            'navConfig' => $navConfig,
            'forms' => $packAppForms,
            'roles' => $packRoles,
        ];
        if (!empty($app['customScreen'])) {
            $packApp['customScreen'] = $app['customScreen'];
        }

        $pack = [
            'formatVersion' => 1,
            'packMeta' => [
                'name' => $app['name'] ?? 'App',
                'description' => $app['description'] ?? '',
                'version' => '1.0.0',
                'tags' => [],
            ],
            'forms' => $packForms,
            'apps' => [$packApp],
        ];

        // Fail fast with a clear message if the app exceeds pack size caps.
        $this->validatePack($pack);

        return $pack;
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
            // Per-app size caps (mirror the form caps) — the app home screen ships executable HTML/CSS/JS.
            if (isset($app['customScreen'])) {
                $screenJson = json_encode($app['customScreen']);
                if ($screenJson !== false && strlen($screenJson) > 524288) {
                    throw new \RuntimeException("App '{$app['packAppId']}' custom screen exceeds 512KB limit");
                }
            }
            foreach (['navConfig' => 10240, 'settings' => 10240, 'theme' => 10240] as $key => $cap) {
                if (isset($app[$key])) {
                    $json = json_encode($app[$key]);
                    if ($json !== false && strlen($json) > $cap) {
                        throw new \RuntimeException("App '{$app['packAppId']}' {$key} exceeds " . ($cap / 1024) . "KB limit");
                    }
                }
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
     * Inverse of remapFieldReferences: rewrite a linked_record's real targetFormId to a portable
     * '@pack:<key>' reference. A reference to a form OUTSIDE the exported set is stripped (never leak a
     * foreign/internal UUID, and never emit a dangling import).
     */
    private function packifyFieldReferences(array $fields, array $realToPackKey): array
    {
        foreach ($fields as &$field) {
            if (($field['type'] ?? '') === 'linked_record') {
                $tid = $field['properties']['targetFormId'] ?? null;
                if (is_string($tid) && $tid !== '') {
                    if (isset($realToPackKey[$tid])) {
                        $field['properties']['targetFormId'] = '@pack:' . $realToPackKey[$tid];
                    } else {
                        unset($field['properties']['targetFormId']);
                    }
                }
            }
            // Empty properties should export as `{}`, not `[]`.
            if (array_key_exists('properties', $field)) {
                $field['properties'] = $this->jsonObject($field['properties']);
            }
        }
        unset($field);
        return $fields;
    }

    /**
     * Object-shaped fields (settings/theme/properties) must serialize as a JSON object, but an empty PHP
     * array encodes as `[]`. Force empty maps to a stdClass so they export as `{}` (cleaner for validators
     * / external AI / JSON Schema). Non-empty assoc arrays already encode as objects. Lists stay arrays.
     */
    private function jsonObject(mixed $v): mixed
    {
        return (is_array($v) && $v === []) ? new \stdClass() : $v;
    }

    /** Slugify a name into a pack key (lowercase, hyphenated, max 50 chars). */
    private function slugify(string $name): string
    {
        $slug = strtolower(trim($name));
        $slug = preg_replace('/[^a-z0-9]+/', '-', $slug) ?? '';
        $slug = trim($slug, '-');
        return $slug !== '' ? substr($slug, 0, 50) : 'form';
    }

    /** A slug unique within the exported pack (appends -2, -3, … on collision). */
    private function uniqueSlug(string $name, array &$used): string
    {
        $base = $this->slugify($name);
        $key = $base;
        $n = 2;
        while (isset($used[$key])) {
            $key = $base . '-' . $n;
            $n++;
        }
        $used[$key] = true;
        return $key;
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

<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use FormLogic\Helpers\CustomLogicSanitizer;
use FormLogic\Helpers\PackCapabilities;
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
                    'customScreen' => $this->resolveCustomScreen($packForm['customScreen'] ?? null, $formIdMap),
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
                    'customScreen' => $this->resolveCustomScreen($packApp['customScreen'] ?? null, $formIdMap),
                    // Sandboxed QuickJS app-logic bundle. References fields by their stable ids (not @pack:
                    // remapped) and is bounded by the client sandbox + permission model at runtime.
                    'customLogic' => is_array($packApp['customLogic'] ?? null) ? $packApp['customLogic'] : null,
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

                // 6. Pre-configured reports (charts + PDF documents): resolve @pack: refs → real form ids.
                if (!empty($packApp['reports']) && is_array($packApp['reports'])) {
                    $reports = $this->resolvePackReports($packApp['reports'], $formIdMap);
                    if ($reports) {
                        $this->appService->updateApp($appId, ['reports' => $reports]);
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
                $entry['customScreen'] = $this->packifyCustomScreen($form['customScreen'], $realToPackKey);
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
            $packApp['customScreen'] = $this->packifyCustomScreen($app['customScreen'], $realToPackKey);
        }
        // Custom app-logic round-trips verbatim: it references form fields by their stable string ids
        // (not @pack: refs), so there is nothing to remap.
        if (!empty($app['customLogic']) && is_array($app['customLogic'])) {
            $packApp['customLogic'] = $app['customLogic'];
        }
        // Reports (charts + PDF documents): rewrite real form ids → @pack: refs so they round-trip.
        if (!empty($app['reports']) && is_array($app['reports'])) {
            $packReports = $this->packifyReports($app['reports'], $realToPackKey);
            if ($packReports) {
                $packApp['reports'] = $packReports;
            }
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
     * Export an app as a full .formlogic ARCHIVE (spec §29): a ZIP bundling
     *   manifest.json  — the ApplicationPackageManifest (id/name/version/description + a content hash)
     *   pack.json      — the existing exportApp() payload (the atomic importer's source of truth)
     *   quickjs/customLogic.json — the app's sandboxed QuickJS bundle, if any
     *   assets/*       — inline data-URI assets decoded to real files, if any
     *   launch.json / native.json — launch + native runtime config, if present on the app
     *   signature.json — a DETACHED signature over the CANONICAL manifest.json (SigningService). The manifest
     *                    carries a sha256 of EVERY archive entry (manifest.entries), so the single detached
     *                    signature transitively covers pack.json AND every envelope file — a tampered
     *                    quickjs/launch/native/asset is detected on import even though it lives outside pack.json.
     * Returns the path to a temp .zip the caller must stream then delete.
     *
     * $signing is passed in (not a constructor dep) so the export/import surface stays additive over the
     * existing PackService wiring; when absent the archive is unsigned (importers treat it as community).
     */
    public function exportApplicationPackage(string $appId, string $userId, ?SigningService $signing = null): string
    {
        // Reuse the owner-checked, whitelisted, @pack:-remapped pack builder verbatim.
        $pack = $this->exportApp($appId, $userId);
        $app = $this->appService->getApp($appId) ?? [];
        $packApp = $pack['apps'][0] ?? [];

        $name = (string) ($pack['packMeta']['name'] ?? 'App');
        $version = (string) ($pack['packMeta']['version'] ?? '1.0.0');
        $slug = $this->slugify((string) ($packApp['packAppId'] ?? $name));

        // Canonical pack JSON (unescaped slashes) — hashed into the manifest and covered by the signed manifest.
        $packJson = (string) json_encode($pack, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);

        // Collect EVERY archive entry (name => bytes) the importer may consume, so the manifest can carry a
        // sha256 of each and the detached signature (over the manifest) transitively covers all of them. This
        // closes the gap where a signature over pack.json alone left the envelope files (quickjs/launch/native/
        // assets) tamperable inside an otherwise "signed" ZIP.
        $entries = ['pack.json' => $packJson];

        // quickjs/ — the sandboxed app-logic bundle (also embedded in pack.json for the atomic import;
        // surfaced here as a discrete file for external tooling / capability review).
        if (!empty($packApp['customLogic']) && is_array($packApp['customLogic'])) {
            $entries['quickjs/customLogic.json'] = (string) json_encode($packApp['customLogic'], JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
        }

        // launch.json / native.json — only if the app record carries them (per-domain configs live
        // elsewhere; these are future-proofed and simply omitted when absent).
        if (is_array($app['launch'] ?? null) && !empty($app['launch'])) {
            $entries['launch.json'] = (string) json_encode($app['launch'], JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
        }
        if (is_array($app['native'] ?? null) && !empty($app['native'])) {
            $entries['native.json'] = (string) json_encode($app['native'], JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
        }

        // assets/ — decode any inline data-URI assets to real files under a safe key.
        foreach ((is_array($app['assets'] ?? null) ? $app['assets'] : []) as $key => $dataUri) {
            if (!is_string($key) || !is_string($dataUri) || !PackFileService::isSafeZipEntryName('assets/' . $key)) {
                continue;
            }
            $decoded = $this->decodeDataUri($dataUri);
            if ($decoded !== null && strlen($decoded) <= PackFileService::MAX_ASSET_BYTES) {
                $entries['assets/' . $key] = $decoded;
            }
        }

        // Per-entry content hashes: the SIGNED manifest binds each archive entry, so a tampered envelope
        // file is detected on import (its recomputed sha256 will not match the signed hash).
        $entryHashes = [];
        foreach ($entries as $entryName => $bytes) {
            $entryHashes[$entryName] = hash('sha256', $bytes);
        }
        $contentHash = 'sha256:' . $entryHashes['pack.json'];

        $manifest = [
            'version' => 1,
            'kind' => 'formlogic.applicationPackage',
            'id' => $slug,
            'name' => $name,
            'description' => (string) ($pack['packMeta']['description'] ?? ''),
            'packVersion' => $version,
            'contentHash' => $contentHash,
            // Signed per-entry manifest (Option A): { "pack.json": "<sha256hex>", ... } for every entry above.
            'entries' => $entryHashes,
            'capabilities' => PackCapabilities::describe($pack),
        ];

        $zipPath = (string) tempnam(sys_get_temp_dir(), 'flapp_');
        $zip = new \ZipArchive();
        if ($zip->open($zipPath, \ZipArchive::CREATE | \ZipArchive::OVERWRITE) !== true) {
            @unlink($zipPath);
            throw new \RuntimeException('Failed to create application package archive');
        }

        $zip->addFromString('manifest.json', (string) json_encode($manifest, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT));
        foreach ($entries as $entryName => $bytes) {
            $zip->addFromString($entryName, $bytes);
        }

        // Detached signature over the CANONICAL manifest (which binds every entry via its sha256). A verifier
        // can therefore trust manifest.entries and, through it, every file the importer consumes.
        if ($signing !== null) {
            $signed = $signing->sign($manifest);
            $zip->addFromString('signature.json', (string) json_encode([
                'signature' => $signed['signature'],
                'alg' => $signed['alg'],
                'keyId' => $signed['keyId'],
                'contentHash' => $contentHash,
            ], JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT));
        }

        $zip->close();
        return $zipPath;
    }

    /**
     * Import a .formlogic ARCHIVE (the inverse of exportApplicationPackage). Opens the ZIP, validates
     * EVERY entry with the shared PackFileService zip-slip + zip-bomb guard, then — when signature.json is
     * present — verifies the detached signature over the CANONICAL manifest.json and enforces the manifest's
     * per-entry sha256 hashes for pack.json AND every envelope file the importer will consume (quickjs/
     * customLogic.json, launch.json, native.json, assets/*). A tampered file, or an applicable envelope file
     * that is PRESENT but NOT listed in the signed manifest (an unsigned extra), is rejected. Only after the
     * covered entries verify does it delegate to the ATOMIC importPack() (remapping / rollback / quota
     * unchanged) and apply the (now signature-covered) envelope metadata.
     *
     * @return array importPack() result plus 'trust' (official|local-only|community).
     */
    public function importApplicationPackage(
        string $zipPath,
        string $userId,
        ?SigningService $signing = null,
        ?string $catalogId = null,
        ?string $versionId = null
    ): array {
        $zip = new \ZipArchive();
        if ($zip->open($zipPath) !== true) {
            throw new \RuntimeException('Failed to open the application package');
        }

        try {
            // 1. Zip-slip + zip-bomb guard over every entry BEFORE reading anything out.
            PackFileService::assertSafeArchive($zip);

            // 2. pack.json is the atomic importer's source of truth (required).
            $packJson = $zip->getFromName('pack.json');
            if ($packJson === false) {
                throw new \RuntimeException('Application package is missing pack.json');
            }
            $pack = json_decode($packJson, true, 128);
            if (!is_array($pack)) {
                throw new \RuntimeException('pack.json is not valid JSON');
            }

            // 3. Detached signature over the CANONICAL manifest.json (which binds every entry via a per-entry
            //    sha256). When present it MUST verify; then each entry the importer consumes must match its
            //    signed hash — so a tampered envelope file (quickjs/launch/native/asset) is rejected even
            //    though it lives outside pack.json. $signatureCovers stays null for an unsigned (community)
            //    archive, and is the covered-entry set for a signed one (drives the "unsigned extra" check).
            $trust = 'community';
            $signatureCovers = null;
            $sigRaw = $zip->getFromName('signature.json');
            if ($sigRaw !== false) {
                $sig = json_decode($sigRaw, true);
                if (!is_array($sig) || !isset($sig['signature'], $sig['alg'])) {
                    throw new \RuntimeException('signature.json is malformed');
                }

                $manifestRaw = $zip->getFromName('manifest.json');
                $manifest = is_string($manifestRaw) ? json_decode($manifestRaw, true) : null;
                if (!is_array($manifest)) {
                    throw new \RuntimeException('Application package signature verification failed: manifest.json is missing or invalid');
                }

                $ok = $signing !== null && $signing->verify([
                    'payload' => $manifest,
                    'signature' => (string) $sig['signature'],
                    'alg' => (string) $sig['alg'],
                ]);
                if (!$ok) {
                    throw new \RuntimeException('Application package signature verification failed');
                }
                // Only reached when the signature verified: Ed25519 => official, HS256 => local-only.
                // Same classifier as describe + the JSON import path (single source of truth).
                $trust = self::classifyTrust(true, true, (string) $sig['alg']);

                // The signed manifest carries a sha256 of every covered entry. Enforce it for pack.json AND
                // every envelope file — recompute + require an exact match; reject any mismatch (tamper).
                $entryHashes = is_array($manifest['entries'] ?? null) ? $manifest['entries'] : [];
                if (empty($entryHashes) || !isset($entryHashes['pack.json'])) {
                    throw new \RuntimeException('Application package signature verification failed: the signed manifest does not cover pack.json');
                }
                $signatureCovers = $this->verifyEntryHashes($zip, $entryHashes);
            }

            // 4. Envelope metadata that lives OUTSIDE pack.json (discrete archive entries). Read it INSIDE
            //    the zip-slip-guarded block so every entry name was already validated by assertSafeArchive.
            //    For a signed archive, only entries covered by the verified manifest are honored — a present-
            //    but-unlisted applicable file is an unsigned extra and is rejected.
            $envelope = $this->readArchiveEnvelope($zip, $signatureCovers);
        } finally {
            $zip->close();
        }

        // Workspace policy (pre-commit): reject an unverified/community archive BEFORE the atomic import, so
        // a failed policy check never leaves a committed import behind. Positively-verified (signed) only.
        if ((($_ENV['REQUIRE_VERIFIED_PACKAGES'] ?? getenv('REQUIRE_VERIFIED_PACKAGES')) === 'true')
            && !in_array($trust, ['official', 'local-only'], true)) {
            throw new \RuntimeException('This workspace only allows verified (signed) application packages.');
        }

        // 5. Delegate to the existing atomic importer (customLogic embedded in pack.json is applied there).
        $result = $this->importPack($pack, $userId, $catalogId, $versionId);
        $result['trust'] = $trust;

        // 6. Apply the envelope metadata (quickjs/customLogic.json, launch.json, native.json, assets/logo)
        //    to the created app(s); anything without a runtime target comes back as a warning.
        $warnings = $this->applyPackageMetadata($envelope, $result['apps'], $userId);
        if (!empty($warnings)) {
            $result['warnings'] = $warnings;
        }
        return $result;
    }

    /**
     * Read an application-package archive's ENVELOPE metadata (the parts that live OUTSIDE pack.json):
     * quickjs/customLogic.json, launch.json, native.json, and assets/* (a logo asset is decoded to a
     * data: URI; other assets are noted so the caller can warn). Every entry name was already validated
     * by PackFileService::assertSafeArchive before this runs, so reads here are within the zip-slip guard.
     *
     * @param array<string,bool>|null $signatureCovers For a SIGNED archive, the set of entry names the
     *        verified manifest covers (from verifyEntryHashes). An applicable envelope/asset file that is
     *        PRESENT but NOT in this set is an unsigned extra (tamper) and is rejected. null => unsigned
     *        (community) archive, so no coverage constraint applies.
     * @return array{customLogic?:array, launch?:array, native?:array, logo?:string, assets?:array<string,bool>}
     */
    private function readArchiveEnvelope(\ZipArchive $zip, ?array $signatureCovers = null): array
    {
        $signed = $signatureCovers !== null;
        $envelope = [];
        foreach (['customLogic' => 'quickjs/customLogic.json', 'launch' => 'launch.json', 'native' => 'native.json'] as $key => $entry) {
            $raw = $zip->getFromName($entry);
            if ($raw === false) {
                continue;
            }
            // A signed archive may only carry envelope files hashed into the verified manifest; an
            // unlisted-but-present applicable file is an unsigned extra injected into a signed ZIP.
            if ($signed && !isset($signatureCovers[$entry])) {
                throw new \RuntimeException('Application package signature verification failed: unsigned "' . $entry . '" not covered by the signed manifest');
            }
            $decoded = json_decode($raw, true);
            if (is_array($decoded) && !empty($decoded)) {
                $envelope[$key] = $decoded;
            }
        }

        // assets/* — surface a logo asset as a data: URI (the only asset with a storage target today);
        // record the presence of any other asset so the caller can warn (no storage target for those yet).
        $assets = [];
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $name = $zip->getNameIndex($i);
            if (!is_string($name) || !str_starts_with($name, 'assets/') || !PackFileService::isSafeZipEntryName($name)) {
                continue;
            }
            $assetKey = substr($name, strlen('assets/'));
            if ($assetKey === '') {
                continue;
            }
            // An asset present in a signed archive but not covered by the verified manifest is an unsigned
            // extra — reject rather than consume it (matches the envelope-file rule above).
            if ($signed && !isset($signatureCovers[$name])) {
                throw new \RuntimeException('Application package signature verification failed: unsigned asset "' . $name . '" not covered by the signed manifest');
            }
            $assets[$assetKey] = true;
            if (!isset($envelope['logo']) && preg_match('/^logo\.(png|jpe?g|gif|webp|svg)$/i', $assetKey, $m)) {
                $raw = $zip->getFromName($name);
                if (is_string($raw) && $raw !== '' && strlen($raw) <= PackFileService::MAX_ASSET_BYTES) {
                    $mime = strtolower($m[1]);
                    $mime = $mime === 'svg' ? 'image/svg+xml' : ($mime === 'jpg' ? 'image/jpeg' : 'image/' . $mime);
                    $envelope['logo'] = 'data:' . $mime . ';base64,' . base64_encode($raw);
                }
            }
        }
        if (!empty($assets)) {
            $envelope['assets'] = $assets;
        }
        return $envelope;
    }

    /**
     * Enforce a SIGNED manifest's per-entry sha256 hashes. For every entry the manifest claims to cover,
     * recompute the archive member's sha256 and require an exact match; reject on any mismatch (a tampered
     * file) or a covered entry that is missing from the archive. The manifest itself was already verified
     * by the detached signature, so its hashes are trusted — this binds every consumed file to that
     * signature. Returns the covered-entry set (name => true) so readArchiveEnvelope can reject any
     * applicable envelope/asset file that is present but NOT covered (an unsigned extra).
     *
     * @param array<string,mixed> $entryHashes manifest.entries { entryName => sha256hex }
     * @return array<string,bool> covered entry names
     */
    private function verifyEntryHashes(\ZipArchive $zip, array $entryHashes): array
    {
        $covered = [];
        foreach ($entryHashes as $entryName => $expected) {
            if (!is_string($entryName) || $entryName === '' || !is_string($expected) || $expected === '') {
                throw new \RuntimeException('Application package signature verification failed: the signed manifest has a malformed entry hash');
            }
            // Defense in depth: a covered name must itself be a safe zip path (assertSafeArchive validated the
            // ARCHIVE's own entry names, but manifest.entries is attacker-influenced input parsed separately).
            if (!PackFileService::isSafeZipEntryName($entryName)) {
                throw new \RuntimeException('Application package signature verification failed: the signed manifest lists an unsafe entry name');
            }
            $bytes = $zip->getFromName($entryName);
            if ($bytes === false) {
                throw new \RuntimeException('Application package signature verification failed: covered entry "' . $entryName . '" is missing from the archive');
            }
            if (!hash_equals(strtolower($expected), hash('sha256', $bytes))) {
                throw new \RuntimeException('Application package signature verification failed: entry "' . $entryName . '" does not match its signed hash');
            }
            $covered[$entryName] = true;
        }
        return $covered;
    }

    /**
     * Classify import / marketplace TRUST from a signature outcome. Single source of truth shared by
     * PackController::describe(), the JSON import path, and importApplicationPackage() so they cannot
     * diverge: an Ed25519 signature that verifies is publicly / native-verifiable ('official'); a
     * verifying HS256 fallback only re-checks on THIS same server ('local-only'); a present-but-failing
     * signature is 'unverified'; no signature at all is 'community'.
     */
    public static function classifyTrust(bool $hasSignature, bool $verified, string $alg): string
    {
        if (!$hasSignature) {
            return 'community';
        }
        if (!$verified) {
            return 'unverified';
        }
        return $alg === 'Ed25519' ? 'official' : 'local-only';
    }

    /**
     * Apply an application package's ENVELOPE-level metadata — the parts that live OUTSIDE pack.json — to
     * the app(s) importPack() just created. Only metadata with a runtime target today is persisted; the
     * rest is returned as human-readable warnings so nothing is silently dropped:
     *   - customLogic  → sanitized (CustomLogicSanitizer) + saved to apps.custom_logic (fills only when the
     *                    created app carries none, so pack.json-embedded logic is never clobbered).
     *   - logo/logoUrl → saved to apps.logo_url when the app has none (data: URIs are size-guarded).
     *   - launch/native→ no app-level target yet (they live per-domain on app_domains) → WARNING.
     *   - other assets → no storage target yet → WARNING.
     * For the ZIP path the envelope is now genuinely signature-covered (each entry's sha256 is bound by the
     * signed manifest and hash-checked in importApplicationPackage); for the JSON path the envelope is part of
     * the one signed `package` object. Either way it is still sanitized/guarded defensively here (never trust
     * asset paths or oversized logic).
     *
     * @param array $envelope The signed envelope (bare Pack => no envelope keys => no-op) or ApplicationPackage.
     * @param array $apps      importPack() result 'apps' ([{id,name}, ...]).
     * @param string $userId   Owner of every app importPack() created.
     * @return string[]        Warnings for metadata that has no runtime target (empty when all applied).
     */
    public function applyPackageMetadata(array $envelope, array $apps, string $userId): array
    {
        $warnings = [];

        // customLogic living outside pack.json — sanitize to the known-safe shape + size before storing.
        $customLogic = null;
        if (is_array($envelope['customLogic'] ?? null) && !empty($envelope['customLogic'])) {
            $sanitized = CustomLogicSanitizer::sanitize($envelope['customLogic']);
            if (!empty($sanitized['scripts']) && CustomLogicSanitizer::withinSizeCap($sanitized)) {
                $customLogic = $sanitized;
            } else {
                $warnings[] = 'Package-level custom logic was empty or over the size cap and was not applied.';
            }
        }

        // A logo asset (data: URI or http(s) URL) maps to logo_url — the only asset with a storage target.
        $logoUrl = null;
        $logo = null;
        foreach (['logo', 'logoUrl'] as $lk) {
            if (is_string($envelope[$lk] ?? null) && $envelope[$lk] !== '') {
                $logo = $envelope[$lk];
                break;
            }
        }
        if ($logo !== null) {
            if (str_starts_with($logo, 'data:')) {
                $decoded = $this->decodeDataUri($logo);
                if ($decoded !== null && strlen($decoded) <= PackFileService::MAX_ASSET_BYTES) {
                    $logoUrl = $logo;
                } else {
                    $warnings[] = 'Package logo asset was invalid or over the size cap and was not applied.';
                }
            } elseif (preg_match('#^https?://#i', $logo)) {
                $logoUrl = $logo;
            } else {
                $warnings[] = 'Package logo reference was not a data: URI or http(s) URL and was not applied.';
            }
        }

        $appliedToApp = false;
        foreach ($apps as $a) {
            $appId = is_array($a) ? ($a['id'] ?? null) : null;
            if (!is_string($appId) || $appId === '') {
                continue;
            }
            try {
                // Owner check: only mutate an app the importer owns (importPack just created these under $userId).
                $app = $this->appService->getApp($appId);
                if (!$app || ($app['ownerId'] ?? null) !== $userId) {
                    continue;
                }
                $update = [];
                if ($customLogic !== null && empty($app['customLogic'])) {
                    $update['customLogic'] = $customLogic;
                }
                if ($logoUrl !== null && empty($app['logoUrl'])) {
                    $update['logoUrl'] = $logoUrl;
                }
                if (!empty($update)) {
                    $this->appService->updateApp($appId, $update);
                    $appliedToApp = true;
                }
            } catch (\Throwable $e) {
                // The forms/apps are already committed by importPack (this runs post-commit, outside its
                // transaction), so a metadata-apply failure must NOT surface as an import failure — that
                // would make the user retry and duplicate everything. Warn and move on.
                $warnings[] = 'App imported, but applying package metadata (logo / custom logic) failed — reconfigure it in app settings.';
            }
        }
        if (($customLogic !== null || $logoUrl !== null) && !$appliedToApp) {
            $warnings[] = 'Package metadata could not be attached: the package created no owned app to apply it to.';
        }

        // launch / native have no app-level runtime target today (they are configured per custom domain
        // on app_domains, which an import does not create). Surface rather than drop.
        if (!empty($envelope['launch'])) {
            $warnings[] = 'Package launch defaults were received but have no app-level target yet; configure them per custom domain after install.';
        }
        if (!empty($envelope['native'])) {
            $warnings[] = 'Package native defaults were received but have no app-level target yet; configure them per custom domain after install.';
        }

        // Non-logo assets have no storage target today.
        $extraAssets = array_values(array_filter(
            array_keys(is_array($envelope['assets'] ?? null) ? $envelope['assets'] : []),
            static fn ($k) => !preg_match('/^logo\.(png|jpe?g|gif|webp|svg)$/i', (string) $k)
        ));
        if (!empty($extraAssets)) {
            $warnings[] = 'Package assets (' . implode(', ', array_map('strval', $extraAssets)) . ') have no storage target and were not imported.';
        }

        return $warnings;
    }

    /** Decode a data: URI to raw bytes; returns null if it is not a well-formed base64 data URI. */
    private function decodeDataUri(string $uri): ?string
    {
        if (!preg_match('#^data:[^,]*;base64,(.*)$#s', $uri, $m)) {
            return null;
        }
        $decoded = base64_decode($m[1], true);
        return $decoded === false ? null : $decoded;
    }

    /**
     * Publish an app the user owns (used by the sample-app install so it opens running immediately).
     * Ordinary pack import stays draft; only the explicit "Try a sample" flow publishes.
     */
    public function publishApp(string $appId, string $userId): void
    {
        $app = $this->appService->getApp($appId);
        if ($app && ($app['ownerId'] ?? null) === $userId) {
            $this->appService->updateApp($appId, ['status' => 'published']);
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
            // Per-app size caps (mirror the form caps) — the app home screen ships executable HTML/CSS/JS.
            if (isset($app['customScreen'])) {
                $screenJson = json_encode($app['customScreen']);
                if ($screenJson !== false && strlen($screenJson) > 524288) {
                    throw new \RuntimeException("App '{$app['packAppId']}' custom screen exceeds 512KB limit");
                }
            }
            // Custom app-logic is code (sandboxed at runtime); cap at 100KB like a form's logic script.
            if (isset($app['customLogic'])) {
                $logicJson = json_encode($app['customLogic']);
                if ($logicJson !== false && strlen($logicJson) > 102400) {
                    throw new \RuntimeException("App '{$app['packAppId']}' custom logic exceeds 100KB limit");
                }
            }
            foreach (['navConfig' => 10240, 'settings' => 10240, 'theme' => 10240, 'reports' => 262144] as $key => $cap) {
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
     * Resolve a pack's report items (charts + PDF documents) into installable `apps.reports` items,
     * rewriting every `@pack:<packFormId>` reference to the real form id via $formIdMap. A report whose
     * form/join/field ref can't be resolved is dropped (never emit a broken spec). Document blocks that
     * reference a dropped/unknown chart are dropped; a document left with no blocks is dropped.
     *
     * @param array         $packReports PackReportItem[] (each: { reportId, kind, name, description?, spec?|blocks? })
     * @param array<string,string> $formIdMap packFormId => real form id
     * @param callable|null $idFor  optional (packReportId) => stable item id; defaults to a fresh UUID
     * @return array AppReportItem[] ready to persist to apps.reports
     */
    public function resolvePackReports(array $packReports, array $formIdMap, ?callable $idFor = null): array
    {
        $idFor ??= fn (string $rid) => $this->generateUuid();

        // Pack-local reportId => resolved item id (so document blocks can point at the right chart).
        $itemIdByPackId = [];
        foreach ($packReports as $r) {
            if (!empty($r['reportId'])) {
                $itemIdByPackId[$r['reportId']] = $idFor((string) $r['reportId']);
            }
        }

        // "@pack:key" => real form id (null if unknown).
        $resolveForm = static function (mixed $ref) use ($formIdMap): ?string {
            if (!is_string($ref) || !str_starts_with($ref, '@pack:')) { return null; }
            return $formIdMap[substr($ref, 6)] ?? null;
        };
        // Field ref: "@pack:key::field" => "realId::field"; bare "field"/"__pseudo" unchanged; unknown => null.
        $resolveFieldRef = static function (mixed $ref) use ($formIdMap): ?string {
            if (!is_string($ref) || $ref === '') { return null; }
            if (!str_contains($ref, '::')) { return $ref; }
            [$fp, $fid] = explode('::', $ref, 2);
            if (!str_starts_with($fp, '@pack:')) { return null; }
            $id = $formIdMap[substr($fp, 6)] ?? null;
            return $id !== null ? $id . '::' . $fid : null;
        };

        $out = [];
        foreach ($packReports as $r) {
            $id = $itemIdByPackId[$r['reportId'] ?? ''] ?? null;
            if ($id === null) { continue; }
            $kind = $r['kind'] ?? 'chart';

            if ($kind === 'document') {
                $blocks = [];
                foreach ($r['blocks'] ?? [] as $b) {
                    $bk = $b['kind'] ?? '';
                    if ($bk === 'text') {
                        $blocks[] = ['id' => $this->generateUuid(), 'kind' => 'text', 'title' => $b['title'] ?? null, 'body' => (string) ($b['body'] ?? '')];
                    } elseif ($bk === 'report') {
                        $rid = $itemIdByPackId[$b['reportId'] ?? ''] ?? null;
                        if ($rid !== null) {
                            $blocks[] = ['id' => $this->generateUuid(), 'kind' => 'report', 'reportId' => $rid, 'caption' => $b['caption'] ?? null];
                        }
                    }
                }
                if ($blocks) {
                    $out[] = ['id' => $id, 'name' => $r['name'] ?? 'Document', 'description' => $r['description'] ?? null, 'type' => 'document', 'blocks' => $blocks];
                }
                continue;
            }

            // chart
            $spec = is_array($r['spec'] ?? null) ? $r['spec'] : null;
            if (!$spec) { continue; }
            $base = $resolveForm($spec['formId'] ?? null);
            if ($base === null) { continue; }
            $ns = ['formId' => $base, 'viz' => in_array($spec['viz'] ?? '', ['table', 'bar', 'line', 'area', 'pie', 'donut', 'kpi'], true) ? $spec['viz'] : 'bar'];

            $ok = true;
            if (!empty($spec['joins'])) {
                $joins = [];
                foreach ($spec['joins'] as $j) {
                    $jf = $resolveForm($j['formId'] ?? null);
                    if ($jf === null) { $ok = false; break; }
                    $joins[] = ['via' => (string) ($j['via'] ?? ''), 'formId' => $jf, 'type' => ($j['type'] ?? 'left') === 'inner' ? 'inner' : 'left'];
                }
                if (!$ok) { continue; }
                $ns['joins'] = $joins;
            }
            if (!empty($spec['groupBy']['field'])) {
                $gf = $resolveFieldRef($spec['groupBy']['field']);
                if ($gf === null) { continue; }
                $ns['groupBy'] = ['field' => $gf];
                if (!empty($spec['groupBy']['bucket'])) { $ns['groupBy']['bucket'] = $spec['groupBy']['bucket']; }
            }
            if (!empty($spec['measure'])) {
                $m = $spec['measure'];
                if (isset($m['field'])) {
                    $mf = $resolveFieldRef($m['field']);
                    if ($mf === null) { continue; }
                    $m['field'] = $mf;
                }
                $ns['measure'] = $m;
            }
            if (!empty($spec['filters'])) {
                $filters = [];
                foreach ($spec['filters'] as $f) {
                    $ff = $resolveFieldRef($f['field'] ?? null);
                    if ($ff === null) { continue; }
                    $filters[] = ['field' => $ff, 'op' => (string) ($f['op'] ?? 'eq'), 'value' => (string) ($f['value'] ?? '')];
                }
                if ($filters) { $ns['filters'] = $filters; }
            }
            if (!empty($spec['columns'])) {
                $cols = [];
                foreach ($spec['columns'] as $c) {
                    $cf = $resolveFieldRef($c);
                    if ($cf !== null) { $cols[] = $cf; }
                }
                if ($cols) { $ns['columns'] = $cols; }
            }
            if (!empty($spec['seriesSort'])) { $ns['seriesSort'] = $spec['seriesSort']; }
            if (isset($spec['sort'])) {
                if (is_string($spec['sort'])) {
                    $ns['sort'] = $spec['sort'];
                } elseif (is_array($spec['sort']) && isset($spec['sort']['by'])) {
                    $sb = $resolveFieldRef($spec['sort']['by']);
                    if ($sb !== null) { $ns['sort'] = ['by' => $sb, 'dir' => ($spec['sort']['dir'] ?? 'asc') === 'desc' ? 'desc' : 'asc']; }
                }
            }
            if (!empty($spec['having']) && is_array($spec['having']) && isset($spec['having']['op'])) {
                $ns['having'] = ['op' => (string) $spec['having']['op'], 'value' => $spec['having']['value'] ?? 0];
            }
            if (isset($spec['limit'])) { $ns['limit'] = (int) $spec['limit']; }

            $out[] = ['id' => $id, 'name' => $r['name'] ?? 'Report', 'description' => $r['description'] ?? null, 'type' => 'builder', 'spec' => $ns];
        }
        return $out;
    }

    /**
     * Resolve @pack: refs in ONE report/widget spec → real ids. Returns null if the base form (or a
     * declared join / required field ref) can't be resolved. Mirrors the chart branch of
     * resolvePackReports so widget-dashboard specs remap identically.
     */
    private function resolveSpecRefs(array $spec, callable $resolveForm, callable $resolveFieldRef): ?array
    {
        $base = $resolveForm($spec['formId'] ?? null);
        if ($base === null) { return null; }
        $ns = ['formId' => $base, 'viz' => in_array($spec['viz'] ?? '', ['table', 'bar', 'line', 'area', 'pie', 'donut', 'kpi'], true) ? $spec['viz'] : 'bar'];
        if (!empty($spec['joins'])) {
            $joins = [];
            foreach ($spec['joins'] as $j) {
                $jf = $resolveForm($j['formId'] ?? null);
                if ($jf === null) { return null; }
                $joins[] = ['via' => (string) ($j['via'] ?? ''), 'formId' => $jf, 'type' => ($j['type'] ?? 'left') === 'inner' ? 'inner' : 'left'];
            }
            $ns['joins'] = $joins;
        }
        if (!empty($spec['groupBy']['field'])) {
            $gf = $resolveFieldRef($spec['groupBy']['field']);
            if ($gf === null) { return null; }
            $ns['groupBy'] = ['field' => $gf];
            if (!empty($spec['groupBy']['bucket'])) { $ns['groupBy']['bucket'] = $spec['groupBy']['bucket']; }
        }
        if (!empty($spec['measure'])) {
            $m = $spec['measure'];
            if (isset($m['field'])) { $mf = $resolveFieldRef($m['field']); if ($mf === null) { return null; } $m['field'] = $mf; }
            $ns['measure'] = $m;
        }
        if (!empty($spec['filters'])) {
            $filters = [];
            foreach ($spec['filters'] as $f) {
                $ff = $resolveFieldRef($f['field'] ?? null);
                if ($ff === null) { continue; }
                $filters[] = ['field' => $ff, 'op' => (string) ($f['op'] ?? 'eq'), 'value' => (string) ($f['value'] ?? '')];
            }
            if ($filters) { $ns['filters'] = $filters; }
        }
        if (!empty($spec['columns'])) {
            $cols = [];
            foreach ($spec['columns'] as $c) { $cf = $resolveFieldRef($c); if ($cf !== null) { $cols[] = $cf; } }
            if ($cols) { $ns['columns'] = $cols; }
        }
        if (!empty($spec['seriesSort'])) { $ns['seriesSort'] = $spec['seriesSort']; }
        if (isset($spec['sort'])) {
            if (is_string($spec['sort'])) { $ns['sort'] = $spec['sort']; }
            elseif (is_array($spec['sort']) && isset($spec['sort']['by'])) {
                $sb = $resolveFieldRef($spec['sort']['by']);
                if ($sb !== null) { $ns['sort'] = ['by' => $sb, 'dir' => ($spec['sort']['dir'] ?? 'asc') === 'desc' ? 'desc' : 'asc']; }
            }
        }
        if (!empty($spec['having']) && is_array($spec['having']) && isset($spec['having']['op'])) {
            $ns['having'] = ['op' => (string) $spec['having']['op'], 'value' => $spec['having']['value'] ?? 0];
        }
        if (isset($spec['limit'])) { $ns['limit'] = (int) $spec['limit']; }
        return $ns;
    }

    /** Resolve @pack: refs inside a widget-dashboard config → real ids (install/refresh side). */
    public function resolvePackDashboard(array $dashboard, array $formIdMap): array
    {
        $resolveForm = static function (mixed $ref) use ($formIdMap): ?string {
            if (!is_string($ref) || $ref === '') { return null; }
            if (str_starts_with($ref, '@pack:')) { return $formIdMap[substr($ref, 6)] ?? null; }
            return $ref; // already a real id (defensive)
        };
        $resolveFieldRef = static function (mixed $ref) use ($formIdMap): ?string {
            if (!is_string($ref) || $ref === '') { return null; }
            if (!str_contains($ref, '::')) { return $ref; }
            [$fp, $fid] = explode('::', $ref, 2);
            if (!str_starts_with($fp, '@pack:')) { return $ref; }
            $id = $formIdMap[substr($fp, 6)] ?? null;
            return $id !== null ? $id . '::' . $fid : null;
        };
        $widgets = [];
        foreach ($dashboard['widgets'] ?? [] as $w) {
            if (!is_array($w)) { continue; }
            $kind = $w['kind'] ?? '';
            if ($kind === 'report' && is_array($w['spec'] ?? null)) {
                $ns = $this->resolveSpecRefs($w['spec'], $resolveForm, $resolveFieldRef);
                if ($ns === null) { continue; }
                $w['spec'] = $ns;
            } elseif ($kind === 'list' && is_array($w['list'] ?? null)) {
                $lf = $resolveForm($w['list']['formId'] ?? null);
                if ($lf === null) { continue; }
                $w['list']['formId'] = $lf;
            }
            $widgets[] = $w;
        }
        return ['version' => 1, 'cols' => (int) ($dashboard['cols'] ?? 12), 'widgets' => array_values($widgets)];
    }

    /** Resolve @pack: refs in a customScreen (only widget dashboards carry them). */
    private function resolveCustomScreen(?array $cs, array $formIdMap): ?array
    {
        if (empty($cs)) { return null; }
        if (($cs['kind'] ?? '') === 'dashboard' && is_array($cs['dashboard'] ?? null)) {
            $cs['dashboard'] = $this->resolvePackDashboard($cs['dashboard'], $formIdMap);
        }
        return $cs;
    }

    /** Inverse of resolvePackDashboard: rewrite real form ids in a dashboard → @pack: refs for export. */
    private function packifyDashboard(array $dashboard, array $realToPackKey): array
    {
        $packForm = static function (mixed $ref) use ($realToPackKey): ?string {
            if (!is_string($ref) || $ref === '') { return null; }
            if (str_starts_with($ref, '@pack:')) { return $ref; }
            return isset($realToPackKey[$ref]) ? '@pack:' . $realToPackKey[$ref] : null;
        };
        $packFieldRef = static function (mixed $ref) use ($realToPackKey): ?string {
            if (!is_string($ref) || $ref === '') { return null; }
            if (!str_contains($ref, '::')) { return $ref; }
            [$f0, $fid] = explode('::', $ref, 2);
            if (str_starts_with($f0, '@pack:')) { return $ref; }
            return isset($realToPackKey[$f0]) ? '@pack:' . $realToPackKey[$f0] . '::' . $fid : null;
        };
        $widgets = [];
        foreach ($dashboard['widgets'] ?? [] as $w) {
            if (!is_array($w)) { continue; }
            $kind = $w['kind'] ?? '';
            if ($kind === 'report' && is_array($w['spec'] ?? null)) {
                $ns = $this->resolveSpecRefs($w['spec'], $packForm, $packFieldRef);
                if ($ns === null) { continue; } // form outside the exported app → drop (never leak a UUID)
                $w['spec'] = $ns;
            } elseif ($kind === 'list' && is_array($w['list'] ?? null)) {
                $lf = $packForm($w['list']['formId'] ?? null);
                if ($lf === null) { continue; }
                $w['list']['formId'] = $lf;
            }
            $widgets[] = $w;
        }
        return ['version' => 1, 'cols' => (int) ($dashboard['cols'] ?? 12), 'widgets' => array_values($widgets)];
    }

    /** Packify a customScreen for export (only widget dashboards carry form refs to rewrite). */
    private function packifyCustomScreen(?array $cs, array $realToPackKey): ?array
    {
        if (empty($cs)) { return null; }
        if (($cs['kind'] ?? '') === 'dashboard' && is_array($cs['dashboard'] ?? null)) {
            $cs['dashboard'] = $this->packifyDashboard($cs['dashboard'], $realToPackKey);
        }
        return $cs;
    }

    /**
     * Inverse of resolvePackReports: rewrite a saved app's reports (apps.reports) into portable pack report
     * items, mapping real form ids back to `@pack:<key>`. A report referencing a form OUTSIDE the exported
     * app is dropped (never leak a foreign UUID / emit a dangling import).
     *
     * @param array $reports AppReportItem[] from apps.reports
     * @param array<string,string> $realToPackKey real form id => packFormId (slug)
     * @return array PackReportItem[]
     */
    private function packifyReports(array $reports, array $realToPackKey): array
    {
        $packForm = static function (mixed $ref) use ($realToPackKey): ?string {
            if (!is_string($ref)) { return null; }
            return isset($realToPackKey[$ref]) ? '@pack:' . $realToPackKey[$ref] : null;
        };
        $packFieldRef = static function (mixed $ref) use ($realToPackKey): ?string {
            if (!is_string($ref) || $ref === '') { return null; }
            if (!str_contains($ref, '::')) { return $ref; } // base field / pseudo-field
            [$fid0, $fid] = explode('::', $ref, 2);
            return isset($realToPackKey[$fid0]) ? '@pack:' . $realToPackKey[$fid0] . '::' . $fid : null;
        };

        $out = [];
        foreach ($reports as $item) {
            $rid = (string) ($item['id'] ?? '');
            if ($rid === '') { continue; }

            if (($item['type'] ?? '') === 'document') {
                $blocks = [];
                foreach ($item['blocks'] ?? [] as $b) {
                    if (($b['kind'] ?? '') === 'text') {
                        $blocks[] = array_filter(['kind' => 'text', 'title' => $b['title'] ?? null, 'body' => (string) ($b['body'] ?? '')], static fn ($v) => $v !== null);
                    } elseif (($b['kind'] ?? '') === 'report') {
                        $blocks[] = array_filter(['kind' => 'report', 'reportId' => (string) ($b['reportId'] ?? ''), 'caption' => $b['caption'] ?? null], static fn ($v) => $v !== null);
                    }
                }
                if ($blocks) {
                    $out[] = array_filter(['reportId' => $rid, 'kind' => 'document', 'name' => $item['name'] ?? 'Document', 'description' => $item['description'] ?? null, 'blocks' => $blocks], static fn ($v) => $v !== null);
                }
                continue;
            }

            $spec = is_array($item['spec'] ?? null) ? $item['spec'] : null;
            if (!$spec) { continue; }
            $base = $packForm($spec['formId'] ?? null);
            if ($base === null) { continue; } // form not in the exported app
            $ns = ['formId' => $base, 'viz' => $spec['viz'] ?? 'bar'];
            $ok = true;
            if (!empty($spec['joins'])) {
                $joins = [];
                foreach ($spec['joins'] as $j) {
                    $jf = $packForm($j['formId'] ?? null);
                    if ($jf === null) { $ok = false; break; }
                    $joins[] = array_filter(['via' => $j['via'] ?? '', 'formId' => $jf, 'type' => $j['type'] ?? 'left'], static fn ($v) => $v !== null);
                }
                if (!$ok) { continue; }
                $ns['joins'] = $joins;
            }
            if (!empty($spec['groupBy']['field'])) {
                $gf = $packFieldRef($spec['groupBy']['field']);
                if ($gf === null) { continue; }
                $ns['groupBy'] = ['field' => $gf];
                if (!empty($spec['groupBy']['bucket'])) { $ns['groupBy']['bucket'] = $spec['groupBy']['bucket']; }
            }
            if (!empty($spec['measure'])) {
                $m = $spec['measure'];
                if (isset($m['field'])) {
                    $mf = $packFieldRef($m['field']);
                    if ($mf === null) { continue; }
                    $m['field'] = $mf;
                }
                $ns['measure'] = $m;
            }
            if (!empty($spec['filters'])) {
                $filters = [];
                foreach ($spec['filters'] as $f) {
                    $ff = $packFieldRef($f['field'] ?? null);
                    if ($ff === null) { continue; }
                    $filters[] = array_filter(['field' => $ff, 'op' => $f['op'] ?? 'eq', 'value' => $f['value'] ?? ''], static fn ($v) => $v !== null && $v !== '');
                }
                if ($filters) { $ns['filters'] = $filters; }
            }
            if (!empty($spec['columns'])) {
                $cols = [];
                foreach ($spec['columns'] as $c) {
                    $cf = $packFieldRef($c);
                    if ($cf !== null) { $cols[] = $cf; }
                }
                if ($cols) { $ns['columns'] = $cols; }
            }
            if (!empty($spec['seriesSort'])) { $ns['seriesSort'] = $spec['seriesSort']; }
            if (isset($spec['sort'])) {
                if (is_string($spec['sort'])) {
                    $ns['sort'] = $spec['sort'];
                } elseif (is_array($spec['sort']) && isset($spec['sort']['by'])) {
                    $sb = $packFieldRef($spec['sort']['by']);
                    if ($sb !== null) { $ns['sort'] = ['by' => $sb, 'dir' => ($spec['sort']['dir'] ?? 'asc') === 'desc' ? 'desc' : 'asc']; }
                }
            }
            if (!empty($spec['having']) && is_array($spec['having']) && isset($spec['having']['op'])) {
                $ns['having'] = ['op' => (string) $spec['having']['op'], 'value' => $spec['having']['value'] ?? 0];
            }
            if (isset($spec['limit'])) { $ns['limit'] = (int) $spec['limit']; }

            $out[] = array_filter(['reportId' => $rid, 'kind' => 'chart', 'name' => $item['name'] ?? 'Report', 'description' => $item['description'] ?? null, 'spec' => $ns], static fn ($v) => $v !== null);
        }
        return $out;
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

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

        $this->mysql->beginTransaction();

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

                $formData = [
                    'id' => $newFormId,
                    'userId' => $userId,
                    'title' => $packForm['title'],
                    'description' => $packForm['description'] ?? null,
                    'status' => 'draft',
                    'settings' => $packForm['settings'] ?? [],
                    'theme' => $packForm['theme'] ?? [],
                    'logicScript' => $packForm['logicScript'] ?? null,
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
                        $this->appUserService->setRolePermissions($role['id'], $permissions);
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

            return [
                'installationId' => $installationId,
                'forms' => $formSummary,
                'apps' => $appSummary,
            ];

        } catch (\Exception $e) {
            $this->mysql->rollBack();

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

        $installations = [];
        foreach ($rows as $row) {
            $formIds = json_decode($row['form_ids'], true) ?? [];
            $appIds = json_decode($row['app_ids'], true) ?? [];

            // Check which forms/apps still exist
            $existingForms = $this->countExistingForms($formIds);
            $existingApps = $this->countExistingApps($appIds);

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
        foreach ($appIds as $appId) {
            try {
                $this->appService->deleteApp($appId);
                $appsDeleted++;
            } catch (\Exception $e) {
                // App may have been manually deleted already
            }
        }

        // Delete forms (and their SQLite databases)
        foreach ($formIds as $formId) {
            try {
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

        // Don't adopt if already tracked
        if ($this->isPackInstalled($packId, $userId)) {
            throw new \RuntimeException('Pack is already tracked');
        }

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

        // Check for duplicate packFormIds
        $seenFormIds = [];
        foreach ($packData['forms'] as $i => $form) {
            if (!isset($form['packFormId']) || $form['packFormId'] === '') {
                throw new \RuntimeException("Form at index {$i} is missing packFormId");
            }
            if (empty($form['title'])) {
                throw new \RuntimeException("Form '{$form['packFormId']}' is missing title");
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
     * Count how many of the given form IDs still exist in the database.
     */
    private function countExistingForms(array $formIds): int
    {
        if (empty($formIds)) {
            return 0;
        }
        $placeholders = implode(',', array_fill(0, count($formIds), '?'));
        $stmt = $this->mysql->prepare("SELECT COUNT(*) FROM forms WHERE id IN ($placeholders)");
        $stmt->execute($formIds);
        return (int)$stmt->fetchColumn();
    }

    /**
     * Count how many of the given app IDs still exist in the database.
     */
    private function countExistingApps(array $appIds): int
    {
        if (empty($appIds)) {
            return 0;
        }
        $placeholders = implode(',', array_fill(0, count($appIds), '?'));
        $stmt = $this->mysql->prepare("SELECT COUNT(*) FROM apps WHERE id IN ($placeholders)");
        $stmt->execute($appIds);
        return (int)$stmt->fetchColumn();
    }

    private function generateUuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}

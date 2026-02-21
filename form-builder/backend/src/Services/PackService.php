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
     * Returns summary of created resources.
     *
     * @param array  $packData Full pack JSON structure
     * @param string $userId   Authenticated user importing the pack
     * @return array { forms: [{id, title}], apps: [{id, name}] }
     */
    public function importPack(array $packData, string $userId): array
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
                    'fields' => $fields,
                ];

                $this->formService->createForm($formData);
                $createdFormIds[] = $newFormId;
                $formSummary[] = ['id' => $newFormId, 'title' => $packForm['title']];
            }

            // 3. Create each app
            $appSummary = [];
            foreach ($packData['apps'] ?? [] as $packApp) {
                // Create the app (generates slug, creates system roles, adds owner)
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

                    // Map permissions to real form IDs (app-level permissions have no packFormId)
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
                            // App-level permission (no form scope)
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

            $this->mysql->commit();

            return [
                'forms' => $formSummary,
                'apps' => $appSummary,
            ];

        } catch (\Exception $e) {
            $this->mysql->rollBack();

            // Clean up any created forms
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
                    $packFormId = substr($targetFormId, 6); // Remove '@pack:' prefix
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

    private function generateUuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}

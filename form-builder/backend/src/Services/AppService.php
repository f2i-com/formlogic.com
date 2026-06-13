<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Constants\AppPermissions;
use FormLogic\Database\MySQLConnection;
use FormLogic\Models\App;
use PDO;

class AppService
{
    private PDO $mysql;
    private FormService $formService;

    public function __construct(MySQLConnection $mysql, FormService $formService)
    {
        $this->mysql = $mysql->getConnection();
        $this->formService = $formService;
    }

    public function getAllApps(string $userId): array
    {
        $stmt = $this->mysql->prepare("
            SELECT DISTINCT a.* FROM apps a
            LEFT JOIN app_users au ON au.app_id = a.id AND au.user_id = :user_id
            WHERE a.owner_id = :owner_id OR au.user_id = :user_id2
            ORDER BY a.updated_at DESC
        ");
        $stmt->execute(['owner_id' => $userId, 'user_id' => $userId, 'user_id2' => $userId]);

        $apps = [];
        while ($row = $stmt->fetch()) {
            $apps[] = App::fromArray($row)->toArray();
        }
        return $apps;
    }

    public function getApp(string $appId): ?array
    {
        $stmt = $this->mysql->prepare("SELECT * FROM apps WHERE id = :id");
        $stmt->execute(['id' => $appId]);
        $row = $stmt->fetch();

        if (!$row) {
            return null;
        }

        return App::fromArray($row)->toArray();
    }

    /**
     * Check if a user is an ACTIVE member of an app (via app_users table).
     * Suspended/pending members are not treated as members — admin-side reads
     * must match the runtime gates (AppPublicController/FileController) which
     * require status === 'active'.
     */
    public function isAppMember(string $appId, string $userId): bool
    {
        $stmt = $this->mysql->prepare("SELECT 1 FROM app_users WHERE app_id = :app_id AND user_id = :user_id AND status = 'active' LIMIT 1");
        $stmt->execute(['app_id' => $appId, 'user_id' => $userId]);
        return (bool) $stmt->fetch();
    }

    /**
     * Does this form belong to at least one app? Used to decide whether a stored
     * file should be access-controlled (app-scoped) or served publicly (standalone).
     */
    public function isFormInAnyApp(string $formId): bool
    {
        $stmt = $this->mysql->prepare("SELECT 1 FROM app_forms WHERE form_id = :fid LIMIT 1");
        $stmt->execute(['fid' => $formId]);
        return $stmt->fetchColumn() !== false;
    }

    /**
     * Is the user an active member of ANY app that contains this form? Grants
     * access to that form's app-scoped uploaded files.
     */
    public function userSharesActiveAppWithForm(string $formId, string $userId): bool
    {
        $stmt = $this->mysql->prepare(
            "SELECT 1 FROM app_forms af
             JOIN app_users au ON au.app_id = af.app_id
             WHERE af.form_id = :fid AND au.user_id = :uid AND au.status = 'active'
             LIMIT 1"
        );
        $stmt->execute(['fid' => $formId, 'uid' => $userId]);
        return $stmt->fetchColumn() !== false;
    }

    public function getAppBySlug(string $slug): ?array
    {
        $stmt = $this->mysql->prepare("SELECT * FROM apps WHERE slug = :slug");
        $stmt->execute(['slug' => $slug]);
        $row = $stmt->fetch();

        if (!$row) {
            return null;
        }

        return App::fromArray($row)->toArray();
    }

    public function createApp(array $data, string $ownerId): array
    {
        $id = $this->generateUuid();
        $now = date('Y-m-d H:i:s');
        $slug = $this->generateSlug($data['name'] ?? 'untitled');

        // Atomic setup: the app row, its three system roles, the owner membership
        // and the owner permission grants must all succeed together. A partial
        // failure used to leave an unmanageable app (no owner app_user / no perms).
        // Guard against an outer transaction (PackService::installPack wraps this).
        $ownTransaction = !$this->mysql->inTransaction();
        if ($ownTransaction) {
            $this->mysql->beginTransaction();
        }
        try {
            $stmt = $this->mysql->prepare("
                INSERT INTO apps (id, owner_id, name, slug, description, logo_url, status, settings, theme, nav_config, created_at, updated_at)
                VALUES (:id, :owner_id, :name, :slug, :description, :logo_url, :status, :settings, :theme, :nav_config, :created_at, :updated_at)
            ");

            $stmt->execute([
                'id' => $id,
                'owner_id' => $ownerId,
                'name' => $data['name'] ?? 'Untitled App',
                'slug' => $slug,
                'description' => $data['description'] ?? null,
                'logo_url' => $data['logoUrl'] ?? null,
                'status' => $data['status'] ?? 'draft',
                'settings' => json_encode($data['settings'] ?? []),
                'theme' => json_encode($data['theme'] ?? []),
                'nav_config' => json_encode($data['navConfig'] ?? []),
                'created_at' => $now,
                'updated_at' => $now,
            ]);

            // Create default system roles
            $ownerRoleId = $this->createSystemRole($id, 'Owner', 'Full access to the app', 0);
            $this->createSystemRole($id, 'Admin', 'Administrative access', 1);
            $this->createSystemRole($id, 'Member', 'Standard member access', 2);

            // Add creator as Owner
            $this->addAppUser($id, $ownerId, $ownerRoleId, 'active');

            // Grant all permissions to Owner role
            $this->grantAllPermissions($ownerRoleId);

            if ($ownTransaction) {
                $this->mysql->commit();
            }
        } catch (\Exception $e) {
            if ($ownTransaction && $this->mysql->inTransaction()) {
                $this->mysql->rollBack();
            }
            throw $e;
        }

        return $this->getApp($id);
    }

    public function updateApp(string $appId, array $data): ?array
    {
        $existing = $this->getApp($appId);
        if (!$existing) {
            return null;
        }

        $updates = [];
        $params = ['id' => $appId];

        if (isset($data['name'])) {
            $updates[] = "name = :name";
            $params['name'] = $data['name'];
        }

        if (isset($data['description'])) {
            $updates[] = "description = :description";
            $params['description'] = $data['description'];
        }

        if (isset($data['logoUrl'])) {
            $updates[] = "logo_url = :logo_url";
            $params['logo_url'] = $data['logoUrl'];
        }

        if (isset($data['status'])) {
            if (!in_array($data['status'], ['draft', 'published', 'archived'], true)) {
                throw new \RuntimeException('Invalid status value');
            }
            $updates[] = "status = :status";
            $params['status'] = $data['status'];
        }

        if (isset($data['settings'])) {
            $updates[] = "settings = :settings";
            $params['settings'] = json_encode($data['settings']);
        }

        if (isset($data['theme'])) {
            $updates[] = "theme = :theme";
            $params['theme'] = json_encode($data['theme']);
        }

        if (isset($data['navConfig'])) {
            $updates[] = "nav_config = :nav_config";
            $params['nav_config'] = json_encode($data['navConfig']);
        }

        if (!empty($updates)) {
            $updates[] = "updated_at = :updated_at";
            $params['updated_at'] = date('Y-m-d H:i:s');

            $sql = "UPDATE apps SET " . implode(', ', $updates) . " WHERE id = :id";
            $stmt = $this->mysql->prepare($sql);
            $stmt->execute($params);
        }

        return $this->getApp($appId);
    }

    public function deleteApp(string $appId): bool
    {
        $this->mysql->beginTransaction();
        try {
            // Delete app_users first to avoid FK constraint with app_roles
            $stmt = $this->mysql->prepare("DELETE FROM app_users WHERE app_id = :app_id");
            $stmt->execute(['app_id' => $appId]);

            // Purge inverse linked_record links for this app's forms before the
            // cascade removes app_forms — response_links is keyed by form_id (not
            // app_id), so it would otherwise leave stale inverse-lookup rows.
            $formStmt = $this->mysql->prepare("SELECT form_id FROM app_forms WHERE app_id = :app_id");
            $formStmt->execute(['app_id' => $appId]);
            $formIds = $formStmt->fetchAll(\PDO::FETCH_COLUMN);
            if (!empty($formIds)) {
                $placeholders = implode(',', array_fill(0, count($formIds), '?'));
                $linkStmt = $this->mysql->prepare(
                    "DELETE FROM response_links WHERE source_form_id IN ($placeholders) OR target_form_id IN ($placeholders)"
                );
                $linkStmt->execute([...$formIds, ...$formIds]);
            }

            // Now delete the app (cascades to app_roles, app_forms, etc.)
            $stmt = $this->mysql->prepare("DELETE FROM apps WHERE id = :id");
            $stmt->execute(['id' => $appId]);
            $deleted = $stmt->rowCount() > 0;

            $this->mysql->commit();
            return $deleted;
        } catch (\Exception $e) {
            $this->mysql->rollBack();
            throw $e;
        }
    }

    // Form management

    public function getAppForms(string $appId): array
    {
        $stmt = $this->mysql->prepare("
            SELECT af.*, f.title as form_title, f.status as form_status
            FROM app_forms af
            JOIN forms f ON f.id = af.form_id
            WHERE af.app_id = :app_id
            ORDER BY af.sort_order ASC
        ");
        $stmt->execute(['app_id' => $appId]);

        $forms = [];
        while ($row = $stmt->fetch()) {
            $forms[] = [
                'id' => $row['id'],
                'appId' => $row['app_id'],
                'formId' => $row['form_id'],
                'displayName' => $row['display_name'] ?? $row['form_title'],
                'sortOrder' => (int)$row['sort_order'],
                'isVisible' => (bool)$row['is_visible'],
                'settings' => json_decode($row['settings'] ?? '{}', true),
                'formTitle' => $row['form_title'],
                'formStatus' => $row['form_status'],
            ];
        }
        return $forms;
    }

    public function addFormToApp(string $appId, string $formId, ?string $displayName = null): array
    {
        // Get current max sort order
        $stmt = $this->mysql->prepare("SELECT MAX(sort_order) as max_order FROM app_forms WHERE app_id = :app_id");
        $stmt->execute(['app_id' => $appId]);
        $row = $stmt->fetch();
        $sortOrder = ($row['max_order'] ?? -1) + 1;

        // Get form title for default display name
        if (!$displayName) {
            $form = $this->formService->getForm($formId);
            $displayName = $form ? $form['title'] : 'Untitled';
        }

        $id = $this->generateUuid();
        $stmt = $this->mysql->prepare("
            INSERT INTO app_forms (id, app_id, form_id, display_name, sort_order, is_visible, settings)
            VALUES (:id, :app_id, :form_id, :display_name, :sort_order, 1, '{}')
        ");
        $stmt->execute([
            'id' => $id,
            'app_id' => $appId,
            'form_id' => $formId,
            'display_name' => $displayName,
            'sort_order' => $sortOrder,
        ]);

        return $this->getAppForms($appId);
    }

    public function removeFormFromApp(string $appId, string $formId): bool
    {
        $stmt = $this->mysql->prepare("DELETE FROM app_forms WHERE app_id = :app_id AND form_id = :form_id");
        $stmt->execute(['app_id' => $appId, 'form_id' => $formId]);
        $removed = $stmt->rowCount() > 0;

        if ($removed) {
            // Only purge response_links if the form no longer belongs to ANY app.
            // response_links are global (no app_id column) and the same form can be
            // shared across apps, so an unconditional delete would wipe the inverse
            // relation lookups still needed by other apps that contain this form.
            $stillUsed = $this->mysql->prepare("SELECT 1 FROM app_forms WHERE form_id = :fid LIMIT 1");
            $stillUsed->execute(['fid' => $formId]);
            if ($stillUsed->fetchColumn() === false) {
                $cleanup = $this->mysql->prepare(
                    "DELETE FROM response_links WHERE source_form_id = :fid OR target_form_id = :fid2"
                );
                $cleanup->execute(['fid' => $formId, 'fid2' => $formId]);
            }
        }

        return $removed;
    }

    public function updateAppForm(string $appId, string $formId, array $data): bool
    {
        $updates = [];
        $params = ['app_id' => $appId, 'form_id' => $formId];

        if (isset($data['displayName'])) {
            $updates[] = "display_name = :display_name";
            $params['display_name'] = $data['displayName'];
        }

        if (isset($data['isVisible'])) {
            $updates[] = "is_visible = :is_visible";
            $params['is_visible'] = (int)$data['isVisible'];
        }

        if (isset($data['settings'])) {
            $updates[] = "settings = :settings";
            $params['settings'] = json_encode($data['settings']);
        }

        if (empty($updates)) {
            return false;
        }

        $sql = "UPDATE app_forms SET " . implode(', ', $updates) . " WHERE app_id = :app_id AND form_id = :form_id";
        $stmt = $this->mysql->prepare($sql);
        $stmt->execute($params);
        return $stmt->rowCount() > 0;
    }

    public function reorderAppForms(string $appId, array $formIds): bool
    {
        $this->mysql->beginTransaction();
        try {
            foreach ($formIds as $index => $formId) {
                $stmt = $this->mysql->prepare("
                    UPDATE app_forms SET sort_order = :sort_order WHERE app_id = :app_id AND form_id = :form_id
                ");
                $stmt->execute([
                    'sort_order' => $index,
                    'app_id' => $appId,
                    'form_id' => $formId,
                ]);
            }
            $this->mysql->commit();
            return true;
        } catch (\Exception $e) {
            $this->mysql->rollBack();
            return false;
        }
    }

    public function isFormOwnedByUser(string $formId, string $userId): bool
    {
        $stmt = $this->mysql->prepare("SELECT id FROM forms WHERE id = :id AND user_id = :user_id");
        $stmt->execute(['id' => $formId, 'user_id' => $userId]);
        return $stmt->fetch(PDO::FETCH_ASSOC) !== false;
    }

    // Private helpers

    private function createSystemRole(string $appId, string $name, string $description, int $sortOrder): string
    {
        $id = $this->generateUuid();
        $stmt = $this->mysql->prepare("
            INSERT INTO app_roles (id, app_id, name, description, is_system, sort_order)
            VALUES (:id, :app_id, :name, :description, 1, :sort_order)
        ");
        $stmt->execute([
            'id' => $id,
            'app_id' => $appId,
            'name' => $name,
            'description' => $description,
            'sort_order' => $sortOrder,
        ]);
        return $id;
    }

    private function addAppUser(string $appId, string $userId, string $roleId, string $status): void
    {
        $id = $this->generateUuid();
        $now = date('Y-m-d H:i:s');
        $stmt = $this->mysql->prepare("
            INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at)
            VALUES (:id, :app_id, :user_id, :role_id, :status, :joined_at)
        ");
        $stmt->execute([
            'id' => $id,
            'app_id' => $appId,
            'user_id' => $userId,
            'role_id' => $roleId,
            'status' => $status,
            'joined_at' => $now,
        ]);
    }

    private function grantAllPermissions(string $roleId): void
    {
        $allPerms = AppPermissions::ALL;

        foreach ($allPerms as $perm) {
            $id = $this->generateUuid();
            $stmt = $this->mysql->prepare("
                INSERT INTO app_role_permissions (id, role_id, form_id, permission)
                VALUES (:id, :role_id, NULL, :permission)
            ");
            $stmt->execute([
                'id' => $id,
                'role_id' => $roleId,
                'permission' => $perm,
            ]);
        }
    }

    private function generateSlug(string $name): string
    {
        $slug = strtolower(preg_replace('/[^a-zA-Z0-9]+/', '-', $name));
        $slug = trim($slug, '-');
        $slug = substr($slug, 0, 50);

        if (!$slug) {
            $slug = 'app';
        }

        // Add short random suffix to prevent TOCTOU race on concurrent creation
        $slug .= '-' . substr(bin2hex(random_bytes(3)), 0, 6);

        // Check uniqueness (still needed for edge cases)
        $baseSlug = $slug;
        $counter = 1;
        while ($this->slugExists($slug)) {
            $slug = $baseSlug . '-' . $counter;
            $counter++;
            if ($counter > 100) {
                throw new \RuntimeException('Unable to generate unique slug');
            }
        }

        return $slug;
    }

    private function slugExists(string $slug): bool
    {
        $stmt = $this->mysql->prepare("SELECT COUNT(*) as cnt FROM apps WHERE slug = :slug");
        $stmt->execute(['slug' => $slug]);
        $row = $stmt->fetch();
        return (int)($row['cnt'] ?? 0) > 0;
    }

    private function generateUuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use FormLogic\Constants\AppPermissions;
use FormLogic\Models\AppRole;
use FormLogic\Models\AppUser;
use FormLogic\Models\AppUserGroup;
use PDO;

class AppUserService
{
    private PDO $mysql;

    public function __construct(MySQLConnection $mysql)
    {
        $this->mysql = $mysql->getConnection();
    }

    // Ownership verification helpers

    public function roleBelongsToApp(string $roleId, string $appId): bool
    {
        $stmt = $this->mysql->prepare("SELECT id FROM app_roles WHERE id = :id AND app_id = :app_id");
        $stmt->execute(['id' => $roleId, 'app_id' => $appId]);
        return $stmt->fetch(PDO::FETCH_ASSOC) !== false;
    }

    public function appUserBelongsToApp(string $appUserId, string $appId): bool
    {
        $stmt = $this->mysql->prepare("SELECT id FROM app_users WHERE id = :id AND app_id = :app_id");
        $stmt->execute(['id' => $appUserId, 'app_id' => $appId]);
        return $stmt->fetch(PDO::FETCH_ASSOC) !== false;
    }

    public function invitationBelongsToApp(string $invitationId, string $appId): bool
    {
        $stmt = $this->mysql->prepare("SELECT id FROM app_invitations WHERE id = :id AND app_id = :app_id");
        $stmt->execute(['id' => $invitationId, 'app_id' => $appId]);
        return $stmt->fetch(PDO::FETCH_ASSOC) !== false;
    }

    public function groupBelongsToApp(string $groupId, string $appId): bool
    {
        $stmt = $this->mysql->prepare("SELECT id FROM app_user_groups WHERE id = :id AND app_id = :app_id");
        $stmt->execute(['id' => $groupId, 'app_id' => $appId]);
        return $stmt->fetch(PDO::FETCH_ASSOC) !== false;
    }

    // Roles

    public function getRoles(string $appId): array
    {
        $stmt = $this->mysql->prepare("SELECT * FROM app_roles WHERE app_id = :app_id ORDER BY sort_order ASC");
        $stmt->execute(['app_id' => $appId]);

        $roles = [];
        while ($row = $stmt->fetch()) {
            $role = AppRole::fromArray($row)->toArray();
            $role['permissions'] = $this->getRolePermissions($row['id']);
            $roles[] = $role;
        }
        return $roles;
    }

    public function createRole(string $appId, array $data): array
    {
        $id = $this->generateUuid();

        // Get max sort order
        $stmt = $this->mysql->prepare("SELECT MAX(sort_order) as max_order FROM app_roles WHERE app_id = :app_id");
        $stmt->execute(['app_id' => $appId]);
        $row = $stmt->fetch();
        $sortOrder = ($row['max_order'] ?? -1) + 1;

        $stmt = $this->mysql->prepare("
            INSERT INTO app_roles (id, app_id, name, description, is_system, sort_order)
            VALUES (:id, :app_id, :name, :description, 0, :sort_order)
        ");
        $stmt->execute([
            'id' => $id,
            'app_id' => $appId,
            'name' => $data['name'],
            'description' => $data['description'] ?? null,
            'sort_order' => $sortOrder,
        ]);

        return AppRole::fromArray([
            'id' => $id,
            'app_id' => $appId,
            'name' => $data['name'],
            'description' => $data['description'] ?? null,
            'is_system' => false,
            'sort_order' => $sortOrder,
        ])->toArray();
    }

    public function updateRole(string $roleId, array $data): bool
    {
        // Cannot rename system roles
        $role = $this->getRole($roleId);
        if (!$role || $role['isSystem']) {
            return false;
        }

        $updates = [];
        $params = ['id' => $roleId];

        if (isset($data['name'])) {
            $updates[] = "name = :name";
            $params['name'] = $data['name'];
        }

        if (isset($data['description'])) {
            $updates[] = "description = :description";
            $params['description'] = $data['description'];
        }

        if (empty($updates)) {
            return false;
        }

        $sql = "UPDATE app_roles SET " . implode(', ', $updates) . " WHERE id = :id";
        $stmt = $this->mysql->prepare($sql);
        $stmt->execute($params);
        return true;
    }

    public function deleteRole(string $roleId): bool
    {
        $role = $this->getRole($roleId);
        if (!$role) {
            throw new \RuntimeException('Role not found');
        }
        if ($role['isSystem']) {
            throw new \RuntimeException('Cannot delete system role');
        }

        // Check if any users are assigned to this role
        $stmt = $this->mysql->prepare("SELECT COUNT(*) as cnt FROM app_users WHERE role_id = :role_id");
        $stmt->execute(['role_id' => $roleId]);
        $row = $stmt->fetch();
        if ((int)($row['cnt'] ?? 0) > 0) {
            throw new \RuntimeException('Cannot delete role with assigned users');
        }

        $stmt = $this->mysql->prepare("DELETE FROM app_roles WHERE id = :id AND is_system = 0");
        $stmt->execute(['id' => $roleId]);
        return $stmt->rowCount() > 0;
    }

    private function getRole(string $roleId): ?array
    {
        $stmt = $this->mysql->prepare("SELECT * FROM app_roles WHERE id = :id");
        $stmt->execute(['id' => $roleId]);
        $row = $stmt->fetch();
        return $row ? AppRole::fromArray($row)->toArray() : null;
    }

    // Permissions

    public function getRolePermissions(string $roleId): array
    {
        $stmt = $this->mysql->prepare("SELECT * FROM app_role_permissions WHERE role_id = :role_id");
        $stmt->execute(['role_id' => $roleId]);

        $permissions = [];
        while ($row = $stmt->fetch()) {
            $permissions[] = [
                'id' => $row['id'],
                'roleId' => $row['role_id'],
                'formId' => $row['form_id'],
                'permission' => $row['permission'],
            ];
        }
        return $permissions;
    }

    public function setRolePermissions(string $roleId, array $permissions): void
    {
        $inTransaction = $this->mysql->inTransaction();
        if (!$inTransaction) {
            $this->mysql->beginTransaction();
        }
        try {
            // Delete existing permissions
            $stmt = $this->mysql->prepare("DELETE FROM app_role_permissions WHERE role_id = :role_id");
            $stmt->execute(['role_id' => $roleId]);

            // Insert new permissions
            $stmt = $this->mysql->prepare("
                INSERT INTO app_role_permissions (id, role_id, form_id, permission)
                VALUES (:id, :role_id, :form_id, :permission)
            ");

            foreach ($permissions as $perm) {
                if (!in_array($perm['permission'], AppPermissions::ALL, true)) {
                    continue;
                }
                $stmt->execute([
                    'id' => $this->generateUuid(),
                    'role_id' => $roleId,
                    'form_id' => $perm['formId'] ?? null,
                    'permission' => $perm['permission'],
                ]);
            }

            if (!$inTransaction) {
                $this->mysql->commit();
            }
        } catch (\Exception $e) {
            if (!$inTransaction) {
                $this->mysql->rollBack();
            }
            throw $e;
        }
    }

    // Users

    public function getAppUsers(string $appId): array
    {
        $stmt = $this->mysql->prepare("
            SELECT au.*, u.email, u.name as user_name, ar.name as role_name
            FROM app_users au
            JOIN users u ON u.id = au.user_id
            JOIN app_roles ar ON ar.id = au.role_id
            WHERE au.app_id = :app_id
            ORDER BY au.joined_at DESC
        ");
        $stmt->execute(['app_id' => $appId]);

        $users = [];
        while ($row = $stmt->fetch()) {
            $user = AppUser::fromArray($row)->toArray();
            $user['email'] = $row['email'];
            $user['name'] = $row['user_name'];
            $user['roleName'] = $row['role_name'];
            $users[] = $user;
        }
        return $users;
    }

    public function getAppUser(string $appId, string $userId): ?array
    {
        $stmt = $this->mysql->prepare("
            SELECT au.*, u.email, u.name as user_name, ar.name as role_name
            FROM app_users au
            JOIN users u ON u.id = au.user_id
            JOIN app_roles ar ON ar.id = au.role_id
            WHERE au.app_id = :app_id AND au.user_id = :user_id
        ");
        $stmt->execute(['app_id' => $appId, 'user_id' => $userId]);
        $row = $stmt->fetch();

        if (!$row) {
            return null;
        }

        $user = AppUser::fromArray($row)->toArray();
        $user['email'] = $row['email'];
        $user['name'] = $row['user_name'];
        $user['roleName'] = $row['role_name'];
        return $user;
    }

    public function updateAppUser(string $appUserId, array $data): bool
    {
        $updates = [];
        $params = ['id' => $appUserId];

        if (isset($data['roleId'])) {
            $updates[] = "role_id = :role_id";
            $params['role_id'] = $data['roleId'];
        }

        if (isset($data['status'])) {
            $updates[] = "status = :status";
            $params['status'] = $data['status'];
        }

        if (empty($updates)) {
            return false;
        }

        $sql = "UPDATE app_users SET " . implode(', ', $updates) . " WHERE id = :id";
        $stmt = $this->mysql->prepare($sql);
        $stmt->execute($params);
        return $stmt->rowCount() > 0;
    }

    public function removeAppUser(string $appUserId): bool
    {
        // Check if user is the owner
        $stmt = $this->mysql->prepare("
            SELECT au.*, ar.name as role_name
            FROM app_users au
            JOIN app_roles ar ON ar.id = au.role_id
            WHERE au.id = :id
        ");
        $stmt->execute(['id' => $appUserId]);
        $row = $stmt->fetch();

        if (!$row) {
            return false;
        }

        if ($row['role_name'] === 'Owner') {
            throw new \RuntimeException('Cannot remove the app owner');
        }

        $stmt = $this->mysql->prepare("DELETE FROM app_users WHERE id = :id");
        $stmt->execute(['id' => $appUserId]);
        return $stmt->rowCount() > 0;
    }

    // Invitations

    public function getInvitations(string $appId): array
    {
        $stmt = $this->mysql->prepare("
            SELECT ai.*, ar.name as role_name, u.name as inviter_name
            FROM app_invitations ai
            JOIN app_roles ar ON ar.id = ai.role_id
            JOIN users u ON u.id = ai.invited_by
            WHERE ai.app_id = :app_id
            ORDER BY ai.created_at DESC
        ");
        $stmt->execute(['app_id' => $appId]);

        $invitations = [];
        while ($row = $stmt->fetch()) {
            $invitations[] = [
                'id' => $row['id'],
                'appId' => $row['app_id'],
                'email' => $row['email'],
                'roleId' => $row['role_id'],
                'roleName' => $row['role_name'],
                'status' => $row['status'],
                'invitedBy' => $row['invited_by'],
                'inviterName' => $row['inviter_name'],
                'expiresAt' => $row['expires_at'],
                'createdAt' => $row['created_at'],
            ];
        }
        return $invitations;
    }

    public function createInvitation(string $appId, string $email, string $roleId, string $invitedBy): array
    {
        $id = $this->generateUuid();
        $token = bin2hex(random_bytes(32));
        $tokenHash = hash('sha256', $token);
        $expiresAt = date('Y-m-d H:i:s', strtotime('+7 days'));

        $stmt = $this->mysql->prepare("
            INSERT INTO app_invitations (id, app_id, email, role_id, token_hash, invited_by, status, expires_at)
            VALUES (:id, :app_id, :email, :role_id, :token_hash, :invited_by, 'pending', :expires_at)
        ");
        $stmt->execute([
            'id' => $id,
            'app_id' => $appId,
            'email' => $email,
            'role_id' => $roleId,
            'token_hash' => $tokenHash,
            'invited_by' => $invitedBy,
            'expires_at' => $expiresAt,
        ]);

        return [
            'id' => $id,
            'appId' => $appId,
            'email' => $email,
            'roleId' => $roleId,
            'status' => 'pending',
            'expiresAt' => $expiresAt,
            'token' => $token,
        ];
    }

    public function acceptInvitation(string $token, string $userId): array
    {
        $tokenHash = hash('sha256', $token);

        $stmt = $this->mysql->prepare("
            SELECT ai.*, ar.name as role_name
            FROM app_invitations ai
            JOIN app_roles ar ON ar.id = ai.role_id
            WHERE ai.token_hash = :token_hash AND ai.status = 'pending'
        ");
        $stmt->execute(['token_hash' => $tokenHash]);
        $invitation = $stmt->fetch();

        if (!$invitation) {
            throw new \RuntimeException('Invalid or expired invitation');
        }

        if (strtotime($invitation['expires_at']) < time()) {
            // Mark as expired
            $stmt = $this->mysql->prepare("UPDATE app_invitations SET status = 'expired' WHERE id = :id");
            $stmt->execute(['id' => $invitation['id']]);
            throw new \RuntimeException('Invitation has expired');
        }

        $this->mysql->beginTransaction();
        try {
            // Check if user is already a member
            $stmt = $this->mysql->prepare("SELECT id FROM app_users WHERE app_id = :app_id AND user_id = :user_id");
            $stmt->execute(['app_id' => $invitation['app_id'], 'user_id' => $userId]);
            if ($stmt->fetch()) {
                throw new \RuntimeException('User is already a member of this app');
            }

            // Add user to app
            $appUserId = $this->generateUuid();
            $now = date('Y-m-d H:i:s');
            $stmt = $this->mysql->prepare("
                INSERT INTO app_users (id, app_id, user_id, role_id, status, invited_by, invited_at, joined_at)
                VALUES (:id, :app_id, :user_id, :role_id, 'active', :invited_by, :invited_at, :joined_at)
            ");
            $stmt->execute([
                'id' => $appUserId,
                'app_id' => $invitation['app_id'],
                'user_id' => $userId,
                'role_id' => $invitation['role_id'],
                'invited_by' => $invitation['invited_by'],
                'invited_at' => $invitation['created_at'],
                'joined_at' => $now,
            ]);

            // Mark invitation as accepted
            $stmt = $this->mysql->prepare("UPDATE app_invitations SET status = 'accepted' WHERE id = :id");
            $stmt->execute(['id' => $invitation['id']]);

            $this->mysql->commit();

            return [
                'appId' => $invitation['app_id'],
                'userId' => $userId,
                'roleId' => $invitation['role_id'],
                'roleName' => $invitation['role_name'],
            ];
        } catch (\Exception $e) {
            $this->mysql->rollBack();
            throw $e;
        }
    }

    public function revokeInvitation(string $invitationId): bool
    {
        $stmt = $this->mysql->prepare("UPDATE app_invitations SET status = 'revoked' WHERE id = :id AND status = 'pending'");
        $stmt->execute(['id' => $invitationId]);
        return $stmt->rowCount() > 0;
    }

    // Groups

    public function getGroups(string $appId): array
    {
        $stmt = $this->mysql->prepare("
            SELECT g.*, (SELECT COUNT(*) FROM app_user_group_members m WHERE m.group_id = g.id) as member_count
            FROM app_user_groups g
            WHERE g.app_id = :app_id
            ORDER BY g.name ASC
        ");
        $stmt->execute(['app_id' => $appId]);

        $groups = [];
        while ($row = $stmt->fetch()) {
            $group = AppUserGroup::fromArray($row)->toArray();
            $group['memberCount'] = (int)$row['member_count'];
            $groups[] = $group;
        }
        return $groups;
    }

    public function createGroup(string $appId, array $data): array
    {
        $id = $this->generateUuid();
        $stmt = $this->mysql->prepare("
            INSERT INTO app_user_groups (id, app_id, name, description)
            VALUES (:id, :app_id, :name, :description)
        ");
        $stmt->execute([
            'id' => $id,
            'app_id' => $appId,
            'name' => $data['name'],
            'description' => $data['description'] ?? null,
        ]);

        return AppUserGroup::fromArray([
            'id' => $id,
            'app_id' => $appId,
            'name' => $data['name'],
            'description' => $data['description'] ?? null,
        ])->toArray();
    }

    public function updateGroup(string $groupId, array $data): bool
    {
        $updates = [];
        $params = ['id' => $groupId];

        if (isset($data['name'])) {
            $updates[] = "name = :name";
            $params['name'] = $data['name'];
        }

        if (isset($data['description'])) {
            $updates[] = "description = :description";
            $params['description'] = $data['description'];
        }

        if (empty($updates)) {
            return false;
        }

        $sql = "UPDATE app_user_groups SET " . implode(', ', $updates) . " WHERE id = :id";
        $stmt = $this->mysql->prepare($sql);
        $stmt->execute($params);
        return true;
    }

    public function deleteGroup(string $groupId): bool
    {
        $stmt = $this->mysql->prepare("DELETE FROM app_user_groups WHERE id = :id");
        $stmt->execute(['id' => $groupId]);
        return $stmt->rowCount() > 0;
    }

    public function addGroupMember(string $groupId, string $appUserId): bool
    {
        $id = $this->generateUuid();
        $stmt = $this->mysql->prepare("
            INSERT IGNORE INTO app_user_group_members (id, group_id, app_user_id)
            VALUES (:id, :group_id, :app_user_id)
        ");
        $stmt->execute([
            'id' => $id,
            'group_id' => $groupId,
            'app_user_id' => $appUserId,
        ]);
        return true;
    }

    public function removeGroupMember(string $groupId, string $appUserId): bool
    {
        $stmt = $this->mysql->prepare("DELETE FROM app_user_group_members WHERE group_id = :group_id AND app_user_id = :app_user_id");
        $stmt->execute(['group_id' => $groupId, 'app_user_id' => $appUserId]);
        return $stmt->rowCount() > 0;
    }

    // Permission checks

    public function hasPermission(string $appId, string $userId, string $permission, ?string $formId = null): bool
    {
        // Get user's role in the app
        $stmt = $this->mysql->prepare("
            SELECT au.role_id, ar.name as role_name
            FROM app_users au
            JOIN app_roles ar ON ar.id = au.role_id
            WHERE au.app_id = :app_id AND au.user_id = :user_id AND au.status = 'active'
        ");
        $stmt->execute(['app_id' => $appId, 'user_id' => $userId]);
        $row = $stmt->fetch();

        if (!$row) {
            return false;
        }

        // Owner always has all permissions
        if ($row['role_name'] === 'Owner') {
            return true;
        }

        // Check specific permission
        $sql = "SELECT COUNT(*) as cnt FROM app_role_permissions WHERE role_id = :role_id AND permission = :permission";
        $params = ['role_id' => $row['role_id'], 'permission' => $permission];

        if ($formId !== null) {
            $sql .= " AND (form_id = :form_id OR form_id IS NULL)";
            $params['form_id'] = $formId;
        } else {
            $sql .= " AND form_id IS NULL";
        }

        $stmt = $this->mysql->prepare($sql);
        $stmt->execute($params);
        $result = $stmt->fetch();

        return (int)($result['cnt'] ?? 0) > 0;
    }

    public function getUserPermissions(string $appId, string $userId): array
    {
        $stmt = $this->mysql->prepare("
            SELECT au.role_id, ar.name as role_name
            FROM app_users au
            JOIN app_roles ar ON ar.id = au.role_id
            WHERE au.app_id = :app_id AND au.user_id = :user_id AND au.status = 'active'
        ");
        $stmt->execute(['app_id' => $appId, 'user_id' => $userId]);
        $row = $stmt->fetch();

        if (!$row) {
            return ['appLevel' => [], 'formLevel' => []];
        }

        // Owner gets all permissions
        if ($row['role_name'] === 'Owner') {
            return [
                'appLevel' => AppPermissions::ALL,
                'formLevel' => [],  // All = app-level grants cover all forms
            ];
        }

        $permissions = $this->getRolePermissions($row['role_id']);

        $appLevel = [];
        $formLevel = [];

        foreach ($permissions as $perm) {
            if ($perm['formId'] === null) {
                $appLevel[] = $perm['permission'];
            } else {
                if (!isset($formLevel[$perm['formId']])) {
                    $formLevel[$perm['formId']] = [];
                }
                $formLevel[$perm['formId']][] = $perm['permission'];
            }
        }

        return ['appLevel' => $appLevel, 'formLevel' => $formLevel];
    }

    private function generateUuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}

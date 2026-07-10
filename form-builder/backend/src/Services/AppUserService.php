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

    public function isAppOwner(string $appId, string $userId): bool
    {
        $stmt = $this->mysql->prepare("SELECT 1 FROM apps WHERE id = :id AND owner_id = :uid LIMIT 1");
        $stmt->execute(['id' => $appId, 'uid' => $userId]);
        return $stmt->fetchColumn() !== false;
    }

    // Roles

    public function getRoles(string $appId): array
    {
        $stmt = $this->mysql->prepare("SELECT * FROM app_roles WHERE app_id = :app_id ORDER BY sort_order ASC");
        $stmt->execute(['app_id' => $appId]);
        $rows = $stmt->fetchAll();

        // Batch-fetch permissions for all roles in one query (was 1 query per role).
        $permsByRole = [];
        $roleIds = array_column($rows, 'id');
        if (!empty($roleIds)) {
            $ph = implode(',', array_fill(0, count($roleIds), '?'));
            $permStmt = $this->mysql->prepare("SELECT id, role_id, form_id, permission FROM app_role_permissions WHERE role_id IN ($ph)");
            $permStmt->execute($roleIds);
            while ($pr = $permStmt->fetch()) {
                $permsByRole[$pr['role_id']][] = [
                    'id' => $pr['id'],
                    'roleId' => $pr['role_id'],
                    'formId' => $pr['form_id'],
                    'permission' => $pr['permission'],
                ];
            }
        }

        $roles = [];
        foreach ($rows as $row) {
            $role = AppRole::fromArray($row)->toArray();
            $role['permissions'] = $permsByRole[$row['id']] ?? [];
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

    /**
     * Does this role grant any app-level permission (MANAGE_APP / MANAGE_USERS /
     * MANAGE_ROLES / VIEW_ANALYTICS)? Used to enforce a privilege ceiling so a
     * delegated MANAGE_USERS holder cannot assign an app-admin role and escalate.
     */
    private function roleGrantsAppLevel(string $roleId): bool
    {
        $stmt = $this->mysql->prepare(
            "SELECT 1 FROM app_role_permissions WHERE role_id = ? AND permission IN ("
            . implode(',', array_fill(0, count(AppPermissions::APP_LEVEL), '?'))
            . ") LIMIT 1"
        );
        $stmt->execute(array_merge([$roleId], AppPermissions::APP_LEVEL));
        return $stmt->fetchColumn() !== false;
    }

    public function setRolePermissions(string $roleId, array $permissions, bool $actorIsOwner = false): void
    {
        // Only the Owner role is immutable (it implicitly has every permission).
        // The other system roles (Admin/Member) are configurable — the role editor
        // UI already presents them as editable, so rejecting the save here produced
        // a dead-end "Save failed".
        $role = $this->getRole($roleId);
        if (!$role) {
            throw new \RuntimeException('Role not found');
        }
        if (($role['isSystem'] ?? false) && ($role['name'] ?? '') === 'Owner') {
            throw new \RuntimeException('The Owner role cannot be modified');
        }

        // Build set of valid form IDs for this app (to validate formId in permissions)
        $appId = $role['appId'];
        $validFormIds = [];
        $fStmt = $this->mysql->prepare("SELECT form_id FROM app_forms WHERE app_id = :app_id");
        $fStmt->execute(['app_id' => $appId]);
        foreach ($fStmt->fetchAll() as $row) {
            $validFormIds[$row['form_id']] = true;
        }

        $inTransaction = $this->mysql->inTransaction();
        if (!$inTransaction) {
            $this->mysql->beginTransaction();
        }
        try {
            // Delete existing BUILT-IN permissions only. connector.* grants are owner-managed via
            // setConnectorGrants() and must survive a role-editor save (the editor doesn't carry
            // them, so a blanket delete-all here would silently wipe them).
            $stmt = $this->mysql->prepare("DELETE FROM app_role_permissions WHERE role_id = :role_id AND permission NOT LIKE 'connector.%'");
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
                // Only the app owner may grant app-level permissions. Otherwise a
                // delegated MANAGE_ROLES holder could grant itself MANAGE_APP /
                // MANAGE_USERS / MANAGE_ROLES and escalate to full app admin.
                if (!$actorIsOwner && in_array($perm['permission'], AppPermissions::APP_LEVEL, true)) {
                    throw new \RuntimeException('Only the app owner can grant app-level permissions');
                }
                $formId = $perm['formId'] ?? null;
                // Skip permissions referencing forms not in this app
                if ($formId !== null && !isset($validFormIds[$formId])) {
                    continue;
                }
                $stmt->execute([
                    'id' => $this->generateUuid(),
                    'role_id' => $roleId,
                    'form_id' => $formId,
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

    /**
     * Replace a role's connector capability grants (connector.<id>[.<command>|.*]). OWNER-ONLY:
     * device-control capability isn't delegatable, so this throws unless $actorIsOwner (pack imports
     * run in the owner's context). Deliberately SEPARATE from setRolePermissions so the built-in role
     * editor — which never carries connector grants — can't wipe them. Full-replace within the
     * connector category only (leaves built-in perms untouched); idempotent (dedupes the input).
     * Accepts the same [{permission, formId?}] shape as setRolePermissions and filters to valid
     * connector grants itself, so a caller can pass a mixed permission list to both methods.
     */
    public function setConnectorGrants(string $roleId, array $grants, bool $actorIsOwner = false): void
    {
        if (!$actorIsOwner) {
            throw new \RuntimeException('Only the app owner can grant connector capabilities');
        }
        $role = $this->getRole($roleId);
        if (!$role) {
            throw new \RuntimeException('Role not found');
        }
        if (($role['isSystem'] ?? false) && ($role['name'] ?? '') === 'Owner') {
            throw new \RuntimeException('The Owner role cannot be modified');
        }

        // Validate + dedupe (connector grants are app-scoped → form_id NULL).
        $valid = [];
        foreach ($grants as $g) {
            $perm = is_array($g) ? (string) ($g['permission'] ?? '') : (string) $g;
            if (AppPermissions::isConnectorGrant($perm)) {
                $valid[$perm] = true;
            }
        }

        $inTransaction = $this->mysql->inTransaction();
        if (!$inTransaction) {
            $this->mysql->beginTransaction();
        }
        try {
            $this->mysql->prepare("DELETE FROM app_role_permissions WHERE role_id = :role_id AND permission LIKE 'connector.%'")
                ->execute(['role_id' => $roleId]);
            $ins = $this->mysql->prepare("
                INSERT INTO app_role_permissions (id, role_id, form_id, permission)
                VALUES (:id, :role_id, NULL, :permission)
            ");
            foreach (array_keys($valid) as $perm) {
                $ins->execute(['id' => $this->generateUuid(), 'role_id' => $roleId, 'permission' => $perm]);
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

    public function updateAppUser(string $appUserId, array $data, ?string $actorUserId = null, ?string $appId = null): bool
    {
        // Prevent modifying the app owner's role or status
        $ownerCheck = $this->mysql->prepare("
            SELECT au.user_id, au.app_id, a.owner_id FROM app_users au
            JOIN apps a ON a.id = au.app_id
            WHERE au.id = :id
        ");
        $ownerCheck->execute(['id' => $appUserId]);
        $ownerRow = $ownerCheck->fetch();
        if ($ownerRow && $ownerRow['user_id'] === $ownerRow['owner_id']) {
            if (isset($data['roleId'])) {
                throw new \RuntimeException('Cannot change the app owner\'s role');
            }
            if (isset($data['status']) && $data['status'] !== 'active') {
                throw new \RuntimeException('Cannot suspend or deactivate the app owner');
            }
        }

        // Prevent assigning system roles (Owner) to non-owner users
        if (isset($data['roleId']) && $ownerRow) {
            $roleCheck = $this->mysql->prepare("SELECT name, is_system FROM app_roles WHERE id = :id AND app_id = :app_id");
            $roleCheck->execute(['id' => $data['roleId'], 'app_id' => $ownerRow['app_id']]);
            $roleRow = $roleCheck->fetch();
            if ($roleRow && (int)$roleRow['is_system'] === 1 && $roleRow['name'] === 'Owner') {
                throw new \RuntimeException('Cannot assign the Owner role');
            }
        }

        // Privilege ceiling: only the app owner may assign a role that grants any
        // app-level permission. Otherwise a delegated MANAGE_USERS holder could move
        // a confederate (or themselves via a second account) into an app-admin role.
        if (isset($data['roleId']) && $actorUserId !== null && $appId !== null) {
            if (!$this->isAppOwner($appId, $actorUserId) && $this->roleGrantsAppLevel($data['roleId'])) {
                throw new \RuntimeException('Only the app owner can assign roles with app-level permissions');
            }
        }

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
        // Check if user is the app owner (by owner_id, not role name)
        $stmt = $this->mysql->prepare("
            SELECT au.*, a.owner_id
            FROM app_users au
            JOIN apps a ON a.id = au.app_id
            WHERE au.id = :id
        ");
        $stmt->execute(['id' => $appUserId]);
        $row = $stmt->fetch();

        if (!$row) {
            return false;
        }

        if ($row['user_id'] === $row['owner_id']) {
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
        // Prevent inviting users with the Owner system role
        $roleCheck = $this->mysql->prepare("SELECT name, is_system FROM app_roles WHERE id = :id AND app_id = :app_id");
        $roleCheck->execute(['id' => $roleId, 'app_id' => $appId]);
        $roleRow = $roleCheck->fetch();
        if ($roleRow && (int)$roleRow['is_system'] === 1 && $roleRow['name'] === 'Owner') {
            throw new \RuntimeException('Cannot invite users to the Owner role');
        }

        // Privilege ceiling: only the app owner may invite into a role that grants
        // app-level permissions (mirrors updateAppUser — closes the invite escalation path).
        if (!$this->isAppOwner($appId, $invitedBy) && $this->roleGrantsAppLevel($roleId)) {
            throw new \RuntimeException('Only the app owner can invite users to roles with app-level permissions');
        }

        // Check if email is already a member
        $stmt = $this->mysql->prepare("
            SELECT au.id FROM app_users au
            JOIN users u ON u.id = au.user_id
            WHERE au.app_id = :app_id AND u.email = :email
        ");
        $stmt->execute(['app_id' => $appId, 'email' => $email]);
        if ($stmt->fetch()) {
            throw new \RuntimeException('This user is already a member of the app');
        }

        // Check for existing pending invitation
        $stmt = $this->mysql->prepare("
            SELECT id FROM app_invitations
            WHERE app_id = :app_id AND email = :email AND status = 'pending' AND expires_at > NOW()
        ");
        $stmt->execute(['app_id' => $appId, 'email' => $email]);
        if ($stmt->fetch()) {
            throw new \RuntimeException('A pending invitation already exists for this email');
        }

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

    /**
     * Self-register the authenticated user into an app (when the app allows it).
     * Resolves the role from the app's configured default, else the lowest
     * non-Owner role. Status is 'pending' when the app requires approval, else
     * 'active'. Idempotent: returns the existing membership status if already a
     * member.
     *
     * @return array{appId:string,userId:string,roleId?:string,status:string}
     */
    public function selfRegister(string $appId, string $userId, ?string $defaultRoleId, bool $requireApproval): array
    {
        $stmt = $this->mysql->prepare("SELECT id, status FROM app_users WHERE app_id = :app_id AND user_id = :user_id");
        $stmt->execute(['app_id' => $appId, 'user_id' => $userId]);
        $existing = $stmt->fetch();
        if ($existing) {
            return ['appId' => $appId, 'userId' => $userId, 'status' => (string) $existing['status']];
        }

        // Resolve the role to assign.
        $roleId = null;
        if ($defaultRoleId && $this->roleBelongsToApp($defaultRoleId, $appId)) {
            // Never let a self-registrant be assigned the protected Owner system role,
            // even if the app's defaultRoleId is misconfigured to point at it (mirrors
            // the guard in createInvitation/updateAppUser). Fall through to the
            // least-privilege auto-pick below in that case.
            $oCheck = $this->mysql->prepare("SELECT name, is_system FROM app_roles WHERE id = :id AND app_id = :app_id");
            $oCheck->execute(['id' => $defaultRoleId, 'app_id' => $appId]);
            $oRow = $oCheck->fetch();
            $isOwnerRole = $oRow && (int)$oRow['is_system'] === 1 && $oRow['name'] === 'Owner';
            if (!$isOwnerRole) {
                $roleId = $defaultRoleId;
            }
        }
        if (!$roleId) {
            // Pick the LEAST-privileged role (convention: Owner sort_order=0 is
            // most privileged, so lowest privilege = highest sort_order). Prefer
            // the built-in 'Member', then the highest-sort_order system role.
            // Earlier this ordered ASC and silently handed new members the Admin
            // role — a privilege-escalation bug.
            $rStmt = $this->mysql->prepare("
                SELECT id FROM app_roles
                WHERE app_id = :app_id AND NOT (is_system = 1 AND name = 'Owner')
                ORDER BY (is_system = 1 AND name = 'Member') DESC, is_system DESC, sort_order DESC
                LIMIT 1
            ");
            $rStmt->execute(['app_id' => $appId]);
            $r = $rStmt->fetch();
            $roleId = $r['id'] ?? null;
        }
        if (!$roleId) {
            throw new \RuntimeException('This app has no role available for new members');
        }

        $status = $requireApproval ? 'pending' : 'active';
        try {
            $stmt = $this->mysql->prepare("
                INSERT INTO app_users (id, app_id, user_id, role_id, status, joined_at)
                VALUES (:id, :app_id, :user_id, :role_id, :status, :joined_at)
            ");
            $stmt->execute([
                'id' => $this->generateUuid(),
                'app_id' => $appId,
                'user_id' => $userId,
                'role_id' => $roleId,
                'status' => $status,
                'joined_at' => date('Y-m-d H:i:s'),
            ]);
        } catch (\PDOException $e) {
            // Lost a race with a concurrent join — return the existing membership.
            if (str_contains($e->getMessage(), '1062') || str_contains($e->getMessage(), 'Duplicate entry')) {
                $existing2 = $this->getAppUser($appId, $userId);
                return ['appId' => $appId, 'userId' => $userId, 'status' => (string) ($existing2['status'] ?? 'active')];
            }
            throw $e;
        }

        return ['appId' => $appId, 'userId' => $userId, 'roleId' => $roleId, 'status' => $status];
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

        // Verify the authenticated user's email matches the invitation target
        $userStmt = $this->mysql->prepare("SELECT email FROM users WHERE id = :user_id");
        $userStmt->execute(['user_id' => $userId]);
        $userRow = $userStmt->fetch();
        if (!$userRow || strtolower(trim($userRow['email'])) !== strtolower(trim($invitation['email']))) {
            throw new \RuntimeException('This invitation was sent to a different email address');
        }

        $this->mysql->beginTransaction();
        try {
            // Atomically mark invitation as accepted (prevents race condition with concurrent accepts)
            $stmt = $this->mysql->prepare("UPDATE app_invitations SET status = 'accepted' WHERE id = :id AND status = 'pending'");
            $stmt->execute(['id' => $invitation['id']]);
            if ($stmt->rowCount() === 0) {
                $this->mysql->rollBack();
                throw new \RuntimeException('Invitation has already been used');
            }

            // Check if user is already a member
            $stmt = $this->mysql->prepare("SELECT id FROM app_users WHERE app_id = :app_id AND user_id = :user_id");
            $stmt->execute(['app_id' => $invitation['app_id'], 'user_id' => $userId]);
            if ($stmt->fetch()) {
                $this->mysql->rollBack();
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

    /**
     * List the app_user IDs that are members of a group (with name/email for display).
     */
    public function getGroupMembers(string $groupId): array
    {
        $stmt = $this->mysql->prepare("
            SELECT m.app_user_id, u.name AS user_name, u.email
            FROM app_user_group_members m
            JOIN app_users au ON au.id = m.app_user_id
            JOIN users u ON u.id = au.user_id
            WHERE m.group_id = :group_id
            ORDER BY u.name ASC
        ");
        $stmt->execute(['group_id' => $groupId]);

        $members = [];
        while ($row = $stmt->fetch()) {
            $members[] = [
                'appUserId' => $row['app_user_id'],
                'name' => $row['user_name'],
                'email' => $row['email'],
            ];
        }
        return $members;
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

    /**
     * The connector.<id>* grant PATTERNS this user holds in the app (audit SEC-001):
     * the owner is ['*']; a member gets their role's connector grants verbatim
     * (exact command, wildcard connector.<id>.*, or bare connector.<id>). Empty = no
     * access. The DESKTOP enforces these patterns on its local loopback via the
     * capability token minted from them — one grant model for local AND relay.
     */
    public function getUserConnectorGrants(string $appId, string $userId, string $connectorId): array
    {
        if ($this->isAppOwner($appId, $userId)) {
            return ['*'];
        }
        $stmt = $this->mysql->prepare("
            SELECT DISTINCT arp.permission
            FROM app_users au
            JOIN app_role_permissions arp ON arp.role_id = au.role_id
            WHERE au.app_id = :a AND au.user_id = :u AND au.status = 'active'
              AND (arp.permission = :bare OR arp.permission LIKE :prefix)
        ");
        $stmt->execute([
            'a' => $appId,
            'u' => $userId,
            'bare' => 'connector.' . $connectorId,
            'prefix' => 'connector.' . $connectorId . '.%',
        ]);
        return array_values(array_map(static fn (array $r) => (string) $r['permission'], $stmt->fetchAll()));
    }

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

        // Owner always has all permissions (check via apps.owner_id, not role name)
        $ownerStmt = $this->mysql->prepare("SELECT owner_id FROM apps WHERE id = :app_id");
        $ownerStmt->execute(['app_id' => $appId]);
        $appRow = $ownerStmt->fetch();
        if ($appRow && $appRow['owner_id'] === $userId) {
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

        // Owner gets all permissions (check via apps.owner_id, not role name)
        $ownerStmt = $this->mysql->prepare("SELECT owner_id FROM apps WHERE id = :app_id");
        $ownerStmt->execute(['app_id' => $appId]);
        $appRow = $ownerStmt->fetch();
        if ($appRow && $appRow['owner_id'] === $userId) {
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

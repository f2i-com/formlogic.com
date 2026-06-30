<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Services\AppUserService;
use FormLogic\Services\AppService;
use FormLogic\Services\AuditService;
use FormLogic\Services\EmailService;
use FormLogic\Constants\AppPermissions;
use FormLogic\Helpers\IpResolver;
use FormLogic\Controllers\Concerns\JsonResponseTrait;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

class AppUserController
{
    use JsonResponseTrait;

    private AppUserService $appUserService;
    private AppService $appService;
    private ?AuditService $auditService;
    private ?EmailService $emailService;

    public function __construct(AppUserService $appUserService, AppService $appService, ?AuditService $auditService = null, ?EmailService $emailService = null)
    {
        $this->appUserService = $appUserService;
        $this->appService = $appService;
        $this->auditService = $auditService;
        $this->emailService = $emailService;
    }

    private function requireAuth(Request $request): ?string
    {
        $userId = $request->getAttribute('userId');
        return $userId ?: null;
    }

    private function requirePermission(string $appId, string $userId, string $permission): bool
    {
        return $this->appUserService->hasPermission($appId, $userId, $permission);
    }

    // Roles

    public function listRoles(Request $request, Response $response, array $args): Response
    {
        $userId = $this->requireAuth($request);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $appId = $args['appId'];
        if (!$this->requirePermission($appId, $userId, AppPermissions::MANAGE_ROLES)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Permission denied'], 403);
        }

        $roles = $this->appUserService->getRoles($appId);
        return $this->jsonResponse($response, ['roles' => $roles]);
    }

    public function createRole(Request $request, Response $response, array $args): Response
    {
        $userId = $this->requireAuth($request);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $appId = $args['appId'];
        if (!$this->requirePermission($appId, $userId, AppPermissions::MANAGE_ROLES)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Permission denied'], 403);
        }

        $data = $request->getParsedBody();
        if (empty($data['name'])) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Role name is required'], 400);
        }

        try {
            $role = $this->appUserService->createRole($appId, $data);
            $this->audit($request, 'role.create', 'role', $role['id'] ?? '', ['appId' => $appId]);
            return $this->jsonResponse($response, ['role' => $role], 201);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    public function updateRole(Request $request, Response $response, array $args): Response
    {
        $userId = $this->requireAuth($request);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $appId = $args['appId'];
        if (!$this->requirePermission($appId, $userId, AppPermissions::MANAGE_ROLES)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Permission denied'], 403);
        }

        if (!$this->appUserService->roleBelongsToApp($args['roleId'], $appId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Role not found'], 404);
        }

        $data = $request->getParsedBody() ?? [];

        try {
            $this->appUserService->updateRole($args['roleId'], $data);
            $this->audit($request, 'role.update', 'role', $args['roleId'], ['appId' => $appId]);
            $roles = $this->appUserService->getRoles($appId);
            return $this->jsonResponse($response, ['roles' => $roles]);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    public function deleteRole(Request $request, Response $response, array $args): Response
    {
        $userId = $this->requireAuth($request);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $appId = $args['appId'];
        if (!$this->requirePermission($appId, $userId, AppPermissions::MANAGE_ROLES)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Permission denied'], 403);
        }

        if (!$this->appUserService->roleBelongsToApp($args['roleId'], $appId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Role not found'], 404);
        }

        try {
            $this->appUserService->deleteRole($args['roleId']);
            $this->audit($request, 'role.delete', 'role', $args['roleId'], ['appId' => $appId]);
            return $this->jsonResponse($response, ['success' => true, 'message' => 'Role deleted']);
        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    // Permissions

    public function getPermissions(Request $request, Response $response, array $args): Response
    {
        $userId = $this->requireAuth($request);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $appId = $args['appId'];
        if (!$this->requirePermission($appId, $userId, AppPermissions::MANAGE_ROLES)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Permission denied'], 403);
        }

        if (!$this->appUserService->roleBelongsToApp($args['roleId'], $appId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Role not found'], 404);
        }

        $permissions = $this->appUserService->getRolePermissions($args['roleId']);
        return $this->jsonResponse($response, ['permissions' => $permissions]);
    }

    public function setPermissions(Request $request, Response $response, array $args): Response
    {
        $userId = $this->requireAuth($request);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $appId = $args['appId'];
        if (!$this->requirePermission($appId, $userId, AppPermissions::MANAGE_ROLES)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Permission denied'], 403);
        }

        if (!$this->appUserService->roleBelongsToApp($args['roleId'], $appId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Role not found'], 404);
        }

        $data = $request->getParsedBody();
        if (!isset($data['permissions']) || !is_array($data['permissions'])) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'permissions array is required'], 400);
        }

        try {
            $actorIsOwner = $this->appUserService->isAppOwner($appId, $userId);
            $this->appUserService->setRolePermissions($args['roleId'], $data['permissions'], $actorIsOwner);
            $this->audit($request, 'permission.update', 'role', $args['roleId'], ['appId' => $appId]);
            $permissions = $this->appUserService->getRolePermissions($args['roleId']);
            return $this->jsonResponse($response, ['permissions' => $permissions]);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    // Users

    public function listUsers(Request $request, Response $response, array $args): Response
    {
        $userId = $this->requireAuth($request);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $appId = $args['appId'];
        if (!$this->requirePermission($appId, $userId, AppPermissions::MANAGE_USERS)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Permission denied'], 403);
        }

        $users = $this->appUserService->getAppUsers($appId);
        return $this->jsonResponse($response, ['users' => $users, 'count' => count($users)]);
    }

    public function updateUser(Request $request, Response $response, array $args): Response
    {
        $userId = $this->requireAuth($request);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $appId = $args['appId'];
        if (!$this->requirePermission($appId, $userId, AppPermissions::MANAGE_USERS)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Permission denied'], 403);
        }

        $data = $request->getParsedBody() ?? [];

        if (!$this->appUserService->appUserBelongsToApp($args['id'], $appId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'User not found'], 404);
        }

        if (isset($data['roleId']) && !$this->appUserService->roleBelongsToApp($data['roleId'], $appId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Role not found'], 404);
        }

        if (isset($data['status'])) {
            $allowedStatuses = ['active', 'suspended'];
            if (!in_array($data['status'], $allowedStatuses, true)) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'Invalid status. Allowed: active, suspended'], 400);
            }
        }

        try {
            $this->appUserService->updateAppUser($args['id'], $data, $userId, $appId);
            $users = $this->appUserService->getAppUsers($appId);
            return $this->jsonResponse($response, ['users' => $users]);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    public function removeUser(Request $request, Response $response, array $args): Response
    {
        $userId = $this->requireAuth($request);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $appId = $args['appId'];
        if (!$this->requirePermission($appId, $userId, AppPermissions::MANAGE_USERS)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Permission denied'], 403);
        }

        if (!$this->appUserService->appUserBelongsToApp($args['id'], $appId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'User not found'], 404);
        }

        try {
            $this->appUserService->removeAppUser($args['id']);
            $this->audit($request, 'user.remove', 'app', $appId, ['appUserId' => $args['id']]);
            return $this->jsonResponse($response, ['success' => true, 'message' => 'User removed']);
        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    // Invitations

    public function listInvitations(Request $request, Response $response, array $args): Response
    {
        $userId = $this->requireAuth($request);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $appId = $args['appId'];
        if (!$this->requirePermission($appId, $userId, AppPermissions::MANAGE_USERS)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Permission denied'], 403);
        }

        $invitations = $this->appUserService->getInvitations($appId);
        return $this->jsonResponse($response, ['invitations' => $invitations]);
    }

    public function createInvitation(Request $request, Response $response, array $args): Response
    {
        $userId = $this->requireAuth($request);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $appId = $args['appId'];
        if (!$this->requirePermission($appId, $userId, AppPermissions::MANAGE_USERS)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Permission denied'], 403);
        }

        $data = $request->getParsedBody();
        if (empty($data['email']) || empty($data['roleId'])) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Email and roleId are required'], 400);
        }

        if (!filter_var($data['email'], FILTER_VALIDATE_EMAIL)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Invalid email format'], 400);
        }

        if (!$this->appUserService->roleBelongsToApp($data['roleId'], $appId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Role not found'], 404);
        }

        try {
            $invitation = $this->appUserService->createInvitation($appId, $data['email'], $data['roleId'], $userId);
            $this->audit($request, 'user.invite', 'app', $appId, ['email' => $data['email']]);

            // Best-effort: email the accept link. The UI also surfaces a copyable
            // link, so onboarding still works if email isn't configured.
            if ($this->emailService !== null && !empty($invitation['token'])) {
                try {
                    // SECURITY: build the accept-link host from a server-trusted
                    // source only (never the raw Origin header) so the invite
                    // token can't be funneled to an attacker domain.
                    $origin = \FormLogic\Helpers\AppUrl::frontendBase($request);
                    $app = $this->appService->getApp($appId);
                    $rawAppName = (string) ($app['name'] ?? 'an app');
                    $appName = htmlspecialchars($rawAppName, ENT_QUOTES); // for the HTML body only
                    $link = htmlspecialchars($origin . '/accept-invite?token=' . $invitation['token'], ENT_QUOTES);
                    $html = "<p>You've been invited to join <strong>{$appName}</strong> on FormLogic.</p>"
                        . "<p><a href=\"{$link}\">Accept your invitation</a></p>"
                        . "<p>Sign in (or create an account) with this email address to join. This invitation expires in 7 days.</p>";
                    // Subject is plaintext — use the raw name so HTML entities don't render literally.
                    $this->emailService->send((string) $data['email'], "You're invited to {$rawAppName}", $html);
                } catch (\Throwable $e) {
                    // Email failure must not fail invitation creation.
                }
            }

            return $this->jsonResponse($response, ['invitation' => $invitation], 201);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    public function acceptInvitation(Request $request, Response $response): Response
    {
        $userId = $this->requireAuth($request);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $data = $request->getParsedBody();
        if (empty($data['token'])) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Invitation token is required'], 400);
        }

        try {
            $result = $this->appUserService->acceptInvitation($data['token'], $userId);
            return $this->jsonResponse($response, ['success' => true, 'membership' => $result]);
        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    public function revokeInvitation(Request $request, Response $response, array $args): Response
    {
        $userId = $this->requireAuth($request);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $appId = $args['appId'];
        if (!$this->requirePermission($appId, $userId, AppPermissions::MANAGE_USERS)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Permission denied'], 403);
        }

        if (!$this->appUserService->invitationBelongsToApp($args['id'], $appId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Invitation not found'], 404);
        }

        $this->appUserService->revokeInvitation($args['id']);
        return $this->jsonResponse($response, ['success' => true, 'message' => 'Invitation revoked']);
    }

    // Groups

    public function listGroups(Request $request, Response $response, array $args): Response
    {
        $userId = $this->requireAuth($request);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $appId = $args['appId'];
        if (!$this->requirePermission($appId, $userId, AppPermissions::MANAGE_USERS)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Permission denied'], 403);
        }

        $groups = $this->appUserService->getGroups($appId);
        return $this->jsonResponse($response, ['groups' => $groups]);
    }

    public function createGroup(Request $request, Response $response, array $args): Response
    {
        $userId = $this->requireAuth($request);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $appId = $args['appId'];
        if (!$this->requirePermission($appId, $userId, AppPermissions::MANAGE_USERS)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Permission denied'], 403);
        }

        $data = $request->getParsedBody();
        if (empty($data['name'])) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Group name is required'], 400);
        }

        try {
            $group = $this->appUserService->createGroup($appId, $data);
            return $this->jsonResponse($response, ['group' => $group], 201);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    public function updateGroup(Request $request, Response $response, array $args): Response
    {
        $userId = $this->requireAuth($request);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $appId = $args['appId'];
        if (!$this->requirePermission($appId, $userId, AppPermissions::MANAGE_USERS)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Permission denied'], 403);
        }

        if (!$this->appUserService->groupBelongsToApp($args['id'], $appId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Group not found'], 404);
        }

        $data = $request->getParsedBody() ?? [];
        $this->appUserService->updateGroup($args['id'], $data);
        return $this->jsonResponse($response, ['success' => true]);
    }

    public function deleteGroup(Request $request, Response $response, array $args): Response
    {
        $userId = $this->requireAuth($request);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $appId = $args['appId'];
        if (!$this->requirePermission($appId, $userId, AppPermissions::MANAGE_USERS)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Permission denied'], 403);
        }

        if (!$this->appUserService->groupBelongsToApp($args['id'], $appId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Group not found'], 404);
        }

        $this->appUserService->deleteGroup($args['id']);
        return $this->jsonResponse($response, ['success' => true, 'message' => 'Group deleted']);
    }

    public function listGroupMembers(Request $request, Response $response, array $args): Response
    {
        $userId = $this->requireAuth($request);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $appId = $args['appId'];
        if (!$this->requirePermission($appId, $userId, AppPermissions::MANAGE_USERS)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Permission denied'], 403);
        }

        if (!$this->appUserService->groupBelongsToApp($args['id'], $appId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Group not found'], 404);
        }

        $members = $this->appUserService->getGroupMembers($args['id']);
        return $this->jsonResponse($response, ['members' => $members]);
    }

    public function addGroupMember(Request $request, Response $response, array $args): Response
    {
        $userId = $this->requireAuth($request);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $appId = $args['appId'];
        if (!$this->requirePermission($appId, $userId, AppPermissions::MANAGE_USERS)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Permission denied'], 403);
        }

        if (!$this->appUserService->groupBelongsToApp($args['id'], $appId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Group not found'], 404);
        }

        if (!$this->appUserService->appUserBelongsToApp($args['memberId'], $appId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'User not found'], 404);
        }

        $this->appUserService->addGroupMember($args['id'], $args['memberId']);
        return $this->jsonResponse($response, ['success' => true]);
    }

    public function removeGroupMember(Request $request, Response $response, array $args): Response
    {
        $userId = $this->requireAuth($request);
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $appId = $args['appId'];
        if (!$this->requirePermission($appId, $userId, AppPermissions::MANAGE_USERS)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Permission denied'], 403);
        }

        if (!$this->appUserService->groupBelongsToApp($args['id'], $appId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Group not found'], 404);
        }

        if (!$this->appUserService->appUserBelongsToApp($args['memberId'], $appId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'User not found'], 404);
        }

        $this->appUserService->removeGroupMember($args['id'], $args['memberId']);
        return $this->jsonResponse($response, ['success' => true]);
    }

    private function audit(Request $request, string $action, string $resourceType, string $resourceId, array $details = []): void
    {
        if ($this->auditService === null) return;
        $userId = $request->getAttribute('userId');
        $ip = IpResolver::fromEnvironment()->getClientIp($request);
        $this->auditService->log($action, $resourceType, $resourceId, $userId, $ip, $details);
    }
}

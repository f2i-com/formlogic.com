<?php

declare(strict_types=1);

namespace FormLogic\Constants;

class AppPermissions
{
    // App-level permissions
    public const MANAGE_APP = 'manage_app';
    public const MANAGE_USERS = 'manage_users';
    public const MANAGE_ROLES = 'manage_roles';
    public const VIEW_ANALYTICS = 'view_analytics';

    // Flow execution (audit FL-AUTH-001): required for the app-runtime flow surface —
    // definitions, reserve/claim/complete, queued-run listing and the shared flow-KV store.
    // Stored app-level (form_id NULL) but deliberately NOT in APP_LEVEL: flows execute with
    // the member's own session (every formlogic.* write still passes the permission-checked
    // APIs), so granting it is not an admin-style escalation and must not make a role
    // unassignable for delegated MANAGE_USERS holders (see AppUserService::roleGrantsAppLevel).
    public const EXECUTE_FLOWS = 'execute_flows';

    // Per-form permissions
    public const SUBMIT_RESPONSES = 'submit_responses';
    public const VIEW_OWN_RESPONSES = 'view_own_responses';
    public const VIEW_ALL_RESPONSES = 'view_all_responses';
    public const EDIT_RESPONSES = 'edit_responses';
    public const DELETE_RESPONSES = 'delete_responses';
    public const EXPORT_RESPONSES = 'export_responses';

    public const APP_LEVEL = [
        self::MANAGE_APP,
        self::MANAGE_USERS,
        self::MANAGE_ROLES,
        self::VIEW_ANALYTICS,
    ];

    public const FORM_LEVEL = [
        self::SUBMIT_RESPONSES,
        self::VIEW_OWN_RESPONSES,
        self::VIEW_ALL_RESPONSES,
        self::EDIT_RESPONSES,
        self::DELETE_RESPONSES,
        self::EXPORT_RESPONSES,
    ];

    public const ALL = [
        self::MANAGE_APP,
        self::MANAGE_USERS,
        self::MANAGE_ROLES,
        self::VIEW_ANALYTICS,
        self::EXECUTE_FLOWS,
        self::SUBMIT_RESPONSES,
        self::VIEW_OWN_RESPONSES,
        self::VIEW_ALL_RESPONSES,
        self::EDIT_RESPONSES,
        self::DELETE_RESPONSES,
        self::EXPORT_RESPONSES,
    ];

    /**
     * Connector capability grants live alongside the built-ins in app_role_permissions but are NOT in
     * ::ALL — they're dynamic (per installed connector). Valid forms (see ConnectorCommandController):
     *   connector.<id>            — every command on the connector
     *   connector.<id>.*          — wildcard, same
     *   connector.<id>.<command>  — one command (command may be dotted, e.g. call.operatorSpeak)
     * Bounded to the column width (VARCHAR(191)) so a grant can never be stored truncated.
     */
    public static function isConnectorGrant(string $permission): bool
    {
        return strlen($permission) <= 191
            && preg_match('/^connector\.[a-z0-9][a-z0-9_-]{0,62}(\.(\*|[A-Za-z0-9][A-Za-z0-9_.-]{0,119}))?$/', $permission) === 1;
    }
}

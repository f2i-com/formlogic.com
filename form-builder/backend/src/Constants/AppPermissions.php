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
        self::SUBMIT_RESPONSES,
        self::VIEW_OWN_RESPONSES,
        self::VIEW_ALL_RESPONSES,
        self::EDIT_RESPONSES,
        self::DELETE_RESPONSES,
        self::EXPORT_RESPONSES,
    ];
}

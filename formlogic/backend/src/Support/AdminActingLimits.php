<?php

declare(strict_types=1);

namespace FormLogic\Support;

use FormLogic\Constants\AppPermissions;
use FormLogic\Services\ChatToolsService;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * The acting-as mirror leaves out every route that returns records (AdminActingAsRoutes), which
 * holds only while the routes it keeps can't open another way to them. An administrator who lets
 * themselves join an app, gives a role the answers, has a form's answers emailed to them or shows
 * them to the public reads them outside the mirror and its redaction. Those edits are the owner's
 * to make. Everything else an owner can do, an administrator acting for them still can.
 */
final class AdminActingLimits
{
    public const CODE = 'admin_acting_limit';

    /**
     * What a role may gain at an administrator's hand: none of it shows anyone else's work. The
     * two manage_ grants stay because support moves members for owners (AdminActingAsMembersTest).
     */
    private const GRANTABLE = [
        AppPermissions::SUBMIT_RESPONSES,
        AppPermissions::VIEW_OWN_RESPONSES,
        AppPermissions::EXECUTE_FLOWS,
        AppPermissions::MANAGE_USERS,
        AppPermissions::MANAGE_APP,
    ];

    public static function acting(Request $request): bool
    {
        $actor = $request->getAttribute('adminActorId');
        return is_string($actor) && $actor !== '';
    }

    public static function showsRecords(string $permission): bool
    {
        return !in_array($permission, self::GRANTABLE, true);
    }

    /**
     * Why this write of an app's settings is the owner's to make, or null. A settings write
     * replaces them all, so a key left out counts as turned off.
     *
     * @param array<string, mixed> $stored
     */
    public static function appSettingsRefusal(mixed $settings, array $stored = []): ?string
    {
        if (!is_array($settings)) {
            return null;
        }
        $opened = !empty($settings['allowSelfRegistration']) && empty($stored['allowSelfRegistration']);
        $roleChanged = !empty($settings['defaultRoleId']) && $settings['defaultRoleId'] !== ($stored['defaultRoleId'] ?? null);
        $approvalDropped = !empty($stored['allowSelfRegistration']) && !empty($stored['requireApproval']) && empty($settings['requireApproval']);
        return $opened || $roleChanged || $approvalDropped ? 'Who can join an app is the owner\'s to change' : null;
    }

    /**
     * Why this edit of a form is the owner's to make, or null.
     *
     * @param array<string, mixed> $input
     * @param array<string, mixed> $form the form as it is
     */
    public static function formRefusal(array $input, array $form): ?string
    {
        $screen = $input['customScreen'] ?? null;
        if ((is_array($screen) && ChatToolsService::widensPublicRecords($screen, $form['customScreen'] ?? null))
            || ChatToolsService::publishesPublicRecords($input, $form)) {
            return 'Showing a form\'s answers to the public is the owner\'s to turn on';
        }
        $sentTo = $input['settings']['notifications']['notificationEmail'] ?? null;
        if (is_string($sentTo) && trim($sentTo) !== '' && $sentTo !== ($form['settings']['notifications']['notificationEmail'] ?? null)) {
            return 'Where a form\'s answers are emailed is the owner\'s to set';
        }
        return null;
    }

    /**
     * Whether saving $requested gives a role a grant that shows records and that it doesn't hold.
     *
     * @param array<mixed> $requested
     * @param list<array{permission: string, formId: ?string}> $held
     */
    public static function widensRole(array $requested, array $held): bool
    {
        $key = static fn (mixed $permission, mixed $formId): string => json_encode([$permission, $formId], JSON_THROW_ON_ERROR);
        $current = array_map(static fn (array $grant): string => $key($grant['permission'], $grant['formId']), $held);
        foreach ($requested as $grant) {
            $permission = is_array($grant) ? ($grant['permission'] ?? null) : null;
            if (is_string($permission) && self::showsRecords($permission) && !in_array($key($permission, $grant['formId'] ?? null), $current, true)) {
                return true;
            }
        }
        return false;
    }
}

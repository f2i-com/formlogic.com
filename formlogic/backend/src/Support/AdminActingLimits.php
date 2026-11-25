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
 * to make. So is code: a flow, form logic or a screen runs on those records later, in someone
 * else's session, so an administrator edits it only while the owner allows it, a day at a time
 * (Settings, Security). Everything else an owner can do, an administrator acting for them still can.
 */
final class AdminActingLimits
{
    public const CODE = 'admin_acting_limit';

    /** Set by AdminActAsMiddleware: whether this owner allows code edits right now. */
    public const CODE_EDITS_ATTRIBUTE = 'adminCodeEdits';

    public const SUPPORT_ACCESS_REFUSAL = [
        'error' => true,
        'code' => 'admin_support_access_required',
        'message' => 'Editing code in this account needs the owner\'s permission. They can allow it in Settings, under Security.',
    ];

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

    public static function mayEditCode(Request $request): bool
    {
        return $request->getAttribute(self::CODE_EDITS_ATTRIBUTE) === true;
    }

    /**
     * Whether this flow edit does nothing but stop the flow. Pausing a runaway is an operator's
     * job and writes no code, so it needs no leave. Anything else in the same body does.
     */
    public static function onlyPausesFlow(mixed $body): bool
    {
        return $body === ['enabled' => false];
    }

    /**
     * The refusal to send when an administrator without the owner's permission is changing code
     * here, or null. Whole-form saves carry the code along, so only a change counts.
     *
     * @param array<string, mixed> $input
     * @param array<string, mixed> $stored
     * @return array<string, mixed>|null
     */
    public static function codeRefusal(Request $request, array $input, array $stored = []): ?array
    {
        return self::acting($request) && !self::mayEditCode($request) && self::changesCode($input, $stored)
            ? self::SUPPORT_ACCESS_REFUSAL
            : null;
    }

    /**
     * @param array<string, mixed> $input
     * @param array<string, mixed> $stored
     */
    public static function changesCode(array $input, array $stored): bool
    {
        foreach (['logicScript', 'customLogic', 'customScreen'] as $key) {
            if (!array_key_exists($key, $input)) {
                continue;
            }
            // A widget dashboard is data the server checks against the app, not code, as long as
            // it holds no code and doesn't replace any.
            if ($key === 'customScreen' && self::isDashboard($input[$key]) && !self::holdsScreenCode($stored[$key] ?? null)) {
                continue;
            }
            if (self::comparable($input[$key]) !== self::comparable($stored[$key] ?? null)) {
                return true;
            }
        }
        return false;
    }

    private static function isDashboard(mixed $screen): bool
    {
        return is_array($screen) && ($screen['kind'] ?? '') === 'dashboard' && !self::holdsScreenCode($screen);
    }

    /** The kind is only a label: renderers run a screen's code whatever it says. */
    private static function holdsScreenCode(mixed $screen): bool
    {
        if (!is_array($screen)) {
            return false;
        }
        foreach (['html', 'css', 'js', 'ts', 'files', 'entry'] as $key) {
            if (self::comparable($screen[$key] ?? null) !== null) {
                return true;
            }
        }
        return false;
    }

    /** Code as a value: no stamps, no key order, and nothing is the same as empty. */
    private static function comparable(mixed $code): mixed
    {
        if (is_string($code)) {
            return trim($code) === '' ? null : $code;
        }
        if (!is_array($code)) {
            return $code;
        }
        unset($code['_trust'], $code['_provenance']);
        $code = array_map(self::comparable(...), $code);
        if (!array_is_list($code)) {
            ksort($code);
        }
        return $code === [] ? null : $code;
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
        // Leaving the role out changes it too: joiners then get the app's Member role.
        $role = ($settings['defaultRoleId'] ?? null) ?: null;
        $roleChanged = $role !== (($stored['defaultRoleId'] ?? null) ?: null) && ($role !== null || !empty($settings['allowSelfRegistration']));
        $approvalDropped = !empty($stored['allowSelfRegistration']) && !empty($stored['requireApproval']) && empty($settings['requireApproval']);
        if ($opened || $roleChanged || $approvalDropped) {
            return 'Who can join an app is the owner\'s to change';
        }
        if (self::widensExternalApi($settings['externalApi'] ?? null, $stored['externalApi'] ?? null)) {
            return 'External API access for an app is the owner\'s to configure';
        }
        return null;
    }

    /**
     * Refuse transitioning an app to `published` while acting-as if its effective external API
     * policy exposes public routes, if open self-registration immediately admits new members
     * with a record-viewing role, or if its installed native project allows non-member visitors
     * (all of which would let an admin read private app records outside the acting-as boundary).
     *
     * @param array<string, mixed> $storedApp
     */
    public static function appPublishRefusal(
        mixed $newStatus,
        array $storedApp,
        mixed $newSettings = null,
        bool $openSelfRegShowsRecords = false,
        ?string $nativeAccess = null,
    ): ?string {
        if ($newStatus !== 'published' || ($storedApp['status'] ?? '') === 'published') {
            return null;
        }
        $settings = is_array($newSettings)
            ? $newSettings
            : (is_array($storedApp['settings'] ?? null) ? $storedApp['settings'] : []);
        $ext = \FormLogic\Services\AppService::sanitizeExternalApi($settings['externalApi'] ?? null);
        if ($ext !== null && !empty($ext['enabled']) && in_array((string) ($ext['authMode'] ?? ''), ['public', 'both'], true)) {
            return 'Publishing an app with a public external API is the owner\'s to do';
        }
        if ($openSelfRegShowsRecords) {
            return 'Publishing an app with open self-registration is the owner\'s to do';
        }
        if ($nativeAccess !== null && $nativeAccess !== 'members') {
            return 'Publishing a public native app is the owner\'s to do';
        }
        return null;
    }

    private static function widensExternalApi(mixed $incoming, mixed $stored): bool
    {
        // Normalize both sides through AppService::sanitizeExternalApi so omitted `enabled`
        // (which defaults to true on persistence) or omitted `allowedMethods` cannot bypass checks.
        $new = \FormLogic\Services\AppService::sanitizeExternalApi($incoming);
        $old = \FormLogic\Services\AppService::sanitizeExternalApi($stored);
        $newEnabled = $new !== null && !empty($new['enabled']);
        $oldEnabled = $old !== null && !empty($old['enabled']);
        if (!$newEnabled) {
            return false;
        }
        if (!$oldEnabled) {
            return true;
        }
        $newMode = strtolower(trim((string) ($new['authMode'] ?? 'api_key')));
        $oldMode = strtolower(trim((string) ($old['authMode'] ?? 'api_key')));
        if ($newMode !== $oldMode && in_array($newMode, ['public', 'both'], true)) {
            return true;
        }
        $normList = static function (mixed $v): array {
            if (!is_array($v)) {
                return [];
            }
            $out = [];
            foreach ($v as $item) {
                if (is_string($item) && trim($item) !== '') {
                    $out[] = trim($item);
                }
            }
            sort($out);
            return array_values(array_unique($out));
        };
        $newMethods = $normList($new['allowedMethods'] ?? null);
        $oldMethods = $normList($old['allowedMethods'] ?? null);
        if ($oldMethods !== [] && ($newMethods === [] || array_diff($newMethods, $oldMethods) !== [])) {
            return true;
        }
        $newAllowed = $normList($new['allowedPaths'] ?? null);
        $oldAllowed = $normList($old['allowedPaths'] ?? null);
        if ($oldAllowed !== [] && ($newAllowed === [] || array_diff($newAllowed, $oldAllowed) !== [])) {
            return true;
        }
        $newBlocked = $normList($new['blockedPaths'] ?? null);
        $oldBlocked = $normList($old['blockedPaths'] ?? null);
        if (array_diff($oldBlocked, $newBlocked) !== []) {
            return true;
        }
        $newCors = $normList($new['corsOrigins'] ?? null);
        $oldCors = $normList($old['corsOrigins'] ?? null);
        if (array_diff($newCors, $oldCors) !== []) {
            return true;
        }
        // Changing defaultPrefix can shift public callers onto previously unexposed container routes;
        // raising rateLimitPerMinute widens public throughput limits.
        $newPrefix = (string) ($new['defaultPrefix'] ?? '');
        $oldPrefix = (string) ($old['defaultPrefix'] ?? '');
        if ($newPrefix !== $oldPrefix) {
            return true;
        }
        $newRate = (int) ($new['rateLimitPerMinute'] ?? 60);
        $oldRate = (int) ($old['rateLimitPerMinute'] ?? 60);
        if ($newRate > $oldRate) {
            return true;
        }
        return false;
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

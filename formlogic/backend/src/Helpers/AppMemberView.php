<?php

declare(strict_types=1);

namespace FormLogic\Helpers;

use FormLogic\Constants\AppPermissions;

/**
 * What a non-owner member may see of an app's config: the runtime (AppPublicController::getApp)
 * and the app list and detail (AppController) narrow it the same way, so a member reads no form
 * id, field name or query of a form they cannot use through any of them.
 */
final class AppMemberView
{
    /**
     * Whether an app member should receive $formId's schema in the runtime config. True if they hold
     * any per-form permission on it (submit/view/edit/delete/export/analytics), or an app-wide grant
     * that covers all forms (manage_app / view_analytics / an app-level form permission). The owner's
     * permission set is ALL, so owners always pass.
     */
    public static function canSeeForm(array $permissions, string $formId): bool
    {
        $appLevel = $permissions['appLevel'] ?? [];
        if (in_array(AppPermissions::MANAGE_APP, $appLevel, true) || in_array(AppPermissions::VIEW_ANALYTICS, $appLevel, true)) {
            return true;
        }
        $relevant = array_merge(AppPermissions::FORM_LEVEL, [AppPermissions::VIEW_ANALYTICS]);
        $formLevel = $permissions['formLevel'][$formId] ?? [];
        foreach ($relevant as $perm) {
            if (in_array($perm, $appLevel, true) || in_array($perm, $formLevel, true)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Narrow an app's payload to what a non-owner member may see, given the form ids they can access.
     * Drops nav items, dashboard widgets, and report specs bound to forms they can't use, and resets a
     * landing page that points at an inaccessible form — so no hidden form id / field name / query
     * leaks through the app config. (Custom CODE screens are owner-authored, app-wide trusted content;
     * the SDK's form context is already filtered via `forms`.)
     *
     * @param array    $safeApp
     * @param string[] $accessible
     */
    public static function narrow(array $safeApp, array $accessible): array
    {
        $ok = fn($fid) => $fid === null || $fid === '' || in_array($fid, $accessible, true);

        // Nav: accessible forms only. Custom LINK entries (kind 'link', no form
        // reference) are app-chrome the owner authored for everyone — kept.
        if (isset($safeApp['navConfig']) && is_array($safeApp['navConfig'])) {
            $safeApp['navConfig'] = array_values(array_filter(
                $safeApp['navConfig'],
                fn($item) => is_array($item) && (
                    (($item['kind'] ?? 'form') === 'link' && !isset($item['formId']))
                    || in_array($item['formId'] ?? null, $accessible, true)
                )
            ));
        }

        // Landing page: fall back to the dashboard if it targets an inaccessible form.
        if (isset($safeApp['settings']) && is_array($safeApp['settings'])) {
            $lp = $safeApp['settings']['landingPage'] ?? null;
            if (is_string($lp) && $lp !== 'dashboard' && !in_array($lp, $accessible, true)) {
                $safeApp['settings']['landingPage'] = 'dashboard';
            }
        }

        // Reports: drop chart specs whose base/join form is inaccessible; then drop document blocks
        // that referenced a dropped report.
        if (isset($safeApp['reports']) && is_array($safeApp['reports'])) {
            $specUsesAccessibleForms = function ($spec) use ($ok): bool {
                if (!is_array($spec)) { return true; }
                if (!$ok($spec['formId'] ?? null)) { return false; }
                foreach (($spec['joins'] ?? []) as $j) {
                    if (is_array($j) && !$ok($j['formId'] ?? null)) { return false; }
                }
                return true;
            };
            $keptReportIds = [];
            $charts = [];
            $docs = [];
            foreach ($safeApp['reports'] as $item) {
                if (!is_array($item)) { continue; }
                if (($item['type'] ?? null) === 'document') { $docs[] = $item; continue; }
                if ($specUsesAccessibleForms($item['spec'] ?? null)) {
                    $charts[] = $item;
                    if (isset($item['id'])) { $keptReportIds[$item['id']] = true; }
                }
            }
            foreach ($docs as &$doc) {
                if (isset($doc['blocks']) && is_array($doc['blocks'])) {
                    $doc['blocks'] = array_values(array_filter($doc['blocks'], function ($b) use ($keptReportIds) {
                        if (!is_array($b)) { return false; }
                        if (($b['kind'] ?? null) === 'report') {
                            return isset($b['reportId'], $keptReportIds[$b['reportId']]);
                        }
                        return true; // text blocks stay
                    }));
                }
            }
            unset($doc);
            $safeApp['reports'] = array_merge(array_values($charts), array_values($docs));
        }

        // Dashboard home screen: drop widgets bound to inaccessible forms.
        if (isset($safeApp['customScreen']) && is_array($safeApp['customScreen'])) {
            $cs = $safeApp['customScreen'];
            if (($cs['kind'] ?? null) === 'dashboard' && isset($cs['dashboard']['widgets']) && is_array($cs['dashboard']['widgets'])) {
                $cs['dashboard']['widgets'] = array_values(array_filter($cs['dashboard']['widgets'], function ($w) use ($ok) {
                    if (!is_array($w)) { return false; }
                    $kind = $w['kind'] ?? null;
                    if ($kind === 'report') {
                        $spec = $w['spec'] ?? null;
                        if (!is_array($spec)) { return true; }
                        if (!$ok($spec['formId'] ?? null)) { return false; }
                        foreach (($spec['joins'] ?? []) as $j) {
                            if (is_array($j) && !$ok($j['formId'] ?? null)) { return false; }
                        }
                        return true;
                    }
                    if ($kind === 'list') {
                        return $ok($w['list']['formId'] ?? null);
                    }
                    return true; // text/actions/activity derive only from accessible forms
                }));
                $safeApp['customScreen'] = $cs;
            }
        }

        return $safeApp;
    }

    /**
     * The forms a member can open in the app: visible, not a hidden data-only form, and covered by
     * one of their permissions (canSeeForm). The runtime's nav targets are these.
     *
     * @param array<int, array<string, mixed>> $appForms AppService::getAppForms rows
     * @return string[]
     */
    public static function navigableFormIds(array $appForms, array $permissions): array
    {
        $ids = [];
        foreach ($appForms as $form) {
            $settings = is_array($form['settings'] ?? null) ? $form['settings'] : [];
            if (empty($form['isVisible']) || ($settings['hidden'] ?? false) === true) {
                continue;
            }
            if (self::canSeeForm($permissions, (string) ($form['formId'] ?? ''))) {
                $ids[] = (string) $form['formId'];
            }
        }
        return $ids;
    }
}

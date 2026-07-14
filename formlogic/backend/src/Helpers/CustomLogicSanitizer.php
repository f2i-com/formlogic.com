<?php

declare(strict_types=1);

namespace FormLogic\Helpers;

/**
 * Normalizes an incoming custom app-logic bundle (app-level or form-level) to a known-safe
 * shape: only recognized hooks, string sources under a per-script cap, at most 50 scripts,
 * runtime forced to 'quickjs'. The stored bundle is never trusted — the client sandboxes it
 * and the server re-validates every submit — but a clean shape avoids storing junk and keeps
 * the payload bounded. Shared by AppController and FormController.
 */
class CustomLogicSanitizer
{
    /** Hook names the QuickJS app-logic runtime understands (mirror of the TS CustomAppLogicHookName union). */
    public const VALID_HOOKS = [
        'onAppStart', 'onScreenEnter', 'onScreenLeave', 'onButtonClick', 'onBeforeSubmit',
        'onAfterSubmit', 'onConnectorEvent', 'onSyncConflict', 'mapConnectorDataToForm', 'calculateDashboardState',
    ];

    public const MAX_SCRIPTS = 50;
    public const MAX_SOURCE_BYTES = 51200;   // 50KB per script
    public const MAX_BUNDLE_BYTES = 102400;  // 100KB total

    /** @param array<string,mixed> $bundle */
    public static function sanitize(array $bundle): array
    {
        $scriptsIn = is_array($bundle['scripts'] ?? null) ? $bundle['scripts'] : [];
        $scriptsOut = [];
        foreach ($scriptsIn as $s) {
            if (!is_array($s)) {
                continue;
            }
            $hook = $s['hook'] ?? '';
            $source = $s['source'] ?? '';
            if (!in_array($hook, self::VALID_HOOKS, true) || !is_string($source) || $source === '') {
                continue;
            }
            if (strlen($source) > self::MAX_SOURCE_BYTES) {
                continue;
            }
            $out = [
                'id' => (is_string($s['id'] ?? null) && $s['id'] !== '') ? $s['id'] : ('script_' . count($scriptsOut)),
                'hook' => $hook,
                'runtime' => 'quickjs',
                'source' => $source,
            ];
            if (isset($s['description']) && is_string($s['description'])) {
                $out['description'] = mb_substr($s['description'], 0, 500);
            }
            if (array_key_exists('enabled', $s)) {
                $out['enabled'] = (bool) $s['enabled'];
            }
            if (is_array($s['permissions'] ?? null)) {
                $out['permissions'] = array_values(array_filter($s['permissions'], 'is_string'));
            }
            if (isset($s['budgetMs']) && is_numeric($s['budgetMs'])) {
                $out['budgetMs'] = max(1, min(5000, (int) $s['budgetMs']));
            }
            $scriptsOut[] = $out;
            if (count($scriptsOut) >= self::MAX_SCRIPTS) {
                break;
            }
        }

        $result = [
            'version' => 1,
            'runtime' => 'quickjs',
            'scripts' => $scriptsOut,
        ];
        if (is_array($bundle['permissions'] ?? null)) {
            $result['permissions'] = array_values(array_filter($bundle['permissions'], 'is_string'));
        }
        if (array_key_exists('strictPermissions', $bundle)) {
            $result['strictPermissions'] = (bool) $bundle['strictPermissions'];
        }
        return $result;
    }

    /** True when the JSON-encoded bundle is within the size cap. A bundle that cannot be encoded
     *  (e.g. invalid UTF-8) is treated as over cap — it can never be stored/round-tripped safely. */
    public static function withinSizeCap(array $bundle): bool
    {
        $json = json_encode($bundle);
        return $json !== false && strlen($json) <= self::MAX_BUNDLE_BYTES;
    }
}

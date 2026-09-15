<?php

declare(strict_types=1);

namespace FormLogic\Helpers;

/**
 * Normalizes an incoming custom app-logic bundle (app-level or form-level) to a known-safe
 * shape: only recognized hooks, string sources under a per-script cap, at most 50 scripts,
 * runtime forced to 'quickjs' (a historical name kept for stored bundles; the browser host runs
 * the scripts on ZIPP), and a script's language kept (formlogic-python/1). The stored bundle is
 * never trusted — the client sandboxes it and the server re-validates every submit — but a clean
 * shape avoids storing junk and keeps the payload bounded. Shared by AppController and
 * FormController.
 *
 * A script's language follows the rule flow code nodes do (FlowLogicLanguages): exactly
 * 'javascript' or 'python', absent / null / '' meaning JavaScript. Anything else is refused
 * (InvalidArgumentException naming the script) rather than relabelled: relabelled JavaScript
 * would run a Python script as JavaScript, and a guessed Python would hide the author's typo.
 */
class CustomLogicSanitizer
{
    /** Hook names the app-logic runtime understands (mirror of the TS CustomAppLogicHookName union). */
    public const VALID_HOOKS = [
        'onAppStart', 'onScreenEnter', 'onScreenLeave', 'onButtonClick', 'onBeforeSubmit',
        'onAfterSubmit', 'onConnectorEvent', 'onSyncConflict', 'mapConnectorDataToForm', 'calculateDashboardState',
    ];

    /**
     * Script languages (formlogic-python/1). A script without one is JavaScript, which every
     * bundle saved before Python is. 'python' scripts define `def run(ctx)`.
     */
    public const LANGUAGES = ['javascript', 'python'];

    public const MAX_SCRIPTS = 50;
    public const MAX_SOURCE_BYTES = 51200;   // 50KB per script
    // 256KB total: scripts (50KB each) plus an optional pack connector driver (128KB).
    public const MAX_BUNDLE_BYTES = 262144;
    // Pack-embedded connector demo driver (client packConnectorDriver.ts DRIVER_SOURCE_MAX — keep in sync).
    public const MAX_DRIVER_BYTES = 131072;
    private const CONNECTOR_ID_PATTERN = '/^[a-z][a-z0-9_-]{0,63}$/';
    // Ids of the host's built-in browser connectors — a pack may never claim one
    // (mirror of nativeConnectorClient's BUILT_IN_CONNECTOR_IDS).
    private const RESERVED_CONNECTOR_IDS = ['device', 'vehicle', 'local_http'];

    /**
     * @param array<string,mixed> $bundle
     * @throws \InvalidArgumentException when a kept script declares a language no runtime runs
     */
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
            // Dropping the key would re-label a Python script as JavaScript, which the host would
            // then run as such; an unknown value is refused (see the class doc).
            $raw = $s['language'] ?? null;
            if ($raw !== null && $raw !== '') {
                if (!in_array($raw, self::LANGUAGES, true)) {
                    throw new \InvalidArgumentException(self::unsupportedMessage($out['id'], $raw));
                }
                $out['language'] = $raw;
            }
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
        // Pack-embedded connector driver (spec: self-contained packs). The client's
        // trusted host is the enforcement point (grant-gated demo driver, allowlisted
        // events, ZIPP sandbox); here we just keep the shape sane + bounded so an
        // owner's customLogic save can never silently DROP the pack's connector.
        $connector = self::sanitizeConnector($bundle['connector'] ?? null);
        if ($connector !== null) {
            $result['connector'] = $connector;
        }
        return $result;
    }

    /**
     * The first script in a bundle whose declared language is not exactly one LANGUAGES names
     * (absent, null and '' are JavaScript), for callers that store a bundle as written — a pack's
     * app logic, a backup restore — and must refuse what sanitize() would. A non-string value is
     * reported as its JSON text.
     *
     * @return array{scriptId: string, language: string}|null
     */
    public static function firstUnsupportedLanguage(mixed $bundle): ?array
    {
        $scripts = is_array($bundle) && is_array($bundle['scripts'] ?? null) ? $bundle['scripts'] : [];
        foreach ($scripts as $i => $script) {
            $raw = is_array($script) ? ($script['language'] ?? null) : null;
            if ($raw === null || $raw === '' || in_array($raw, self::LANGUAGES, true)) {
                continue;
            }
            $id = is_array($script) && is_string($script['id'] ?? null) && $script['id'] !== '' ? $script['id'] : ('script_' . $i);
            return ['scriptId' => $id, 'language' => is_string($raw) ? $raw : (string) json_encode($raw)];
        }
        return null;
    }

    /**
     * Refuse a bundle stored as written that holds a script in a language no runtime runs.
     * @throws \InvalidArgumentException
     */
    public static function assertSupportedLanguages(mixed $bundle): void
    {
        $unsupported = self::firstUnsupportedLanguage($bundle);
        if ($unsupported !== null) {
            throw new \InvalidArgumentException(self::unsupportedMessage($unsupported['scriptId'], $unsupported['language']));
        }
    }

    private static function unsupportedMessage(string $scriptId, mixed $language): string
    {
        $shown = is_string($language) ? $language : (string) json_encode($language);
        return "App logic script '{$scriptId}' has an unsupported language '{$shown}': use javascript or python";
    }

    /**
     * A stored bundle without the scripts in a language the caller did not declare (null =
     * JavaScript only, the reading for a caller built before Python, which would run a Python
     * script as JavaScript). A script in a language no runtime implements is never listed. The
     * rest of the bundle is unchanged. Serves GET /api/v1/app-logic (a Desktop) and the app
     * runtime config (a browser tab), both under `?languages=`.
     *
     * @param list<string>|null $languages FlowLogicLanguages::fromCaller
     */
    public static function forLanguages(mixed $bundle, ?array $languages): mixed
    {
        if (!is_array($bundle) || !is_array($bundle['scripts'] ?? null)) {
            return $bundle;
        }
        $runs = $languages ?? ['javascript'];
        $bundle['scripts'] = array_values(array_filter(
            $bundle['scripts'],
            static fn (mixed $script): bool => in_array(self::scriptLanguage($script), $runs, true)
        ));
        return $bundle;
    }

    /**
     * The language a stored script runs in: its declared one, else JavaScript. Anything else a
     * stored script holds (only a path that skipped the sanitizer can store one) comes back as
     * written, so a caller that filters by language never mistakes it for JavaScript.
     */
    public static function scriptLanguage(mixed $script): string
    {
        $raw = is_array($script) ? ($script['language'] ?? null) : null;
        if ($raw === null || $raw === '') {
            return 'javascript';
        }
        return is_string($raw) ? $raw : (string) json_encode($raw);
    }

    /**
     * Normalize a pack connector bundle ({manifest, demoDriver?}) or reject it (null).
     * Mirrors the TS ConnectorDriverManifest surface: dot-free connectorId slug,
     * bounded string lists, driver source under MAX_DRIVER_BYTES.
     *
     * @param mixed $connector
     * @return array<string,mixed>|null
     */
    public static function sanitizeConnector(mixed $connector): ?array
    {
        if (!is_array($connector) || !is_array($connector['manifest'] ?? null)) {
            return null;
        }
        $m = $connector['manifest'];
        $id = $m['connectorId'] ?? '';
        if (!is_string($id) || preg_match(self::CONNECTOR_ID_PATTERN, $id) !== 1) {
            return null;
        }
        if (in_array($id, self::RESERVED_CONNECTOR_IDS, true)) {
            return null; // reserved for a built-in browser connector
        }
        if (!is_string($m['kind'] ?? null) || ($m['kind'] ?? '') === ''
            || !is_string($m['label'] ?? null) || ($m['label'] ?? '') === '') {
            return null;
        }
        $stringList = static function (mixed $list, int $cap): ?array {
            if (!is_array($list)) {
                return null;
            }
            $out = [];
            foreach ($list as $item) {
                if (!is_string($item) || $item === '' || strlen($item) > 80) {
                    continue;
                }
                $out[] = $item;
                if (count($out) >= $cap) {
                    break;
                }
            }
            return $out;
        };
        $commands = $stringList($m['commands'] ?? null, 64);
        if ($commands === null || $commands === []) {
            return null;
        }
        $manifest = [
            'connectorId' => $id,
            'kind' => mb_substr($m['kind'], 0, 80),
            'label' => mb_substr($m['label'], 0, 120),
            'commands' => $commands,
        ];
        foreach (['journalledCommands' => 64, 'demoEvents' => 32, 'demoCeremonies' => 8] as $key => $cap) {
            $list = $stringList($m[$key] ?? null, $cap);
            if ($list !== null) {
                $manifest[$key] = $list;
            }
        }
        if (is_string($m['demoStatusDetail'] ?? null)) {
            $manifest['demoStatusDetail'] = mb_substr($m['demoStatusDetail'], 0, 300);
        }
        if (array_key_exists('captions', $m)) {
            $manifest['captions'] = (bool) $m['captions'];
        }
        $out = ['manifest' => $manifest];
        $driver = $connector['demoDriver'] ?? null;
        if (is_string($driver) && $driver !== '' && strlen($driver) <= self::MAX_DRIVER_BYTES) {
            $out['demoDriver'] = $driver;
        }
        return $out;
    }

    /** True when the JSON-encoded bundle is within the size cap. A bundle that cannot be encoded
     *  (e.g. invalid UTF-8) is treated as over cap — it can never be stored/round-tripped safely. */
    public static function withinSizeCap(array $bundle): bool
    {
        $json = json_encode($bundle);
        return $json !== false && strlen($json) <= self::MAX_BUNDLE_BYTES;
    }
}

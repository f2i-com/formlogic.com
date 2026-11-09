<?php

declare(strict_types=1);

namespace FormLogic\Services;

use InvalidArgumentException;

/**
 * The two FormLogic-only sections a SoftN app's manifest may carry, as `formlogicPlugin` is for a
 * plugin. Neither is SoftN's: the runner and the page never read them (the runtime GET strips them
 * from the page's copy), and FormLogic shows them at install review and in the app's settings.
 *
 *   "formlogicAi": {
 *     "uses": ["pictures", "picture-edits", "chat"],
 *     "purpose": "One sentence shown to the owner and the app's visitors.",
 *     "jobs": { "table": "ai_jobs", "deliver": "/api/site/ai/deliver" }
 *   }
 *   "formlogicPayments": {
 *     "purpose": "Pay 5¢ to download a logo.",
 *     "items": [ { "id": "download", "label": "Download a logo", "priceCents": 5 } ],
 *     "routes": [ "/api/download" ]
 *   }
 *
 * An app that declares either asks for FormLogic's visitors (AppVisitors): only such an app is given
 * a visitor id and the context that goes with it. Every other app's requests are exactly what they
 * were (docs/HOSTED_APPS.md, "App AI, visitors and payments").
 */
final class AppFormlogicManifest
{
    /** What an app may use FormLogic's AI for, and the job kind each allows. */
    public const AI_USES = ['pictures' => 'picture', 'picture-edits' => 'edit', 'chat' => 'chat'];
    /** A jobs table the runner's record events can name (record-events.mjs, record_events.rs). */
    public const TABLE = '/^[A-Za-z][A-Za-z0-9_]{0,62}$/D';
    /** A delivery route: the site's alone (PluginService::SITE_ROUTE_PREFIX), never a page's. */
    public const SITE_ROUTE = '~^/api/site/[a-zA-Z0-9/_-]{1,150}$~D';
    public const ITEM_ID = '/^[a-z0-9][a-z0-9_-]{0,31}$/D';
    public const MAX_ITEMS = 20;
    public const MAX_ROUTES = 20;
    /** A charge an app may ask for (500¢); the administrator may hold every app to less. */
    public const MAX_PRICE_CENTS = 500;

    /**
     * Refuse a manifest whose FormLogic sections are malformed, with the reason in the owner's words.
     * A manifest without them passes untouched.
     */
    public static function validate(array $manifest): void
    {
        $ai = array_key_exists('formlogicAi', $manifest) ? self::parseAi($manifest) : null;
        $payments = array_key_exists('formlogicPayments', $manifest) ? self::parsePayments($manifest) : null;
        unset($ai, $payments);
    }

    /**
     * The app's AI declaration: {uses: list<string>, kinds: list<string>, purpose, table, deliver},
     * or null when it declares none or a malformed one (an installed app was validated already).
     */
    public static function ai(array $manifest): ?array
    {
        if (!array_key_exists('formlogicAi', $manifest)) return null;
        try { return self::parseAi($manifest); } catch (InvalidArgumentException) { return null; }
    }

    /**
     * The app's payments declaration: {purpose, items: array<id, {label, priceCents}>, routes: list},
     * or null.
     */
    public static function payments(array $manifest): ?array
    {
        if (!array_key_exists('formlogicPayments', $manifest)) return null;
        try { return self::parsePayments($manifest); } catch (InvalidArgumentException) { return null; }
    }

    /** Whether the app asks for FormLogic's visitors: it declares AI or payments. */
    public static function asksForVisitors(array $manifest): bool
    {
        return self::ai($manifest) !== null || self::payments($manifest) !== null;
    }

    /** The manifest's JSON as an array, or [] when it is not one. */
    public static function decode(?string $json): array
    {
        if (!is_string($json) || $json === '') return [];
        try { $manifest = json_decode($json, true, 64, JSON_THROW_ON_ERROR); } catch (\JsonException) { return []; }
        return is_array($manifest) ? $manifest : [];
    }

    private static function parseAi(array $manifest): array
    {
        $section = $manifest['formlogicAi'];
        $lead = 'manifest.json\'s formlogicAi';
        if (!self::isObject($section)) throw new InvalidArgumentException("{$lead} must be an object.");
        $uses = $section['uses'] ?? null;
        if (!is_array($uses) || !array_is_list($uses) || $uses === [] || count($uses) > count(self::AI_USES)) {
            throw new InvalidArgumentException("{$lead} needs \"uses\": a list of " . implode(', ', array_keys(self::AI_USES)) . '.');
        }
        foreach ($uses as $use) {
            if (!is_string($use) || !array_key_exists($use, self::AI_USES)) throw new InvalidArgumentException("{$lead} uses \"" . (is_string($use) ? mb_substr($use, 0, 40) : 'something') . '", which is not one of ' . implode(', ', array_keys(self::AI_USES)) . '.');
        }
        if (count(array_unique($uses)) !== count($uses)) throw new InvalidArgumentException("{$lead} lists a use twice.");
        $purpose = self::purpose($section['purpose'] ?? null, $lead);
        $jobs = $section['jobs'] ?? null;
        if (!self::isObject($jobs) || !is_string($jobs['table'] ?? null) || !preg_match(self::TABLE, $jobs['table']) || !is_string($jobs['deliver'] ?? null)) {
            throw new InvalidArgumentException("{$lead} needs \"jobs\": {\"table\": the table its server writes jobs into, \"deliver\": the /api/site/… route FormLogic delivers results to}.");
        }
        if (str_starts_with(strtolower($jobs['table']), 'sqlite_')) throw new InvalidArgumentException("{$lead}'s jobs table cannot be one of SQLite's own.");
        if (!preg_match(self::SITE_ROUTE, $jobs['deliver'])) throw new InvalidArgumentException("{$lead}'s deliver route must be under /api/site/, which only FormLogic itself may call.");
        $routes = self::declaredRoutes($manifest, $lead);
        if (!in_array('POST ' . $jobs['deliver'], $routes, true)) throw new InvalidArgumentException("{$lead} delivers to {$jobs['deliver']}, but the server block declares no POST route there.");
        return [
            'uses' => array_values($uses),
            'kinds' => array_values(array_map(static fn(string $use) => self::AI_USES[$use], $uses)),
            'purpose' => $purpose,
            'table' => $jobs['table'],
            'deliver' => $jobs['deliver'],
        ];
    }

    private static function parsePayments(array $manifest): array
    {
        $section = $manifest['formlogicPayments'];
        $lead = 'manifest.json\'s formlogicPayments';
        if (!self::isObject($section)) throw new InvalidArgumentException("{$lead} must be an object.");
        $purpose = self::purpose($section['purpose'] ?? null, $lead);
        $items = $section['items'] ?? null;
        if (!is_array($items) || !array_is_list($items) || $items === [] || count($items) > self::MAX_ITEMS) {
            throw new InvalidArgumentException("{$lead} needs \"items\": 1 to " . self::MAX_ITEMS . ' things it charges for, each {"id", "label", "priceCents"}.');
        }
        $parsed = [];
        foreach ($items as $item) {
            if (!self::isObject($item) || !is_string($item['id'] ?? null) || !preg_match(self::ITEM_ID, $item['id'])) {
                throw new InvalidArgumentException("{$lead}: each item's id is lower-case letters, digits, '-' and '_', up to 32.");
            }
            $label = is_string($item['label'] ?? null) ? trim($item['label']) : '';
            if ($label === '' || mb_strlen($label) > 80 || preg_match('/[\x00-\x1f\x7f]/u', $label)) throw new InvalidArgumentException("{$lead}: item {$item['id']} needs a label of 1 to 80 characters.");
            $price = $item['priceCents'] ?? null;
            if (!is_int($price) || $price < 1 || $price > self::MAX_PRICE_CENTS) throw new InvalidArgumentException("{$lead}: item {$item['id']}'s priceCents must be a whole number of cents from 1 to " . self::MAX_PRICE_CENTS . '.');
            if (isset($parsed[$item['id']])) throw new InvalidArgumentException("{$lead} lists item {$item['id']} twice.");
            $parsed[$item['id']] = ['label' => $label, 'priceCents' => $price];
        }
        $routes = $section['routes'] ?? null;
        if (!is_array($routes) || !array_is_list($routes) || $routes === [] || count($routes) > self::MAX_ROUTES) {
            throw new InvalidArgumentException("{$lead} needs \"routes\": 1 to " . self::MAX_ROUTES . ' POST routes of its server that may ask for a charge.');
        }
        $declared = self::declaredRoutes($manifest, $lead);
        foreach ($routes as $route) {
            if (!is_string($route) || !preg_match('~^/api/[a-zA-Z0-9/_-]+$~D', $route)) throw new InvalidArgumentException("{$lead}: each route is an /api/… path of its server.");
            if (str_starts_with(strtolower($route), PluginService::SITE_ROUTE_PREFIX)) throw new InvalidArgumentException("{$lead}: {$route} is under /api/site/, which a page never calls.");
            if (!in_array('POST ' . $route, $declared, true)) throw new InvalidArgumentException("{$lead} charges on {$route}, but the server block declares no POST route there.");
        }
        if (count(array_unique($routes)) !== count($routes)) throw new InvalidArgumentException("{$lead} lists a route twice.");
        return ['purpose' => $purpose, 'items' => $parsed, 'routes' => array_values($routes)];
    }

    /** "METHOD /path" for each route the server block declares; a section that needs a backend fails without one. */
    private static function declaredRoutes(array $manifest, string $lead): array
    {
        $server = $manifest['server'] ?? null;
        if (!self::isObject($server)) throw new InvalidArgumentException("{$lead} needs the app's own backend (a server block): its server is what writes jobs and answers charges.");
        $routes = [];
        foreach (is_array($server['routes'] ?? null) ? $server['routes'] : [] as $route) {
            if (is_array($route) && is_string($route['method'] ?? null) && is_string($route['path'] ?? null)) $routes[] = strtoupper($route['method']) . ' ' . $route['path'];
        }
        return $routes;
    }

    private static function purpose(mixed $value, string $lead): string
    {
        $purpose = is_string($value) ? trim($value) : '';
        if ($purpose === '' || mb_strlen($purpose) > 200 || preg_match('/[\x00-\x1f\x7f]/u', $purpose)) throw new InvalidArgumentException("{$lead} needs a \"purpose\": one sentence of up to 200 characters, shown to the owner and the app's visitors.");
        return $purpose;
    }

    private static function isObject(mixed $value): bool
    {
        return is_array($value) && ($value === [] || !array_is_list($value));
    }
}

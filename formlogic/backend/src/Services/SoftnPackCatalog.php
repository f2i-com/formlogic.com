<?php

declare(strict_types=1);

namespace FormLogic\Services;

use InvalidArgumentException;

/**
 * Loads the bundled Free SoftN + Linked Forms Business Packs from `resources/softn-packs/`.
 *
 * Kept separate from `FolderPackCatalog` so the 29 legacy Form Packs in `resources/packs/`
 * remain 100% intact (including vendor signatures and `FolderPackCatalogTest`), while all 29
 * full-stack SoftN business apps + schema-matched FormLogic Forms appear right beside them
 * in the Marketplace with live interactive sandboxes and 1-click unified install.
 */
final class SoftnPackCatalog
{
    private string $dir;
    /** @var array<string, array<string, mixed>>|null */
    private static ?array $metaCache = null;
    private static ?string $metaCacheDir = null;

    public function __construct(?string $directory = null)
    {
        $this->dir = $directory ?? dirname(__DIR__, 2) . '/resources/softn-packs';
    }

    /**
     * Load lightweight metadata (`pack.json`) for every bundled SoftN pack.
     *
     * @return array<string, array<string, mixed>> keyed by slug
     */
    public function loadMeta(): array
    {
        if (self::$metaCache !== null && self::$metaCacheDir === $this->dir) {
            return self::$metaCache;
        }
        $entries = [];
        if (!is_dir($this->dir)) {
            return $entries;
        }
        $folders = glob($this->dir . '/*', GLOB_ONLYDIR) ?: [];
        sort($folders, SORT_STRING);
        foreach ($folders as $folder) {
            $slug = basename($folder);
            if (is_link($folder) || preg_match('/^[a-z0-9][a-z0-9-]{0,79}$/D', $slug) !== 1) {
                continue;
            }
            $metaFile = $folder . '/pack.json';
            $installFile = $folder . '/install.json';
            if (!is_file($metaFile) || !is_file($installFile)) {
                continue;
            }
            $meta = json_decode((string) @file_get_contents($metaFile), true);
            if (!is_array($meta) || ($meta['slug'] ?? $meta['id'] ?? '') !== $slug) {
                continue;
            }
            $archiveName = is_string($meta['softnArchive'] ?? null) ? basename((string) $meta['softnArchive']) : ($slug . '.softn');
            $archivePath = $folder . '/' . $archiveName;
            if (!is_file($archivePath)) {
                continue;
            }
            $meta['_folder'] = $folder;
            $meta['_archivePath'] = $archivePath;
            $meta['_installPath'] = $installFile;
            $entries[$slug] = $meta;
        }
        self::$metaCache = $entries;
        self::$metaCacheDir = $this->dir;
        return $entries;
    }

    /** Check whether a companion SoftN pack exists for a legacy Form pack slug (e.g. `property-maintenance`). */
    public function companionSoftnSlugFor(string $legacyPackId): ?string
    {
        $candidate = $legacyPackId . '-softn';
        $all = $this->loadMeta();
        return isset($all[$candidate]) ? $candidate : null;
    }

    /** @return array<string, mixed>|null */
    public function getMeta(string $slug): ?array
    {
        $all = $this->loadMeta();
        return $all[$slug] ?? null;
    }

    /**
     * Format a bundled SoftN pack into the exact Marketplace catalog summary shape returned by
     * `PackCatalogService` and `FolderPackCatalog`.
     *
     * @param array<string, mixed> $meta
     * @return array<string, mixed>
     */
    public static function summary(array $meta, bool $includeInstallInfo = false): array
    {
        $slug = (string) ($meta['slug'] ?? $meta['id'] ?? '');
        $tables = is_array($meta['tables'] ?? null) ? array_values(array_map('strval', $meta['tables'])) : [];
        $formTitles = [];
        $appNames = [];
        if ($includeInstallInfo && is_string($meta['_installPath'] ?? null) && is_file($meta['_installPath'])) {
            $inst = json_decode((string) @file_get_contents($meta['_installPath']), true);
            if (is_array($inst)) {
                $formTitles = array_values(array_map('strval', array_column($inst['forms'] ?? [], 'title')));
                $appNames = array_values(array_map('strval', array_column($inst['apps'] ?? [], 'name')));
            }
        }
        if ($formTitles === []) {
            $formTitles = array_map(static fn(string $t): string => ucwords(str_replace('_', ' ', (string) preg_replace('/^(?:ak|au|us|ohs)_/', '', $t))), $tables);
        }
        if ($appNames === []) {
            $short = (string) ($meta['shortName'] ?? $meta['name'] ?? $slug);
            $appNames = [$short, $short . ' Forms & Charts'];
        }
        $shots = is_array($meta['screenshots'] ?? null) ? $meta['screenshots'] : [];

        return [
            'id' => 'softn-pack-' . $slug,
            'slug' => $slug,
            'name' => (string) ($meta['name'] ?? $slug),
            'description' => (string) ($meta['description'] ?? ''),
            'icon' => $meta['icon'] ?? 'Layers',
            'tags' => is_array($meta['tags'] ?? null) ? array_values($meta['tags']) : [],
            'category' => $meta['category'] ?? 'Business apps',
            'itemType' => 'softn_app',
            'trustLevel' => 'official',
            'official' => true,
            'folderSource' => true,
            'bundledSoftnPack' => true,
            'visibility' => 'public',
            'sourceVisibility' => 'open',
            'priceCents' => 0,
            'currency' => 'USD',
            'billingModel' => 'free',
            'demoEnabled' => true,
            'compatibleWith' => null,
            'pluginMeta' => null,
            'companionPackSlug' => is_string($meta['companionPackSlug'] ?? null) ? $meta['companionPackSlug'] : null,
            'tables' => $tables,
            'status' => 'published',
            'downloadCount' => 0,
            'avgRating' => 0,
            'ratingCount' => 0,
            'featured' => ($meta['featured'] ?? false) === true,
            'publisherId' => '',
            'publisherName' => 'FormLogic Official',
            'latestVersion' => (string) ($meta['version'] ?? '1.0.0'),
            'formatVersion' => 1,
            'formCount' => (int) ($meta['formCount'] ?? count($tables)),
            'appCount' => (int) ($meta['appCount'] ?? 2),
            'nodeCount' => 0,
            'screenshot' => $shots[0]['url'] ?? null,
            'screenshots' => $shots,
            'versions' => [],
            'createdAt' => '',
            'updatedAt' => '',
            'formTitles' => $formTitles,
            'appNames' => $appNames,
        ];
    }

    /**
     * Build a DB-like catalog record for `MarketplaceSandboxService` so bundled Free SoftN packs
     * reuse the exact same sandbox session/frame/backend pipeline as member-published listings.
     *
     * @return array<string, mixed>|null
     */
    public function asDemoCatalogRecord(string $slug): ?array
    {
        $meta = $this->getMeta($slug);
        if ($meta === null) {
            return null;
        }
        return [
            'id' => 'softn-pack-' . $slug,
            'slug' => $slug,
            'name' => (string) ($meta['shortName'] ?? $meta['name'] ?? $slug),
            'item_type' => 'softn_app',
            'source_visibility' => 'open',
            'price_cents' => 0,
            'currency' => 'USD',
            'billing_model' => 'free',
            'demo_enabled' => 1,
            'demo_app_id' => self::demoAppIdFor($slug),
            '_archivePath' => (string) $meta['_archivePath'],
            '_bundledSoftnPack' => true,
        ];
    }

    public static function demoAppIdFor(string $slug): string
    {
        return 'mkt_sbp_' . substr(hash('sha256', $slug), 0, 20);
    }

    /**
     * Load the complete installable pack JSON for `PackService::importPack()`, with the extracted
     * SoftN `nativeProject` attached to the SoftN app.
     *
     * Modes:
     *  - `bundle`: installs BOTH the SoftN App AND all schema-matched FormLogic Forms + Charts App
     *  - `softn_only`: installs only the SoftN App
     *  - `link_forms`: installs only the schema-matched FormLogic Forms + Charts App bound directly
     *                  to an existing owned SoftN app (`$existingTargetAppId`)
     *
     * @return array<string, mixed>|null
     */
    public function buildInstallablePack(string $slug, string $mode = 'bundle', ?string $existingTargetAppId = null): ?array
    {
        $meta = $this->getMeta($slug);
        if ($meta === null) {
            return null;
        }
        $install = json_decode((string) file_get_contents((string) $meta['_installPath']), true, 128, JSON_THROW_ON_ERROR);
        if (!is_array($install)) {
            return null;
        }
        $softnPackAppId = (string) ($meta['softnPackAppId'] ?? ($slug . '-app'));
        $formsPackAppId = (string) ($meta['formsPackAppId'] ?? ($slug . '-forms'));

        if ($mode === 'softn_only') {
            $project = NativeAppService::extractProjectFromArchive((string) $meta['_archivePath']);
            $softnApp = null;
            foreach ($install['apps'] ?? [] as $app) {
                if (($app['packAppId'] ?? '') === $softnPackAppId) {
                    $softnApp = $app;
                    $softnApp['nativeProject'] = $project;
                    break;
                }
            }
            if ($softnApp === null) {
                throw new InvalidArgumentException('SoftN app definition missing in pack.');
            }
            $install['forms'] = [];
            $install['apps'] = [$softnApp];
            $install['packMeta']['id'] = $slug . '-app-only-' . substr(bin2hex(random_bytes(4)), 0, 6);
            return $install;
        }

        if ($mode === 'link_forms') {
            if ($existingTargetAppId === null || trim($existingTargetAppId) === '') {
                throw new InvalidArgumentException('Choose an existing SoftN app to link these forms to.');
            }
            $targetId = trim($existingTargetAppId);
            foreach ($install['forms'] as &$form) {
                if (isset($form['settings']['nativeTableBinding']['appId'])) {
                    $form['settings']['nativeTableBinding']['appId'] = $targetId;
                }
            }
            unset($form);
            $formsApp = null;
            foreach ($install['apps'] ?? [] as $app) {
                if (($app['packAppId'] ?? '') === $formsPackAppId) {
                    $formsApp = $app;
                    $formsApp['settings']['sharedDatabaseAppId'] = $targetId;
                    $formsApp['settings']['linkedSoftnAppId'] = $targetId;
                    break;
                }
            }
            $install['apps'] = $formsApp !== null ? [$formsApp] : [];
            $install['packMeta']['id'] = $slug . '-linked-' . substr(bin2hex(random_bytes(4)), 0, 6);
            return $install;
        }

        // Default `bundle`: both SoftN App + Schema-Matched Forms & Management Charts App
        $project = NativeAppService::extractProjectFromArchive((string) $meta['_archivePath']);
        foreach ($install['apps'] as &$app) {
            if (($app['packAppId'] ?? '') === $softnPackAppId) {
                $app['nativeProject'] = $project;
            }
        }
        unset($app);
        return $install;
    }

    /** Path to the raw `.softn` archive on disk for direct free download. */
    public function archivePath(string $slug): ?string
    {
        $meta = $this->getMeta($slug);
        return $meta !== null && is_string($meta['_archivePath'] ?? null) ? (string) $meta['_archivePath'] : null;
    }
}

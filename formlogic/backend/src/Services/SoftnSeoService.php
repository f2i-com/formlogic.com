<?php

declare(strict_types=1);

namespace FormLogic\Services;

use DOMDocument;
use DOMElement;
use DOMXPath;
use InvalidArgumentException;

/**
 * Search-engine discoverability, per-page metadata, crawlable HTML snapshots, sitemap.xml, and
 * robots.txt generation for hosted SoftN and JavaScript apps.
 *
 * Security & privacy invariants:
 *  - Only published, public (`access === 'application'`) SoftN apps with `allowIndexing === true`
 *    expose metadata, crawlable HTML snapshots, or sitemap URLs.
 *  - Draft apps, members-only apps, and apps with indexing turned off NEVER emit page content or
 *    URLs and instead emit `noindex, nofollow` (and `Disallow: /` on their custom domain).
 *  - All extracted HTML content is stripped of scripts, styles, iframes, forms, and event handlers
 *    and re-emitted exclusively via escaped text nodes and allowlisted internal navigation links.
 */
class SoftnSeoService
{
    private const MAX_PAGES = 200;
    private const MAX_EXTRA_ROUTES = 100;
    private const MAX_SNAPSHOT_CHARS = 8000;
    private const MAX_DESCRIPTION_CHARS = 300;

    public function __construct(
        private NativeAppService $native,
        private ?AppLookService $look = null,
    ) {}

    /**
     * @param array<string, mixed> $app
     * @return array{allowIndexing: bool, defaultDescription: string, extraRoutes: list<string>}
     */
    public function getSettings(array $app): array
    {
        $settings = is_array($app['settings'] ?? null) ? $app['settings'] : [];
        $raw = is_array($settings['softnSeo'] ?? null) ? $settings['softnSeo'] : [];

        $allowIndexing = array_key_exists('allowIndexing', $raw) ? (bool) $raw['allowIndexing'] : true;
        $defaultDescription = is_string($raw['defaultDescription'] ?? null)
            ? self::cleanText($raw['defaultDescription'], self::MAX_DESCRIPTION_CHARS)
            : '';
        $extraRoutes = self::sanitizeExtraRoutes($raw['extraRoutes'] ?? []);

        return [
            'allowIndexing' => $allowIndexing,
            'defaultDescription' => $defaultDescription,
            'extraRoutes' => $extraRoutes,
        ];
    }

    /**
     * @param array<string, mixed> $app
     * @param array<string, mixed> $patch
     * @return array{allowIndexing: bool, defaultDescription: string, extraRoutes: list<string>}
     */
    public function normalizeSettingsPatch(array $app, array $patch): array
    {
        $current = $this->getSettings($app);
        if (array_key_exists('allowIndexing', $patch)) {
            $current['allowIndexing'] = (bool) $patch['allowIndexing'];
        }
        if (array_key_exists('defaultDescription', $patch)) {
            if (!is_string($patch['defaultDescription'])) {
                throw new InvalidArgumentException('defaultDescription must be a string.');
            }
            $current['defaultDescription'] = self::cleanText($patch['defaultDescription'], self::MAX_DESCRIPTION_CHARS);
        }
        if (array_key_exists('extraRoutes', $patch)) {
            if (!is_array($patch['extraRoutes'])) {
                throw new InvalidArgumentException('extraRoutes must be an array of paths.');
            }
            $current['extraRoutes'] = self::sanitizeExtraRoutes($patch['extraRoutes']);
        }
        return $current;
    }

    /**
     * Assesses whether an app is eligible for search-engine indexing.
     *
     * @param array<string, mixed> $app
     * @return array{indexable: bool, reason: string, published: bool, access: 'application'|'members'}
     */
    public function assessIndexability(array $app): array
    {
        $published = ($app['status'] ?? '') === 'published';
        $summary = null;
        try {
            $summary = $this->native->summary((string) ($app['id'] ?? ''));
        } catch (\Throwable) {
            $summary = null;
        }
        $access = (is_array($summary) && ($summary['access'] ?? null) === 'application') ? 'application' : 'members';
        $settings = $this->getSettings($app);

        if (empty($app['settings']['softnApp'])) {
            return ['indexable' => false, 'reason' => 'Not a SoftN web app.', 'published' => $published, 'access' => $access];
        }
        if (!$published) {
            return ['indexable' => false, 'reason' => 'App is currently a draft. Publish it to allow search engines to index its pages.', 'published' => false, 'access' => $access];
        }
        if ($summary === null) {
            return ['indexable' => false, 'reason' => 'No app bundle is installed yet.', 'published' => true, 'access' => $access];
        }
        if ($access !== 'application') {
            return ['indexable' => false, 'reason' => 'App access is restricted to Members only — search engines are blocked from indexing private apps.', 'published' => true, 'access' => 'members'];
        }
        if (!$settings['allowIndexing']) {
            return ['indexable' => false, 'reason' => 'Search indexing is turned off in SEO settings (noindex, nofollow).', 'published' => true, 'access' => 'application'];
        }
        return ['indexable' => true, 'reason' => 'Public and indexable by search engines with per-page metadata, crawlable HTML snapshots, and XML sitemap.', 'published' => true, 'access' => 'application'];
    }

    /**
     * Discovers all public navigable pages for a SoftN / built JS app.
     *
     * @param array<string, mixed> $app
     * @return list<array{path: string, title: string, description: string, canonicalUrl: string, source: string, headings: list<string>, paragraphs: list<string>, links: list<array{href: string, text: string}>}>
     */
    public function discoverPages(array $app, string $baseUrl, bool $onDomain): array
    {
        $appId = (string) ($app['id'] ?? '');
        $slug = (string) ($app['slug'] ?? '');
        $appName = self::cleanText((string) ($app['name'] ?? $slug), 120) ?: $slug;
        $seoSettings = $this->getSettings($app);
        $fallbackDesc = $this->resolveFallbackDescription($app, $seoSettings);

        $project = null;
        try {
            $project = $this->native->project($appId);
        } catch (\Throwable) {
            $project = null;
        }
        if (!is_array($project)) {
            return [];
        }

        $pagesByPath = [];
        $files = is_array($project['files'] ?? null) ? $project['files'] : [];
        $assets = is_array($project['assets'] ?? null) ? $project['assets'] : [];
        $siteEntry = NativeAppService::siteEntry($project);

        if ($siteEntry !== null) {
            // Built JavaScript site stored under site/
            $siteKeys = [];
            foreach ($assets as $assetPath => $_b64) {
                if (!is_string($assetPath) || !str_starts_with($assetPath, 'site/')) continue;
                if (preg_match('/\.html?$/i', $assetPath) !== 1) continue;
                $siteKeys[] = $assetPath;
            }
            sort($siteKeys);
            foreach (array_slice($siteKeys, 0, self::MAX_PAGES) as $assetPath) {
                $rel = substr($assetPath, 5); // strip "site/"
                $routePath = self::htmlFileToRoutePath($rel, $siteEntry);
                $rawBytes = $this->readSiteHtmlBytes($appId, $rel, $assets[$assetPath] ?? null);
                $extracted = self::extractFromHtml($rawBytes, $appName, $fallbackDesc, $routePath);
                $pagesByPath[$routePath] = [
                    'path' => $routePath,
                    'title' => $extracted['title'],
                    'description' => $extracted['description'],
                    'canonicalUrl' => self::buildCanonicalUrl($baseUrl, $slug, $routePath, $onDomain),
                    'source' => $assetPath,
                    'headings' => $extracted['headings'],
                    'paragraphs' => $extracted['paragraphs'],
                    'links' => $extracted['links'],
                ];
            }
        } else {
            // SoftN container HTML files OR classic .ui files
            $htmlFiles = [];
            foreach ($files as $filePath => $content) {
                if (!is_string($filePath) || !is_string($content)) continue;
                if (preg_match('/^(?:server|backend|api|node_modules)\//i', $filePath) === 1) continue;
                if (preg_match('/\.html?$/i', $filePath) === 1) {
                    $htmlFiles[] = $filePath;
                }
            }
            sort($htmlFiles);
            if ($htmlFiles !== []) {
                foreach (array_slice($htmlFiles, 0, self::MAX_PAGES) as $filePath) {
                    $routePath = self::htmlFileToRoutePath($filePath, 'index.html');
                    $extracted = self::extractFromHtml($files[$filePath], $appName, $fallbackDesc, $routePath);
                    $pagesByPath[$routePath] = [
                        'path' => $routePath,
                        'title' => $extracted['title'],
                        'description' => $extracted['description'],
                        'canonicalUrl' => self::buildCanonicalUrl($baseUrl, $slug, $routePath, $onDomain),
                        'source' => $filePath,
                        'headings' => $extracted['headings'],
                        'paragraphs' => $extracted['paragraphs'],
                        'links' => $extracted['links'],
                    ];
                }
            } else {
                // Classic SoftN (.ui) app: extract readable headings & text from main .ui
                $uiTexts = [];
                foreach ($files as $filePath => $content) {
                    if (!is_string($filePath) || !is_string($content) || !str_ends_with(strtolower($filePath), '.ui')) continue;
                    if (preg_match_all('~<(?:Heading|Text|Title|Paragraph)\b[^>]*>([^<{]{2,300})</(?:Heading|Text|Title|Paragraph)>~i', $content, $m)) {
                        foreach ($m[1] as $snippet) {
                            $clean = self::cleanText(html_entity_decode($snippet, ENT_QUOTES | ENT_HTML5, 'UTF-8'), 240);
                            if ($clean !== '' && !in_array($clean, $uiTexts, true)) {
                                $uiTexts[] = $clean;
                            }
                            if (count($uiTexts) >= 20) break 2;
                        }
                    }
                }
                $pagesByPath['/'] = [
                    'path' => '/',
                    'title' => $appName,
                    'description' => $fallbackDesc,
                    'canonicalUrl' => self::buildCanonicalUrl($baseUrl, $slug, '/', $onDomain),
                    'source' => 'ui/main.ui',
                    'headings' => [$appName],
                    'paragraphs' => $uiTexts,
                    'links' => [],
                ];
            }
        }

        // Ensure "/" always exists as the first page
        if (!isset($pagesByPath['/'])) {
            $pagesByPath['/'] = [
                'path' => '/',
                'title' => $appName,
                'description' => $fallbackDesc,
                'canonicalUrl' => self::buildCanonicalUrl($baseUrl, $slug, '/', $onDomain),
                'source' => 'index',
                'headings' => [$appName],
                'paragraphs' => $fallbackDesc !== '' ? [$fallbackDesc] : [],
                'links' => [],
            ];
        }

        // Include optional manifest.json `seo.pages` and owner `extraRoutes`
        $manifest = is_string($files['manifest.json'] ?? null) ? json_decode($files['manifest.json'], true) : null;
        $manifestPages = is_array($manifest) && is_array($manifest['seo']['pages'] ?? null) ? $manifest['seo']['pages'] : [];
        foreach ($manifestPages as $entry) {
            if (count($pagesByPath) >= self::MAX_PAGES) break;
            if (is_string($entry)) {
                $route = self::normalizeRoutePath($entry);
                if ($route !== null && !isset($pagesByPath[$route])) {
                    $pagesByPath[$route] = [
                        'path' => $route,
                        'title' => self::humanizeRouteTitle($route, $appName),
                        'description' => $fallbackDesc,
                        'canonicalUrl' => self::buildCanonicalUrl($baseUrl, $slug, $route, $onDomain),
                        'source' => 'manifest.json',
                        'headings' => [self::humanizeRouteTitle($route, $appName)],
                        'paragraphs' => $fallbackDesc !== '' ? [$fallbackDesc] : [],
                        'links' => [],
                    ];
                }
            } elseif (is_array($entry) && is_string($entry['path'] ?? null)) {
                $route = self::normalizeRoutePath($entry['path']);
                if ($route !== null) {
                    $title = is_string($entry['title'] ?? null) ? self::cleanText($entry['title'], 120) : self::humanizeRouteTitle($route, $appName);
                    $desc = is_string($entry['description'] ?? null) ? self::cleanText($entry['description'], self::MAX_DESCRIPTION_CHARS) : $fallbackDesc;
                    if (!isset($pagesByPath[$route])) {
                        $pagesByPath[$route] = [
                            'path' => $route,
                            'title' => $title ?: $appName,
                            'description' => $desc,
                            'canonicalUrl' => self::buildCanonicalUrl($baseUrl, $slug, $route, $onDomain),
                            'source' => 'manifest.json',
                            'headings' => [$title ?: $appName],
                            'paragraphs' => $desc !== '' ? [$desc] : [],
                            'links' => [],
                        ];
                    } else {
                        if ($title !== '') $pagesByPath[$route]['title'] = $title;
                        if ($desc !== '') $pagesByPath[$route]['description'] = $desc;
                    }
                }
            }
        }

        foreach ($seoSettings['extraRoutes'] as $route) {
            if (count($pagesByPath) >= self::MAX_PAGES) break;
            if (!isset($pagesByPath[$route])) {
                $title = self::humanizeRouteTitle($route, $appName);
                $pagesByPath[$route] = [
                    'path' => $route,
                    'title' => $title,
                    'description' => $fallbackDesc,
                    'canonicalUrl' => self::buildCanonicalUrl($baseUrl, $slug, $route, $onDomain),
                    'source' => 'seo-settings',
                    'headings' => [$title],
                    'paragraphs' => $fallbackDesc !== '' ? [$fallbackDesc] : [],
                    'links' => [],
                ];
            }
        }

        // Put "/" first, then sort remaining paths alphabetically
        $root = $pagesByPath['/'];
        unset($pagesByPath['/']);
        ksort($pagesByPath);
        return array_values(['/' => $root] + $pagesByPath);
    }

    /**
     * Resolves complete per-page SEO metadata, JSON-LD, and crawlable HTML snapshot for one URL.
     *
     * @param array<string, mixed> $app
     * @param array<string, mixed>|null $look
     * @return array{
     *   indexable: bool,
     *   robots: string,
     *   title: string,
     *   description: string,
     *   canonicalUrl: string,
     *   ogImage: ?string,
     *   themeColor: ?string,
     *   jsonLd: ?string,
     *   snapshotHtml: string,
     *   pagePath: string
     * }
     */
    public function resolvePage(array $app, string $subpath, string $baseUrl, bool $onDomain, ?array $look = null): array
    {
        $assessment = $this->assessIndexability($app);
        $slug = (string) ($app['slug'] ?? '');
        $appName = self::cleanText((string) ($app['name'] ?? $slug), 120) ?: $slug;
        $normalized = self::normalizeRoutePath($subpath) ?? '/';
        $canonicalUrl = self::buildCanonicalUrl($baseUrl, $slug, $normalized, $onDomain);

        if (!$assessment['indexable']) {
            return [
                'indexable' => false,
                'robots' => 'noindex, nofollow',
                'title' => $appName,
                'description' => '',
                'canonicalUrl' => $canonicalUrl,
                'ogImage' => null,
                'themeColor' => is_string($look['themeColor'] ?? null) ? $look['themeColor'] : null,
                'jsonLd' => null,
                'snapshotHtml' => '',
                'pagePath' => $normalized,
            ];
        }

        $pages = $this->discoverPages($app, $baseUrl, $onDomain);
        $matched = null;
        foreach ($pages as $page) {
            if (strtolower($page['path']) === strtolower($normalized)) {
                $matched = $page;
                break;
            }
        }
        if ($matched === null && $normalized !== '/' && !str_ends_with(strtolower($normalized), '.html')) {
            // Try matching "/about" to "/about.html"
            foreach ($pages as $page) {
                if (strtolower($page['path']) === strtolower($normalized . '.html')) {
                    $matched = $page;
                    break;
                }
            }
        }
        $active = $matched ?? ($pages[0] ?? [
            'path' => '/',
            'title' => $appName,
            'description' => $this->resolveFallbackDescription($app, $this->getSettings($app)),
            'canonicalUrl' => $canonicalUrl,
            'source' => 'index',
            'headings' => [$appName],
            'paragraphs' => [],
            'links' => [],
        ]);

        $ogImage = null;
        if (is_array($look) && !empty($look['shareImage']) && !empty($look['version'])) {
            $ogImage = rtrim($baseUrl, '/') . AppLookService::imagePath($slug, 'share.png', (string) $look['version']);
        }

        $siteRootUrl = self::buildCanonicalUrl($baseUrl, $slug, '/', $onDomain);
        $jsonLdData = [
            '@context' => 'https://schema.org',
            '@type' => $active['path'] === '/' ? 'WebSite' : 'WebPage',
            'name' => $active['title'],
            'url' => $active['canonicalUrl'],
        ];
        if ($active['description'] !== '') {
            $jsonLdData['description'] = $active['description'];
        }
        if ($ogImage !== null) {
            $jsonLdData['image'] = $ogImage;
        }
        if ($active['path'] !== '/') {
            $jsonLdData['isPartOf'] = [
                '@type' => 'WebSite',
                'name' => $appName,
                'url' => $siteRootUrl,
            ];
        }
        $jsonLd = json_encode(
            $jsonLdData,
            JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT
        ) ?: null;

        $snapshotHtml = self::renderCrawlableSnapshot($appName, $active, $pages, $baseUrl, $slug, $onDomain);

        return [
            'indexable' => true,
            'robots' => 'index, follow',
            'title' => $active['title'],
            'description' => $active['description'],
            'canonicalUrl' => $active['canonicalUrl'],
            'ogImage' => $ogImage,
            'themeColor' => is_string($look['themeColor'] ?? null) ? $look['themeColor'] : null,
            'jsonLd' => $jsonLd,
            'snapshotHtml' => $snapshotHtml,
            'pagePath' => $active['path'],
        ];
    }

    /**
     * Generates an XML sitemap (`sitemap.xml`) for an indexable SoftN app.
     *
     * @param array<string, mixed> $app
     */
    public function buildSitemapXml(array $app, string $baseUrl, bool $onDomain): string
    {
        $assessment = $this->assessIndexability($app);
        $lines = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        ];
        if ($assessment['indexable']) {
            $pages = $this->discoverPages($app, $baseUrl, $onDomain);
            $updated = is_string($app['updatedAt'] ?? null) && $app['updatedAt'] !== ''
                ? gmdate('Y-m-d', strtotime((string) $app['updatedAt']) ?: time())
                : gmdate('Y-m-d');
            foreach ($pages as $page) {
                $depth = substr_count(trim($page['path'], '/'), '/');
                $priority = $page['path'] === '/' ? '1.0' : ($depth === 0 ? '0.8' : '0.6');
                $loc = htmlspecialchars($page['canonicalUrl'], ENT_XML1 | ENT_QUOTES, 'UTF-8');
                $lines[] = '  <url>';
                $lines[] = "    <loc>{$loc}</loc>";
                $lines[] = "    <lastmod>{$updated}</lastmod>";
                $lines[] = "    <priority>{$priority}</priority>";
                $lines[] = '  </url>';
            }
        }
        $lines[] = '</urlset>';
        return implode("\n", $lines) . "\n";
    }

    /**
     * Generates `robots.txt` for either a custom domain (app-aware) or the platform host.
     *
     * @param array<string, mixed>|null $domainApp
     */
    public function buildRobotsTxt(?array $domainApp, string $baseUrl): string
    {
        $base = rtrim($baseUrl, '/');
        if ($domainApp !== null) {
            $assessment = $this->assessIndexability($domainApp);
            if (!$assessment['indexable']) {
                return "User-agent: *\nDisallow: /\n";
            }
            return implode("\n", [
                'User-agent: *',
                'Allow: /',
                'Disallow: /api/',
                'Disallow: /hosted-runtime/',
                'Disallow: /app-editors/',
                'Disallow: /zipp/',
                'Sitemap: ' . $base . '/sitemap.xml',
            ]) . "\n";
        }

        return implode("\n", [
            'User-agent: *',
            'Allow: /',
            'Disallow: /api/',
            'Disallow: /admin/',
            'Disallow: /apps/',
            'Disallow: /builder/',
            'Disallow: /hosted-runtime/',
            'Disallow: /app-editors/',
            'Disallow: /zipp/',
        ]) . "\n";
    }

    /**
     * Builds the canonical URL for one page of an app on either its custom domain or the platform host.
     */
    public static function buildCanonicalUrl(string $baseUrl, string $slug, string $pagePath, bool $onDomain): string
    {
        $base = rtrim($baseUrl, '/');
        $clean = self::normalizeRoutePath($pagePath) ?? '/';
        if ($onDomain) {
            return $base . $clean;
        }
        $appBase = $base . '/app/' . rawurlencode($slug);
        return $clean === '/' ? $appBase : $appBase . $clean;
    }

    /**
     * Builds a relative href for internal crawlable navigation links inside `<nav>`.
     */
    private static function buildRelativeHref(string $slug, string $pagePath, bool $onDomain): string
    {
        $clean = self::normalizeRoutePath($pagePath) ?? '/';
        if ($onDomain) {
            return $clean;
        }
        $appBase = '/app/' . rawurlencode($slug);
        return $clean === '/' ? $appBase : $appBase . $clean;
    }

    /**
     * Renders a sanitized, script-free semantic HTML snapshot inside `<div id="root">` so search
     * engines can index headings, copy, and internal page links before or without executing JS.
     *
     * @param array{path: string, title: string, description: string, headings: list<string>, paragraphs: list<string>, links: list<array{href: string, text: string}>} $active
     * @param list<array{path: string, title: string}> $allPages
     */
    private static function renderCrawlableSnapshot(
        string $appName,
        array $active,
        array $allPages,
        string $baseUrl,
        string $slug,
        bool $onDomain,
    ): string {
        $e = static fn(string $text): string => htmlspecialchars($text, ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML5, 'UTF-8');
        $parts = [];
        $parts[] = '<div data-fl-seo-snapshot="1">';
        $parts[] = '<header>';
        $parts[] = '<a href="' . $e(self::buildRelativeHref($slug, '/', $onDomain)) . '">' . $e($appName) . '</a>';
        if (count($allPages) > 1) {
            $parts[] = '<nav aria-label="Pages"><ul>';
            foreach (array_slice($allPages, 0, 50) as $p) {
                $href = self::buildRelativeHref($slug, $p['path'], $onDomain);
                $label = $p['title'] !== '' ? $p['title'] : ($p['path'] === '/' ? 'Home' : $p['path']);
                $parts[] = '<li><a href="' . $e($href) . '">' . $e($label) . '</a></li>';
            }
            $parts[] = '</ul></nav>';
        }
        $parts[] = '</header>';

        $parts[] = '<main>';
        $headings = $active['headings'] !== [] ? $active['headings'] : [$active['title']];
        foreach (array_slice($headings, 0, 12) as $idx => $heading) {
            $tag = $idx === 0 ? 'h1' : 'h2';
            $parts[] = "<{$tag}>" . $e($heading) . "</{$tag}>";
        }
        if ($active['description'] !== '' && ($active['paragraphs'] === [] || $active['paragraphs'][0] !== $active['description'])) {
            $parts[] = '<p>' . $e($active['description']) . '</p>';
        }
        $budget = self::MAX_SNAPSHOT_CHARS;
        foreach (array_slice($active['paragraphs'], 0, 30) as $para) {
            if ($budget <= 0) break;
            $chunk = mb_substr($para, 0, min(600, $budget));
            $parts[] = '<p>' . $e($chunk) . '</p>';
            $budget -= mb_strlen($chunk);
        }
        $parts[] = '</main>';
        $parts[] = '</div>';
        return implode("\n", $parts);
    }

    /**
     * Parses raw HTML safely with DOMDocument (LIBXML_NONET) and extracts clean metadata & copy.
     *
     * @return array{title: string, description: string, headings: list<string>, paragraphs: list<string>, links: list<array{href: string, text: string}>}
     */
    private static function extractFromHtml(string $html, string $appName, string $fallbackDesc, string $routePath): array
    {
        $title = '';
        $description = '';
        $headings = [];
        $paragraphs = [];
        $links = [];

        if (trim($html) !== '' && class_exists(DOMDocument::class)) {
            $dom = new DOMDocument();
            $prev = libxml_use_internal_errors(true);
            @$dom->loadHTML('<?xml encoding="utf-8" ?>' . $html, LIBXML_NOERROR | LIBXML_NOWARNING | LIBXML_NONET);
            libxml_clear_errors();
            libxml_use_internal_errors($prev);

            $xpath = new DOMXPath($dom);

            // Strip active/non-content nodes before reading text
            foreach ($xpath->query('//script|//style|//noscript|//template|//iframe|//svg') ?: [] as $node) {
                $node->parentNode?->removeChild($node);
            }

            $titleNode = $xpath->query('//title')->item(0);
            if ($titleNode !== null) {
                $title = self::cleanText($titleNode->textContent ?? '', 120);
            }
            foreach ($xpath->query('//meta[@name]') ?: [] as $meta) {
                if ($meta instanceof DOMElement && strtolower($meta->getAttribute('name')) === 'description') {
                    $description = self::cleanText($meta->getAttribute('content'), self::MAX_DESCRIPTION_CHARS);
                    if ($description !== '') break;
                }
            }
            foreach ($xpath->query('//h1|//h2|//h3') ?: [] as $h) {
                $text = self::cleanText($h->textContent ?? '', 160);
                if ($text !== '' && !in_array($text, $headings, true)) {
                    $headings[] = $text;
                }
                if (count($headings) >= 12) break;
            }
            foreach ($xpath->query('//p|//li') ?: [] as $p) {
                $text = self::cleanText($p->textContent ?? '', 500);
                if (mb_strlen($text) >= 12 && !in_array($text, $paragraphs, true)) {
                    $paragraphs[] = $text;
                }
                if (count($paragraphs) >= 25) break;
            }
            foreach ($xpath->query('//a[@href]') ?: [] as $a) {
                if (!($a instanceof DOMElement)) continue;
                $href = trim($a->getAttribute('href'));
                $text = self::cleanText($a->textContent ?? '', 80);
                if ($href !== '' && $text !== '' && !preg_match('/^(?:javascript|data|vbscript|mailto|tel):/i', $href)) {
                    $links[] = ['href' => $href, 'text' => $text];
                }
                if (count($links) >= 40) break;
            }
        }

        if ($title === '') {
            $title = $headings[0] ?? self::humanizeRouteTitle($routePath, $appName);
        }
        if ($description === '') {
            $description = $paragraphs[0] ?? $fallbackDesc;
            if (mb_strlen($description) > self::MAX_DESCRIPTION_CHARS) {
                $description = mb_substr($description, 0, self::MAX_DESCRIPTION_CHARS - 1) . '…';
            }
        }

        return [
            'title' => $title,
            'description' => $description,
            'headings' => $headings,
            'paragraphs' => $paragraphs,
            'links' => $links,
        ];
    }

    private function readSiteHtmlBytes(string $appId, string $relPath, mixed $assetValue): string
    {
        if (is_string($assetValue) && $assetValue !== '') {
            $decoded = base64_decode($assetValue, true);
            if ($decoded !== false) {
                return $decoded;
            }
        }
        $file = $this->native->siteFile($appId, $relPath);
        if (is_array($file) && isset($file['stream']) && is_resource($file['stream'])) {
            $bytes = (string) stream_get_contents($file['stream'], 512 * 1024);
            fclose($file['stream']);
            return $bytes;
        }
        return '';
    }

    /**
     * @param array<string, mixed> $app
     * @param array{defaultDescription: string} $seoSettings
     */
    private function resolveFallbackDescription(array $app, array $seoSettings): string
    {
        if ($seoSettings['defaultDescription'] !== '') {
            return $seoSettings['defaultDescription'];
        }
        if ($this->look !== null) {
            try {
                $look = $this->look->resolve($app);
                if (is_array($look) && !empty($look['description'])) {
                    return self::cleanText((string) $look['description'], self::MAX_DESCRIPTION_CHARS);
                }
            } catch (\Throwable) { /* fall back to app row */ }
        }
        return self::cleanText((string) ($app['description'] ?? ''), self::MAX_DESCRIPTION_CHARS);
    }

    private static function htmlFileToRoutePath(string $relPath, string $entry): string
    {
        $clean = ltrim(str_replace('\\', '/', $relPath), '/');
        if (strtolower($clean) === strtolower($entry) || strtolower($clean) === 'index.html' || strtolower($clean) === 'index.htm') {
            return '/';
        }
        if (preg_match('/^(.+)\/index\.html?$/i', $clean, $m) === 1) {
            return '/' . $m[1] . '/';
        }
        return '/' . $clean;
    }

    public static function normalizeRoutePath(string $raw): ?string
    {
        $clean = trim(str_replace('\\', '/', $raw));
        $clean = explode('#', $clean, 2)[0];
        $clean = explode('?', $clean, 2)[0];
        if ($clean === '' || $clean === '/') {
            return '/';
        }
        if (!str_starts_with($clean, '/')) {
            $clean = '/' . $clean;
        }
        if (str_contains($clean, '..') || str_contains($clean, '//') || strlen($clean) > 160) {
            return null;
        }
        if (preg_match('/^\/[a-zA-Z0-9._~\/-]+$/', $clean) !== 1) {
            return null;
        }
        return $clean;
    }

    /**
     * @param mixed $raw
     * @return list<string>
     */
    private static function sanitizeExtraRoutes(mixed $raw): array
    {
        if (!is_array($raw)) {
            return [];
        }
        $out = [];
        foreach ($raw as $item) {
            if (!is_string($item)) continue;
            $norm = self::normalizeRoutePath($item);
            if ($norm !== null && $norm !== '/' && !in_array($norm, $out, true)) {
                $out[] = $norm;
            }
            if (count($out) >= self::MAX_EXTRA_ROUTES) break;
        }
        return $out;
    }

    private static function humanizeRouteTitle(string $routePath, string $appName): string
    {
        if ($routePath === '/') {
            return $appName;
        }
        $base = basename(rtrim($routePath, '/'));
        $base = preg_replace('/\.html?$/i', '', $base) ?? $base;
        $words = trim(preg_replace('/[-_]+/', ' ', $base) ?? '');
        if ($words === '') {
            return $appName;
        }
        $label = ucwords(strtolower($words));
        return "{$label} — {$appName}";
    }

    private static function cleanText(string $text, int $maxLen): string
    {
        $clean = preg_replace('/[\x00-\x1F\x7F]+/u', ' ', $text) ?? $text;
        $clean = trim(preg_replace('/\s+/u', ' ', $clean) ?? $clean);
        if (mb_strlen($clean) > $maxLen) {
            return mb_substr($clean, 0, $maxLen);
        }
        return $clean;
    }
}

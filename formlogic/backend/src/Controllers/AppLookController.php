<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Helpers\AppUrl;
use FormLogic\Services\AppDomainService;
use FormLogic\Services\AppLookService;
use FormLogic\Services\AppService;
use FormLogic\Services\SoftnSeoService;
use InvalidArgumentException;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * A hosted SoftN app's look where the app itself is not running: the images a tab, a home screen
 * and a link preview show (AppLookService), and the page a link-preview service is given for the
 * app's address, which carries the app's name, description and image because those services run
 * no script.
 */
final class AppLookController
{
    /**
     * The services that fetch a link to show a preview of it, and run no script. Search engines are
     * not among them: they run the page. ui/public/.htaccess and ci/router.php send these, and only
     * these, to sharePage(); a test holds the three lists equal.
     */
    public const PREVIEW_BOTS = 'facebookexternalhit|Twitterbot|Slackbot|Discordbot|LinkedInBot|WhatsApp|TelegramBot|SkypeUriPreview|redditbot|Pinterestbot|Embedly|vkShare|Iframely|Mastodon|Bluesky';

    public function __construct(
        private AppService $apps,
        private AppLookService $look,
        private AppDomainService $domains,
        private ?SoftnSeoService $seo = null,
    ) {}

    /** GET /api/app/{slug}/look/{name}: one image of the app's look, for anyone its manifest is for. */
    public function image(Request $request, Response $response, array $args): Response
    {
        $app = $this->apps->getAppBySlug((string) ($args['slug'] ?? ''));
        $name = (string) ($args['name'] ?? '');
        if (!$app || empty($app['settings']['softnApp']) || !$this->apps->isRuntimeVisible($app, $request->getAttribute('userId'))) {
            return $this->notFound($response);
        }
        try { $image = $this->look->image($app, $name); } catch (\Throwable) { $image = null; }
        if ($image === null) return $this->notFound($response);
        $etag = '"' . hash('xxh128', $image['bytes']) . '"';
        // Addressed by the look's version as it is (`?v=`), it never changes: an app or look that
        // changes is served at a new address. One naming another version, from a page opened before a
        // change, is sent the look as it is and checked each time: kept for a year under the old
        // address, it came back wrong for a year if the look was ever changed back to that version.
        $asked = (string) ($request->getQueryParams()['v'] ?? '');
        $version = (string) ($image['version'] ?? '');
        $versioned = $asked !== '' && $version !== '' && hash_equals($version, $asked);
        // A published app's look is its public face, as its name is. A draft's is its owner's alone.
        $published = ($app['status'] ?? '') === 'published';
        $response = $response
            ->withHeader('ETag', $etag)
            ->withHeader('Cache-Control', !$published ? 'private, no-cache' : ($versioned ? 'public, max-age=31536000, immutable' : ($asked !== '' ? 'public, no-cache' : 'public, max-age=3600')))
            ->withHeader('X-Content-Type-Options', 'nosniff');
        if ($image['type'] === 'image/svg+xml') {
            // The owner's SVG, from this site's own address: opened as a page, nothing in it runs and
            // it has no origin of its own (as an <img>, a favicon or an icon, scripts never run).
            $response = $response->withHeader('Content-Security-Policy', \FormLogic\Middleware\SecurityHeadersMiddleware::SANDBOXED_IMAGE);
        }
        if (trim($request->getHeaderLine('If-None-Match')) === $etag) return $response->withStatus(304);
        $response->getBody()->write($image['bytes']);
        return $response->withHeader('Content-Type', $image['type']);
    }

    /**
     * GET / and /app/{slug}. For a link-preview service (the rewrite sends /app/{slug} to nobody
     * else): the app's name, description, image and icon, at the address that was shared, for a
     * published SoftN app at /app/<slug> or on its own domain. For everyone else, the site's own page
     * as it is, but at the root of a domain whose app opens there, with the app's name and
     * description in its head (domainHead()), so the tab and a search engine name the app from the
     * first moment, not FormLogic.
     */
    public function sharePage(Request $request, Response $response, array $args): Response
    {
        $slug = isset($args['slug']) ? (string) $args['slug'] : null;
        $subpath = self::extractSubpath($args);
        $host = strtolower(trim(explode(':', $request->getHeaderLine('Host'))[0] ?? ''));
        $app = null;
        $onDomain = false;
        if (!self::isPreviewBot($request->getHeaderLine('User-Agent'))) {
            if ($this->seo !== null) {
                $seoBundle = $this->resolvePageSeoForBrowser($request, $host, $slug, $subpath);
                if ($seoBundle !== null) {
                    return $this->sitePage($response, $seoBundle['head'], $seoBundle['seo']);
                }
            }
            return $this->sitePage($response, $slug === null ? $this->domainHead($host) : null);
        }
        $verifiedDomain = null;
        try {
            if ($slug === null) {
                $resolved = $host !== '' ? $this->domains->resolveAppSlugByHost($host) : null;
                if ($resolved !== null) {
                    $app = $this->apps->getAppBySlug($resolved['slug']);
                    $onDomain = true;
                    $verifiedDomain = (string) ($resolved['domain'] ?? $host);
                }
            } else {
                $app = $this->apps->getAppBySlug($slug);
            }
        } catch (\Throwable) {
            $app = null;
        }
        if (!$app || ($app['status'] ?? '') !== 'published' || empty($app['settings']['softnApp'])) return $this->sitePage($response);
        if ($this->seo !== null) {
            $assessment = $this->seo->assessIndexability($app);
            // Never leak metadata/preview cards for private members-only apps to unauthenticated link-preview bots.
            if ($assessment['access'] !== 'application') {
                return $this->sitePage($response);
            }
        }
        try { $look = $this->look->resolve($app); } catch (\Throwable) { $look = null; }
        if ($look === null) return $this->sitePage($response);
        try {
            $base = $onDomain ? $this->domainBase($request, $verifiedDomain ?? $host) : rtrim(AppUrl::frontendBase($request), '/');
        } catch (\Throwable) {
            return $this->sitePage($response);
        }
        $appSlug = (string) $app['slug'];
        $seoPage = $this->seo !== null ? $this->seo->resolvePage($app, $subpath, $base, $onDomain, $look) : null;
        $url = $seoPage !== null && $seoPage['indexable']
            ? $seoPage['canonicalUrl']
            : ($onDomain ? $base . ($subpath === '/' ? '/' : $subpath) : $base . '/app/' . rawurlencode($appSlug) . ($subpath === '/' ? '' : $subpath));
        $name = $seoPage !== null && $seoPage['indexable'] && $seoPage['title'] !== ''
            ? $seoPage['title']
            : mb_substr(trim((string) ($app['name'] ?? '')), 0, 120);
        $description = $seoPage !== null && $seoPage['indexable'] && $seoPage['description'] !== ''
            ? $seoPage['description']
            : $look['description'];
        $e = static fn(string $text): string => htmlspecialchars($text, ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML5, 'UTF-8');
        $head = [
            '<meta charset="utf-8">',
            '<title>' . $e($name) . '</title>',
            '<link rel="canonical" href="' . $e($url) . '">',
            '<meta property="og:type" content="website">',
            '<meta property="og:url" content="' . $e($url) . '">',
            '<meta property="og:title" content="' . $e($name) . '">',
            '<meta name="twitter:title" content="' . $e($name) . '">',
        ];
        if ($seoPage !== null && !$seoPage['indexable']) {
            $head[] = '<meta name="robots" content="noindex, nofollow">';
        }
        if ($description !== '') {
            $head[] = '<meta name="description" content="' . $e($description) . '">';
            $head[] = '<meta property="og:description" content="' . $e($description) . '">';
            $head[] = '<meta name="twitter:description" content="' . $e($description) . '">';
        }
        if ($look['shareImage'] !== null) {
            $image = $base . AppLookService::imagePath($appSlug, 'share.png', $look['version']);
            $head[] = '<meta property="og:image" content="' . $e($image) . '">';
            $head[] = '<meta property="og:image:width" content="' . AppLookService::SHARE_WIDTH . '">';
            $head[] = '<meta property="og:image:height" content="' . AppLookService::SHARE_HEIGHT . '">';
            $head[] = '<meta name="twitter:card" content="summary_large_image">';
            $head[] = '<meta name="twitter:image" content="' . $e($image) . '">';
        } else {
            $head[] = '<meta name="twitter:card" content="summary">';
        }
        if ($look['iconKind'] !== null) {
            $icon = $look['iconKind'] === 'svg' ? 'icon.svg' : 'icon-192.png';
            $head[] = '<link rel="icon" href="' . $e($base . AppLookService::imagePath($appSlug, $icon, $look['version'])) . '">';
        }
        if ($look['themeColor'] !== null) $head[] = '<meta name="theme-color" content="' . $e($look['themeColor']) . '">';
        $html = "<!doctype html>\n<html lang=\"en\"><head>\n" . implode("\n", $head) . "\n</head><body><h1><a href=\"" . $e($url) . '">' . $e($name) . '</a></h1>'
            . ($description !== '' ? '<p>' . $e($description) . '</p>' : '') . "</body></html>\n";
        $response->getBody()->write($html);
        return $response
            ->withHeader('Content-Type', 'text/html; charset=utf-8')
            // Never kept by a cache in front of the site, where a person could be given it.
            ->withHeader('Cache-Control', 'private, no-store')
            ->withHeader('Vary', 'User-Agent')
            ->withHeader('X-Content-Type-Options', 'nosniff');
    }

    /** GET /sitemap.xml (custom domain) and GET /app/{slug}/sitemap.xml (platform host). */
    public function sitemap(Request $request, Response $response, array $args): Response
    {
        if ($this->seo === null) {
            return $this->notFound($response);
        }
        $slug = isset($args['slug']) ? (string) $args['slug'] : null;
        $host = strtolower(trim(explode(':', $request->getHeaderLine('Host'))[0] ?? ''));
        $app = null;
        $onDomain = false;
        $verifiedDomain = null;
        try {
            if ($slug === null) {
                if ($host === '' || $this->domains->isThisSiteHost($host)) {
                    $xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n</urlset>\n";
                    $response->getBody()->write($xml);
                    return $response
                        ->withHeader('Content-Type', 'application/xml; charset=utf-8')
                        ->withHeader('Cache-Control', 'public, max-age=300')
                        ->withHeader('Vary', 'Host')
                        ->withHeader('X-Content-Type-Options', 'nosniff');
                }
                $resolved = $this->domains->resolveAppSlugByHost($host);
                if ($resolved !== null) {
                    $app = $this->apps->getAppBySlug($resolved['slug']);
                    $onDomain = true;
                    $verifiedDomain = (string) ($resolved['domain'] ?? $host);
                }
            } else {
                $app = $this->apps->getAppBySlug($slug);
            }
        } catch (\Throwable) {
            $app = null;
        }
        if (!$app || empty($app['settings']['softnApp'])) {
            return $this->notFound($response);
        }
        // Return 404 for unpublished/private/noindex apps so /sitemap.xml cannot act as a draft slug existence oracle.
        $assessment = $this->seo->assessIndexability($app);
        if (!$assessment['indexable']) {
            return $this->notFound($response);
        }
        try {
            $base = $onDomain ? $this->domainBase($request, $verifiedDomain ?? $host) : rtrim(AppUrl::frontendBase($request), '/');
        } catch (\Throwable) {
            return $this->notFound($response);
        }
        $xml = $this->seo->buildSitemapXml($app, $base, $onDomain);
        $response->getBody()->write($xml);
        return $response
            ->withHeader('Content-Type', 'application/xml; charset=utf-8')
            ->withHeader('Cache-Control', 'public, max-age=300')
            ->withHeader('Vary', 'Host')
            ->withHeader('X-Content-Type-Options', 'nosniff');
    }

    /** GET /robots.txt (app-aware for custom domains, platform defaults for main host). */
    public function robots(Request $request, Response $response): Response
    {
        $host = strtolower(trim(explode(':', $request->getHeaderLine('Host'))[0] ?? ''));
        $domainApp = null;
        $base = rtrim(AppUrl::frontendBase($request), '/');
        if ($this->seo !== null && $host !== '') {
            try {
                if (!$this->domains->isThisSiteHost($host)) {
                    $resolved = $this->domains->resolveAppSlugByHost($host);
                    if ($resolved !== null) {
                        $candidate = $this->apps->getAppBySlug($resolved['slug']);
                        if (is_array($candidate) && !empty($candidate['settings']['softnApp'])) {
                            $domainApp = $candidate;
                            $base = $this->domainBase($request, (string) ($resolved['domain'] ?? $host));
                        }
                    }
                }
            } catch (\Throwable) {
                $domainApp = null;
            }
        }
        $txt = $this->seo !== null
            ? $this->seo->buildRobotsTxt($domainApp, $base)
            : "User-agent: *\nAllow: /\nDisallow: /api/\n";
        $response->getBody()->write($txt);
        return $response
            ->withHeader('Content-Type', 'text/plain; charset=utf-8')
            ->withHeader('Cache-Control', 'public, max-age=300')
            ->withHeader('Vary', 'Host')
            ->withHeader('X-Content-Type-Options', 'nosniff');
    }

    /** GET /api/apps/{id}/native/seo — owner SEO & discoverable pages overview. */
    public function ownerGetSeo(Request $request, Response $response, array $args): Response
    {
        if ($this->seo === null) {
            return $this->notFound($response);
        }
        $app = $this->requireOwnedApp($request, (string) ($args['id'] ?? ''));
        if ($app === null) {
            return $this->notFound($response);
        }
        return $this->seoOverviewResponse($request, $response, $app);
    }

    /** PUT /api/apps/{id}/native/seo — owner updates indexing toggle, description, and extra SPA routes. */
    public function ownerPutSeo(Request $request, Response $response, array $args): Response
    {
        if ($this->seo === null) {
            return $this->notFound($response);
        }
        $app = $this->requireOwnedApp($request, (string) ($args['id'] ?? ''));
        if ($app === null) {
            return $this->notFound($response);
        }
        $body = $request->getParsedBody();
        if (!is_array($body)) {
            $body = json_decode((string) $request->getBody(), true) ?: [];
        }
        try {
            $next = $this->seo->normalizeSettingsPatch($app, $body);
            $settings = is_array($app['settings'] ?? null) ? $app['settings'] : [];
            $settings['softnSeo'] = $next;
            $this->apps->updateApp((string) $app['id'], ['settings' => $settings]);
            $app['settings'] = $settings;
            return $this->seoOverviewResponse($request, $response, $app);
        } catch (InvalidArgumentException $e) {
            $response->getBody()->write((string) json_encode(['error' => $e->getMessage()]));
            return $response->withStatus(422)->withHeader('Content-Type', 'application/json');
        }
    }

    public static function isPreviewBot(string $userAgent): bool
    {
        return $userAgent !== '' && preg_match('~(?:' . self::PREVIEW_BOTS . ')~i', $userAgent) === 1;
    }

    /**
     * The site's own page, as the web server serves it, with the headers it gives it there (the API's
     * policy would let it run nothing). With $head, the app's name and description in it (withAppHead).
     * When $seoPage is also provided (via SoftnSeoService), enriches canonical URL, robots directive,
     * JSON-LD structured data, and crawlable semantic HTML snapshot inside `<div id="root">`.
     *
     * @param array{name: string, description: string, themeColor: ?string}|null $head
     * @param array{indexable: bool, robots: string, title: string, description: string, canonicalUrl: string, ogImage: ?string, themeColor: ?string, jsonLd: ?string, snapshotHtml: string, pagePath: string}|null $seoPage
     */
    private function sitePage(Response $response, ?array $head = null, ?array $seoPage = null): Response
    {
        $html = false;
        // The web root, or in the package (api/src/Controllers) the folder above the API, where the UI is.
        foreach ([(string) ($_SERVER['DOCUMENT_ROOT'] ?? ''), dirname(__DIR__, 3), dirname(__DIR__, 3) . '/ui/dist'] as $root) {
            $file = $root !== '' ? rtrim($root, '/\\') . '/index.html' : '';
            $html = $file !== '' && is_file($file) ? @file_get_contents($file) : false;
            if (is_string($html)) break;
        }
        if (!is_string($html)) return $this->notFound($response);
        if ($head !== null) {
            $html = self::withAppHead($html, $head);
        }
        if ($seoPage !== null) {
            $html = self::withSeoEnvelope($html, $seoPage);
        }
        $response->getBody()->write($html);
        $out = $response
            ->withHeader('Content-Type', 'text/html; charset=utf-8')
            ->withHeader('Cache-Control', 'no-cache')
            ->withHeader('Vary', 'User-Agent')
            ->withHeader('X-Content-Type-Options', 'nosniff')
            ->withHeader('Content-Security-Policy', \FormLogic\Middleware\SecurityHeadersMiddleware::SITE_PAGE);
        if ($seoPage !== null && !$seoPage['indexable']) {
            $out = $out->withHeader('X-Robots-Tag', 'noindex, nofollow');
        }
        return $out;
    }

    /**
     * Injects canonical URL, robots meta, JSON-LD, og:image, and crawlable `<div id="root">` HTML
     * snapshot for search engines while preserving React hydration cleanly.
     *
     * @param array{indexable: bool, robots: string, title: string, description: string, canonicalUrl: string, ogImage: ?string, themeColor: ?string, jsonLd: ?string, snapshotHtml: string, pagePath: string} $seo
     */
    public static function withSeoEnvelope(string $html, array $seo): string
    {
        $e = static fn(string $text): string => htmlspecialchars($text, ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML5, 'UTF-8');
        $end = stripos($html, '</head>');
        if ($end !== false) {
            $extra = [];
            if ($seo['indexable']) {
                $extra[] = '<link rel="canonical" href="' . $e($seo['canonicalUrl']) . '">';
                $extra[] = '<meta name="robots" content="index, follow">';
                if (!empty($seo['ogImage'])) {
                    $extra[] = '<meta property="og:image" content="' . $e((string) $seo['ogImage']) . '">';
                    $extra[] = '<meta name="twitter:image" content="' . $e((string) $seo['ogImage']) . '">';
                }
                if (!empty($seo['jsonLd'])) {
                    $extra[] = '<script type="application/ld+json">' . $seo['jsonLd'] . '</script>';
                }
            } else {
                $extra[] = '<meta name="robots" content="noindex, nofollow">';
            }
            $html = substr($html, 0, $end) . "\n" . implode("\n", $extra) . "\n" . substr($html, $end);
        }
        if ($seo['indexable'] && $seo['snapshotHtml'] !== '') {
            $snapshot = '<div id="root">' . $seo['snapshotHtml'] . '</div>';
            $replaced = preg_replace_callback(
                '~<div\s+id=["\']root["\']\s*>\s*</div>~i',
                static fn(): string => $snapshot,
                $html,
                1
            );
            if (is_string($replaced)) {
                $html = $replaced;
            }
        }
        return $html;
    }

    /**
     * Resolves browser/crawler SEO head + snapshot for a SoftN app on its custom domain or `/app/{slug}/*`.
     *
     * @return array{head: array{name: string, description: string, themeColor: ?string}, seo: array<string, mixed>}|null
     */
    private function resolvePageSeoForBrowser(Request $request, string $host, ?string $slug, string $subpath): ?array
    {
        if ($this->seo === null) return null;
        $app = null;
        $onDomain = false;
        $verifiedDomain = null;
        try {
            if ($slug === null) {
                if ($host === '' || $this->domains->isThisSiteHost($host)) return null;
                $resolved = $this->domains->resolveAppSlugByHost($host);
                if ($resolved === null || ($resolved['mode'] ?? '') !== 'runtime_direct') return null;
                $app = $this->apps->getAppBySlug($resolved['slug']);
                $onDomain = true;
                $verifiedDomain = (string) ($resolved['domain'] ?? $host);
            } else {
                $app = $this->apps->getAppBySlug($slug);
            }
        } catch (\Throwable) {
            return null;
        }
        if (!$app || empty($app['settings']['softnApp'])) return null;
        // Never leak draft app names/theme colors to unauthenticated requests on either custom or platform hosts.
        if (($app['status'] ?? '') !== 'published') return null;
        try {
            $look = $this->look->resolve($app);
        } catch (\Throwable) {
            $look = null;
        }
        try {
            $base = $onDomain ? $this->domainBase($request, $verifiedDomain ?? $host) : rtrim(AppUrl::frontendBase($request), '/');
        } catch (\Throwable) {
            return null;
        }
        $seoPage = $this->seo->resolvePage($app, $subpath, $base, $onDomain, $look);
        // Never leak private/members-only app titles or theme colors via public SEO head injection.
        if (!$seoPage['indexable']) {
            return null;
        }
        $name = $seoPage['title'] !== ''
            ? $seoPage['title']
            : trim((string) ($app['name'] ?? ''));
        if ($name === '') return null;
        return [
            'head' => [
                'name' => $name,
                'description' => $seoPage['description'],
                'themeColor' => $seoPage['themeColor'],
            ],
            'seo' => $seoPage,
        ];
    }

    /** @param array<string, string> $args */
    private static function extractSubpath(array $args): string
    {
        $raw = (string) ($args['page'] ?? $args['rest'] ?? '');
        $raw = trim($raw, '/');
        if ($raw === '' || strtolower($raw) === 'native') {
            return '/';
        }
        if (str_starts_with(strtolower($raw), 'native/')) {
            $raw = substr($raw, 7);
        }
        return $raw === '' ? '/' : '/' . $raw;
    }

    /** @return array<string, mixed>|null */
    private function requireOwnedApp(Request $request, string $appId): ?array
    {
        $userId = $request->getAttribute('userId');
        if (!is_string($userId) || $userId === '' || $appId === '') {
            $user = $request->getAttribute('user');
            $userId = is_array($user) && !empty($user['id']) ? (string) $user['id'] : '';
        }
        if ($userId === '' || $appId === '') return null;
        $app = $this->apps->getApp($appId);
        if (!$app || (string) ($app['ownerId'] ?? '') !== $userId) return null;
        return $app;
    }

    /** @param array<string, mixed> $app */
    private function seoOverviewResponse(Request $request, Response $response, array $app): Response
    {
        assert($this->seo !== null);
        $assessment = $this->seo->assessIndexability($app);
        $settings = $this->seo->getSettings($app);
        $slug = (string) ($app['slug'] ?? '');
        $customDomain = null;
        try {
            $domains = $this->domains->getDomainsForApp((string) $app['id'], (string) ($app['ownerId'] ?? ''));
            foreach ($domains as $d) {
                if (in_array((string) ($d['status'] ?? ''), ['active', 'verified'], true) && !empty($d['domain'])) {
                    $customDomain = (string) $d['domain'];
                    break;
                }
            }
        } catch (\Throwable) {
            $customDomain = null;
        }
        $onDomain = $customDomain !== null;
        try {
            $platformBase = rtrim(AppUrl::frontendBase($request), '/');
        } catch (\Throwable) {
            $platformBase = $this->domainBase($request, strtolower(trim(explode(':', $request->getHeaderLine('Host'))[0] ?? 'localhost')));
        }
        $base = $onDomain ? 'https://' . $customDomain : $platformBase;
        $discovered = $this->seo->discoverPages($app, $base, $onDomain);
        $pages = array_map(static fn(array $p): array => [
            'path' => $p['path'],
            'title' => $p['title'],
            'description' => $p['description'],
            'canonicalUrl' => $p['canonicalUrl'],
            'source' => $p['source'],
        ], $discovered);

        $payload = [
            'indexable' => $assessment['indexable'],
            'indexabilityReason' => $assessment['reason'],
            'published' => $assessment['published'],
            'access' => $assessment['access'],
            'settings' => $settings,
            'pages' => $pages,
            'sitemapUrl' => $onDomain ? $base . '/sitemap.xml' : $platformBase . '/app/' . rawurlencode($slug) . '/sitemap.xml',
            'robotsUrl' => $base . '/robots.txt',
            'customDomain' => $customDomain,
        ];
        $response->getBody()->write((string) json_encode($payload, JSON_UNESCAPED_SLASHES));
        return $response->withHeader('Content-Type', 'application/json');
    }

    /**
     * What the head of a connected domain's root says of its app: a published SoftN app's name and
     * description, where the domain opens the app at its root ('runtime_direct'), which is where the
     * page shows it (DomainLaunchRouter). Null anywhere else: this site's own address, any other app
     * or mode, and wherever it can't be found out, as the page has to come whatever happens.
     *
     * @return array{name: string, description: string, themeColor: ?string}|null
     */
    private function domainHead(string $host): ?array
    {
        if ($host === '') return null;
        try {
            if ($this->domains->isThisSiteHost($host)) return null;
            $resolved = $this->domains->resolveAppSlugByHost($host);
            if ($resolved === null || ($resolved['mode'] ?? '') !== 'runtime_direct') return null;
            $app = $this->apps->getAppBySlug($resolved['slug']);
            if (!$app || ($app['status'] ?? '') !== 'published' || empty($app['settings']['softnApp'])) return null;
            $name = trim((string) ($app['name'] ?? ''));
            if ($name === '') return null;
            $look = $this->look->resolve($app);
        } catch (\Throwable) {
            return null;
        }
        $description = $look !== null && $look['description'] !== '' ? $look['description'] : trim((string) ($app['description'] ?? ''));
        return ['name' => $name, 'description' => $description, 'themeColor' => $look['themeColor'] ?? null];
    }

    /**
     * $html with the app's name and description in its head: the title, the description, the name an
     * iPhone gives a home-screen icon, the theme colour, the manifest (the domain's own, which installs
     * the app), and the titles and description a link shows. Each element it changes keeps the site's
     * own value (data-fl-original) and the one given it (data-fl-applied), so the page can put the
     * site's back where the domain shows anything but its app (ui/src/lib/domainHead.ts). Every value
     * is text, never markup. An element the page doesn't have is left out.
     *
     * @param array{name: string, description: string, themeColor: ?string} $head
     */
    public static function withAppHead(string $html, array $head): string
    {
        $end = stripos($html, '</head>');
        if ($end === false) return $html;
        $top = substr($html, 0, $end);
        $e = static fn(string $text): string => htmlspecialchars($text, ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML5, 'UTF-8');
        $marks = static fn(string $original, string $applied): string => ' data-fl-original="' . $original . '" data-fl-applied="' . $applied . '"';
        $name = $e($head['name']);
        $top = preg_replace_callback('~<title>([^<]*)</title>~i', static function (array $m) use ($e, $marks, $name): string {
            return '<title' . $marks($e(html_entity_decode($m[1], ENT_QUOTES | ENT_HTML5, 'UTF-8')), $name) . '>' . $name . '</title>';
        }, $top, 1) ?? $top;
        // The first <$tag> naming $which, its $attribute given $value. The value it had is already
        // written as an attribute's, so it is kept as it was written.
        $set = static function (string $top, string $tag, string $which, string $attribute, string $value) use ($marks): string {
            $pattern = '~<' . $tag . '\b(?=[^>]*\s' . preg_quote($which, '~') . '[\s/>])[^>]*>~i';
            return preg_replace_callback($pattern, static function (array $m) use ($attribute, $value, $marks): string {
                return preg_replace_callback('~\s' . $attribute . '="([^"]*)"~i', static fn(array $a): string => ' ' . $attribute . '="' . $value . '"' . $marks($a[1], $value), $m[0], 1) ?? $m[0];
            }, $top, 1) ?? $top;
        };
        foreach (['name="apple-mobile-web-app-title"', 'property="og:site_name"', 'property="og:title"', 'name="twitter:title"'] as $which) {
            $top = $set($top, 'meta', $which, 'content', $name);
        }
        if ($head['description'] !== '') {
            foreach (['name="description"', 'property="og:description"', 'name="twitter:description"'] as $which) {
                $top = $set($top, 'meta', $which, 'content', $e($head['description']));
            }
        }
        if ($head['themeColor'] !== null && preg_match('/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/', $head['themeColor'])) {
            $top = $set($top, 'meta', 'name="theme-color"', 'content', $head['themeColor']);
        }
        $top = $set($top, 'link', 'rel="manifest"', 'href', '/manifest.json');
        return $top . substr($html, $end);
    }

    /** https://<the domain> (http only in development), the Host being a connected domain's. */
    private function domainBase(Request $request, string $host): string
    {
        $development = ($_ENV['APP_ENV'] ?? (getenv('APP_ENV') ?: 'production')) === 'development';
        $scheme = $development && strtolower($request->getUri()->getScheme()) === 'http' ? 'http' : 'https';
        $port = $request->getUri()->getPort();
        return $scheme . '://' . $host . ($development && $port !== null && !in_array($port, [80, 443], true) ? ':' . $port : '');
    }

    private function notFound(Response $response): Response
    {
        $response->getBody()->write(json_encode(['error' => true, 'message' => 'Not found']) ?: '');
        return $response->withStatus(404)->withHeader('Content-Type', 'application/json')->withHeader('Cache-Control', 'no-store');
    }
}

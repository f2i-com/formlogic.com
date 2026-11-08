<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Helpers\AppUrl;
use FormLogic\Services\AppDomainService;
use FormLogic\Services\AppLookService;
use FormLogic\Services\AppService;
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

    public function __construct(private AppService $apps, private AppLookService $look, private AppDomainService $domains) {}

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
        $host = strtolower(trim(explode(':', $request->getHeaderLine('Host'))[0] ?? ''));
        $app = null;
        $onDomain = false;
        if (!self::isPreviewBot($request->getHeaderLine('User-Agent'))) {
            return $this->sitePage($response, $slug === null ? $this->domainHead($host) : null);
        }
        try {
            if ($slug === null) {
                $resolved = $host !== '' ? $this->domains->resolveAppSlugByHost($host) : null;
                if ($resolved !== null) { $app = $this->apps->getAppBySlug($resolved['slug']); $onDomain = true; }
            } else {
                $app = $this->apps->getAppBySlug($slug);
            }
        } catch (\Throwable) {
            $app = null;
        }
        if (!$app || ($app['status'] ?? '') !== 'published' || empty($app['settings']['softnApp'])) return $this->sitePage($response);
        try { $look = $this->look->resolve($app); } catch (\Throwable) { $look = null; }
        if ($look === null) return $this->sitePage($response);
        try {
            $base = $onDomain ? $this->domainBase($request, $host) : rtrim(AppUrl::frontendBase($request), '/');
        } catch (\Throwable) {
            return $this->sitePage($response);
        }
        $appSlug = (string) $app['slug'];
        $url = $onDomain ? $base . '/' : $base . '/app/' . rawurlencode($appSlug);
        $name = mb_substr(trim((string) ($app['name'] ?? '')), 0, 120);
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
        if ($look['description'] !== '') {
            $head[] = '<meta name="description" content="' . $e($look['description']) . '">';
            $head[] = '<meta property="og:description" content="' . $e($look['description']) . '">';
            $head[] = '<meta name="twitter:description" content="' . $e($look['description']) . '">';
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
            . ($look['description'] !== '' ? '<p>' . $e($look['description']) . '</p>' : '') . "</body></html>\n";
        $response->getBody()->write($html);
        return $response
            ->withHeader('Content-Type', 'text/html; charset=utf-8')
            // Never kept by a cache in front of the site, where a person could be given it.
            ->withHeader('Cache-Control', 'private, no-store')
            ->withHeader('Vary', 'User-Agent')
            ->withHeader('X-Content-Type-Options', 'nosniff');
    }

    public static function isPreviewBot(string $userAgent): bool
    {
        return $userAgent !== '' && preg_match('~(?:' . self::PREVIEW_BOTS . ')~i', $userAgent) === 1;
    }

    /**
     * The site's own page, as the web server serves it, with the headers it gives it there (the API's
     * policy would let it run nothing). With $head, the app's name and description in it (withAppHead).
     *
     * @param array{name: string, description: string, themeColor: ?string}|null $head
     */
    private function sitePage(Response $response, ?array $head = null): Response
    {
        $html = false;
        // The web root, or in the package (api/src/Controllers) the folder above the API, where the UI is.
        foreach ([(string) ($_SERVER['DOCUMENT_ROOT'] ?? ''), dirname(__DIR__, 3)] as $root) {
            $file = $root !== '' ? rtrim($root, '/\\') . '/index.html' : '';
            $html = $file !== '' && is_file($file) ? @file_get_contents($file) : false;
            if (is_string($html)) break;
        }
        if (!is_string($html)) return $this->notFound($response);
        $response->getBody()->write($head !== null ? self::withAppHead($html, $head) : $html);
        return $response
            ->withHeader('Content-Type', 'text/html; charset=utf-8')
            ->withHeader('Cache-Control', 'no-cache')
            ->withHeader('Vary', 'User-Agent')
            ->withHeader('X-Content-Type-Options', 'nosniff')
            ->withHeader('Content-Security-Policy', \FormLogic\Middleware\SecurityHeadersMiddleware::SITE_PAGE);
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

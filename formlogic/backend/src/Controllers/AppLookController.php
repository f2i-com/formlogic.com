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
        // Addressed by the look's version (`?v=`), it never changes: an app or look that changes is
        // served at a new address.
        $versioned = ($request->getQueryParams()['v'] ?? '') !== '';
        // A published app's look is its public face, as its name is. A draft's is its owner's alone.
        $published = ($app['status'] ?? '') === 'published';
        $response = $response
            ->withHeader('ETag', $etag)
            ->withHeader('Cache-Control', !$published ? 'private, no-cache' : ($versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=3600'))
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
     * GET / and /app/{slug}, for a link-preview service only (the rewrite sends nobody else): the
     * app's name, description, image and icon, at the address that was shared, for a published
     * SoftN app at /app/<slug> or on its own domain. Anything else, and anyone else, gets the site's
     * own page as it is.
     */
    public function sharePage(Request $request, Response $response, array $args): Response
    {
        $slug = isset($args['slug']) ? (string) $args['slug'] : null;
        $host = strtolower(trim(explode(':', $request->getHeaderLine('Host'))[0] ?? ''));
        $app = null;
        $onDomain = false;
        if (self::isPreviewBot($request->getHeaderLine('User-Agent'))) {
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

    /** The site's own page, as the web server serves it to everyone else. */
    private function sitePage(Response $response): Response
    {
        $root = (string) ($_SERVER['DOCUMENT_ROOT'] ?? '');
        $file = $root !== '' ? rtrim($root, '/\\') . '/index.html' : '';
        $html = $file !== '' && is_file($file) ? @file_get_contents($file) : false;
        if (!is_string($html)) return $this->notFound($response);
        $response->getBody()->write($html);
        return $response
            ->withHeader('Content-Type', 'text/html; charset=utf-8')
            ->withHeader('Cache-Control', 'no-cache')
            ->withHeader('Vary', 'User-Agent');
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

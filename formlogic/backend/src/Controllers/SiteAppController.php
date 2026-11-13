<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Middleware\SecurityHeadersMiddleware;
use FormLogic\Services\AppService;
use FormLogic\Services\McpOAuthService;
use FormLogic\Services\NativeAppService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Serves a JavaScript app's built site: someone's compiled front end, file by file, to the frame
 * its app's page shows it in.
 *
 * These are the only documents and scripts of an app's that this site sends for a browser to run
 * as they are, so everything here is about holding them:
 *  - every file goes out under the sandbox policy for its own address
 *    (SecurityHeadersMiddleware::siteFramePolicy): no origin, no cookies, no network but the
 *    site's own files. Opened directly, outside its frame, a file is held the same way.
 *  - the page has no origin, so its requests carry no session. What admits a request is the
 *    address: a ticket signed for this app and version (NativeAppService::siteTicket), handed
 *    out only with the runtime descriptor, to whoever may open the app.
 *  - a page of the site is never sent bare. It is sent as a small document that first makes the
 *    line to the framing page (resources/site-boot.js: the app's backend, storage) and then
 *    loads the page itself, asked for with `?formlogic-raw=1`.
 *  - a build is made to sit at the root of a site of its own, and here it sits under a long
 *    address. So an address that names no file is the app's first page (a single-page app's
 *    screens), and a stylesheet's files named from the root are pointed at the site's own; the
 *    boot script does the same for the page (its address, its scripts, pictures and requests).
 *  - a file's name is held to the rule it was installed under, so no address reaches outside the
 *    site's own folder.
 */
final class SiteAppController
{
    /**
     * The type each kind of site file is sent as. A kind a site keeps that is not here (a game's
     * data) is sent as plain bytes; what a site does not keep is never found (NativeAppService::isSitePath).
     */
    private const TYPES = [
        'html' => 'text/html; charset=utf-8', 'htm' => 'text/html; charset=utf-8',
        'js' => 'text/javascript; charset=utf-8', 'mjs' => 'text/javascript; charset=utf-8', 'cjs' => 'text/javascript; charset=utf-8',
        'css' => 'text/css; charset=utf-8', 'json' => 'application/json; charset=utf-8', 'map' => 'application/json; charset=utf-8',
        'webmanifest' => 'application/manifest+json', 'xml' => 'application/xml; charset=utf-8', 'txt' => 'text/plain; charset=utf-8',
        'md' => 'text/markdown; charset=utf-8', 'csv' => 'text/csv; charset=utf-8',
        'svg' => 'image/svg+xml', 'png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'gif' => 'image/gif',
        'webp' => 'image/webp', 'avif' => 'image/avif', 'ico' => 'image/x-icon', 'bmp' => 'image/bmp',
        'woff' => 'font/woff', 'woff2' => 'font/woff2', 'ttf' => 'font/ttf', 'otf' => 'font/otf', 'eot' => 'application/vnd.ms-fontobject',
        'mp3' => 'audio/mpeg', 'wav' => 'audio/wav', 'ogg' => 'audio/ogg', 'opus' => 'audio/ogg', 'aac' => 'audio/aac', 'flac' => 'audio/flac', 'm4a' => 'audio/mp4',
        'mp4' => 'video/mp4', 'webm' => 'video/webm', 'wasm' => 'application/wasm',
        'glb' => 'model/gltf-binary', 'gltf' => 'model/gltf+json', 'bin' => 'application/octet-stream', 'pdf' => 'application/pdf',
        'cur' => 'image/x-icon', 'tif' => 'image/tiff', 'tiff' => 'image/tiff', 'jxl' => 'image/jxl', 'ttc' => 'font/collection',
        'mid' => 'audio/midi', 'midi' => 'audio/midi', 'm4v' => 'video/mp4', 'mov' => 'video/quicktime', 'ogv' => 'video/ogg',
        'vtt' => 'text/vtt; charset=utf-8', 'srt' => 'text/plain; charset=utf-8', 'tsv' => 'text/tab-separated-values; charset=utf-8',
        'yaml' => 'text/yaml; charset=utf-8', 'yml' => 'text/yaml; charset=utf-8', 'toml' => 'text/plain; charset=utf-8',
        'geojson' => 'application/geo+json', 'ndjson' => 'application/x-ndjson', 'rss' => 'application/rss+xml', 'atom' => 'application/atom+xml',
        'ics' => 'text/calendar; charset=utf-8', 'zip' => 'application/zip', 'stl' => 'model/stl', 'usdz' => 'model/vnd.usdz+zip',
        'obj' => 'text/plain; charset=utf-8', 'mtl' => 'text/plain; charset=utf-8', 'atlas' => 'text/plain; charset=utf-8',
        'glsl' => 'text/plain; charset=utf-8', 'vert' => 'text/plain; charset=utf-8', 'frag' => 'text/plain; charset=utf-8', 'wgsl' => 'text/plain; charset=utf-8',
    ];

    /**
     * What kind of file a path names, and how the build packed it: ['wasm', 'br'] for
     * game.wasm.br, ['js', null] for app.js. Read in lower case, as the rule reads a name.
     *
     * @return array{0: string, 1: 'br'|'gzip'|null}
     */
    private static function kindOf(string $path): array
    {
        $name = strtolower(basename($path));
        $packed = null;
        if (str_ends_with($name, '.br')) { $packed = 'br'; $name = substr($name, 0, -3); }
        elseif (str_ends_with($name, '.gz')) { $packed = 'gzip'; $name = substr($name, 0, -3); }
        return [pathinfo($name, PATHINFO_EXTENSION), $packed];
    }

    public function __construct(private AppService $apps, private NativeAppService $native)
    {
    }

    /** The address of a built site's first page, for the runtime descriptor: under the API, with its ticket. */
    public static function address(string $slug, string $ticket, string $entry): string
    {
        // Under the API's own base, as every address the page is given is (the media pack's too):
        // the page joins it to wherever this installation's API is.
        return '/app/' . rawurlencode($slug) . '/site/' . $ticket . '/' . implode('/', array_map('rawurlencode', explode('/', $entry)));
    }

    /** @param array<string, string> $args */
    public function serve(Request $request, Response $response, array $args): Response
    {
        try {
            return $this->answer($request, $response, $args);
        } catch (\RuntimeException $busy) {
            // The app is being updated, or put back after a failed update: asked again in a moment
            // it answers. Said as that, and not as a fault of the server's.
            if (!in_array($busy->getCode(), [409, 423, 503], true)) throw $busy;
            return $this->refuse(new \Slim\Psr7\Response(), 503, 'The app is being updated. Try again in a moment.')->withHeader('Retry-After', '2');
        }
    }

    /** @param array<string, string> $args */
    private function answer(Request $request, Response $response, array $args): Response
    {
        $app = $this->apps->getAppBySlug((string) ($args['slug'] ?? ''));
        $key = $app ? $this->native->siteKey((string) $app['id']) : null;
        if (!$app || $key === null) return $this->refuse($response, 404, 'This app has no site to show.');
        $ticket = (string) ($args['ticket'] ?? '');
        // The ticket first, and by its signature alone: anyone can ask this address anything, and
        // what follows reads the app's files. One answer for every ticket that does not admit
        // (another app's, past its day, not signed here), and below for one of another version:
        // the page that frames the site asks for a new address and loads again.
        $version = NativeAppService::siteTicketVersion($ticket, $key, (string) $app['id']);
        if ($version === null) return $this->refuse($response, 410, 'This address of the app is no longer in use. Open the app again.');
        $site = $this->native->site((string) $app['id']);
        if ($site === null) return $this->refuse($response, 404, 'This app has no site to show.');
        if ($site['version'] !== $version) return $this->refuse($response, 410, 'This address of the app is no longer in use. Open the app again.');
        if (preg_match(SecurityHeadersMiddleware::SITE_FRAME_PATH, $request->getUri()->getPath(), $found) !== 1) return $this->refuse($response, 404, 'Not found.');
        $root = $found[1];
        $policy = SecurityHeadersMiddleware::siteFramePolicy(McpOAuthService::publicOrigin($request), $root);
        // How the browser means to use what it asks for (Sec-Fetch-Dest): "document" is a tab of
        // its own, "iframe" the app's frame, "empty" a script's fetch, and so on. One too old to
        // say sends nothing, and is served as before.
        $as = strtolower(trim($request->getHeaderLine('Sec-Fetch-Dest')));

        $asked = rawurldecode((string) ($args['path'] ?? ''));
        // The site's own address, or a folder of it, is that folder's first page.
        $path = $asked === '' ? $site['entry'] : (str_ends_with($asked, '/') ? $asked . 'index.html' : $asked);
        [$kind, $packed] = self::kindOf($path);
        // siteFile holds the path to the rule it was installed under: only a kind of file a site
        // keeps is found. One with no type of its own here (a game's data) is sent as plain bytes.
        $type = self::TYPES[$kind] ?? 'application/octet-stream';
        $file = $this->native->siteFile((string) $app['id'], $path);
        if ($file === null) {
            // An address that names no file and does not look like one (/prices, /orders/12) is a
            // screen of a single-page app, which its own router draws: the app's first page is
            // sent for it, as a site's server sends index.html for any address. A missing file
            // (it ends in a kind of file) is a missing file.
            $last = basename($asked);
            $screen = $asked !== '' && strlen($asked) <= NativeAppService::MAX_SITE_PATH_LENGTH && !str_contains($last, '.') && !str_contains($asked, '..');
            $file = $screen ? $this->native->siteFile((string) $app['id'], $site['entry']) : null;
            if ($file === null) return $this->refuse($response, 404, 'The app has no such file.');
            [$path, $kind, $packed, $type] = [$site['entry'], 'html', null, self::TYPES['html']];
        }

        // Nothing of an app's that a browser draws as a page (its pages, an SVG, XML) is opened as
        // a tab of its own. The address is on this site's own name, and a page an app's owner
        // wrote, standing there alone under that name, is a sign-in page waiting to be faked. It
        // would have no origin and no cookies, and a person would have only the address bar to
        // go by. An app's pages are for its frame; a picture or a PDF opened in a tab is a file.
        // A feed is XML too, and a browser draws and runs an XHTML page saved under any XML kind.
        if ($as === 'document' && in_array($kind, ['html', 'htm', 'svg', 'xml', 'rss', 'atom'], true)) {
            fclose($file['stream']);
            return $this->refuse($response, 403, 'This is a file of an app on FormLogic. Open the app itself to use it.');
        }
        // A page kept packed (index.html.gz) is a file like any other: only a plain page is the app's document.
        $page = ($kind === 'html' || $kind === 'htm') && $packed === null;
        // The page itself, not the boot document: for the app's own script reading one of its
        // HTML files with fetch (the boot script reading the page it is about to become, a
        // template, a partial), which is not a page being opened. In the frame it is always the
        // boot document, whatever the address says.
        $framed = in_array($as, ['iframe', 'frame', 'embed', 'object'], true);
        $bare = !$framed && ($as !== '' || ($request->getQueryParams()['formlogic-raw'] ?? null) === '1' || !self::acceptsAPage($request));
        if ($page && !$bare) {
            // The page is asked for as a document: what is sent is the small document that sets up
            // the line to the framing page and then loads this page into itself.
            fclose($file['stream']);
            $document = $this->bootDocument($root, $path, NativeAppService::siteProof($site['key'], $ticket));
            $response->getBody()->write($document);
            return $response
                ->withHeader('Content-Type', 'text/html; charset=utf-8')
                ->withHeader('Content-Security-Policy', $policy)
                ->withHeader('Cache-Control', 'no-store, no-transform');
        }
        if ($kind === 'css' && $packed === null) {
            // A stylesheet names its pictures and fonts from the root when the build was made for
            // the root of a site (url(/assets/font.woff2)). Here that is the platform's root, so
            // such an address is pointed at the site's own files, as the page's are by its script.
            $sheet = (string) stream_get_contents($file['stream']);
            fclose($file['stream']);
            $sheet = (string) preg_replace(['~(url\(\s*["\']?)/(?!/)~i', '~(@import\s+["\'])/(?!/)~i'], '${1}' . $root, $sheet);
            $response->getBody()->write($sheet);
            $sent = $response;
        } elseif ($packed === null && !$page && ($part = self::partAsked($request->getHeaderLine('Range'), $file['size'])) !== null) {
            // Part of a file, as a player asks for sound and video (Safari plays neither without).
            if ($part === false) {
                fclose($file['stream']);
                return $this->refuse($response, 416, 'The file is not that long.')->withHeader('Content-Range', 'bytes */' . $file['size']);
            }
            [$first, $last] = $part;
            fseek($file['stream'], $first);
            $response->getBody()->write((string) stream_get_contents($file['stream'], $last - $first + 1));
            fclose($file['stream']);
            $sent = $response->withStatus(206)->withHeader('Content-Range', "bytes {$first}-{$last}/{$file['size']}")->withHeader('Accept-Ranges', 'bytes');
        } else {
            $sent = $response->withBody(new \Slim\Psr7\Stream($file['stream']))->withHeader('Content-Length', (string) $file['size']);
            // A file the build packed itself (game.wasm.br) is sent as what it holds, said to be
            // packed, which is how the build's loader asks for it.
            if ($packed !== null) $sent = $sent->withHeader('Content-Encoding', $packed);
            elseif (!$page) $sent = $sent->withHeader('Accept-Ranges', 'bytes');
        }
        return $sent
            ->withHeader('Content-Type', $type)
            ->withHeader('Content-Security-Policy', $policy)
            // The page has no origin, so every script, font and fetch of its own files is a
            // cross-origin read to the browser. These are the app's public files and the request
            // carries no session: any reader may have them.
            ->withHeader('Access-Control-Allow-Origin', '*')
            ->withHeader('Cross-Origin-Resource-Policy', 'cross-origin')
            // The address names the version, so what it names never changes; a page is read afresh.
            // no-transform: a proxy that rewrites pages on their way (to add its own script) would
            // add one the page's policy then refuses, or break a file the build made.
            ->withHeader('Cache-Control', $page ? 'no-store, no-transform' : 'private, max-age=86400, immutable, no-transform');
    }

    /**
     * For a browser too old to say how it means to use what it asks for: whether it is opening a
     * page, read by what it accepts (a page being opened asks for text/html; a script's fetch
     * asks for anything). A request that says nothing at all is taken as opening a page.
     */
    private static function acceptsAPage(Request $request): bool
    {
        $accepts = strtolower($request->getHeaderLine('Accept'));
        return $accepts === '' || str_contains($accepts, 'text/html');
    }

    /**
     * The part of a file a Range header asks for ("bytes=0-1023", "bytes=500-", "bytes=-200"):
     * [first, last], null to send the file whole (no header, or one this does not read, such as
     * several parts at once), or false when the part is past the file's end.
     *
     * @return array{0: int, 1: int}|false|null
     */
    private static function partAsked(string $header, int $size): array|false|null
    {
        if (preg_match('/^bytes=(\d{0,18})-(\d{0,18})$/D', trim($header), $asked) !== 1 || ($asked[1] === '' && $asked[2] === '')) return null;
        if ($asked[1] === '') {
            $tail = (int) $asked[2];
            return $tail === 0 || $size === 0 ? false : [max(0, $size - $tail), $size - 1];
        }
        $first = (int) $asked[1];
        $last = $asked[2] === '' ? $size - 1 : min((int) $asked[2], $size - 1);
        return $first >= $size || $first > $last ? false : [$first, $last];
    }

    /**
     * The document a page of the site is sent as: nothing but the boot script, told where the
     * site's root is, which page it is to load, and the proof to show the framing page.
     */
    private function bootDocument(string $root, string $page, string $proof): string
    {
        $boot = (string) file_get_contents(dirname(__DIR__, 2) . '/resources/site-boot.js');
        $attribute = static fn (string $value): string => htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>'
            . '<script data-root="' . $attribute($root) . '" data-page="' . $attribute($page) . '" data-proof="' . $attribute($proof) . '">'
            // The script is this site's own; closing tags in it are kept from ending the element.
            . str_replace('</script', '<\/script', $boot)
            . '</script></body></html>';
    }

    private function refuse(Response $response, int $status, string $message): Response
    {
        $response->getBody()->write($message);
        return $response->withStatus($status)->withHeader('Content-Type', 'text/plain; charset=utf-8')->withHeader('Cache-Control', 'no-store');
    }
}

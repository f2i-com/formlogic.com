<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\SiteAppController;
use FormLogic\Middleware\SecurityHeadersMiddleware;
use FormLogic\Services\{AppService, NativeAppService};
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * A JavaScript app's built site, served file by file to the frame its app's page shows it in: a
 * page goes out to its frame as the boot document, to a script that reads it as itself, and to a
 * tab of its own not at all; every file goes out under the sandbox policy for its own address,
 * the ticket in the address is what admits a request, and no address reaches a file outside the
 * site's own folder.
 *
 * The app is installed for real (NativeAppService::install, a project with no backend, so nothing
 * is started): what is served here is what an install lays down.
 */
final class SiteAppControllerTest extends TestCase
{
    private const ORIGIN = 'https://apps.example.test';
    private const APP_ID = 'shop-id';
    /** The apps the site knows by their address: one with a built site, a SoftN app, and one with nothing installed. */
    private const APPS = [
        'shop' => ['id' => 'shop-id', 'slug' => 'shop', 'ownerId' => 'owner', 'name' => 'Shop', 'status' => 'published', 'settings' => ['softnApp' => true]],
        'notes' => ['id' => 'notes-id', 'slug' => 'notes', 'ownerId' => 'owner', 'name' => 'Notes', 'status' => 'published', 'settings' => ['softnApp' => true]],
        'empty' => ['id' => 'empty-id', 'slug' => 'empty', 'ownerId' => 'owner', 'name' => 'Empty', 'status' => 'published', 'settings' => []],
    ];
    /** The API's own policy, which every response that is not a file of a site is held to. */
    private const API_POLICY = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
    /** How a file of the site is kept by the browser, how a page of it is (read afresh), and what a refusal is sent as. No proxy on the way rewrites either. */
    private const KEPT = 'private, max-age=86400, immutable, no-transform';
    private const AFRESH = 'no-store, no-transform';
    private const PLAIN = 'text/plain; charset=utf-8';
    /** The value this browser keeps for the app, which its tickets are made for: so its address is the same all day. */
    private const FRAME = '0123456789abcdef0123456789abcdef';

    private const PAGE = '<!doctype html><html><head><title>Shop</title><link rel="stylesheet" href="/assets/app.css"></head><body><main id="shop-own-markup">Shop</main><script type="module" src="/assets/app.js"></script></body></html>';
    private const DOCS = '<!doctype html><html><body><h1 id="docs-own-markup">Docs</h1></body></html>';
    private const ABOUT = '<!doctype html><html><body><p id="about-own-markup">About</p></body></html>';
    private const SCRIPT = 'document.getElementById("shop-own-markup").textContent = "ready";';
    private const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle id="mark-own-markup" cx="4" cy="4" r="3"/></svg>';
    private const FEED = '<?xml version="1.0" encoding="UTF-8"?><feed id="feed-own-markup"><title>Shop</title></feed>';
    private const PNG = "\x89PNG\r\n\x1a\n\x00\xff\x80\x07";
    private const JPEG = "\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01";
    private const PACKED_WASM = "\x1b\x0b\x00\xf8packed-wasm\x03";
    private const PACKED_SCRIPT = "\x1f\x8b\x08\x00packed-script";
    private const GAME_DATA = "\x00\x01\x02game-data";

    /** A stylesheet as a build writes one, line by line: as written, then as sent ("{root}" is the site's own address) where that differs. */
    private const SHEET = [
        // Named from the root of a site: pointed at the site's own files.
        ['@import "/base.css";', '@import "{root}base.css";'],
        ["@import '/theme/dark.css';", "@import '{root}theme/dark.css';"],
        ['@import url(/reset.css);', '@import url({root}reset.css);'],
        ['.a { background: url(/assets/logo.png); }', '.a { background: url({root}assets/logo.png); }'],
        ['.b { background: url("/assets/b.png"); }', '.b { background: url("{root}assets/b.png"); }'],
        [".c { background: url( '/assets/c.png' ); }", ".c { background: url( '{root}assets/c.png' ); }"],
        ['@font-face { font-family: X; src: URL(/fonts/x.woff2) format("woff2"); }', '@font-face { font-family: X; src: URL({root}fonts/x.woff2) format("woff2"); }'],
        // Named from where the stylesheet is, or on another host: left as written.
        ['@import "relative.css";'],
        ['@import "//cdn.other.host/x.css";'],
        ['.d { background: url(assets/d.png); }'],
        ['.e { background: url(../e.png); }'],
        ['.f { background: url(//other.host/f.png); }'],
        ['.g { background: url("//other.host/g.png"); }'],
        ['.h { background: url(https://other.host/h.png); }'],
        ['.i { background: url(data:image/png;base64,AAAA); }'],
    ];

    private ?string $storage = null;
    /** @var list<string> every folder a test keeps apps in: the fixture's own, and any other installation's it made */
    private array $folders = [];
    private NativeAppService $native;
    private SiteAppController $controller;

    protected function setUp(): void
    {
        $this->storage = $this->folder();
        $this->native = new NativeAppService($this->storage, $this->storage . '/no-runtime');
        $this->native->install(self::APP_ID, self::project(self::site()), 0);
        $this->controller = new SiteAppController($this->apps(), $this->native);
    }

    protected function tearDown(): void
    {
        foreach ($this->folders as $folder) {
            if (!is_dir($folder)) continue;
            $root = realpath($folder);
            $temp = realpath(sys_get_temp_dir()) . DIRECTORY_SEPARATOR;
            if ($root === false || !str_starts_with($root, $temp) || !str_starts_with(basename($root), 'formlogic-site-app-')) throw new \RuntimeException('Unexpected fixture path');
            $iterator = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
            foreach ($iterator as $file) { if ($file->isDir() && !$file->isLink()) rmdir($file->getPathname()); else unlink($file->getPathname()); }
            rmdir($root);
        }
    }

    /** A folder for an installation to keep its apps in, removed when the test is over. */
    private function folder(): string
    {
        $folder = sys_get_temp_dir() . '/formlogic-site-app-' . bin2hex(random_bytes(8));
        mkdir($folder, 0700);
        return $this->folders[] = $folder;
    }

    /** The apps the site knows by their address. */
    private function apps(): AppService
    {
        $apps = $this->createMock(AppService::class);
        $apps->method('getAppBySlug')->willReturnCallback(static fn (string $slug): ?array => self::APPS[$slug] ?? null);
        return $apps;
    }

    /** The built site: a first page, a folder with a page of its own, an older page, a script, a stylesheet, pictures, a feed and a game's packed files. */
    private static function site(): array
    {
        return [
            'site/index.html' => self::PAGE,
            'site/docs/index.html' => self::DOCS,
            'site/about.htm' => self::ABOUT,
            'site/feed.xml' => self::FEED,
            'site/assets/app.js' => self::SCRIPT,
            'site/assets/app.css' => implode("\n", array_column(self::SHEET, 0)),
            'site/assets/logo.png' => self::PNG,
            'site/assets/mark.svg' => self::SVG,
            'site/assets/vendor.js.gz' => self::PACKED_SCRIPT,
            'site/Build/game.wasm.br' => self::PACKED_WASM,
            'site/Build/game.data' => self::GAME_DATA,
            'site/photos/IMG_1.JPG' => self::JPEG,
        ];
    }

    /** A JavaScript app's project as it is uploaded: the manifest among the files, the built site among the assets. */
    private static function project(array $site): array
    {
        return ['access' => 'application', 'files' => ['manifest.json' => '{"name":"Shop","version":"1.0.0","site":{"entry":"index.html"}}'], 'assets' => array_map('base64_encode', $site)];
    }

    /** Where the install keeps the app: its project, its private configuration and its staged files. */
    private function root(): string
    {
        return $this->storage . '/' . hash('sha256', self::APP_ID);
    }

    /** What the service answers for the installed site: its version, its first page, the key its addresses are signed with. */
    private function installed(): array
    {
        $site = $this->native->site(self::APP_ID);
        $this->assertNotNull($site, 'the installed project has a built site');
        return $site;
    }

    /**
     * A ticket as the runtime descriptor hands one out: for this app, as installed, now, to the
     * frame this browser keeps for the app. So it is the same ticket each time a test asks.
     */
    private function ticket(): string
    {
        $site = $this->installed();
        return NativeAppService::siteTicket($site['key'], self::APP_ID, $site['version'], null, self::FRAME);
    }

    private static function prefix(string $ticket, string $slug = 'shop'): string
    {
        return '/api/app/' . $slug . '/site/' . $ticket . '/';
    }

    /** @param array<string, string> $headers what the browser sends with it; none is one too old to say how it means to use the file */
    private function request(string $path, string $ticket, array $query, string $slug, string $origin, array $headers = []): ServerRequestInterface
    {
        $address = $origin . self::prefix($ticket, $slug) . implode('/', array_map('rawurlencode', explode('/', $path)));
        $request = (new ServerRequestFactory())->createServerRequest('GET', $address . ($query ? '?' . http_build_query($query) : ''))->withQueryParams($query);
        foreach ($headers as $name => $value) $request = $request->withHeader($name, $value);
        return $request;
    }

    /**
     * One request for a file of the site, as the router hands it to the controller: `$path` is what
     * follows the ticket in the address, decoded once. The body is read and the file behind it
     * closed (an open file cannot be removed on Windows when the fixture goes).
     *
     * @param array<string, string> $headers
     * @return array{0: ResponseInterface, 1: string} the response and its body
     */
    private function fetch(string $path, ?string $ticket = null, array $query = [], string $slug = 'shop', array $headers = [], ?SiteAppController $controller = null): array
    {
        $ticket ??= $this->ticket();
        $response = ($controller ?? $this->controller)->serve($this->request($path, $ticket, $query, $slug, self::ORIGIN, $headers), new Response(), ['slug' => $slug, 'ticket' => $ticket, 'path' => $path]);
        $body = (string) $response->getBody();
        $response->getBody()->close();
        return [$response, $body];
    }

    /**
     * The same request answered through the API's security headers, as every response is.
     *
     * @param array<string, string> $headers
     */
    private function through(string $path, string $ticket, array $query, string $origin, array $headers = []): ResponseInterface
    {
        $handler = new class($this->controller, ['slug' => 'shop', 'ticket' => $ticket, 'path' => $path]) implements RequestHandlerInterface {
            /** @param array<string, string> $args */
            public function __construct(private SiteAppController $controller, private array $args) {}
            public function handle(ServerRequestInterface $request): ResponseInterface { return $this->controller->serve($request, new Response(), $this->args); }
        };
        $response = (new SecurityHeadersMiddleware())->process($this->request($path, $ticket, $query, 'shop', $origin, $headers), $handler);
        $response->getBody()->close();
        return $response;
    }

    /**
     * What a boot document tells its script: the data attributes of its script element, read as a
     * browser reads them.
     *
     * @return array{root: string, page: string, proof: string}
     */
    private static function told(string $document): array
    {
        self::assertSame(1, preg_match('~<script\b([^>]*)>~', $document, $tag), 'the document has a script element');
        $told = [];
        foreach (['root', 'page', 'proof'] as $name) {
            self::assertSame(1, preg_match('~\sdata-' . $name . '="([^"]*)"~', $tag[1], $value), "the script is told data-{$name}");
            $told[$name] = html_entity_decode($value[1], ENT_QUOTES | ENT_HTML5, 'UTF-8');
        }
        return $told;
    }

    /** The boot script as a document carries it: its closing tags kept from ending the script element. */
    private static function bootScript(): string
    {
        $boot = (string) file_get_contents(dirname(__DIR__, 2) . '/resources/site-boot.js');
        self::assertNotSame('', $boot, 'resources/site-boot.js is there to send');
        return str_replace('</script', '<\/script', $boot);
    }

    public function testAnInstalledSiteAnswersWithItsVersionItsFirstPageAndAKeyOfItsOwn(): void
    {
        $site = $this->installed();
        $this->assertSame(1, $site['version']);
        $this->assertSame('index.html', $site['entry']);
        $this->assertSame(32, strlen($site['key']));
        $this->assertSame($site, $this->installed(), 'the same each time it is asked');
        $this->assertSame($site['key'], $this->native->siteKey(self::APP_ID), 'the key the service signs this app\'s addresses with');
        // The install lays the site out where it is served from, and the app's own key is no part of how its addresses are signed.
        $this->assertSame(self::PAGE, file_get_contents($this->root() . '/app/site/index.html'));
        $config = json_decode((string) file_get_contents($this->root() . '/private/config.json'), true);
        $this->assertNotSame(hex2bin($config['keyHex']), $site['key'], 'addresses are not signed with the app\'s own key');
    }

    public function testAddressesAreSignedWithASecretTheInstallationMakesOnceAndKeepsInNoAppsFolder(): void
    {
        $key = $this->native->siteKey(self::APP_ID);
        $this->assertNotNull($key);
        $file = $this->storage . '/site-addresses.key';
        $this->assertFileExists($file);
        $secret = (string) file_get_contents($file);
        $this->assertMatchesRegularExpression('/^[a-f0-9]{64}$/D', $secret);
        $this->assertNotSame(hex2bin($secret), $key, 'an app\'s key is made from the secret, and is not the secret');

        // Beside the apps' folders, in none of them: nothing an app is served from, exported with or brought in with holds it.
        $this->assertDirectoryExists($this->root());
        $this->assertSame(realpath($this->storage), realpath(dirname($file)));
        $inApps = [];
        foreach (new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($this->root(), \FilesystemIterator::SKIP_DOTS)) as $kept) {
            if ($kept->getFilename() === basename($file)) $inApps[] = $kept->getPathname();
        }
        $this->assertSame([], $inApps);

        // Made once: asked again, by this service or by another on the same folder (the next request),
        // the secret is read and not made anew, so an address handed out by one is admitted by the other.
        $next = new NativeAppService($this->storage, $this->storage . '/no-runtime');
        $this->assertSame($key, $next->siteKey(self::APP_ID));
        $this->assertSame($key, $this->native->siteKey(self::APP_ID));
        $this->assertSame($secret, file_get_contents($file), 'the file is as it was made');
        $this->assertSame($this->installed(), $next->site(self::APP_ID));
        $handed = NativeAppService::siteTicket((string) $next->siteKey(self::APP_ID), self::APP_ID, 1, null, self::FRAME);
        $this->assertSame(200, $this->fetch('assets/app.js', $handed)[0]->getStatusCode());
    }

    public function testEachAppHasAKeyOfItsOwnAndAnotherInstallationHasOthers(): void
    {
        $key = $this->native->siteKey(self::APP_ID);
        // Another app of this installation, with something installed or not: a ticket signed for one admits nobody to another.
        $keys = ['shop' => $key, 'notes' => $this->native->siteKey('notes-id'), 'empty' => $this->native->siteKey('empty-id')];
        foreach ($keys as $whose => $one) $this->assertSame(32, strlen((string) $one), $whose);
        $this->assertCount(3, array_unique($keys), 'each its own');
        $this->assertSame(410, $this->fetch('assets/app.js', NativeAppService::siteTicket((string) $keys['notes'], self::APP_ID, 1, null, self::FRAME))[0]->getStatusCode());

        // Another installation, keeping its apps in a folder of its own, makes a secret of its own:
        // the same app there has another key, and its addresses are not this one's.
        $elsewhere = $this->folder();
        $other = new NativeAppService($elsewhere, $elsewhere . '/no-runtime');
        $theirs = $other->siteKey(self::APP_ID);
        $this->assertNotNull($theirs);
        $this->assertNotSame($key, $theirs);
        $this->assertMatchesRegularExpression('/^[a-f0-9]{64}$/D', (string) file_get_contents($elsewhere . '/site-addresses.key'));
        $this->assertNotSame(file_get_contents($this->storage . '/site-addresses.key'), file_get_contents($elsewhere . '/site-addresses.key'));
        $this->assertSame(410, $this->fetch('assets/app.js', NativeAppService::siteTicket($theirs, self::APP_ID, 1, null, self::FRAME))[0]->getStatusCode());
        $this->assertSame(200, $this->fetch('assets/app.js', NativeAppService::siteTicket((string) $key, self::APP_ID, 1, null, self::FRAME))[0]->getStatusCode());

        // Where the apps' folder is not there yet, there is nothing to sign with, and none is made.
        $nowhere = new NativeAppService($this->storage . '/not-there', $this->storage . '/no-runtime');
        $this->assertNull($nowhere->siteKey(self::APP_ID));
        $this->assertDirectoryDoesNotExist($this->storage . '/not-there');
    }

    public function testBringingInAnotherKeyForTheAppLeavesItsAddressesAndWhatSignsThemAsTheyWere(): void
    {
        $site = $this->installed();
        $ticket = $this->ticket();
        $proof = self::told($this->fetch('index.html', $ticket)[1])['proof'];
        $this->assertSame(NativeAppService::siteProof($site['key'], $ticket), $proof);

        // What bringing an app's own key in leaves behind: another key in its private configuration, of its owner's choosing.
        $path = $this->root() . '/private/config.json';
        $config = json_decode((string) file_get_contents($path), true);
        $this->assertMatchesRegularExpression('/^[a-f0-9]{64}$/D', $config['keyHex']);
        $brought = str_repeat('5a', 32);
        $this->assertNotSame($brought, $config['keyHex']);
        file_put_contents($path, json_encode(['keyHex' => $brought] + $config));
        clearstatcache();
        $this->assertSame($brought, json_decode((string) file_get_contents($path), true)['keyHex']);

        // The key its addresses are signed with is the one it was, so the address handed out before
        // is still served, is the one handed out now, and its page shows the same proof.
        $this->assertSame($site['key'], $this->native->siteKey(self::APP_ID));
        $this->assertSame($site, $this->installed());
        $this->assertSame($ticket, $this->ticket());
        [$response, $body] = $this->fetch('assets/app.js', $ticket);
        $this->assertSame(200, $response->getStatusCode());
        $this->assertSame(self::SCRIPT, $body);
        $this->assertSame($proof, self::told($this->fetch('index.html', $ticket)[1])['proof']);

        // And whoever knows the key that was brought in, or the one before it, can write no address
        // with it: not signed with it as it is, nor with a key made from it for this app.
        foreach ([$brought, $config['keyHex']] as $known) {
            foreach ([hex2bin($known), hash_hmac('sha256', self::APP_ID, hex2bin($known), true), hash_hmac('sha256', 'formlogic:site-address:v1|' . self::APP_ID, hex2bin($known), true)] as $forged) {
                $written = NativeAppService::siteTicket($forged, self::APP_ID, $site['version'], null, self::FRAME);
                $this->assertNotSame($ticket, $written);
                $this->assertSame(410, $this->fetch('assets/app.js', $written)[0]->getStatusCode());
            }
        }
    }

    public function testTheFirstPageOpenedAsAPageIsTheBootDocumentAndNotThePageItself(): void
    {
        $site = $this->installed();
        $ticket = $this->ticket();
        $root = self::prefix($ticket);
        [$response, $body] = $this->fetch('index.html', $ticket);

        $this->assertSame(200, $response->getStatusCode());
        $this->assertSame('text/html; charset=utf-8', $response->getHeaderLine('Content-Type'));
        $this->assertSame(self::AFRESH, $response->getHeaderLine('Cache-Control'));
        $this->assertSame(SecurityHeadersMiddleware::siteFramePolicy(self::ORIGIN, $root), $response->getHeaderLine('Content-Security-Policy'));

        // The boot script, whole, in a script element that only the document itself ends.
        $this->assertStringContainsString(self::bootScript(), $body);
        $this->assertSame(1, substr_count($body, '</script'), 'nothing in the script ends its element early');
        $this->assertStringEndsWith('</script></body></html>', $body);
        // Told where the site is, which page of it this document is to become, and what to show the framing page.
        $this->assertSame(['root' => $root, 'page' => 'index.html', 'proof' => NativeAppService::siteProof($site['key'], $ticket)], self::told($body));
        // And nothing of the page itself: that is loaded by the script, once the line to the framing page is made.
        $this->assertStringNotContainsString('shop-own-markup', $body);
        $this->assertStringNotContainsString('<title>Shop</title>', $body);
    }

    public function testThePageAskedForRawByABrowserTooOldToSayWhatForIsItsOwnBytes(): void
    {
        // No word from the browser on how it means to use the file (no Sec-Fetch-Dest): the address is what is gone by.
        $ticket = $this->ticket();
        [$response, $body] = $this->fetch('index.html', $ticket, ['formlogic-raw' => '1']);
        $this->assertSame(200, $response->getStatusCode());
        $this->assertSame(self::PAGE, $body);
        $this->assertSame('text/html; charset=utf-8', $response->getHeaderLine('Content-Type'));
        $this->assertSame((string) strlen(self::PAGE), $response->getHeaderLine('Content-Length'));
        // The page that reads it has no origin, so to the browser this is a read from another origin.
        $this->assertSame('*', $response->getHeaderLine('Access-Control-Allow-Origin'));
        $this->assertSame(SecurityHeadersMiddleware::siteFramePolicy(self::ORIGIN, self::prefix($ticket)), $response->getHeaderLine('Content-Security-Policy'), 'held the same way when it is opened by this address');
        $this->assertSame(self::AFRESH, $response->getHeaderLine('Cache-Control'), 'a page is read afresh');

        // Only that word asks for the page itself.
        foreach (['0', 'true', ''] as $other) {
            [$response, $body] = $this->fetch('index.html', $ticket, ['formlogic-raw' => $other]);
            $this->assertSame(200, $response->getStatusCode());
            $this->assertSame('index.html', self::told($body)['page'], "formlogic-raw={$other} is an ordinary opening");
            $this->assertStringNotContainsString('shop-own-markup', $body);
        }
    }

    public function testInTheFrameAPageAskedForRawIsStillTheBootDocument(): void
    {
        $site = $this->installed();
        $ticket = $this->ticket();
        $root = self::prefix($ticket);
        // The frame going to an address that asks for the page itself (a link in the app, or a page
        // that sent it there): whatever the address says, what the frame shows is the boot document.
        foreach (['iframe', 'frame', 'embed', 'object'] as $as) {
            foreach ([['index.html', 'index.html', 'shop-own-markup'], ['docs/index.html', 'docs/index.html', 'docs-own-markup'], ['about.htm', 'about.htm', 'about-own-markup'], ['', 'index.html', 'shop-own-markup'], ['docs/', 'docs/index.html', 'docs-own-markup'], ['orders/12', 'index.html', 'shop-own-markup']] as [$address, $page, $markup]) {
                foreach ([[], ['Accept' => '*/*'], ['Accept' => 'text/html,application/xhtml+xml,*/*;q=0.8']] as $accepts) {
                    [$response, $body] = $this->fetch($address, $ticket, ['formlogic-raw' => '1'], 'shop', ['Sec-Fetch-Dest' => $as] + $accepts);
                    $shown = "'{$address}' in an {$as}";
                    $this->assertSame(200, $response->getStatusCode(), $shown);
                    $this->assertSame('text/html; charset=utf-8', $response->getHeaderLine('Content-Type'), $shown);
                    $this->assertSame(self::AFRESH, $response->getHeaderLine('Cache-Control'), $shown);
                    $this->assertSame(SecurityHeadersMiddleware::siteFramePolicy(self::ORIGIN, $root), $response->getHeaderLine('Content-Security-Policy'), $shown);
                    $this->assertSame(['root' => $root, 'page' => $page, 'proof' => NativeAppService::siteProof($site['key'], $ticket)], self::told($body), $shown);
                    $this->assertStringNotContainsString($markup, $body, $shown);
                }
            }
        }
        // The boot script's own reading of the page it is to become asks the same address, and says it is a script's: the page.
        [$response, $body] = $this->fetch('index.html', $ticket, ['formlogic-raw' => '1'], 'shop', ['Sec-Fetch-Dest' => 'empty']);
        $this->assertSame(200, $response->getStatusCode());
        $this->assertSame(self::PAGE, $body);
    }

    public function testAScriptAndAPictureAreSentAsWhatTheyAreAndKeptByTheBrowser(): void
    {
        $ticket = $this->ticket();
        $policy = SecurityHeadersMiddleware::siteFramePolicy(self::ORIGIN, self::prefix($ticket));
        foreach ([['assets/app.js', 'text/javascript; charset=utf-8', self::SCRIPT], ['assets/logo.png', 'image/png', self::PNG], ['assets/mark.svg', 'image/svg+xml', self::SVG]] as [$path, $type, $bytes]) {
            [$response, $body] = $this->fetch($path, $ticket);
            $this->assertSame(200, $response->getStatusCode(), $path);
            $this->assertSame($type, $response->getHeaderLine('Content-Type'), $path);
            $this->assertSame($bytes, $body, $path);
            $this->assertSame((string) strlen($bytes), $response->getHeaderLine('Content-Length'), $path);
            $this->assertSame('*', $response->getHeaderLine('Access-Control-Allow-Origin'), $path);
            $this->assertSame('cross-origin', $response->getHeaderLine('Cross-Origin-Resource-Policy'), $path);
            // The address names the version, so what it names never changes. Never a shared cache: a members-only app's files.
            $this->assertSame(self::KEPT, $response->getHeaderLine('Cache-Control'), $path);
            $this->assertSame($policy, $response->getHeaderLine('Content-Security-Policy'), $path);
            $this->assertFalse($response->hasHeader('Content-Encoding'), "{$path} is not said to be packed");
        }
    }

    public function testAStylesheetsAddressesNamedFromTheRootArePointedAtTheSitesOwnFiles(): void
    {
        $ticket = $this->ticket();
        $root = self::prefix($ticket);
        [$response, $body] = $this->fetch('assets/app.css', $ticket);
        $this->assertSame(200, $response->getStatusCode());
        $this->assertSame('text/css; charset=utf-8', $response->getHeaderLine('Content-Type'));

        // url(/x) and @import "/x" under the site's own address; relative ones and //other.host ones as the build wrote them.
        $sent = implode("\n", array_map(static fn (array $line): string => str_replace('{root}', $root, $line[1] ?? $line[0]), self::SHEET));
        $this->assertSame($sent, $body);
        $this->assertStringContainsString('url(' . $root . 'assets/logo.png)', $body);
        $this->assertStringContainsString('@import "' . $root . 'base.css"', $body);
        $this->assertStringContainsString('url(assets/d.png)', $body);
        $this->assertStringContainsString('url(//other.host/f.png)', $body);

        $this->assertSame('*', $response->getHeaderLine('Access-Control-Allow-Origin'));
        $this->assertSame(self::KEPT, $response->getHeaderLine('Cache-Control'));
        $this->assertSame(SecurityHeadersMiddleware::siteFramePolicy(self::ORIGIN, $root), $response->getHeaderLine('Content-Security-Policy'));
    }

    public function testTheSitesOwnAddressAndAFolderServeTheirFirstPage(): void
    {
        $ticket = $this->ticket();
        $root = self::prefix($ticket);
        foreach ([['', 'index.html', self::PAGE, 'shop-own-markup'], ['docs/', 'docs/index.html', self::DOCS, 'docs-own-markup']] as [$address, $page, $bytes, $markup]) {
            [$response, $body] = $this->fetch($address, $ticket);
            $this->assertSame(200, $response->getStatusCode(), "'{$address}'");
            $this->assertSame('text/html; charset=utf-8', $response->getHeaderLine('Content-Type'));
            $told = self::told($body);
            $this->assertSame($page, $told['page'], "'{$address}' is the boot document for {$page}");
            $this->assertSame($root, $told['root'], 'the root is the site\'s, whichever folder the page is in');
            $this->assertStringNotContainsString($markup, $body);

            [$response, $body] = $this->fetch($address, $ticket, ['formlogic-raw' => '1']);
            $this->assertSame(200, $response->getStatusCode());
            $this->assertSame($bytes, $body, "'{$address}' asked for raw is {$page}");
        }
    }

    public function testAnAddressThatNamesNoFileIsAScreenOfTheAppAndAMissingFileIsMissing(): void
    {
        $ticket = $this->ticket();
        $root = self::prefix($ticket);
        // No ending and no such file: a single-page app's own screen, so its first page is sent, as a site's server would.
        foreach (['orders/12', 'prices'] as $screen) {
            [$response, $body] = $this->fetch($screen, $ticket);
            $this->assertSame(200, $response->getStatusCode(), $screen);
            $this->assertSame('text/html; charset=utf-8', $response->getHeaderLine('Content-Type'), $screen);
            $this->assertSame(self::AFRESH, $response->getHeaderLine('Cache-Control'), $screen);
            $this->assertSame(SecurityHeadersMiddleware::siteFramePolicy(self::ORIGIN, $root), $response->getHeaderLine('Content-Security-Policy'), $screen);
            $this->assertSame(['root' => $root, 'page' => 'index.html'], array_diff_key(self::told($body), ['proof' => true]), "{$screen} is the boot document for the first page");

            [$response, $body] = $this->fetch($screen, $ticket, ['formlogic-raw' => '1']);
            $this->assertSame(200, $response->getStatusCode(), $screen);
            $this->assertSame(self::PAGE, $body, "{$screen} asked for raw is the first page");
            $this->assertSame(self::AFRESH, $response->getHeaderLine('Cache-Control'), $screen);
        }
        // It ends in a kind of file, and there is no such file: missing, not the first page.
        foreach (['assets/missing.js', 'missing.html', 'orders/12.json', 'docs/missing.png', 'assets/app.js.map'] as $missing) {
            foreach ([[], ['formlogic-raw' => '1']] as $query) {
                [$response, $body] = $this->fetch($missing, $ticket, $query);
                $this->assertSame(404, $response->getStatusCode(), $missing);
                $this->assertSame(self::PLAIN, $response->getHeaderLine('Content-Type'), $missing);
                $this->assertSame('no-store', $response->getHeaderLine('Cache-Control'), $missing);
                $this->assertFalse($response->hasHeader('Content-Security-Policy'), "{$missing}: a refusal carries no sandbox policy");
                $this->assertStringNotContainsString('shop-own-markup', $body, $missing);
                $this->assertStringNotContainsString('data-proof', $body, $missing);
            }
        }
    }

    public function testAFileTheBuildPackedIsSentAsWhatItHoldsAndSaidToBePacked(): void
    {
        $ticket = $this->ticket();
        foreach ([['Build/game.wasm.br', 'br', 'application/wasm', self::PACKED_WASM], ['assets/vendor.js.gz', 'gzip', 'text/javascript; charset=utf-8', self::PACKED_SCRIPT]] as [$path, $packed, $type, $bytes]) {
            [$response, $body] = $this->fetch($path, $ticket);
            $this->assertSame(200, $response->getStatusCode(), $path);
            $this->assertSame($packed, $response->getHeaderLine('Content-Encoding'), $path);
            $this->assertSame($type, $response->getHeaderLine('Content-Type'), "{$path} is sent as the kind of file inside");
            $this->assertSame($bytes, $body, "{$path} is sent as the build packed it");
            $this->assertSame((string) strlen($bytes), $response->getHeaderLine('Content-Length'), $path);
            $this->assertSame('*', $response->getHeaderLine('Access-Control-Allow-Origin'), $path);
            $this->assertSame(self::KEPT, $response->getHeaderLine('Cache-Control'), $path);
        }
        // A game's data has no type of its own: plain bytes, and not said to be packed.
        [$response, $body] = $this->fetch('Build/game.data', $ticket);
        $this->assertSame(200, $response->getStatusCode());
        $this->assertSame('application/octet-stream', $response->getHeaderLine('Content-Type'));
        $this->assertSame(self::GAME_DATA, $body);
        $this->assertFalse($response->hasHeader('Content-Encoding'));
    }

    public function testAnEndingInCapitalsIsTheSameKindOfFile(): void
    {
        [$response, $body] = $this->fetch('photos/IMG_1.JPG');
        $this->assertSame(200, $response->getStatusCode());
        $this->assertSame('image/jpeg', $response->getHeaderLine('Content-Type'));
        $this->assertSame(self::JPEG, $body);
        $this->assertSame(self::KEPT, $response->getHeaderLine('Cache-Control'));
    }

    public function testTheAddressTheRuntimeDescriptorHandsOutIsOneThatIsServed(): void
    {
        $ticket = $this->ticket();
        // Handed out under the API's own base, as every address the page is given is: the page puts
        // where this installation's API is (/api) in front of it, and that is the address served.
        $this->assertSame('/app/shop/site/' . $ticket . '/index.html', SiteAppController::address('shop', $ticket, 'index.html'));
        $this->assertSame(self::prefix($ticket) . 'index.html', '/api' . SiteAppController::address('shop', $ticket, 'index.html'));
        $this->assertSame(self::prefix($ticket) . 'docs/index.html', '/api' . SiteAppController::address('shop', $ticket, 'docs/index.html'), 'a first page in a folder keeps its folders');
        // So joined, it is an address the security headers know as a site's, and its root is what the boot document is told.
        $this->assertSame(1, preg_match(SecurityHeadersMiddleware::SITE_FRAME_PATH, '/api' . SiteAppController::address('shop', $ticket, 'docs/index.html'), $found));
        $this->assertSame(self::prefix($ticket), $found[1]);
        $this->assertSame(self::prefix($ticket), self::told($this->fetch('docs/index.html', $ticket)[1])['root']);
        $this->assertSame(0, preg_match(SecurityHeadersMiddleware::SITE_FRAME_PATH, SiteAppController::address('shop', $ticket, 'docs/index.html')), 'as it is handed out, without the API\'s base, it is no site\'s address');
    }

    public function testATicketThatDoesNotAdmitGetsOneAnswerAndNothingOfTheSite(): void
    {
        $site = $this->installed();
        $good = $this->ticket();
        [$version, $until, $signature, $frame] = explode('-', $good);
        $this->assertSame([self::FRAME, "{$version}-{$until}-{$signature}-{$frame}"], [$frame, $good]);
        $flipped = static fn (string $hex): string => substr($hex, 0, -1) . ($hex[-1] === '0' ? '1' : '0');
        $tickets = [
            'signed with another key' => NativeAppService::siteTicket(random_bytes(32), self::APP_ID, $site['version'], null, self::FRAME),
            'its signature changed' => "{$version}-{$until}-" . $flipped($signature) . "-{$frame}",
            // The ticket of this browser's frame, moved to another's: the signature is over the frame's value too.
            'its frame changed' => "{$version}-{$until}-{$signature}-" . $flipped($frame),
            'its frame left off, as a ticket once was' => "{$version}-{$until}-{$signature}",
            'for another version' => NativeAppService::siteTicket($site['key'], self::APP_ID, $site['version'] + 1, null, self::FRAME),
            'for another app' => NativeAppService::siteTicket($site['key'], 'other-id', $site['version'], null, self::FRAME),
            'another app\'s own' => NativeAppService::siteTicket((string) $this->native->siteKey('notes-id'), 'notes-id', $site['version'], null, self::FRAME),
            // Signed here, for this app, version and frame, three days ago: only its day is wrong.
            'past its day' => NativeAppService::siteTicket($site['key'], self::APP_ID, $site['version'], time() - 3 * 86400, self::FRAME),
            // And the same with a last day further off than anyone is handed: one written to go on working.
            'not yet in its days' => NativeAppService::siteTicket($site['key'], self::APP_ID, $site['version'], time() + 2 * 86400, self::FRAME),
            'given a year' => NativeAppService::siteTicket($site['key'], self::APP_ID, $site['version'], time() + 365 * 86400, self::FRAME),
            'not a ticket' => 'not-a-ticket',
            'only the shape of one' => 'v' . $site['version'] . '-99999-' . str_repeat('0', 40) . '-' . str_repeat('0', 32),
            'only the shape one once had' => 'v' . $site['version'] . '-99999-' . str_repeat('0', 40),
        ];
        $answers = [];
        foreach ($tickets as $what => $ticket) {
            foreach ([['index.html', []], ['index.html', ['formlogic-raw' => '1']], ['assets/app.js', []], ['', []], ['orders/12', []], ['assets/missing.js', []]] as [$path, $query]) {
                [$response, $body] = $this->fetch($path, $ticket, $query);
                $this->assertSame(410, $response->getStatusCode(), "{$what}: '{$path}'");
                $this->assertSame(self::PLAIN, $response->getHeaderLine('Content-Type'), $what);
                $this->assertSame('no-store', $response->getHeaderLine('Cache-Control'), $what);
                $this->assertFalse($response->hasHeader('Content-Security-Policy'), "{$what}: a refusal carries no sandbox policy");
                $this->assertStringNotContainsString('shop-own-markup', $body, $what);
                $this->assertStringNotContainsString(self::SCRIPT, $body, $what);
                $this->assertStringNotContainsString('data-proof', $body, $what);
                $answers[$body] = true;
            }
        }
        $this->assertCount(1, $answers, 'one answer, whatever is wrong with the ticket and whatever was asked for');
        // The same addresses under a ticket that admits are served.
        $this->assertSame(200, $this->fetch('assets/app.js', $good)[0]->getStatusCode());
    }

    public function testAnAddressFromBeforeAnUpdateStopsWorkingWhenTheAppIsUpdated(): void
    {
        $before = $this->ticket();
        $this->assertSame(200, $this->fetch('assets/app.js', $before)[0]->getStatusCode());

        $this->native->install(self::APP_ID, self::project(['site/index.html' => self::PAGE, 'site/assets/app.js' => 'console.log("version two");']), 1);
        $this->assertSame(2, $this->installed()['version']);
        foreach (['assets/app.js', 'index.html', ''] as $path) {
            $this->assertSame(410, $this->fetch($path, $before)[0]->getStatusCode(), "'{$path}' under the address of the version before");
        }
        // The page that frames the site asks for a new address, and is served the new version.
        $after = $this->ticket();
        $this->assertNotSame($before, $after);
        [$response, $body] = $this->fetch('assets/app.js', $after);
        $this->assertSame(200, $response->getStatusCode());
        $this->assertSame('console.log("version two");', $body);
        $this->assertSame(404, $this->fetch('assets/logo.png', $after)[0]->getStatusCode(), 'a file the new version does not have is gone');
    }

    public function testNoAddressReachesAFileOutsideTheSitesOwnFolder(): void
    {
        $root = $this->root();
        $ticket = $this->ticket();
        // What an address must never give: the app's own key, the secret every app's addresses are
        // signed with (beside the apps' folders), the stored project, the staged manifest beside
        // the site's folder, and files planted where only the path rule keeps them out (kinds of
        // file a site keeps, so nothing but their place or name refuses them).
        $config = json_decode((string) file_get_contents($root . '/private/config.json'), true);
        $this->assertMatchesRegularExpression('/^[a-f0-9]{64}$/', $config['keyHex']);
        $secret = (string) file_get_contents($this->storage . '/site-addresses.key');
        $this->assertMatchesRegularExpression('/^[a-f0-9]{64}$/D', $secret);
        $this->assertFileExists($root . '/project.json');
        $this->assertFileExists($root . '/app/manifest.json');
        $this->assertFileExists($root . '/app/site/index.html');
        $planted = 'PLANTED-' . bin2hex(random_bytes(8));
        file_put_contents($root . '/app/outside.json', $planted);
        file_put_contents($root . '/app/site/.secret.json', $planted);
        mkdir($root . '/app/site/.well-known');
        file_put_contents($root . '/app/site/.well-known/keys.json', $planted);

        $attempts = [
            '../private/config.json', '../../private/config.json',
            'assets/../../project.json', 'assets/../../../project.json', '../../project.json',
            '../manifest.json', '../outside.json', 'assets/../../outside.json', 'docs/../../outside.json',
            '../../../site-addresses.key', 'assets/../../../../site-addresses.key', '../../site-addresses.key', 'site-addresses.key', '%2e%2e/%2e%2e/%2e%2e/site-addresses.key', '..\\..\\..\\site-addresses.key',
            // Encoded twice in the address, so still encoded once the router has decoded it.
            '%2e%2e/%2e%2e/private/config.json', '%2e%2e%2f%2e%2e%2fprivate%2fconfig.json', '..%2foutside.json', '%2e%2e%5coutside.json',
            // The other slash, which Windows reads as a folder too.
            '..\\..\\private\\config.json', '..\\outside.json', 'assets\\..\\..\\outside.json',
            // A file or a folder whose name starts with a dot, in the site's own folder.
            '.secret.json', '.well-known/keys.json', '%2esecret.json', 'assets/../.secret.json',
            // A folder, and a name cut short for whatever opens it.
            '..', '../..', '../../private', "../outside.json\0.png", "index.html\0.png",
        ];
        foreach ($attempts as $path) {
            foreach ([[], ['formlogic-raw' => '1']] as $query) {
                $shown = addcslashes($path, "\0") . ($query ? ' (raw)' : '');
                [$response, $body] = $this->fetch($path, $ticket, $query);
                $this->assertSame(404, $response->getStatusCode(), $shown);
                $this->assertSame(self::PLAIN, $response->getHeaderLine('Content-Type'), $shown);
                $this->assertFalse($response->hasHeader('Content-Security-Policy'), $shown);
                foreach ([$planted, $config['keyHex'], $secret, 'keyHex', '"assets"', '"site"', 'shop-own-markup'] as $kept) {
                    $this->assertStringNotContainsString($kept, $body, "{$shown} gave something that is not the site's");
                }
            }
        }
        // And the site's own files are still served from beside them.
        $this->assertSame(self::SCRIPT, $this->fetch('assets/app.js', $ticket)[1]);
    }

    public function testAnUnknownAppIsNotFoundAndAnAppWithNoBuiltSiteSaysSoOnlyToATicketSignedForIt(): void
    {
        // A SoftN app: installed, with pages of its own kind and no built site.
        $this->native->install('notes-id', ['access' => 'application', 'assets' => [], 'files' => [
            'manifest.json' => '{"name":"Notes","version":"1.0.0","main":"ui/main.ui"}', 'ui/main.ui' => '<Text>Notes</Text>',
        ]], 0);
        $this->assertNull($this->native->site('notes-id'));
        $this->assertNull($this->native->site('empty-id'), 'an app with nothing installed');

        $shops = $this->ticket();
        $shaped = 'v1-99999-' . str_repeat('a', 40) . '-' . str_repeat('a', 32);
        $asked = function (string $slug, string $ticket, int $status, string $what): void {
            foreach (['index.html', '', 'ui/main.ui', 'manifest.json'] as $path) {
                [$response, $body] = $this->fetch($path, $ticket, ['formlogic-raw' => '1'], $slug);
                $this->assertSame($status, $response->getStatusCode(), "{$what}: '{$path}'");
                $this->assertSame(self::PLAIN, $response->getHeaderLine('Content-Type'), $what);
                $this->assertSame('no-store', $response->getHeaderLine('Cache-Control'), $what);
                $this->assertFalse($response->hasHeader('Content-Security-Policy'), $what);
                $this->assertStringNotContainsString('<Text>', $body, $what);
                $this->assertStringNotContainsString('"main"', $body, $what);
            }
        };
        // No such app: not found, whatever the ticket.
        $asked('nobody', $shops, 404, 'no such app, another app\'s ticket');
        $asked('nobody', $shaped, 404, 'no such app, the shape of a ticket');
        foreach (['notes' => ['notes-id', 'a SoftN app'], 'empty' => ['empty-id', 'an app with nothing installed']] as $slug => [$id, $what]) {
            // An app there is: the ticket is read first, by its signature alone and before anything of
            // the app is opened. One not signed for this app is told what any such ticket is told.
            $asked($slug, $shops, 410, "{$what}, another app's ticket");
            $asked($slug, $shaped, 410, "{$what}, the shape of a ticket");
            // One that is signed for it (nobody is handed one: the runtime descriptor makes a ticket
            // only for a built site) is told there is no site, whichever version it names.
            foreach ([1, 7] as $version) {
                $own = NativeAppService::siteTicket((string) $this->native->siteKey($id), $id, $version, null, self::FRAME);
                $asked($slug, $own, 404, "{$what}, a ticket signed for it");
            }
        }
        // The same tickets at the app they are for: the one signed for it is served, the other is not.
        $this->assertSame(200, $this->fetch('index.html', $shops, ['formlogic-raw' => '1'])[0]->getStatusCode());
        $this->assertSame(410, $this->fetch('index.html', $shaped, ['formlogic-raw' => '1'])[0]->getStatusCode());
    }

    public function testWhatIsSentPassesTheSecurityHeadersAsItIsAndARefusalStaysUnframeable(): void
    {
        // Reached on a port of its own, which is part of the address the policy holds the site's files to.
        $origin = 'https://apps.example.test:8443';
        $ticket = $this->ticket();
        $policy = SecurityHeadersMiddleware::siteFramePolicy($origin, self::prefix($ticket));
        $this->assertStringContainsString('; connect-src http://apps.example.test:8443' . self::prefix($ticket) . ' https://apps.example.test:8443' . self::prefix($ticket) . ';', $policy);
        $this->assertStringContainsString("; frame-ancestors 'self'", $policy);
        foreach ([['index.html', [], self::AFRESH], ['index.html', ['formlogic-raw' => '1'], self::AFRESH], ['orders/12', [], self::AFRESH], ['assets/app.js', [], self::KEPT], ['assets/app.css', [], self::KEPT], ['Build/game.wasm.br', [], self::KEPT]] as [$path, $query, $cache]) {
            foreach ([[], ['Sec-Fetch-Dest' => 'iframe']] as $headers) {
                $response = $this->through($path, $ticket, $query, $origin, $headers);
                $this->assertSame(200, $response->getStatusCode(), $path);
                $this->assertSame($policy, $response->getHeaderLine('Content-Security-Policy'), "{$path} keeps the policy it was sent under");
                $this->assertFalse($response->hasHeader('X-Frame-Options'), "{$path} may be framed, by the pages its policy names");
                $this->assertSame('no-referrer', $response->getHeaderLine('Referrer-Policy'), "{$path}: the address holds the ticket");
                $this->assertSame('nosniff', $response->getHeaderLine('X-Content-Type-Options'), $path);
                $this->assertSame($cache, $response->getHeaderLine('Cache-Control'), $path);
            }
        }
        $refusals = [
            ['index.html', 'not-a-ticket', 410, []], ['assets/missing.js', $ticket, 404, []], ['../private/config.json', $ticket, 404, []],
            // A page of the app opened as a tab of its own.
            ['index.html', $ticket, 403, ['Sec-Fetch-Dest' => 'document']], ['assets/mark.svg', $ticket, 403, ['Sec-Fetch-Dest' => 'document']],
        ];
        foreach ($refusals as [$path, $with, $status, $headers]) {
            $response = $this->through($path, $with, [], $origin, $headers);
            $this->assertSame($status, $response->getStatusCode(), $path);
            $this->assertSame(self::API_POLICY, $response->getHeaderLine('Content-Security-Policy'), "{$path}: a refusal is held to the API's policy");
            $this->assertSame('DENY', $response->getHeaderLine('X-Frame-Options'), $path);
            $this->assertSame('no-store', $response->getHeaderLine('Cache-Control'), $path);
        }
    }

    /**
     * One request with the headers a browser sends with it.
     *
     * @param array<string, string> $headers
     * @return array{0: ResponseInterface, 1: string} the response and its body
     */
    private function ask(string $path, array $headers, array $query = []): array
    {
        return $this->fetch($path, null, $query, 'shop', $headers);
    }

    public function testAPageOpenedInTheFrameIsTheBootDocumentAndOneReadByAScriptIsThePageItself(): void
    {
        // The frame going to the page, as a browser says it (whatever it says it accepts), and as an
        // older one that says only what it accepts.
        $framed = [['Sec-Fetch-Dest' => 'iframe'], ['Sec-Fetch-Dest' => 'frame'], ['Sec-Fetch-Dest' => 'embed'], ['Sec-Fetch-Dest' => 'object'], ['Sec-Fetch-Dest' => 'IFrame'],
            ['Sec-Fetch-Dest' => 'iframe', 'Accept' => '*/*'], ['Accept' => 'text/html,application/xhtml+xml,*/*;q=0.8']];
        foreach ($framed as $headers) {
            [$response, $body] = $this->ask('docs/index.html', $headers);
            $this->assertSame(200, $response->getStatusCode(), (string) json_encode($headers));
            $this->assertStringNotContainsString('docs-own-markup', $body, (string) json_encode($headers));
            $this->assertSame('docs/index.html', self::told($body)['page']);
            $this->assertSame(self::AFRESH, $response->getHeaderLine('Cache-Control'));
        }
        // The app's own script reading the file (fetch, XMLHttpRequest), or anything else of the page's
        // that is not a page being opened: the file, as any other of its files.
        $read = [['Sec-Fetch-Dest' => 'empty'], ['Accept' => '*/*'], ['Sec-Fetch-Dest' => 'empty', 'Accept' => 'text/html'],
            ['Sec-Fetch-Dest' => 'script'], ['Sec-Fetch-Dest' => 'worker'], ['Sec-Fetch-Dest' => 'image', 'Accept' => 'text/html']];
        foreach ($read as $headers) {
            [$response, $body] = $this->ask('docs/index.html', $headers);
            $this->assertSame(200, $response->getStatusCode(), (string) json_encode($headers));
            $this->assertSame(self::DOCS, $body, (string) json_encode($headers));
            $this->assertSame('text/html; charset=utf-8', $response->getHeaderLine('Content-Type'));
            $this->assertSame('*', $response->getHeaderLine('Access-Control-Allow-Origin'));
            $this->assertSame(self::AFRESH, $response->getHeaderLine('Cache-Control'));
        }
    }

    public function testAPageOfTheAppOpenedAsATabOfItsOwnIsRefusedAndAPictureOpenedSoIsServed(): void
    {
        $ticket = $this->ticket();
        $tab = ['Sec-Fetch-Dest' => 'document'];
        // What a browser draws as a page: the app's pages (by their own address, the site's, a folder's
        // or a screen's), an SVG, XML. Standing alone in a tab under this site's name, none is sent,
        // whatever the address asks for and whatever the browser says it accepts.
        $pages = ['index.html', 'docs/index.html', 'about.htm', '', 'docs/', 'orders/12', 'prices', 'assets/mark.svg', 'feed.xml'];
        foreach ($pages as $path) {
            foreach ([[], ['formlogic-raw' => '1']] as $query) {
                foreach ([$tab, $tab + ['Accept' => '*/*'], $tab + ['Accept' => 'text/html,application/xhtml+xml,*/*;q=0.8'], ['Sec-Fetch-Dest' => 'Document']] as $headers) {
                    $shown = "'{$path}'" . ($query ? ' (raw)' : '') . ' ' . json_encode($headers);
                    [$response, $body] = $this->ask($path, $headers, $query);
                    $this->assertSame(403, $response->getStatusCode(), $shown);
                    $this->assertSame(self::PLAIN, $response->getHeaderLine('Content-Type'), $shown);
                    $this->assertStringStartsNotWith('sandbox', $response->getHeaderLine('Content-Security-Policy'), "{$shown}: a refusal carries no sandbox policy");
                    $this->assertSame('no-store', $response->getHeaderLine('Cache-Control'), $shown);
                    foreach (['shop-own-markup', 'docs-own-markup', 'about-own-markup', 'mark-own-markup', 'feed-own-markup', 'data-proof', '<script', '<svg'] as $ofTheApp) {
                        $this->assertStringNotContainsString($ofTheApp, $body, $shown);
                    }
                }
            }
        }
        // A file that is no page (a picture, a script, a game's data) opened in a tab is a file: served as ever, under its policy.
        $policy = SecurityHeadersMiddleware::siteFramePolicy(self::ORIGIN, self::prefix($ticket));
        foreach ([['assets/logo.png', 'image/png', self::PNG], ['photos/IMG_1.JPG', 'image/jpeg', self::JPEG], ['assets/app.js', 'text/javascript; charset=utf-8', self::SCRIPT], ['Build/game.data', 'application/octet-stream', self::GAME_DATA]] as [$path, $type, $bytes]) {
            [$response, $body] = $this->ask($path, $tab);
            $this->assertSame(200, $response->getStatusCode(), $path);
            $this->assertSame($type, $response->getHeaderLine('Content-Type'), $path);
            $this->assertSame($bytes, $body, $path);
            $this->assertSame($policy, $response->getHeaderLine('Content-Security-Policy'), $path);
            $this->assertSame(self::KEPT, $response->getHeaderLine('Cache-Control'), $path);
        }
        // And what is refused a tab is a file of the app's like any other where the page itself uses it: as a picture, by a script.
        foreach ([['assets/mark.svg', 'image', 'image/svg+xml', self::SVG], ['feed.xml', 'empty', 'application/xml; charset=utf-8', self::FEED]] as [$path, $as, $type, $bytes]) {
            [$response, $body] = $this->ask($path, ['Sec-Fetch-Dest' => $as]);
            $this->assertSame(200, $response->getStatusCode(), $path);
            $this->assertSame($type, $response->getHeaderLine('Content-Type'), $path);
            $this->assertSame($bytes, $body, $path);
            $this->assertSame($policy, $response->getHeaderLine('Content-Security-Policy'), $path);
        }
        // A file that is not there is missing, and a ticket that does not admit is not admitted, in a tab as anywhere.
        $this->assertSame(404, $this->ask('missing.html', $tab)[0]->getStatusCode());
        $this->assertSame(410, $this->fetch('index.html', 'not-a-ticket', [], 'shop', $tab)[0]->getStatusCode());
    }

    public function testWhileTheAppIsBeingUpdatedItsFilesAreToBeAskedForAgainInAMoment(): void
    {
        $ticket = $this->ticket();
        $this->assertSame(200, $this->fetch('assets/app.js', $ticket)[0]->getStatusCode());
        // An update holds the app's lock while it replaces the app's files (NativeAppService::install).
        $lock = fopen($this->root() . '/private/manage.lock', 'c');
        $this->assertTrue(flock($lock, LOCK_EX | LOCK_NB));
        try {
            foreach (['assets/app.js', 'index.html', '', 'orders/12', 'assets/missing.js'] as $path) {
                foreach ([[], ['Sec-Fetch-Dest' => 'iframe'], ['Sec-Fetch-Dest' => 'document']] as $headers) {
                    [$response, $body] = $this->fetch($path, $ticket, [], 'shop', $headers);
                    $this->assertToBeAskedAgain($response, $body, "'{$path}' " . json_encode($headers));
                }
            }
            // The ticket is read before anything of the app is opened: one that does not admit is told so, update or no update.
            $this->assertSame(410, $this->fetch('assets/app.js', 'not-a-ticket')[0]->getStatusCode());
        } finally { flock($lock, LOCK_UN); fclose($lock); }
        // The update over, the same address is served.
        [$response, $body] = $this->fetch('assets/app.js', $ticket);
        $this->assertSame(200, $response->getStatusCode());
        $this->assertSame(self::SCRIPT, $body);
    }

    public function testOnlyAnAppBeingUpdatedIsToBeAskedForAgainAndAnyOtherFaultIsLeftAFault(): void
    {
        $site = $this->installed();
        $ticket = $this->ticket();
        // A service that fails at one of the three things asked of it for a file, and answers the others as the installed app does.
        $failing = function (string $at, \Throwable $with) use ($site): SiteAppController {
            $native = $this->createMock(NativeAppService::class);
            foreach (['siteKey' => $site['key'], 'site' => $site, 'siteFile' => null] as $method => $answer) {
                if ($method === $at) $native->method($method)->willThrowException($with);
                else $native->method($method)->willReturn($answer);
            }
            return new SiteAppController($this->apps(), $native);
        };
        foreach (['siteKey', 'site', 'siteFile'] as $at) {
            // What the service says of an app that is being updated, or put back after a failed update.
            foreach ([409, 423, 503] as $code) {
                [$response, $body] = $this->fetch('assets/app.js', $ticket, [], 'shop', [], $failing($at, new \RuntimeException('The app is being updated. Try again shortly.', $code)));
                $this->assertToBeAskedAgain($response, $body, "{$code} from {$at}");
            }
            // Anything else is not an update: it goes on as it is, to be answered as a fault.
            $faults = [new \RuntimeException('The app database needs operator recovery'), new \RuntimeException('Storage is unavailable', 500), new \RuntimeException('Native app not found', 404),
                new \RuntimeException('Too many requests', 429), new \LogicException('Not an update', 503), new \InvalidArgumentException('Invalid app identity', 409)];
            foreach ($faults as $fault) {
                $thrown = null;
                try { $this->fetch('assets/app.js', $ticket, [], 'shop', [], $failing($at, $fault)); }
                catch (\Throwable $caught) { $thrown = $caught; }
                $this->assertSame($fault, $thrown, get_class($fault) . ' ' . $fault->getCode() . " from {$at}");
            }
        }
    }

    /** A response that says the app is being updated: asked again in a moment it answers, and nothing of the app goes with it. */
    private function assertToBeAskedAgain(ResponseInterface $response, string $body, string $what): void
    {
        $this->assertSame(503, $response->getStatusCode(), $what);
        $this->assertSame('2', $response->getHeaderLine('Retry-After'), $what);
        $this->assertSame(self::PLAIN, $response->getHeaderLine('Content-Type'), $what);
        $this->assertSame('no-store', $response->getHeaderLine('Cache-Control'), $what);
        $this->assertFalse($response->hasHeader('Content-Security-Policy'), "{$what}: a refusal carries no sandbox policy");
        $this->assertNotSame('', $body, $what);
        foreach (['shop-own-markup', self::SCRIPT, 'data-proof'] as $ofTheApp) $this->assertStringNotContainsString($ofTheApp, $body, $what);
    }

    /**
     * A file of a built site may be 32 MB. Two answers hold what they send in memory, a part of
     * a file and a stylesheet whose addresses are rewritten, and neither holds more than this
     * server reads whole: a long video's "the rest" is the next stretch of it, and a stylesheet
     * larger than that is sent as the build wrote it.
     */
    public function testALargeFileIsSentInStretchesAndALargeStylesheetAsItIs(): void
    {
        $most = NativeAppService::MAX_MEDIA_READ_BYTES;
        // A film a megabyte longer than one answer carries, each megabyte its own letter.
        $film = '';
        for ($at = 0; $at <= intdiv($most, 1048576); $at++) $film .= str_repeat(chr(65 + $at), 1048576);
        $size = strlen($film);
        $sheet = '.a { background: url(/assets/logo.png); }' . "\n/*" . str_repeat('x', $most) . '*/';
        $this->native->install(self::APP_ID, self::project(['site/index.html' => self::PAGE, 'site/media/film.mp4' => $film, 'site/assets/big.css' => $sheet, 'site/assets/app.css' => '.a { background: url(/assets/logo.png); }']), 1);
        $root = self::prefix($this->ticket());

        // "From the start to the end": the first stretch, which says where it ends and how long the film is.
        [$first, $body] = $this->ask('media/film.mp4', ['Range' => 'bytes=0-']);
        $this->assertSame(206, $first->getStatusCode());
        $this->assertSame('bytes 0-' . ($most - 1) . '/' . $size, $first->getHeaderLine('Content-Range'));
        $this->assertSame($most, strlen($body));
        $this->assertSame(substr($film, 0, $most), $body);
        // And on from there, as a player asks next: the rest, which is short of a stretch.
        [$next, $rest] = $this->ask('media/film.mp4', ['Range' => 'bytes=' . $most . '-']);
        $this->assertSame(206, $next->getStatusCode());
        $this->assertSame('bytes ' . $most . '-' . ($size - 1) . '/' . $size, $next->getHeaderLine('Content-Range'));
        $this->assertSame(substr($film, $most), $rest);
        // A part that fits is the part asked for, wherever it is, and the last bytes are the last bytes.
        [, $middle] = $this->ask('media/film.mp4', ['Range' => 'bytes=' . ($most - 2) . '-' . ($most + 1)]);
        $this->assertSame(substr($film, $most - 2, 4), $middle);
        [$tail, $end] = $this->ask('media/film.mp4', ['Range' => 'bytes=-3']);
        $this->assertSame('bytes ' . ($size - 3) . '-' . ($size - 1) . '/' . $size, $tail->getHeaderLine('Content-Range'));
        $this->assertSame(substr($film, -3), $end);
        // Asked for whole, it is sent whole, as a stream.
        [$whole, $all] = $this->ask('media/film.mp4', []);
        $this->assertSame([200, (string) $size], [$whole->getStatusCode(), $whole->getHeaderLine('Content-Length')]);
        $this->assertSame(hash('sha256', $film), hash('sha256', $all));

        // The stylesheet past that size is the build's own bytes; one within it still has its addresses pointed at the site.
        [$large, $sent] = $this->ask('assets/big.css', []);
        $this->assertSame([200, 'text/css; charset=utf-8'], [$large->getStatusCode(), $large->getHeaderLine('Content-Type')]);
        $this->assertSame(hash('sha256', $sheet), hash('sha256', $sent));
        [, $small] = $this->ask('assets/app.css', []);
        $this->assertSame('.a { background: url(' . $root . 'assets/logo.png); }', $small);
    }

    public function testAPartOfAFileIsSentAsAPlayerAsksForIt(): void
    {
        [$whole] = $this->ask('assets/logo.png', []);
        $this->assertSame('bytes', $whole->getHeaderLine('Accept-Ranges'));
        $size = strlen(self::PNG);
        $policy = SecurityHeadersMiddleware::siteFramePolicy(self::ORIGIN, self::prefix($this->ticket()));
        foreach ([['bytes=0-3', 0, 3], ['bytes=4-', 4, $size - 1], ['bytes=-2', $size - 2, $size - 1], ['bytes=2-999', 2, $size - 1]] as [$range, $first, $last]) {
            [$response, $body] = $this->ask('assets/logo.png', ['Range' => $range]);
            $this->assertSame(206, $response->getStatusCode(), $range);
            $this->assertSame(substr(self::PNG, $first, $last - $first + 1), $body, $range);
            $this->assertSame("bytes {$first}-{$last}/{$size}", $response->getHeaderLine('Content-Range'), $range);
            $this->assertSame('image/png', $response->getHeaderLine('Content-Type'));
            $this->assertSame($policy, $response->getHeaderLine('Content-Security-Policy'));
            $this->assertSame('*', $response->getHeaderLine('Access-Control-Allow-Origin'));
        }
        // Past the file's end: refused, with its length, and nothing of the sandbox policy to frame.
        [$past] = $this->ask('assets/logo.png', ['Range' => 'bytes=' . $size . '-']);
        $this->assertSame(416, $past->getStatusCode());
        $this->assertSame('bytes */' . $size, $past->getHeaderLine('Content-Range'));
        $this->assertSame('', $past->getHeaderLine('Content-Security-Policy'));
        // Several parts at once, or not a range at all: the whole file.
        foreach (['bytes=0-1,3-4', 'items=0-1', 'bytes=-'] as $odd) {
            [$response, $body] = $this->ask('assets/logo.png', ['Range' => $odd]);
            $this->assertSame(200, $response->getStatusCode(), $odd);
            $this->assertSame(self::PNG, $body, $odd);
        }
        // A file the build packed is sent whole: a part of it would be a part of the packed bytes.
        [$packed, $body] = $this->ask('Build/game.wasm.br', ['Range' => 'bytes=0-1']);
        $this->assertSame(200, $packed->getStatusCode());
        $this->assertSame(self::PACKED_WASM, $body);
    }

    public function testTheAnswerAboutTheSiteIsKeptBesideTheCacheAndFollowsTheProjectFile(): void
    {
        $first = $this->installed();
        $project = $this->root() . '/project.json';
        $note = $this->root() . '/runtime-cache/site.json';
        // A project file just written is not yet kept an answer for (two installs in one second
        // could leave the same size and time): only one a few seconds old is.
        $this->assertFileDoesNotExist($note);
        touch($project, time() - 10);
        clearstatcache();
        $this->assertSame($first, $this->installed());
        $this->assertFileExists($note);
        // The next asking reads it from there: a kept answer that says otherwise is what comes back.
        $kept = json_decode((string) file_get_contents($note), true);
        file_put_contents($note, json_encode(['version' => 41] + $kept));
        $this->assertSame(41, $this->installed()['version']);
        // The project file is another one (another time): the kept answer is not its, and is worked out again.
        touch($project, time() - 5);
        clearstatcache();
        $this->assertSame($first['version'], $this->installed()['version']);
        $this->assertSame($first['version'], json_decode((string) file_get_contents($note), true)['version']);
    }
}

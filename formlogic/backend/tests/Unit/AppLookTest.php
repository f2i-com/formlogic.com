<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\AppLookController;
use FormLogic\Services\{AppDomainService, AppLookService, AppService, NativeAppService};
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * A hosted SoftN app's look: its icon and share image drawn from its own media, its description,
 * its loading colours, the images served from this site's own address (an SVG never runs), and the
 * page a link-preview service is given, which nobody else gets.
 */
final class AppLookTest extends TestCase
{
    private ?string $storage = null;
    private array $saved = [];
    private ?AppLookService $service = null;

    protected function setUp(): void
    {
        $this->saved = ['APP_URL' => $_ENV['APP_URL'] ?? null, 'DOCUMENT_ROOT' => $_SERVER['DOCUMENT_ROOT'] ?? null];
        $_ENV['APP_URL'] = 'https://forms.example';
    }

    protected function tearDown(): void
    {
        foreach (['APP_URL'] as $name) { if ($this->saved[$name] === null) unset($_ENV[$name]); else $_ENV[$name] = $this->saved[$name]; }
        if ($this->saved['DOCUMENT_ROOT'] === null) unset($_SERVER['DOCUMENT_ROOT']); else $_SERVER['DOCUMENT_ROOT'] = $this->saved['DOCUMENT_ROOT'];
        if ($this->storage === null || !is_dir($this->storage)) return;
        $root = realpath($this->storage);
        $temp = realpath(sys_get_temp_dir()) . DIRECTORY_SEPARATOR;
        if ($root === false || !str_starts_with($root, $temp) || !str_starts_with(basename($root), 'formlogic-app-look-')) throw new \RuntimeException('Unexpected fixture path');
        $iterator = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($iterator as $file) { if ($file->isDir() && !$file->isLink()) rmdir($file->getPathname()); else unlink($file->getPathname()); }
        rmdir($root);
    }

    private const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><rect width="10" height="10" fill="#f00"/></svg>';

    /** A PNG of $w x $h, drawn with GD where there is GD; a fixed 1x1 PNG otherwise. */
    private static function png(int $w = 64, int $h = 32): string
    {
        if (!function_exists('imagecreatetruecolor')) return base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
        $image = imagecreatetruecolor($w, $h);
        imagefill($image, 0, 0, imagecolorallocate($image, 200, 50, 50));
        ob_start(); imagepng($image); return (string) ob_get_clean();
    }

    /** An installed app with the manifest and media given. */
    private function install(array $manifest, array $media): NativeAppService
    {
        $this->storage ??= sys_get_temp_dir() . '/formlogic-app-look-' . bin2hex(random_bytes(8));
        $root = $this->storage . '/' . hash('sha256', 'game');
        if (!is_dir($root . '/private')) mkdir($root . '/private', 0700, true);
        file_put_contents($root . '/project.json', json_encode([
            'home' => true, 'version' => 1, 'access' => 'application',
            'files' => ['manifest.json' => json_encode($manifest + ['main' => 'ui/main.ui']), 'ui/main.ui' => '<Text>Game</Text>'],
            'assets' => array_map('base64_encode', $media),
        ]));
        return new NativeAppService($this->storage, $this->storage . '/no-runtime');
    }

    private static function app(array $look = [], string $status = 'published', array $more = []): array
    {
        return ['id' => 'game', 'slug' => 'outerstead', 'name' => 'Outer<stead> & "Co"', 'status' => $status, 'description' => 'App row description',
            'settings' => ['softnApp' => true] + ($look ? ['softnLook' => $look] : []) + $more];
    }

    public function testTheSettingKeepsOnlyWhatItsShapeAllows(): void
    {
        $this->assertSame(
            ['icon' => 'assets/art/logo.png', 'shareImage' => 'assets/cover.jpg', 'description' => 'A colony sim. Two lines.', 'background' => '#0b1020', 'spinner' => '#abc'],
            AppLookService::sanitize(['icon' => 'assets/art/logo.png', 'shareImage' => 'assets/cover.jpg', 'description' => "  A colony sim.\n\tTwo lines.  ", 'background' => '#0B1020', 'spinner' => '#ABC', 'extra' => 'x']),
        );
        $this->assertSame([], AppLookService::sanitize(['icon' => 'assets/../secret.png', 'shareImage' => 'assets/icon.svg', 'background' => 'red', 'spinner' => 'url(x)', 'description' => "\x01\x02"]));
        $this->assertSame(['icon' => 'assets/icon.svg'], AppLookService::sanitize(['icon' => 'assets/icon.svg', 'shareImage' => 'ui/main.ui']));
        $this->assertSame(300, mb_strlen(AppLookService::sanitize(['description' => str_repeat('é', 400)])['description']));
        $this->assertSame([], AppLookService::sanitize('not a look'));
    }

    public function testTheAppsOwnIconAndDescriptionComeFirstUntilTheOwnerChooses(): void
    {
        $native = $this->install(['icon' => 'assets/icon.svg', 'description' => 'First Light on Hollow-7.'], ['assets/icon.svg' => self::SVG, 'assets/art/logo.png' => self::png()]);
        $service = new AppLookService($native);
        $own = $service->resolve(self::app());
        $this->assertSame(['assets/icon.svg', 'svg', null, 'First Light on Hollow-7.'], [$own['icon'], $own['iconKind'], $own['shareImage'], $own['description']]);

        $chosen = $service->resolve(self::app(['icon' => 'assets/art/logo.png', 'description' => 'Mine', 'background' => '#112233']));
        $this->assertSame(['assets/art/logo.png', 'raster', 'assets/art/logo.png', 'Mine', '#112233'], [$chosen['icon'], $chosen['iconKind'], $chosen['shareImage'], $chosen['description'], $chosen['background']]);
        $this->assertNotSame($own['version'], $chosen['version'], 'a new look is a new address for its images');

        // A chosen file the app no longer has falls back to the app's own.
        $gone = $service->resolve(self::app(['icon' => 'assets/art/missing.png']));
        $this->assertSame('assets/icon.svg', $gone['icon']);
        // Not a SoftN app: no look at all.
        $this->assertNull($service->resolve(['id' => 'game', 'slug' => 'x', 'settings' => []]));
    }

    public function testIconsAndTheShareImageAreDrawnAtTheSizesAskedFor(): void
    {
        if (!function_exists('imagecreatetruecolor')) $this->markTestSkipped('GD is not installed');
        $service = new AppLookService($this->install([], ['assets/art/logo.png' => self::png(300, 100)]));
        $app = self::app(['icon' => 'assets/art/logo.png', 'background' => '#00ff00']);
        foreach ([32, 180, 192, 512] as $size) {
            $image = $service->image($app, "icon-$size.png");
            $this->assertSame('image/png', $image['type']);
            $this->assertSame([$size, $size], array_slice(getimagesizefromstring($image['bytes']), 0, 2));
        }
        $share = $service->image($app, 'share.png');
        $this->assertSame([1200, 630], array_slice(getimagesizefromstring($share['bytes']), 0, 2));
        // The maskable icon and Apple's sit on the loading background, the tab's on transparency.
        $corner = static function (string $png): array { $i = imagecreatefromstring($png); $c = imagecolorat($i, 0, 0); return [($c >> 16) & 255, ($c >> 8) & 255, $c & 255, ($c >> 24) & 127]; };
        $this->assertSame([0, 255, 0, 0], $corner($service->image($app, 'icon-512-maskable.png')['bytes']));
        $this->assertSame([0, 255, 0, 0], $corner($service->image($app, 'icon-180.png')['bytes']));
        $this->assertSame(127, $corner($service->image($app, 'icon-192.png')['bytes'])[3]);
        // Drawn once, then kept beside the media pack.
        $this->assertSame($service->image($app, 'icon-192.png')['bytes'], $service->image($app, 'icon-192.png')['bytes']);
        $this->assertNotEmpty(glob($this->storage . '/' . hash('sha256', 'game') . '/runtime-cache/look-*.bin'));
        // Nothing else by name, and no SVG where the icon is not one.
        foreach (['icon-64.png', 'icon-192-maskable.png', 'icon.svg', '../project.json', 'share.jpg'] as $name) $this->assertNull($service->image($app, $name), $name);
    }

    public function testAnIconThatCannotBeDrawnIsNotUsedAndIsNotDecodedAgain(): void
    {
        // A PNG's header and nothing a decoder can read after it.
        $broken = substr(self::png(), 0, 33) . str_repeat("\0", 64);
        $native = $this->install(['icon' => 'assets/icon.svg'], ['assets/icon.svg' => self::SVG, 'assets/broken.png' => $broken]);
        $service = new AppLookService($native);
        $app = self::app(['icon' => 'assets/broken.png', 'shareImage' => 'assets/broken.png']);
        // Describing the app decodes nothing: until someone asks for the image, it counts.
        $this->assertSame('assets/broken.png', $service->resolve($app)['icon']);
        $this->assertSame([], glob($this->storage . '/' . hash('sha256', 'game') . '/runtime-cache/look-*.bin'));
        // The first page that asks finds it cannot be drawn; from then on the app's own icon is used.
        // A tab asks for the smallest size first: that alone is enough for every size to be known.
        $this->assertNull($service->image($app, 'icon-32.png'));
        $this->assertNull($service->image($app, 'share.png'));
        $look = $service->resolve($app);
        $this->assertSame(['assets/icon.svg', 'svg', null], [$look['icon'], $look['iconKind'], $look['shareImage']], 'the app\'s own icon, and no share image');
        // What could not be drawn is known from then on, without decoding it again.
        $files = glob($this->storage . '/' . hash('sha256', 'game') . '/runtime-cache/look-*.bin');
        $this->assertNotEmpty($files);
        $this->assertContains("\0", array_map('file_get_contents', $files));
        $this->assertNull($service->image(self::app(['icon' => 'assets/broken.png']), 'icon-192.png'));
    }
    public function testAnImageClaimingMorePixelsThanAllowedIsNotDecoded(): void
    {
        // A PNG header for 30000 x 30000: a few bytes that would ask for gigabytes.
        $ihdr = pack('NNCCCCC', 30000, 30000, 8, 6, 0, 0, 0);
        $bomb = "\x89PNG\r\n\x1a\n" . pack('N', 13) . 'IHDR' . $ihdr . pack('N', crc32('IHDR' . $ihdr));
        $this->assertNull(AppLookService::draw($bomb, 192, 192, null, 1.0));
        $this->assertNull(AppLookService::draw('not an image', 192, 192, null, 1.0));
    }

    private function controller(array $app, ?array $domainApp = null): AppLookController
    {
        $apps = $this->createMock(AppService::class);
        $apps->method('getAppBySlug')->willReturn($app);
        $apps->method('isRuntimeVisible')->willReturnCallback(static fn(array $candidate, $user) => ($candidate['status'] ?? '') === 'published' || $user === 'owner');
        $domains = $this->createMock(AppDomainService::class);
        $domains->method('resolveAppSlugByHost')->willReturnCallback(static fn(string $host) => $host === 'outerstead.example' && $domainApp ? ['slug' => $domainApp['slug']] + $domainApp + ['mode' => 'runtime_direct'] : null);
        $domains->method('isThisSiteHost')->willReturnCallback(static fn(string $host) => $host === 'forms.example');
        $this->service = new AppLookService($this->install(['icon' => 'assets/icon.svg', 'description' => 'First <Light>.'], ['assets/icon.svg' => self::SVG, 'assets/art/logo.png' => self::png()]));
        return new AppLookController($apps, $this->service, $domains);
    }

    private function get(string $uri, array $headers = [], ?string $user = null): \Psr\Http\Message\ServerRequestInterface
    {
        $request = (new ServerRequestFactory())->createServerRequest('GET', $uri);
        foreach ($headers as $name => $value) $request = $request->withHeader($name, $value);
        parse_str((string) parse_url($uri, PHP_URL_QUERY), $query);
        return ($user !== null ? $request->withAttribute('userId', $user) : $request)->withQueryParams($query);
    }

    public function testAnSvgIconIsServedSoThatNothingInItEverRuns(): void
    {
        $controller = $this->controller(self::app());
        $version = $this->service->resolve(self::app())['version'];
        $response = $controller->image($this->get('/api/app/outerstead/look/icon.svg?v=' . $version), new Response(), ['slug' => 'outerstead', 'name' => 'icon.svg']);
        $this->assertSame(200, $response->getStatusCode());
        $this->assertSame('image/svg+xml', $response->getHeaderLine('Content-Type'));
        $this->assertStringStartsWith('sandbox;', $response->getHeaderLine('Content-Security-Policy'));
        $this->assertStringContainsString("default-src 'none'", $response->getHeaderLine('Content-Security-Policy'));
        $this->assertSame('nosniff', $response->getHeaderLine('X-Content-Type-Options'));
        $this->assertSame('public, max-age=31536000, immutable', $response->getHeaderLine('Cache-Control'));
        // Named by another version (a page opened before a change): the look as it is, checked each time,
        // never kept for a year under an address a look changed back to would name again.
        $stale = $controller->image($this->get('/api/app/outerstead/look/icon.svg?v=0'), new Response(), ['slug' => 'outerstead', 'name' => 'icon.svg']);
        $this->assertSame('public, no-cache', $stale->getHeaderLine('Cache-Control'));
        $again = $controller->image($this->get('/api/app/outerstead/look/icon.svg', ['If-None-Match' => $response->getHeaderLine('ETag')]), new Response(), ['slug' => 'outerstead', 'name' => 'icon.svg']);
        $this->assertSame(304, $again->getStatusCode());
    }

    public function testTheApisOwnPolicyKeepsTheSandboxItIsGiven(): void
    {
        $through = static function (string $csp): string {
            $handler = new class($csp) implements \Psr\Http\Server\RequestHandlerInterface {
                public function __construct(private string $csp) {}
                public function handle(\Psr\Http\Message\ServerRequestInterface $request): ResponseInterface { return $this->csp === '' ? new Response() : (new Response())->withHeader('Content-Security-Policy', $this->csp); }
            };
            return (new \FormLogic\Middleware\SecurityHeadersMiddleware())->process((new ServerRequestFactory())->createServerRequest('GET', '/'), $handler)->getHeaderLine('Content-Security-Policy');
        };
        $api = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
        // The sandboxed image's own policy, exactly, styles and all: it has no origin of its own.
        $own = \FormLogic\Middleware\SecurityHeadersMiddleware::SANDBOXED_IMAGE;
        $this->assertSame($own, $through($own));
        // Anything else is replaced, however it starts.
        $this->assertSame($api, $through('sandbox; script-src *'));
        $this->assertSame($api, $through("sandbox allow-scripts allow-same-origin; default-src 'none'; script-src 'unsafe-inline'"));
        // The site's own page (sitePage), exactly: under the API's it could run nothing.
        $this->assertSame(\FormLogic\Middleware\SecurityHeadersMiddleware::SITE_PAGE, $through(\FormLogic\Middleware\SecurityHeadersMiddleware::SITE_PAGE));
        $this->assertSame($api, $through(\FormLogic\Middleware\SecurityHeadersMiddleware::SITE_PAGE . "; script-src 'unsafe-inline'"), 'and only exactly');
        $this->assertSame($api, $through(''), 'everything else as before');
        $this->assertSame($api, $through("default-src 'self'"), 'and nothing looser survives it');
    }
    public function testImagesAreForWhomTheAppsManifestIs(): void
    {
        $draft = $this->controller(self::app([], 'draft'));
        $this->assertSame(404, $draft->image($this->get('/x'), new Response(), ['slug' => 'outerstead', 'name' => 'icon.svg'])->getStatusCode());
        $owners = $draft->image($this->get('/x?v=1', [], 'owner'), new Response(), ['slug' => 'outerstead', 'name' => 'icon.svg']);
        $this->assertSame(200, $owners->getStatusCode());
        $this->assertSame('private, no-cache', $owners->getHeaderLine('Cache-Control'), 'a draft\'s look is never kept where others could be given it');
        // Past an app's pass, as its manifest and welcome are: the look is its public face.
        $this->assertTrue(\FormLogic\Middleware\AppAccessGateMiddleware::isOpen('/api/app/{slug}/look/{name}'));
        $forms = $this->controller(['id' => 'game', 'slug' => 'outerstead', 'status' => 'published', 'settings' => []]);
        $this->assertSame(404, $forms->image($this->get('/x'), new Response(), ['slug' => 'outerstead', 'name' => 'icon.svg'])->getStatusCode());
    }

    private function sitePage(): string
    {
        $_SERVER['DOCUMENT_ROOT'] = $this->storage;
        file_put_contents($this->storage . '/index.html', '<!doctype html><title>FormLogic</title>');
        return '<!doctype html><title>FormLogic</title>';
    }

    public function testALinkPreviewServiceIsGivenTheAppsNameDescriptionAndImage(): void
    {
        $controller = $this->controller(self::app(['icon' => 'assets/art/logo.png']));
        $site = $this->sitePage();
        $response = $controller->sharePage($this->get('/app/outerstead', ['User-Agent' => 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)', 'Host' => 'forms.example']), new Response(), ['slug' => 'outerstead']);
        $html = (string) $response->getBody();
        $this->assertStringContainsString('<title>Outer&lt;stead&gt; &amp; &quot;Co&quot;</title>', $html, 'the name is text, never markup');
        $this->assertStringContainsString('<meta property="og:url" content="https://forms.example/app/outerstead">', $html);
        $this->assertStringContainsString('<meta property="og:description" content="First &lt;Light&gt;.">', $html);
        $this->assertMatchesRegularExpression('~<meta property="og:image" content="https://forms\.example/api/app/outerstead/look/share\.png\?v=[0-9a-f]{16}">~', $html);
        $this->assertStringContainsString('<meta name="twitter:card" content="summary_large_image">', $html);
        $this->assertSame('private, no-store', $response->getHeaderLine('Cache-Control'), 'never kept where a person could be given it');
        $this->assertSame('User-Agent', $response->getHeaderLine('Vary'));
        $this->assertStringNotContainsString('<script', $html);

        // A person, a draft, or another kind of app: the site's own page, as it is.
        $this->assertSame($site, (string) $controller->sharePage($this->get('/app/outerstead', ['User-Agent' => 'Mozilla/5.0 Chrome/140']), new Response(), ['slug' => 'outerstead'])->getBody());
        $this->assertSame($site, (string) $this->controller(self::app([], 'draft'))->sharePage($this->get('/app/outerstead', ['User-Agent' => 'Discordbot/2.0']), new Response(), ['slug' => 'outerstead'])->getBody());
        $this->assertSame($site, (string) $controller->sharePage($this->get('/', ['User-Agent' => 'Discordbot/2.0', 'Host' => 'forms.example']), new Response(), [])->getBody(), 'the site\'s own root');
    }

    public function testOnItsOwnDomainTheRootIsTheApp(): void
    {
        $app = self::app();
        $controller = $this->controller($app, $app);
        $this->sitePage();
        $html = (string) $controller->sharePage($this->get('/', ['User-Agent' => 'Twitterbot/1.0', 'Host' => 'outerstead.example']), new Response(), [])->getBody();
        $this->assertStringContainsString('<link rel="canonical" href="https://outerstead.example/">', $html);
        // An SVG icon cannot be a preview image: a summary card, and the icon as the page's icon.
        $this->assertStringContainsString('<meta name="twitter:card" content="summary">', $html);
        $this->assertStringNotContainsString('og:image', $html);
        $this->assertMatchesRegularExpression('~<link rel="icon" href="https://outerstead\.example/api/app/outerstead/look/icon\.svg\?v=~', $html);
    }

    /** The site's page as the build makes it: index.html, and the manifest link the PWA plugin adds. */
    private function builtSitePage(): string
    {
        $this->storage ??= sys_get_temp_dir() . '/formlogic-app-look-' . bin2hex(random_bytes(8));
        if (!is_dir($this->storage)) mkdir($this->storage, 0700, true);
        $_SERVER['DOCUMENT_ROOT'] = $this->storage;

        $html = (string) file_get_contents(__DIR__ . '/../../../ui/index.html');
        $html = str_replace('</head>', '<link rel="manifest" href="/manifest.webmanifest"></head>', $html);
        file_put_contents($this->storage . '/index.html', $html);
        return $html;
    }

    private function person(string $host): \Psr\Http\Message\ServerRequestInterface
    {
        return $this->get('/', ['User-Agent' => 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1', 'Host' => $host]);
    }

    public function testAPersonAtTheRootOfTheAppsDomainIsGivenTheSitesPageNamingTheApp(): void
    {
        $app = self::app();
        $controller = $this->controller($app, $app);
        $site = $this->builtSitePage();
        $response = $controller->sharePage($this->person('outerstead.example'), new Response(), []);
        $html = (string) $response->getBody();
        $name = 'Outer&lt;stead&gt; &amp; &quot;Co&quot;';
        $this->assertStringContainsString('<title data-fl-original="FormLogic — Build the system that runs your business" data-fl-applied="' . $name . '">' . $name . '</title>', $html, 'the name is text, never markup');
        foreach (['name="apple-mobile-web-app-title"', 'property="og:site_name"', 'property="og:title"', 'name="twitter:title"'] as $which) {
            $this->assertMatchesRegularExpression('~<meta ' . preg_quote($which, '~') . ' content="' . preg_quote($name, '~') . '" data-fl-original="[^"]+" data-fl-applied="' . preg_quote($name, '~') . '"~', $html, $which);
        }
        foreach (['name="description"', 'property="og:description"', 'name="twitter:description"'] as $which) {
            $this->assertMatchesRegularExpression('~<meta ' . preg_quote($which, '~') . ' content="First &lt;Light&gt;\." data-fl-original="Turn forms[^"]*" data-fl-applied="First &lt;Light&gt;\."~', $html, $which);
        }
        $this->assertStringContainsString('<link rel="manifest" href="/manifest.json" data-fl-original="/manifest.webmanifest" data-fl-applied="/manifest.json">', $html);
        // Nothing else of the page is touched: its scripts, its body, the rest of its head.
        $this->assertSame(substr_count($site, '<script'), substr_count($html, '<script'));
        $this->assertSame(substr($site, (int) strpos($site, '</head>')), substr($html, (int) strpos($html, '</head>')));
        $this->assertStringContainsString('<meta name="theme-color" content="#6366f1" />', $html, 'no theme colour of its own: the site\'s');
        // Under the shell's headers, which the security middleware leaves as they are.
        $this->assertSame(200, $response->getStatusCode());
        $this->assertSame('text/html; charset=utf-8', $response->getHeaderLine('Content-Type'));
        $this->assertSame(\FormLogic\Middleware\SecurityHeadersMiddleware::SITE_PAGE, $response->getHeaderLine('Content-Security-Policy'));
        $this->assertSame('no-cache', $response->getHeaderLine('Cache-Control'));
        $this->assertSame('nosniff', $response->getHeaderLine('X-Content-Type-Options'));
    }

    public function testANameOrDescriptionThatLooksLikeMarkupStaysText(): void
    {
        $app = ['name' => '</title><script>alert(1)</script>', 'description' => 'x'] + self::app(['description' => '"><script>alert(2)</script>']);
        $controller = $this->controller($app, $app);
        $site = $this->builtSitePage();
        $html = (string) $controller->sharePage($this->person('outerstead.example'), new Response(), [])->getBody();
        $this->assertSame(substr_count($site, '<script'), substr_count($html, '<script'));
        $this->assertStringContainsString('&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>', $html);
        $this->assertStringContainsString('content="&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;"', $html);
    }

    public function testEverywhereElseAPersonIsGivenTheSitesPageAsItIs(): void
    {
        $app = self::app();
        $site = $this->builtSitePage();
        $page = fn(AppLookController $controller, string $host): string => (string) $controller->sharePage($this->person($host), new Response(), [])->getBody();
        $this->assertSame($site, $page($this->controller($app, $app), 'forms.example'), 'the site\'s own address');
        $this->assertSame($site, $page($this->controller($app, $app), 'elsewhere.example'), 'a host nobody connected');
        $this->assertSame($site, $page($this->controller($app, ['mode' => 'launch_page'] + $app), 'outerstead.example'), 'a domain that opens on its launch page');
        $this->assertSame($site, $page($this->controller(self::app([], 'draft'), $app), 'outerstead.example'), 'a draft');
        $forms = ['id' => 'game', 'slug' => 'outerstead', 'name' => 'Forms', 'status' => 'published', 'settings' => []];
        $this->assertSame($site, $page($this->controller($forms, $forms), 'outerstead.example'), 'any other kind of app');
        // And when the lookup fails, the page still comes, as it is: the site's front page never fails for it.
        $apps = $this->createMock(AppService::class);
        $domains = $this->createMock(AppDomainService::class);
        $domains->method('resolveAppSlugByHost')->willThrowException(new \RuntimeException('database gone'));
        $this->service = new AppLookService($this->install([], []));
        $broken = $this->builtSitePage();
        $response = (new AppLookController($apps, $this->service, $domains))->sharePage($this->person('outerstead.example'), new Response(), []);
        $this->assertSame(200, $response->getStatusCode());
        $this->assertSame($broken, (string) $response->getBody());
    }

    public function testTheSitesRootComesFromTheBackendForEveryoneAndOnlyBotsAreLimited(): void
    {
        $htaccess = str_replace("\r\n", "\n", (string) file_get_contents(__DIR__ . '/../../../ui/public/.htaccess'));
        $this->assertStringContainsString("RewriteCond %{REQUEST_METHOD} ^(GET|HEAD)$\n  RewriteCond %{DOCUMENT_ROOT}/api/public/index.php -f\n  RewriteCond %{DOCUMENT_ROOT}/api/.env -f\n  RewriteRule ^$ api/public/index.php [QSA,L]", $htaccess);
        $this->assertStringContainsString("if (\$uri === '/' && in_array(\$_SERVER['REQUEST_METHOD'] ?? 'GET', ['GET', 'HEAD'], true)) {", (string) file_get_contents(__DIR__ . '/../../../ci/router.php'));
        $routes = str_replace("\r\n", "\n", (string) file_get_contents(__DIR__ . '/../../public/index.php'));
        $this->assertMatchesRegularExpression('~\$app->get\(\'/\', function[^}]+\}\)->add\(function \(\$request, \$handler\) use \(\$appLookRateLimiter\) \{\n\s+return \\\\FormLogic\\\\Controllers\\\\AppLookController::isPreviewBot\(~', $routes);
    }

    public function testTheWebServerSendsThePreviewServicesAndOnlyThose(): void

    {
        $htaccess = (string) file_get_contents(__DIR__ . '/../../../ui/public/.htaccess');
        $router = (string) file_get_contents(__DIR__ . '/../../../ci/router.php');
        $this->assertStringContainsString('RewriteCond %{HTTP_USER_AGENT} (' . AppLookController::PREVIEW_BOTS . ') [NC]', $htaccess);
        $this->assertStringContainsString("preg_match('~(" . AppLookController::PREVIEW_BOTS . ")~i'", $router);
        // And the README's Apache example, whose backend the bundled .htaccess cannot see.
        $this->assertStringContainsString('RewriteCond %{HTTP_USER_AGENT} (' . AppLookController::PREVIEW_BOTS . ') [NC]', (string) file_get_contents(__DIR__ . '/../../../README.md'));
        $this->assertTrue(AppLookController::isPreviewBot('WhatsApp/2.23.20.0'));
        $this->assertFalse(AppLookController::isPreviewBot('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), 'search engines run the page');
        $this->assertFalse(AppLookController::isPreviewBot(''));
    }

    public function testTheRuntimeGetSaysAnAppIsInstallableOnlyOncePublished(): void
    {
        // A draft's manifest answers its signed-in owner alone, and a browser asks for one signed out:
        // its page linked a manifest that was a 404 on every opening.
        $native = $this->install(['icon' => 'assets/icon.svg'], ['assets/icon.svg' => self::SVG]);
        $controller = new \FormLogic\Controllers\NativeAppController($this->createMock(AppService::class), $this->createMock(\FormLogic\Services\AppUserService::class), $native,
            $this->createMock(\FormLogic\Services\PlanService::class), $this->createMock(\FormLogic\Services\FlowService::class), $this->createMock(\FormLogic\Services\RuntimeEngineService::class), null, null, new AppLookService($native));
        $look = new \ReflectionMethod($controller, 'lookForRuntime');
        $this->assertTrue($look->invoke($controller, self::app(), null)['look']['installable']);
        $this->assertFalse($look->invoke($controller, self::app([], 'draft'), null)['look']['installable']);
    }

    public function testAManifestListsTheAppsOwnIcons(): void
    {
        $raster = AppLookService::manifestIcons(['icon' => 'assets/a.png', 'iconKind' => 'raster', 'version' => 'abc'], 'look/');
        $this->assertSame(['192x192', '512x512', '512x512'], array_column($raster, 'sizes'));
        $this->assertSame(['any', 'any', 'maskable'], array_column($raster, 'purpose'));
        // Beside the manifest's own address, which is the API's wherever the API is.
        $this->assertSame('look/icon-192.png?v=abc', $raster[0]['src']);
        $svg = AppLookService::manifestIcons(['icon' => 'assets/a.svg', 'iconKind' => 'svg', 'version' => 'abc'], '/api/app/outerstead/look/');
        $this->assertSame([['src' => '/api/app/outerstead/look/icon.svg?v=abc', 'sizes' => 'any', 'type' => 'image/svg+xml', 'purpose' => 'any']], $svg);
        $this->assertSame([], AppLookService::manifestIcons(['icon' => null, 'iconKind' => null, 'version' => 'abc'], 'look/'));
    }
}

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
        $domains->method('resolveAppSlugByHost')->willReturnCallback(static fn(string $host) => $host === 'outerstead.example' && $domainApp ? ['slug' => $domainApp['slug']] + $domainApp : null);
        return new AppLookController($apps, new AppLookService($this->install(['icon' => 'assets/icon.svg', 'description' => 'First <Light>.'], ['assets/icon.svg' => self::SVG, 'assets/art/logo.png' => self::png()])), $domains);
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
        $response = $controller->image($this->get('/api/app/outerstead/look/icon.svg?v=1'), new Response(), ['slug' => 'outerstead', 'name' => 'icon.svg']);
        $this->assertSame(200, $response->getStatusCode());
        $this->assertSame('image/svg+xml', $response->getHeaderLine('Content-Type'));
        $this->assertStringStartsWith('sandbox;', $response->getHeaderLine('Content-Security-Policy'));
        $this->assertStringContainsString("default-src 'none'", $response->getHeaderLine('Content-Security-Policy'));
        $this->assertSame('nosniff', $response->getHeaderLine('X-Content-Type-Options'));
        $this->assertSame('public, max-age=31536000, immutable', $response->getHeaderLine('Cache-Control'));
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

    public function testTheWebServerSendsThePreviewServicesAndOnlyThose(): void
    {
        $htaccess = (string) file_get_contents(__DIR__ . '/../../../ui/public/.htaccess');
        $router = (string) file_get_contents(__DIR__ . '/../../../ci/router.php');
        $this->assertStringContainsString('RewriteCond %{HTTP_USER_AGENT} (' . AppLookController::PREVIEW_BOTS . ') [NC]', $htaccess);
        $this->assertStringContainsString("preg_match('~(" . AppLookController::PREVIEW_BOTS . ")~i'", $router);
        $this->assertTrue(AppLookController::isPreviewBot('WhatsApp/2.23.20.0'));
        $this->assertFalse(AppLookController::isPreviewBot('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), 'search engines run the page');
        $this->assertFalse(AppLookController::isPreviewBot(''));
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

<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\AppLookController;
use FormLogic\Services\{AppDomainService, AppLookService, AppService, NativeAppService, SoftnSeoService};
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

final class SoftnSeoTest extends TestCase
{
    private string $storage;

    protected function setUp(): void
    {
        $this->storage = sys_get_temp_dir() . '/fl-softn-seo-' . bin2hex(random_bytes(6));
        mkdir($this->storage, 0700, true);
        $_ENV['APP_URL'] = 'https://forms.example';
        $_SERVER['DOCUMENT_ROOT'] = $this->storage;
        file_put_contents(
            $this->storage . '/index.html',
            '<!doctype html><html lang="en"><head><title>FormLogic</title><meta name="description" content="Default"><link rel="manifest" href="/manifest.webmanifest"></head><body><div id="root"></div><script src="/assets/app.js"></script></body></html>'
        );
    }

    protected function tearDown(): void
    {
        $this->removeDir($this->storage);
    }

    private function removeDir(string $dir): void
    {
        if (!is_dir($dir)) return;
        foreach (scandir($dir) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..') continue;
            $full = $dir . DIRECTORY_SEPARATOR . $entry;
            if (is_dir($full)) $this->removeDir($full);
            else @unlink($full);
        }
        @rmdir($dir);
    }

    private function installHtmlApp(string $appId, string $access = 'application'): NativeAppService
    {
        $root = $this->storage . '/' . hash('sha256', $appId);
        mkdir($root . '/private', 0700, true);
        file_put_contents($root . '/project.json', json_encode([
            'home' => true,
            'version' => 2,
            'access' => $access,
            'files' => [
                'manifest.json' => json_encode(['name' => 'Acme Bakery', 'main' => 'index.html']),
                'index.html' => '<!doctype html><html><head><title>Acme Bakery — Fresh Sourdough</title><meta name="description" content="Artisan sourdough baked daily."></head><body><h1>Fresh Sourdough Daily</h1><p>Visit our neighborhood bakery for warm loaves every morning.</p><a href="/about.html">About Us</a><script>alert("xss")</script></body></html>',
                'about.html' => '<!doctype html><html><head><title>About Acme Bakery</title><meta name="description" content="Our family story since 1998."></head><body><h1>Our Story</h1><p>Founded by two bakers with a wood-fired oven.</p></body></html>',
                'docs/menu.html' => '<!doctype html><html><head><title>Seasonal Menu</title></head><body><h1>Seasonal Menu</h1><p>Country loaf, rye batard, and cardamom buns.</p></body></html>',
            ],
            'assets' => [],
        ]));
        return new NativeAppService($this->storage, $this->storage . '/no-runtime');
    }

    /** @return array<string, mixed> */
    private function appRow(string $status = 'published', array $seo = []): array
    {
        return [
            'id' => 'bakery-1',
            'slug' => 'acme-bakery',
            'ownerId' => 'owner-1',
            'name' => 'Acme Bakery',
            'description' => 'Neighborhood bakery',
            'status' => $status,
            'updatedAt' => '2026-11-22 10:00:00',
            'settings' => [
                'softnApp' => true,
                ...($seo !== [] ? ['softnSeo' => $seo] : []),
            ],
        ];
    }

    public function testDiscoversMultiPageHtmlAppAndBuildsCleanSitemapAndSnapshot(): void
    {
        $native = $this->installHtmlApp('bakery-1', 'application');
        $look = new AppLookService($native);
        $seo = new SoftnSeoService($native, $look);
        $app = $this->appRow('published', ['extraRoutes' => ['/catering']]);

        $pages = $seo->discoverPages($app, 'https://acmebakery.example', true);
        $paths = array_column($pages, 'path');
        self::assertSame(['/', '/about.html', '/catering', '/docs/menu.html'], $paths);
        self::assertSame('About Acme Bakery', $pages[1]['title']);
        self::assertSame('Our family story since 1998.', $pages[1]['description']);

        // Per-page resolution for /about.html on custom domain
        $about = $seo->resolvePage($app, '/about.html', 'https://acmebakery.example', true, $look->resolve($app));
        self::assertTrue($about['indexable']);
        self::assertSame('About Acme Bakery', $about['title']);
        self::assertSame('https://acmebakery.example/about.html', $about['canonicalUrl']);
        self::assertStringContainsString('<h1>Our Story</h1>', $about['snapshotHtml']);
        self::assertStringContainsString('href="/about.html"', $about['snapshotHtml']);
        self::assertStringContainsString('href="/docs/menu.html"', $about['snapshotHtml']);
        // Embedded scripts from HTML source are NEVER emitted into the crawlable snapshot
        self::assertStringNotContainsString('<script', $about['snapshotHtml']);
        self::assertStringNotContainsString('alert(', $about['snapshotHtml']);
        // JSON-LD is valid WebPage schema
        self::assertNotNull($about['jsonLd']);
        $ld = json_decode($about['jsonLd'], true);
        self::assertSame('WebPage', $ld['@type']);
        self::assertSame('https://acmebakery.example/about.html', $ld['url']);

        // XML Sitemap includes every discovered page
        $xml = $seo->buildSitemapXml($app, 'https://acmebakery.example', true);
        self::assertStringContainsString('<loc>https://acmebakery.example/</loc>', $xml);
        self::assertStringContainsString('<loc>https://acmebakery.example/about.html</loc>', $xml);
        self::assertStringContainsString('<loc>https://acmebakery.example/docs/menu.html</loc>', $xml);
        self::assertStringContainsString('<loc>https://acmebakery.example/catering</loc>', $xml);

        // Robots.txt exposes sitemap on custom domain
        $robots = $seo->buildRobotsTxt($app, 'https://acmebakery.example');
        self::assertStringContainsString('Allow: /', $robots);
        self::assertStringContainsString('Sitemap: https://acmebakery.example/sitemap.xml', $robots);
    }

    public function testBlocksPrivateMembersOnlyAndDraftAndNoindexAppsFromCrawling(): void
    {
        $nativeMembers = $this->installHtmlApp('bakery-members', 'members');
        $seoMembers = new SoftnSeoService($nativeMembers);
        $membersApp = $this->appRow('published');
        $membersApp['id'] = 'bakery-members';

        $resolved = $seoMembers->resolvePage($membersApp, '/about.html', 'https://private.example', true);
        self::assertFalse($resolved['indexable']);
        self::assertSame('noindex, nofollow', $resolved['robots']);
        self::assertSame('', $resolved['snapshotHtml']);
        self::assertNull($resolved['jsonLd']);
        self::assertStringNotContainsString('/about.html', $seoMembers->buildSitemapXml($membersApp, 'https://private.example', true));
        self::assertStringContainsString('Disallow: /', $seoMembers->buildRobotsTxt($membersApp, 'https://private.example'));

        // Public app with allowIndexing = false
        $nativePub = $this->installHtmlApp('bakery-1', 'application');
        $seoPub = new SoftnSeoService($nativePub);
        $noindexApp = $this->appRow('published', ['allowIndexing' => false]);
        self::assertFalse($seoPub->assessIndexability($noindexApp)['indexable']);
        self::assertStringContainsString('Disallow: /', $seoPub->buildRobotsTxt($noindexApp, 'https://acmebakery.example'));
    }

    public function testControllerServesPerPageSeoHtmlSnapshotSitemapAndRobots(): void
    {
        $native = $this->installHtmlApp('bakery-1', 'application');
        $look = new AppLookService($native);
        $seo = new SoftnSeoService($native, $look);
        $app = $this->appRow('published');

        $apps = $this->createMock(AppService::class);
        $apps->method('getAppBySlug')->willReturn($app);
        $domains = $this->createMock(AppDomainService::class);
        $domains->method('isThisSiteHost')->willReturnCallback(static fn(string $h) => $h === 'forms.example');
        $domains->method('resolveAppSlugByHost')->willReturnCallback(static fn(string $h) => $h === 'acmebakery.example' ? ['slug' => 'acme-bakery', 'mode' => 'runtime_direct'] : null);

        $controller = new AppLookController($apps, $look, $domains, $seo);
        $reqFactory = new ServerRequestFactory();

        // Search engine visiting https://acmebakery.example/about.html
        $req = $reqFactory->createServerRequest('GET', 'https://acmebakery.example/about.html')
            ->withHeader('Host', 'acmebakery.example')
            ->withHeader('User-Agent', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)');
        $res = $controller->sharePage($req, new Response(), ['page' => 'about.html']);
        $body = (string) $res->getBody();
        self::assertSame(200, $res->getStatusCode());
        self::assertStringContainsString('<title data-fl-original="FormLogic" data-fl-applied="About Acme Bakery">About Acme Bakery</title>', $body);
        self::assertStringContainsString('<link rel="canonical" href="https://acmebakery.example/about.html">', $body);
        self::assertStringContainsString('<script type="application/ld+json">', $body);
        self::assertStringContainsString('<div id="root"><div data-fl-seo-snapshot="1">', $body);
        self::assertStringContainsString('<h1>Our Story</h1>', $body);

        // Sitemap at /app/acme-bakery/sitemap.xml
        $smReq = $reqFactory->createServerRequest('GET', 'https://forms.example/app/acme-bakery/sitemap.xml')->withHeader('Host', 'forms.example');
        $smRes = $controller->sitemap($smReq, new Response(), ['slug' => 'acme-bakery']);
        self::assertSame(200, $smRes->getStatusCode());
        self::assertSame('application/xml; charset=utf-8', $smRes->getHeaderLine('Content-Type'));
        self::assertStringContainsString('https://forms.example/app/acme-bakery/about.html', (string) $smRes->getBody());

        // Robots on custom domain
        $rbReq = $reqFactory->createServerRequest('GET', 'https://acmebakery.example/robots.txt')->withHeader('Host', 'acmebakery.example');
        $rbRes = $controller->robots($rbReq, new Response());
        self::assertSame(200, $rbRes->getStatusCode());
        self::assertStringContainsString('Sitemap: https://acmebakery.example/sitemap.xml', (string) $rbRes->getBody());
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\ExternalAppApiController;
use FormLogic\Middleware\SecurityHeadersMiddleware;
use FormLogic\Services\AppService;
use FormLogic\Services\NativeAppService;
use FormLogic\Services\NativeAppUploadsService;
use FormLogic\Services\SoftnSeoService;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * Security regression suite covering the FormLogic sandboxed-app audit findings:
 *  - API routes cannot opt into SITE_PAGE CSP (prevents same-origin XSS relaxation on /api/*)
 *  - ExternalAppApiController segment-safe prefix matching & customHeader allowlisting
 *  - NativeAppUploadsService filename/folder sanitization & magic-byte payload sniffing
 *  - SoftnSeoService draft/members/allowIndexing privacy suppression
 */
class SandboxSecurityAuditTest extends TestCase
{
    public function testSecurityHeadersBlocksSitePageCspOnApiRoutes(): void
    {
        $mw = new SecurityHeadersMiddleware(false);
        $req = (new ServerRequestFactory())->createServerRequest('GET', 'https://app.example.com/api/public/apps/a1/routes/index');
        $handler = new class implements RequestHandlerInterface {
            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                return (new ResponseFactory())->createResponse(200)
                    ->withHeader('Content-Security-Policy', SecurityHeadersMiddleware::SITE_PAGE);
            }
        };

        $res = $mw->process($req, $handler);
        $csp = $res->getHeaderLine('Content-Security-Policy');
        $this->assertStringContainsString("default-src 'none'", $csp);
        $this->assertNotSame(SecurityHeadersMiddleware::SITE_PAGE, $csp);
    }

    public function testSecurityHeadersAllowsSitePageCspOnNonApiSiteRoot(): void
    {
        $mw = new SecurityHeadersMiddleware(false);
        $req = (new ServerRequestFactory())->createServerRequest('GET', 'https://custom.example.com/about.html');
        $handler = new class implements RequestHandlerInterface {
            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                return (new ResponseFactory())->createResponse(200)
                    ->withHeader('Content-Security-Policy', SecurityHeadersMiddleware::SITE_PAGE);
            }
        };

        $res = $mw->process($req, $handler);
        $this->assertSame(SecurityHeadersMiddleware::SITE_PAGE, $res->getHeaderLine('Content-Security-Policy'));
    }

    public function testExternalApiSanitizeDropsDangerousCustomHeaders(): void
    {
        $clean = AppService::sanitizeExternalApi([
            'enabled' => true,
            'authMode' => 'public',
            'customHeaders' => [
                'Set-Cookie' => 'session=evil',
                'Content-Security-Policy' => "default-src *",
                'Content-Type' => 'text/html',
                'Access-Control-Allow-Origin' => 'https://evil.example',
                'Location' => 'https://evil.example',
                'X-App-Version' => '1.2.3',
            ],
        ]);

        $this->assertIsArray($clean);
        $headers = $clean['customHeaders'] ?? [];
        $lowerKeys = array_map('strtolower', array_keys($headers));
        $this->assertNotContains('set-cookie', $lowerKeys);
        $this->assertNotContains('content-security-policy', $lowerKeys);
        $this->assertNotContains('content-type', $lowerKeys);
        $this->assertNotContains('access-control-allow-origin', $lowerKeys);
        $this->assertNotContains('location', $lowerKeys);
        $this->assertContains('x-app-version', $lowerKeys);
    }

    public function testExternalApiPathPrefixIsSegmentSafe(): void
    {
        $ref = new \ReflectionMethod(ExternalAppApiController::class, 'pathMatchesPrefix');
        $ref->setAccessible(true);

        $this->assertTrue($ref->invoke(null, '/api/items', '/api/items'));
        $this->assertTrue($ref->invoke(null, '/api/items/42', '/api/items'));
        $this->assertFalse($ref->invoke(null, '/api/items-secret', '/api/items'));
        $this->assertFalse($ref->invoke(null, '/api/items2/1', '/api/items'));
    }

    public function testUploadsSanitizeFilenameAndFolderAgainstTraversal(): void
    {
        $this->assertStringNotContainsString('..', NativeAppUploadsService::sanitizeFilename('../../evil.php'));
        $this->assertStringNotContainsString('/', NativeAppUploadsService::sanitizeFilename('a/b/c.png'));
        $this->assertStringNotContainsString('\\', NativeAppUploadsService::sanitizeFilename('a\\b\\c.png'));

        $this->assertSame('docs/sub', NativeAppUploadsService::sanitizeFolder('/docs/sub/'));
        $this->assertStringNotContainsString('..', NativeAppUploadsService::sanitizeFolder('../../etc/passwd'));
    }

    public function testUploadsRejectsDangerousMagicBytesInNonMatchingCategories(): void
    {
        $ref = new \ReflectionMethod(NativeAppUploadsService::class, 'containsDangerousPayloadHeader');
        $ref->setAccessible(true);

        $this->assertTrue($ref->invoke(null, "<!DOCTYPE html><html><script>alert(1)</script></html>", 'images'));
        $this->assertTrue($ref->invoke(null, "<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>", 'images'));
        $this->assertTrue($ref->invoke(null, "<?php system('id'); ?>", 'documents'));
        $this->assertTrue($ref->invoke(null, "MZ\x90\x00\x03\x00\x00\x00", 'documents'));
        $this->assertTrue($ref->invoke(null, "\x7fELF\x02\x01\x01\x00", 'archives'));
        // Legitimate PNG header is allowed for images
        $this->assertFalse($ref->invoke(null, "\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR", 'images'));
    }

    public function testSoftnSeoSuppressesDraftMembersAndOptOutApps(): void
    {
        $nativeMock = $this->createMock(NativeAppService::class);
        $nativeMock->method('summary')->willReturnCallback(static function (string $appId): ?array {
            return match ($appId) {
                'pub-app' => ['access' => 'application', 'files' => ['index.html' => '<h1>Hello</h1>']],
                'members-app' => ['access' => 'members', 'files' => ['index.html' => '<h1>Private</h1>']],
                default => null,
            };
        });
        $seo = new SoftnSeoService($nativeMock);

        $draft = $seo->assessIndexability([
            'id' => 'pub-app',
            'status' => 'draft',
            'settings' => ['softnApp' => true],
        ]);
        $this->assertFalse($draft['indexable']);

        $members = $seo->assessIndexability([
            'id' => 'members-app',
            'status' => 'published',
            'settings' => ['softnApp' => true],
        ]);
        $this->assertFalse($members['indexable']);
        $this->assertSame('members', $members['access']);

        $optOut = $seo->assessIndexability([
            'id' => 'pub-app',
            'status' => 'published',
            'settings' => ['softnApp' => true, 'softnSeo' => ['allowIndexing' => false]],
        ]);
        $this->assertFalse($optOut['indexable']);

        $publicOk = $seo->assessIndexability([
            'id' => 'pub-app',
            'status' => 'published',
            'settings' => ['softnApp' => true, 'softnSeo' => ['allowIndexing' => true]],
        ]);
        $this->assertTrue($publicOk['indexable']);
    }
}

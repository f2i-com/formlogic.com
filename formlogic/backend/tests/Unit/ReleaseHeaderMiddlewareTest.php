<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Middleware\CorsMiddleware;
use FormLogic\Middleware\ReleaseHeaderMiddleware;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response as SlimResponse;

class ReleaseHeaderMiddlewareTest extends TestCase
{
    private string $file;

    protected function setUp(): void
    {
        $this->file = (string) tempnam(sys_get_temp_dir(), 'fl-version-');
    }

    protected function tearDown(): void
    {
        @unlink($this->file);
    }

    private function reply(string $path): ResponseInterface
    {
        $handler = new class implements RequestHandlerInterface {
            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                return new SlimResponse(503);
            }
        };
        return (new ReleaseHeaderMiddleware($path))->process((new ServerRequestFactory())->createServerRequest('GET', 'http://api.test/api/forms'), $handler);
    }

    public function testEveryReplyNamesTheRunningRelease(): void
    {
        file_put_contents($this->file, "0.1.21\n");
        $reply = $this->reply($this->file);
        $this->assertSame('0.1.21', $reply->getHeaderLine('X-FormLogic-Release'));
        $this->assertSame(503, $reply->getStatusCode(), 'a refusal says so too: it is what a page out of date gets');
    }

    public function testAnUntaggedPackageNamesItsOwnBuild(): void
    {
        file_put_contents($this->file, "4872f1c3-20261101\n");
        $this->assertSame('4872f1c3-20261101', $this->reply($this->file)->getHeaderLine('X-FormLogic-Release'));
    }

    // A source checkout has no VERSION file, and a page is built from no release there.
    public function testAnInstallWithNoVersionFileSendsNothing(): void
    {
        $this->assertFalse($this->reply($this->file . '-missing')->hasHeader('X-FormLogic-Release'));
    }

    // Slim throws on a header value it can't send, and that would take every reply down with it.
    public function testAFileThatIsNotAVersionSendsNothing(): void
    {
        foreach (['', "0.1.21\r\nX-Evil: 1", str_repeat('1', 200)] as $text) {
            file_put_contents($this->file, $text);
            $this->assertFalse($this->reply($this->file)->hasHeader('X-FormLogic-Release'), $text);
        }
    }

    // On a site with its API on another domain, a page can't read a response header unless CORS lets it.
    public function testAPageOnAnotherOriginMayReadIt(): void
    {
        $handler = new class implements RequestHandlerInterface {
            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                return new SlimResponse(200);
            }
        };
        $request = (new ServerRequestFactory())->createServerRequest('GET', 'http://api.test/api/forms')->withHeader('Origin', 'https://app.example.com');
        $reply = (new CorsMiddleware('https://app.example.com'))->process($request, $handler);
        $this->assertContains(ReleaseHeaderMiddleware::HEADER, array_map('trim', explode(',', $reply->getHeaderLine('Access-Control-Expose-Headers'))));
    }

    // Outside maintenance mode's middleware, so its 503s say which release is coming back.
    public function testItIsWiredOutsideMaintenanceMode(): void
    {
        $index = (string) file_get_contents(dirname(__DIR__, 2) . '/public/index.php');
        $release = strpos($index, '$app->add(new \FormLogic\Middleware\ReleaseHeaderMiddleware(');
        $this->assertIsInt($release);
        $this->assertGreaterThan((int) strpos($index, '$app->add(new \FormLogic\Middleware\MaintenanceMiddleware('), $release);
        $this->assertGreaterThan((int) strpos($index, '$app->add($corsMiddleware);'), $release);
        $this->assertStringContainsString("UpgradeService::defaultApiRoot() . '/VERSION'", $index);
    }
}

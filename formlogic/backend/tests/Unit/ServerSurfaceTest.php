<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Middleware\SecurityHeadersMiddleware;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/** What a server shows to a plain web request, whatever its rewrites do. */
final class ServerSurfaceTest extends TestCase
{
    /** @return array<string, array{string}> */
    public static function scripts(): array
    {
        $backend = dirname(__DIR__, 2);
        $found = [];
        foreach ([...(glob($backend . '/bin/*.php') ?: []), $backend . '/database/migrate.php'] as $path) {
            $found[basename($path)] = [$path];
        }
        return $found;
    }

    /** @dataProvider scripts */
    public function testAWebRequestRunsNoScript(string $path): void
    {
        $source = (string) file_get_contents($path);
        $guard = strpos($source, "if (isset(\$_SERVER['REQUEST_METHOD'])) {");
        self::assertNotFalse($guard, basename($path) . ' can be run by visiting it');
        foreach (['require ', 'require_once ', 'include ', 'include_once '] as $load) {
            $first = strpos($source, $load);
            self::assertTrue($first === false || $first > $guard, basename($path) . ' does work before the guard');
        }
    }

    public function testScriptFoldersDenyHttp(): void
    {
        $backend = dirname(__DIR__, 2);
        foreach (['bin', 'database', 'config', 'storage'] as $folder) {
            self::assertStringContainsString('Require all denied', (string) file_get_contents($backend . '/' . $folder . '/.htaccess'), $folder);
        }
    }

    private function hsts(string $url, ?string $appUrl): string
    {
        $saved = $_ENV['APP_URL'] ?? null;
        unset($_ENV['APP_URL'], $_SERVER['APP_URL']);
        if ($appUrl !== null) {
            $_ENV['APP_URL'] = $appUrl;
        }
        try {
            $handler = new class implements RequestHandlerInterface {
                public function handle(ServerRequestInterface $request): ResponseInterface
                {
                    return new Response(200);
                }
            };
            return (new SecurityHeadersMiddleware(true))
                ->process((new ServerRequestFactory())->createServerRequest('GET', $url), $handler)
                ->getHeaderLine('Strict-Transport-Security');
        } finally {
            unset($_ENV['APP_URL']);
            if ($saved !== null) {
                $_ENV['APP_URL'] = $saved;
            }
        }
    }

    public function testACustomersSubdomainsAreLeftToTheCustomer(): void
    {
        self::assertSame('max-age=31536000; includeSubDomains', $this->hsts('https://forms.example/api/x', 'https://forms.example'));
        self::assertSame('max-age=31536000; includeSubDomains', $this->hsts('https://FORMS.example/api/x', 'https://forms.example/'));
        self::assertSame('max-age=31536000', $this->hsts('https://shop.acme.com/api/x', 'https://forms.example'));
        self::assertSame('max-age=31536000', $this->hsts('https://shop.acme.com/api/x', null));
    }
}

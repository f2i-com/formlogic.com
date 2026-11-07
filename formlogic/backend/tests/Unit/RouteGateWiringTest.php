<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Middleware\AppAccessGateMiddleware;
use PHPUnit\Framework\TestCase;

/**
 * Every route that names an app by slug rides the age gate (AppAccessGateMiddleware): the
 * /api/app/{slug} group as a whole, and each such route outside it. Read from public/index.php, so
 * a route added later without the gate fails here. Which of them the gate leaves open is decided
 * by their ending, in the middleware, and is held here to what a page needs before the gate.
 */
final class RouteGateWiringTest extends TestCase
{
    private function source(): string
    {
        $source = file_get_contents(dirname(__DIR__, 2) . '/public/index.php');
        self::assertIsString($source);
        return str_replace("\r\n", "\n", $source);
    }

    public function testTheAppGroupRidesTheGate(): void
    {
        $source = $this->source();
        $groups = preg_match_all("/^\\\$app->group\\('\\/api\\/app\\/\\{slug\\}'/m", $source, $starts, PREG_OFFSET_CAPTURE);
        self::assertSame(1, $groups, 'one /api/app/{slug} group');
        // The group's closure ends at the first line that starts with "})" after it opens.
        self::assertSame(1, preg_match('/^\}\)(.*);$/m', $source, $end, 0, $starts[0][0][1]));
        self::assertStringContainsString('->add($appAccessGate)', $end[1], 'the /api/app/{slug} group must ride the age gate');
    }

    public function testEveryAppRouteOutsideTheGroupRidesTheGate(): void
    {
        $count = preg_match_all(
            "/\\\$app->(?:get|post|put|patch|delete|any|map)\\((?:\\[[^\\]]*\\],\\s*)?'(\\/api\\/app\\/\\{slug\\}[^']*)'.*?\\}\\)((?:->add\\([^;]*?\\))*);/s",
            $this->source(),
            $routes,
            PREG_SET_ORDER
        );
        self::assertGreaterThanOrEqual(6, $count, 'hosting, actions, entry, native, native/request and aokie-discovery');
        foreach ($routes as [, $path, $chain]) {
            self::assertStringContainsString('->add($appAccessGate)', $chain, "{$path} names an app and must ride the age gate");
        }
    }

    public function testNoOtherGroupReachesAnAppBySlug(): void
    {
        $source = $this->source();
        self::assertSame(0, preg_match("/\\\$app->group\\('\\/api\\/app'/", $source), 'a group of /api/app would place routes beside the gated one');
        self::assertSame(0, preg_match("/\\\$app->group\\('\\/api'\\s*,/", $source));
    }

    public function testTheGateIsBuiltOnOptionalSignInAndFilesAreGatedToo(): void
    {
        $source = $this->source();
        self::assertMatchesRegularExpression('/\$appAccessGate = new \\\\FormLogic\\\\Middleware\\\\AppAccessGateMiddleware\(\s*\$container->get\(AppService::class\),\s*\$container->get\(\\\\FormLogic\\\\Services\\\\AccessGateService::class\),\s*\$authOptional\s*\);/', $source);
        self::assertMatchesRegularExpression('/new FileController\([^;]*AccessGateService::class\)\s*\);/s', $source, 'files of a gated app are gated in FileController');
    }

    public function testWhatStaysOpenIsWhatAPageNeedsBeforeTheGate(): void
    {
        self::assertSame(['/manifest.json', '/client-manifest', '/welcome', '/membership', '/join', '/entry', '/aokie-discovery', '/look/{name}'], AppAccessGateMiddleware::OPEN);
        // A SoftN app's icons and share image (AppLookController): what its manifest, its welcome and a
        // link to it name, so they are as open as those. The app's media pack stays gated.
        self::assertTrue(AppAccessGateMiddleware::isOpen('/api/app/{slug}/look/{name}'));
        self::assertFalse(AppAccessGateMiddleware::isOpen('/api/app/{slug}/native/media'));
        // The Companion reads its discovery before anyone signs in: gated, no member could set it up.
        // What it may do after is the member's permissions, which the pass gates.
        self::assertTrue(AppAccessGateMiddleware::isOpen('/api/app/{slug}/aokie-discovery'));
        foreach (['/api/app/{slug}', '/api/app/{slug}/forms/{formId}/responses', '/api/app/{slug}/native', '/api/app/{slug}/native/request',
            '/api/app/{slug}/hosting', '/api/app/{slug}/actions/{action}', '/api/app/{slug}/flows', '/api/app/{slug}/my-permissions'] as $pattern) {
            self::assertFalse(AppAccessGateMiddleware::isOpen($pattern), $pattern);
        }
    }
}

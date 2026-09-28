<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use PHPUnit\Framework\TestCase;

/**
 * A linked desktop's lanes and the data API draw on separate budgets (docs/FORMLOGIC_DESKTOP.md
 * §8). One flk_ key serves both: the desktop's long polls, claims and heartbeat, and its calendar
 * sync and app-logic record writes. While they shared the /api/v1 group's 120/min per address and
 * ApiKeyMiddleware's 120/min per key, a burst of writes after an offline gap 429'd the relay and
 * flow runs, and busy lanes 429'd the writes. This pins the split in public/index.php: every
 * lane route sits in the second /api/v1 group (its own per-address limiter, and a per-key
 * budget named desktop_link), none of them in the data group, and nothing else joins them.
 */
final class DesktopLinkRateLimitWiringTest extends TestCase
{
    /** Every route of the desktop link, as `METHOD path` under /api/v1. */
    private const LINK_ROUTES = [
        'GET /flow-runs/queued',
        'POST /flow-runs/{runId}/claim',
        'PATCH /flow-runs/{runId}',
        'GET /connector-commands/pending',
        'POST /connector-commands/{id}/claim',
        'POST /connector-commands/{id}/complete',
        'DELETE /desktop-connections/self',
        'POST /desktop-connections',
        'POST /desktop-ai/pubkey',
        'GET /desktop-ai/pending',
        'POST /desktop-ai/{id}/claim',
        'POST /desktop-ai/{id}/frames',
        'GET /desktop-ai/{id}/input',
        'POST /desktop-ai/{id}/complete',
        'GET /desktop-flows/pending',
        'POST /desktop-flows/{id}/claim',
        'POST /desktop-flows/{id}/frames',
        'POST /desktop-flows/{id}/complete',
    ];

    /** Data calls the desktop also makes, which stay on the data API's budget. */
    private const DATA_ROUTES = [
        'GET /forms/{formId}/responses',
        'POST /forms/{formId}/responses',
        'PUT /forms/{formId}/responses/{id}',
        'POST /flow-runs',
        'GET /flows',
        'GET /flow-bindings',
        'GET /app-logic',
        'GET /script-profile',
        'GET /ai/preferences',
        'POST /aokie-companion/admission',
        'POST /data-node/register',
        'GET /data-node/self',
    ];

    private static function source(): string
    {
        $source = file_get_contents(dirname(__DIR__, 2) . '/public/index.php');
        self::assertIsString($source);
        return str_replace("\r\n", "\n", $source);
    }

    /** The body of the /api/v1 group closed by `})->add($<limiter>);`. */
    private static function group(string $source, string $limiter): string
    {
        $close = "})->add(\${$limiter});";
        $end = strpos($source, $close);
        self::assertNotFalse($end, "no group closed by {$close}");
        self::assertFalse(strpos($source, $close, $end + 1), "{$close} closes more than one group");
        $start = strrpos(substr($source, 0, $end), "\$app->group('/api/v1',");
        self::assertNotFalse($start, "no /api/v1 group before {$close}");
        return substr($source, $start, $end - $start);
    }

    /** @return list<string> every `METHOD path` a group registers, in order */
    private static function routes(string $group): array
    {
        preg_match_all("/\\\$group->(get|post|put|patch|delete)\\('([^']+)'/", $group, $m, PREG_SET_ORDER);
        return array_map(static fn (array $r): string => strtoupper($r[1]) . ' ' . $r[2], $m);
    }

    public function testTheLimitersHaveTheirOwnNamesAndNumbers(): void
    {
        $source = self::source();
        $this->assertMatchesRegularExpression(
            "/\\\$apiRateLimiter\\s*=\\s*new RateLimitMiddleware\\(\\\$rateLimiter,\\s*120,\\s*60,\\s*'api_v1'\\);/",
            $source,
            'the data API keeps 120/min per address'
        );
        $this->assertMatchesRegularExpression(
            "/\\\$desktopLinkRateLimiter\\s*=\\s*new RateLimitMiddleware\\(\\\$rateLimiter,\\s*1200,\\s*60,\\s*'desktop_link'\\);/",
            $source,
            'the desktop link has its own per-address budget, before auth'
        );
        $link = self::group($source, 'desktopLinkRateLimiter');
        $this->assertMatchesRegularExpression(
            "/\\\$desktopLinkAuth\\s*=\\s*fn\\s*\\(array \\\$scopes\\):\\s*ApiKeyMiddleware\\s*=>\\s*new ApiKeyMiddleware\\(\\\$apiKeyService,\\s*\\\$scopes,\\s*\\\$rateLimiter,\\s*600,\\s*60,\\s*'desktop_link'\\);/",
            $link,
            'the link lanes count 600/min per key, in a per-key budget of their own'
        );
        $this->assertSame(1, substr_count($link, 'new ApiKeyMiddleware('), 'every link route authenticates through $desktopLinkAuth');
    }

    public function testEveryLaneRouteIsOnTheLinkBudgetAndNothingElseIs(): void
    {
        $source = self::source();
        $link = self::group($source, 'desktopLinkRateLimiter');
        $data = self::group($source, 'apiRateLimiter');

        $linkRoutes = self::routes($link);
        $this->assertEqualsCanonicalizing(self::LINK_ROUTES, $linkRoutes, 'the link group holds exactly the lane routes');
        $this->assertSame(count($linkRoutes), count(array_unique($linkRoutes)));

        $dataRoutes = self::routes($data);
        foreach (self::LINK_ROUTES as $route) {
            $this->assertNotContains($route, $dataRoutes, "{$route} must not also draw on the data API's budget");
        }
        foreach (self::DATA_ROUTES as $route) {
            $this->assertContains($route, $dataRoutes, "{$route} stays on the data API's budget");
        }
        $this->assertStringNotContainsString('desktop_link', $data, 'no data route counts against the link budget');
    }

    public function testEachLinkRouteAuthenticatesWithALinkMiddleware(): void
    {
        $link = self::group(self::source(), 'desktopLinkRateLimiter');
        preg_match_all('/\$(\w+)\s*=\s*\$desktopLinkAuth\(/', $link, $m);
        $linkAuth = $m[1];
        $this->assertNotEmpty($linkAuth);

        preg_match_all("/\\\$group->\\w+\\('([^']+)'.*?\\}\\)((?:->add\\(\\\$\\w+\\))+);/s", $link, $routes, PREG_SET_ORDER);
        $this->assertCount(count(self::LINK_ROUTES), $routes);
        foreach ($routes as [, $path, $adds]) {
            preg_match_all('/->add\(\$(\w+)\)/', $adds, $added);
            $this->assertSame(1, count(array_intersect($added[1], $linkAuth)), "{$path} authenticates on the link budget");
        }
    }
}

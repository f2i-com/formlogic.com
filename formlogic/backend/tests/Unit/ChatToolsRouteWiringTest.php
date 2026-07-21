<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use PHPUnit\Framework\TestCase;

/**
 * Pins the route + middleware wiring of the Phase-6 chat-tools backend surface (plan §5.4):
 * the grant mint is session-authed behind its own per-user throttle (Slim middleware is
 * LIFO, so ->add($authRequired) must come last); the catalog rides authOptional (session
 * OR an flk_ key the controller validates itself); execute is flk_-ONLY via an
 * ApiKeyMiddleware with an EMPTY required-scope list (the controller does the
 * either-scope ai:relay|connector:relay check like preferencesV1). Also pins the DI
 * registrations and that the /api/ai/chat route now feeds the tool loop's dependencies.
 */
class ChatToolsRouteWiringTest extends TestCase
{
    private static string $source = '';

    public static function setUpBeforeClass(): void
    {
        $source = file_get_contents(dirname(__DIR__, 2) . '/public/index.php');
        self::assertIsString($source);
        self::$source = $source;
    }

    public function testGrantMintRoute(): void
    {
        $s = self::$source;
        $this->assertSame(1, substr_count($s, "'/api/ai/chat-tool-grant'"), 'grant route registered exactly once');
        $this->assertMatchesRegularExpression(
            '/\$chatToolsRateLimiter\s*=\s*new RateLimitMiddleware\(\$rateLimiter,\s*60,\s*60,\s*\'chat_tools\',\s*true\);/',
            $s,
            'chat-tools surface gets its own per-user budget'
        );
        $this->assertMatchesRegularExpression(
            '/\$app->post\(\'\/api\/ai\/chat-tool-grant\'.*?->mintGrant\(.*?\);\s*\}\)->add\(\$chatToolsRateLimiter\)->add\(\$authRequired\);/s',
            $s,
            'mint is session-authed (authRequired added last = runs first) behind the throttle'
        );
    }

    public function testCatalogRoute(): void
    {
        $this->assertSame(1, substr_count(self::$source, "'/api/ai/chat-tools/catalog'"));
        $this->assertMatchesRegularExpression(
            '/\$app->get\(\'\/api\/ai\/chat-tools\/catalog\'.*?->catalog\(.*?\);\s*\}\)->add\(\$authOptional\);/s',
            self::$source,
            'catalog is authOptional: a session wins, otherwise the controller validates an flk_ key itself'
        );
    }

    public function testExecuteRouteIsFlkOnly(): void
    {
        $s = self::$source;
        $this->assertSame(1, substr_count($s, "'/api/ai/chat-tools/execute'"));
        $this->assertMatchesRegularExpression(
            '/\$chatToolsExecuteAuth\s*=\s*new ApiKeyMiddleware\(\$container->get\(ApiKeyService::class\),\s*\[\],\s*\$rateLimiter\);/',
            $s,
            'execute authenticates flk_ keys with an EMPTY scope list — the controller does the either-scope check'
        );
        $this->assertMatchesRegularExpression(
            '/\$app->post\(\'\/api\/ai\/chat-tools\/execute\'.*?->execute\(.*?\);\s*\}\)->add\(\$chatToolsExecuteAuth\);/s',
            $s,
            'execute rides ONLY the API-key middleware (no session auth)'
        );
    }

    public function testContainerRegistrations(): void
    {
        $s = self::$source;
        $this->assertStringContainsString('\FormLogic\Services\ChatToolsService::class, function (Container $c)', $s);
        $this->assertStringContainsString('\FormLogic\Services\ChatToolGrantService::class, function (Container $c)', $s);
        $this->assertStringContainsString('\FormLogic\Controllers\ChatToolsController::class, function (Container $c)', $s);
        // The AIController registration feeds the hosted tool loop its handlers + audit sink.
        $this->assertMatchesRegularExpression(
            '/new AIController\(.*?\$c->get\(\\\\FormLogic\\\\Services\\\\ChatToolsService::class\),\s*\$c->get\(AuditService::class\)\s*\);/s',
            $s
        );
    }
}

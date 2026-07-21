<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use PHPUnit\Framework\TestCase;

/**
 * Pins the route + middleware wiring of the Phase-2/3 backend surfaces (plan §7):
 * hosted chat + preferences are session-authed OUTSIDE the cloudWriteGate'd /api/ai group
 * (allowance, not cloud entitlement, gates hosted inference); the admin allowances live in
 * the admin group; the v1 preferences route rides the either-scope relay middleware; and
 * the ops relay carries its own 30/min per-user throttle after session auth (Slim
 * middleware is LIFO, so ->add($authRequired) must come last).
 */
class SiteAiRouteWiringTest extends TestCase
{
    private static string $source = '';

    public static function setUpBeforeClass(): void
    {
        $source = file_get_contents(dirname(__DIR__, 2) . '/public/index.php');
        self::assertIsString($source);
        self::$source = $source;
    }

    public function testChatAndPreferencesRoutes(): void
    {
        $s = self::$source;
        // Exactly one registration of each new route (no double registration inside the group).
        $this->assertSame(1, substr_count($s, "'/api/ai/chat'"), 'chat route registered exactly once');
        $this->assertSame(2, substr_count($s, "'/api/ai/preferences'"), 'preferences registered once per method (GET + PUT)');
        $this->assertMatchesRegularExpression(
            '/\$aiChatRateLimiter\s*=\s*new RateLimitMiddleware\(\$rateLimiter,\s*30,\s*60,\s*\'ai_chat\',\s*true\);/',
            $s,
            'hosted chat gets the plan §7 30/min per-user budget'
        );
        $this->assertMatchesRegularExpression(
            '/\$app->post\(\'\/api\/ai\/chat\'.*?->chat\(.*?\);\s*\}\)->add\(\$aiChatRateLimiter\)->add\(\$authOptional\);/s',
            $s,
            'authOptional: a session JWT wins; otherwise the controller authenticates a scoped flk_ key (plan §5.6)'
        );
        $this->assertMatchesRegularExpression(
            '/\$app->get\(\'\/api\/ai\/preferences\'.*?getPreferences\(.*?\);\s*\}\)->add\(\$authRequired\);/s',
            $s
        );
        $this->assertMatchesRegularExpression(
            '/\$app->put\(\'\/api\/ai\/preferences\'.*?putPreferences\(.*?\);\s*\}\)->add\(\$authRequired\);/s',
            $s
        );
        // The chat route must NOT ride the cloudWriteGate'd /api/ai group: it is registered
        // AFTER that group closes.
        $groupClose = strpos($s, ")->add(\$cloudWriteGate)->add(\$aiRateLimiter)->add(\$authRequired);");
        $chatAt = strpos($s, "\$app->post('/api/ai/chat'");
        $this->assertNotFalse($groupClose);
        $this->assertNotFalse($chatAt);
        $this->assertGreaterThan($groupClose, $chatAt, 'chat must be registered after (outside) the cloudWriteGate group');
    }

    public function testAdminAllowanceRoutes(): void
    {
        $this->assertMatchesRegularExpression(
            '/\$group->get\(\'\/allowances\'.*?listAllowances\(.*?\);\s*\}\);/s',
            self::$source,
            'GET /api/admin/allowances inside the admin group'
        );
        $this->assertMatchesRegularExpression(
            '/\$group->put\(\'\/allowances\'.*?putAllowance\(.*?\);\s*\}\);/s',
            self::$source,
            'PUT /api/admin/allowances inside the admin group'
        );
    }

    public function testV1PreferencesRoute(): void
    {
        $this->assertMatchesRegularExpression(
            '/\$group->get\(\'\/ai\/preferences\'.*?preferencesV1\(.*?\);\s*\}\)->add\(\$desktopAiRelayAuth\);/s',
            self::$source,
            'the v1 preferences route rides the either-scope relay middleware (controller checks ai:relay|connector:relay)'
        );
    }

    public function testDesktopOpsRoutes(): void
    {
        $this->assertMatchesRegularExpression(
            '/\$desktopOpsRateLimiter\s*=\s*new RateLimitMiddleware\(\$rateLimiter,\s*30,\s*60,\s*\'desktop_ops\',\s*true\);/',
            self::$source
        );
        $this->assertMatchesRegularExpression(
            '/\$app->post\(\'\/api\/desktop\/ops\'.*?->enqueue\(.*?\);\s*\}\)->add\(\$desktopOpsRateLimiter\)->add\(\$authRequired\);/s',
            self::$source,
            'ops enqueue is throttled per user after session auth'
        );
        $this->assertMatchesRegularExpression(
            '/\$app->get\(\'\/api\/desktop\/ops\/\{id\}\'.*?->getOp\(.*?\);\s*\}\)->add\(\$authRequired\);/s',
            self::$source,
            'ops read-back is session-authed'
        );
    }

    public function testContainerRegistrations(): void
    {
        $this->assertStringContainsString('\FormLogic\Services\UserAiSettingsService::class, function (Container $c)', self::$source);
        $this->assertStringContainsString('\FormLogic\Controllers\DesktopOpsController::class, function (Container $c)', self::$source);
    }
}

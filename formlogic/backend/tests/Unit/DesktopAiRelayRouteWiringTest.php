<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use PHPUnit\Framework\TestCase;

/**
 * Pins the auth wiring of the E2E AI relay routes (plan Phase 1 §7): the web enqueue/input
 * routes run the per-user 30/min limiter AFTER session auth (Slim middleware is LIFO, so
 * ->add($authRequired) must come last), and the desktop v1 routes ride a scope-less
 * ApiKeyMiddleware because the controller accepts EITHER ai:relay OR the grandfathered
 * connector:relay scope per request (the middleware's required-scope list is AND-ed).
 */
class DesktopAiRelayRouteWiringTest extends TestCase
{
    public function testWebRoutesAreSessionAuthedWithAUserKeyedThrottle(): void
    {
        $indexPath = dirname(__DIR__, 2) . '/public/index.php';
        $source = file_get_contents($indexPath);
        $this->assertIsString($source);

        $this->assertMatchesRegularExpression(
            '/\$desktopAiRateLimiter\s*=\s*new RateLimitMiddleware\(\$rateLimiter,\s*30,\s*60,\s*\'desktop_ai\',\s*true\);/',
            $source,
            'the AI relay web throttle is 30/min keyed by user (plan §7)'
        );
        $this->assertMatchesRegularExpression(
            '/\$app->post\(\'\/api\/desktop\/ai\/requests\'.*?enqueue\(.*?\);\s*\}\)->add\(\$desktopAiRateLimiter\)->add\(\$authRequired\);/s',
            $source,
            'auth must be added last so userId exists before the per-user limiter runs'
        );
        $this->assertMatchesRegularExpression(
            '/\$app->post\(\'\/api\/desktop\/ai\/requests\/\{id\}\/input\'.*?postInput\(.*?\);\s*\}\)->add\(\$desktopAiRateLimiter\)->add\(\$authRequired\);/s',
            $source,
            'the input route shares the same auth-first throttle'
        );
        $this->assertMatchesRegularExpression(
            '/\$app->get\(\'\/api\/desktop\/ai\/requests\/\{id\}\/stream\'.*?->stream\(.*?\);\s*\}\)->add\(\$authRequired\);/s',
            $source,
            'the SSE route is session-authed (requesting-user match happens in the controller)'
        );
        $this->assertMatchesRegularExpression(
            '/\$app->get\(\'\/api\/desktop\/ai\/pubkey\'.*?getPubkey\(.*?\);\s*\}\)->add\(\$authRequired\);/s',
            $source,
            'the pubkey read is session-authed'
        );
    }

    public function testDesktopRoutesUseTheScopeCheckedRelayAuth(): void
    {
        $indexPath = dirname(__DIR__, 2) . '/public/index.php';
        $source = file_get_contents($indexPath);
        $this->assertIsString($source);

        $this->assertMatchesRegularExpression(
            '/\$desktopAiRelayAuth\s*=\s*new ApiKeyMiddleware\(\$apiKeyService,\s*\[\],\s*\$rateLimiter\);/',
            $source,
            'the desktop AI relay authenticates the flk_ key without an AND-ed scope list (either-scope check lives in the controller)'
        );
        foreach (['pubkey', 'pending', '{id}/claim', '{id}/frames', '{id}/input', '{id}/complete'] as $path) {
            $quoted = preg_quote($path, '/');
            $this->assertMatchesRegularExpression(
                '/\$group->(?:get|post)\(\'\/desktop-ai\/' . $quoted . '\'.*?\}\)->add\(\$desktopAiRelayAuth\);/s',
                $source,
                "desktop-ai/{$path} must ride the relay auth middleware"
            );
        }
    }
}

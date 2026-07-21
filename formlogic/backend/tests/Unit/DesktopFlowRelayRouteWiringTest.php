<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use PHPUnit\Framework\TestCase;

/**
 * Pins the auth wiring of the Phase-5 flow lanes (plan §5.7/§7): the web flow-relay
 * enqueue runs the per-user 30/min limiter AFTER session auth (Slim middleware is LIFO,
 * so ->add($authRequired) must come last), the desktop v1 routes ride a scope-less
 * ApiKeyMiddleware because the controller accepts EITHER flows:relay OR the grandfathered
 * connector:relay scope per request (the middleware's required-scope list is AND-ed), and
 * the cloud run dispatcher carries the plan §7 10/min per-user throttle with auth first.
 */
class DesktopFlowRelayRouteWiringTest extends TestCase
{
    public function testWebRoutesAreSessionAuthedWithAUserKeyedThrottle(): void
    {
        $indexPath = dirname(__DIR__, 2) . '/public/index.php';
        $source = file_get_contents($indexPath);
        $this->assertIsString($source);

        $this->assertMatchesRegularExpression(
            '/\$desktopFlowRateLimiter\s*=\s*new RateLimitMiddleware\(\$rateLimiter,\s*30,\s*60,\s*\'desktop_flow\',\s*true\);/',
            $source,
            'the flow relay web throttle is 30/min keyed by user (mirrors the AI lane)'
        );
        $this->assertMatchesRegularExpression(
            '/\$app->post\(\'\/api\/desktop\/flows\/run\'.*?enqueue\(.*?\);\s*\}\)->add\(\$desktopFlowRateLimiter\)->add\(\$authRequired\);/s',
            $source,
            'auth must be added last so userId exists before the per-user limiter runs'
        );
        $this->assertMatchesRegularExpression(
            '/\$app->get\(\'\/api\/desktop\/flows\/runs\/\{id\}\/stream\'.*?->stream\(.*?\);\s*\}\)->add\(\$authRequired\);/s',
            $source,
            'the SSE route is session-authed (requesting-user match happens in the controller)'
        );
    }

    public function testDesktopRoutesUseTheScopeCheckedRelayAuth(): void
    {
        $indexPath = dirname(__DIR__, 2) . '/public/index.php';
        $source = file_get_contents($indexPath);
        $this->assertIsString($source);

        $this->assertMatchesRegularExpression(
            '/\$desktopFlowRelayAuth\s*=\s*new ApiKeyMiddleware\(\$apiKeyService,\s*\[\],\s*\$rateLimiter\);/',
            $source,
            'the desktop flow relay authenticates the flk_ key without an AND-ed scope list (either-scope check lives in the controller)'
        );
        foreach (['pending', '{id}/claim', '{id}/frames', '{id}/complete'] as $path) {
            $quoted = preg_quote($path, '/');
            $this->assertMatchesRegularExpression(
                '/\$group->(?:get|post)\(\'\/desktop-flows\/' . $quoted . '\'.*?\}\)->add\(\$desktopFlowRelayAuth\);/s',
                $source,
                "desktop-flows/{$path} must ride the relay auth middleware"
            );
        }
    }

    public function testCloudRunDispatcherIsThrottledAndAuthed(): void
    {
        $indexPath = dirname(__DIR__, 2) . '/public/index.php';
        $source = file_get_contents($indexPath);
        $this->assertIsString($source);

        $this->assertMatchesRegularExpression(
            '/\$cloudFlowRunRateLimiter\s*=\s*new RateLimitMiddleware\(\$rateLimiter,\s*10,\s*60,\s*\'cloud_flow_run\',\s*true\);/',
            $source,
            'cloud runs are throttled at 10/min per user (plan §7)'
        );
        $this->assertMatchesRegularExpression(
            '/\$app->post\(\'\/api\/flows\/\{flowId\}\/run\'.*?FlowRunController::class\)->run\(.*?\);\s*\}\)->add\(\$cloudFlowRunRateLimiter\)->add\(\$authRequired\);/s',
            $source,
            'the dispatcher runs session auth before the per-user limiter'
        );
    }
}

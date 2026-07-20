<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use PHPUnit\Framework\TestCase;

/** Pins the auth-first, fail-closed rate-limit wiring for capability issuance. */
class ServiceCapabilityRouteWiringTest extends TestCase
{
    public function testServiceCapabilityMintUsesDedicatedFailClosedPerOwnerBudget(): void
    {
        $indexPath = dirname(__DIR__, 2) . '/public/index.php';
        $source = file_get_contents($indexPath);
        $this->assertIsString($source);

        $this->assertMatchesRegularExpression(
            '/\$serviceCapabilityRateLimiter\s*=\s*new RateLimitMiddleware\(\$rateLimiter,\s*10,\s*60,\s*\'service_capability\',\s*true,\s*true\);/',
            $source,
            'service capability issuance must be per-user, bounded to 10/minute, and fail closed'
        );
        $this->assertMatchesRegularExpression(
            '/\$group->post\(\'\/service-capability\'.*?mintServiceCapability\(.*?\);\s*\}\)->add\(\$serviceCapabilityRateLimiter\)->add\(\$authRequired\);/s',
            $source,
            'Slim is LIFO: auth must be added last so userId exists before the per-user limiter runs'
        );
        $this->assertMatchesRegularExpression(
            '/\$app->post\(\'\/api\/service-capability\'.*?mintWorkspaceServiceCapability\(.*?\);\s*\}\)->add\(\$serviceCapabilityRateLimiter\)->add\(\$authRequired\);/s',
            $source,
            'the app-less workspace mint must share the same auth-first, fail-closed budget'
        );
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use PHPUnit\Framework\TestCase;

/**
 * Every page load on a host the build doesn't know, so every page of a self-hosted site, asks
 * /api/public/launch/by-host. In the budget public forms share, a class on one address reached 429
 * at half the opens. This pins the lookup to a bucket of its own in the front controller, at the
 * forms' rate.
 */
class LaunchLookupRateLimitWiringTest extends TestCase
{
    public function testTheHostLookupHasItsOwnBucketAtTheFormsRate(): void
    {
        $source = file_get_contents(dirname(__DIR__, 2) . '/public/index.php');
        $this->assertIsString($source);

        $start = strpos($source, "\$app->get('/api/public/launch/by-host'");
        $this->assertNotFalse($start, 'the route exists');
        $end = strpos($source, "\n})", $start);
        $this->assertNotFalse($end);
        $line = trim((string) strtok(substr($source, $end + 1), "\n"));
        $this->assertSame("})->add(new RateLimitMiddleware(\$rateLimiter, 60, 60, 'launch_by_host'));", $line);

        $this->assertStringContainsString(
            "\$publicFormRateLimiter = new RateLimitMiddleware(\$rateLimiter, 60, 60, 'public_form');",
            $source,
            'the rate is the one public forms have'
        );
    }
}

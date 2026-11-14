<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use PHPUnit\Framework\TestCase;

/**
 * Pins the wiring of App AI's lane routes in public/index.php: a turn the browser stops is cancelled
 * by its requester, a link code is withdrawn by its maker, a computer's listing counts against the
 * listings budget once as it is asked (not on every read that follows), and the listings' turn keys
 * are derived from a secret of their own.
 */
final class AppAiLaneRouteWiringTest extends TestCase
{
    private static string $source = '';

    public static function setUpBeforeClass(): void
    {
        $source = file_get_contents(dirname(__DIR__, 2) . '/public/index.php');
        self::assertIsString($source);
        self::$source = $source;
    }

    public function testTheRequesterCancelsATurnOnTheSessionAuthedThrottledRoute(): void
    {
        $this->assertMatchesRegularExpression(
            '/\$app->post\(\'\/api\/desktop\/ai\/requests\/\{id\}\/cancel\'.*?->cancelRequest\(.*?\);\s*\}\)->add\(\$desktopAiRateLimiter\)->add\(\$authRequired\);/s',
            self::$source
        );
        $this->assertSame(1, substr_count(self::$source, "'/api/desktop/ai/requests/{id}/cancel'"));
    }

    public function testALinkCodeIsWithdrawnByItsMakerOnly(): void
    {
        // The controller's (DesktopLinkController::withdraw): the signed-in maker, never the demo or an administrator acting as them.
        $this->assertMatchesRegularExpression(
            '/\$app->delete\(\'\/api\/desktop-links\/codes\/\{id\}\', function \(\$request, \$response\) use \(\$container, \$getArgs\) \{\s*return \$container->get\(\\\\FormLogic\\\\Controllers\\\\DesktopLinkController::class\)->withdraw\(\$request, \$response, \$getArgs\(\$request\)\);\s*\}\)->add\(\$authRequired\);/s',
            self::$source
        );
        $this->assertSame(1, substr_count(self::$source, "\$app->delete('/api/desktop-links/codes/{id}'"));
    }

    public function testOnlyTheAskingCountsAgainstTheListingsBudget(): void
    {
        // Only a request that names a listing by a handle (text) is a read; none, or anything else
        // (`listing[]=1`, which the controller refuses), is the asking's.
        $this->assertMatchesRegularExpression(
            '/\$app->get\(\'\/api\/apps\/\{id\}\/ai\/\{listing:providers\|models\}\'.*?\}\)->add\(function \(\$request, \$handler\) use \(\$appAiListingLimiter, \$appAiListingReadLimiter\) \{\s*(?:\/\/[^\n]*\n\s*)?\$listing = \$request->getQueryParams\(\)\[\'listing\'\] \?\? null;\s*return is_string\(\$listing\) && \$listing !== \'\'\s*\? \$appAiListingReadLimiter->process\(\$request, \$handler\)\s*: \$appAiListingLimiter->process\(\$request, \$handler\);\s*\}\)->add\(\$authRequired\);/s',
            self::$source
        );
        $this->assertMatchesRegularExpression('/\$appAiListingLimiter = new RateLimitMiddleware\(\$rateLimiter, 60, 3600, \'app_ai_listings\', true, true\);/', self::$source, 'the budget is what it was');
    }

    /** From the JWT secret, and none at all without one: a hash of nothing is anyone's to make. */
    public function testTheListingsKeysHaveASecretOfTheirOwnFromTheJwtSecret(): void
    {
        $this->assertMatchesRegularExpression(
            '/new \\\\FormLogic\\\\Services\\\\SiteDesktopAi\(.*?secret: \(static fn \(string \$jwt\): \?string => strlen\(\$jwt\) >= 16 \? hash\(\'sha256\', \'formlogic-oaiy-listings:\' \. \$jwt\) : null\)\(\(string\) \(\$c->get\(\'settings\'\)\[\'jwt\'\]\[\'secret\'\] \?\? \'\'\)\)/s',
            self::$source
        );
    }
}

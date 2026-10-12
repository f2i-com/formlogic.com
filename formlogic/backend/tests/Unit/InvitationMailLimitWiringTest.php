<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use PHPUnit\Framework\TestCase;

/**
 * The invitation mail limits (EmailService's per-account and per-address counts, UserMailLimitTest)
 * hold only when AppUserController is given the rate limiter they count with: without it the
 * controller sends every invitation, as it did before the limits existed. The container in the
 * front controller is where it is given, for the owner's routes and the admin "acting as" ones
 * alike, so that is what this pins.
 */
class InvitationMailLimitWiringTest extends TestCase
{
    public function testTheInvitationsControllerIsGivenTheRateLimiter(): void
    {
        $source = file_get_contents(dirname(__DIR__, 2) . '/public/index.php');
        $this->assertIsString($source);
        $this->assertSame(1, substr_count($source, 'new AppUserController('), 'one place builds it, so every route gets the limits');

        $start = strpos($source, '$container->set(AppUserController::class');
        $this->assertNotFalse($start, 'the container defines AppUserController');
        $end = strpos($source, '});', $start);
        $this->assertNotFalse($end);
        $definition = substr($source, $start, $end - $start);
        $this->assertStringContainsString(
            '$c->get(\FormLogic\Services\RateLimiter::class)',
            $definition,
            'AppUserController is built with the rate limiter its invitation mail limits count with'
        );
    }
}

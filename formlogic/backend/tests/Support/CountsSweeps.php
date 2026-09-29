<?php

declare(strict_types=1);

namespace FormLogic\Tests\Support;

/**
 * Mixed into a subclass of one of the desktop relay services (DesktopCommandService,
 * DesktopAiRelayService, DesktopFlowRelayService) to count how often a poll runs the expiry sweep —
 * the expensive part of a held long-poll round — and, when asked, to skip the sweep itself.
 */
trait CountsSweeps
{
    /** How many times expireStale() was asked to run. */
    public int $sweeps = 0;
    private bool $sweepForReal = true;

    /** Keep counting but never sweep: shows that what a poll delivers does not depend on the sweep. */
    public function neverSweeping(): static
    {
        $this->sweepForReal = false;
        return $this;
    }

    public function expireStale(?string $ownerUserId = null): int
    {
        $this->sweeps++;
        return $this->sweepForReal ? parent::expireStale($ownerUserId) : 0;
    }
}

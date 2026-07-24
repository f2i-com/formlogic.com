<?php

declare(strict_types=1);

namespace FormLogic\Services\Packages;

/**
 * REL-705 (ADR-010): the Application Package v2 kill switch. Default ON (the plane shipped
 * fully gated and live-verified); set APPLICATION_PACKAGES_V2=false to disable it
 * OPERATIONALLY without corrupting installed state:
 *   - install lanes refuse (install plans propose/confirm, the v2 import branch, v2 describe);
 *   - definition serving goes dark → the flow editor degrades to the missing-node
 *     placeholders and NEW version mints compile no IR (already-minted compiled IR keeps
 *     executing — pinned revisions are immutable);
 *   - MANAGEMENT stays available: installed lists still show v2 rows and uninstall still
 *     works, so operators can always remove content while the plane is off.
 */
class PackagesFeature
{
    public static function v2Enabled(): bool
    {
        return (($_ENV['APPLICATION_PACKAGES_V2'] ?? getenv('APPLICATION_PACKAGES_V2')) !== 'false');
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * Thrown when materialising a blueprint would exceed the owner's plan form limit.
 */
final class BlueprintPlanLimitException extends \RuntimeException
{
}

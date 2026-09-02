<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use PHPUnit\Framework\TestCase;

/**
 * bin/flow-runs-reclaim.php cron script (Rotation 5 Tier-2 audit item #5).
 *
 * Mirrors DesktopCommandsCleanupTest's layering:
 *   1. Pure parsing of the staleness threshold (--seconds flag > FLOW_RUN_STALE_SECONDS env > 600
 *      default, clamped to >= 1). Always runs — no DB needed.
 *   2. The actual reclaim (revert-to-error) behavior — including the --dry-run "report without
 *      mutating" contract this script wraps — is exercised directly against FlowService in
 *      FlowRunLogTest (testReclaimStuckRunsRevertsOldRunningToErrorAndLeavesFreshRunAlone,
 *      testReclaimStuckRunsDryRunReportsWithoutMutating, testReclaimStuckRunsNeverTouchesQueuedRows).
 *      This file doesn't shell out to `php bin/flow-runs-reclaim.php` — UpgradeScriptTest documents
 *      why: spawning a child process here is fragile (Windows env/$_ENV plumbing through proc_open),
 *      so the CLI is tested by requiring it with a NO_RUN guard defined (exposing only the pure
 *      parsing function) and the code path it calls is tested directly.
 *
 * bin/flow-runs-reclaim.php is require-able with FLOW_RUNS_RECLAIM_NO_RUN defined: the guard returns
 * before any env/settings/DB work, exposing only flowRunStaleSeconds().
 */
class FlowRunsReclaimCleanupTest extends TestCase
{
    public static function setUpBeforeClass(): void
    {
        if (!defined('FLOW_RUNS_RECLAIM_NO_RUN')) {
            define('FLOW_RUNS_RECLAIM_NO_RUN', true);
        }
        require_once dirname(__DIR__, 2) . '/bin/flow-runs-reclaim.php';
    }

    public function testDefaultsTo600WhenNothingSet(): void
    {
        $this->assertSame(600, flowRunStaleSeconds([], []));
    }

    public function testEnvOverridesDefault(): void
    {
        $this->assertSame(900, flowRunStaleSeconds([], ['FLOW_RUN_STALE_SECONDS' => '900']));
    }

    public function testCliSecondsFlagWinsOverEnv(): void
    {
        $this->assertSame(
            120,
            flowRunStaleSeconds(['--seconds=120'], ['FLOW_RUN_STALE_SECONDS' => '900'])
        );
    }

    public function testInvalidEnvFallsBackToDefault(): void
    {
        $this->assertSame(600, flowRunStaleSeconds([], ['FLOW_RUN_STALE_SECONDS' => 'abc']));
        $this->assertSame(600, flowRunStaleSeconds([], ['FLOW_RUN_STALE_SECONDS' => '']));
    }

    public function testZeroFallsBackToTheDefaultRatherThanOneSecond(): void
    {
        // Clamping 0 to 1 turned a typo into "reclaim every run older than a
        // second": every in-flight run flipped to error on each cron tick and
        // every later completion 409ed. A nonsensical threshold is ignored.
        $this->assertSame(600, flowRunStaleSeconds(['--seconds=0'], []));
        $this->assertSame(600, flowRunStaleSeconds([], ['FLOW_RUN_STALE_SECONDS' => '0']));
    }
}

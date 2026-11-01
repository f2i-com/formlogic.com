<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\NotStoredAfterScript;
use FormLogic\Services\SubmissionIdempotencyService;
use PHPUnit\Framework\TestCase;

/**
 * The server holds the key of a submission whose script acted, and a page from before v0.1.19 never
 * changes it, so its copies are refused until it is reloaded. A current page changes the key and goes
 * straight through, and reloading it would throw its answers away, so "reload" can't be the first
 * thing these say. The offline queues know both texts by "script has already run" (isScriptRan).
 */
class ScriptRanWordingTest extends TestCase
{
    public function testAPageThatKeepsItsKeyIsToldToReloadOnlyIfItIsRefused(): void
    {
        $this->assertSame(
            "This form's script has already run for this submission, and nothing was stored. Please check with the form's owner before sending it again. If sending it again is refused, reload this page.",
            SubmissionIdempotencyService::SCRIPT_RAN_MESSAGE
        );
        $this->assertSame(
            "Your answers could not be saved, but this form's script has already run. Please check with the form's owner before sending them again. If sending them again is refused, reload this page.",
            (new NotStoredAfterScript(new \RuntimeException('database is locked')))->getMessage()
        );
    }
}

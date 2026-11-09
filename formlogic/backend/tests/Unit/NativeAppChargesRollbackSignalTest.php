<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\NativeAppService;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The runtime's word that a run committed nothing, which NativeAppCharges gives a paid charge back
 * on (NativeAppService::saysRolledBack): the runner's own handler line, or a startup stage that ends
 * before the handler. Never `request_integration`: under Node that stage lasts through the handler
 * and what follows its COMMIT, so a sale the app committed would be given back.
 */
final class NativeAppChargesRollbackSignalTest extends TestCase
{
    public static function lines(): array
    {
        return [
            'a handler that threw' => ["softn: handler download: could not make the file\n", true],
            'a handler that failed a host call, after Node\'s own warnings' => ["(node:4242) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n(Use `node --trace-warnings ...` to show where the warning was created)\nsoftn: handler download: SQL write failed\n", true],
            'a stage before the handler' => ["softn: startup stage database_open: unable to open database file\n", true],
            'a migration the deadline stopped' => ["softn: startup stage database_migrations: migration 002.sql was stopped at the 20 s deadline (1 of 3)\n", true],
            'request_integration: the handler may have committed' => ["softn: startup stage request_integration: engine dispose failed\n", false],
            'request_integration after the handler was rolled back' => ["softn: handler download: could not make the file\nsoftn: startup stage request_integration: engine dispose failed\n", true],
            'request_integration quoting an earlier stage' => ["softn: startup stage request_integration: softn: startup stage database_open: no\n", false],
            'nothing' => ['', false],
            'a worker that died' => ["softn: runner worker died: ERR_WORKER_OUT_OF_MEMORY\n", false],
            'a fault in the runner' => ["softn: host fault: panicked at <path>\n", false],
            'a stage this FormLogic has not read' => ["softn: startup stage answer_written: no\n", false],
            'a stage that only starts like an earlier one' => ["softn: startup stage request_limits_kept: no\n", false],
            'the handler line\'s words inside another line' => ["warning: softn: handler download: could not make the file\n", false],
            'a stage line\'s words inside another line' => ["warning: softn: startup stage database_open: no\n", false],
            'unrelated text' => ["Warning: something else went wrong\nsoftn handler download\n", false],
        ];
    }

    #[DataProvider('lines')]
    public function testOnlyTheRuntimesOwnWordThatNothingWasCommittedCounts(string $errors, bool $rolledBack): void
    {
        $this->assertSame($rolledBack, NativeAppService::saysRolledBack($errors));
    }

    public function testEveryStageBeforeTheHandlerCountsAndRequestIntegrationIsNotOne(): void
    {
        foreach (NativeAppService::STAGES_BEFORE_HANDLER as $stage) {
            $this->assertTrue(NativeAppService::saysRolledBack("softn: startup stage {$stage}: Invalid configuration\n"), $stage);
        }
        $this->assertNotContains('request_integration', NativeAppService::STAGES_BEFORE_HANDLER);
    }

    /**
     * The list is the bundled runtime's: every stage its Node worker names, in its order, up to
     * `request_integration`, which it enters just before it runs the handler. A SoftN that names
     * another stage, or moves one, fails here until the list is read against it again.
     */
    public function testTheStagesAreTheBundledRuntimesUpToTheOneThatRunsTheHandler(): void
    {
        $worker = dirname(__DIR__, 2) . '/resources/softn-native/request-worker.mjs';
        if (!is_file($worker)) $this->markTestSkipped('Prepare the native runtime.');
        $source = (string) file_get_contents($worker);
        preg_match_all('/startupStage\s*=\s*\'([a-z_]+)\'/', $source, $named, PREG_OFFSET_CAPTURE);
        $stages = array_values(array_unique(array_column($named[1], 0)));
        $this->assertSame([...NativeAppService::STAGES_BEFORE_HANDLER, 'request_integration'], $stages);
        // Every stage is entered before the handler is run, `request_integration` last: nothing after
        // the handler has a name of its own, so that one covers the handler and all that follows it.
        $handlerRuns = strpos($source, 'invokeWithHook(');
        $this->assertNotFalse($handlerRuns, 'where the worker runs the handler');
        foreach ($named[1] as [$stage, $at]) $this->assertLessThan($handlerRuns, $at, "{$stage} is entered before the handler runs");
        $this->assertSame('request_integration', end($named[1])[0]);
    }
}

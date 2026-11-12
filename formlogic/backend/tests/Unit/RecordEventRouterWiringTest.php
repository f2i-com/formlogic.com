<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\AppAiService;
use FormLogic\Services\FlowService;
use FormLogic\Services\NativeRecordEventRouter;
use PHPUnit\Framework\TestCase;

/**
 * Every place that dispatches a native app's record events goes through NativeRecordEventRouter. A
 * dispatcher acknowledges an event once its callback returns, and the flow queue skips binding ids
 * it does not know: one place that went straight to the flows would drop App AI's jobs, silently.
 */
final class RecordEventRouterWiringTest extends TestCase
{
    /** Where events are dispatched, and how many times each file does it. */
    private const DISPATCHERS = [
        'src/Controllers/NativeAppController.php' => 2,
        'bin/native-record-dispatch.php' => 1,
        // App AI's worker catches up on the events of apps with AI on, every few seconds, and takes
        // the follow-up job a delivery asked for as soon as the delivery is made (contract §0.13).
        'src/Services/AppAiWorker.php' => 2,
        // A record an AI created, corrected or deleted with change_native_app_record (over MCP, or
        // from the chat): its table's automations follow it as they follow the owner's own edit.
        'src/Services/SoftnAppTools.php' => 1,
    ];

    public function testEveryDispatcherGoesThroughTheRouter(): void
    {
        $root = dirname(__DIR__, 2);
        foreach (self::DISPATCHERS as $file => $expected) {
            if (!is_file($root . '/' . $file)) {
                $this->assertSame(0, $expected, "{$file} is missing");
                continue;
            }
            $source = (string) file_get_contents($root . '/' . $file);
            preg_match_all('/->dispatchRecordEvents\((.{0,240}?)\);/s', $source, $calls);
            $this->assertCount($expected, $calls[1], "{$file} should dispatch {$expected} time(s)");
            foreach ($calls[1] as $arguments) {
                $this->assertMatchesRegularExpression('/->for\(/', $arguments, "{$file} dispatches without NativeRecordEventRouter: {$arguments}");
            }
            $this->assertStringNotContainsString('->enqueueNativeRecordEvent(', $source, "{$file} hands events to the flows directly");
        }
    }

    public function testNothingElseDispatches(): void
    {
        $root = dirname(__DIR__, 2);
        $found = [];
        foreach (['src', 'bin', 'public'] as $folder) {
            $iterator = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($root . '/' . $folder, \FilesystemIterator::SKIP_DOTS));
            foreach ($iterator as $file) {
                if ($file->getExtension() !== 'php') continue;
                $relative = str_replace('\\', '/', substr($file->getPathname(), strlen($root) + 1));
                if (str_contains((string) file_get_contents($file->getPathname()), '->dispatchRecordEvents(')) $found[] = $relative;
            }
        }
        sort($found);
        $known = array_keys(array_filter(self::DISPATCHERS, static fn(int $count) => $count > 0));
        sort($known);
        $this->assertSame(array_values(array_intersect($known, $found)), $found, 'a new dispatcher must be added here and use the router');
    }

    public function testTheRouterHandsAppAiItsBindingsAndTheFlowsTheRest(): void
    {
        $flows = $this->createMock(FlowService::class);
        $flows->expects($this->once())->method('enqueueNativeRecordEvent')->with('app', str_repeat('e', 32), 'app.record.created.ai_jobs', ['record' => []], ['17', '18'])->willReturn(2);
        $ai = $this->createMock(AppAiService::class);
        $reader = static fn() => null;
        $ai->expects($this->once())->method('capture')->with('app', str_repeat('e', 32), 'app.record.created.ai_jobs', ['record' => []], ['fl-ai-v-x'], $reader)->willReturn(1);
        $router = new NativeRecordEventRouter($flows, $ai);
        $this->assertSame(3, ($router->for('app'))(str_repeat('e', 32), 'app.record.created.ai_jobs', ['record' => []], ['17', 'fl-ai-v-x', '18'], $reader));
    }

    public function testAnEventWithOnlyFlowBindingsNeverReachesAppAi(): void
    {
        $flows = $this->createMock(FlowService::class);
        $flows->method('enqueueNativeRecordEvent')->willReturn(1);
        $ai = $this->createMock(AppAiService::class);
        $ai->expects($this->never())->method('capture');
        $this->assertSame(1, (new NativeRecordEventRouter($flows, $ai))->deliver('app', str_repeat('e', 32), 'app.record.created.users', [], ['17']));
    }

    public function testAppAiFailingLeavesTheEventForTheNextDispatch(): void
    {
        $flows = $this->createMock(FlowService::class);
        $flows->expects($this->never())->method('enqueueNativeRecordEvent');
        $ai = $this->createMock(AppAiService::class);
        $ai->method('capture')->willThrowException(new \RuntimeException('MySQL is away'));
        $this->expectException(\RuntimeException::class);
        (new NativeRecordEventRouter($flows, $ai))->deliver('app', str_repeat('e', 32), 'app.record.created.ai_jobs', [], ['fl-ai-v-x', '17']);
    }
}

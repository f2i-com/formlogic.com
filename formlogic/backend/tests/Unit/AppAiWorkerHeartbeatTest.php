<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\AppAiService;
use FormLogic\Services\AppAiWorker;
use PHPUnit\Framework\TestCase;

/**
 * What the web reads of the App AI worker: its heartbeat (when it last made a pass, and which code it
 * runs), and from that whether a worker runs here and runs the code that is here now. And what an
 * administrator is told when their own test fails, which is no app's.
 */
final class AppAiWorkerHeartbeatTest extends TestCase
{
    private string $results = '';

    protected function setUp(): void
    {
        $this->results = sys_get_temp_dir() . '/formlogic-heartbeat-' . bin2hex(random_bytes(4));
        mkdir($this->results, 0777, true);
    }

    protected function tearDown(): void
    {
        @unlink($this->results . '/.alive');
        @rmdir($this->results);
    }

    /** The heartbeat a worker leaves: what it said of itself, and how long ago its last pass was. */
    private function beat(?array $said, int $secondsAgo = 2): void
    {
        file_put_contents($this->results . '/.alive', $said === null ? '' : json_encode($said));
        touch($this->results . '/.alive', time() - $secondsAgo);
    }

    public function testNoWorkerHasEverRun(): void
    {
        $this->assertNull(AppAiWorker::heartbeat($this->results));
        $this->assertNull(AppAiWorker::idleSeconds($this->results));
        $this->assertSame(['state' => 'missing', 'idleSeconds' => null, 'mode' => null], AppAiWorker::state($this->results, 'code-1'));
    }

    public function testAWorkerRunningTheCodeThatIsHere(): void
    {
        $this->beat(['fingerprint' => 'code-1', 'mode' => 'watch', 'startedAt' => time() - 500], 3);
        $beat = AppAiWorker::heartbeat($this->results);
        $this->assertSame(['code-1', 'watch'], [$beat['fingerprint'], $beat['mode']]);
        $this->assertEqualsWithDelta(3, $beat['idleSeconds'], 2);
        $this->assertSame('ok', AppAiWorker::state($this->results, 'code-1')['state']);
    }

    public function testAWatchingWorkerStartedBeforeTheLastUpdateIsStale(): void
    {
        $this->beat(['fingerprint' => 'code-1', 'mode' => 'watch'], 3);
        $state = AppAiWorker::state($this->results, 'code-2');
        $this->assertSame(['stale', 'watch'], [$state['state'], $state['mode']]);
    }

    /** A worker from before workers said what they run only touched its file: it is older than this code. */
    public function testAWorkerThatSaysNothingOfItselfIsStale(): void
    {
        $this->beat(null, 3);
        $this->assertSame(['fingerprint' => null, 'mode' => null], array_intersect_key(AppAiWorker::heartbeat($this->results), ['fingerprint' => 1, 'mode' => 1]));
        $this->assertSame('stale', AppAiWorker::state($this->results, 'code-2')['state']);
        $this->beat(['mode' => 'watch'], 3);
        $this->assertSame('stale', AppAiWorker::state($this->results, 'code-2')['state']);
        file_put_contents($this->results . '/.alive', '{"fingerprint":');
        $this->assertSame('stale', AppAiWorker::state($this->results, 'code-2')['state'], 'unreadable is nothing said');
    }

    /** A cron run notices the update and ends within seconds; the next minute's is fresh. */
    public function testACronRunFromJustBeforeAnUpdateIsNotStale(): void
    {
        $this->beat(['fingerprint' => 'code-1', 'mode' => 'cron'], 40);
        $this->assertSame('ok', AppAiWorker::state($this->results, 'code-2')['state']);
    }

    public function testAWorkerThatHasGoneQuietIsMissingWhateverItRan(): void
    {
        $this->beat(['fingerprint' => 'code-1', 'mode' => 'watch'], AppAiWorker::QUIET_SECONDS + 30);
        $missing = AppAiWorker::state($this->results, 'code-1');
        $this->assertSame('missing', $missing['state']);
        $this->assertEqualsWithDelta(AppAiWorker::QUIET_SECONDS + 30, $missing['idleSeconds'], 2);
        $this->assertSame('missing', AppAiWorker::state($this->results, 'code-2')['state'], 'not running comes before running old code');
        $this->beat(['fingerprint' => 'code-1', 'mode' => 'cron'], AppAiWorker::QUIET_SECONDS - 30);
        $this->assertSame('ok', AppAiWorker::state($this->results, 'code-1')['state'], 'a cron run a minute and a half ago is still running');
    }

    /** An administrator's test belongs to no app: none of what they are told about it says "this app". */
    public function testAnAdministratorsFailedTestIsToldInTheirOwnWords(): void
    {
        $changed = 'switched off or changed while the test waited';
        $codes = ['site_ai_unavailable', 'site_ai_gone', 'model_unset', 'no_pictures', 'expired', 'ai_unavailable', 'ai_off', 'ai_paused',
            'model_disabled', 'model_unknown', 'busy', 'bad_request', 'too_large', 'engine_failed', 'timeout', '', null];
        foreach ($codes as $code) {
            // What a worker running older code wrote on a job it did not know.
            $told = AppAiService::siteTestFailure($code, 'AI is turned off for this app.');
            $this->assertSame(['code', 'message', 'advice'], array_keys($told));
            $this->assertNotSame('', $told['message']);
            if (in_array($code, ['ai_unavailable', 'ai_off', 'ai_paused'], true)) {
                $this->assertSame('worker_outdated', $told['code']);
                $this->assertStringContainsString('started before the last update', $told['message']);
            }
            if (isset(AppAiService::SITE_TEST_FAILURES[$told['code']])) {
                $this->assertStringNotContainsStringIgnoringCase('this app', $told['message'] . $told['advice'], (string) $code);
            }
            // "Switched off or changed while the test waited" is said when that is what happened, and only then.
            $this->assertSame($code === 'site_ai_unavailable', str_contains($told['message'] . $told['advice'], $changed), (string) $code);
        }
        // Each thing that can change while a test waits is told as itself.
        $this->assertStringContainsString('unlinked, or got a new key, while the test waited', AppAiService::siteTestFailure('site_ai_gone', null)['message']);
        $this->assertStringContainsString('picture model was cleared while the test waited', AppAiService::siteTestFailure('model_unset', null)['message']);
        $this->assertStringContainsString('Nothing took the test in half an hour', AppAiService::siteTestFailure('expired', 'The AI was too busy to get to this in time. Try again.')['message']);
        // What the AI itself said is told as it said it, with what to try.
        $refused = AppAiService::siteTestFailure('model_disabled', 'image model flux-3-image-klein is disabled');
        $this->assertSame(['model_disabled', 'image model flux-3-image-klein is disabled'], [$refused['code'], $refused['message']]);
        $this->assertStringContainsString('Turn the model on in OAIY', $refused['advice']);
        $this->assertSame(['engine_failed', 'The AI gave no reason.', 'Look at OAIY on the computer for why, then test again.'], array_values(AppAiService::siteTestFailure('engine_failed', '  ')));
        // No words of the administrator's test, to start it or when it fails, speak of an app.
        foreach ([AppAiService::SITE_TEST_REFUSALS, AppAiService::SITE_TEST_FAILURES, AppAiService::SITE_TEST_ADVICE] as $words) {
            foreach ($words as $sentence) $this->assertStringNotContainsStringIgnoringCase(' app', $sentence);
        }
    }
}

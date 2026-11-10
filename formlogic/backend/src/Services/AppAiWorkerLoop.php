<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * How bin/app-ai-worker.php runs the worker: a pass about every second, for its budget (cron) or
 * until it is stopped (--watch), and never on code that has since been replaced.
 *
 * A PHP process keeps the code it started with. After an update the web asks for things the old code
 * does not know (a job that is no app's was told "AI is turned off for this app"), so a worker left
 * running is worse than none. The loop is given the fingerprint of the code as the process loaded it
 * and reads the code on disk again before every pass (CodeFingerprint: a few hundred `stat` calls,
 * about once a second). When they differ it takes no new work, finishes what it has in hand on the
 * .env upstream, says once that FormLogic was updated, and ends with UPDATED: its supervisor (or the
 * next minute's cron run) starts a fresh one. Work it sent to a computer is not lost: the next
 * worker carries on from the job's row.
 */
final class AppAiWorkerLoop
{
    /** The exit status when the code was updated under the worker (sysexits' EX_TEMPFAIL: start it again). */
    public const UPDATED = 75;
    /** A pass failed (--watch ends on the first, for its supervisor to restart it with a fresh connection). */
    public const FAILED = 1;
    public const UPDATED_LINE = 'FormLogic was updated; stopping so a fresh worker starts';

    private \Closure $now;
    private \Closure $rest;

    /**
     * @param \Closure(bool): array $tick one pass (AppAiWorker::tick); false: finish what is in flight, take nothing new
     * @param \Closure(): bool $busy whether anything is in flight in this process (AppAiWorker::busy)
     * @param \Closure(): string $onDisk the code's fingerprint as it is on disk now
     * @param string $loaded the code's fingerprint as this process loaded it
     * @param \Closure(string): void $say a line for the log
     * @param \Closure(string): void $complain a line for the error log
     * @param (\Closure(): float)|null $now the clock, in seconds
     * @param (\Closure(float): void)|null $rest wait this many seconds
     */
    public function __construct(
        private \Closure $tick,
        private \Closure $busy,
        private \Closure $onDisk,
        private string $loaded,
        private \Closure $say,
        private \Closure $complain,
        ?\Closure $now = null,
        ?\Closure $rest = null,
    ) {
        $this->now = $now ?? static fn(): float => microtime(true);
        $this->rest = $rest ?? static function (float $seconds): void {
            usleep((int) ($seconds * 1000000));
        };
    }

    /** Run until the budget is spent (or for ever, with $watch), or the code is updated. Answers the exit status. */
    public function run(bool $watch, int $budget): int
    {
        $deadline = ($this->now)() + $budget;
        $updated = false;
        $failed = false;
        do {
            $started = ($this->now)();
            // Before every pass: no job is taken by code that has been replaced.
            if (!$updated && $this->updated()) {
                $updated = true;
                ($this->say)(self::UPDATED_LINE);
            }
            // Past the budget, or once updated, a run takes no new work but finishes what it sent to the .env upstream.
            $takeNew = !$updated && ($watch || $started < $deadline);
            try {
                $did = array_filter(($this->tick)($takeNew));
                if ($did !== []) ($this->say)((string) json_encode($did));
            } catch (\Throwable $error) {
                $failed = true;
                ($this->complain)('App AI worker pass failed: ' . get_class($error) . ': ' . $error->getMessage());
                if ($watch) return $updated ? self::UPDATED : self::FAILED;
            }
            // About a pass a second; a pass with work in flight on the .env upstream waits on it instead.
            $spent = ($this->now)() - $started;
            if ($spent < 1.0) ($this->rest)(1.0 - $spent);
        } while (($this->busy)() || (!$updated && ($watch || ($this->now)() < $deadline)));
        return $updated ? self::UPDATED : ($failed ? self::FAILED : 0);
    }

    /** Whether the code on disk is no longer what this process loaded. Unreadable is not updated. */
    private function updated(): bool
    {
        try {
            return ($this->onDisk)() !== $this->loaded;
        } catch (\Throwable) {
            return false;
        }
    }
}

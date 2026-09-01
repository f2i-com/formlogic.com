<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * Runs FormLogic user code inside the zipp sandbox, via the vendored
 * `formlogic-runtime` child (no Node runtime required). The desktop flow runner
 * embeds the same engine and the same prelude, so an expression means the same
 * thing wherever it runs.
 *
 * The engine replaced a QuickJS build whose harness had to capture `std`/`os`
 * — filesystem, `popen`, `getenv`, `urlGet` — and then delete them from the
 * global object before a guest ran. zipp's interpreter-only `safe-sandbox`
 * profile ships no host modules at all, so there is no list to keep in step, and
 * a runaway guest is stopped by an instruction budget inside the interpreter
 * rather than only by an external kill.
 *
 * Two modes, both speaking newline-delimited JSON over the child's stdio
 * (the protocol is unchanged; the child implements it in Rust):
 *
 *  - evaluateBatch(): pure field expressions (conditions / calculated fields /
 *    validation). One round-trip, no host callbacks.
 *  - runScript(): a user onSubmit(ctx) script. ctx.db/ctx.http/ctx.utils are
 *    dispatched back to a PHP host handler via synchronous RPC, so all IO and its
 *    SSRF/DNS-pinning guards stay in PHP. The RPC is now a host-side Rust closure
 *    rather than the guest reading its own stdin, so the guest has no way to
 *    reach the transport.
 *
 * IO model: stdio pipes are left BLOCKING. The NDJSON protocol is strictly
 * turn-based (the child writes exactly one line then blocks reading our reply), so
 * blocking fgets cannot deadlock. A runaway/looping guest is hard-killed by an
 * EXTERNAL watchdog process (ping+taskkill on Windows / sleep+kill on POSIX, see
 * spawnWatchdog) when a single compute window overruns the CPU budget; that
 * closes the pipes and unblocks fgets. proc_terminate() in run() is only a
 * post-loop cleanup fallback. Windows proc_open pipes don't support non-blocking
 * reads, stream_select or stream_set_timeout, which is why this design is used.
 * The watchdog is paused around host calls so handler latency (e.g. a slow HTTP
 * request, bounded separately) doesn't count against the guest's compute budget.
 */
class SandboxRunner
{
    private string $binary;
    private string $prelude;
    private int $memoryLimitKb;
    private int $stackSizeKb;

    public function __construct(
        ?string $binary = null,
        int $memoryLimitKb = 65536, // 64 MiB — matches the browser VM (zipp-host.ts)
        int $stackSizeKb = 512
    ) {
        $base = dirname(__DIR__, 2); // .../backend
        $this->binary = $binary ?? $this->detectBinary($base);
        $this->prelude = $base . '/resources/formlogic-prelude.js';
        $this->memoryLimitKb = $memoryLimitKb;
        $this->stackSizeKb = $stackSizeKb;
    }

    private function detectBinary(string $base): string
    {
        // FORMLOGIC_QJS_BIN is still honoured: it is documented, it is set in
        // existing deployments, and its job (point at a runtime somewhere else)
        // has not changed. FORMLOGIC_RUNTIME_BIN is the name that matches what it
        // now points at.
        foreach (['FORMLOGIC_RUNTIME_BIN', 'FORMLOGIC_QJS_BIN'] as $var) {
            $override = getenv($var) ?: ($_ENV[$var] ?? '');
            if (is_string($override) && $override !== '' && is_file($override)) {
                return $override;
            }
        }
        $dir = $base . '/bin/runtime';
        if (PHP_OS_FAMILY === 'Windows') {
            return $dir . '/formlogic-runtime-windows-x86_64.exe';
        }
        return $dir . '/formlogic-runtime-linux-x86_64';
    }

    /**
     * Whether the runtime is installed and usable. Callers should treat a false
     * here the same way they handle an evaluation error (fail-open visibility,
     * skip calculated fields, etc.).
     */
    public function isAvailable(): bool
    {
        return is_file($this->binary) && is_file($this->prelude);
    }

    /**
     * Evaluate a batch of pure expressions.
     *
     * @param array<int, array{id: string, expression: string, context?: array}> $jobs
     * @return array<string, array{ok: bool, value?: mixed, error?: string}> keyed by job id
     */
    public function evaluateBatch(array $jobs, array $context = [], int $cpuBudgetMs = 1000): array
    {
        // Shared context sent ONCE at the payload top level (the runtime applies it
        // to all jobs) instead of duplicated into every job — see FormLogicService.
        $payload = ['mode' => 'eval', 'jobs' => array_values($jobs), 'context' => (object) $context];
        $done = $this->run($payload, null, $cpuBudgetMs);

        $out = [];
        foreach (($done['results'] ?? []) as $r) {
            if (isset($r['id'])) {
                $out[(string) $r['id']] = $r;
            }
        }
        return $out;
    }

    /**
     * Evaluate a single expression. Returns ['ok' => bool, 'value' => mixed] or
     * ['ok' => false, 'error' => string].
     *
     * @param array<string, mixed> $context
     * @return array{ok: bool, value?: mixed, error?: string}
     */
    public function evaluate(string $expression, array $context = [], int $cpuBudgetMs = 1000): array
    {
        $results = $this->evaluateBatch(
            [['id' => '0', 'expression' => $expression]],
            $context,
            $cpuBudgetMs
        );
        return $results['0'] ?? ['ok' => false, 'error' => 'no result'];
    }

    /**
     * Run a user onSubmit(ctx) script. The host handler is invoked for every
     * ctx.db/ctx.http/ctx.utils call: handler(string $module, string $method, array $args): mixed.
     * It may throw to surface an error into the guest.
     *
     * @param array{answers?: array, meta?: array} $context
     * @return array  The runtime's "done" message: {result?, reject?, message?, error?}
     */
    public function runScript(string $script, array $context, callable $hostHandler, int $cpuBudgetMs = 2500): array
    {
        $payload = [
            'mode' => 'script',
            'script' => $script,
            'context' => [
                'answers' => (object) ($context['answers'] ?? []),
                'meta' => (object) ($context['meta'] ?? []),
            ],
        ];
        return $this->run($payload, $hostHandler, $cpuBudgetMs);
    }

    /**
     * Core process driver. Spawns the child, writes the job, pumps the NDJSON protocol
     * until a "done" message (or deadline/crash), and returns the done payload.
     *
     * @return array  Always returns a "done"-shaped array; on failure it carries
     *                an 'error' key so callers degrade gracefully.
     */
    private function run(array $payload, ?callable $hostHandler, int $cpuBudgetMs): array
    {
        if (!$this->isAvailable()) {
            return ['error' => 'FormLogic runtime is not available'];
        }

        $cmd = [
            $this->binary,
            '--prelude', $this->prelude,
            '--heap-mb', (string) max(1, intdiv($this->memoryLimitKb, 1024)),
        ];

        $descriptors = [
            0 => ['pipe', 'r'],
            1 => ['pipe', 'w'],
            2 => ['pipe', 'w'],
        ];

        $proc = @proc_open($cmd, $descriptors, $pipes, null, null, ['bypass_shell' => true]);
        if (!is_resource($proc)) {
            return ['error' => 'Failed to start FormLogic runtime'];
        }

        $pid = (int) (proc_get_status($proc)['pid'] ?? 0);

        // See the class docblock for the blocking-lockstep + external-watchdog IO
        // model (and why non-blocking pipes can't be used on Windows).
        $cpuSecs = max(1, (int) ceil($cpuBudgetMs / 1000));
        // CUMULATIVE guest-compute budget that host calls cannot reset. The watchdog
        // is paused/re-armed around every host call; re-arming with the FULL window
        // each time let a guest emitting cheap host calls in a loop run forever
        // (pinning this PHP worker — a cross-tenant DoS that defeated the runaway
        // kill). We cap total guest-compute time across all windows, and cap the
        // host-call COUNT (a tight fast-host-call loop consumes ~0 compute per window
        // but churns proc_open and still pins the worker).
        $budgetSecs = max(1.0, $cpuBudgetMs / 1000);
        $consumedSecs = 0.0;
        $hostCalls = 0;
        // Generous vs any legit onSubmit (ctx.db caps at 50 fields/20 tags, ctx.http
        // is separately capped), but bounds a tight fast-host-call loop that consumes
        // ~0 compute per window yet churns proc_open and pins the worker.
        // A legit onSubmit caps at 50 fields + 20 tags via ctx.db (plus
        // separately-capped ctx.http) — well under ~100 host calls — so 256 keeps
        // generous headroom while tightly bounding a fast-host-call loop's
        // proc_open(watchdog) churn.
        $maxHostCalls = 256;
        $watchdog = $this->spawnWatchdog($pid, $cpuSecs);
        // Fail closed: without an armed watchdog a runaway guest would wedge this
        // worker forever on the blocking read. Callers degrade like any error.
        if ($watchdog === null) {
            $this->cleanup($proc, $pipes);
            return ['error' => 'FormLogic runtime watchdog could not be started'];
        }

        // Send the job (single line of JSON).
        @fwrite($pipes[0], $this->encodeLine($payload));
        @fflush($pipes[0]);
        $windowStart = microtime(true);

        $done = null;
        while (($line = fgets($pipes[1])) !== false) {
            $line = trim($line);
            if ($line === '') {
                continue;
            }
            $msg = json_decode($line, true);
            if (!is_array($msg)) {
                continue;
            }
            $type = $msg['type'] ?? null;
            if ($type === 'call') {
                // Account the guest-compute time of the window that just ended, then
                // enforce the cumulative budget + host-call cap BEFORE more work —
                // neither can be reset by the guest.
                $consumedSecs += microtime(true) - $windowStart;
                if (++$hostCalls > $maxHostCalls || $consumedSecs >= $budgetSecs) {
                    break; // budget / host-call cap exhausted — cleanup() kills the guest
                }
                // Pause the compute watchdog around EVERY host call: the handler
                // runs on the trusted PHP side while the guest sits idle waiting
                // for the reply, so it must not burn the compute budget — and this
                // also closes the kill-mid-dispatch race for db/utils calls.
                $this->stopWatchdog($watchdog);
                $reply = $this->dispatchHostCall($hostHandler, $msg);
                // the child may have been killed (or the pipe broken) meanwhile; stop if so.
                $st = proc_get_status($proc);
                if (empty($st['running']) || @fwrite($pipes[0], $this->encodeLine($reply)) === false) {
                    break;
                }
                @fflush($pipes[0]);
                // Re-arm with only the REMAINING compute budget (never the full
                // window again) so cumulative guest compute stays bounded.
                $remainingSecs = max(1, (int) ceil($budgetSecs - $consumedSecs));
                $windowStart = microtime(true);
                $watchdog = $this->spawnWatchdog($pid, $remainingSecs);
                if ($watchdog === null) {
                    break; // can't re-arm — don't enter another unbounded read
                }
            } elseif ($type === 'done') {
                $done = $msg;
                break;
            }
        }

        $this->stopWatchdog($watchdog);
        $this->cleanup($proc, $pipes);

        if ($done === null) {
            // fgets hit EOF without a "done" — watchdog kill or crash.
            return ['error' => 'FormLogic runtime timed out or crashed'];
        }
        return $done;
    }

    /**
     * JSON-encode one NDJSON protocol line, tolerant of non-finite floats
     * (INF/NaN from e.g. an over-range HTTP JSON number) so the lockstep channel
     * is never broken by an unencodable value.
     */
    private function encodeLine(array $data): string
    {
        $json = json_encode(
            $data,
            JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE | JSON_PARTIAL_OUTPUT_ON_ERROR
        );
        if ($json === false) {
            $json = json_encode(['error' => 'host reply not encodable']);
        }
        return $json . "\n";
    }

    /**
     * Terminate (if still running) and fully release the child process and its pipes.
     *
     * @param resource $proc
     * @param array<int, resource> $pipes
     */
    private function cleanup($proc, array $pipes): void
    {
        if (is_resource($proc)) {
            $st = proc_get_status($proc);
            if (!empty($st['running'])) {
                proc_terminate($proc);
            }
        }
        foreach ($pipes as $p) {
            if (is_resource($p)) {
                fclose($p);
            }
        }
        if (is_resource($proc)) {
            proc_close($proc);
        }
    }

    /**
     * Spawn a detached watchdog that hard-kills the child process after $secs.
     * Returns an opaque handle (or null) for {@see stopWatchdog}.
     */
    private function spawnWatchdog(int $pid, int $secs): mixed
    {
        if ($pid <= 0) {
            return null;
        }
        $null = PHP_OS_FAMILY === 'Windows' ? 'NUL' : '/dev/null';
        // String command form on purpose: it routes through cmd/sh so the shell
        // operators (`&`, `>`, `;`) are parsed. The array+bypass_shell form mangles
        // them via Windows arg-escaping and the kill never runs.
        if (PHP_OS_FAMILY === 'Windows') {
            // `ping -n` is the portable Windows sleep; then taskkill the tree.
            $cmd = 'ping -n ' . ($secs + 1) . ' 127.0.0.1 >NUL & taskkill /F /T /PID ' . $pid . ' >NUL 2>&1';
        } else {
            $cmd = 'sleep ' . $secs . '; kill -9 ' . $pid . ' 2>/dev/null';
        }
        $spec = [0 => ['pipe', 'r'], 1 => ['file', $null, 'w'], 2 => ['file', $null, 'w']];
        $wd = @proc_open($cmd, $spec, $wpipes);
        if (!is_resource($wd)) {
            return null;
        }
        if (isset($wpipes[0]) && is_resource($wpipes[0])) {
            fclose($wpipes[0]);
        }
        return $wd;
    }

    /**
     * Cancel a watchdog (used when the guest finished within budget).
     */
    private function stopWatchdog(mixed $watchdog): void
    {
        if (!is_resource($watchdog)) {
            return;
        }
        $st = proc_get_status($watchdog);
        if (!empty($st['running'])) {
            proc_terminate($watchdog);
        }
        proc_close($watchdog);
    }

    /**
     * Invoke the host handler for a ctx.* call and shape the reply line.
     *
     * @return array{value?: mixed, error?: string}
     */
    private function dispatchHostCall(?callable $hostHandler, array $msg): array
    {
        if ($hostHandler === null) {
            return ['error' => 'host calls are not allowed here'];
        }
        $module = (string) ($msg['module'] ?? '');
        $method = (string) ($msg['method'] ?? '');
        $args = is_array($msg['args'] ?? null) ? $msg['args'] : [];
        try {
            return ['value' => $hostHandler($module, $method, $args)];
        } catch (\Throwable $e) {
            return ['error' => $e->getMessage()];
        }
    }
}

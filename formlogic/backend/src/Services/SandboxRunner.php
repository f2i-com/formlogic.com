<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * Runs FormLogic user code inside the zipp sandbox, via the `formlogic-runtime`
 * child in bin/runtime (built from the source of the ZIPP release the installed
 * Softn release names, by CI or scripts/build-runtime.sh; no Node runtime
 * required). The browser evaluates form logic with that same ZIPP release
 * (ui/vendor/zipp-wasm) and loads the same prelude; the shared expression corpus
 * (docs/contracts/formlogic-expression-corpus.json) is asserted on both sides, so
 * a divergence between the two shows up as a failing test.
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
 * EXTERNAL watchdog process (retained-handle helper on Windows / sleep+kill on POSIX, see
 * spawnWatchdog) when a single compute window overruns the CPU budget; that
 * closes the pipes and unblocks fgets. proc_terminate() in run() is only a
 * post-loop cleanup fallback. Windows proc_open pipes don't support non-blocking
 * reads, stream_select or stream_set_timeout, which is why this design is used.
 * The watchdog is paused around host calls so handler latency (e.g. a slow HTTP
 * request, bounded separately) doesn't count against the guest's compute budget.
 */
class SandboxRunner
{
    /**
     * Longest protocol line read from the child. A `done` frame carries at most the guest's
     * 4 MiB output limit plus its JSON, and a host-call frame its arguments; a longer line is
     * refused while it is being read, not read into memory whole first.
     */
    private const MAX_LINE_BYTES = 16 * 1024 * 1024;

    /** How much of the end of the child's stderr the error log is given. */
    private const STDERR_TAIL_BYTES = 2048;

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
        // FORMLOGIC_QJS_BIN is still honoured: it was set in existing deployments
        // and its job (point at a runtime somewhere else) has not changed.
        // FORMLOGIC_RUNTIME_BIN is the name that matches what it now points at;
        // both are described in .env.example.
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
        if (!function_exists('proc_open')) {
            return false;
        }
        if (!is_file($this->binary) || !is_file($this->prelude)) {
            return false;
        }
        // A shell wrapper introduces descendants that this exact-process watchdog
        // does not own. Windows overrides must be direct native launcher builds.
        if (PHP_OS_FAMILY === 'Windows' && preg_match('/\.(?:bat|cmd)\z/i', $this->binary)) {
            return false;
        }
        // Present is not the same as runnable. Zip extraction and `git clone` on
        // a box with core.filemode=false both hand out the Linux launcher without
        // its execute bit; proc_open then starts a child that dies at exec, and
        // every evaluation reports "failed to start" while a presence-only check
        // keeps the health endpoint green. Windows has no execute bit to lose.
        return PHP_OS_FAMILY === 'Windows'
            ? $this->windowsWatchdogCommand() !== null
            : is_executable($this->binary);
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

        // The callers fail OPEN by design (a condition that cannot be evaluated is
        // treated as visible; a calculated field is skipped) and they never see
        // this error string. That is a deliberate posture for the respondent; it
        // must not also be silence for the operator. A dead or mis-deployed
        // runtime used to produce a fully visible, fully submittable form and
        // not one log line anywhere.
        if (isset($done['error']) && is_string($done['error'])) {
            error_log(sprintf(
                'FormLogic sandbox: eval batch of %d expression(s) failed: %s',
                count($jobs),
                $done['error']
            ));
        }

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

        // Serialization can invoke application JsonSerializable code. Refuse a
        // throwing input before acquiring a runtime, helper or temporary file.
        try {
            $payloadLine = $this->encodeLine($payload);
        } catch (\Throwable) {
            return ['error' => 'FormLogic runtime input could not be encoded'];
        }

        $cmd = $this->command();

        // stderr goes to a file, not a pipe: the loop below reads only stdout (Windows pipes
        // allow no select), so a child that filled a stderr pipe would stall there until the
        // watchdog killed it. The file's tail explains a run that ends without a result (to
        // the operator, in the error log).
        $stderrFile = tempnam(sys_get_temp_dir(), 'flsbx');
        $descriptors = [
            0 => ['pipe', 'r'],
            1 => ['pipe', 'w'],
            2 => ['file', $stderrFile !== false ? $stderrFile : (PHP_OS_FAMILY === 'Windows' ? 'NUL' : '/dev/null'), 'w'],
        ];

        $proc = @proc_open($cmd, $descriptors, $pipes, null, null, ['bypass_shell' => true]);
        if (!is_resource($proc)) {
            if ($stderrFile !== false) {
                @unlink($stderrFile);
            }
            return ['error' => 'Failed to start FormLogic runtime'];
        }

        $watchdog = null;
        $done = null;
        $failure = null;
        try {
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
            if ($watchdog === null || !$this->watchdogAlive($watchdog)) {
                $failure = 'FormLogic runtime watchdog could not be started';
            } else {
                // Send the job (single line of JSON).
                @fwrite($pipes[0], $payloadLine);
                @fflush($pipes[0]);
                $windowStart = microtime(true);

                while (($line = $this->readLine($pipes[1])) !== null) {
                    if ($line === false) {
                        $failure = 'FormLogic runtime sent a protocol line over ' . (self::MAX_LINE_BYTES >> 20) . ' MiB';
                        break; // cleanup() kills the guest
                    }
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
                        if (!$this->pauseWatchdog($watchdog)) {
                            $failure = 'FormLogic runtime watchdog could not be paused';
                            break;
                        }
                        if ((proc_get_status($proc)['running'] ?? null) !== true) {
                            break;
                        }
                        $reply = $this->dispatchHostCall($hostHandler, $msg);
                        // A host result may run JsonSerializable code too. Keep its
                        // serialization inside the paused host window, before rearming.
                        try {
                            $replyLine = $this->encodeLine($reply);
                        } catch (\Throwable) {
                            $failure = 'FormLogic runtime host reply could not be encoded';
                            break;
                        }
                        // Keep the guest waiting while its remaining compute window is armed.
                        $st = proc_get_status($proc);
                        if (empty($st['running'])) {
                            break;
                        }
                        $remainingSecs = max(1, (int) ceil($budgetSecs - $consumedSecs));
                        if (!$this->resumeWatchdog($watchdog, $pid, $remainingSecs)) {
                            $failure = 'FormLogic runtime watchdog could not be armed';
                            break;
                        }
                        $windowStart = microtime(true);
                        if (@fwrite($pipes[0], $replyLine) === false) {
                            break;
                        }
                        @fflush($pipes[0]);
                    } elseif ($type === 'done') {
                        $done = $msg;
                        break;
                    }
                }
            }
        } catch (\Throwable) {
            // Never expose exception text from protocol or application objects.
            $failure = 'FormLogic runtime communication failed';
            $done = null;
        } finally {
            // Every acquired runtime reaches the same bounded cancellation/join,
            // including exceptions during payload delivery or reply processing.
            if (!$this->finish($watchdog, $proc, $pipes)) {
                $failure = 'FormLogic runtime cleanup could not be confirmed';
                $done = null; // never return success after an unconfirmed cleanup
            }
            $stderr = $stderrFile !== false ? $this->stderrTail($stderrFile) : '';
            if ($stderrFile !== false) {
                @unlink($stderrFile);
            }
        }

        if ($done === null) {
            // EOF without a "done" — watchdog kill or crash — or a line over the cap.
            $message = $failure ?? 'FormLogic runtime timed out or crashed';
            // What the child wrote to stderr is the operator's account of why, so it goes to
            // the error log and not into the returned error: for an onSubmit script that error
            // is shown to the form's owner (ScriptRejection's detail), and a launcher's stderr
            // names install paths and library versions.
            if ($stderr !== '') {
                error_log('FormLogic sandbox: ' . $message . '; the runtime wrote to stderr: ' . $stderr);
            }
            return ['error' => $message];
        }
        return $done;
    }

    /** Direct argv, also allowing child-protocol tests to use a native fixture executable. */
    protected function command(): array
    {
        return [$this->binary, '--prelude', $this->prelude,
            '--heap-mb', (string) max(1, intdiv($this->memoryLimitKb, 1024))];
    }

    /**
     * One protocol line from the child, read in pieces so that a line over MAX_LINE_BYTES is
     * refused without being held whole. Null at the end of the stream; false for a line over
     * the cap.
     *
     * @param resource $pipe
     */
    private function readLine($pipe): string|false|null
    {
        $line = '';
        while (($piece = fgets($pipe, 65536)) !== false) {
            $line .= $piece;
            if (str_ends_with($piece, "\n")) {
                return $line;
            }
            if (strlen($line) > self::MAX_LINE_BYTES) {
                return false;
            }
        }
        return $line === '' ? null : $line;
    }

    /** The end of what the child wrote to stderr, on one line of printable ASCII. */
    private function stderrTail(string $path): string
    {
        $size = @filesize($path);
        if (!is_int($size) || $size === 0) {
            return '';
        }
        $fh = @fopen($path, 'rb');
        if ($fh === false) {
            return '';
        }
        if ($size > self::STDERR_TAIL_BYTES) {
            fseek($fh, -self::STDERR_TAIL_BYTES, SEEK_END);
        }
        $tail = (string) fread($fh, self::STDERR_TAIL_BYTES);
        fclose($fh);
        return trim((string) preg_replace('/[^\x20-\x7E]+/', ' ', $tail));
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
     * @param-out resource|null $proc
     * @param array<int, resource> $pipes
     */
    private function cleanup(&$proc, array $pipes): bool
    {
        if (is_resource($proc)) {
            $st = proc_get_status($proc);
            if (($st['running'] ?? null) !== false) {
                @proc_terminate($proc);
            }
        }
        foreach ($pipes as $p) {
            if (is_resource($p)) {
                fclose($p);
            }
        }
        if (is_resource($proc)) {
            if (PHP_OS_FAMILY === 'Windows' && !$this->waitForExit($proc, 2000)) {
                // Resource GC closes the stored Windows handle without waiting.
                // Explicit proc_close would wait indefinitely for a live process.
                $proc = null;
                return false;
            }
            proc_close($proc);
            $proc = null;
        }
        return true;
    }

    /** Cancel/join before releasing the runtime; a failed join never becomes success. */
    private function finish(mixed &$watchdog, mixed &$proc, array $pipes): bool
    {
        $joined = $this->stopWatchdog($watchdog);
        $runtimeExited = $this->cleanup($proc, $pipes);
        if (!$joined && is_array($watchdog)) {
            // A helper that remains alive can only own its retained original target.
            // Killing/closing PHP's original target cannot retarget that handle.
            $helper = $watchdog['process'];
            if ($runtimeExited && is_resource($helper)) {
                // Never remove the owner-loss guard while its target may still live.
                @proc_terminate($helper);
                if ($this->waitForExit($helper, 250)) {
                    proc_close($helper);
                    $this->removeWatchdogFiles($watchdog);
                }
            }
            $watchdog = null; // no explicit blocking close on an unconfirmed helper
        }
        return $joined && $runtimeExited;
    }

    private function waitForExit(mixed $process, int $milliseconds): bool
    {
        $until = hrtime(true) + $milliseconds * 1_000_000;
        do {
            $status = proc_get_status($process);
            if (($status['running'] ?? null) === false) { return true; }
            usleep(10_000);
        } while (hrtime(true) < $until);
        return false;
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
        if (PHP_OS_FAMILY === 'Windows') {
            return $this->spawnWindowsWatchdog($pid, $secs);
        }
        $cmd = 'sleep ' . $secs . '; kill -9 ' . $pid . ' 2>/dev/null';
        $spec = [0 => ['pipe', 'r'], 1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']];
        $wd = @proc_open($cmd, $spec, $wpipes);
        if (!is_resource($wd)) {
            return null;
        }
        if (isset($wpipes[0]) && is_resource($wpipes[0])) {
            fclose($wpipes[0]);
        }
        return $wd;
    }

    /** @return list<string>|null Side-effect-free prerequisite check; policy is checked at startup. */
    private function windowsWatchdogCommand(): ?array
    {
        $systemRoot = getenv('SystemRoot') ?: getenv('WINDIR');
        if (!is_string($systemRoot) || !preg_match('/\A[A-Za-z]:[\\\\\/]/D', $systemRoot)) { return null; }
        $powershell = rtrim($systemRoot, '/\\') . '/System32/WindowsPowerShell/v1.0/powershell.exe';
        $helper = __DIR__ . '/windows-watchdog.ps1';
        if (!is_file($powershell) || !is_file($helper)) { return null; }
        return [$powershell, '-NoLogo', '-NoProfile', '-NonInteractive', '-File', $helper];
    }

    private function spawnWindowsWatchdog(int $pid, int $secs): mixed
    {
        $cmd = $this->windowsWatchdogCommand();
        if ($cmd === null || $secs < 1) { return null; }
        $marker = tempnam(sys_get_temp_dir(), 'flwd');
        if ($marker === false) { return null; }
        $directory = $marker . '.d';
        if (!@mkdir($directory, 0700)) { @unlink($marker); return null; }
        $ack = $directory . '/ack';
        // This challenge travels only over the exact helper's stdin. A fixed PID
        // or sequence marker in temp storage is not proof that helper acquired it.
        try { $nonce = bin2hex(random_bytes(32)); }
        catch (\Throwable) { @rmdir($directory); @unlink($marker); return null; }
        array_push($cmd, '-TargetPid', (string) $pid, '-AckPath', $ack);
        $spec = [0 => ['pipe', 'r'], 1 => ['file', 'NUL', 'w'], 2 => ['file', 'NUL', 'w']];
        $process = @proc_open($cmd, $spec, $pipes, null, null, ['bypass_shell' => true]);
        if (!is_resource($process)) { @rmdir($directory); @unlink($marker); return null; }
        $state = ['process' => $process, 'input' => $pipes[0] ?? null,
            'marker' => $marker, 'directory' => $directory, 'ack' => $ack, 'nonce' => $nonce,
            'pid' => $pid, 'sequence' => 0, 'ready' => false];
        $hello = 'HELLO ' . $nonce . "\n";
        if (is_resource($state['input']) && @fwrite($state['input'], $hello) === strlen($hello)
            && @fflush($state['input'])
            && $this->awaitAcknowledgment($state, '0 READY ' . $pid, 8000)
            && $this->windowsCommand($state, 'ARM ' . $secs, 'ARMED')) {
            $state['ready'] = true;
        }
        // Even failed startup returns the exact owned helper for bounded cleanup.
        return $state;
    }

    private function awaitAcknowledgment(array $watchdog, string $expected, int $milliseconds): bool
    {
        $until = hrtime(true) + $milliseconds * 1_000_000;
        do {
            if ((proc_get_status($watchdog['process'])['running'] ?? null) !== true) { return false; }
            clearstatcache(true, $watchdog['ack']);
            if (is_file($watchdog['ack']) && @file_get_contents($watchdog['ack'], false, null, 0, 128) === $watchdog['nonce'] . ' ' . $expected . "\n") {
                return (proc_get_status($watchdog['process'])['running'] ?? null) === true;
            }
            usleep(10_000);
        } while (hrtime(true) < $until);
        return false;
    }

    private function windowsCommand(array &$watchdog, string $command, string $ack): bool
    {
        $sequence = ++$watchdog['sequence'];
        $line = $sequence . ' ' . $command . "\n";
        if (!is_resource($watchdog['input']) || @fwrite($watchdog['input'], $line) !== strlen($line)
            || !@fflush($watchdog['input'])) { return false; }
        return $this->awaitAcknowledgment($watchdog, $sequence . ' ' . $ack . ' ' . $watchdog['pid'], 2000);
    }

    private function watchdogAlive(mixed $watchdog): bool
    {
        if (!is_array($watchdog)) { return is_resource($watchdog); }
        return $watchdog['ready'] && (proc_get_status($watchdog['process'])['running'] ?? null) === true;
    }

    private function pauseWatchdog(mixed &$watchdog): bool
    {
        if (is_array($watchdog)) { return $this->windowsCommand($watchdog, 'PAUSE', 'PAUSED'); }
        return $this->stopWatchdog($watchdog);
    }

    private function resumeWatchdog(mixed &$watchdog, int $pid, int $seconds): bool
    {
        if (is_array($watchdog)) {
            return $this->windowsCommand($watchdog, 'ARM ' . $seconds, 'ARMED');
        }
        $watchdog = $this->spawnWatchdog($pid, $seconds);
        return $watchdog !== null && $this->watchdogAlive($watchdog);
    }

    /** Final CANCEL also stops the original target, closing the PHP-owner-death gap. */
    private function stopWatchdog(mixed &$watchdog): bool
    {
        if (is_array($watchdog)) {
            $process = $watchdog['process'];
            if (is_resource($watchdog['input'])) {
                @fwrite($watchdog['input'], (++$watchdog['sequence']) . " CANCEL\n");
                @fflush($watchdog['input']);
                fclose($watchdog['input']);
                $watchdog['input'] = null;
            }
            if (!$this->waitForExit($process, 2000)) { return false; }
            proc_close($process); // observed exit only; no descendant killer exists
            $this->removeWatchdogFiles($watchdog);
            $watchdog = null;
            return true;
        }
        if (!is_resource($watchdog)) { return true; }
        $st = proc_get_status($watchdog);
        if (!empty($st['running'])) { proc_terminate($watchdog); }
        proc_close($watchdog);
        $watchdog = null;
        return true;
    }

    private function removeWatchdogFiles(array $watchdog): void
    {
        @unlink($watchdog['ack']);
        @rmdir($watchdog['directory']);
        @unlink($watchdog['marker']);
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

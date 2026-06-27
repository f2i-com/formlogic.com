<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * Runs FormLogic user code inside the QuickJS sandbox via the vendored static
 * `qjs` binary (no Node runtime required). This is the backend half of the
 * unified QuickJS runtime — the browser runs the SAME engine + the SAME prelude
 * (quickjs-emscripten), so client and server results match by construction.
 *
 * Two modes, both speaking newline-delimited JSON over the qjs process's stdio
 * (see resources/formlogic-harness.js):
 *
 *  - evaluateBatch(): pure field expressions (conditions / calculated fields /
 *    validation). One round-trip, no host callbacks.
 *  - runScript(): a user onSubmit(ctx) script. ctx.db/ctx.http/ctx.utils are
 *    dispatched back to a PHP host handler via synchronous RPC, so all IO and its
 *    SSRF/DNS-pinning guards stay in PHP.
 *
 * IO model: stdout/stderr pipes are non-blocking and polled (works on Windows,
 * where stream_select() does not support process pipes). A CPU-wall deadline
 * hard-kills a wedged/looping process via proc_terminate(); time spent inside a
 * host handler (e.g. a slow HTTP call) is added back so it doesn't count against
 * the guest's CPU budget.
 */
class QuickJsRunner
{
    private string $binary;
    private string $harness;
    private string $prelude;
    private int $memoryLimitKb;
    private int $stackSizeKb;

    public function __construct(
        ?string $binary = null,
        int $memoryLimitKb = 131072, // 128 MiB
        int $stackSizeKb = 1024
    ) {
        $base = dirname(__DIR__, 2); // .../backend
        $this->binary = $binary ?? $this->detectBinary($base);
        $this->harness = $base . '/resources/formlogic-harness.js';
        $this->prelude = $base . '/resources/formlogic-prelude.js';
        $this->memoryLimitKb = $memoryLimitKb;
        $this->stackSizeKb = $stackSizeKb;
    }

    private function detectBinary(string $base): string
    {
        $override = getenv('FORMLOGIC_QJS_BIN') ?: ($_ENV['FORMLOGIC_QJS_BIN'] ?? '');
        if (is_string($override) && $override !== '' && is_file($override)) {
            return $override;
        }
        $dir = $base . '/bin/qjs';
        if (PHP_OS_FAMILY === 'Windows') {
            return $dir . '/qjs-windows-x86_64.exe';
        }
        return $dir . '/qjs-linux-x86_64';
    }

    /**
     * Whether the runtime is installed and usable. Callers should treat a false
     * here the same way they handle an evaluation error (fail-open visibility,
     * skip calculated fields, etc.).
     */
    public function isAvailable(): bool
    {
        return is_file($this->binary) && is_file($this->harness) && is_file($this->prelude);
    }

    /**
     * Evaluate a batch of pure expressions.
     *
     * @param array<int, array{id: string, expression: string, context?: array}> $jobs
     * @return array<string, array{ok: bool, value?: mixed, error?: string}> keyed by job id
     */
    public function evaluateBatch(array $jobs, int $cpuBudgetMs = 1500): array
    {
        $payload = ['mode' => 'eval', 'jobs' => array_values($jobs)];
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
    public function evaluate(string $expression, array $context = [], int $cpuBudgetMs = 1500): array
    {
        $results = $this->evaluateBatch(
            [['id' => '0', 'expression' => $expression, 'context' => (object) $context]],
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
     * @return array  The harness "done" message: {result?, reject?, message?, error?}
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
     * Core process driver. Spawns qjs, writes the job, pumps the NDJSON protocol
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
            '--std',
            '--memory-limit', (string) $this->memoryLimitKb,
            '--stack-size', (string) $this->stackSizeKb,
            $this->harness,
            $this->prelude,
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

        // Windows proc_open pipes don't support non-blocking reads, stream_select,
        // or stream_set_timeout, so we can't poll a deadline while blocked on a
        // read. Instead the protocol is strictly turn-based (qjs writes exactly
        // one line, then blocks reading our reply) so blocking I/O can't deadlock,
        // and an external watchdog process SIGKILLs qjs if a single COMPUTE window
        // overruns $cpuBudgetMs — which closes the pipes and unblocks fgets. The
        // watchdog is paused around host calls so HTTP latency (bounded separately
        // by the handler) doesn't count against the guest's compute budget.
        $cpuSecs = max(1, (int) ceil($cpuBudgetMs / 1000));
        $watchdog = $this->spawnWatchdog($pid, $cpuSecs);

        // Send the job (single line of JSON).
        $jobLine = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        fwrite($pipes[0], $jobLine . "\n");
        fflush($pipes[0]);

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
                $isHttp = ($msg['module'] ?? '') === 'http';
                // HTTP may legitimately take seconds; pause the compute watchdog
                // so it doesn't kill the (idle, waiting) guest mid-request.
                if ($isHttp) {
                    $this->stopWatchdog($watchdog);
                }
                $reply = $this->dispatchHostCall($hostHandler, $msg);
                fwrite($pipes[0], json_encode($reply, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE) . "\n");
                fflush($pipes[0]);
                if ($isHttp) {
                    $watchdog = $this->spawnWatchdog($pid, $cpuSecs);
                }
            } elseif ($type === 'done') {
                $done = $msg;
                break;
            }
        }

        $this->stopWatchdog($watchdog);
        $st = proc_get_status($proc);
        if (!empty($st['running'])) {
            proc_terminate($proc);
        }
        foreach ($pipes as $p) {
            if (is_resource($p)) {
                fclose($p);
            }
        }
        proc_close($proc);

        if ($done === null) {
            // fgets hit EOF without a "done" — watchdog kill or crash.
            return ['error' => 'FormLogic runtime timed out or crashed'];
        }
        return $done;
    }

    /**
     * Spawn a detached watchdog that hard-kills the qjs process after $secs.
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

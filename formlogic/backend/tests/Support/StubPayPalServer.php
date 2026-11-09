<?php

declare(strict_types=1);

namespace FormLogic\Tests\Support;

/**
 * The stand-in for PayPal's REST API (stub-paypal-server.php) under `php -S` for one test class, on
 * the first free port of 8305-8308. Approve an order as its buyer would, and read what it holds.
 */
final class StubPayPalServer
{
    /** @var resource */
    private $process;

    private function __construct(public readonly string $base, public readonly string $state, $process)
    {
        $this->process = $process;
    }

    public static function start(): self
    {
        $state = tempnam(sys_get_temp_dir(), 'stub-paypal-');
        file_put_contents($state, '');
        foreach ([8308, 8307, 8306, 8305] as $port) {
            $probe = @stream_socket_server("tcp://127.0.0.1:{$port}");
            if ($probe === false) continue;
            fclose($probe);
            $nowhere = PHP_OS_FAMILY === 'Windows' ? 'NUL' : '/dev/null';
            $pipes = [];
            $process = proc_open(
                [PHP_BINARY, '-d', 'xdebug.mode=off', '-d', 'variables_order=EGPCS', '-S', "127.0.0.1:{$port}", __DIR__ . '/stub-paypal-server.php'],
                [1 => ['file', $nowhere, 'a'], 2 => ['file', $nowhere, 'a']],
                $pipes,
                __DIR__,
                ['STUB_PAYPAL_STATE' => $state, 'SystemRoot' => (string) getenv('SystemRoot'), 'PATH' => (string) getenv('PATH'), 'TEMP' => sys_get_temp_dir(), 'TMP' => sys_get_temp_dir()],
            );
            if (!is_resource($process)) continue;
            $server = new self("http://127.0.0.1:{$port}", $state, $process);
            for ($i = 0; $i < 100; $i++) {
                if (@file_get_contents($server->base . '/stub/state') !== false) return $server;
                usleep(100_000);
            }
            $server->stop();
        }
        throw new \RuntimeException('The stub PayPal server could not start on 8305-8308');
    }

    /** The buyer approves $orderId in PayPal; capturing it will then be $outcome (completed, pending, declined, lost, mismatch). */
    public function approve(string $orderId, string $outcome = 'completed'): void
    {
        $context = stream_context_create(['http' => ['method' => 'POST', 'header' => "Content-Type: application/json\r\n", 'content' => json_encode(['outcome' => $outcome]), 'ignore_errors' => true]]);
        $answer = file_get_contents($this->base . '/stub/orders/' . rawurlencode($orderId) . '/approve', false, $context);
        if (!is_string($answer) || !str_contains($answer, 'approved')) throw new \RuntimeException('The stub did not approve ' . $orderId . ': ' . $answer);
    }

    public function orders(): array
    {
        $state = json_decode((string) @file_get_contents($this->base . '/stub/state'), true);
        return is_array($state['orders'] ?? null) ? $state['orders'] : [];
    }

    public function stop(): void
    {
        if (is_resource($this->process)) {
            proc_terminate($this->process);
            proc_close($this->process);
        }
        @unlink($this->state);
        @unlink($this->state . '.lock');
    }
}

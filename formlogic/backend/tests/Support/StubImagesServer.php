<?php

declare(strict_types=1);

namespace FormLogic\Tests\Support;

/**
 * The stand-in for OAIY Studio's gateway (stub-images-server.php) running under `php -S` for one test
 * class, on the first free port of 8305-8308. Every request it was sent can be read back.
 */
final class StubImagesServer
{
    /** @var resource */
    private $process;

    private function __construct(public readonly string $base, public readonly string $log, $process)
    {
        $this->process = $process;
    }

    public static function start(): self
    {
        $log = tempnam(sys_get_temp_dir(), 'stub-images-');
        foreach ([8305, 8306, 8307, 8308] as $port) {
            $probe = @stream_socket_server("tcp://127.0.0.1:{$port}");
            if ($probe === false) continue;
            fclose($probe);
            $nowhere = PHP_OS_FAMILY === 'Windows' ? 'NUL' : '/dev/null';
            $pipes = [];
            $process = proc_open(
                [PHP_BINARY, '-d', 'xdebug.mode=off', '-d', 'variables_order=EGPCS', '-S', "127.0.0.1:{$port}", __DIR__ . '/stub-images-server.php'],
                [1 => ['file', $nowhere, 'a'], 2 => ['file', $nowhere, 'a']],
                $pipes,
                __DIR__,
                ['STUB_IMAGES_LOG' => $log, 'SystemRoot' => (string) getenv('SystemRoot'), 'PATH' => (string) getenv('PATH'), 'TEMP' => sys_get_temp_dir(), 'TMP' => sys_get_temp_dir(), 'PHP_CLI_SERVER_WORKERS' => '4'],
            );
            if (!is_resource($process)) continue;
            $server = new self("http://127.0.0.1:{$port}", $log, $process);
            for ($i = 0; $i < 100; $i++) {
                $health = @file_get_contents($server->base . '/health');
                if ($health !== false) return $server;
                usleep(100_000);
            }
            $server->stop();
        }
        throw new \RuntimeException('The stub images server could not start on 8305-8308');
    }

    /** The upstream's base URL, as AI_BASE_URL names it. */
    public function url(): string
    {
        return $this->base . '/v1';
    }

    /** @return list<array{method: string, path: string, headers: array<string, string>, body: array}> */
    public function requests(): array
    {
        $lines = array_filter(explode("\n", (string) @file_get_contents($this->log)));
        return array_values(array_map(static fn(string $line) => json_decode($line, true), $lines));
    }

    public function clear(): void
    {
        file_put_contents($this->log, '');
    }

    public function stop(): void
    {
        if (is_resource($this->process)) {
            proc_terminate($this->process);
            proc_close($this->process);
        }
        @unlink($this->log);
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Tests\Support\SandboxWatchdogFixture;

/** Exercise the Windows branch on every host, without an OS process or filesystem fixture. */
const PHP_OS_FAMILY = 'Windows';

final class State
{
    public const NONCE = 'abababababababababababababababababababababababababababababababab';
    public static array $events = [];
    public static array $resources = [];
    public static array $kinds = [];
    public static array $running = [];
    public static array $commands = [];
    public static array $controlFaults = [];
    public static array $runtimeWrites = [];
    public static array $computeMilliseconds = [];
    public static array $logs = [];
    public static array $statusValues = [];
    public static string $startupFault = '';
    public static string $ack = '';
    public static string $activeFault = '';
    public static bool $cancelIgnored = false;
    public static bool $runtimeTerminationFails = false;
    public static bool $helperTerminationFails = false;
    public static bool $authorized = false;
    public static bool $computing = false;
    public static bool $runtimeExitsWhenPaused = false;
    public static bool $readThrows = false;
    public static int $nanoseconds = 0;
    public static int $sequence = 0;
    public static int $reads = 0;
    public static int $helperStatusChecksLeft = -1;
    public static string $protocol = '';

    public static function load(): void
    {
        if (class_exists(__NAMESPACE__ . '\\SandboxRunner', false)) {
            return;
        }
        $source = \file_get_contents(__DIR__ . '/../../src/Services/SandboxRunner.php');
        if (!is_string($source) || !str_starts_with($source, '<?php')) {
            throw new \LogicException('Cannot read canonical SandboxRunner source');
        }
        $source = str_replace('namespace FormLogic\\Services;', 'namespace ' . __NAMESPACE__ . ';', $source, $count);
        if ($count !== 1) {
            throw new \LogicException('Expected exactly one production namespace declaration');
        }
        // Only the namespace changes. All production methods execute unchanged;
        // their unqualified process/time/file calls resolve to the inert functions below.
        eval(substr($source, 5));
    }

    public static function reset(int $calls = 0): void
    {
        self::release();
        self::$events = self::$resources = self::$kinds = self::$running = self::$commands = [];
        self::$controlFaults = self::$runtimeWrites = self::$computeMilliseconds = self::$logs = self::$statusValues = [];
        self::$startupFault = self::$ack = self::$activeFault = '';
        self::$cancelIgnored = self::$runtimeTerminationFails = self::$helperTerminationFails = self::$authorized = false;
        self::$computing = self::$runtimeExitsWhenPaused = self::$readThrows = false;
        self::$nanoseconds = self::$sequence = self::$reads = 0;
        self::$helperStatusChecksLeft = -1;
        self::$protocol = str_repeat("{\"type\":\"call\",\"module\":\"utils\",\"method\":\"fixture\",\"args\":[]}\n", $calls)
            . "{\"type\":\"done\",\"result\":42,\"results\":[{\"id\":\"0\",\"ok\":true,\"value\":42}]}\n";
    }

    public static function release(): void
    {
        foreach (self::$resources as $resource) {
            if (\is_resource($resource)) { \fclose($resource); }
        }
    }

    public static function memory(string $kind)
    {
        $resource = \fopen('php://memory', 'w+');
        if ($resource === false) { throw new \LogicException('Memory stream unavailable'); }
        self::$resources[] = $resource;
        self::$kinds[(int) $resource] = $kind;
        return $resource;
    }

    public static function kind($resource): string
    {
        return self::$kinds[(int) $resource] ?? throw new \LogicException('Unowned fixture resource');
    }

    public static function advance(int $milliseconds): void
    {
        self::$nanoseconds += $milliseconds * 1_000_000;
    }

    public static function prohibit(string $operation): never
    {
        throw new \LogicException('Unexpected real I/O boundary: ' . $operation);
    }
}

function function_exists(string $name): bool
{
    return !($name === 'proc_open' && State::$startupFault === 'process-launch-disabled') && \function_exists($name);
}

function getenv(string $name): string|false
{
    if (State::$startupFault === 'system-root-relative') { return 'relative-windows'; }
    return in_array($name, ['SystemRoot', 'WINDIR'], true) && State::$startupFault !== 'system-root'
        ? 'C:/inert-windows' : false;
}
function sys_get_temp_dir(): string { return 'C:/inert-memory-only'; }
function is_file(string $path): bool
{
    if (str_ends_with($path, '/ack')) { return State::$ack !== ''; }
    if (State::$startupFault === 'helper-missing' && str_ends_with($path, 'windows-watchdog.ps1')) { return false; }
    if (State::$startupFault === 'powershell-missing' && str_ends_with($path, '/powershell.exe')) { return false; }
    return true;
}
function is_executable(string $path): bool { return true; }
function tempnam(string $directory, string $prefix): string|false
{
    State::$events[] = 'temp:' . $prefix;
    return $prefix === 'flwd' && State::$startupFault === 'marker-failed' ? false : 'C:/inert-memory-only/' . $prefix;
}
function unlink(string $path): bool { State::$events[] = 'unlink:' . basename($path); return true; }
function mkdir(string $path, int $permissions = 0777, bool $recursive = false): bool
{
    State::$events[] = 'mkdir:' . $permissions;
    return State::$startupFault !== 'directory-failed';
}
function rmdir(string $path): bool { State::$events[] = 'rmdir'; return true; }
function random_bytes(int $length): string
{
    if (State::$startupFault === 'entropy-failed') { throw new \RuntimeException('fixture entropy failure'); }
    return str_repeat("\xab", $length);
}
function clearstatcache(bool $all = false, string $path = ''): void {}
function filesize(string $path): int { return 0; }
function file_get_contents(string $path, mixed ...$arguments): string
{
    if (!str_ends_with($path, '/ack')) { State::prohibit('file_get_contents'); }
    State::$events[] = 'ack:' . trim(str_replace(State::NONCE . ' ', '', State::$ack));
    if (State::$runtimeExitsWhenPaused && str_contains(State::$ack, ' PAUSED ')) { State::$running['runtime'] = false; }
    if (State::$activeFault === 'exit-after-ack') { State::$helperStatusChecksLeft = 0; }
    if (State::$activeFault === 'exit-before-payload') { State::$helperStatusChecksLeft = 1; }
    return State::$ack;
}
function hrtime(bool $asNumber = false): int { return State::$nanoseconds; }
function microtime(bool $asFloat = false): float { return State::$nanoseconds / 1_000_000_000; }
function usleep(int $microseconds): void { State::$nanoseconds += $microseconds * 1000; }
function sleep(int $seconds): int { State::advance($seconds * 1000); return 0; }
function error_log(string $message, mixed ...$arguments): bool { State::$logs[] = $message; return true; }

function proc_open(mixed $command, array $descriptors, &$pipes, mixed $cwd = null, mixed $environment = null, array $options = [])
{
    if (!is_array($command) || ($options['bypass_shell'] ?? false) !== true) {
        throw new \LogicException('A watchdog command attempted shell execution');
    }
    $kind = str_ends_with($command[0], '/powershell.exe') ? 'helper' : 'runtime';
    State::$events[] = 'open:' . $kind;
    State::$commands[] = ['kind' => $kind, 'argv' => $command, 'options' => $options];
    if (State::$startupFault === $kind . '-open') { return false; }
    $resource = State::memory($kind);
    State::$running[$kind] = true;
    $pipes = [State::memory($kind . '-stdin')];
    if ($kind === 'runtime') {
        $pipes[1] = State::memory('runtime-stdout');
        \fwrite($pipes[1], State::$protocol);
        \rewind($pipes[1]);
    } else {
        State::$ack = '';
        if (State::$startupFault === 'helper-exited') { State::$running['helper'] = false; }
    }
    return $resource;
}

function proc_get_status($resource): array
{
    $kind = State::kind($resource);
    if (array_key_exists($kind, State::$statusValues)) {
        State::$events[] = 'status:' . $kind . ':injected';
        return State::$statusValues[$kind] === 'missing' ? [] : ['running' => State::$statusValues[$kind]];
    }
    if ($kind === 'helper' && State::$helperStatusChecksLeft >= 0) {
        if (State::$helperStatusChecksLeft-- === 0) { State::$running['helper'] = false; }
    }
    $running = State::$running[$kind];
    State::$events[] = 'status:' . $kind . ':' . ($running ? 'running' : 'exited');
    return ['running' => $running, 'pid' => $kind === 'runtime' ? 31337 : 31338];
}

function proc_terminate($resource, int $signal = 15): bool
{
    $kind = State::kind($resource);
    State::$events[] = 'terminate:' . $kind;
    if (($kind === 'runtime' && State::$runtimeTerminationFails) || ($kind === 'helper' && State::$helperTerminationFails)) {
        return false;
    }
    State::$running[$kind] = false;
    return true;
}

function proc_close($resource): int
{
    $kind = State::kind($resource);
    if (State::$running[$kind]) { throw new \LogicException('Explicit close of live ' . $kind); }
    State::$events[] = 'close:' . $kind;
    \fclose($resource);
    return 0;
}

function fwrite($resource, string $data, ?int $length = null): int|false
{
    $kind = State::kind($resource);
    if ($kind === 'runtime-stdin') {
        State::$events[] = 'runtime-write:' . count(State::$runtimeWrites);
        State::$runtimeWrites[] = $data;
        return \fwrite($resource, $data);
    }
    if ($kind !== 'helper-stdin') { State::prohibit('fwrite'); }
    State::$events[] = 'control:' . trim($data);
    if (!(State::$running['helper'] ?? false)) { return false; }
    if ($data === 'HELLO ' . State::NONCE . "\n") {
        State::$activeFault = State::$startupFault === 'hello-flush' ? 'flush-failed' : '';
        if (State::$startupFault === 'hello-partial') { return strlen($data) - 1; }
        State::$ack = match (State::$startupFault) {
            'ready-missing' => '',
            'ready-malformed' => "PRIVATE-CANARY\n",
            'ready-wrong-pid' => State::NONCE . " 0 READY 999\n",
            'ready-partial' => State::NONCE . ' 0 READY 31337',
            'ready-forged-fixed' => "0 READY 31337\n",
            'ready-wrong-nonce' => str_repeat('c', 64) . " 0 READY 31337\n",
            default => State::NONCE . " 0 READY 31337\n",
        };
        return \fwrite($resource, $data);
    }
    if (!preg_match('/\A([1-9][0-9]*) (ARM ([1-9][0-9]*)|PAUSE|CANCEL)\n\z/', $data, $match)) {
        throw new \LogicException('Malformed control emitted by production code');
    }
    $sequence = (int) $match[1];
    if ($sequence !== State::$sequence + 1) { throw new \LogicException('Control sequence must increase by exactly one'); }
    State::$sequence = $sequence;
    State::$activeFault = State::$controlFaults[$sequence] ?? '';
    if (State::$activeFault === 'write-zero') { return 0; }
    if (State::$activeFault === 'write-partial') { return strlen($data) - 1; }
    if ($match[2] === 'CANCEL') {
        if (!State::$cancelIgnored) {
            if (State::$authorized) {
                State::$events[] = 'cancel:target-exited';
                State::$running['runtime'] = false;
            }
            State::$running['helper'] = false;
        }
    } else {
        $ack = str_starts_with($match[2], 'ARM ') ? 'ARMED' : 'PAUSED';
        if (($ack === 'ARMED') === State::$computing) { throw new \LogicException('Control violates computing/paused transition'); }
        State::$computing = $ack === 'ARMED';
        if ($ack === 'ARMED') { State::$authorized = true; }
        State::$ack = match (State::$activeFault) {
            'ack-missing' => '',
            'ack-stale' => State::NONCE . ' ' . ($sequence - 1) . ' ' . $ack . " 31337\n",
            'ack-wrong-pid' => State::NONCE . ' ' . $sequence . ' ' . $ack . " 999\n",
            'ack-malformed' => "PRIVATE-CANARY\n",
            'ack-partial' => State::NONCE . ' ' . $sequence . ' ' . $ack . ' 31337',
            'ack-forged-fixed' => $sequence . ' ' . $ack . " 31337\n",
            'ack-wrong-nonce' => str_repeat('c', 64) . ' ' . $sequence . ' ' . $ack . " 31337\n",
            default => State::NONCE . ' ' . $sequence . ' ' . $ack . " 31337\n",
        };
        if (State::$activeFault === 'exit-before-ack') { State::$running['helper'] = false; }
    }
    return \fwrite($resource, $data);
}

function fflush($resource): bool
{
    $kind = State::kind($resource);
    State::$events[] = 'flush:' . $kind;
    return $kind !== 'helper-stdin' || State::$activeFault !== 'flush-failed';
}

function fgets($resource, ?int $length = null): string|false
{
    if (State::kind($resource) !== 'runtime-stdout') { State::prohibit('fgets'); }
    if (State::$readThrows) {
        State::$events[] = 'read:exception';
        throw new \RuntimeException('PRIVATE-CANARY protocol failure');
    }
    State::advance(State::$computeMilliseconds[State::$reads++] ?? 0);
    return $length === null ? \fgets($resource) : \fgets($resource, $length);
}

function fclose($resource): bool
{
    State::$events[] = 'close-pipe:' . State::kind($resource);
    return \fclose($resource);
}

// These guards ensure a future production refactor cannot silently introduce real I/O.
function file_put_contents(mixed ...$arguments): never { State::prohibit('file_put_contents'); }
function fopen(mixed ...$arguments): never { State::prohibit('fopen'); }
function rename(mixed ...$arguments): never { State::prohibit('rename'); }
function shell_exec(mixed ...$arguments): never { State::prohibit('shell_exec'); }
function exec(mixed ...$arguments): never { State::prohibit('exec'); }
function system(mixed ...$arguments): never { State::prohibit('system'); }
function passthru(mixed ...$arguments): never { State::prohibit('passthru'); }
function popen(mixed ...$arguments): never { State::prohibit('popen'); }

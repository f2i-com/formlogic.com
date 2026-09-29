<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * error_log() for a warning that would otherwise repeat on every request for as long as a fault
 * lasts: a given message is written at most once per window, so a public, unauthenticated route
 * cannot grow the PHP error log at the rate it is hit, and an operator reads one line, not thousands.
 *
 * PHP keeps nothing from one request to the next (not even a static property, under php-fpm or
 * Apache), so what remembers is a marker file per distinct message, in the system temp folder by
 * default: its modification time is when the message was last written, and every worker shares it.
 * The file name is a hash, so no part of a message is ever in it. A message that differs, such as
 * the next thing to go wrong, is a different marker and is written at once.
 *
 * Losing a warning is worse than repeating one, so anything that stops it remembering (a folder it
 * cannot write to) makes it write every occurrence, and a marker dated in the future, after the
 * clock was set back, never silences a message.
 */
final class ThrottledLog
{
    public const MARKER_PREFIX = 'formlogic-throttled-log-';
    public const DEFAULT_WINDOW_SECONDS = 60;

    /** @var \Closure(string): void */
    private readonly \Closure $sink;
    /** @var \Closure(): int */
    private readonly \Closure $clock;

    /**
     * @param string $directory where the markers live
     * @param (callable(string): void)|null $sink what writes a message; error_log() by default
     * @param (callable(): int)|null $clock Unix time; the real one by default
     */
    public function __construct(
        private readonly string $directory,
        private readonly int $windowSeconds = self::DEFAULT_WINDOW_SECONDS,
        ?callable $sink = null,
        ?callable $clock = null,
    ) {
        $this->sink = $sink !== null
            ? \Closure::fromCallable($sink)
            : static function (string $message): void {
                error_log($message);
            };
        $this->clock = $clock !== null
            ? \Closure::fromCallable($clock)
            : static fn (): int => time();
    }

    /** The PHP error log, throttled per message, remembering in the system temp folder. */
    public static function forErrorLog(int $windowSeconds = self::DEFAULT_WINDOW_SECONDS): self
    {
        return new self(sys_get_temp_dir(), $windowSeconds);
    }

    public function __invoke(string $message): void
    {
        if ($this->due($message)) {
            ($this->sink)($message);
        }
    }

    private function due(string $message): bool
    {
        $marker = rtrim($this->directory, '/\\') . DIRECTORY_SEPARATOR . self::MARKER_PREFIX . sha1($message);
        $now = ($this->clock)();
        clearstatcache(true, $marker);
        $last = @filemtime($marker);
        if ($last !== false) {
            $age = $now - $last;
            if ($age >= 0 && $age < $this->windowSeconds) {
                return false;
            }
        }
        // Two workers can both find the marker stale and both write: one duplicate a window, at worst.
        @touch($marker, $now);
        return true;
    }
}

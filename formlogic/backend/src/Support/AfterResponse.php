<?php

declare(strict_types=1);

namespace FormLogic\Support;

/**
 * Work a request sets off that the person who made it should not wait for, above all mail. A job
 * runs in the same process once they have their whole answer, so it needs no worker and no cron,
 * which a shared host may not have. A job catches its own failures: there is nobody left to tell.
 *
 * How the answer ends depends on the server:
 *   - PHP-FPM and LiteSpeed have a call that ends it (finish());
 *   - anywhere else (mod_php, php -S) it ends when the client has read Content-Length bytes,
 *     so AfterResponseMiddleware states the length, closes the connection and stops mod_deflate
 *     holding the answer back.
 * Plain FastCGI (mod_fcgid) has neither, and holds a short answer until PHP exits, so there the
 * client waits for the jobs: nothing is lost, but it is what the jobs are here to avoid, and Doctor
 * says so (LIMITATION).
 *
 * Without a call that ends it, the connection stays open while PHP runs, even once the client has
 * every byte, so anyone timing the close sees how long the jobs took (runWithFloor).
 */
final class AfterResponse
{
    /** What Doctor says on a server that holds the answer until the jobs are done. */
    public const LIMITATION = 'PHP runs here as plain FastCGI, which can\'t end an answer early: a visitor waits while mail is sent, up to several seconds if the mail server is down, and every forgot-password request takes at least 2 seconds, longer if the mail server is slower than that, which shows that the address has an account. PHP-FPM or LiteSpeed don\'t have this.';

    /** What Doctor says under mod_php, where the visitor doesn't wait but the connection does. */
    public const LIMITATION_MOD_PHP = 'PHP runs here as mod_php, which can\'t close a connection until the work after an answer is done. Visitors have their answer at once, but someone timing the close of a forgot-password request can tell an address with an account from one without if the mail server takes more than 2 seconds or is down. PHP-FPM doesn\'t have this.';

    /** Long enough to cover a healthy mail server: 0.8 s at 100 ms a step, measured. */
    public const FLOOR_SECONDS = 2.0;

    /** A mail is a few seconds at worst (EmailService::SMTP_TIMEOUT_SECONDS for each step). */
    private const SECONDS_PER_JOB = 60;

    /** @var list<callable(): void> */
    private static array $jobs = [];

    /** On the command line nobody is waiting for an answer, so the job runs now. */
    public static function run(callable $job): void
    {
        if (PHP_SAPI === 'cli') {
            $job();
            return;
        }
        if (self::$jobs === []) {
            register_shutdown_function([self::class, 'runJobs']);
        }
        self::$jobs[] = $job;
    }

    /**
     * A job whose length would say something private. Where the server can't end the answer, it
     * takes FLOOR_SECONDS at least, whatever it did, so the close comes at the same time on every
     * path. That costs the worker those seconds, and a job slower than the floor still shows.
     */
    public static function runWithFloor(callable $job): void
    {
        if (PHP_SAPI === 'cli' || self::serverCanFinish()) {
            self::run($job);
            return;
        }
        self::run(static function () use ($job): void {
            $until = microtime(true) + self::FLOOR_SECONDS;
            try {
                $job();
            } finally {
                $left = $until - microtime(true);
                if ($left > 0 && function_exists('usleep')) {
                    usleep((int) ($left * 1_000_000));
                }
            }
        });
    }

    public static function pending(): bool
    {
        return self::$jobs !== [];
    }

    /** True where a call ends the answer, so it needs none of the middleware's headers. */
    public static function serverCanFinish(): bool
    {
        return function_exists('fastcgi_finish_request') || function_exists('litespeed_finish_request');
    }

    /** Doctor's warning for this server, or null. */
    public static function limitation(string $sapi = PHP_SAPI): ?string
    {
        if (self::serverCanFinish()) {
            return null;
        }
        return match ($sapi) {
            'cgi-fcgi' => self::LIMITATION,
            'apache2handler' => self::LIMITATION_MOD_PHP,
            default => null,
        };
    }

    /** @internal registered as a shutdown function; public for that reason only */
    public static function runJobs(): void
    {
        // The client is free to go now, and a flush to a closed connection would end this script.
        // Shared hosts disable functions like these, and a disabled function is an Error here.
        if (function_exists('ignore_user_abort')) {
            ignore_user_abort(true);
        }
        self::finish();
        foreach (self::$jobs as $job) {
            if (function_exists('set_time_limit')) {
                @set_time_limit(self::SECONDS_PER_JOB);
            }
            try {
                $job();
            } catch (\Throwable $e) {
                error_log('Work after the response failed: ' . $e->getMessage());
            }
        }
        self::$jobs = [];
    }

    private static function finish(): void
    {
        if (function_exists('fastcgi_finish_request')) {
            fastcgi_finish_request();
            return;
        }
        if (function_exists('litespeed_finish_request')) {
            litespeed_finish_request();
            return;
        }
        while (ob_get_level() > 0) {
            @ob_end_flush();
        }
        flush();
    }
}

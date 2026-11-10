<?php
declare(strict_types=1);

// A web request never runs this. The folder can be reachable on a server without the bundle's
// rewrites, and a visit would run it with the site's credentials.
if (isset($_SERVER['REQUEST_METHOD'])) {
    http_response_code(404);
    exit;
}

// App AI's worker (AppAiWorker): sends apps' AI jobs to the site's or the owner's OAIY, or the .env
// upstream, and delivers what comes back. Run it every minute from cron (each run works for about 55
// seconds, and finishes what it started), or under a process supervisor with --watch:
//
//   * * * * * cd /path/to/api && php bin/app-ai-worker.php
//   php bin/app-ai-worker.php --watch
//
// --budget=<seconds> changes how long one run takes new work (default 55). One worker runs at a time:
// a run that finds another working exits at once.
//
// A worker keeps the code it started with, so it never outlives an update: before every pass it reads
// the code on disk again, and when FormLogic was updated it finishes what it has in hand, says so, and
// exits with status 75 (AppAiWorkerLoop). A cron run is fresh every minute. --watch belongs under a
// supervisor that starts it again whenever it exits (systemd Restart=always, supervisord
// autorestart=true): started by hand, it stops at the first update and nothing takes its place, and
// Admin → Platform → AI for apps says the worker is not running.
if (PHP_SAPI !== 'cli') exit;
require __DIR__ . '/../vendor/autoload.php';
// The code as this process loads it. An update writes its files over a moment, and a supervisor
// starts this again at once: wait until the code has stopped changing, so one version of it is
// loaded and not half of each.
$loaded = \FormLogic\Support\CodeFingerprint::onDisk();
for ($look = 0; $look < 20; $look++) {
    usleep(500000);
    $again = \FormLogic\Support\CodeFingerprint::onDisk();
    if ($again === $loaded) break;
    $loaded = $again;
}
date_default_timezone_set('UTC');
\Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();
$config = require __DIR__ . '/../config/settings.php';

$watch = in_array('--watch', $argv, true);
$budget = 55;
foreach ($argv as $argument) {
    if (preg_match('/^--budget=(\d{1,5})$/D', $argument, $m)) $budget = max(1, (int) $m[1]);
}

// Another run is working: this one has nothing to add.
$lock = \FormLogic\Support\CronLock::take('app-ai-worker');
if ($lock === null) exit(0);

$status = \FormLogic\Services\AppAiWorkerLoop::FAILED;
try {
    $mysql = new \FormLogic\Database\MySQLConnection($config['settings']['mysql']);
    // The App AI tables exist even if this runs before the web app first booted (under its migration lock).
    try {
        $mysql->ensureSchemaCurrent();
    } catch (\Throwable $e) {
        fwrite(STDERR, date('c') . ' schema check failed: ' . $e->getMessage() . "\n");
    }
    $worker = \FormLogic\Services\AppAiWorker::standalone($mysql);
    // Its heartbeat says which code it runs, for the administrator's card to tell a stale worker.
    $worker->identify($loaded, $watch ? 'watch' : 'cron');
    $loop = new \FormLogic\Services\AppAiWorkerLoop(
        static fn(bool $takeNew): array => $worker->tick($takeNew),
        static fn(): bool => $worker->busy(),
        static fn(): string => \FormLogic\Support\CodeFingerprint::onDisk(),
        $loaded,
        static function (string $line): void {
            fwrite(STDOUT, date('c') . ' ' . $line . "\n");
        },
        static function (string $line): void {
            fwrite(STDERR, date('c') . ' ' . $line . "\n");
        },
    );
    // 0: done. 1: a pass failed (--watch ends at once, for its supervisor to start it with a fresh
    // connection). 75: FormLogic was updated; a fresh worker has to take over.
    $status = $loop->run($watch, $budget);
} finally {
    flock($lock, LOCK_UN);
    fclose($lock);
}
exit($status);

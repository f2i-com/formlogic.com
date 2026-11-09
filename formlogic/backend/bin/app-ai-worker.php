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
if (PHP_SAPI !== 'cli') exit;
require __DIR__ . '/../vendor/autoload.php';
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

$failed = false;
try {
    $mysql = new \FormLogic\Database\MySQLConnection($config['settings']['mysql']);
    // The App AI tables exist even if this runs before the web app first booted (under its migration lock).
    try {
        $mysql->ensureSchemaCurrent();
    } catch (\Throwable $e) {
        fwrite(STDERR, date('c') . ' schema check failed: ' . $e->getMessage() . "\n");
    }
    $worker = \FormLogic\Services\AppAiWorker::standalone($mysql);
    $deadline = microtime(true) + $budget;
    do {
        $started = microtime(true);
        try {
            $done = $worker->tick($watch || microtime(true) < $deadline);
            $busy = array_filter($done);
            if ($busy !== []) fwrite(STDOUT, date('c') . ' ' . json_encode($busy) . "\n");
        } catch (\Throwable $error) {
            $failed = true;
            fwrite(STDERR, date('c') . ' App AI worker pass failed: ' . get_class($error) . ': ' . $error->getMessage() . "\n");
            if ($watch) exit(1); // the supervisor restarts it with a fresh connection
        }
        // About a pass a second; a pass with work in flight on the .env upstream waits on it instead.
        $spent = microtime(true) - $started;
        if ($spent < 1.0) usleep((int) ((1.0 - $spent) * 1000000));
        // Past the budget, a run takes no new work but finishes what it sent to the .env upstream.
    } while ($watch || microtime(true) < $deadline || $worker->busy());
} finally {
    flock($lock, LOCK_UN);
    fclose($lock);
}
exit($failed ? 1 : 0);

<?php
declare(strict_types=1);

// Recovery for committed native records whose inline queue delivery was interrupted.
// Run every minute, or use --watch under a process supervisor. This queues flows;
// a connected OAIY executor or authenticated app runtime executes them.
if (PHP_SAPI !== 'cli') exit;
require __DIR__ . '/../vendor/autoload.php';
\Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();
$config = require __DIR__ . '/../config/settings.php';
$mysql = new \FormLogic\Database\MySQLConnection($config['settings']['mysql']);
$native = new \FormLogic\Services\NativeAppService();
$watch = in_array('--watch', $argv, true);
do {
    $failed = false;
    try {
        $flows = new \FormLogic\Services\FlowService($mysql);
        $apps = $mysql->getConnection()->query('SELECT id FROM apps')->fetchAll(PDO::FETCH_COLUMN);
        foreach ($apps as $appId) {
            try {
                $count = $native->dispatchRecordEvents($appId, fn($id, $event, $data, $bindings) => $flows->enqueueNativeRecordEvent($appId, $id, $event, $data, $bindings));
                if ($count) fwrite(STDOUT, date('c') . " Delivered $count record event(s) for app $appId\n");
            } catch (Throwable $error) {
                $failed = true;
                fwrite(STDERR, date('c') . " Record event delivery pending for app $appId\n");
            }
        }
    } catch (Throwable $error) {
        $failed = true;
        fwrite(STDERR, date('c') . " Record dispatcher unavailable; check database configuration\n");
        // Let the supervisor restart with a fresh PDO connection after an outage.
        if ($watch) exit(1);
    }
    if ($watch) sleep(15);
} while ($watch);
exit($failed ? 1 : 0);

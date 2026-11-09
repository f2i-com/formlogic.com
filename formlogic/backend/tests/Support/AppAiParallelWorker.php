<?php
declare(strict_types=1);
/**
 * One process of App AI's tests that need requests at the same moment: does what one of several
 * parallel requests does, on the real database, from a start time shared with the others, and
 * prints its outcome as JSON.
 *
 *   php AppAiParallelWorker.php redeem-link <job as JSON>   (DesktopLinkCodeTest)
 */

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\ApiKeyService;
use FormLogic\Services\DesktopLinkCodeService;
use FormLogic\Services\DesktopLinkIssuer;
use FormLogic\Services\FlowService;

require dirname(__DIR__, 2) . '/vendor/autoload.php';
date_default_timezone_set('UTC');
$mode = (string) ($argv[1] ?? '');
$job = json_decode((string) ($argv[2] ?? '{}'), true, 32, JSON_THROW_ON_ERROR);
$mysql = new MySQLConnection($job['mysql']);
$mysql->getConnection()->query('SELECT 1');
while (microtime(true) < (float) $job['startAt']) usleep(500);
try {
    if ($mode === 'redeem-link') {
        $keys = new ApiKeyService($mysql);
        $links = new DesktopLinkCodeService($mysql, new DesktopLinkIssuer($keys, new FlowService($mysql)), $keys, (string) $job['secret']);
        $linked = $links->redeem((string) $job['code']);
        echo json_encode(['ok' => true, 'connectionId' => $linked['connection']['id']]);
    } else {
        echo json_encode(['ok' => false, 'error' => 'unknown mode ' . $mode]);
    }
} catch (\Throwable $e) {
    echo json_encode(['ok' => false, 'error' => $e->getMessage()]);
}

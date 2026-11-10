<?php

declare(strict_types=1);

// One process of a token bucket race (RateLimiterTokenBucketTest): wait for the shared start time,
// take one token, and print whether it was given. Its arguments are a JSON file, named by argv[1].

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\RateLimiter;

require dirname(__DIR__, 2) . '/vendor/autoload.php';

$args = json_decode((string) file_get_contents($argv[1] ?? ''), true, 512, JSON_THROW_ON_ERROR);
$mysql = new MySQLConnection($args['db']);
$pdo = $mysql->getConnection();
$pdo->query('SELECT 1');
$limiter = new RateLimiter($pdo);
while (microtime(true) < (float) $args['at']) usleep(200);
// The same moment for every process, so none of them is handed a refilled token.
echo json_encode($limiter->take((string) $args['key'], (int) $args['capacity'], (int) $args['perSeconds'], (float) $args['at']));

<?php

declare(strict_types=1);

// One process of a wallet race (AppWalletRaceTest): wait for the shared start time, do one thing with
// the wallets, and print what came of it as JSON. Its arguments are a JSON file, named by argv[1].

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\AppPaymentsSiteSettings;
use FormLogic\Services\AppVisitors;
use FormLogic\Services\AppWalletService;
use FormLogic\Services\EmailService;
use FormLogic\Services\PayPalService;
use FormLogic\Services\PlatformPlansService;
use FormLogic\Services\WalletRefusal;

require dirname(__DIR__, 2) . '/vendor/autoload.php';

/** Mail that is always sent, and goes nowhere. */
final class RaceMail extends EmailService
{
    public function __construct()
    {
    }

    public function isConfigured(): bool
    {
        return true;
    }

    public function send(string $to, string $subject, string $htmlBody, ?string $textBody = null): bool
    {
        return true;
    }
}

$args = json_decode((string) file_get_contents($argv[1] ?? ''), true, 512, JSON_THROW_ON_ERROR);
$mysql = new MySQLConnection($args['db']);
$mysql->getConnection()->query('SELECT 1');
$wallets = new AppWalletService(
    $mysql,
    new AppPaymentsSiteSettings($args['site']),
    // Never asked anything here: a charge, a code and a credit need no PayPal call.
    new PayPalService(['clientId' => 'race', 'secret' => 'race', 'baseUrl' => 'http://127.0.0.1:9', 'webhookId' => 'race']),
    new PlatformPlansService($args['plans']),
    new AppVisitors($mysql, ['secure' => false]),
    false,
    new RaceMail(),
);
while (microtime(true) < (float) $args['at']) usleep(200);
try {
    $out = match ($args['op']) {
        'charge' => $wallets->charge($args['app'], $args['declared'], $args['holder'], $args['chargeId'], $args['item']),
        'confirm' => $wallets->confirmCode($args['app'], $args['holder'], $args['purpose'], $args['email'], $args['code']),
        'credit' => ['credited' => $wallets->creditTopup($args['topup'], $args['capture'])],
        'webhook' => ['handled' => $wallets->webhook($args['type'], $args['resource'])],
        'sendCode' => (static function () use ($wallets, $args): array {
            $wallets->sendCode($args['app'], $args['holder'], 'save', $args['email'], $args['ipKey']);
            return ['sent' => true];
        })(),
        // A second run starting: running, a moment of work, then its answer settles it.
        'start' => (static function () use ($wallets, $args): array {
            $started = $wallets->startCharge($args['charge']);
            usleep(300000);
            if ($started) $wallets->settleCharge($args['charge']);
            return ['started' => $started];
        })(),
        'settle' => (static function () use ($wallets, $args): array {
            $wallets->settleCharge($args['charge']);
            return ['settled' => true];
        })(),
        'sweep' => $wallets->sweepStale($args['wallet']),
        default => ['error' => 'unknown op'],
    };
} catch (WalletRefusal $e) {
    $out = ['refused' => $e->reason];
} catch (\Throwable $e) {
    $out = ['error' => get_class($e) . ': ' . $e->getMessage()];
}
echo json_encode($out);

<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppAiService;
use FormLogic\Services\AppPaymentsSiteSettings;
use FormLogic\Services\AppService;
use FormLogic\Services\AppVisitors;
use FormLogic\Services\AppWalletService;
use FormLogic\Services\EmailService;
use FormLogic\Services\FormService;
use FormLogic\Services\PayPalService;
use FormLogic\Services\PlatformPlansService;
use FormLogic\Tests\Support\LosesWalletLock;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * App payments under real concurrency (PAYMENTS-REVIEW.md): several PHP processes at once against
 * MySQL (tests/Support/wallet-race.php), each starting at the same moment. One charge id is paid
 * once; a wallet's day holds; guesses at one code share its five, and a right code works once; a
 * capture and its webhook credit a top-up once; two restores in opposite directions both finish.
 */
final class AppWalletRaceTest extends TestCase
{
    private static ?PDO $pdo = null;
    private static ?MySQLConnection $mysql = null;
    private static array $db = [];
    private static AppService $apps;
    private static string $tmpRoot = '';

    private string $ownerId = '';
    private array $app = [];
    private string $sitePath = '';
    private string $plansPath = '';
    private AppWalletService $wallets;
    private array $mail = [];

    private const DECLARED = ['items' => ['download' => ['label' => 'Download a logo', 'priceCents' => 5]], 'routes' => ['/api/download'], 'purpose' => ''];

    public static function setUpBeforeClass(): void
    {
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) \Dotenv\Dotenv::createImmutable($root)->safeLoad();
        self::$db = [
            'host' => $_ENV['DB_HOST'] ?? '127.0.0.1', 'port' => $_ENV['DB_PORT'] ?? '3306', 'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
            'username' => $_ENV['DB_USERNAME'] ?? 'root', 'password' => $_ENV['DB_PASSWORD'] ?? '', 'charset' => 'utf8mb4', 'collation' => 'utf8mb4_unicode_ci',
        ];
        try {
            $conn = new MySQLConnection(self::$db);
            $conn->getConnection()->query('SELECT 1');
            $conn->initializeSchema();
            $conn->runMigrations();
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
        self::$mysql = $conn;
        self::$pdo = $conn->getConnection();
        self::$tmpRoot = sys_get_temp_dir() . '/formlogic-wallet-race-' . bin2hex(random_bytes(4));
        mkdir(self::$tmpRoot . '/sqlite', 0777, true);
        self::$apps = new AppService($conn, new FormService($conn, new SQLiteConnection(self::$tmpRoot . '/sqlite')));
    }

    protected function setUp(): void
    {
        if (self::$pdo === null) $this->markTestSkipped('No test database');
        if (!function_exists('proc_open')) $this->markTestSkipped('Needs proc_open');
        $this->ownerId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, is_admin) VALUES (?, ?, 'x', 'Owner', 1)")->execute([$this->ownerId, $this->ownerId . '@test.local']);
        $created = self::$apps->createApp(['name' => 'Race ' . bin2hex(random_bytes(3)), 'settings' => ['softnApp' => true]], $this->ownerId);
        $this->app = ['id' => $created['id'], 'ownerId' => $this->ownerId, 'name' => 'Race'];
        self::$pdo->prepare('INSERT INTO app_payment_settings (app_id, enabled, prices) VALUES (?, 1, ?)')->execute([$created['id'], '{"download":5}']);
        $this->sitePath = self::$tmpRoot . '/app-payments-' . bin2hex(random_bytes(3)) . '.json';
        (new AppPaymentsSiteSettings($this->sitePath))->save(['enabled' => true, 'packages' => [200], 'maxChargeCents' => 500, 'dailyLimitCents' => 500]);
        $this->plansPath = self::$tmpRoot . '/plans-' . bin2hex(random_bytes(3)) . '.json';
        file_put_contents($this->plansPath, json_encode(array_replace(PlatformPlansService::defaults(), ['paymentsEnabled' => true])));
        $email = $this->createMock(EmailService::class);
        $email->method('isConfigured')->willReturn(true);
        $email->method('send')->willReturnCallback(function (string $to, string $subject, string $html) {
            $this->mail[] = preg_match('/<strong>(\d{6})<\/strong>/', $html, $m) ? $m[1] : null;
            return true;
        });
        $this->wallets = new AppWalletService(self::$mysql, new AppPaymentsSiteSettings($this->sitePath),
            new PayPalService(['clientId' => 'race', 'secret' => 'race', 'baseUrl' => 'http://127.0.0.1:9', 'webhookId' => 'race']),
            new PlatformPlansService($this->plansPath), new AppVisitors(self::$mysql, ['secure' => false]), false, $email);
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null || $this->app === []) return;
        $id = $this->app['id'];
        foreach (['app_wallet_charges', 'app_wallet_ledger', 'app_wallet_topups', 'app_wallet_codes', 'app_wallet_holders', 'app_wallets', 'app_payment_settings', 'app_users'] as $table) {
            self::$pdo->prepare("DELETE FROM {$table} WHERE app_id = ?")->execute([$id]);
        }
        self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?)')->execute([$id]);
        self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$id]);
        self::$pdo->prepare('DELETE FROM app_versions WHERE app_id = ?')->execute([$id]);
        self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$id]);
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->ownerId]);
    }

    /** A visitor with $cents in their wallet, put there as an administrator's correction. */
    private function funded(int $cents): array
    {
        $holder = ['kind' => 'visitor', 'id' => bin2hex(random_bytes(16))];
        $wallet = $this->wallets->wallet($this->app['id'], $holder, true);
        if ($cents !== 0) $this->wallets->adjust((string) $wallet['id'], $cents, 'race', $this->ownerId);
        return $holder;
    }

    /**
     * Run each of $jobs in its own PHP process, all starting at one moment; answer what each printed.
     *
     * @param list<array> $jobs
     * @return list<array>
     */
    private function race(array $jobs): array
    {
        $at = microtime(true) + 2.5 + count($jobs) * 0.15;
        $script = dirname(__DIR__) . '/Support/wallet-race.php';
        $running = [];
        foreach ($jobs as $index => $job) {
            $file = self::$tmpRoot . '/race-' . bin2hex(random_bytes(4)) . '.json';
            file_put_contents($file, json_encode($job + ['db' => self::$db, 'site' => $this->sitePath, 'plans' => $this->plansPath, 'app' => $this->app, 'declared' => self::DECLARED, 'at' => $at], JSON_THROW_ON_ERROR));
            $process = proc_open([PHP_BINARY, '-d', 'xdebug.mode=off', $script, $file], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
            $this->assertIsResource($process);
            $running[$index] = [$process, $pipes];
        }
        $out = [];
        foreach ($running as $index => [$process, $pipes]) {
            $printed = stream_get_contents($pipes[1]);
            $errors = stream_get_contents($pipes[2]);
            fclose($pipes[1]);
            fclose($pipes[2]);
            proc_close($process);
            $answer = json_decode((string) $printed, true);
            $this->assertIsArray($answer, "process {$index} printed: {$printed} {$errors}");
            $this->assertArrayNotHasKey('error', $answer, (string) ($answer['error'] ?? ''));
            $out[] = $answer;
        }
        $this->assertLessThan($at + 30, microtime(true));
        return $out;
    }

    private function balance(array $holder): int
    {
        return (int) $this->wallets->wallet($this->app['id'], $holder, false)['balance_cents'];
    }

    /** H1: one charge id, eight requests at once: paid once, the rest told it is being paid, never paid twice. */
    public function testOneChargeIdAskedForAtOnceIsPaidOnce(): void
    {
        $holder = $this->funded(200);
        $answers = $this->race(array_fill(0, 8, ['op' => 'charge', 'holder' => $holder, 'chargeId' => 'download:d1', 'item' => 'download']));
        $paid = array_filter($answers, static fn(array $a) => $a['status'] === 'paid' && $a['alreadyPaid'] === false);
        $this->assertCount(1, $paid, json_encode($answers));
        $this->assertSame(array_fill(0, 7, 'in_progress'), array_values(array_map(static fn(array $a) => $a['code'] ?? $a['status'], array_filter($answers, static fn(array $a) => $a['status'] !== 'paid'))));
        $this->assertSame(195, $this->balance($holder));
        $this->assertSame(1, (int) self::$pdo->query("SELECT COUNT(*) FROM app_wallet_ledger WHERE kind = 'charge' AND app_id = " . self::$pdo->quote($this->app['id']))->fetchColumn());
    }

    /** L1: a wallet's day holds when its charges come at once. */
    public function testAWalletsDayHoldsWhenChargesComeAtOnce(): void
    {
        (new AppPaymentsSiteSettings($this->sitePath))->save(['enabled' => true, 'packages' => [200], 'maxChargeCents' => 500, 'dailyLimitCents' => 10]);
        $holder = $this->funded(200);
        $jobs = [];
        for ($i = 0; $i < 6; $i++) $jobs[] = ['op' => 'charge', 'holder' => $holder, 'chargeId' => 'download:d' . $i, 'item' => 'download'];
        $answers = $this->race($jobs);
        $this->assertCount(2, array_filter($answers, static fn(array $a) => $a['status'] === 'paid'), json_encode($answers));
        $this->assertSame(4, count(array_filter($answers, static fn(array $a) => ($a['code'] ?? null) === 'limit_reached')));
        $this->assertSame(190, $this->balance($holder));
    }

    /** M5: guesses at one code at once share its five, and the right code works once. */
    public function testGuessesAtOnceShareFiveAndARightCodeWorksOnce(): void
    {
        $holder = $this->funded(200);
        $this->wallets->sendCode($this->app, $holder, 'save', 'race@example.com', 'abababababababab');
        $code = (string) end($this->mail);
        $wrong = [];
        for ($i = 0; $i < 12; $i++) $wrong[] = ['op' => 'confirm', 'holder' => $holder, 'purpose' => 'save', 'email' => 'race@example.com', 'code' => str_pad((string) (((int) $code + 1 + $i) % 1000000), 6, '0', STR_PAD_LEFT)];
        $answers = $this->race($wrong);
        $this->assertSame(array_fill(0, 12, 'bad_code'), array_column($answers, 'refused'));
        $this->assertSame(5, (int) self::$pdo->query('SELECT attempts FROM app_wallet_codes WHERE app_id = ' . self::$pdo->quote($this->app['id']))->fetchColumn(), 'five guesses counted, however many came at once');
        try {
            $this->wallets->confirmCode($this->app, $holder, 'save', 'race@example.com', $code);
            $this->fail('the right code after its five guesses');
        } catch (\FormLogic\Services\WalletRefusal $e) {
            $this->assertSame('bad_code', $e->reason);
        }

        $this->wallets->sendCode($this->app, $holder, 'save', 'race@example.com', 'abababababababab');
        $right = (string) end($this->mail);
        $answers = $this->race(array_fill(0, 8, ['op' => 'confirm', 'holder' => $holder, 'purpose' => 'save', 'email' => 'race@example.com', 'code' => $right]));
        $this->assertCount(1, array_filter($answers, static fn(array $a) => isset($a['balanceCents'])), json_encode($answers));
        $this->assertCount(7, array_filter($answers, static fn(array $a) => ($a['refused'] ?? null) === 'bad_code'));
    }

    /** M5: the code limits hold when codes are asked for at once, from one address and for one email. */
    public function testCodeLimitsHoldWhenCodesAreAskedForAtOnce(): void
    {
        $holder = $this->funded(0);
        $byAddress = [];
        $byEmail = [];
        for ($i = 0; $i < 8; $i++) {
            $byAddress[] = ['op' => 'sendCode', 'holder' => $holder, 'email' => "limit{$i}@example.com", 'ipKey' => 'cdcdcdcdcdcdcdcd'];
            $byEmail[] = ['op' => 'sendCode', 'holder' => $holder, 'email' => 'same@example.com', 'ipKey' => sprintf('ee%014d', $i)];
        }
        foreach (['an address' => $byAddress, 'an email' => $byEmail] as $what => $jobs) {
            $answers = $this->race($jobs);
            $this->assertCount(AppWalletService::CODES_PER_HOUR, array_filter($answers, static fn(array $a) => ($a['sent'] ?? false) === true), $what . ': ' . json_encode($answers));
            $this->assertCount(8 - AppWalletService::CODES_PER_HOUR, array_filter($answers, static fn(array $a) => ($a['refused'] ?? null) === 'too_many'), $what);
        }
        $this->assertSame(AppWalletService::CODES_PER_HOUR, (int) self::$pdo->query("SELECT COUNT(*) FROM app_wallet_codes WHERE ip_key = 'cdcdcdcdcdcdcdcd'")->fetchColumn(), 'only the codes the limit allows are kept');
    }

    /** A charge as a request that died fifteen minutes ago left it. */
    private function stale(string $charge): void
    {
        $then = AppAiService::stamp(time() - AppWalletService::STALE_CHARGE_SECONDS - 60);
        self::$pdo->prepare('UPDATE app_wallet_charges SET created_at = ?, updated_at = ? WHERE id = ?')->execute([$then, $then, $charge]);
    }

    private function refunds(): int
    {
        return (int) self::$pdo->query("SELECT COUNT(*) FROM app_wallet_ledger WHERE kind = 'refund' AND app_id = " . self::$pdo->quote($this->app['id']))->fetchColumn();
    }

    /** N1: a stale charge, its second run starting while the sweeper runs: one outcome, never both. */
    public function testTheSweeperAndASecondRunStartingAtOnceAgreeOnOneOutcome(): void
    {
        $holder = $this->funded(200);
        $paid = $this->wallets->charge($this->app, self::DECLARED, $holder, 'download:edge', 'download');
        $this->stale($paid['charge']);
        $wallet = (string) $this->wallets->wallet($this->app['id'], $holder, false)['id'];
        $jobs = [['op' => 'start', 'charge' => $paid['charge']]];
        for ($i = 0; $i < 5; $i++) $jobs[] = ['op' => 'sweep', 'wallet' => $wallet];
        $answers = $this->race($jobs);
        $state = self::$pdo->query('SELECT state FROM app_wallet_charges WHERE id = ' . self::$pdo->quote($paid['charge']))->fetchColumn();
        $this->assertSame($answers[0]['started'] ? ['settled', 0, 195] : ['refunded', 1, 200], [$state, $this->refunds(), $this->balance($holder)], json_encode($answers));
    }

    /** N1: a stale running charge, swept while its late answer settles it: settled, never given back. */
    public function testARunThatStartedIsNeverGivenBackHoweverManySweep(): void
    {
        $holder = $this->funded(200);
        $paid = $this->wallets->charge($this->app, self::DECLARED, $holder, 'download:late', 'download');
        $this->assertTrue($this->wallets->startCharge($paid['charge']));
        $this->stale($paid['charge']);
        $wallet = (string) $this->wallets->wallet($this->app['id'], $holder, false)['id'];
        $jobs = [['op' => 'settle', 'charge' => $paid['charge']]];
        for ($i = 0; $i < 6; $i++) $jobs[] = ['op' => 'sweep', 'wallet' => $wallet];
        $answers = $this->race($jobs);
        $this->assertSame(0, array_sum(array_map(static fn(array $a) => (int) ($a['refunded'] ?? 0), $answers)), json_encode($answers));
        $this->assertSame(['settled', 0, 195], [self::$pdo->query('SELECT state FROM app_wallet_charges WHERE id = ' . self::$pdo->quote($paid['charge']))->fetchColumn(), $this->refunds(), $this->balance($holder)]);
    }

    /** A pending top-up for $holder's wallet $walletId, as createTopup records one. */
    private function topupRow(array $holder, string $walletId, int $cents): array
    {
        $now = AppAiService::stamp(microtime(true));
        $id = bin2hex(random_bytes(16));
        self::$pdo->prepare("INSERT INTO app_wallet_topups (id, wallet_id, app_id, order_id, amount_cents, currency, package_cents, status, holder_kind, holder_id, ip_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'USD', ?, 'pending', ?, ?, 'abababababababab', ?, ?)")
            ->execute([$id, $walletId, $this->app['id'], 'RACE-' . $id, $cents, $cents, $holder['kind'], $holder['id'], $now, $now]);
        return self::$pdo->query('SELECT * FROM app_wallet_topups WHERE id = ' . self::$pdo->quote($id))->fetch(PDO::FETCH_ASSOC);
    }

    /** N3: a restore racing a credit and a refund of the same browser's top-ups: no deadlock, and not a cent lost or made. */
    public function testARestoreRacingACreditAndARefundLosesNothing(): void
    {
        for ($round = 0; $round < 3; $round++) {
            $email = "restore{$round}@example.com";
            $ip = sprintf('ef%014d', $round);
            $saved = $this->funded(100);
            $this->wallets->sendCode($this->app, $saved, 'save', $email, $ip);
            $this->wallets->confirmCode($this->app, $saved, 'save', $email, (string) end($this->mail));
            $savedWallet = (string) $this->wallets->wallet($this->app['id'], $saved, false)['id'];
            $mover = $this->funded(0);
            $moverWallet = (string) $this->wallets->wallet($this->app['id'], $mover, false)['id'];
            $capture = 'RACECAP1-' . bin2hex(random_bytes(6));
            $this->assertTrue($this->wallets->creditTopup($this->topupRow($mover, $moverWallet, 200), $capture));
            $pending = $this->topupRow($mover, $moverWallet, 300);
            $this->wallets->sendCode($this->app, $mover, 'restore', $email, $ip);
            $answers = $this->race([
                ['op' => 'confirm', 'holder' => $mover, 'purpose' => 'restore', 'email' => $email, 'code' => (string) end($this->mail)],
                ['op' => 'credit', 'topup' => $pending, 'capture' => 'RACECAP2-' . bin2hex(random_bytes(6))],
                ['op' => 'webhook', 'type' => 'PAYMENT.CAPTURE.REFUNDED', 'resource' => ['id' => 'RACEREF-' . bin2hex(random_bytes(6)), 'amount' => ['currency_code' => 'USD', 'value' => '0.50'],
                    'links' => [['rel' => 'up', 'href' => 'https://api-m.paypal.com/v2/payments/captures/' . $capture]]]],
            ]);
            $this->assertSame([true, true, true], [isset($answers[0]['balanceCents']), $answers[1]['credited'] ?? null, $answers[2]['handled'] ?? null], "round {$round}: " . json_encode($answers));
            $this->assertSame($savedWallet, (string) $this->wallets->wallet($this->app['id'], $mover, false)['id'], 'restored into the saved wallet');
            $this->assertSame(550, $this->balance($mover), "round {$round}: 100 + 200 + 300 - 50, whatever came first");
            $this->assertSame(0, (int) self::$pdo->query('SELECT balance_cents FROM app_wallets WHERE id = ' . self::$pdo->quote($moverWallet))->fetchColumn());
        }
    }

    /** A visitor with $cents, their balance saved under $email: [holder, wallet id]. */
    private function savedUnder(string $email, int $cents, string $ipKey): array
    {
        $holder = $this->funded($cents);
        $this->wallets->sendCode($this->app, $holder, 'save', $email, $ipKey);
        $this->wallets->confirmCode($this->app, $holder, 'save', $email, (string) end($this->mail));
        return [$holder, (string) $this->wallets->wallet($this->app['id'], $holder, false)['id']];
    }

    /** A restore of the balance saved under $email, asked for by $holder: the job that confirms its code. */
    private function restoreJob(array $holder, string $email, string $ipKey): array
    {
        $this->wallets->sendCode($this->app, $holder, 'restore', $email, $ipKey);
        return ['op' => 'confirm', 'holder' => $holder, 'purpose' => 'restore', 'email' => $email, 'code' => (string) end($this->mail)];
    }

    private function walletBalance(string $walletId): int
    {
        return (int) self::$pdo->query('SELECT balance_cents FROM app_wallets WHERE id = ' . self::$pdo->quote($walletId))->fetchColumn();
    }

    /**
     * Two restores at once between the same two wallets, each bringing its browser to the other's
     * saved balance: both are answered (neither is ended by MySQL to break a deadlock, 1213), the
     * browsers have changed places, and every cent is in one of the two, on a ledger that adds up.
     */
    public function testTwoRestoresInOppositeDirectionsAtOnceBothFinishAndLoseNothing(): void
    {
        $asked = 0;
        $ip = static function () use (&$asked): string {
            return sprintf('f1%014d', $asked++);
        };
        for ($round = 0; $round < 3; $round++) {
            $pairs = [];
            $jobs = [];
            for ($pair = 0; $pair < 4; $pair++) {
                $emails = ["left{$round}x{$pair}@example.com", "right{$round}x{$pair}@example.com"];
                [$left, $leftWallet] = $this->savedUnder($emails[0], 100 + $pair, $ip());
                [$right, $rightWallet] = $this->savedUnder($emails[1], 40, $ip());
                $jobs[] = $this->restoreJob($left, $emails[1], $ip());
                $jobs[] = $this->restoreJob($right, $emails[0], $ip());
                $pairs[] = [$left, $leftWallet, $right, $rightWallet, 140 + $pair];
            }
            $answers = $this->race($jobs);
            foreach ($pairs as $index => [$left, $leftWallet, $right, $rightWallet, $total]) {
                $what = "round {$round}, pair {$index}: " . json_encode([$answers[$index * 2], $answers[$index * 2 + 1]]);
                $this->assertSame([true, true], [isset($answers[$index * 2]['balanceCents']), isset($answers[$index * 2 + 1]['balanceCents'])], $what);
                $this->assertSame([$rightWallet, $leftWallet], [(string) $this->wallets->wallet($this->app['id'], $left, false)['id'], (string) $this->wallets->wallet($this->app['id'], $right, false)['id']], 'each browser holds the other\'s saved balance now');
                $balances = [$this->walletBalance($leftWallet), $this->walletBalance($rightWallet)];
                sort($balances);
                $this->assertSame([0, $total], $balances, $what);
                foreach ([$leftWallet, $rightWallet] as $wallet) {
                    $this->assertSame($this->walletBalance($wallet), (int) self::$pdo->query('SELECT COALESCE(SUM(amount_cents), 0) FROM app_wallet_ledger WHERE wallet_id = ' . self::$pdo->quote($wallet))->fetchColumn(), 'the ledger adds up to the balance');
                }
            }
        }
        $this->assertSame(0, (int) self::$pdo->query("SELECT COUNT(*) FROM app_wallet_codes WHERE purpose = 'restore' AND (attempts <> 1 OR used_at IS NULL) AND app_id = " . self::$pdo->quote($this->app['id']))->fetchColumn(), 'each code took one guess and was spent');
    }

    /**
     * A restore MySQL ends to break a deadlock (LosesWalletLock makes one on demand) is tried again,
     * on the one guess its code was counted. One that loses every try surfaces the error with nothing
     * moved, its code unspent and still one guess used; confirmed again, it is done.
     */
    public function testARestoreThatLosesALockIsTriedAgainOnTheOneGuess(): void
    {
        [$saved, $savedWallet] = $this->savedUnder('kept@example.com', 100, 'f200000000000001');
        $mover = $this->funded(30);
        $moverWallet = (string) $this->wallets->wallet($this->app['id'], $mover, false)['id'];
        $code = $this->restoreJob($mover, 'kept@example.com', 'f200000000000002')['code'];
        $confirm = fn(): array => $this->wallets->confirmCode($this->app, $mover, 'restore', 'kept@example.com', $code);
        $guesses = fn(): array => self::$pdo->query("SELECT attempts, used_at IS NOT NULL AS spent FROM app_wallet_codes WHERE purpose = 'restore' AND app_id = " . self::$pdo->quote($this->app['id']))->fetch(PDO::FETCH_NUM);
        $transfers = fn(): int => (int) self::$pdo->query("SELECT COUNT(*) FROM app_wallet_ledger WHERE kind IN ('transfer_out', 'transfer_in') AND app_id = " . self::$pdo->quote($this->app['id']))->fetchColumn();

        try {
            LosesWalletLock::during(self::$pdo, 3, $confirm);
            $this->fail('every try lost its lock');
        } catch (\PDOException $e) {
            $this->assertSame(1213, $e->errorInfo[1] ?? null);
        }
        $this->assertSame(3, LosesWalletLock::$lost, 'tried three times');
        $this->assertSame([1, 0], array_map('intval', $guesses()), 'one guess counted for three tries, and the code unspent');
        $this->assertSame([$moverWallet, 30, 100, 0], [(string) $this->wallets->wallet($this->app['id'], $mover, false)['id'], $this->walletBalance($moverWallet), $this->walletBalance($savedWallet), $transfers()], 'nothing moved');

        $answer = LosesWalletLock::during(self::$pdo, 1, $confirm);
        $this->assertSame([1, 130], [LosesWalletLock::$lost, $answer['balanceCents']], 'lost once, tried again, and done');
        $this->assertSame([2, 1], array_map('intval', $guesses()), 'this confirm counted its own guess, once, and spent the code');
        $this->assertSame([$savedWallet, 0, 130, 2], [(string) $this->wallets->wallet($this->app['id'], $mover, false)['id'], $this->walletBalance($moverWallet), $this->walletBalance($savedWallet), $transfers()], 'moved once');
        $this->assertSame(130, $this->balance($saved));
    }

    /** A top-up's capture and its webhook at once: credited once. */
    public function testACaptureAndItsWebhookAtOnceCreditOnce(): void
    {
        $holder = $this->funded(0);
        $wallet = $this->wallets->wallet($this->app['id'], $holder, false);
        $now = AppAiService::stamp(microtime(true));
        $id = bin2hex(random_bytes(16));
        self::$pdo->prepare("INSERT INTO app_wallet_topups (id, wallet_id, app_id, order_id, amount_cents, currency, package_cents, status, holder_kind, holder_id, ip_key, created_at, updated_at) VALUES (?, ?, ?, ?, 200, 'USD', 200, 'pending', ?, ?, 'abababababababab', ?, ?)")
            ->execute([$id, $wallet['id'], $this->app['id'], 'RACE-' . $id, $holder['kind'], $holder['id'], $now, $now]);
        $topup = self::$pdo->query('SELECT * FROM app_wallet_topups WHERE id = ' . self::$pdo->quote($id))->fetch(PDO::FETCH_ASSOC);
        $answers = $this->race(array_fill(0, 6, ['op' => 'credit', 'topup' => $topup, 'capture' => 'RACECAP-' . $id]));
        $this->assertSame([true], array_values(array_filter(array_column($answers, 'credited'))), json_encode($answers));
        $this->assertSame(200, $this->balance($holder));
        $this->assertSame(1, (int) self::$pdo->query("SELECT COUNT(*) FROM app_wallet_ledger WHERE kind = 'topup' AND app_id = " . self::$pdo->quote($this->app['id']))->fetchColumn());
    }
}

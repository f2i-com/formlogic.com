<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\BillingController;
use FormLogic\Controllers\NativeAppController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppPaymentsSiteSettings;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\AppVisitors;
use FormLogic\Services\AppWalletService;
use FormLogic\Services\EmailService;
use FormLogic\Services\FlowService;
use FormLogic\Services\FormService;
use FormLogic\Services\NativeAppCharges;
use FormLogic\Services\NativeAppService;
use FormLogic\Services\NativeRecordEventRouter;
use FormLogic\Services\PayPalService;
use FormLogic\Services\PlanService;
use FormLogic\Services\PlatformPlansService;
use FormLogic\Services\RuntimeEngineService;
use FormLogic\Services\WalletRefusal;
use FormLogic\Support\SessionOriginPolicy;
use FormLogic\Tests\Support\StubPayPalServer;
use PDO;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response;

/**
 * App payments end to end (contract §0.5, §0.6): a visitor's charge in two runs of the app's own route
 * through the real controller and runner, the owner's price and never the app's, once per charge id,
 * given back when the app does not finish; top-ups through a stand-in for PayPal (capture, recovery,
 * webhooks, refunds below zero, disputes); and a balance saved under an email and restored elsewhere.
 */
final class AppPaymentsTest extends TestCase
{
    private const ORIGIN = 'http://127.0.0.1:8300';
    private const IP = '203.0.113.30';

    private static ?PDO $pdo = null;
    private static ?MySQLConnection $mysql = null;
    private static AppService $apps;
    private static string $tmpRoot = '';
    private static ?StubPayPalServer $paypal = null;

    private string $ownerId = '';
    private NativeAppService $native;
    private AppVisitors $visitors;
    private AppPaymentsSiteSettings $site;
    private PlatformPlansService $platform;
    private AppWalletService $wallets;
    private NativeAppController $controller;
    private array $mail = [];
    /** @var string[] */
    private array $appIds = [];
    private bool $beta = false;

    public static function setUpBeforeClass(): void
    {
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) \Dotenv\Dotenv::createImmutable($root)->safeLoad();
        try {
            $conn = new MySQLConnection([
                'host' => $_ENV['DB_HOST'] ?? '127.0.0.1', 'port' => $_ENV['DB_PORT'] ?? '3306', 'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
                'username' => $_ENV['DB_USERNAME'] ?? 'root', 'password' => $_ENV['DB_PASSWORD'] ?? '', 'charset' => 'utf8mb4', 'collation' => 'utf8mb4_unicode_ci',
            ]);
            $conn->getConnection()->query('SELECT 1');
            $conn->initializeSchema();
            $conn->runMigrations();
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
        self::$mysql = $conn;
        self::$pdo = $conn->getConnection();
        self::$tmpRoot = sys_get_temp_dir() . '/formlogic-app-payments-' . bin2hex(random_bytes(4));
        mkdir(self::$tmpRoot . '/sqlite', 0777, true);
        self::$apps = new AppService($conn, new FormService($conn, new SQLiteConnection(self::$tmpRoot . '/sqlite')));
        if (function_exists('curl_init')) self::$paypal = StubPayPalServer::start();
    }

    public static function tearDownAfterClass(): void
    {
        self::$paypal?->stop();
        self::$paypal = null;
        if (self::$tmpRoot !== '' && is_dir(self::$tmpRoot)) self::removeTree(self::$tmpRoot);
    }

    public static function runners(): array
    {
        return ['softn-runner (or Node where none ships)' => ['auto'], 'Node runner.mjs' => ['node']];
    }

    private function boot(string $runner = 'auto', bool $admin = true): void
    {
        if (self::$pdo === null) $this->markTestSkipped('No test database');
        if (self::$paypal === null) $this->markTestSkipped('Needs curl');
        $node = getenv('FORMLOGIC_NODE_BIN') ?: null;
        if ($runner === 'node' && $node === null) $this->markTestSkipped('Set FORMLOGIC_NODE_BIN to run the Node runner');
        $this->native = new NativeAppService(self::$tmpRoot . '/native-' . bin2hex(random_bytes(3)), null, $node, $runner);
        if (!$this->native->available()) $this->markTestSkipped('No SoftN runtime here');
        $this->ownerId = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, is_admin) VALUES (?, ?, 'x', 'Owner', ?)")->execute([$this->ownerId, $this->ownerId . '@test.local', $admin ? 1 : 0]);
        $this->visitors = new AppVisitors(self::$mysql, ['secure' => false], new SessionOriginPolicy([self::ORIGIN]));
        $this->site = new AppPaymentsSiteSettings(self::$tmpRoot . '/app-payments-' . bin2hex(random_bytes(3)) . '.json');
        $this->site->save(['enabled' => true, 'packages' => [200, 500], 'maxChargeCents' => 500, 'dailyLimitCents' => 500]);
        $plans = self::$tmpRoot . '/plans-' . bin2hex(random_bytes(3)) . '.json';
        file_put_contents($plans, json_encode(array_replace(PlatformPlansService::defaults(), ['paymentsEnabled' => true])));
        $this->platform = new PlatformPlansService($plans);
        $email = $this->createMock(EmailService::class);
        $email->method('isConfigured')->willReturn(true);
        $email->method('send')->willReturnCallback(function (string $to, string $subject, string $html) {
            $this->mail[] = ['to' => $to, 'code' => preg_match('/<strong>(\d{6})<\/strong>/', $html, $m) ? $m[1] : null];
            return true;
        });
        $paypal = new PayPalService(['clientId' => 'stub-client', 'secret' => 'stub-secret', 'baseUrl' => self::$paypal->base]);
        $this->wallets = new AppWalletService(self::$mysql, $this->site, $paypal, $this->platform, $this->visitors, $this->beta, $email);
        $engines = $this->createMock(RuntimeEngineService::class);
        $engines->method('effective')->willReturn(['id' => 'zipp-web-python', 'requested' => 'zipp-web-python', 'stored' => null, 'revision' => '0123456789abcdef']);
        $flows = new FlowService(self::$mysql);
        $this->controller = new NativeAppController(self::$apps, $this->createMock(AppUserService::class), $this->native, $this->createMock(PlanService::class), $flows, $engines,
            null, null, null, null, new NativeRecordEventRouter($flows, null), $this->visitors, null, $this->wallets, new NativeAppCharges($this->wallets));
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) return;
        foreach ($this->appIds as $appId) {
            foreach (['app_wallet_ledger', 'app_wallet_topups', 'app_wallet_codes', 'app_wallet_holders', 'app_wallets'] as $table) self::$pdo->prepare("DELETE FROM {$table} WHERE app_id = ?")->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_users WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_role_permissions WHERE role_id IN (SELECT id FROM app_roles WHERE app_id = ?)')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_roles WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM app_versions WHERE app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE FROM apps WHERE id = ?')->execute([$appId]);
        }
        if ($this->ownerId !== '') self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$this->ownerId]);
        $this->appIds = [];
    }

    // ------------------------------------------------------------------ the app

    private const SERVER = <<<'JS'
function buyer(req) { var f = req.context && req.context.formlogic ? req.context.formlogic : {}; return f.visitor ? f.visitor.id : (f.userId || ""); }
function download(req) {
  var body = req.body || {};
  var design = String(body.design || "d1");
  var owned = softn.sql.first("SELECT 1 AS yes FROM purchases WHERE design = ? AND buyer = ?", [design, buyer(req)]);
  if (owned) return { status: 200, body: { design: design, already: true } };
  var payment = req.context && req.context.formlogic ? req.context.formlogic.payment : null;
  if (!payment) {
    // The ask writes nothing: a row written here is rolled back with it.
    softn.sql.execute("INSERT INTO asked(design) VALUES(?)", [design]);
    return { status: 402, body: { formlogicCharge: { id: body.chargeId || ("download:" + design), item: body.item || "download", amountCents: 1 } }, rollback: true };
  }
  if (payment.status !== "paid") return { status: 402, body: { declined: payment.code, balanceCents: payment.balanceCents } };
  if (body.failAfter === "throw") throw new Error("could not make the file");
  if (body.failAfter === "status") return { status: 503, body: { error: "busy" } };
  if (body.askAgain) return { status: 402, body: { formlogicCharge: { id: "again", item: "download" } } };
  softn.sql.execute("INSERT INTO purchases(design, buyer, charge) VALUES(?,?,?)", [design, buyer(req), payment.chargeId]);
  return { status: 200, body: { design: design, paid: payment.amountCents, balanceCents: payment.balanceCents, alreadyPaid: payment.alreadyPaid } };
}
function whoami(req) { return { status: 200, body: { wallet: req.context && req.context.formlogic ? req.context.formlogic.wallet || null : null } }; }
JS;

    private function app(): array
    {
        $manifest = [
            'name' => 'Logo shop', 'version' => '0.0.1', 'main' => 'ui/main.ui',
            'server' => [
                'entry' => 'server/main.logic', 'requires' => ['apiVersion' => 1, 'capabilities' => ['sql']],
                'database' => ['kind' => 'private-sqlite', 'migrations' => ['server/migrations/001.sql']],
                'routes' => [
                    ['path' => '/api/download', 'method' => 'POST', 'handler' => 'download', 'transaction' => 'write', 'authorization' => 'anonymous'],
                    ['path' => '/api/free', 'method' => 'POST', 'handler' => 'download', 'transaction' => 'write', 'authorization' => 'anonymous'],
                    ['path' => '/api/whoami', 'method' => 'GET', 'handler' => 'whoami', 'transaction' => 'read', 'authorization' => 'anonymous'],
                ],
            ],
            'formlogicPayments' => ['purpose' => 'Pay 5 cents to download a logo.', 'items' => [['id' => 'download', 'label' => 'Download a logo', 'priceCents' => 5], ['id' => 'poster', 'label' => 'A poster', 'priceCents' => 300]], 'routes' => ['/api/download']],
        ];
        $app = self::$apps->createApp(['name' => 'Logo shop ' . bin2hex(random_bytes(3)), 'settings' => ['softnApp' => true]], $this->ownerId);
        $this->appIds[] = $app['id'];
        $this->native->install($app['id'], ['version' => 0, 'home' => true, 'access' => 'application', 'assets' => [], 'files' => [
            'manifest.json' => json_encode($manifest, JSON_UNESCAPED_SLASHES), 'ui/main.ui' => '<Stack><Text>Shop</Text></Stack>', 'server/main.logic' => self::SERVER,
            'server/migrations/001.sql' => "CREATE TABLE purchases(design TEXT, buyer TEXT, charge TEXT);\nCREATE TABLE asked(design TEXT);",
        ]], 0);
        self::$pdo->prepare("UPDATE apps SET status = 'published' WHERE id = ?")->execute([$app['id']]);
        self::$pdo->prepare('INSERT INTO app_payment_settings (app_id, enabled) VALUES (?, 1)')->execute([$app['id']]);
        return self::$apps->getApp($app['id']);
    }

    /** One request from the app's page as a visitor whose browser holds $cookie (a new one when empty). */
    private function call(array $app, string $path, array $body = [], array &$cookie = [], string $method = 'POST'): array
    {
        $payload = ['method' => $method, 'path' => $path, 'query' => [], 'headers' => [], 'body' => $body === [] ? new \stdClass() : $body];
        $request = (new ServerRequestFactory())->createServerRequest('POST', self::ORIGIN . '/api/app/' . $app['slug'] . '/native/request', ['REMOTE_ADDR' => self::IP])
            ->withHeader('Host', '127.0.0.1:8300')->withHeader('Content-Type', 'application/json')->withHeader(AppVisitors::HEADER, '1')->withHeader('Origin', self::ORIGIN)
            ->withCookieParams($cookie)->withParsedBody(json_decode((string) json_encode($payload), true));
        $request->getBody()->write((string) json_encode($payload));
        $response = $this->controller->runtime($request, new Response(), ['slug' => $app['slug']]);
        if (preg_match('/formlogic_visitor=([^;]+)/', $response->getHeaderLine('Set-Cookie'), $m)) $cookie = [AppVisitors::COOKIE => $m[1]];
        $data = json_decode((string) $response->getBody(), true);
        return ['http' => $response->getStatusCode(), 'status' => $data['result']['status'] ?? null, 'body' => $data['result']['body'] ?? $data];
    }

    /** The visitor's wallet sheet operations, as FormLogic's own page sends them. */
    private function wallet(array $app, string $method, array $args = [], array $body = [], array $cookie = []): array
    {
        $request = (new ServerRequestFactory())->createServerRequest($method, self::ORIGIN . '/api/app/' . $app['slug'] . '/wallet', ['REMOTE_ADDR' => self::IP])
            ->withHeader(AppVisitors::HEADER, '1')->withHeader('Origin', self::ORIGIN)->withCookieParams($cookie)->withParsedBody($body);
        $response = $this->controller->wallet($request, new Response(), ['slug' => $app['slug']] + $args);
        return ['http' => $response->getStatusCode(), 'body' => json_decode((string) $response->getBody(), true)];
    }

    private function visitorOf(array $cookie, string $appId): array
    {
        return ['kind' => 'visitor', 'id' => $this->visitors->idFor($appId, (string) $this->visitors->open($cookie[AppVisitors::COOKIE] ?? null))];
    }

    /** Credit a visitor's wallet as a completed top-up would. */
    private function topUp(array $app, array $holder, int $cents): void
    {
        $order = $this->wallets->createTopup($app, $holder, $cents, 'aaaaaaaaaaaaaaaa');
        self::$paypal->approve($order['orderId']);
        $this->assertSame('completed', $this->wallets->captureTopup($app, $holder, $order['orderId'])['status']);
    }

    private function ledger(array $app): array
    {
        $statement = self::$pdo->prepare('SELECT kind, amount_cents, balance_after, ref, charge_id FROM app_wallet_ledger WHERE app_id = ? ORDER BY created_at, id');
        $statement->execute([$app['id']]);
        return $statement->fetchAll(PDO::FETCH_ASSOC);
    }

    // ------------------------------------------------------------------ the charge

    #[DataProvider('runners')]
    public function testAChargeIsTheOwnersPriceTakenOnceAndTheAppActsOnTheSecondRun(string $runner): void
    {
        $this->boot($runner);
        $app = $this->app();
        $cookie = [];
        $first = $this->call($app, '/api/download', ['design' => 'd1'], $cookie);
        $this->assertSame([402, 'insufficient_funds', 0], [$first['status'], $first['body']['declined'] ?? null, $first['body']['balanceCents'] ?? null], json_encode($first));
        $holder = $this->visitorOf($cookie, $app['id']);
        $this->topUp($app, $holder, 200);
        // The owner lowers the price: the charge is theirs, never the 1 cent the app's answer named.
        $this->wallets->saveSettings($app, ['items' => ['download' => ['label' => 'Download a logo', 'priceCents' => 5], 'poster' => ['label' => 'A poster', 'priceCents' => 300]], 'routes' => ['/api/download'], 'purpose' => ''], ['prices' => ['download' => 4]], $this->ownerId);

        $paid = $this->call($app, '/api/download', ['design' => 'd1'], $cookie);
        $this->assertSame([200, 4, 196, false], [$paid['status'], $paid['body']['paid'] ?? null, $paid['body']['balanceCents'] ?? null, $paid['body']['alreadyPaid'] ?? null], json_encode($paid));
        $again = $this->call($app, '/api/download', ['design' => 'd1'], $cookie);
        $this->assertSame([200, true], [$again['status'], $again['body']['already'] ?? null], 'the app knows it sold it: nothing is asked');
        $this->assertSame(['topup', 'charge'], array_column($this->ledger($app), 'kind'));
        $this->assertSame([200, -4], array_map('intval', array_column($this->ledger($app), 'amount_cents')));
        $this->assertSame(0, (int) $this->native->withDatabase($app['id'], static fn(PDO $db) => $db->query('SELECT COUNT(*) FROM asked')->fetchColumn()), 'the ask wrote nothing');
        $context = $this->call($app, '/api/whoami', [], $cookie, 'GET')['body']['wallet'];
        $this->assertSame([true, 196, 'USD', ['download' => 4, 'poster' => 300]], [$context['available'], $context['balanceCents'], $context['currency'], $context['items']]);
    }

    public function testTheSameChargeIdIsNeverChargedTwiceAndAFailedSecondRunIsGivenBack(): void
    {
        $this->boot();
        $app = $this->app();
        $cookie = [];
        $this->call($app, '/api/whoami', [], $cookie, 'GET');
        $holder = $this->visitorOf($cookie, $app['id']);
        $this->topUp($app, $holder, 200);
        // The app lost its own record of the sale: the same charge id is paid already, not charged again.
        $this->call($app, '/api/download', ['design' => 'd2'], $cookie);
        $this->native->withDatabase($app['id'], static fn(PDO $db) => $db->exec('DELETE FROM purchases'));
        $retry = $this->call($app, '/api/download', ['design' => 'd2'], $cookie);
        $this->assertSame([200, true, 195], [$retry['status'], $retry['body']['alreadyPaid'] ?? null, $retry['body']['balanceCents'] ?? null]);

        foreach (['throw' => 500, 'status' => 503] as $how => $expected) {
            $failed = $this->call($app, '/api/download', ['design' => 'd-' . $how, 'failAfter' => $how], $cookie);
            $this->assertNotSame(200, $failed['status'] ?? $failed['http']);
            $this->assertSame(195, (int) ($this->wallets->wallet($app['id'], $holder, false)['balance_cents'] ?? 0), "{$how}: the charge was given back");
        }
        $kinds = array_column($this->ledger($app), 'kind');
        $this->assertSame(['topup', 'charge', 'charge', 'refund', 'charge', 'refund'], $kinds);
        // Bought again after a failure: a new charge, the next ref.
        $ok = $this->call($app, '/api/download', ['design' => 'd-status'], $cookie);
        $this->assertSame([200, 190], [$ok['status'], $ok['body']['balanceCents'] ?? null]);
        $lines = $this->ledger($app);
        $this->assertSame('download:d-status#2', end($lines)['ref'] ?? null);
        // A second ask in the second run is never charged, and the first is given back.
        $twice = $this->call($app, '/api/download', ['design' => 'd3', 'askAgain' => true], $cookie);
        $this->assertSame(500, $twice['status']);
        $this->assertSame(190, (int) $this->wallets->wallet($app['id'], $holder, false)['balance_cents']);
    }

    public function testDeclinesSayWhy(): void
    {
        $this->boot();
        $app = $this->app();
        $cookie = [];
        $this->call($app, '/api/whoami', [], $cookie, 'GET');
        $holder = $this->visitorOf($cookie, $app['id']);
        $this->topUp($app, $holder, 500);
        $this->assertSame('unknown_item', $this->call($app, '/api/download', ['design' => 'x', 'item' => 'video'], $cookie)['body']['declined'] ?? null);
        $this->assertSame('bad_charge', $this->call($app, '/api/download', ['design' => 'x', 'chargeId' => 'has spaces'], $cookie)['body']['declined'] ?? null);
        $this->site->save(['enabled' => true, 'packages' => [200, 500], 'maxChargeCents' => 500, 'dailyLimitCents' => 304]);
        $this->assertSame(200, $this->call($app, '/api/download', ['design' => 'p1', 'item' => 'poster'], $cookie)['status']);
        $this->assertSame('limit_reached', $this->call($app, '/api/download', ['design' => 'p2'], $cookie)['body']['declined'] ?? null, 'a wallet\'s day');
        $this->site->save(['enabled' => false]);
        $off = $this->call($app, '/api/download', ['design' => 'p3'], $cookie);
        $this->assertSame('payments_off', $off['body']['declined'] ?? null);
        $context = $this->call($app, '/api/whoami', [], $cookie, 'GET')['body']['wallet'];
        $this->assertSame([false, 'app_payments_off', 200], [$context['available'], $context['reason'], $context['balanceCents']]);
        // A route the manifest does not list never charges, whatever it answers.
        $this->site->save(['enabled' => true, 'packages' => [200]]);
        $free = $this->call($app, '/api/free', ['design' => 'z'], $cookie);
        $this->assertSame(402, $free['status']);
        $this->assertArrayHasKey('formlogicCharge', $free['body']);
        $this->assertSame(200, (int) $this->wallets->wallet($app['id'], $holder, false)['balance_cents']);
    }

    public function testOnlyAnAdministratorsAppTakesPaymentsAndNeverInTheBeta(): void
    {
        $this->boot('auto', false);
        $app = $this->app();
        $this->assertSame('owner_not_admin', $this->wallets->availability($app)['reason']);
        try {
            $this->wallets->saveSettings($app, ['items' => [], 'routes' => [], 'purpose' => ''], ['enabled' => true], $this->ownerId);
            $this->fail('turned on for a member\'s app');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('administrators', $e->getMessage());
        }
        self::$pdo->prepare('UPDATE users SET is_admin = 1 WHERE id = ?')->execute([$this->ownerId]);
        $this->assertTrue($this->wallets->availability($app)['available']);
        $beta = new AppWalletService(self::$mysql, $this->site, new PayPalService(['clientId' => 'a', 'secret' => 'b', 'baseUrl' => self::$paypal->base]), $this->platform, $this->visitors, true);
        $this->assertSame('beta', $beta->availability($app)['reason']);
        file_put_contents((new \ReflectionProperty(PlatformPlansService::class, 'path'))->getValue($this->platform), json_encode(array_replace(PlatformPlansService::defaults(), ['paymentsEnabled' => false])));
        $this->assertSame('payments_disabled', $this->wallets->availability($app)['reason']);
        try {
            $this->wallets->createTopup($app, ['kind' => 'visitor', 'id' => str_repeat('a', 32)], 200, 'bbbbbbbbbbbbbbbb');
            $this->fail('a top-up while payments are off');
        } catch (WalletRefusal $e) {
            $this->assertSame('payments_off', $e->reason);
        }
    }

    // ------------------------------------------------------------------ top-ups

    public function testATopUpIsCapturedOnceRecoveredWhenItsAnswerIsLostAndHeldToItsAmount(): void
    {
        $this->boot();
        $app = $this->app();
        $cookie = [];
        $this->call($app, '/api/whoami', [], $cookie, 'GET');
        $sheet = $this->wallet($app, 'GET', [], [], $cookie);
        $this->assertSame([200, true, 0, [200, 500]], [$sheet['http'], $sheet['body']['data']['available'], $sheet['body']['data']['balanceCents'], $sheet['body']['data']['packages']]);
        $this->assertSame('stub-client', $sheet['body']['data']['paypalClientId']);
        $this->assertSame(400, $this->wallet($app, 'POST', ['operation' => 'orders'], ['cents' => 300], $cookie)['http'], 'only the amounts offered');
        $order = $this->wallet($app, 'POST', ['operation' => 'orders'], ['cents' => 500], $cookie)['body']['data']['orderId'];
        $this->assertSame(['currency_code' => 'USD', 'value' => '5.00'], self::$paypal->orders()[$order]['amount']);
        $this->assertStringStartsWith('wallet:', (string) self::$paypal->orders()[$order]['custom_id']);
        self::$paypal->approve($order);
        $captured = $this->wallet($app, 'POST', ['operation' => 'orders', 'orderId' => $order], [], $cookie);
        $this->assertSame(['completed', 500], [$captured['body']['data']['status'], $captured['body']['data']['balanceCents']], json_encode($captured));
        $this->assertSame(true, $this->wallet($app, 'POST', ['operation' => 'orders', 'orderId' => $order], [], $cookie)['body']['data']['alreadyProcessed'] ?? null);
        $this->assertCount(1, array_filter($this->ledger($app), static fn($l) => $l['kind'] === 'topup'));
        // Another browser cannot capture this browser's order.
        $other = [];
        $this->call($app, '/api/whoami', [], $other, 'GET');
        $this->assertSame(404, $this->wallet($app, 'POST', ['operation' => 'orders', 'orderId' => $order], [], $other)['http']);

        // The capture's answer is lost: the top-up waits, and the retry (the same request id) credits it once.
        $lost = $this->wallet($app, 'POST', ['operation' => 'orders'], ['cents' => 200], $cookie)['body']['data']['orderId'];
        self::$paypal->approve($lost, 'lost');
        $this->assertSame(502, $this->wallet($app, 'POST', ['operation' => 'orders', 'orderId' => $lost], [], $cookie)['http']);
        $this->assertSame(700, $this->wallet($app, 'POST', ['operation' => 'orders', 'orderId' => $lost], [], $cookie)['body']['data']['balanceCents']);
        // A capture of another amount is not this top-up: never credited.
        $wrong = $this->wallet($app, 'POST', ['operation' => 'orders'], ['cents' => 200], $cookie)['body']['data']['orderId'];
        self::$paypal->approve($wrong, 'mismatch');
        $this->assertSame(502, $this->wallet($app, 'POST', ['operation' => 'orders', 'orderId' => $wrong], [], $cookie)['http']);
        $declined = $this->wallet($app, 'POST', ['operation' => 'orders'], ['cents' => 200], $cookie)['body']['data']['orderId'];
        self::$paypal->approve($declined, 'declined');
        $this->assertSame('declined', $this->wallet($app, 'POST', ['operation' => 'orders', 'orderId' => $declined], [], $cookie)['body']['code']);
        $this->assertSame(200, $this->wallet($app, 'POST', ['operation' => 'orders'], ['cents' => 200], $cookie)['http'], 'the fifth this hour');
        $this->assertSame(429, $this->wallet($app, 'POST', ['operation' => 'orders'], ['cents' => 200], $cookie)['http'], 'five top-ups an hour');
        $this->assertSame(700, (int) $this->wallets->wallet($app['id'], $this->visitorOf($cookie, $app['id']), false)['balance_cents']);
    }

    public function testWebhooksCreditAHeldPaymentTakeBackARefundAndHoldADispute(): void
    {
        $this->boot();
        $app = $this->app();
        $cookie = [];
        $this->call($app, '/api/whoami', [], $cookie, 'GET');
        $holder = $this->visitorOf($cookie, $app['id']);
        $_ENV['PAYPAL_WEBHOOK_ID'] = 'stub-webhook';
        $billing = new BillingController(new PayPalService(['clientId' => 'a', 'secret' => 'b', 'baseUrl' => self::$paypal->base]), self::$mysql, null, null, null, false, $this->platform, $this->wallets);
        $hook = function (array $event) use ($billing): int {
            $request = (new ServerRequestFactory())->createServerRequest('POST', self::ORIGIN . '/api/billing/webhook/paypal')->withParsedBody($event)->withHeader('PAYPAL-TRANSMISSION-SIG', 'stub-valid');
            return $billing->webhook($request, new Response())->getStatusCode();
        };
        // eCheck: PENDING at capture, completed by the webhook.
        $order = $this->wallets->createTopup($app, $holder, 500, 'cccccccccccccccc')['orderId'];
        self::$paypal->approve($order, 'pending');
        $this->assertSame('processing', $this->wallets->captureTopup($app, $holder, $order)['status']);
        $capture = 'STUBCAP' . substr($order, 9);
        $this->assertSame(200, $hook(['event_type' => 'PAYMENT.CAPTURE.COMPLETED', 'resource' => ['id' => $capture, 'status' => 'COMPLETED', 'amount' => ['currency_code' => 'USD', 'value' => '5.00']]]));
        $this->assertSame(500, (int) $this->wallets->wallet($app['id'], $holder, false)['balance_cents']);
        $this->assertSame(200, $hook(['event_type' => 'PAYMENT.CAPTURE.COMPLETED', 'resource' => ['id' => $capture, 'status' => 'COMPLETED', 'amount' => ['currency_code' => 'USD', 'value' => '5.00']]]), 'delivered twice');
        $this->assertSame(500, (int) $this->wallets->wallet($app['id'], $holder, false)['balance_cents']);
        // Spent, then refunded in PayPal: below zero, and held until a top-up settles it.
        $this->call($app, '/api/download', ['design' => 'd1'], $cookie);
        $refund = ['event_type' => 'PAYMENT.CAPTURE.REFUNDED', 'resource' => ['id' => 'REFUND1', 'amount' => ['currency_code' => 'USD', 'value' => '5.00'],
            'seller_payable_breakdown' => ['total_refunded_amount' => ['currency_code' => 'USD', 'value' => '5.00']], 'links' => [['rel' => 'up', 'href' => 'https://api-m.paypal.com/v2/payments/captures/' . $capture]]]];
        $this->assertSame(200, $hook($refund));
        $this->assertSame(200, $hook($refund), 'the same refund twice');
        $wallet = $this->wallets->wallet($app['id'], $holder, false);
        $this->assertSame([-5, 'blocked'], [(int) $wallet['balance_cents'], $wallet['status']]);
        $this->assertSame('wallet_blocked', $this->call($app, '/api/download', ['design' => 'd2'], $cookie)['body']['declined'] ?? null);
        $this->topUp($app, $holder, 200);
        $this->assertSame([195, 'active'], [(int) $this->wallets->wallet($app['id'], $holder, false)['balance_cents'], $this->wallets->wallet($app['id'], $holder, false)['status']]);
        // A dispute holds the wallet until it is resolved.
        $disputed = ['disputed_transactions' => [['seller_transaction_id' => 'STUBCAP' . substr((string) self::$pdo->query("SELECT order_id FROM app_wallet_topups WHERE app_id = " . self::$pdo->quote($app['id']) . " AND status = 'completed' ORDER BY created_at DESC LIMIT 1")->fetchColumn(), 9)]]];
        $this->assertSame(200, $hook(['event_type' => 'CUSTOMER.DISPUTE.CREATED', 'resource' => $disputed]));
        $this->assertSame('disputed', $this->wallets->wallet($app['id'], $holder, false)['status']);
        $this->assertSame('wallet_blocked', $this->call($app, '/api/download', ['design' => 'd3'], $cookie)['body']['declined'] ?? null);
        $this->assertSame(200, $hook(['event_type' => 'CUSTOMER.DISPUTE.RESOLVED', 'resource' => $disputed]));
        $this->assertSame('active', $this->wallets->wallet($app['id'], $holder, false)['status']);
        // An event about no top-up of ours is left to cloud billing, as before.
        $this->assertSame(200, $hook(['event_type' => 'PAYMENT.CAPTURE.COMPLETED', 'resource' => ['id' => 'NOT-OURS', 'amount' => ['currency_code' => 'USD', 'value' => '1.00']]]));
        $this->assertSame(400, (function () use ($billing) {
            $request = (new ServerRequestFactory())->createServerRequest('POST', self::ORIGIN . '/api/billing/webhook/paypal')->withParsedBody(['event_type' => 'PAYMENT.CAPTURE.COMPLETED', 'resource' => []])->withHeader('PAYPAL-TRANSMISSION-SIG', 'forged');
            return $billing->webhook($request, new Response())->getStatusCode();
        })(), 'a webhook PayPal did not sign');
        unset($_ENV['PAYPAL_WEBHOOK_ID']);
    }

    // ------------------------------------------------------------------ email restore

    public function testABalanceSavedUnderAnEmailComesToAnotherBrowser(): void
    {
        $this->boot();
        $app = $this->app();
        $first = [];
        $this->call($app, '/api/whoami', [], $first, 'GET');
        $this->topUp($app, $this->visitorOf($first, $app['id']), 500);
        $this->assertSame(202, $this->wallet($app, 'POST', ['operation' => 'email'], ['purpose' => 'save', 'email' => 'Buyer@Example.com '], $first)['http']);
        $code = $this->mail[0]['code'];
        $this->assertSame('buyer@example.com', $this->mail[0]['to']);
        $this->assertSame(400, $this->wallet($app, 'POST', ['operation' => 'confirm'], ['purpose' => 'save', 'email' => 'buyer@example.com', 'code' => $code === '000000' ? '111111' : '000000'], $first)['http']);
        $this->assertSame(200, $this->wallet($app, 'POST', ['operation' => 'confirm'], ['purpose' => 'save', 'email' => 'buyer@example.com', 'code' => $code], $first)['http']);
        $this->assertNotNull($this->wallets->wallet($app['id'], $this->visitorOf($first, $app['id']), false)['email_hash']);
        $this->assertStringNotContainsString('buyer@example.com', (string) json_encode(self::$pdo->query('SELECT * FROM app_wallets WHERE app_id = ' . self::$pdo->quote($app['id']))->fetchAll(PDO::FETCH_ASSOC)), 'the address itself is never kept');

        // Another browser, with a balance of its own, brings the saved one here.
        $second = [];
        $this->call($app, '/api/whoami', [], $second, 'GET');
        $this->topUp($app, $this->visitorOf($second, $app['id']), 200);
        $this->wallet($app, 'POST', ['operation' => 'email'], ['purpose' => 'restore', 'email' => 'nobody@example.com'], $second);
        $this->assertCount(1, $this->mail, 'no wallet under that email: nothing is sent, and the answer is the same');
        $this->assertSame(202, $this->wallet($app, 'POST', ['operation' => 'email'], ['purpose' => 'restore', 'email' => 'buyer@example.com'], $second)['http']);
        $restored = $this->wallet($app, 'POST', ['operation' => 'confirm'], ['purpose' => 'restore', 'email' => 'buyer@example.com', 'code' => $this->mail[1]['code']], $second);
        $this->assertSame(700, $restored['body']['data']['balanceCents'], 'both balances, in one wallet');
        $this->assertSame(
            $this->wallets->wallet($app['id'], $this->visitorOf($first, $app['id']), false)['id'],
            $this->wallets->wallet($app['id'], $this->visitorOf($second, $app['id']), false)['id'],
        );
        $kinds = array_column($this->ledger($app), 'kind');
        $this->assertContains('transfer_out', $kinds);
        $this->assertContains('transfer_in', $kinds);
        $joined = $this->wallets->wallet($app['id'], $this->visitorOf($second, $app['id']), false)['id'];
        $this->assertSame([$joined], array_values(array_unique(self::$pdo->query('SELECT wallet_id FROM app_wallet_topups WHERE app_id = ' . self::$pdo->quote($app['id']))->fetchAll(PDO::FETCH_COLUMN))), 'a refund of either top-up takes it back from the wallet the money went to');
        // Five wrong codes, and that code is spent.
        $this->wallet($app, 'POST', ['operation' => 'email'], ['purpose' => 'save', 'email' => 'buyer@example.com'], $second);
        for ($i = 0; $i < 5; $i++) $this->wallet($app, 'POST', ['operation' => 'confirm'], ['purpose' => 'save', 'email' => 'buyer@example.com', 'code' => '99999' . $i], $second);
        $this->assertSame(400, $this->wallet($app, 'POST', ['operation' => 'confirm'], ['purpose' => 'save', 'email' => 'buyer@example.com', 'code' => end($this->mail)['code']], $second)['http']);
    }

    public function testTheWalletNeedsFormLogicsMarkedRequest(): void
    {
        $this->boot();
        $app = $this->app();
        $request = (new ServerRequestFactory())->createServerRequest('GET', self::ORIGIN . '/api/app/' . $app['slug'] . '/wallet', ['REMOTE_ADDR' => self::IP])->withHeader('Origin', 'https://elsewhere.example');
        $this->assertSame(403, $this->controller->wallet($request, new Response(), ['slug' => $app['slug']])->getStatusCode());
    }

    private static function removeTree(string $path): void
    {
        if (!is_dir($path)) { @unlink($path); return; }
        foreach (new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($path, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST) as $entry) {
            $entry->isDir() && !$entry->isLink() ? @rmdir($entry->getPathname()) : @unlink($entry->getPathname());
        }
        @rmdir($path);
    }
}

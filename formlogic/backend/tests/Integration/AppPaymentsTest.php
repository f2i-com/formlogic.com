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

    private function boot(string $runner = 'auto', bool $admin = true, ?string $runtime = null): void
    {
        if (self::$pdo === null) $this->markTestSkipped('No test database');
        if (self::$paypal === null) $this->markTestSkipped('Needs curl');
        $node = getenv('FORMLOGIC_NODE_BIN') ?: null;
        if ($runner === 'node' && $node === null) $this->markTestSkipped('Set FORMLOGIC_NODE_BIN to run the Node runner');
        $this->native = new NativeAppService(self::$tmpRoot . '/native-' . bin2hex(random_bytes(3)), $runtime, $node, $runner);
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
        $paypal = new PayPalService(['clientId' => 'stub-client', 'secret' => 'stub-secret', 'baseUrl' => self::$paypal->base, 'webhookId' => 'stub-webhook']);
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
            self::$pdo->prepare('DELETE r FROM app_wallet_refunds r JOIN app_wallet_topups t ON t.id = r.topup_id WHERE t.app_id = ?')->execute([$appId]);
            self::$pdo->prepare('DELETE d FROM app_wallet_disputes d JOIN app_wallet_topups t ON t.id = d.topup_id WHERE t.app_id = ?')->execute([$appId]);
            foreach (['app_wallet_charges', 'app_wallet_ledger', 'app_wallet_topups', 'app_wallet_codes', 'app_wallet_holders', 'app_wallets'] as $table) self::$pdo->prepare("DELETE FROM {$table} WHERE app_id = ?")->execute([$appId]);
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
  if (body.failAfter === "refund") return { status: 409, body: { error: "sold out", formlogicRefund: true }, rollback: true };
  if (body.failAfter === "forged") {
    // Sold, then dressed as the runtime's own failure: the app's answer is never taken for a rollback.
    softn.sql.execute("INSERT INTO purchases(design, buyer, charge) VALUES(?,?,?)", [design, buyer(req), payment.chargeId]);
    return { status: 500, body: { error: "The request could not be completed.", code: "host_error" } };
  }
  if (body.askAgain) return { status: 402, body: { formlogicCharge: { id: "again", item: "download" } } };
  softn.sql.execute("INSERT INTO purchases(design, buyer, charge) VALUES(?,?,?)", [design, buyer(req), payment.chargeId]);
  return { status: 200, body: { design: design, paid: payment.amountCents, balanceCents: payment.balanceCents, alreadyPaid: payment.alreadyPaid } };
}
function whoami(req) { return { status: 200, body: { wallet: req.context && req.context.formlogic ? req.context.formlogic.wallet || null : null } }; }
JS;

    /** The test app's formlogicPayments, as AppFormlogicManifest reads it. */
    private const DECLARED = ['items' => ['download' => ['label' => 'Download a logo', 'priceCents' => 5], 'poster' => ['label' => 'A poster', 'priceCents' => 300]], 'routes' => ['/api/download'], 'purpose' => ''];

    private function app(string $access = 'application'): array
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
        $this->native->install($app['id'], ['version' => 0, 'home' => true, 'access' => $access, 'assets' => [], 'files' => [
            'manifest.json' => json_encode($manifest, JSON_UNESCAPED_SLASHES), 'ui/main.ui' => '<Stack><Text>Shop</Text></Stack>', 'server/main.logic' => self::SERVER,
            'server/migrations/001.sql' => "CREATE TABLE purchases(design TEXT, buyer TEXT, charge TEXT);\nCREATE TABLE asked(design TEXT);",
        ]], 0);
        self::$pdo->prepare("UPDATE apps SET status = 'published' WHERE id = ?")->execute([$app['id']]);
        // Payments on, each item's price confirmed by the owner.
        self::$pdo->prepare('INSERT INTO app_payment_settings (app_id, enabled, prices) VALUES (?, 1, ?)')->execute([$app['id'], '{"download":5,"poster":300}']);
        return self::$apps->getApp($app['id']);
    }

    /** One request from the app's page as a visitor whose browser holds $cookie (a new one when empty). */
    private function call(array $app, string $path, array $body = [], array &$cookie = [], string $method = 'POST', ?string $user = null): array
    {
        $payload = ['method' => $method, 'path' => $path, 'query' => [], 'headers' => [], 'body' => $body === [] ? new \stdClass() : $body];
        $request = (new ServerRequestFactory())->createServerRequest('POST', self::ORIGIN . '/api/app/' . $app['slug'] . '/native/request', ['REMOTE_ADDR' => self::IP])
            ->withHeader('Host', '127.0.0.1:8300')->withHeader('Content-Type', 'application/json')->withHeader(AppVisitors::HEADER, '1')->withHeader('Origin', self::ORIGIN)
            ->withCookieParams($cookie)->withParsedBody(json_decode((string) json_encode($payload), true));
        $request->getBody()->write((string) json_encode($payload));
        if ($user !== null) $request = $request->withAttribute('userId', $user)->withAttribute('user', new \FormLogic\Models\User(id: $user, email: $user . '@test.local'));
        $response = $this->controller->runtime($request, new Response(), ['slug' => $app['slug']]);
        if (preg_match('/formlogic_visitor=([^;]+)/', $response->getHeaderLine('Set-Cookie'), $m)) $cookie = [AppVisitors::COOKIE => $m[1]];
        $data = json_decode((string) $response->getBody(), true);
        return ['http' => $response->getStatusCode(), 'status' => $data['result']['status'] ?? null, 'body' => $data['result']['body'] ?? $data];
    }

    /** The visitor's wallet sheet operations, as FormLogic's own page sends them; $site: another site's controller than this test's own. */
    private function wallet(array $app, string $method, array $args = [], array $body = [], array $cookie = [], ?NativeAppController $site = null): array
    {
        $request = (new ServerRequestFactory())->createServerRequest($method, self::ORIGIN . '/api/app/' . $app['slug'] . '/wallet', ['REMOTE_ADDR' => self::IP])
            ->withHeader(AppVisitors::HEADER, '1')->withHeader('Origin', self::ORIGIN)->withCookieParams($cookie)->withParsedBody($body);
        $response = ($site ?? $this->controller)->wallet($request, new Response(), ['slug' => $app['slug']] + $args);
        return ['http' => $response->getStatusCode(), 'body' => json_decode((string) $response->getBody(), true)];
    }

    /**
     * The controller of a site set up as the environment says, its PayPal made as public/index.php
     * makes the site's own (`new PayPalService()`: every setting from the environment, none from the
     * code), over this test's database and apps.
     */
    private function siteFromEnvironment(): NativeAppController
    {
        $wallets = new AppWalletService(self::$mysql, $this->site, new PayPalService(), $this->platform, $this->visitors);
        $flows = new FlowService(self::$mysql);
        return new NativeAppController(self::$apps, $this->createMock(AppUserService::class), $this->native, $this->createMock(PlanService::class), $flows, $this->createMock(RuntimeEngineService::class),
            null, null, null, null, new NativeRecordEventRouter($flows, null), $this->visitors, null, $wallets, new NativeAppCharges($wallets));
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

    /** M1: only a second run that committed nothing is given back; any other answer keeps the charge for a retry. */
    #[DataProvider('runners')]
    public function testTheSameChargeIdIsNeverChargedTwiceAndOnlyARunThatCommittedNothingIsGivenBack(string $runner): void
    {
        $this->boot($runner);
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

        // Given back: a run that threw (the runner rolled it back), and one that said so with rollback.
        foreach (['throw' => [500, 'host_error'], 'refund' => [409, null]] as $how => [$expected, $code]) {
            $failed = $this->call($app, '/api/download', ['design' => 'd-' . $how, 'failAfter' => $how], $cookie);
            $this->assertSame([$expected, $code], [$failed['status'], $failed['body']['code'] ?? null], $how . ': ' . json_encode($failed));
            $this->assertSame(195, (int) ($this->wallets->wallet($app['id'], $holder, false)['balance_cents'] ?? 0), "{$how}: the charge was given back");
        }
        // Not 2xx, but it may have written the sale: the charge stands, and the retry is told it is paid.
        $kept = $this->call($app, '/api/download', ['design' => 'd-status', 'failAfter' => 'status'], $cookie);
        $this->assertSame(503, $kept['status']);
        $this->assertSame(190, (int) $this->wallets->wallet($app['id'], $holder, false)['balance_cents']);
        $retry = $this->call($app, '/api/download', ['design' => 'd-status'], $cookie);
        $this->assertSame([200, true, 190], [$retry['status'], $retry['body']['alreadyPaid'] ?? null, $retry['body']['balanceCents'] ?? null]);
        $this->assertSame(['topup', 'charge', 'charge', 'refund', 'charge', 'refund', 'charge'], array_column($this->ledger($app), 'kind'));
        // Bought again after one was given back: a new charge, the next ref.
        $ok = $this->call($app, '/api/download', ['design' => 'd-throw'], $cookie);
        $this->assertSame([200, 185], [$ok['status'], $ok['body']['balanceCents'] ?? null]);
        $lines = $this->ledger($app);
        $this->assertSame('download:d-throw#2', end($lines)['ref'] ?? null);
        // A second ask in the second run is never charged, and the first is given back.
        $twice = $this->call($app, '/api/download', ['design' => 'd3', 'askAgain' => true], $cookie);
        $this->assertSame(500, $twice['status']);
        $this->assertSame(185, (int) $this->wallets->wallet($app['id'], $holder, false)['balance_cents']);
        // N2: an answer that looks like the runtime's rollback, written by the app after it sold: kept.
        $forged = $this->call($app, '/api/download', ['design' => 'd-forged', 'failAfter' => 'forged'], $cookie);
        $this->assertSame([500, 'host_error', 180], [$forged['status'], $forged['body']['code'] ?? null, (int) $this->wallets->wallet($app['id'], $holder, false)['balance_cents']], 'the app wrote the sale: the charge stands');
        $this->assertSame([200, true], [($owned = $this->call($app, '/api/download', ['design' => 'd-forged'], $cookie))['status'], $owned['body']['already'] ?? null]);
        $this->assertSame(0, (int) self::$pdo->query("SELECT COUNT(*) FROM app_wallet_charges WHERE state IN ('pending', 'running') AND app_id = " . self::$pdo->quote($app['id']))->fetchColumn(), 'every charge settled or given back');
    }

    /**
     * A copy of the bundled runtime, for Node, whose engine fails as it is disposed of once a paid
     * run asked to with `failAfter: "dispose"` has committed: what a failing dispose does to the real
     * one (wasm-host.mjs, the `finally` of a host's invoke). Null when the runtime no longer has it.
     */
    private function runtimeThatFailsAfterTheCommit(): ?string
    {
        $bundled = dirname(__DIR__, 2) . '/resources/softn-native';
        $copy = self::$tmpRoot . '/runtime-late-' . bin2hex(random_bytes(3));
        $disposes = 'if (engine) { try { engine.dispose(); } finally { engine.free(); } }';
        $host = is_file($bundled . '/wasm-host.mjs') ? (string) file_get_contents($bundled . '/wasm-host.mjs') : '';
        if (substr_count($host, $disposes) !== 1) return null;
        foreach (new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($bundled, \FilesystemIterator::SKIP_DOTS)) as $file) {
            $relative = str_replace('\\', '/', substr($file->getPathname(), strlen($bundled) + 1));
            // Node runs it: the runner binaries stay behind.
            if (str_starts_with($relative, 'bin/')) continue;
            if (!is_dir(dirname($copy . '/' . $relative))) mkdir(dirname($copy . '/' . $relative), 0700, true);
            copy($file->getPathname(), $copy . '/' . $relative);
        }
        file_put_contents($copy . '/wasm-host.mjs', str_replace($disposes, $disposes . ' if (context?.formlogic?.payment?.status === "paid" && request?.body?.failAfter === "dispose") throw new Error("engine dispose failed");', $host));
        return $copy;
    }

    /**
     * Under Node the runtime's `request_integration` stage lasts through the handler and what follows
     * its COMMIT. A run that fails there after the app committed the sale is answered 503 with that
     * stage's line on the error channel: that is not the runtime's word that nothing was committed,
     * so the charge stands, and the retry is served what was bought.
     */
    public function testARunThatFailsAfterItsCommitKeepsItsCharge(): void
    {
        $runtime = $this->runtimeThatFailsAfterTheCommit();
        if ($runtime === null) $this->markTestSkipped('The bundled wasm-host.mjs disposes of its engine another way now: read it again.');
        $this->boot('node', true, $runtime);
        $app = $this->app();
        $cookie = [];
        $this->call($app, '/api/whoami', [], $cookie, 'GET');
        $holder = $this->visitorOf($cookie, $app['id']);
        $this->topUp($app, $holder, 200);
        $late = $this->call($app, '/api/download', ['design' => 'd-late', 'failAfter' => 'dispose'], $cookie);
        $this->assertSame([503, 'backend_unavailable', 'request_integration'], [$late['status'], $late['body']['code'] ?? null, $late['body']['diagnostic'] ?? null], json_encode($late));
        $this->assertFalse($this->native->lastRunRolledBack(), 'request_integration says nothing about what was committed');
        $this->assertSame(1, (int) $this->native->withDatabase($app['id'], static fn(PDO $db) => $db->query("SELECT COUNT(*) FROM purchases WHERE design = 'd-late'")->fetchColumn()), 'the app committed the sale');
        $this->assertSame([195, 'settled'], [(int) $this->wallets->wallet($app['id'], $holder, false)['balance_cents'], self::$pdo->query("SELECT state FROM app_wallet_charges WHERE charge_id = 'download:d-late' AND app_id = " . self::$pdo->quote($app['id']))->fetchColumn()], 'so the charge stands');
        $this->assertNotContains('refund', array_column($this->ledger($app), 'kind'));
        $retry = $this->call($app, '/api/download', ['design' => 'd-late'], $cookie);
        $this->assertSame([200, true, 195], [$retry['status'], $retry['body']['already'] ?? null, (int) $this->wallets->wallet($app['id'], $holder, false)['balance_cents']], 'the retry is served what was bought, and pays nothing more');
        // The runtime's own rollback is still given back by the same runtime: a handler that threw.
        $thrown = $this->call($app, '/api/download', ['design' => 'd-thrown', 'failAfter' => 'throw'], $cookie);
        $this->assertSame([500, 'host_error', true, 195], [$thrown['status'], $thrown['body']['code'] ?? null, $this->native->lastRunRolledBack(), (int) $this->wallets->wallet($app['id'], $holder, false)['balance_cents']]);
    }

    /** M1: a second run that throws is given back only when it never started; a timeout may have committed, and keeps it. */
    public function testASecondRunThatThrowsIsGivenBackOnlyWhenItNeverStarted(): void
    {
        $this->boot();
        $app = $this->app();
        $cookie = [];
        $this->call($app, '/api/whoami', [], $cookie, 'GET');
        $holder = $this->visitorOf($cookie, $app['id']);
        $this->topUp($app, $holder, 200);
        $charges = new NativeAppCharges($this->wallets);
        foreach ([
            ['download:t1', new \RuntimeException('The app was updated while this request was in flight. Reload and try again.', 409), 'refunded'],
            ['download:t2', new \RuntimeException('Native runtime could not start', 503), 'refunded'],
            ['download:t3', new \RuntimeException('Native request timed out'), 'settled'],
            ['download:t4', new \RuntimeException('Native runtime returned no response'), 'settled'],
        ] as [$id, $thrown, $state]) {
            $runs = 0;
            $run = static function (array $identity) use (&$runs, $id, $thrown): array {
                if (++$runs === 1) return ['status' => 402, 'body' => ['formlogicCharge' => ['id' => $id, 'item' => 'download']]];
                throw $thrown;
            };
            try {
                $charges->handle($app, self::DECLARED, $holder, ['formlogic' => ['appId' => $app['id']]], $run);
                $this->fail('the second run threw');
            } catch (\RuntimeException $e) {
                $this->assertSame($thrown, $e, 'the page is told what went wrong');
            }
            $this->assertSame($state, self::$pdo->query('SELECT state FROM app_wallet_charges WHERE charge_id = ' . self::$pdo->quote($id))->fetchColumn(), $thrown->getMessage());
        }
        $this->assertSame(190, (int) $this->wallets->wallet($app['id'], $holder, false)['balance_cents'], 'the two that never ran given back; the two that may have committed kept');
        $retry = $this->wallets->charge($app, self::DECLARED, $holder, 'download:t3', 'download');
        $this->assertSame([true, 190], [$retry['alreadyPaid'], $retry['balanceCents']], 'and a retry delivers without paying again');
    }

    /** H1, M2: a charge being paid is in progress for any other request, never paid; another item under its id is a conflict. */
    public function testAChargeBeingPaidIsInProgressElsewhereAndASettledOneIsPaidForItsOwnItemOnly(): void
    {
        $this->boot();
        $app = $this->app();
        $cookie = [];
        $this->call($app, '/api/whoami', [], $cookie, 'GET');
        $holder = $this->visitorOf($cookie, $app['id']);
        $this->topUp($app, $holder, 200);
        $paid = $this->wallets->charge($app, self::DECLARED, $holder, 'download:x', 'download');
        $this->assertSame(['paid', false, 195], [$paid['status'], $paid['alreadyPaid'], $paid['balanceCents']]);
        $this->assertSame(['declined', 'in_progress'], [($again = $this->wallets->charge($app, self::DECLARED, $holder, 'download:x', 'download'))['status'], $again['code'] ?? null], 'not told it is paid while the first is unfinished');
        $this->assertSame('charge_conflict', $this->wallets->charge($app, self::DECLARED, $holder, 'download:x', 'poster')['code'] ?? null);
        $this->wallets->settleCharge($paid['charge']);
        $settled = $this->wallets->charge($app, self::DECLARED, $holder, 'download:x', 'download');
        $this->assertSame(['paid', true, 5, 195], [$settled['status'], $settled['alreadyPaid'], $settled['amountCents'], $settled['balanceCents']]);
        $poster = $this->wallets->charge($app, self::DECLARED, $holder, 'download:x', 'poster');
        $this->assertSame(['declined', 'charge_conflict'], [$poster['status'], $poster['code'] ?? null], 'never the 300 cent poster on a 5 cent payment');
        $this->assertFalse($this->wallets->refundCharge($paid['charge'], 'too late'), 'a settled charge is never given back');
        $this->assertSame(195, (int) $this->wallets->wallet($app['id'], $holder, false)['balance_cents']);
    }

    /** L7: a charge a dead request left pending is given back, once, and the id can be bought again. */
    public function testAChargeLeftPendingByARequestThatDiedIsGivenBack(): void
    {
        $this->boot();
        $app = $this->app();
        $cookie = [];
        $this->call($app, '/api/whoami', [], $cookie, 'GET');
        $holder = $this->visitorOf($cookie, $app['id']);
        $this->topUp($app, $holder, 200);
        $paid = $this->wallets->charge($app, self::DECLARED, $holder, 'download:dead', 'download');
        $wallet = (string) $this->wallets->wallet($app['id'], $holder, false)['id'];
        $this->assertSame(['refunded' => 0, 'settled' => 0], $this->wallets->sweepStale($wallet), 'not yet stale');
        $this->stale($paid['charge']);
        $again = $this->wallets->charge($app, self::DECLARED, $holder, 'download:dead', 'download');
        $this->assertSame(['paid', false, 195], [$again['status'], $again['alreadyPaid'], $again['balanceCents']], 'the stale one given back first, then charged anew');
        $this->assertSame(['refunded', 'pending'], [
            self::$pdo->query('SELECT state FROM app_wallet_charges WHERE id = ' . self::$pdo->quote($paid['charge']))->fetchColumn(),
            self::$pdo->query('SELECT state FROM app_wallet_charges WHERE id = ' . self::$pdo->quote($again['charge']))->fetchColumn(),
        ]);
        $this->assertSame(['refunded' => 0, 'settled' => 0], $this->wallets->sweepStale($wallet));
    }

    /** A charge as a request that died fifteen minutes ago left it. */
    private function stale(string $charge): void
    {
        $then = \FormLogic\Services\AppAiService::stamp(time() - AppWalletService::STALE_CHARGE_SECONDS - 60);
        self::$pdo->prepare('UPDATE app_wallet_charges SET created_at = ?, updated_at = ? WHERE id = ?')->execute([$then, $then, $charge]);
    }

    /** N1: once its second run has started, a charge whose request dies is settled by the sweeper, never given back. */
    public function testAChargeWhoseSecondRunStartedIsSettledNotGivenBackWhenItsRequestDies(): void
    {
        $this->boot();
        $app = $this->app();
        $cookie = [];
        $this->call($app, '/api/whoami', [], $cookie, 'GET');
        $holder = $this->visitorOf($cookie, $app['id']);
        $this->topUp($app, $holder, 200);
        $wallet = (string) $this->wallets->wallet($app['id'], $holder, false)['id'];
        $ran = $this->wallets->charge($app, self::DECLARED, $holder, 'download:ran', 'download');
        $this->assertTrue($this->wallets->startCharge($ran['charge']));
        $this->assertFalse($this->wallets->startCharge($ran['charge']), 'started once');
        $this->assertSame('in_progress', $this->wallets->charge($app, self::DECLARED, $holder, 'download:ran', 'download')['code'] ?? null, 'running: in progress for anyone else');
        // The PHP worker dies here; the runner it started may still commit the sale. Fifteen minutes on:
        $this->stale($ran['charge']);
        $this->assertSame(['refunded' => 0, 'settled' => 1], $this->wallets->sweepStale($wallet));
        $this->assertSame('settled', self::$pdo->query('SELECT state FROM app_wallet_charges WHERE id = ' . self::$pdo->quote($ran['charge']))->fetchColumn());
        $this->assertSame(195, (int) $this->wallets->wallet($app['id'], $holder, false)['balance_cents']);
        $this->assertNotContains('refund', array_column($this->ledger($app), 'kind'));
        $this->assertTrue($this->wallets->charge($app, self::DECLARED, $holder, 'download:ran', 'download')['alreadyPaid'], 'a retry delivers it');
        // One whose second run never started is still given back.
        $never = $this->wallets->charge($app, self::DECLARED, $holder, 'download:never', 'download');
        $this->stale($never['charge']);
        $this->assertSame(['refunded' => 1, 'settled' => 0], $this->wallets->sweepStale($wallet));
        $this->assertSame(195, (int) $this->wallets->wallet($app['id'], $holder, false)['balance_cents']);
        $this->assertFalse($this->wallets->startCharge($never['charge']), 'a run that comes after it was given back is told nothing was paid');
    }

    /** L5: an item the owner has not confirmed a price for is not sold. */
    public function testAnItemTheOwnerHasNotConfirmedIsNotSold(): void
    {
        $this->boot();
        $app = $this->app();
        self::$pdo->prepare('UPDATE app_payment_settings SET prices = ? WHERE app_id = ?')->execute(['{"download":5}', $app['id']]);
        $cookie = [];
        $context = $this->call($app, '/api/whoami', [], $cookie, 'GET')['body']['wallet'];
        $this->assertSame(['download' => 5], $context['items'], 'only confirmed items are offered');
        $holder = $this->visitorOf($cookie, $app['id']);
        $this->topUp($app, $holder, 500);
        $this->assertSame('price_unconfirmed', $this->wallets->charge($app, self::DECLARED, $holder, 'poster:1', 'poster')['code'] ?? null);
        $this->assertSame(['poster' => 300], $this->wallets->settings($app['id'], self::DECLARED)['unconfirmed']);
        $this->wallets->saveSettings($app, self::DECLARED, ['prices' => ['poster' => 250]], $this->ownerId);
        $this->assertSame([], $this->wallets->settings($app['id'], self::DECLARED)['unconfirmed']);
        $this->assertSame(['paid', 250], [($sold = $this->wallets->charge($app, self::DECLARED, $holder, 'poster:1', 'poster'))['status'], $sold['amountCents']]);
    }

    /** H1: both runs of a charge run in one worker slot, held from the first to the last. */
    public function testBothRunsOfAChargeHoldOneWorkerSlot(): void
    {
        $this->boot();
        $app = $this->app();
        $before = [getenv('NATIVE_WORKERS_PER_APP'), $_ENV['NATIVE_WORKERS_PER_APP'] ?? null];
        putenv('NATIVE_WORKERS_PER_APP=1');
        $_ENV['NATIVE_WORKERS_PER_APP'] = '1';
        try {
            $ping = ['method' => 'GET', 'path' => '/api/whoami', 'query' => (object) [], 'body' => (object) [], 'headers' => (object) [], 'client_ip' => '127.0.0.1', 'photos' => false];
            $other = new NativeAppService((new \ReflectionProperty(NativeAppService::class, 'storagePath'))->getValue($this->native), null, getenv('FORMLOGIC_NODE_BIN') ?: null);
            $seen = $this->native->withSlots($app['id'], function () use ($app, $ping, $other): array {
                $answers = [$this->native->request($app['id'], $ping)['status'], $this->native->request($app['id'], $ping)['status']];
                $started = microtime(true);
                try {
                    $other->request($app['id'], $ping);
                    $answers[] = 'served';
                } catch (\RuntimeException $e) {
                    $answers[] = $e->getCode();
                }
                $answers[] = microtime(true) - $started >= 2.5;
                return $answers;
            });
            $this->assertSame([200, 200, 429, true], $seen, 'the runs inside take the held slot; anyone else waits for it, then is turned away');
            $this->assertSame(200, $other->request($app['id'], $ping)['status'], 'and it is free again once the work ends');
        } finally {
            $before[0] === false ? putenv('NATIVE_WORKERS_PER_APP') : putenv('NATIVE_WORKERS_PER_APP=' . $before[0]);
            if ($before[1] === null) unset($_ENV['NATIVE_WORKERS_PER_APP']); else $_ENV['NATIVE_WORKERS_PER_APP'] = $before[1];
        }
    }

    /** M3, M4: a stand-in PayPal is refused outside development, and payments need the webhook. */
    public function testAStandInPayPalIsRefusedOutsideDevelopmentAndPaymentsNeedTheWebhook(): void
    {
        $this->boot();
        $app = $this->app();
        $before = [$_ENV['APP_ENV'] ?? null, $_ENV['PAYPAL_BASE_URL'] ?? null];
        $wallets = fn(PayPalService $paypal) => new AppWalletService(self::$mysql, $this->site, $paypal, $this->platform, $this->visitors);
        $base = static fn(PayPalService $paypal): string => (new \ReflectionProperty(PayPalService::class, 'baseUrl'))->getValue($paypal);
        try {
            $_ENV['PAYPAL_BASE_URL'] = self::$paypal->base;
            foreach (['production', 'staging', 'prod', 'Production', 'Development', 'test', ''] as $env) {
                $_ENV['APP_ENV'] = $env;
                $paypal = new PayPalService(['clientId' => 'a', 'secret' => 'b', 'webhookId' => 'w']);
                $this->assertSame([true, 'https://api-m.sandbox.paypal.com'], [$paypal->standInRefused(), $base($paypal)], "APP_ENV={$env}");
                $this->assertFalse($paypal->standIn(), "APP_ENV={$env}: no stand-in, so no stand-in button and nothing to approve an order with");
                $this->assertSame('paypal_unconfigured', $wallets($paypal)->availability($app)['reason'], "APP_ENV={$env}: payments are unavailable, never sent to the stand-in");
            }
            $_ENV['APP_ENV'] = 'development';
            $paypal = new PayPalService(['clientId' => 'a', 'secret' => 'b', 'webhookId' => 'w']);
            $this->assertSame([false, self::$paypal->base], [$paypal->standInRefused(), $base($paypal)]);
            $this->assertTrue($paypal->standIn(), 'exactly development: the stand-in is used, and a person can pay through it');
            $this->assertTrue($wallets($paypal)->availability($app)['available']);
            $this->assertSame('paypal_unconfigured', $wallets(new PayPalService(['clientId' => 'a', 'secret' => 'b', 'webhookId' => '']))->availability($app)['reason'], 'no webhook: refunds and disputes would never reach a wallet');
        } finally {
            foreach (['APP_ENV' => $before[0], 'PAYPAL_BASE_URL' => $before[1]] as $name => $value) {
                if ($value === null) unset($_ENV[$name]); else $_ENV[$name] = $value;
            }
        }
    }

    /** A members app's wallet is the member's, and one app's balance is never another's. */
    public function testAMembersWalletIsTheirsAndAppsAreKeptApart(): void
    {
        $this->boot();
        $members = $this->app('members');
        $owner = ['kind' => 'user', 'id' => $this->ownerId];
        $this->topUp($members, $owner, 200);
        $none = [];
        $bought = $this->call($members, '/api/download', ['design' => 'm1'], $none, 'POST', $this->ownerId);
        $this->assertSame([200, 195], [$bought['status'], $bought['body']['balanceCents'] ?? null], json_encode($bought));
        $this->assertSame('user:' . substr($this->ownerId, 0, 40), self::$pdo->query("SELECT actor FROM app_wallet_ledger WHERE kind = 'charge' AND app_id = " . self::$pdo->quote($members['id']))->fetchColumn());
        // Another app: the same person has nothing there, and its orders are not theirs to capture.
        $other = $this->app('members');
        $this->assertSame('insufficient_funds', $this->wallets->charge($other, self::DECLARED, $owner, 'download:m1', 'download')['code'] ?? null);
        $order = self::$pdo->query('SELECT order_id FROM app_wallet_topups WHERE app_id = ' . self::$pdo->quote($members['id']))->fetchColumn();
        try {
            $this->wallets->captureTopup($other, $owner, (string) $order);
            $this->fail('another app\'s top-up');
        } catch (WalletRefusal $e) {
            $this->assertSame('not_found', $e->reason);
        }
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

    /**
     * A person can pay on a development site, in a real browser: where a stand-in answers for PayPal
     * the sheet says so, and FormLogic approves the person's own order at the stand-in, which is what
     * they would do in PayPal's own window (PayPal's script knows nothing of a stand-in's orders).
     * Where PayPal is PayPal there is no such thing.
     */
    public function testOnADevelopmentSiteAPersonPaysThroughTheStandIn(): void
    {
        $this->boot();
        $app = $this->app();
        $cookie = [];
        $this->call($app, '/api/whoami', [], $cookie, 'GET');
        $sheet = $this->wallet($app, 'GET', [], [], $cookie)['body']['data'];
        $this->assertSame([true, true, 'stub-client'], [$sheet['available'], $sheet['paypalStandIn'], $sheet['paypalClientId']]);

        // The three steps the sheet's button takes: start, approve at the stand-in, capture.
        $order = $this->wallet($app, 'POST', ['operation' => 'orders'], ['cents' => 200], $cookie)['body']['data']['orderId'];
        $this->assertSame('CREATED', self::$paypal->orders()[$order]['status']);
        $this->assertSame(502, $this->wallet($app, 'POST', ['operation' => 'orders', 'orderId' => $order], [], $cookie)['http'], 'an order nobody approved is not captured');
        $approved = $this->wallet($app, 'POST', ['operation' => 'stand-in', 'orderId' => $order], [], $cookie);
        $this->assertSame([200, ['approved' => true]], [$approved['http'], $approved['body']['data'] ?? null], json_encode($approved));
        $this->assertSame(['APPROVED', 'completed'], [self::$paypal->orders()[$order]['status'], self::$paypal->orders()[$order]['outcome']]);
        $captured = $this->wallet($app, 'POST', ['operation' => 'orders', 'orderId' => $order], [], $cookie)['body']['data'];
        $this->assertSame(['completed', 200], [$captured['status'], $captured['balanceCents']]);
        $this->assertSame([['kind' => 'topup', 'amount_cents' => 200]], array_map(static fn(array $line) => ['kind' => $line['kind'], 'amount_cents' => (int) $line['amount_cents']], $this->ledger($app)), 'credited once, as any top-up is');
        // And it buys what a real top-up buys.
        $this->assertSame([200, 195], [($bought = $this->call($app, '/api/download', ['design' => 'd1'], $cookie))['status'], $bought['body']['balanceCents'] ?? null]);

        // Only a top-up of one's own that still waits: not one already paid, another browser's, or none.
        $this->assertSame(404, $this->wallet($app, 'POST', ['operation' => 'stand-in', 'orderId' => $order], [], $cookie)['http']);
        $mine = $this->wallet($app, 'POST', ['operation' => 'orders'], ['cents' => 500], $cookie)['body']['data']['orderId'];
        $other = [];
        $this->call($app, '/api/whoami', [], $other, 'GET');
        $this->assertSame(404, $this->wallet($app, 'POST', ['operation' => 'stand-in', 'orderId' => $mine], [], $other)['http'], 'another browser\'s order');
        $this->assertSame(404, $this->wallet($app, 'POST', ['operation' => 'stand-in', 'orderId' => 'STUBORDER999999'], [], $cookie)['http']);
        $this->assertSame('CREATED', self::$paypal->orders()[$mine]['status']);

        // Where PayPal is PayPal (no stand-in named, whatever the environment says of one): the sheet
        // shows PayPal's own buttons, and nothing approves an order but its buyer.
        $before = $_ENV['PAYPAL_BASE_URL'] ?? null;
        unset($_ENV['PAYPAL_BASE_URL']);
        try {
            $paypal = new PayPalService(['clientId' => 'a', 'secret' => 'b', 'webhookId' => 'w']);
            $this->assertFalse($paypal->standIn());
            $real = new AppWalletService(self::$mysql, $this->site, $paypal, $this->platform, $this->visitors);
            $holder = $this->visitorOf($cookie, $app['id']);
            $this->assertSame([true, false], [$real->sheet($app, self::DECLARED, $holder)['available'], $real->sheet($app, self::DECLARED, $holder)['paypalStandIn']]);
            try {
                $real->approveStandIn($app, $holder, $mine);
                $this->fail('approved without its buyer');
            } catch (WalletRefusal $e) {
                $this->assertSame(['not_found', 404], [$e->reason, $e->status]);
            }
            try {
                $paypal->approveStandInOrder($mine);
                $this->fail('PayPal itself was asked to approve');
            } catch (\RuntimeException $e) {
                $this->assertSame('No stand-in for PayPal is in use', $e->getMessage());
            }
        } finally {
            if ($before !== null) $_ENV['PAYPAL_BASE_URL'] = $before;
        }
        $this->assertSame('CREATED', self::$paypal->orders()[$mine]['status']);

        // Five top-ups an hour for a wallet and for an address, as everywhere. A development site,
        // where a test suite's visitors all come from one address, may name another number; a site
        // whose PayPal is PayPal never reads it.
        $limit = $_ENV['APP_WALLET_TOPUPS_PER_HOUR'] ?? null;
        try {
            $started = fn(): int => (int) self::$pdo->query('SELECT COUNT(*) FROM app_wallet_topups WHERE app_id = ' . self::$pdo->quote($app['id']))->fetchColumn();
            $this->assertSame(2, $started());
            foreach ([3, 4, 5] as $n) $this->assertSame(200, $this->wallet($app, 'POST', ['operation' => 'orders'], ['cents' => 200], $cookie)['http'], "top-up {$n}");
            $sixth = $this->wallet($app, 'POST', ['operation' => 'orders'], ['cents' => 200], $cookie);
            $this->assertSame([429, 'too_many'], [$sixth['http'], $sixth['body']['code'] ?? null]);
            $_ENV['APP_WALLET_TOPUPS_PER_HOUR'] = '7';
            $this->assertSame(200, $this->wallet($app, 'POST', ['operation' => 'orders'], ['cents' => 200], $cookie)['http'], 'the sixth, where a stand-in answers and the site says seven');
            $this->assertSame(200, $this->wallet($app, 'POST', ['operation' => 'orders'], ['cents' => 200], $cookie)['http']);
            $this->assertSame(429, $this->wallet($app, 'POST', ['operation' => 'orders'], ['cents' => 200], $cookie)['http'], 'and no more than it says');
            foreach (['0', '-3', 'many', ''] as $nonsense) {
                $_ENV['APP_WALLET_TOPUPS_PER_HOUR'] = $nonsense;
                $this->assertSame(429, $this->wallet($app, 'POST', ['operation' => 'orders'], ['cents' => 200], $cookie)['http'], "'{$nonsense}' is not a number of top-ups: five, as ever");
            }
            // PayPal itself: the number is not read, whatever it says.
            $_ENV['APP_WALLET_TOPUPS_PER_HOUR'] = '1000';
            unset($_ENV['PAYPAL_BASE_URL']);
            $real = new AppWalletService(self::$mysql, $this->site, new PayPalService(['clientId' => 'a', 'secret' => 'b', 'webhookId' => 'w']), $this->platform, $this->visitors);
            try {
                $real->createTopup($app, $this->visitorOf($cookie, $app['id']), 200, 'dddddddddddddddd');
                $this->fail('a real site took a development setting');
            } catch (WalletRefusal $e) {
                $this->assertSame('too_many', $e->reason);
            }
            $this->assertSame(7, $started());
        } finally {
            if ($limit === null) unset($_ENV['APP_WALLET_TOPUPS_PER_HOUR']); else $_ENV['APP_WALLET_TOPUPS_PER_HOUR'] = $limit;
            if ($before !== null) $_ENV['PAYPAL_BASE_URL'] = $before;
        }

        // While payments are off nothing is approved either.
        $this->site->save(['enabled' => false]);
        $off = $this->wallet($app, 'POST', ['operation' => 'stand-in', 'orderId' => $mine], [], $cookie);
        $this->assertSame([403, 'payments_off'], [$off['http'], $off['body']['code'] ?? null]);
        $this->assertFalse($this->wallet($app, 'GET', [], [], $cookie)['body']['data']['paypalStandIn'], 'and the sheet offers no button');
    }

    /**
     * The stand-in button and its route are a development site's alone. Asked through the controller,
     * as FormLogic's page asks, of a site whose PayPal is made as the real site's is (from the
     * environment alone): under every configuration but APP_ENV exactly `development` with a
     * PAYPAL_BASE_URL, the sheet offers no stand-in, `…/wallet/stand-in/{orderId}` answers 404 and
     * approves nothing, and APP_WALLET_TOPUPS_PER_HOUR is not read.
     */
    public function testOnlyADevelopmentSiteWithAStandInHasItsButtonAndItsRoute(): void
    {
        $this->boot();
        $app = $this->app();
        $cookie = [];
        $this->call($app, '/api/whoami', [], $cookie, 'GET');
        // The visitor's own top-ups at the stand-in, still waiting for their buyer: what the route
        // would approve, and an hour's allowance of them used up.
        $orders = [];
        foreach (range(1, AppWalletService::TOPUPS_PER_HOUR) as $n) $orders[] = $this->wallet($app, 'POST', ['operation' => 'orders'], ['cents' => 200], $cookie)['body']['data']['orderId'];
        $order = $orders[0];
        $started = fn(): int => (int) self::$pdo->query('SELECT COUNT(*) FROM app_wallet_topups WHERE app_id = ' . self::$pdo->quote($app['id']))->fetchColumn();
        $this->assertSame([AppWalletService::TOPUPS_PER_HOUR, 'CREATED'], [$started(), self::$paypal->orders()[$order]['status']]);

        $names = ['APP_ENV', 'PAYPAL_BASE_URL', 'PAYPAL_CLIENT_ID', 'PAYPAL_SECRET', 'PAYPAL_WEBHOOK_ID', 'PAYPAL_ENV', 'APP_WALLET_TOPUPS_PER_HOUR'];
        $before = array_map(static fn(string $name): ?string => $_ENV[$name] ?? null, array_combine($names, $names));
        $set = static function (array $values): void {
            foreach ($values as $name => $value) {
                if ($value === null) unset($_ENV[$name]); else $_ENV[$name] = $value;
            }
        };
        try {
            $standIn = self::$paypal->base;
            $set(['PAYPAL_CLIENT_ID' => 'the-site-client', 'PAYPAL_SECRET' => 'the-site-secret', 'PAYPAL_WEBHOOK_ID' => 'the-site-webhook', 'PAYPAL_ENV' => null, 'APP_WALLET_TOPUPS_PER_HOUR' => '1000']);
            // What the site is: [APP_ENV, PAYPAL_BASE_URL, PAYPAL_ENV, whether it takes payments at all].
            $sites = [
                'production, PayPal itself' => ['production', null, 'live', true],
                'production, PayPal\'s sandbox' => ['production', null, 'sandbox', true],
                'no APP_ENV, PayPal itself' => [null, null, 'live', true],
                'development, PayPal\'s sandbox and no stand-in' => ['development', null, null, true],
                'development, PAYPAL_BASE_URL empty' => ['development', '', null, true],
            ];
            // A stand-in named anywhere but in development is refused, and payments are off until it is removed.
            foreach ([null, '', 'production', 'prod', 'staging', 'test', 'local', 'dev', 'Development', 'DEVELOPMENT', 'development ', ' development', 'development,production'] as $env) {
                $sites['APP_ENV ' . json_encode($env) . ', a stand-in named'] = [$env, $standIn, null, false];
            }
            foreach ($sites as $what => [$env, $base, $paypalEnv, $takesPayments]) {
                $set(['APP_ENV' => $env, 'PAYPAL_BASE_URL' => $base, 'PAYPAL_ENV' => $paypalEnv]);
                $site = $this->siteFromEnvironment();
                $sheet = $this->wallet($app, 'GET', [], [], $cookie, $site)['body']['data'];
                $this->assertSame([$takesPayments, false, $takesPayments ? 'the-site-client' : null], [$sheet['available'], $sheet['paypalStandIn'], $sheet['paypalClientId']], "{$what}: the sheet offers no stand-in button");
                $refused = $this->wallet($app, 'POST', ['operation' => 'stand-in', 'orderId' => $order], [], $cookie, $site);
                $this->assertSame([404, 'not_found'], [$refused['http'], $refused['body']['code'] ?? null], "{$what}: there is no such route");
                $this->assertSame('CREATED', self::$paypal->orders()[$order]['status'], "{$what}: and nothing was approved");
                // One more top-up this hour: turned away, the development setting unread (and where payments are off, they are off).
                $more = $this->wallet($app, 'POST', ['operation' => 'orders'], ['cents' => 200], $cookie, $site);
                $this->assertSame($takesPayments ? [429, 'too_many'] : [403, 'payments_off'], [$more['http'], $more['body']['code'] ?? null], "{$what}: five top-ups an hour, whatever APP_WALLET_TOPUPS_PER_HOUR says");
            }
            $this->assertSame(AppWalletService::TOPUPS_PER_HOUR, $started());

            // The one site that has them: APP_ENV exactly `development`, and a stand-in named.
            $set(['APP_ENV' => 'development', 'PAYPAL_BASE_URL' => $standIn, 'PAYPAL_ENV' => null]);
            $site = $this->siteFromEnvironment();
            $sheet = $this->wallet($app, 'GET', [], [], $cookie, $site)['body']['data'];
            $this->assertSame([true, true], [$sheet['available'], $sheet['paypalStandIn']]);
            $approved = $this->wallet($app, 'POST', ['operation' => 'stand-in', 'orderId' => $order], [], $cookie, $site);
            $this->assertSame([200, ['approved' => true]], [$approved['http'], $approved['body']['data'] ?? null], json_encode($approved));
            $this->assertSame('APPROVED', self::$paypal->orders()[$order]['status']);
            $this->assertSame(200, $this->wallet($app, 'POST', ['operation' => 'orders'], ['cents' => 200], $cookie, $site)['http'], 'and there the setting is read');
            $this->assertSame(AppWalletService::TOPUPS_PER_HOUR + 1, $started());
        } finally {
            $set($before);
        }
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
        $this->assertSame(202, $this->wallet($app, 'POST', ['operation' => 'email'], ['purpose' => 'restore', 'email' => 'nobody@example.com'], $second)['http']);
        $this->assertSame(['nobody@example.com', null], [$this->mail[1]['to'], $this->mail[1]['code']], 'no balance under that email: answered and mailed the same, with no code');
        $this->assertSame(202, $this->wallet($app, 'POST', ['operation' => 'email'], ['purpose' => 'restore', 'email' => 'buyer@example.com'], $second)['http']);
        $restored = $this->wallet($app, 'POST', ['operation' => 'confirm'], ['purpose' => 'restore', 'email' => 'buyer@example.com', 'code' => $this->mail[2]['code']], $second);
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

    /** M5: a code works once and for ten minutes. */
    public function testACodeIsSpentOnceAndRunsOut(): void
    {
        $this->boot();
        $app = $this->app();
        $cookie = [];
        $this->call($app, '/api/whoami', [], $cookie, 'GET');
        $holder = $this->visitorOf($cookie, $app['id']);
        $this->topUp($app, $holder, 200);
        $this->wallets->sendCode($app, $holder, 'save', 'once@example.com', 'dddddddddddddddd');
        $code = (string) end($this->mail)['code'];
        $this->assertSame(200, $this->wallets->confirmCode($app, $holder, 'save', 'once@example.com', $code)['balanceCents']);
        try {
            $this->wallets->confirmCode($app, $holder, 'save', 'once@example.com', $code);
            $this->fail('a code used twice');
        } catch (WalletRefusal $e) {
            $this->assertSame('bad_code', $e->reason);
        }
        $this->wallets->sendCode($app, $holder, 'save', 'late@example.com', 'dddddddddddddddd');
        self::$pdo->prepare("UPDATE app_wallet_codes SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 MINUTE WHERE app_id = ? AND used_at IS NULL")->execute([$app['id']]);
        try {
            $this->wallets->confirmCode($app, $holder, 'save', 'late@example.com', (string) end($this->mail)['code']);
            $this->fail('a code past its ten minutes');
        } catch (WalletRefusal $e) {
            $this->assertSame('bad_code', $e->reason);
        }
    }

    /** L2: a held balance stays where it is held; a blocked one a restore brings to zero or more is open again. */
    public function testARestoreNeverMovesAHeldBalanceAndSettlesABlockedOne(): void
    {
        $this->boot();
        $app = $this->app();
        $saved = [];
        $this->call($app, '/api/whoami', [], $saved, 'GET');
        $savedHolder = $this->visitorOf($saved, $app['id']);
        $this->wallets->sendCode($app, $savedHolder, 'save', 'held@example.com', 'eeeeeeeeeeeeeeee');
        $this->wallets->confirmCode($app, $savedHolder, 'save', 'held@example.com', (string) end($this->mail)['code']);
        $savedWallet = (string) $this->wallets->wallet($app['id'], $savedHolder, false)['id'];
        // Held: a disputed balance in another browser is not moved into the saved one.
        $held = [];
        $this->call($app, '/api/whoami', [], $held, 'GET');
        $heldHolder = $this->visitorOf($held, $app['id']);
        $this->topUp($app, $heldHolder, 200);
        self::$pdo->prepare("UPDATE app_wallets SET status = 'disputed' WHERE id = ?")->execute([$this->wallets->wallet($app['id'], $heldHolder, false)['id']]);
        $this->wallets->sendCode($app, $heldHolder, 'restore', 'held@example.com', 'eeeeeeeeeeeeeeee');
        try {
            $this->wallets->confirmCode($app, $heldHolder, 'restore', 'held@example.com', (string) end($this->mail)['code']);
            $this->fail('a disputed balance moved');
        } catch (WalletRefusal $e) {
            $this->assertSame([409, 'wallet_held'], [$e->status, $e->reason]);
        }
        $this->assertSame(['disputed', 200], [$this->wallets->wallet($app['id'], $heldHolder, false)['status'], (int) $this->wallets->wallet($app['id'], $heldHolder, false)['balance_cents']]);
        // Blocked below zero, then a restore brings 200 to it: settled, and open again.
        self::$pdo->prepare("UPDATE app_wallets SET status = 'blocked', balance_cents = -5 WHERE id = ?")->execute([$savedWallet]);
        $fresh = [];
        $this->call($app, '/api/whoami', [], $fresh, 'GET');
        $freshHolder = $this->visitorOf($fresh, $app['id']);
        $this->topUp($app, $freshHolder, 200);
        $this->wallets->sendCode($app, $freshHolder, 'restore', 'held@example.com', 'ffffffffffffffff');
        $this->assertSame(195, $this->wallets->confirmCode($app, $freshHolder, 'restore', 'held@example.com', (string) end($this->mail)['code'])['balanceCents']);
        $this->assertSame('active', $this->wallets->wallet($app['id'], $freshHolder, false)['status']);
    }

    /** L3, L4, a mismatched capture: two disputes, refunds once each for their own amounts, and a reversal named by its capture. */
    public function testRefundsAreTakenOnceEachAndAWalletIsHeldUntilEveryDisputeIsResolved(): void
    {
        $this->boot();
        $app = $this->app();
        $cookie = [];
        $this->call($app, '/api/whoami', [], $cookie, 'GET');
        $holder = $this->visitorOf($cookie, $app['id']);
        $this->topUp($app, $holder, 500);
        $this->topUp($app, $holder, 200);
        $captures = array_map(static fn(string $order) => 'STUBCAP' . substr($order, 9), self::$pdo->query('SELECT order_id FROM app_wallet_topups WHERE app_id = ' . self::$pdo->quote($app['id']) . ' ORDER BY created_at')->fetchAll(PDO::FETCH_COLUMN));
        $balance = fn(): int => (int) $this->wallets->wallet($app['id'], $holder, false)['balance_cents'];
        $refund = static fn(string $id, string $capture, string $value, ?string $total = null) => ['id' => $id, 'amount' => ['currency_code' => 'USD', 'value' => $value],
            'links' => [['rel' => 'up', 'href' => 'https://api-m.paypal.com/v2/payments/captures/' . $capture]]] + ($total !== null ? ['seller_payable_breakdown' => ['total_refunded_amount' => ['currency_code' => 'USD', 'value' => $total]]] : []);
        // Two partial refunds of the $5 top-up, each delivered twice: each taken once, for its own amount.
        foreach ([['R1', '1.00', '1.00'], ['R2', '2.00', '3.00'], ['R1', '1.00', '1.00'], ['R2', '2.00', '3.00']] as [$id, $value, $total]) {
            $this->assertTrue($this->wallets->webhook('PAYMENT.CAPTURE.REFUNDED', $refund($id, $captures[0], $value, $total)));
        }
        $this->assertSame(400, $balance());
        // A negative amount takes nothing; a reversal with no refund id or total takes what is left, once.
        $this->wallets->webhook('PAYMENT.CAPTURE.REFUNDED', $refund('R3', $captures[0], '-4.00'));
        $this->assertSame(400, $balance());
        $reversal = ['id' => $captures[0], 'amount' => ['currency_code' => 'USD', 'value' => '5.00'], 'status' => 'REVERSED'];
        $this->wallets->webhook('PAYMENT.CAPTURE.REVERSED', $reversal);
        $this->wallets->webhook('PAYMENT.CAPTURE.REVERSED', $reversal);
        $this->assertSame(200, $balance(), 'the $2 left of the $5, once: never more than the top-up');
        $this->assertSame(['reversed', 500], array_map(static fn($v) => is_numeric($v) ? (int) $v : $v, self::$pdo->query('SELECT status, refunded_cents FROM app_wallet_topups WHERE capture_id = ' . self::$pdo->quote($captures[0]))->fetch(PDO::FETCH_NUM)));
        // Two disputes on two top-ups: held until both are resolved.
        $dispute = static fn(string $id, string $capture) => ['dispute_id' => $id, 'disputed_transactions' => [['seller_transaction_id' => $capture]]];
        $this->wallets->webhook('CUSTOMER.DISPUTE.CREATED', $dispute('D1', $captures[0]));
        $this->wallets->webhook('CUSTOMER.DISPUTE.CREATED', $dispute('D2', $captures[1]));
        $this->wallets->webhook('CUSTOMER.DISPUTE.RESOLVED', $dispute('D1', $captures[0]));
        $this->assertSame('disputed', $this->wallets->wallet($app['id'], $holder, false)['status'], 'the other is still open');
        $this->wallets->webhook('CUSTOMER.DISPUTE.RESOLVED', $dispute('D2', $captures[1]));
        $this->assertSame('active', $this->wallets->wallet($app['id'], $holder, false)['status']);
        // A capture of another amount, by webhook: not credited.
        $order = $this->wallets->createTopup($app, $holder, 200, 'aaaaaaaaaaaaaaaa')['orderId'];
        self::$paypal->approve($order, 'pending');
        $this->wallets->captureTopup($app, $holder, $order);
        $this->wallets->webhook('PAYMENT.CAPTURE.COMPLETED', ['id' => 'STUBCAP' . substr($order, 9), 'status' => 'COMPLETED', 'amount' => ['currency_code' => 'USD', 'value' => '20.00']]);
        $this->assertSame(200, $balance());
    }

    /** L8: a top-up is credited to the wallet its holder has when it is credited. */
    public function testATopUpIsCreditedToTheWalletItsHolderHasNow(): void
    {
        $this->boot();
        $app = $this->app();
        $cookie = [];
        $this->call($app, '/api/whoami', [], $cookie, 'GET');
        $holder = $this->visitorOf($cookie, $app['id']);
        $order = $this->wallets->createTopup($app, $holder, 200, 'aaaaaaaaaaaaaaaa')['orderId'];
        $old = (string) $this->wallets->wallet($app['id'], $holder, false)['id'];
        // Restored elsewhere meanwhile (the old wallet still held by another browser, so its top-ups stay).
        $now = bin2hex(random_bytes(16));
        $stamp = \FormLogic\Services\AppAiService::stamp(microtime(true));
        self::$pdo->prepare("INSERT INTO app_wallets (id, app_id, balance_cents, status, created_at, updated_at) VALUES (?, ?, 0, 'active', ?, ?)")->execute([$now, $app['id'], $stamp, $stamp]);
        self::$pdo->prepare('UPDATE app_wallet_holders SET wallet_id = ? WHERE app_id = ? AND holder_kind = ? AND holder_id = ?')->execute([$now, $app['id'], $holder['kind'], $holder['id']]);
        self::$pdo->prepare("INSERT INTO app_wallet_holders (app_id, holder_kind, holder_id, wallet_id, created_at) VALUES (?, 'visitor', ?, ?, ?)")->execute([$app['id'], str_repeat('9', 32), $old, $stamp]);
        self::$paypal->approve($order);
        $this->assertSame(['completed', 200], array_values(array_intersect_key($this->wallets->captureTopup($app, $holder, $order), ['status' => 1, 'balanceCents' => 1])));
        $this->assertSame([200, 0], [(int) self::$pdo->query('SELECT balance_cents FROM app_wallets WHERE id = ' . self::$pdo->quote($now))->fetchColumn(), (int) self::$pdo->query('SELECT balance_cents FROM app_wallets WHERE id = ' . self::$pdo->quote($old))->fetchColumn()]);
        $this->assertSame($now, self::$pdo->query('SELECT wallet_id FROM app_wallet_topups WHERE order_id = ' . self::$pdo->quote($order))->fetchColumn());
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

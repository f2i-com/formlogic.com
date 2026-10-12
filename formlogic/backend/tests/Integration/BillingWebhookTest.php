<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\BillingController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Services\PayPalService;
use FormLogic\Services\PlatformPlansService;
use PDO;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/** PayPal stand-in: configured, and the signature check answers what the test tells it to. */
class BillingWebhookFakePayPal extends PayPalService
{
    public bool $signatureValid = true;
    /** @var array<string,mixed> what capture answers */
    public array $captureResponse = [];

    public function __construct()
    {
        parent::__construct(['clientId' => 'client', 'secret' => 'secret', 'env' => 'sandbox']);
    }

    public function verifyWebhookSignature(array $headers, array $event): bool
    {
        return $this->signatureValid;
    }

    public function captureOrder(string $orderId, ?string $requestId = null): array
    {
        return $this->captureResponse;
    }

    public function getOrder(string $orderId): array
    {
        return $this->captureResponse;
    }
}

/**
 * The PayPal webhook is the second way a payment is credited (the first is the capture call the
 * buyer's browser asks for). Both must hold the capture to what the server recorded for the
 * order: a capture of another amount or currency is not the purchase, whoever reports it.
 * Skipped without a test database.
 */
class BillingWebhookTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;

    /** @var string[] */ private array $userIds = [];
    private BillingWebhookFakePayPal $paypal;

    public static function setUpBeforeClass(): void
    {
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) {
            \Dotenv\Dotenv::createImmutable($root)->safeLoad();
        }
        $config = [
            'host' => $_ENV['DB_HOST'] ?? '127.0.0.1',
            'port' => $_ENV['DB_PORT'] ?? '3306',
            'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
            'username' => $_ENV['DB_USERNAME'] ?? 'root',
            'password' => $_ENV['DB_PASSWORD'] ?? '',
            'charset' => 'utf8mb4',
            'collation' => 'utf8mb4_unicode_ci',
        ];
        try {
            $conn = new MySQLConnection($config);
            $conn->getConnection()->query('SELECT 1');
            $conn->initializeSchema();
            $conn->runMigrations();
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
        self::$mysql = $conn;
        self::$pdo = $conn->getConnection();
    }

    protected function setUp(): void
    {
        if (self::$mysql === null) {
            $this->markTestSkipped('No test database');
        }
        $this->paypal = new BillingWebhookFakePayPal();
    }

    protected function tearDown(): void
    {
        if (self::$pdo === null) {
            return;
        }
        foreach ($this->userIds as $uid) {
            self::$pdo->prepare('DELETE FROM payments WHERE user_id = ?')->execute([$uid]);
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$uid]);
        }
        $this->userIds = [];
    }

    private function controller(): BillingController
    {
        $plans = new class extends PlatformPlansService {
            public function status(): array
            {
                return array_replace(self::defaults(), ['paymentsEnabled' => true, 'pricePerMonthCents' => 500]);
            }
        };
        return new BillingController($this->paypal, self::$mysql, null, null, null, false, $plans);
    }

    private function makeUser(): string
    {
        $id = 'u-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name, plan, cloud_until) VALUES (?, ?, 'x', 'T', 'personal', NULL)")
            ->execute([$id, $id . '@test.local']);
        $this->userIds[] = $id;
        return $id;
    }

    /** A pending order as createOrder records it: 12 months, 6000 cents, USD. */
    private function makePayment(string $userId, string $status = 'pending', ?string $captureId = null): string
    {
        $orderId = 'ORDER-' . strtoupper(bin2hex(random_bytes(6)));
        self::$pdo->prepare(
            "INSERT INTO payments (id, user_id, provider, order_id, capture_id, amount_cents, currency, months, status)
             VALUES (?, ?, 'paypal', ?, ?, 6000, 'USD', 12, ?)"
        )->execute(['p-' . bin2hex(random_bytes(12)), $userId, $orderId, $captureId, $status]);
        return $orderId;
    }

    private function payment(string $orderId): array
    {
        $stmt = self::$pdo->prepare('SELECT * FROM payments WHERE order_id = ?');
        $stmt->execute([$orderId]);
        return $stmt->fetch(PDO::FETCH_ASSOC) ?: [];
    }

    private function cloudUntil(string $userId): ?string
    {
        $stmt = self::$pdo->prepare('SELECT cloud_until FROM users WHERE id = ?');
        $stmt->execute([$userId]);
        $value = $stmt->fetchColumn();
        return is_string($value) && $value !== '' ? $value : null;
    }

    /** @param array<string,mixed> $resource */
    private function postWebhook(string $type, array $resource): int
    {
        $request = (new ServerRequestFactory())
            ->createServerRequest('POST', '/api/billing/webhook/paypal')
            ->withParsedBody(['id' => 'WH-' . bin2hex(random_bytes(6)), 'event_type' => $type, 'resource' => $resource]);
        return $this->controller()->webhook($request, (new ResponseFactory())->createResponse())->getStatusCode();
    }

    /** @return array<string,mixed> */
    private function completedCapture(string $captureId, string $orderId, string $value, string $currency = 'USD'): array
    {
        return [
            'id' => $captureId,
            'status' => 'COMPLETED',
            'amount' => ['currency_code' => $currency, 'value' => $value],
            'supplementary_data' => ['related_ids' => ['order_id' => $orderId]],
        ];
    }

    public function testACompletedCaptureOfTheRecordedAmountCreditsTheMonthsOnce(): void
    {
        $user = $this->makeUser();
        $order = $this->makePayment($user);
        $capture = $this->completedCapture('CAP-' . bin2hex(random_bytes(6)), $order, '60.00');

        $this->assertSame(200, $this->postWebhook('PAYMENT.CAPTURE.COMPLETED', $capture));
        $this->assertSame('completed', $this->payment($order)['status']);
        $first = $this->cloudUntil($user);
        $this->assertNotNull($first, 'the purchase was credited');

        // PayPal delivers at least once: the same event again adds nothing.
        $this->assertSame(200, $this->postWebhook('PAYMENT.CAPTURE.COMPLETED', $capture));
        $this->assertSame($first, $this->cloudUntil($user));
    }

    public function testACompletedCaptureOfAnotherAmountIsNotCredited(): void
    {
        $user = $this->makeUser();
        $order = $this->makePayment($user);

        // The order was recorded at 60.00 USD; what PayPal reports captured is one cent.
        $status = $this->postWebhook(
            'PAYMENT.CAPTURE.COMPLETED',
            $this->completedCapture('CAP-' . bin2hex(random_bytes(6)), $order, '0.01')
        );

        $this->assertSame(200, $status, 'a genuine event is acknowledged so PayPal stops redelivering it');
        $this->assertNull($this->cloudUntil($user), 'twelve months must not be granted for one cent');
        $this->assertSame('pending', $this->payment($order)['status']);
    }

    public function testACompletedCaptureInAnotherCurrencyIsNotCredited(): void
    {
        $user = $this->makeUser();
        $order = $this->makePayment($user);

        $this->postWebhook(
            'PAYMENT.CAPTURE.COMPLETED',
            $this->completedCapture('CAP-' . bin2hex(random_bytes(6)), $order, '60.00', 'JPY')
        );

        $this->assertNull($this->cloudUntil($user));
        $this->assertSame('pending', $this->payment($order)['status']);
    }

    public function testACaptureEventThatCarriesNoAmountIsNotCredited(): void
    {
        $user = $this->makeUser();
        $order = $this->makePayment($user);
        $capture = $this->completedCapture('CAP-' . bin2hex(random_bytes(6)), $order, '60.00');
        unset($capture['amount']);

        $this->postWebhook('PAYMENT.CAPTURE.COMPLETED', $capture);

        $this->assertNull($this->cloudUntil($user));
        $this->assertSame('pending', $this->payment($order)['status']);
    }

    public function testAnEventWhoseSignatureDoesNotVerifyChangesNothing(): void
    {
        $user = $this->makeUser();
        $order = $this->makePayment($user);
        $this->paypal->signatureValid = false;

        $status = $this->postWebhook(
            'PAYMENT.CAPTURE.COMPLETED',
            $this->completedCapture('CAP-' . bin2hex(random_bytes(6)), $order, '60.00')
        );

        $this->assertSame(400, $status);
        $this->assertNull($this->cloudUntil($user));
        $this->assertSame('pending', $this->payment($order)['status']);
    }

    public function testAReversalTakesBackTheMonthsOnceAndACompletedReplayDoesNotRestoreThem(): void
    {
        $user = $this->makeUser();
        $order = $this->makePayment($user);
        $captureId = 'CAP-' . bin2hex(random_bytes(6));
        $capture = $this->completedCapture($captureId, $order, '60.00');
        $this->postWebhook('PAYMENT.CAPTURE.COMPLETED', $capture);
        $this->assertGreaterThan(time() + 300 * 86400, strtotime((string) $this->cloudUntil($user)));

        $this->assertSame(200, $this->postWebhook('PAYMENT.CAPTURE.REVERSED', $capture));
        $this->assertSame('reversed', $this->payment($order)['status']);
        $this->assertLessThan(time() + 86400, strtotime((string) $this->cloudUntil($user)));

        // Neither a second reversal nor the original completion, sent again, moves it.
        $after = $this->cloudUntil($user);
        $this->postWebhook('PAYMENT.CAPTURE.REVERSED', $capture);
        $this->postWebhook('PAYMENT.CAPTURE.COMPLETED', $capture);
        $this->assertSame('reversed', $this->payment($order)['status']);
        $this->assertLessThan(time() + 86400, strtotime((string) $this->cloudUntil($user)));
        $this->assertNotNull($after);
    }

    /** PayPal answering something that is not a capture is "could not confirm", never a crash. */
    public function testACaptureAnswerThatIsNotACaptureLeavesTheOrderPending(): void
    {
        $user = $this->makeUser();
        $order = $this->makePayment($user);
        $request = (new ServerRequestFactory())
            ->createServerRequest('POST', '/api/billing/orders/' . $order . '/capture')
            ->withAttribute('userId', $user);

        foreach ([
            ['purchase_units' => [['payments' => ['captures' => ['unexpected']]]]],
            ['purchase_units' => 'unexpected'],
            ['name' => 'UNPROCESSABLE_ENTITY', 'details' => [['issue' => 'ORDER_NOT_APPROVED']]],
        ] as $answer) {
            $this->paypal->captureResponse = $answer;
            $response = $this->controller()->captureOrder($request, (new ResponseFactory())->createResponse(), ['orderId' => $order]);
            $this->assertSame(502, $response->getStatusCode(), json_encode($answer));
            $this->assertSame('pending', $this->payment($order)['status']);
            $this->assertNull($this->cloudUntil($user));
        }
    }

    public function testTheCaptureCallAndTheWebhookAgreeOnAMismatchedAmount(): void
    {
        $user = $this->makeUser();
        $order = $this->makePayment($user);
        $captureId = 'CAP-' . bin2hex(random_bytes(6));
        $short = $this->completedCapture($captureId, $order, '0.01');
        $this->paypal->captureResponse = ['purchase_units' => [['payments' => ['captures' => [$short]]]]];

        $request = (new ServerRequestFactory())
            ->createServerRequest('POST', '/api/billing/orders/' . $order . '/capture')
            ->withAttribute('userId', $user);
        $response = $this->controller()->captureOrder($request, (new ResponseFactory())->createResponse(), ['orderId' => $order]);
        $this->assertSame(502, $response->getStatusCode(), 'the capture call refuses the short capture');
        $this->assertNull($this->cloudUntil($user));

        // The webhook for that same capture must not grant what the capture call refused.
        $this->postWebhook('PAYMENT.CAPTURE.COMPLETED', $short);
        $this->assertNull($this->cloudUntil($user));
        $this->assertSame('pending', $this->payment($order)['status']);
    }
}

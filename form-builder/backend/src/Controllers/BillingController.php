<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Services\PayPalService;
use FormLogic\Services\AuditService;
use FormLogic\Services\PlanService;
use FormLogic\Database\MySQLConnection;
use FormLogic\Helpers\IpResolver;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Log\LoggerInterface;
use Psr\Log\NullLogger;

/**
 * Pay-as-you-go cloud billing via PayPal (one-time captures, no subscription).
 *
 * Each paid month ($5 by default) extends the user's cloud_until expiry from
 * max(now, current expiry), so buying 6 months simply stacks to 6 months. The
 * credited month count comes from the SERVER-recorded pending order (never the
 * client), the capture is verified server-side, and order/capture ids are unique
 * so a payment can only ever credit once.
 */
class BillingController
{
    private PayPalService $paypal;
    private MySQLConnection $db;
    private ?AuditService $auditService;
    private LoggerInterface $logger;
    private ?PlanService $planService;
    private IpResolver $ipResolver;

    private int $pricePerMonthCents;
    private string $currency = 'USD';
    private const MAX_MONTHS = 12;

    public function __construct(PayPalService $paypal, MySQLConnection $db, ?AuditService $auditService = null, ?LoggerInterface $logger = null, ?PlanService $planService = null)
    {
        $this->paypal = $paypal;
        $this->db = $db;
        $this->auditService = $auditService;
        $this->logger = $logger ?? new NullLogger();
        $this->planService = $planService;
        $this->ipResolver = IpResolver::fromEnvironment();
        $this->pricePerMonthCents = (int) ($_ENV['CLOUD_PRICE_CENTS'] ?? 500);
        if ($this->pricePerMonthCents < 1) {
            $this->pricePerMonthCents = 500;
        }
    }

    /** GET /api/billing — current cloud status + pricing + PayPal availability. */
    public function status(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        $cloudUntil = $this->getCloudUntil($userId);
        return $this->jsonResponse($response, [
            'cloudUntil' => $cloudUntil,
            'active' => $cloudUntil !== null && strtotime($cloudUntil) > time(),
            'pricePerMonthCents' => $this->pricePerMonthCents,
            'currency' => $this->currency,
            'maxMonths' => self::MAX_MONTHS,
            'paypalEnabled' => $this->paypal->isConfigured(),
            'paypalClientId' => $this->paypal->isConfigured() ? $this->paypal->getClientId() : null,
            // Plan usage (forms/storage) — only meaningful when enforcement is on.
            'usage' => $this->planService ? $this->planService->usage($userId) : null,
        ]);
    }

    /** POST /api/billing/orders — create a PayPal order for {months} cloud months. */
    public function createOrder(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$this->paypal->isConfigured()) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Cloud billing is not configured on this instance.'], 503);
        }
        $data = $request->getParsedBody();
        $months = (int) ($data['months'] ?? 0);
        if ($months < 1 || $months > self::MAX_MONTHS) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Months must be between 1 and ' . self::MAX_MONTHS], 400);
        }

        $amountCents = $months * $this->pricePerMonthCents;
        try {
            $orderId = $this->paypal->createOrder(
                $amountCents,
                $this->currency,
                ($months * 30) . ' days of FormLogic Cloud',
                $userId . ':' . $months
            );
            // Record the order as the server's source of truth for what was purchased.
            $pdo = $this->db->getConnection();
            $stmt = $pdo->prepare(
                'INSERT INTO payments (id, user_id, provider, order_id, amount_cents, currency, months, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
            );
            $stmt->execute([$this->uuid(), $userId, 'paypal', $orderId, $amountCents, $this->currency, $months, 'pending']);
            return $this->jsonResponse($response, ['orderId' => $orderId]);
        } catch (\Throwable $e) {
            $this->logger->error('PayPal create-order failed', ['error' => $e->getMessage()]);
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Could not start the payment. Please try again.'], 502);
        }
    }

    /** POST /api/billing/orders/{orderId}/capture — capture + credit cloud months. */
    public function captureOrder(Request $request, Response $response, array $args): Response
    {
        $userId = $request->getAttribute('userId');
        $orderId = (string) ($args['orderId'] ?? '');
        if (!$this->paypal->isConfigured()) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Cloud billing is not configured on this instance.'], 503);
        }

        $pdo = $this->db->getConnection();
        $stmt = $pdo->prepare('SELECT * FROM payments WHERE order_id = ? AND user_id = ?');
        $stmt->execute([$orderId, $userId]);
        $payment = $stmt->fetch(\PDO::FETCH_ASSOC);
        if (!$payment) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Order not found.'], 404);
        }
        // Already credited (idempotent): just report the current status.
        if ($payment['status'] === 'completed') {
            return $this->cloudStatusResponse($response, $userId, ['alreadyProcessed' => true]);
        }

        // Capture. A stable PayPal-Request-Id makes a replayed capture (after a lost
        // response) return the ORIGINAL result instead of ORDER_ALREADY_CAPTURED.
        try {
            $res = $this->paypal->captureOrder($orderId, 'cap-' . $orderId);
        } catch (\Throwable $e) {
            // Transport failure — money may or may not have moved. Leave the row 'pending'
            // (recoverable) and let the user retry; never mark a terminal state here.
            $this->logger->error('PayPal capture transport error', ['order' => $orderId, 'error' => $e->getMessage()]);
            return $this->jsonResponse($response, ['error' => true, 'message' => 'We could not confirm the payment. Please retry — if you were charged it will be credited.'], 502);
        }

        // The capture response may lack a capture (e.g. ORDER_ALREADY_CAPTURED on retry);
        // re-fetch the order to learn the authoritative state.
        $capture = $res['purchase_units'][0]['payments']['captures'][0] ?? null;
        if (!$capture) {
            try {
                $order = $this->paypal->getOrder($orderId);
                $capture = $order['purchase_units'][0]['payments']['captures'][0] ?? null;
            } catch (\Throwable $e) { /* fall through to indeterminate handling */ }
        }

        $captureStatus = strtoupper((string) ($capture['status'] ?? ''));
        $captureId = $capture['id'] ?? null;
        $capturedCents = isset($capture['amount']['value']) ? (int) round(((float) $capture['amount']['value']) * 100) : -1;
        $captureCurrency = strtoupper((string) ($capture['amount']['currency_code'] ?? ''));
        $amountOk = $captureId
            && $capturedCents === (int) $payment['amount_cents']
            && $captureCurrency === strtoupper((string) $payment['currency']);

        if ($captureStatus === 'COMPLETED' && $amountOk) {
            try {
                $credited = $this->creditPayment($payment, (string) $captureId);
            } catch (\Throwable $e) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'Payment captured but crediting failed. Contact support with order ' . $orderId . '.'], 500);
            }
            return $this->cloudStatusResponse($response, $userId, $credited ? ['monthsAdded' => (int) $payment['months']] : ['alreadyProcessed' => true]);
        }

        if ($captureStatus === 'PENDING' && $amountOk) {
            // eCheck / risk-review hold: funds settle later. Keep it recoverable
            // (non-terminal 'processing'); the webhook (or a retry) credits once it clears.
            $pdo->prepare("UPDATE payments SET status = 'processing', capture_id = ? WHERE id = ? AND status IN ('pending','processing')")
                ->execute([$captureId, $payment['id']]);
            return $this->jsonResponse($response, ['processing' => true, 'message' => 'Your payment is processing — your cloud time will be added as soon as it clears.']);
        }

        if (in_array($captureStatus, ['DECLINED', 'FAILED', 'VOIDED'], true)) {
            // Genuinely terminal and no money taken — safe to mark failed.
            $pdo->prepare("UPDATE payments SET status = 'failed' WHERE id = ? AND status = 'pending'")->execute([$payment['id']]);
            return $this->jsonResponse($response, ['error' => true, 'message' => 'The payment was declined.'], 400);
        }

        // Indeterminate (couldn't read the capture, or an amount/currency mismatch we can't
        // confirm): DON'T mark terminal — leave 'pending' so a retry or webhook can credit.
        $this->logger->warning('PayPal capture indeterminate', ['order' => $orderId, 'captureStatus' => $captureStatus, 'capturedCents' => $capturedCents, 'expected' => $payment['amount_cents']]);
        return $this->jsonResponse($response, ['error' => true, 'message' => "We could not confirm the payment yet. If you were charged, it will be credited shortly — contact support with order $orderId."], 502);
    }

    /**
     * POST /api/billing/webhook/paypal — credit/finalize payments asynchronously.
     * Public (PayPal calls it); authenticated by verifying the webhook signature.
     */
    public function webhook(Request $request, Response $response): Response
    {
        $event = $request->getParsedBody();
        if (!is_array($event) || empty($event['event_type'])) {
            return $response->withStatus(400);
        }
        if (!$this->paypal->verifyWebhookSignature($request->getHeaders(), $event)) {
            $this->logger->warning('PayPal webhook signature verification failed', ['type' => $event['event_type'] ?? null]);
            return $response->withStatus(400);
        }

        $type = (string) $event['event_type'];
        $resource = $event['resource'] ?? [];
        $captureId = (string) ($resource['id'] ?? '');
        // The capture's parent order id (custom_id was set to "userId:months" on create).
        $pdo = $this->db->getConnection();

        if ($type === 'PAYMENT.CAPTURE.COMPLETED' && $captureId !== '') {
            // Resolve by capture id, falling back to the parent order id — a lost capture
            // response leaves the row 'pending' with capture_id NULL, so this webhook is the
            // only path that can still credit it. Credit idempotently.
            $payment = $this->findPaymentForCapture($captureId, $resource);
            if ($payment && $payment['status'] !== 'completed') {
                try { $this->creditPayment($payment, $captureId); } catch (\Throwable $e) {
                    $this->logger->error('Webhook credit failed', ['capture' => $captureId, 'error' => $e->getMessage()]);
                    return $response->withStatus(500);
                }
            }
        } elseif (in_array($type, ['PAYMENT.CAPTURE.DENIED', 'PAYMENT.CAPTURE.REVERSED'], true) && $captureId !== '') {
            $payment = $this->findPaymentForCapture($captureId, $resource);
            if ($payment && $payment['status'] === 'completed') {
                // Chargeback/clawback of an already-credited payment — revoke the cloud time
                // it granted and flag the account (audit), instead of silently ignoring it.
                try { $this->reversePayment($payment, $captureId); } catch (\Throwable $e) {
                    $this->logger->error('Webhook reversal failed', ['capture' => $captureId, 'error' => $e->getMessage()]);
                    return $response->withStatus(500);
                }
            } else {
                // Not yet credited (a pending/processing eCheck that bounced): mark failed.
                $pdo->prepare("UPDATE payments SET status = 'failed' WHERE capture_id = ? AND status NOT IN ('completed','reversed')")->execute([$captureId]);
            }
        }
        return $response->withStatus(200);
    }

    /** Resolve a payment from a webhook capture: by capture_id, else by the parent order id. */
    private function findPaymentForCapture(string $captureId, array $resource): ?array
    {
        $pdo = $this->db->getConnection();
        $stmt = $pdo->prepare('SELECT * FROM payments WHERE capture_id = ?');
        $stmt->execute([$captureId]);
        $payment = $stmt->fetch(\PDO::FETCH_ASSOC);
        if ($payment) {
            return $payment;
        }
        $orderId = (string) ($resource['supplementary_data']['related_ids']['order_id'] ?? '');
        if ($orderId !== '') {
            $stmt = $pdo->prepare('SELECT * FROM payments WHERE order_id = ?');
            $stmt->execute([$orderId]);
            $payment = $stmt->fetch(\PDO::FETCH_ASSOC);
            return $payment ?: null;
        }
        return null;
    }

    /** Revoke the cloud time granted by a now-reversed/charged-back payment (idempotent). */
    private function reversePayment(array $payment, string $captureId): void
    {
        $pdo = $this->db->getConnection();
        try {
            $pdo->beginTransaction();
            // Only a completed payment can be reversed, and only once.
            $upd = $pdo->prepare("UPDATE payments SET status = 'reversed' WHERE id = ? AND status = 'completed'");
            $upd->execute([$payment['id']]);
            if ($upd->rowCount() === 0) {
                $pdo->rollBack();
                return;
            }
            // Claw back the granted days, never moving the expiry earlier than now.
            $pdo->prepare('UPDATE users SET cloud_until = GREATEST(NOW(), DATE_SUB(COALESCE(cloud_until, NOW()), INTERVAL ? DAY)) WHERE id = ?')
                ->execute([(int) $payment['months'] * 30, $payment['user_id']]);
            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
        if ($this->auditService) {
            try {
                $this->auditService->log('billing.reversal', 'payment', $captureId, (string) $payment['user_id'], null, ['months' => (int) $payment['months'], 'amountCents' => (int) $payment['amount_cents']]);
            } catch (\Throwable $e) { /* audit is non-critical */ }
        }
    }

    /** Credit a verified-completed payment exactly once (idempotent). Returns true if THIS
     *  call did the crediting, false if it was already credited. Shared by capture + webhook. */
    private function creditPayment(array $payment, string $captureId): bool
    {
        $pdo = $this->db->getConnection();
        try {
            $pdo->beginTransaction();
            // Win the race: only credit while still pending/processing.
            $upd = $pdo->prepare("UPDATE payments SET status = 'completed', capture_id = ? WHERE id = ? AND status IN ('pending','processing')");
            $upd->execute([$captureId, $payment['id']]);
            if ($upd->rowCount() === 0) {
                $pdo->rollBack();
                return false;
            }
            // Stack 30-day periods from max(now, current expiry) — no subscription, no
            // calendar-month variance: each purchased unit is exactly 30 days.
            $pdo->prepare('UPDATE users SET cloud_until = DATE_ADD(GREATEST(COALESCE(cloud_until, NOW()), NOW()), INTERVAL ? DAY) WHERE id = ?')
                ->execute([(int) $payment['months'] * 30, $payment['user_id']]);
            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            $this->logger->error('Crediting cloud months failed', ['payment' => $payment['id'], 'error' => $e->getMessage()]);
            throw $e;
        }
        if ($this->auditService) {
            try {
                $this->auditService->log('billing.credit', 'payment', $captureId, (string) $payment['user_id'], null, ['months' => (int) $payment['months'], 'amountCents' => (int) $payment['amount_cents']]);
            } catch (\Throwable $e) { /* audit is non-critical */ }
        }
        return true;
    }

    private function cloudStatusResponse(Response $response, string $userId, array $extra = []): Response
    {
        $cloudUntil = $this->getCloudUntil($userId);
        return $this->jsonResponse($response, array_merge([
            'cloudUntil' => $cloudUntil,
            'active' => $cloudUntil !== null && strtotime($cloudUntil) > time(),
        ], $extra));
    }

    private function getCloudUntil(string $userId): ?string
    {
        $stmt = $this->db->getConnection()->prepare('SELECT cloud_until FROM users WHERE id = ?');
        $stmt->execute([$userId]);
        $row = $stmt->fetch(\PDO::FETCH_ASSOC);
        return $row && $row['cloud_until'] ? (string) $row['cloud_until'] : null;
    }

    private function uuid(): string
    {
        $d = random_bytes(16);
        $d[6] = chr((ord($d[6]) & 0x0f) | 0x40);
        $d[8] = chr((ord($d[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($d), 4));
    }

    private function jsonResponse(Response $response, array $data, int $status = 200): Response
    {
        $json = json_encode($data);
        if ($json === false) {
            $json = json_encode(['error' => true, 'message' => 'Internal server error']);
            $status = 500;
        }
        $response->getBody()->write($json);
        return $response->withStatus($status)->withHeader('Content-Type', 'application/json');
    }
}

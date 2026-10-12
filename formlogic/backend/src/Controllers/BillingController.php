<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
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
    use JsonResponseTrait;

    private PayPalService $paypal;
    private MySQLConnection $db;
    private ?AuditService $auditService;
    private LoggerInterface $logger;
    private ?PlanService $planService;
    private IpResolver $ipResolver;
    private bool $betaMode;

    private int $pricePerMonthCents;
    private string $currency = 'USD';
    private const MAX_MONTHS = 12;
    /** Webhook events that mean the money of a capture is not, or no longer, the merchant's. */
    private const MONEY_BACK_EVENTS = [
        'PAYMENT.CAPTURE.REFUNDED',
        'PAYMENT.CAPTURE.REVERSED',
        'PAYMENT.CAPTURE.DECLINED',
        'PAYMENT.CAPTURE.DENIED',
    ];

    public function __construct(PayPalService $paypal, MySQLConnection $db, ?AuditService $auditService = null, ?LoggerInterface $logger = null, ?PlanService $planService = null, bool $betaMode = false, private ?\FormLogic\Services\PlatformPlansService $platformPlans = null)
    {
        $this->paypal = $paypal;
        $this->db = $db;
        $this->auditService = $auditService;
        $this->logger = $logger ?? new NullLogger();
        $this->planService = $planService;
        $this->betaMode = $betaMode;
        $this->ipResolver = IpResolver::fromEnvironment();
        $this->platformPlans ??= new \FormLogic\Services\PlatformPlansService();
        $this->pricePerMonthCents = $this->platformPlans->status()['pricePerMonthCents'];
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
            'active' => true,
            'plans' => $this->platformPlans->status(),
            'pricePerMonthCents' => $this->pricePerMonthCents,
            'currency' => $this->currency,
            'maxMonths' => self::MAX_MONTHS,
            // During the public beta everything is free and payments are turned off.
            'betaMode' => $this->betaMode,
            'paypalEnabled' => !$this->betaMode && $this->platformPlans->status()['paymentsEnabled'] && $this->paypal->isConfigured(),
            'paypalClientId' => (!$this->betaMode && $this->platformPlans->status()['paymentsEnabled'] && $this->paypal->isConfigured()) ? $this->paypal->getClientId() : null,
            // Plan usage (forms/storage) — only meaningful when enforcement is on.
            'usage' => $this->planService ? $this->planService->usage($userId) : null,
        ]);
    }

    /** POST /api/billing/orders — create a PayPal order for {months} cloud months. */
    public function createOrder(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if ($this->betaMode) {
            return $this->jsonResponse($response, ['error' => true, 'code' => 'beta_free', 'message' => 'Payments are disabled during the beta — Cloud is free right now.'], 403);
        }
        if (!$this->platformPlans->status()['paymentsEnabled']) {
            return $this->jsonResponse($response, ['error' => true, 'code' => 'payments_disabled', 'message' => 'FormLogic is free. Optional payments are disabled.'], 403);
        }
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
                ($months * 30) . ' days of ' . $this->platformPlans->status()['paidName'],
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
        if ($this->betaMode) {
            return $this->jsonResponse($response, ['error' => true, 'code' => 'beta_free', 'message' => 'Payments are disabled during the beta — Cloud is free right now.'], 403);
        }
        if (!$this->platformPlans->status()['paymentsEnabled']) {
            return $this->jsonResponse($response, ['error' => true, 'code' => 'payments_disabled', 'message' => 'FormLogic is free. Optional payments are disabled.'], 403);
        }
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
        // Anything that is not a capture object is no capture: the indeterminate answer below.
        $capture = is_array($capture) ? $capture : null;

        $captureStatus = strtoupper((string) ($capture['status'] ?? ''));
        $captureId = $capture['id'] ?? null;
        $capturedCents = self::capturedCents($capture);
        $amountOk = $captureId && self::captureMatchesPayment($capture, $payment);

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

        // Indeterminate: DON'T mark terminal. A capture that could not be read stays 'pending'
        // so a retry or the webhook can credit it; one whose amount or currency is not the
        // recorded order's stays 'pending' too, and neither path credits it (the webhook
        // applies the same check), so it is left for support.
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
        $resource = is_array($event['resource'] ?? null) ? $event['resource'] : [];
        $captureId = is_string($resource['id'] ?? null) ? $resource['id'] : '';
        // The capture's parent order id (custom_id was set to "userId:months" on create).
        $pdo = $this->db->getConnection();

        if ($type === 'PAYMENT.CAPTURE.COMPLETED' && $captureId !== '') {
            // Resolve by capture id, falling back to the parent order id — a lost capture
            // response leaves the row 'pending' with capture_id NULL, so this webhook is the
            // only path that can still credit it. Credit idempotently.
            $payment = $this->findPaymentForCapture($captureId, $resource);
            if ($payment && $payment['status'] !== 'completed' && !self::captureMatchesPayment($resource, $payment)) {
                // The same rule the capture call applies: a capture of another amount or
                // currency is not the purchase the order was recorded for. The row stays as
                // it is for support to look at, and the event is acknowledged (PayPal would
                // otherwise redeliver it for days).
                $this->logger->warning('PayPal webhook capture does not match the recorded order', [
                    'capture' => $captureId,
                    'order' => $payment['order_id'],
                    'capturedCents' => self::capturedCents($resource),
                    'capturedCurrency' => $resource['amount']['currency_code'] ?? null,
                    'expectedCents' => (int) $payment['amount_cents'],
                    'expectedCurrency' => $payment['currency'],
                ]);
            } elseif ($payment && $payment['status'] !== 'completed') {
                try { $this->creditPayment($payment, $captureId); } catch (\Throwable $e) {
                    $this->logger->error('Webhook credit failed', ['capture' => $captureId, 'error' => $e->getMessage()]);
                    return $response->withStatus(500);
                }
            }
        } elseif (in_array($type, self::MONEY_BACK_EVENTS, true)) {
            // Money that is not, or no longer, the merchant's. REFUNDED (the operator refunded it)
            // and REVERSED (PayPal took it back) carry a refund, whose id is the refund's own: the
            // capture it gives money back from is named only by its 'up' link. DECLINED (Payments
            // v2) and DENIED (v1) carry the capture that did not go through. An older reversal
            // that carries the capture itself is still read by its id.
            $refunds = in_array($type, ['PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED'], true);
            $targetCaptureId = ($refunds ? self::refundedCaptureId($resource) : null) ?? $captureId;
            $payment = $targetCaptureId !== '' ? $this->findPaymentForCapture($targetCaptureId, $resource) : null;
            if (!$payment) {
                $this->logger->warning('PayPal webhook names no payment recorded here', ['type' => $type, 'resource' => $captureId, 'capture' => $targetCaptureId]);
                return $response->withStatus(200);
            }
            if ($refunds && !self::refundsWholePayment($resource, $payment)) {
                // Part of the payment given back (a goodwill credit, say): which months it was
                // meant to cover is the operator's to say. Kept for support; the months stay until
                // the refunds add up to the whole payment.
                $this->recordPartialRefund($payment, $targetCaptureId, $type, $resource);
                return $response->withStatus(200);
            }
            if ($payment['status'] === 'completed') {
                // Already credited — revoke the cloud time it granted and flag the account
                // (audit), instead of silently ignoring it.
                try { $this->reversePayment($payment, $targetCaptureId, $type); } catch (\Throwable $e) {
                    $this->logger->error('Webhook reversal failed', ['capture' => $targetCaptureId, 'error' => $e->getMessage()]);
                    return $response->withStatus(500);
                }
            } else {
                // Not yet credited (a held eCheck that bounced, or was given back while held):
                // failed, so a completion delivered later cannot credit it.
                $pdo->prepare("UPDATE payments SET status = 'failed' WHERE id = ? AND status IN ('pending','processing')")->execute([$payment['id']]);
                $this->logger->info('PayPal webhook failed a payment that was not credited', ['type' => $type, 'payment' => $payment['id']]);
            }
        }
        return $response->withStatus(200);
    }

    /** The capture a refund gives money back from: the id in its 'up' link (…/v2/payments/captures/{id}). */
    private static function refundedCaptureId(array $refund): ?string
    {
        foreach (is_array($refund['links'] ?? null) ? $refund['links'] : [] as $link) {
            if (is_array($link) && ($link['rel'] ?? null) === 'up' && is_string($link['href'] ?? null)
                && preg_match('#/v[12]/payments/captures?/([A-Za-z0-9-]+)/?(?:[?\#]|$)#', $link['href'], $m) === 1) {
                return $m[1];
            }
        }
        return null;
    }

    /**
     * Whether everything the payment was recorded for has now been given back: the refunded total
     * so far (seller_payable_breakdown.total_refunded_amount, or this refund's own amount when the
     * event does not carry a total), in the payment's currency, reaches the recorded amount.
     */
    private static function refundsWholePayment(array $refund, array $payment): bool
    {
        $total = $refund['seller_payable_breakdown']['total_refunded_amount'] ?? null;
        $money = is_array($total) ? $total : ($refund['amount'] ?? null);
        if (!is_array($money)) {
            return false;
        }
        return self::capturedCents(['amount' => $money]) >= (int) $payment['amount_cents']
            && strtoupper((string) ($money['currency_code'] ?? '')) === strtoupper((string) $payment['currency']);
    }

    /** Log and audit a refund that gives back part of a payment; the months are left as they are. */
    private function recordPartialRefund(array $payment, string $captureId, string $type, array $refund): void
    {
        $total = $refund['seller_payable_breakdown']['total_refunded_amount'] ?? $refund['amount'] ?? null;
        $details = [
            'event' => $type,
            'payment' => $payment['id'],
            'refund' => is_string($refund['id'] ?? null) ? $refund['id'] : null,
            'refundedCents' => is_array($total) ? self::capturedCents(['amount' => $total]) : null,
            'refundedCurrency' => is_array($total) ? ($total['currency_code'] ?? null) : null,
            'amountCents' => (int) $payment['amount_cents'],
            'currency' => $payment['currency'],
            'months' => (int) $payment['months'],
        ];
        $this->logger->warning('PayPal refund gives back part of a payment; its months are left for support to adjust', $details + ['capture' => $captureId]);
        if ($this->auditService) {
            try {
                $this->auditService->log('billing.partial_refund', 'payment', $captureId, (string) $payment['user_id'], null, $details);
            } catch (\Throwable $e) { /* audit is non-critical */ }
        }
    }

    /** A PayPal capture's amount in cents, or -1 when it carries none. */
    private static function capturedCents(?array $capture): int
    {
        $value = $capture['amount']['value'] ?? null;
        return is_string($value) || is_int($value) || is_float($value) ? (int) round(((float) $value) * 100) : -1;
    }

    /**
     * Whether a PayPal capture is for exactly what the server recorded when it created the order.
     * Asked on both crediting paths (the capture call and the webhook): the months credited come
     * from the recorded order, so a capture of any other amount or currency must not credit it.
     */
    private static function captureMatchesPayment(?array $capture, array $payment): bool
    {
        return self::capturedCents($capture) === (int) $payment['amount_cents']
            && strtoupper((string) ($capture['amount']['currency_code'] ?? '')) === strtoupper((string) $payment['currency']);
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

    /** Revoke the cloud time granted by a now-refunded/reversed/charged-back payment (idempotent). */
    private function reversePayment(array $payment, string $captureId, string $eventType): void
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
        $this->logger->warning('PayPal payment given back; the cloud time it bought was taken back', [
            'event' => $eventType, 'payment' => $payment['id'], 'capture' => $captureId, 'months' => (int) $payment['months'],
        ]);
        if ($this->auditService) {
            try {
                $this->auditService->log('billing.reversal', 'payment', $captureId, (string) $payment['user_id'], null, ['months' => (int) $payment['months'], 'amountCents' => (int) $payment['amount_cents'], 'event' => $eventType]);
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
            'active' => true,
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
}

<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Services\PayPalService;
use FormLogic\Services\AuditService;
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
    private IpResolver $ipResolver;

    private int $pricePerMonthCents;
    private string $currency = 'USD';
    private const MAX_MONTHS = 12;

    public function __construct(PayPalService $paypal, MySQLConnection $db, ?AuditService $auditService = null, ?LoggerInterface $logger = null)
    {
        $this->paypal = $paypal;
        $this->db = $db;
        $this->auditService = $auditService;
        $this->logger = $logger ?? new NullLogger();
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
                $months . ' month' . ($months === 1 ? '' : 's') . ' of FormLogic Cloud',
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
            $cloudUntil = $this->getCloudUntil($userId);
            return $this->jsonResponse($response, ['cloudUntil' => $cloudUntil, 'active' => $cloudUntil !== null && strtotime($cloudUntil) > time(), 'alreadyProcessed' => true]);
        }

        try {
            $res = $this->paypal->captureOrder($orderId);
        } catch (\Throwable $e) {
            $this->logger->error('PayPal capture failed', ['order' => $orderId, 'error' => $e->getMessage()]);
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Could not confirm the payment. If you were charged, contact support.'], 502);
        }

        // Verify the capture really completed for the exact amount we recorded.
        $capture = $res['purchase_units'][0]['payments']['captures'][0] ?? null;
        $captureId = $capture['id'] ?? null;
        $capturedCents = isset($capture['amount']['value']) ? (int) round(((float) $capture['amount']['value']) * 100) : -1;
        $ok = ($res['status'] ?? '') === 'COMPLETED'
            && ($capture['status'] ?? '') === 'COMPLETED'
            && $captureId
            && $capturedCents === (int) $payment['amount_cents'];

        if (!$ok) {
            $pdo->prepare('UPDATE payments SET status = ? WHERE id = ? AND status = ?')->execute(['failed', $payment['id'], 'pending']);
            $this->logger->warning('PayPal capture not completed/mismatched', ['order' => $orderId, 'status' => $res['status'] ?? null, 'capturedCents' => $capturedCents, 'expected' => $payment['amount_cents']]);
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Payment was not completed.'], 400);
        }

        $months = (int) $payment['months'];
        try {
            $pdo->beginTransaction();
            // Mark completed only if still pending — wins the race against double-capture.
            $upd = $pdo->prepare('UPDATE payments SET status = ?, capture_id = ? WHERE id = ? AND status = ?');
            $upd->execute(['completed', $captureId, $payment['id'], 'pending']);
            if ($upd->rowCount() === 0) {
                $pdo->rollBack();
                $cloudUntil = $this->getCloudUntil($userId);
                return $this->jsonResponse($response, ['cloudUntil' => $cloudUntil, 'active' => $cloudUntil !== null && strtotime($cloudUntil) > time(), 'alreadyProcessed' => true]);
            }
            // Stack months from max(now, current expiry) — no subscription.
            $credit = $pdo->prepare(
                'UPDATE users SET cloud_until = DATE_ADD(GREATEST(COALESCE(cloud_until, NOW()), NOW()), INTERVAL ? MONTH) WHERE id = ?'
            );
            $credit->execute([$months, $userId]);
            $pdo->commit();
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            $this->logger->error('Crediting cloud months failed after capture', ['order' => $orderId, 'capture' => $captureId, 'error' => $e->getMessage()]);
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Payment captured but crediting failed. Contact support with order ' . $orderId . '.'], 500);
        }

        if ($this->auditService) {
            try {
                $this->auditService->log('billing.capture', 'payment', $captureId, $userId, $this->ipResolver->getClientIp($request), ['months' => $months, 'amountCents' => (int) $payment['amount_cents']]);
            } catch (\Throwable $e) { /* audit is non-critical */ }
        }

        $cloudUntil = $this->getCloudUntil($userId);
        return $this->jsonResponse($response, ['cloudUntil' => $cloudUntil, 'active' => $cloudUntil !== null && strtotime($cloudUntil) > time(), 'monthsAdded' => $months]);
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

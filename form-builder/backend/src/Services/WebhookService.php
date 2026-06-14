<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use Psr\Log\LoggerInterface;
use Psr\Log\NullLogger;
use PDO;

class WebhookService
{
    private PDO $mysql;
    private LoggerInterface $logger;

    public function __construct(MySQLConnection $mysql, ?LoggerInterface $logger = null)
    {
        $this->mysql = $mysql->getConnection();
        $this->logger = $logger ?? new NullLogger();
    }

    public function createWebhook(string $formId, string $userId, string $url, array $events, ?string $description = null): array
    {
        // Validate URL before storing
        $parsed = parse_url($url);
        if (!$parsed || !isset($parsed['scheme']) || !isset($parsed['host'])) {
            throw new \InvalidArgumentException('Invalid webhook URL');
        }
        if (!in_array($parsed['scheme'], ['http', 'https'], true)) {
            throw new \InvalidArgumentException('Webhook URL must use HTTP or HTTPS');
        }

        $id = $this->generateUuid();
        $secret = bin2hex(random_bytes(32));

        $stmt = $this->mysql->prepare("
            INSERT INTO webhooks (id, form_id, user_id, url, secret, events, is_active, description)
            VALUES (:id, :form_id, :user_id, :url, :secret, :events, 1, :description)
        ");
        $stmt->execute([
            'id' => $id,
            'form_id' => $formId,
            'user_id' => $userId,
            'url' => $url,
            'secret' => $secret,
            'events' => json_encode($events),
            'description' => $description,
        ]);

        $webhook = $this->getWebhook($id);
        // Include secret only on creation
        $webhook['secret'] = $secret;
        return $webhook;
    }

    public function getWebhooksForForm(string $formId): array
    {
        $stmt = $this->mysql->prepare("SELECT id, form_id, user_id, url, events, is_active, description, created_at, updated_at FROM webhooks WHERE form_id = :form_id ORDER BY created_at DESC");
        $stmt->execute(['form_id' => $formId]);

        $webhooks = [];
        while ($row = $stmt->fetch()) {
            $webhooks[] = $this->formatWebhook($row);
        }
        return $webhooks;
    }

    public function getWebhook(string $webhookId): ?array
    {
        $stmt = $this->mysql->prepare("SELECT id, form_id, user_id, url, events, is_active, description, created_at, updated_at FROM webhooks WHERE id = :id");
        $stmt->execute(['id' => $webhookId]);
        $row = $stmt->fetch();
        return $row ? $this->formatWebhook($row) : null;
    }

    public function updateWebhook(string $webhookId, array $data): ?array
    {
        // Defense-in-depth: validate URL at service layer too
        if (isset($data['url'])) {
            $parsed = parse_url($data['url']);
            if (!$parsed || !isset($parsed['scheme']) || !isset($parsed['host'])) {
                throw new \InvalidArgumentException('Invalid webhook URL');
            }
            if (!in_array($parsed['scheme'], ['http', 'https'], true)) {
                throw new \InvalidArgumentException('Webhook URL must use HTTP or HTTPS');
            }
        }

        $updates = [];
        $params = ['id' => $webhookId];

        if (isset($data['url'])) {
            $updates[] = "url = :url";
            $params['url'] = $data['url'];
        }
        if (isset($data['events'])) {
            $updates[] = "events = :events";
            $params['events'] = json_encode($data['events']);
        }
        if (isset($data['is_active'])) {
            $updates[] = "is_active = :is_active";
            $params['is_active'] = $data['is_active'] ? 1 : 0;
        }
        if (isset($data['description'])) {
            $updates[] = "description = :description";
            $params['description'] = $data['description'];
        }

        if (empty($updates)) {
            return $this->getWebhook($webhookId);
        }

        $sql = "UPDATE webhooks SET " . implode(', ', $updates) . " WHERE id = :id";
        $stmt = $this->mysql->prepare($sql);
        $stmt->execute($params);

        return $this->getWebhook($webhookId);
    }

    public function deleteWebhook(string $webhookId): bool
    {
        $stmt = $this->mysql->prepare("DELETE FROM webhooks WHERE id = :id");
        $stmt->execute(['id' => $webhookId]);
        return $stmt->rowCount() > 0;
    }

    public function getDeliveries(string $webhookId, int $limit = 20): array
    {
        $stmt = $this->mysql->prepare(
            "SELECT * FROM webhook_deliveries WHERE webhook_id = :webhook_id ORDER BY created_at DESC LIMIT :lim"
        );
        $stmt->bindValue('webhook_id', $webhookId);
        $stmt->bindValue('lim', $limit, PDO::PARAM_INT);
        $stmt->execute();

        $deliveries = [];
        while ($row = $stmt->fetch()) {
            $deliveries[] = [
                'id' => $row['id'],
                'webhookId' => $row['webhook_id'],
                'event' => $row['event'],
                'responseStatus' => $row['response_status'] ? (int)$row['response_status'] : null,
                'durationMs' => $row['duration_ms'] ? (int)$row['duration_ms'] : null,
                'success' => (bool)$row['success'],
                'errorMessage' => $row['error_message'],
                'createdAt' => $row['created_at'],
            ];
        }
        return $deliveries;
    }

    /**
     * Dispatch a webhook event to all active webhooks for a form.
     *
     * Deliveries run in parallel via curl_multi so a form with N webhooks (or a
     * single slow endpoint) no longer serializes N × the timeout onto the
     * submitter's request — the whole batch is bounded by the slowest single
     * delivery instead of their sum.
     */
    public function dispatch(string $formId, string $event, array $payload): void
    {
        try {
            $stmt = $this->mysql->prepare(
                "SELECT * FROM webhooks WHERE form_id = :form_id AND is_active = 1"
            );
            $stmt->execute(['form_id' => $formId]);

            $matching = [];
            while ($webhook = $stmt->fetch()) {
                $events = json_decode($webhook['events'], true) ?? [];
                if (in_array($event, $events, true)) {
                    $matching[] = $webhook;
                }
            }

            if (!empty($matching)) {
                $this->deliverBatch($matching, $event, $payload);
            }
        } catch (\Exception $e) {
            $this->logger->error('Webhook dispatch error', [
                'formId' => $formId,
                'event' => $event,
                'exception' => $e->getMessage(),
            ]);
        }
    }

    /**
     * Deliver an event to multiple webhooks concurrently with curl_multi.
     */
    private function deliverBatch(array $webhooks, string $event, array $payload): void
    {
        $mh = curl_multi_init();
        // deliveryId => ['ch' => handle, 'webhook' => row, 'body' => string, 'start' => float]
        $handles = [];

        foreach ($webhooks as $webhook) {
            $deliveryId = $this->generateUuid();
            $body = json_encode(['event' => $event, 'payload' => $payload, 'deliveryId' => $deliveryId]);

            // Cap payload size to prevent OOM and excessive bandwidth
            if (strlen($body) > 5 * 1024 * 1024) {
                $this->logger->warning('Webhook payload too large, skipping delivery', [
                    'webhookId' => $webhook['id'],
                    'event' => $event,
                    'payloadSize' => strlen($body),
                ]);
                // Oversized payload won't shrink on retry — permanent failure.
                $this->logDelivery($deliveryId, $webhook['id'], $event, null, null, null, 0, false, 'Payload exceeded 5MB size limit', 'abandoned', 1, null);
                continue;
            }

            try {
                $ch = $this->buildDeliveryHandle($webhook, $event, $body, $deliveryId);
            } catch (\Throwable $e) {
                // SSRF / URL validation failure — schedule a retry (could be a
                // transient DNS issue; the worker re-validates each time).
                $this->logDelivery($deliveryId, $webhook['id'], $event, $body, null, null, 0, false, $e->getMessage(), 'failed', 1, $this->nextRetryTimestamp(1));
                continue;
            }

            curl_multi_add_handle($mh, $ch);
            $handles[$deliveryId] = ['ch' => $ch, 'webhook' => $webhook, 'body' => $body, 'start' => microtime(true)];
        }

        if (empty($handles)) {
            curl_multi_close($mh);
            return;
        }

        // Drive the parallel transfers to completion.
        do {
            $status = curl_multi_exec($mh, $running);
            if ($running) {
                curl_multi_select($mh, 1.0);
            }
        } while ($running && $status === CURLM_OK);

        foreach ($handles as $deliveryId => $h) {
            $ch = $h['ch'];
            $responseBody = curl_multi_getcontent($ch);
            $responseStatus = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
            $errno = curl_errno($ch);
            $success = false;
            $errorMessage = null;

            if ($errno || $responseBody === false || $responseStatus === 0) {
                $errorMessage = curl_error($ch) ?: 'curl transfer failed';
            } else {
                $success = $responseStatus >= 200 && $responseStatus < 300;
                if (!$success) {
                    $errorMessage = 'HTTP ' . $responseStatus;
                }
            }

            $durationMs = (int)((microtime(true) - $h['start']) * 1000);
            $this->logDelivery(
                $deliveryId,
                $h['webhook']['id'],
                $event,
                $h['body'],
                $responseStatus ?: null,
                is_string($responseBody) ? $responseBody : null,
                $durationMs,
                $success,
                $errorMessage,
                $success ? 'success' : 'failed',
                1,
                $success ? null : $this->nextRetryTimestamp(1)
            );

            curl_multi_remove_handle($mh, $ch);
            curl_close($ch);
        }

        curl_multi_close($mh);
    }

    /**
     * Build an SSRF-guarded curl handle for a single webhook delivery.
     * Throws on any URL/host/IP validation failure.
     *
     * @return \CurlHandle
     */
    private function buildDeliveryHandle(array $webhook, string $event, string $body, string $deliveryId)
    {
        $signature = 'sha256=' . hash_hmac('sha256', $body, $webhook['secret']);

        // SSRF protection: resolve hostname and block private/reserved IPs
        $parsedUrl = parse_url($webhook['url']);
        $host = $parsedUrl['host'] ?? '';
        $port = $parsedUrl['port'] ?? (($parsedUrl['scheme'] ?? 'https') === 'https' ? 443 : 80);
        if ($host === '') {
            throw new \RuntimeException('Webhook URL has no valid host');
        }

        // Block known metadata endpoints and localhost (including IPv4-mapped IPv6)
        $blockedHosts = [
            'localhost', '127.0.0.1', '169.254.169.254', 'metadata.google.internal',
            'metadata.azure.internal', '0.0.0.0', '::1', '::ffff:127.0.0.1',
            '::ffff:0:127.0.0.1', '::ffff:169.254.169.254', '::ffff:0.0.0.0',
        ];
        if (in_array(strtolower($host), $blockedHosts, true)) {
            throw new \RuntimeException('Webhook URL host is not allowed');
        }

        $resolvedIps = gethostbynamel($host);
        if ($resolvedIps === false || empty($resolvedIps)) {
            throw new \RuntimeException('Unable to resolve webhook URL hostname');
        }
        foreach ($resolvedIps as $ip) {
            // Strip IPv4-mapped IPv6 prefix for validation
            $checkIp = $ip;
            if (preg_match('/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i', $ip, $m)) {
                $checkIp = $m[1];
            }
            if (!filter_var($checkIp, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) {
                throw new \RuntimeException('Webhook URL resolves to a private or reserved IP address');
            }
        }
        $resolvedIp = $resolvedIps[0];

        $ch = curl_init($webhook['url']);
        $curlOpts = [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 5,
            CURLOPT_CONNECTTIMEOUT => 3,
            CURLOPT_FOLLOWLOCATION => false, // Block redirects to prevent SSRF via redirect
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS | CURLPROTO_HTTP,
            CURLOPT_HTTPHEADER => [
                'Content-Type: application/json',
                'X-FormLogic-Event: ' . $event,
                'X-FormLogic-Signature: ' . $signature,
                'X-FormLogic-Delivery: ' . $deliveryId,
            ],
        ];
        // DNS pinning: connect to the resolved IP to prevent TOCTOU DNS rebinding
        if ($resolvedIp !== null) {
            $curlOpts[CURLOPT_RESOLVE] = ["{$host}:{$port}:{$resolvedIp}"];
        }
        curl_setopt_array($ch, $curlOpts);

        return $ch;
    }

    /**
     * Persist a delivery attempt record. Best-effort — logging must never break
     * the submission flow. `status` is one of success|failed|abandoned|exhausted;
     * `nextRetryAt` schedules a retry pickup by the worker (null = no retry).
     */
    private function logDelivery(
        string $deliveryId,
        string $webhookId,
        string $event,
        ?string $payload,
        ?int $responseStatus,
        ?string $responseBody,
        int $durationMs,
        bool $success,
        ?string $errorMessage,
        string $status = 'success',
        int $attempt = 1,
        ?string $nextRetryAt = null
    ): void {
        try {
            $stmt = $this->mysql->prepare("
                INSERT INTO webhook_deliveries (id, webhook_id, event, payload, response_status, response_body, duration_ms, success, error_message, status, attempt, next_retry_at)
                VALUES (:id, :webhook_id, :event, :payload, :response_status, :response_body, :duration_ms, :success, :error_message, :status, :attempt, :next_retry_at)
            ");
            $stmt->execute([
                'id' => $deliveryId,
                'webhook_id' => $webhookId,
                'event' => $event,
                'payload' => $payload,
                'response_status' => $responseStatus,
                'response_body' => $responseBody !== null ? substr($responseBody, 0, 2000) : null,
                'duration_ms' => $durationMs,
                'success' => $success ? 1 : 0,
                'error_message' => $errorMessage,
                'status' => $status,
                'attempt' => $attempt,
                'next_retry_at' => $nextRetryAt,
            ]);
        } catch (\Exception $e) {
            $this->logger->error('Failed to log webhook delivery', ['exception' => $e->getMessage()]);
        }
    }

    /** Exponential backoff schedule (seconds) for retry attempt N (1-based). */
    private function backoffSeconds(int $attempt): int
    {
        $schedule = [60, 300, 1800, 7200, 21600]; // 1m, 5m, 30m, 2h, 6h
        return $schedule[min(max($attempt, 1), count($schedule)) - 1];
    }

    private function nextRetryTimestamp(int $attempt): string
    {
        return date('Y-m-d H:i:s', time() + $this->backoffSeconds($attempt));
    }

    /**
     * Drain failed webhook deliveries whose retry time has arrived. Intended to
     * be called by a cron worker (bin/webhook-worker.php). Re-applies the SSRF
     * guards at send time (so a deferred retry can't be exploited via DNS
     * rebinding). Returns a small summary.
     *
     * @return array{processed:int,sent:int,failed:int,abandoned:int}
     */
    public function processPendingRetries(int $maxAttempts = 5, int $batchSize = 50): array
    {
        $maxAttempts = max(1, $maxAttempts);
        $batchSize = max(1, min(500, $batchSize));

        $stmt = $this->mysql->prepare("
            SELECT id, webhook_id, event, payload, attempt
            FROM webhook_deliveries
            WHERE status = 'failed' AND attempt < " . (int) $maxAttempts . "
              AND next_retry_at IS NOT NULL AND next_retry_at <= NOW()
            ORDER BY next_retry_at ASC
            LIMIT " . (int) $batchSize . "
        ");
        $stmt->execute();
        $rows = $stmt->fetchAll();

        $sent = 0;
        $failed = 0;
        $abandoned = 0;
        foreach ($rows as $row) {
            $result = $this->retryDelivery($row, $maxAttempts);
            if ($result === 'success') {
                $sent++;
            } elseif ($result === 'abandoned') {
                $abandoned++;
            } else {
                $failed++;
            }
        }

        return ['processed' => count($rows), 'sent' => $sent, 'failed' => $failed, 'abandoned' => $abandoned];
    }

    /** Re-send a single stored delivery. Returns success|failed|abandoned. */
    private function retryDelivery(array $row, int $maxAttempts): string
    {
        $deliveryId = (string) $row['id'];
        $attempt = (int) $row['attempt'] + 1;

        $wStmt = $this->mysql->prepare("SELECT * FROM webhooks WHERE id = :id AND is_active = 1");
        $wStmt->execute(['id' => $row['webhook_id']]);
        $webhook = $wStmt->fetch();
        if (!$webhook) {
            $this->updateDeliveryResult($deliveryId, false, null, null, 0, 'Webhook no longer active', 'abandoned', $attempt, null);
            return 'abandoned';
        }

        $body = $row['payload'];
        if (!is_string($body) || $body === '') {
            $this->updateDeliveryResult($deliveryId, false, null, null, 0, 'No stored payload to retry', 'abandoned', $attempt, null);
            return 'abandoned';
        }

        $start = microtime(true);
        try {
            // SSRF guards are re-applied here (not just at enqueue) to prevent a
            // DNS-rebinding TOCTOU on deferred retries.
            $ch = $this->buildDeliveryHandle($webhook, (string) $row['event'], $body, $deliveryId);
        } catch (\Throwable $e) {
            $exhausted = $attempt >= $maxAttempts;
            $this->updateDeliveryResult($deliveryId, false, null, null, 0, $e->getMessage(), $exhausted ? 'exhausted' : 'failed', $attempt, $exhausted ? null : $this->nextRetryTimestamp($attempt));
            return $exhausted ? 'abandoned' : 'failed';
        }

        $responseBody = curl_exec($ch);
        $responseStatus = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $errno = curl_errno($ch);
        $success = false;
        $errorMessage = null;
        if ($errno || $responseBody === false || $responseStatus === 0) {
            $errorMessage = curl_error($ch) ?: 'curl transfer failed';
        } else {
            $success = $responseStatus >= 200 && $responseStatus < 300;
            if (!$success) {
                $errorMessage = 'HTTP ' . $responseStatus;
            }
        }
        curl_close($ch);
        $durationMs = (int)((microtime(true) - $start) * 1000);

        if ($success) {
            $this->updateDeliveryResult($deliveryId, true, $responseStatus ?: null, is_string($responseBody) ? $responseBody : null, $durationMs, null, 'success', $attempt, null);
            return 'success';
        }

        $exhausted = $attempt >= $maxAttempts;
        $this->updateDeliveryResult($deliveryId, false, $responseStatus ?: null, is_string($responseBody) ? $responseBody : null, $durationMs, $errorMessage, $exhausted ? 'exhausted' : 'failed', $attempt, $exhausted ? null : $this->nextRetryTimestamp($attempt));
        return $exhausted ? 'abandoned' : 'failed';
    }

    /** Update an existing delivery row after a retry attempt. */
    private function updateDeliveryResult(string $id, bool $success, ?int $responseStatus, ?string $responseBody, int $durationMs, ?string $errorMessage, string $status, int $attempt, ?string $nextRetryAt): void
    {
        try {
            $stmt = $this->mysql->prepare("
                UPDATE webhook_deliveries
                SET success = :success, response_status = :rs, response_body = :rb, duration_ms = :dm,
                    error_message = :err, status = :status, attempt = :attempt, next_retry_at = :nr
                WHERE id = :id
            ");
            $stmt->execute([
                'success' => $success ? 1 : 0,
                'rs' => $responseStatus,
                'rb' => $responseBody !== null ? substr($responseBody, 0, 2000) : null,
                'dm' => $durationMs,
                'err' => $errorMessage,
                'status' => $status,
                'attempt' => $attempt,
                'nr' => $nextRetryAt,
                'id' => $id,
            ]);
        } catch (\Exception $e) {
            $this->logger->error('Failed to update webhook delivery', ['exception' => $e->getMessage()]);
        }
    }

    private function formatWebhook(array $row): array
    {
        return [
            'id' => $row['id'],
            'formId' => $row['form_id'],
            'userId' => $row['user_id'],
            'url' => $row['url'],
            'events' => json_decode($row['events'], true) ?? [],
            'isActive' => (bool)$row['is_active'],
            'description' => $row['description'],
            'createdAt' => $row['created_at'],
            'updatedAt' => $row['updated_at'],
        ];
    }

    private function generateUuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}

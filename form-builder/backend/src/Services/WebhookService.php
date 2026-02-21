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
     * Dispatch a webhook event to all active webhooks for a form
     */
    public function dispatch(string $formId, string $event, array $payload): void
    {
        try {
            $stmt = $this->mysql->prepare(
                "SELECT * FROM webhooks WHERE form_id = :form_id AND is_active = 1"
            );
            $stmt->execute(['form_id' => $formId]);

            while ($webhook = $stmt->fetch()) {
                $events = json_decode($webhook['events'], true) ?? [];
                if (!in_array($event, $events)) {
                    continue;
                }
                $this->deliver($webhook, $event, $payload);
            }
        } catch (\Exception $e) {
            $this->logger->error('Webhook dispatch error', [
                'formId' => $formId,
                'event' => $event,
                'exception' => $e->getMessage(),
            ]);
        }
    }

    private function deliver(array $webhook, string $event, array $payload): void
    {
        $deliveryId = $this->generateUuid();
        $body = json_encode(['event' => $event, 'payload' => $payload, 'deliveryId' => $deliveryId]);
        $signature = 'sha256=' . hash_hmac('sha256', $body, $webhook['secret']);

        $startTime = microtime(true);
        $responseStatus = null;
        $responseBody = null;
        $success = false;
        $errorMessage = null;

        try {
            $ch = curl_init($webhook['url']);
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => $body,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT => 5,
                CURLOPT_CONNECTTIMEOUT => 3,
                CURLOPT_HTTPHEADER => [
                    'Content-Type: application/json',
                    'X-FormLogic-Event: ' . $event,
                    'X-FormLogic-Signature: ' . $signature,
                    'X-FormLogic-Delivery: ' . $deliveryId,
                ],
            ]);

            $responseBody = curl_exec($ch);
            $responseStatus = curl_getinfo($ch, CURLINFO_HTTP_CODE);

            if (curl_errno($ch)) {
                $errorMessage = curl_error($ch);
            } else {
                $success = $responseStatus >= 200 && $responseStatus < 300;
            }

            curl_close($ch);
        } catch (\Exception $e) {
            $errorMessage = $e->getMessage();
        }

        $durationMs = (int)((microtime(true) - $startTime) * 1000);

        // Log delivery
        try {
            $stmt = $this->mysql->prepare("
                INSERT INTO webhook_deliveries (id, webhook_id, event, payload, response_status, response_body, duration_ms, success, error_message)
                VALUES (:id, :webhook_id, :event, :payload, :response_status, :response_body, :duration_ms, :success, :error_message)
            ");
            $stmt->execute([
                'id' => $deliveryId,
                'webhook_id' => $webhook['id'],
                'event' => $event,
                'payload' => $body,
                'response_status' => $responseStatus,
                'response_body' => $responseBody ? substr($responseBody, 0, 2000) : null,
                'duration_ms' => $durationMs,
                'success' => $success ? 1 : 0,
                'error_message' => $errorMessage,
            ]);
        } catch (\Exception $e) {
            $this->logger->error('Failed to log webhook delivery', ['exception' => $e->getMessage()]);
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

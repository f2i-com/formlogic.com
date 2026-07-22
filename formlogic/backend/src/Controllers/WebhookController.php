<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\WebhookService;
use FormLogic\Services\FormService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

class WebhookController
{
    use JsonResponseTrait;

    private WebhookService $webhookService;
    private FormService $formService;

    public function __construct(WebhookService $webhookService, FormService $formService)
    {
        $this->webhookService = $webhookService;
        $this->formService = $formService;
    }

    public function listWebhooks(Request $request, Response $response, array $args): Response
    {
        $formId = $args['id'];
        $userId = $request->getAttribute('userId');

        if (!$this->authorizeFormOwner($formId, $userId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found or access denied'], 404);
        }

        $webhooks = $this->webhookService->getWebhooksForForm($formId);
        return $this->jsonResponse($response, ['webhooks' => $webhooks]);
    }

    public function createWebhook(Request $request, Response $response, array $args): Response
    {
        $formId = $args['id'];
        $userId = $request->getAttribute('userId');

        if (!$this->authorizeFormOwner($formId, $userId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found or access denied'], 404);
        }

        $data = $request->getParsedBody();
        $url = $data['url'] ?? '';
        $events = $data['events'] ?? [];
        $description = $data['description'] ?? null;

        if (empty($url) || !filter_var($url, FILTER_VALIDATE_URL)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'A valid URL is required'], 400);
        }

        // Enforce HTTPS in production
        $scheme = parse_url($url, PHP_URL_SCHEME);
        if ($scheme !== 'https' && $scheme !== 'http') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'URL must use http or https'], 400);
        }

        // Block internal/private hosts
        if ($this->isBlockedWebhookHost($url)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Webhook URL host is not allowed'], 400);
        }

        if (empty($events) || !is_array($events)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'At least one event is required'], 400);
        }

        $allowedEvents = ['response.created', 'response.updated', 'response.deleted', 'form.published'];
        foreach ($events as $event) {
            if (!in_array($event, $allowedEvents, true)) {
                return $this->jsonResponse($response, ['error' => true, 'message' => "Invalid event: $event"], 400);
            }
        }

        try {
            $webhook = $this->webhookService->createWebhook($formId, $userId, $url, $events, $description);
        } catch (\FormLogic\Services\PrivateFormEncryptedException $e) {
            // E2EE §9.2: no webhooks on private forms — typed, never silent.
            return $this->jsonError($response, $e->getMessage(), 409, \FormLogic\Services\PrivateFormEncryptedException::ERROR_CODE);
        }
        return $this->jsonResponse($response, ['webhook' => $webhook], 201);
    }

    public function updateWebhook(Request $request, Response $response, array $args): Response
    {
        $formId = $args['id'];
        $webhookId = $args['webhookId'];
        $userId = $request->getAttribute('userId');

        if (!$this->authorizeFormOwner($formId, $userId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found or access denied'], 404);
        }

        $webhook = $this->webhookService->getWebhook($webhookId);
        if (!$webhook || $webhook['formId'] !== $formId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Webhook not found'], 404);
        }

        $data = $request->getParsedBody();

        if (isset($data['url'])) {
            if (!filter_var($data['url'], FILTER_VALIDATE_URL)) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'A valid URL is required'], 400);
            }
            $scheme = parse_url($data['url'], PHP_URL_SCHEME);
            if ($scheme !== 'https' && $scheme !== 'http') {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'URL must use http or https'], 400);
            }
            if ($this->isBlockedWebhookHost($data['url'])) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'Webhook URL host is not allowed'], 400);
            }
        }

        if (isset($data['events'])) {
            if (!is_array($data['events']) || empty($data['events'])) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'Events must be a non-empty array'], 400);
            }
            $allowedEvents = ['response.created', 'response.updated', 'response.deleted', 'form.published'];
            foreach ($data['events'] as $event) {
                if (!in_array($event, $allowedEvents, true)) {
                    return $this->jsonResponse($response, ['error' => true, 'message' => "Invalid event: $event"], 400);
                }
            }
        }

        // Only allow known fields to prevent mass-assignment
        $allowedFields = ['url', 'events', 'is_active', 'description'];
        $filtered = array_intersect_key($data, array_flip($allowedFields));
        $updated = $this->webhookService->updateWebhook($webhookId, $filtered);
        return $this->jsonResponse($response, ['webhook' => $updated]);
    }

    public function deleteWebhook(Request $request, Response $response, array $args): Response
    {
        $formId = $args['id'];
        $webhookId = $args['webhookId'];
        $userId = $request->getAttribute('userId');

        if (!$this->authorizeFormOwner($formId, $userId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found or access denied'], 404);
        }

        $webhook = $this->webhookService->getWebhook($webhookId);
        if (!$webhook || $webhook['formId'] !== $formId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Webhook not found'], 404);
        }

        $this->webhookService->deleteWebhook($webhookId);
        return $this->jsonResponse($response, ['success' => true, 'message' => 'Webhook deleted']);
    }

    public function getDeliveries(Request $request, Response $response, array $args): Response
    {
        $formId = $args['id'];
        $webhookId = $args['webhookId'];
        $userId = $request->getAttribute('userId');

        if (!$this->authorizeFormOwner($formId, $userId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found or access denied'], 404);
        }

        $webhook = $this->webhookService->getWebhook($webhookId);
        if (!$webhook || $webhook['formId'] !== $formId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Webhook not found'], 404);
        }

        $deliveries = $this->webhookService->getDeliveries($webhookId);
        return $this->jsonResponse($response, ['deliveries' => $deliveries]);
    }

    /**
     * Validate that a webhook URL does not target internal/private hosts.
     */
    private function isBlockedWebhookHost(string $url): bool
    {
        $host = strtolower(parse_url($url, PHP_URL_HOST) ?? '');
        $blockedHosts = [
            'localhost', '127.0.0.1', '169.254.169.254', 'metadata.google.internal',
            '0.0.0.0', '::1', '::ffff:127.0.0.1', '::ffff:0:127.0.0.1',
            '::ffff:169.254.169.254', '::ffff:0.0.0.0', 'metadata.azure.internal',
        ];
        if (in_array($host, $blockedHosts, true)) {
            return true;
        }
        // Block IP addresses in private/reserved ranges (covers both IPv4 and IPv6)
        if (filter_var($host, FILTER_VALIDATE_IP) && !filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) {
            return true;
        }
        // Resolve hostname and check if it points to a private/reserved IP
        if (!filter_var($host, FILTER_VALIDATE_IP)) {
            $resolved = gethostbyname($host);
            if ($resolved !== $host && filter_var($resolved, FILTER_VALIDATE_IP) && !filter_var($resolved, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) {
                return true;
            }
            // Also check IPv6 resolution
            $ipv6Records = dns_get_record($host, DNS_AAAA);
            if (is_array($ipv6Records)) {
                foreach ($ipv6Records as $record) {
                    $ip = $record['ipv6'] ?? '';
                    if ($ip !== '' && filter_var($ip, FILTER_VALIDATE_IP) && !filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    private function authorizeFormOwner(string $formId, ?string $userId): bool
    {
        if (!$userId) return false;
        $form = $this->formService->getForm($formId);
        return $form && $form['userId'] === $userId;
    }
}

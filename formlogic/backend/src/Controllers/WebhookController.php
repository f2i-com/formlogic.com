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

        if (!is_string($url) || empty($url) || !filter_var($url, FILTER_VALIDATE_URL)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'A valid URL is required'], 400);
        }

        // Single SSRF/URL authority (shared identically with create/update/delivery).
        try {
            WebhookService::validateWebhookUrl($url);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
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
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (\FormLogic\Services\EncryptionEnablingException $e) {
            // Enable-race gate: mid-enable webhook creation fails closed (409).
            return $this->jsonError($response, $e->getMessage(), 409, \FormLogic\Services\EncryptionEnablingException::ERROR_CODE);
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
        if (!is_array($data)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Invalid request body'], 400);
        }

        if (isset($data['url'])) {
            if (!is_string($data['url']) || !filter_var($data['url'], FILTER_VALIDATE_URL)) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'A valid URL is required'], 400);
            }
            try {
                WebhookService::validateWebhookUrl($data['url']);
            } catch (\InvalidArgumentException $e) {
                return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
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
        try {
            $updated = $this->webhookService->updateWebhook($webhookId, $filtered);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
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

    private function authorizeFormOwner(string $formId, ?string $userId): bool
    {
        if (!$userId) return false;
        $form = $this->formService->getForm($formId);
        return $form && $form['userId'] === $userId;
    }
}

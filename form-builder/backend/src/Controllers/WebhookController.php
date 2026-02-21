<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Services\WebhookService;
use FormLogic\Services\FormService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

class WebhookController
{
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

        if (empty($events) || !is_array($events)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'At least one event is required'], 400);
        }

        $allowedEvents = ['response.created', 'response.updated', 'response.deleted', 'form.published'];
        foreach ($events as $event) {
            if (!in_array($event, $allowedEvents, true)) {
                return $this->jsonResponse($response, ['error' => true, 'message' => "Invalid event: $event"], 400);
            }
        }

        $webhook = $this->webhookService->createWebhook($formId, $userId, $url, $events, $description);
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

        $updated = $this->webhookService->updateWebhook($webhookId, $data);
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

    private function jsonResponse(Response $response, array $data, int $status = 200): Response
    {
        $response->getBody()->write(json_encode($data));
        return $response
            ->withStatus($status)
            ->withHeader('Content-Type', 'application/json');
    }
}

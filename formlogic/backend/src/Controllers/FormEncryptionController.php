<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\EncryptionRequestException;
use FormLogic\Services\FormEncryptionService;
use FormLogic\Services\FormService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Log\LoggerInterface;
use Psr\Log\NullLogger;

/**
 * E2EE per-form encryption API (docs/E2EE_PRIVATE_FORMS_PLAN.md §9.1, §16-P3):
 *   POST /api/forms/{formId}/encryption         → atomic enable (full §9.1 preflight)
 *   GET  /api/forms/{formId}/encryption         → owner key/grant/manifest state
 *   POST /api/forms/{formId}/encryption/schema  → publish a signed schema version
 *
 * Owner-only (the same 404-on-non-owner posture as every form surface), demo
 * refused, admin acting-as refused (not mirrored in AdminActingAsRoutes AND
 * rejected here defensively), ext-sodium required — fail closed with
 * encryption_unavailable, never a fallback (plan D3).
 */
class FormEncryptionController
{
    use JsonResponseTrait;

    private LoggerInterface $logger;

    public function __construct(
        private FormEncryptionService $encryptionService,
        private FormService $formService,
        ?LoggerInterface $logger = null,
        private bool $privateFormsEnabled = true,
    ) {
        $this->logger = $logger ?? new NullLogger();
    }

    public function enable(Request $request, Response $response, array $args): Response
    {
        $formId = (string) ($args['formId'] ?? '');
        if ($guard = $this->guardMutation($request, $response)) {
            return $guard;
        }
        if (!$this->privateFormsEnabled) {
            // Beta gate (plan D9): the PRIVATE_FORMS public-config flag is off.
            return $this->jsonError($response, 'Private forms are not enabled on this server.', 403, 'private_forms_disabled');
        }
        if (!$this->ownsForm($request, $formId)) {
            return $this->jsonError($response, 'Form not found or access denied', 404);
        }
        if (!FormEncryptionService::sodiumAvailable()) {
            return $this->jsonError($response, 'Server-side signature verification (ext-sodium) is unavailable — private forms cannot be enabled.', 503, 'encryption_unavailable');
        }
        $body = $request->getParsedBody();
        if (!is_array($body)) {
            return $this->jsonError($response, 'Invalid request body', 400, 'encryption_payload_invalid');
        }
        try {
            $result = $this->encryptionService->enable($formId, (string) $request->getAttribute('userId'), $body);
            return $this->jsonResponse($response, ['data' => $result]);
        } catch (EncryptionRequestException $e) {
            return $this->jsonError($response, $e->getMessage(), $e->status, $e->errorCode, $e->details);
        } catch (\Throwable $e) {
            $this->logger->error('Private-form enable failed', ['formId' => $formId, 'error' => $e->getMessage()]);
            return $this->jsonError($response, 'An unexpected error occurred', 500);
        }
    }

    public function getEncryption(Request $request, Response $response, array $args): Response
    {
        $formId = (string) ($args['formId'] ?? '');
        if (!$this->ownsForm($request, $formId)) {
            return $this->jsonError($response, 'Form not found or access denied', 404);
        }
        $actor = $request->getAttribute('adminActorId');
        if (is_string($actor) && $actor !== '') {
            return $this->jsonError($response, 'Administrators cannot access form key material.', 403, 'acting_as_denied');
        }
        $state = $this->encryptionService->getState($formId, (string) $request->getAttribute('userId'));
        if ($state === null) {
            return $this->jsonError($response, 'This form is not a private form.', 404, 'private_form_not_encrypted');
        }
        return $this->jsonResponse($response, ['data' => $state]);
    }

    public function publishSchema(Request $request, Response $response, array $args): Response
    {
        $formId = (string) ($args['formId'] ?? '');
        if ($guard = $this->guardMutation($request, $response)) {
            return $guard;
        }
        if (!$this->privateFormsEnabled) {
            return $this->jsonError($response, 'Private forms are not enabled on this server.', 403, 'private_forms_disabled');
        }
        if (!$this->ownsForm($request, $formId)) {
            return $this->jsonError($response, 'Form not found or access denied', 404);
        }
        $body = $request->getParsedBody();
        if (!is_array($body)) {
            return $this->jsonError($response, 'Invalid request body', 400, 'encryption_payload_invalid');
        }
        try {
            $result = $this->encryptionService->publishSchemaVersion($formId, (string) $request->getAttribute('userId'), $body);
            return $this->jsonResponse($response, ['data' => $result]);
        } catch (EncryptionRequestException $e) {
            return $this->jsonError($response, $e->getMessage(), $e->status, $e->errorCode, $e->details);
        } catch (\Throwable $e) {
            $this->logger->error('Private-form schema publish failed', ['formId' => $formId, 'error' => $e->getMessage()]);
            return $this->jsonError($response, 'An unexpected error occurred', 500);
        }
    }

    private function guardMutation(Request $request, Response $response): ?Response
    {
        if ($this->isDemoRequest($request)) {
            return $this->jsonError($response, 'The shared demo account cannot use private forms.', 403, 'demo_readonly');
        }
        $actor = $request->getAttribute('adminActorId');
        if (is_string($actor) && $actor !== '') {
            return $this->jsonError($response, 'Administrators cannot manage form encryption.', 403, 'acting_as_denied');
        }
        return null;
    }

    private function ownsForm(Request $request, string $formId): bool
    {
        $userId = $request->getAttribute('userId');
        if (!is_string($userId) || $userId === '' || $formId === '') {
            return false;
        }
        $form = $this->formService->getForm($formId);
        return $form !== null && ($form['userId'] ?? null) === $userId;
    }
}

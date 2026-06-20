<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use PDO;

class AppResponseService
{
    private PDO $mysql;
    private SQLiteConnection $sqlite;
    private ResponseService $responseService;
    private ?FormLogicRuntime $runtime;
    private ?FormService $formService;

    public function __construct(
        MySQLConnection $mysql,
        SQLiteConnection $sqlite,
        ResponseService $responseService,
        ?FormLogicRuntime $runtime = null,
        ?FormService $formService = null
    ) {
        $this->mysql = $mysql->getConnection();
        $this->sqlite = $sqlite;
        $this->responseService = $responseService;
        $this->runtime = $runtime;
        $this->formService = $formService;
    }

    public function createResponse(string $appId, string $formId, array $data, string $userId, ?string $script = null): array|ScriptRejection
    {
        // Set the server-controlled submitter at the top level where
        // ResponseService::createResponse() reads it, preventing client spoofing.
        // (appId is intentionally not persisted on the response — it's derivable
        // from the form's app — and the previous metadata merge was a no-op since
        // ResponseService rebuilds the metadata object from scratch.)
        $data['submittedByUserId'] = $userId;

        $result = $this->responseService->createResponse($formId, $data, $script);

        // Write response links for linked_record fields
        if (is_array($result) && isset($result['id'])) {
            $this->syncResponseLinks($formId, $result['id'], $data['answers'] ?? []);
        }

        return $result;
    }

    public function getResponses(string $formId, string $scope, string $userId, array $options = []): array
    {
        // Push scope filtering into SQL for correct pagination
        if ($scope === 'own') {
            $options['submittedByUserId'] = $userId;
        }

        return $this->responseService->getFormResponses($formId, $options);
    }

    public function getResponse(string $formId, string $responseId): ?array
    {
        return $this->responseService->getResponse($formId, $responseId);
    }

    public function updateResponse(string $formId, string $responseId, array $data): ?array
    {
        $result = $this->responseService->updateResponse($formId, $responseId, $data);

        // Re-sync response links if answers were updated
        if ($result && isset($data['answers'])) {
            $this->syncResponseLinks($formId, $responseId, $data['answers']);
        }

        return $result;
    }

    public function deleteResponse(string $formId, string $responseId): bool
    {
        $deleted = $this->responseService->deleteResponse($formId, $responseId);

        if ($deleted) {
            // Clean up response links (both as source and target)
            $stmt = $this->mysql->prepare("DELETE FROM response_links WHERE source_response_id = :id OR target_response_id = :id2");
            $stmt->execute(['id' => $responseId, 'id2' => $responseId]);
        }

        return $deleted;
    }

    /**
     * Sync response_links rows for a response's linked_record fields. Delegates to
     * ResponseService's implementation, which is BEST-EFFORT (a link-index hiccup
     * must never fail an already-persisted response — otherwise the submitter sees
     * a 500 and re-submits, creating a duplicate) and VALIDATES that each target
     * exists before inserting (so a client can't spoof dangling/cross-form links).
     */
    private function syncResponseLinks(string $formId, string $responseId, array $answers): void
    {
        if (!$this->formService) {
            return;
        }

        $form = $this->formService->getForm($formId);
        if (!$form) {
            return;
        }

        $this->responseService->syncResponseLinks($formId, $responseId, $form['fields'] ?? [], $answers);
    }
}

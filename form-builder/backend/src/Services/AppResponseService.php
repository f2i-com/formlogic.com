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
        // Add app context to metadata
        $data['metadata'] = array_merge($data['metadata'] ?? [], [
            'appId' => $appId,
            'submittedByUserId' => $userId,
        ]);

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
     * Sync response_links rows for a response's linked_record fields.
     * Deletes old links and inserts new ones.
     */
    private function syncResponseLinks(string $formId, string $responseId, array $answers): void
    {
        if (!$this->formService) return;

        $form = $this->formService->getForm($formId);
        if (!$form) return;

        // Find linked_record fields
        $linkedFields = [];
        foreach ($form['fields'] as $field) {
            if ($field['type'] === 'linked_record' && !empty($field['properties']['targetFormId'])) {
                $linkedFields[] = $field;
            }
        }

        if (empty($linkedFields)) return;

        // Wrap delete + insert in a transaction to prevent inconsistent reads
        $this->mysql->beginTransaction();
        try {
            // Delete existing links for this response
            $stmt = $this->mysql->prepare("DELETE FROM response_links WHERE source_response_id = :id");
            $stmt->execute(['id' => $responseId]);

            // Insert new links
            $insertStmt = $this->mysql->prepare("
                INSERT INTO response_links (id, source_form_id, source_response_id, target_form_id, target_response_id, field_id)
                VALUES (:id, :source_form_id, :source_response_id, :target_form_id, :target_response_id, :field_id)
            ");

            foreach ($linkedFields as $field) {
                $targetFormId = $field['properties']['targetFormId'];
                $val = $answers[$field['id']] ?? null;
                if ($val === null) continue;

                $ids = is_array($val) ? $val : [$val];
                foreach ($ids as $targetResponseId) {
                    if (!is_string($targetResponseId) || $targetResponseId === '') continue;
                    $insertStmt->execute([
                        'id' => $this->generateUuid(),
                        'source_form_id' => $formId,
                        'source_response_id' => $responseId,
                        'target_form_id' => $targetFormId,
                        'target_response_id' => $targetResponseId,
                        'field_id' => $field['id'],
                    ]);
                }
            }

            $this->mysql->commit();
        } catch (\Exception $e) {
            $this->mysql->rollBack();
            throw $e;
        }
    }

    private function generateUuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}

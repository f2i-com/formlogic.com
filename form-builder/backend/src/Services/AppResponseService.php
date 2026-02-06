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

    public function __construct(
        MySQLConnection $mysql,
        SQLiteConnection $sqlite,
        ResponseService $responseService,
        ?FormLogicRuntime $runtime = null
    ) {
        $this->mysql = $mysql->getConnection();
        $this->sqlite = $sqlite;
        $this->responseService = $responseService;
        $this->runtime = $runtime;
    }

    public function createResponse(string $appId, string $formId, array $data, string $userId, ?string $script = null): array|ScriptRejection
    {
        // Add app context to metadata
        $data['metadata'] = array_merge($data['metadata'] ?? [], [
            'appId' => $appId,
            'submittedByUserId' => $userId,
        ]);

        return $this->responseService->createResponse($formId, $data, $script);
    }

    public function getResponses(string $formId, string $scope, string $userId, array $options = []): array
    {
        $responses = $this->responseService->getFormResponses($formId, $options);

        if ($scope === 'own') {
            $responses = array_values(array_filter($responses, function ($response) use ($userId) {
                return ($response['metadata']['submittedByUserId'] ?? null) === $userId;
            }));
        }

        return $responses;
    }

    public function getResponse(string $formId, string $responseId): ?array
    {
        return $this->responseService->getResponse($formId, $responseId);
    }

    public function updateResponse(string $formId, string $responseId, array $data): ?array
    {
        return $this->responseService->updateResponse($formId, $responseId, $data);
    }

    public function deleteResponse(string $formId, string $responseId): bool
    {
        return $this->responseService->deleteResponse($formId, $responseId);
    }
}

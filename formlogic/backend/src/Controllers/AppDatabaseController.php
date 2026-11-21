<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Services\FormSqliteDatabaseService;
use InvalidArgumentException;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use RuntimeException;

/**
 * Unified SQLite Database endpoints for ANY FormLogic App (Form Apps AND SoftN Apps):
 *  - Turn a Form App's forms into real SQLite tables
 *  - Sync newly added forms/fields into SQLite tables
 *  - Share SQLite databases across Form Apps, SoftN Apps, and Secondary API Backends
 *  - Link existing FormLogic Forms to any SQLite table
 *  - Attach Forms + Charts to a shared SQLite database for multiple frontends
 *  - Scaffold a SoftN App directly on top of a Form App's SQLite database
 */
final class AppDatabaseController
{
    public function __construct(private FormSqliteDatabaseService $dbService) {}

    public function describe(Request $request, Response $response, array $args): Response
    {
        return $this->run($response, function () use ($request, $args): array {
            $userId = $this->requireUser($request);
            return $this->dbService->describeAppDatabase((string) ($args['id'] ?? ''), $userId);
        });
    }

    public function enable(Request $request, Response $response, array $args): Response
    {
        return $this->run($response, function () use ($request, $args): array {
            $userId = $this->requireUser($request);
            return $this->dbService->enableForApp((string) ($args['id'] ?? ''), $userId);
        });
    }

    public function sync(Request $request, Response $response, array $args): Response
    {
        return $this->run($response, function () use ($request, $args): array {
            $userId = $this->requireUser($request);
            return $this->dbService->syncAppForms((string) ($args['id'] ?? ''), $userId);
        });
    }

    public function setLink(Request $request, Response $response, array $args): Response
    {
        return $this->run($response, function () use ($request, $args): array {
            $userId = $this->requireUser($request);
            $body = $request->getParsedBody();
            if (!is_array($body)) {
                throw new InvalidArgumentException('Provide { targetAppId: string | null }.');
            }
            $target = $body['targetAppId'] ?? null;
            if ($target !== null && !is_string($target)) {
                throw new InvalidArgumentException('targetAppId must be a string or null.');
            }
            return $this->dbService->setAppSharedDatabase((string) ($args['id'] ?? ''), $target, $userId);
        });
    }

    public function linkForm(Request $request, Response $response, array $args): Response
    {
        return $this->run($response, function () use ($request, $args): array {
            $userId = $this->requireUser($request);
            $body = $request->getParsedBody();
            if (!is_array($body)) {
                throw new InvalidArgumentException('Provide { formId, table }.');
            }
            $formId = trim((string) ($body['formId'] ?? ''));
            $table = trim((string) ($body['table'] ?? ''));
            if ($formId === '' || $table === '') {
                throw new InvalidArgumentException('Both formId and table are required.');
            }
            $colMap = is_array($body['columnMap'] ?? null) ? $body['columnMap'] : null;
            return $this->dbService->linkExistingFormToTable($formId, (string) ($args['id'] ?? ''), $table, $userId, $colMap);
        });
    }

    public function attachForms(Request $request, Response $response, array $args): Response
    {
        return $this->run($response, function () use ($request, $args): array {
            $userId = $this->requireUser($request);
            $body = $request->getParsedBody();
            if (!is_array($body)) {
                throw new InvalidArgumentException('Provide { sourceAppId }.');
            }
            $sourceAppId = trim((string) ($body['sourceAppId'] ?? ''));
            if ($sourceAppId === '') {
                throw new InvalidArgumentException('sourceAppId is required.');
            }
            $tables = is_array($body['tables'] ?? null) ? array_values(array_filter($body['tables'], 'is_string')) : [];
            $includeCharts = ($body['includeCharts'] ?? true) !== false;
            return $this->dbService->attachFormsFromDatabase((string) ($args['id'] ?? ''), $sourceAppId, $userId, $tables, $includeCharts);
        });
    }

    public function createSoftnApp(Request $request, Response $response, array $args): Response
    {
        return $this->run($response, function () use ($request, $args): array {
            $userId = $this->requireUser($request);
            $body = $request->getParsedBody();
            $options = is_array($body) ? $body : [];
            return $this->dbService->createSoftnAppForFormDatabase((string) ($args['id'] ?? ''), $userId, $options);
        }, 201);
    }

    private function requireUser(Request $request): string
    {
        $userId = (string) ($request->getAttribute('userId') ?? '');
        if ($userId === '') {
            throw new RuntimeException('Authentication required.', 401);
        }
        return $userId;
    }

    /** @param callable(): array<string, mixed> $fn */
    private function run(Response $response, callable $fn, int $okStatus = 200): Response
    {
        try {
            $data = $fn();
            return $this->json($response, $data, $okStatus);
        } catch (InvalidArgumentException $e) {
            return $this->json($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } catch (RuntimeException $e) {
            $code = $e->getCode();
            $status = ($code >= 400 && $code < 600) ? $code : 400;
            return $this->json($response, ['error' => true, 'message' => $e->getMessage()], $status);
        }
    }

    /** @param array<string, mixed> $payload */
    private function json(Response $response, array $payload, int $status): Response
    {
        $response->getBody()->write(json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR));
        return $response
            ->withStatus($status)
            ->withHeader('Content-Type', 'application/json; charset=utf-8')
            ->withHeader('Cache-Control', 'no-store');
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Services\AppService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

class AppController
{
    private AppService $appService;

    public function __construct(AppService $appService)
    {
        $this->appService = $appService;
    }

    private function authorizeAppOwnership(Request $request, string $appId): ?array
    {
        $app = $this->appService->getApp($appId);
        if (!$app) {
            return null;
        }

        $userId = $request->getAttribute('userId');
        if (!$userId || $app['ownerId'] !== $userId) {
            return null;
        }

        return $app;
    }

    public function index(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $apps = $this->appService->getAllApps($userId);
        return $this->jsonResponse($response, ['apps' => $apps, 'count' => count($apps)]);
    }

    public function create(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $data = $request->getParsedBody();
        if (empty($data['name'])) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App name is required'], 400);
        }

        try {
            $app = $this->appService->createApp($data, $userId);
            return $this->jsonResponse($response, ['app' => $app], 201);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    public function show(Request $request, Response $response, array $args): Response
    {
        $app = $this->authorizeAppOwnership($request, $args['id']);
        if (!$app) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found or access denied'], 404);
        }

        return $this->jsonResponse($response, ['app' => $app]);
    }

    public function update(Request $request, Response $response, array $args): Response
    {
        $app = $this->authorizeAppOwnership($request, $args['id']);
        if (!$app) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found or access denied'], 404);
        }

        $data = $request->getParsedBody();

        try {
            $updatedApp = $this->appService->updateApp($args['id'], $data);
            return $this->jsonResponse($response, ['app' => $updatedApp]);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    public function delete(Request $request, Response $response, array $args): Response
    {
        $app = $this->authorizeAppOwnership($request, $args['id']);
        if (!$app) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found or access denied'], 404);
        }

        $this->appService->deleteApp($args['id']);
        return $this->jsonResponse($response, ['success' => true, 'message' => 'App deleted successfully']);
    }

    // Form management

    public function listForms(Request $request, Response $response, array $args): Response
    {
        $app = $this->authorizeAppOwnership($request, $args['id']);
        if (!$app) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found or access denied'], 404);
        }

        $forms = $this->appService->getAppForms($args['id']);
        return $this->jsonResponse($response, ['forms' => $forms]);
    }

    public function addForm(Request $request, Response $response, array $args): Response
    {
        $app = $this->authorizeAppOwnership($request, $args['id']);
        if (!$app) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found or access denied'], 404);
        }

        $data = $request->getParsedBody();
        if (empty($data['formId'])) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form ID is required'], 400);
        }

        $userId = $request->getAttribute('userId');
        if (!$this->appService->isFormOwnedByUser($data['formId'], $userId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found or access denied'], 404);
        }

        try {
            $forms = $this->appService->addFormToApp($args['id'], $data['formId'], $data['displayName'] ?? null);
            return $this->jsonResponse($response, ['forms' => $forms], 201);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
    }

    public function updateForm(Request $request, Response $response, array $args): Response
    {
        $app = $this->authorizeAppOwnership($request, $args['id']);
        if (!$app) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found or access denied'], 404);
        }

        $data = $request->getParsedBody();
        $this->appService->updateAppForm($args['id'], $args['formId'], $data);
        $forms = $this->appService->getAppForms($args['id']);
        return $this->jsonResponse($response, ['forms' => $forms]);
    }

    public function removeForm(Request $request, Response $response, array $args): Response
    {
        $app = $this->authorizeAppOwnership($request, $args['id']);
        if (!$app) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found or access denied'], 404);
        }

        $this->appService->removeFormFromApp($args['id'], $args['formId']);
        return $this->jsonResponse($response, ['success' => true, 'message' => 'Form removed from app']);
    }

    public function reorderForms(Request $request, Response $response, array $args): Response
    {
        $app = $this->authorizeAppOwnership($request, $args['id']);
        if (!$app) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found or access denied'], 404);
        }

        $data = $request->getParsedBody();
        if (empty($data['formIds']) || !is_array($data['formIds'])) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'formIds array is required'], 400);
        }

        $this->appService->reorderAppForms($args['id'], $data['formIds']);
        $forms = $this->appService->getAppForms($args['id']);
        return $this->jsonResponse($response, ['forms' => $forms]);
    }

    private function jsonResponse(Response $response, array $data, int $status = 200): Response
    {
        $response->getBody()->write(json_encode($data));
        return $response
            ->withStatus($status)
            ->withHeader('Content-Type', 'application/json');
    }
}

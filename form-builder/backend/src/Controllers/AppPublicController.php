<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\AppResponseService;
use FormLogic\Services\FormService;
use FormLogic\Constants\AppPermissions;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

class AppPublicController
{
    private AppService $appService;
    private AppUserService $appUserService;
    private AppResponseService $appResponseService;
    private FormService $formService;

    public function __construct(
        AppService $appService,
        AppUserService $appUserService,
        AppResponseService $appResponseService,
        FormService $formService
    ) {
        $this->appService = $appService;
        $this->appUserService = $appUserService;
        $this->appResponseService = $appResponseService;
        $this->formService = $formService;
    }

    public function getApp(Request $request, Response $response, array $args): Response
    {
        $slug = $args['slug'];
        $app = $this->appService->getAppBySlug($slug);

        if (!$app || $app['status'] !== 'published') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found'], 404);
        }

        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        // Check user is a member
        $appUser = $this->appUserService->getAppUser($app['id'], $userId);
        if (!$appUser || $appUser['status'] !== 'active') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Not a member of this app'], 403);
        }

        $forms = $this->appService->getAppForms($app['id']);
        $permissions = $this->appUserService->getUserPermissions($app['id'], $userId);

        // Build runtime forms with form field data
        $runtimeForms = [];
        foreach ($forms as $form) {
            if (!$form['isVisible']) {
                continue;
            }
            $formData = $this->formService->getForm($form['formId']);
            if ($formData) {
                $runtimeForms[] = [
                    'formId' => $form['formId'],
                    'displayName' => $form['displayName'],
                    'sortOrder' => $form['sortOrder'],
                    'fields' => $formData['fields'],
                    'settings' => $formData['settings'],
                    'theme' => $formData['theme'],
                ];
            }
        }

        return $this->jsonResponse($response, [
            'app' => $app,
            'forms' => $runtimeForms,
            'user' => $appUser,
            'permissions' => $permissions,
        ]);
    }

    public function getMyPermissions(Request $request, Response $response, array $args): Response
    {
        $slug = $args['slug'];
        $app = $this->appService->getAppBySlug($slug);

        if (!$app || $app['status'] !== 'published') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found'], 404);
        }

        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $permissions = $this->appUserService->getUserPermissions($app['id'], $userId);
        return $this->jsonResponse($response, ['permissions' => $permissions]);
    }

    public function getForm(Request $request, Response $response, array $args): Response
    {
        $slug = $args['slug'];
        $formId = $args['formId'];
        $app = $this->appService->getAppBySlug($slug);

        if (!$app || $app['status'] !== 'published') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found'], 404);
        }

        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        // Check user is a member
        $appUser = $this->appUserService->getAppUser($app['id'], $userId);
        if (!$appUser || $appUser['status'] !== 'active') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Not a member of this app'], 403);
        }

        if (!$this->verifyFormBelongsToApp($app['id'], $formId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found'], 404);
        }

        $form = $this->formService->getForm($formId);
        if (!$form) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found'], 404);
        }

        return $this->jsonResponse($response, ['form' => $form]);
    }

    public function createResponse(Request $request, Response $response, array $args): Response
    {
        $slug = $args['slug'];
        $formId = $args['formId'];
        $app = $this->appService->getAppBySlug($slug);

        if (!$app || $app['status'] !== 'published') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found'], 404);
        }

        if (!$this->verifyFormBelongsToApp($app['id'], $formId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found'], 404);
        }

        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        if (!$this->appUserService->hasPermission($app['id'], $userId, AppPermissions::SUBMIT_RESPONSES, $formId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Permission denied'], 403);
        }

        $data = $request->getParsedBody();
        $data['ipAddress'] = $request->getServerParams()['REMOTE_ADDR'] ?? null;
        $data['userAgent'] = $request->getHeaderLine('User-Agent');

        // Get form's logic script if any
        $form = $this->formService->getForm($formId);
        $script = $form['logicScript'] ?? null;

        $result = $this->appResponseService->createResponse($app['id'], $formId, $data, $userId, $script);

        if ($result instanceof \FormLogic\Services\ScriptRejection) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $result->message, 'rejected' => true], 422);
        }

        return $this->jsonResponse($response, ['response' => $result], 201);
    }

    public function listResponses(Request $request, Response $response, array $args): Response
    {
        $slug = $args['slug'];
        $formId = $args['formId'];
        $app = $this->appService->getAppBySlug($slug);

        if (!$app || $app['status'] !== 'published') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found'], 404);
        }

        if (!$this->verifyFormBelongsToApp($app['id'], $formId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found'], 404);
        }

        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        // Determine scope based on permissions
        $canViewAll = $this->appUserService->hasPermission($app['id'], $userId, AppPermissions::VIEW_ALL_RESPONSES, $formId);
        $canViewOwn = $this->appUserService->hasPermission($app['id'], $userId, AppPermissions::VIEW_OWN_RESPONSES, $formId);

        if (!$canViewAll && !$canViewOwn) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Permission denied'], 403);
        }

        $scope = $canViewAll ? 'all' : 'own';
        $queryParams = $request->getQueryParams();
        $options = [
            'limit' => (int)($queryParams['limit'] ?? 100),
            'offset' => (int)($queryParams['offset'] ?? 0),
        ];

        $responses = $this->appResponseService->getResponses($formId, $scope, $userId, $options);
        return $this->jsonResponse($response, ['responses' => $responses, 'count' => count($responses), 'scope' => $scope]);
    }

    public function getResponseById(Request $request, Response $response, array $args): Response
    {
        $slug = $args['slug'];
        $formId = $args['formId'];
        $responseId = $args['id'];
        $app = $this->appService->getAppBySlug($slug);

        if (!$app || $app['status'] !== 'published') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found'], 404);
        }

        if (!$this->verifyFormBelongsToApp($app['id'], $formId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found'], 404);
        }

        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        $resp = $this->appResponseService->getResponse($formId, $responseId);
        if (!$resp) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Response not found'], 404);
        }

        // Check permission: own response or view_all
        $isOwn = ($resp['metadata']['submittedByUserId'] ?? null) === $userId;
        $canViewAll = $this->appUserService->hasPermission($app['id'], $userId, AppPermissions::VIEW_ALL_RESPONSES, $formId);
        $canViewOwn = $this->appUserService->hasPermission($app['id'], $userId, AppPermissions::VIEW_OWN_RESPONSES, $formId);

        if (!$canViewAll && !($isOwn && $canViewOwn)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Permission denied'], 403);
        }

        return $this->jsonResponse($response, ['response' => $resp]);
    }

    public function updateResponseById(Request $request, Response $response, array $args): Response
    {
        $slug = $args['slug'];
        $formId = $args['formId'];
        $responseId = $args['id'];
        $app = $this->appService->getAppBySlug($slug);

        if (!$app || $app['status'] !== 'published') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found'], 404);
        }

        if (!$this->verifyFormBelongsToApp($app['id'], $formId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found'], 404);
        }

        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        if (!$this->appUserService->hasPermission($app['id'], $userId, AppPermissions::EDIT_RESPONSES, $formId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Permission denied'], 403);
        }

        $data = $request->getParsedBody();
        $updated = $this->appResponseService->updateResponse($formId, $responseId, $data);

        if (!$updated) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Response not found'], 404);
        }

        return $this->jsonResponse($response, ['response' => $updated]);
    }

    public function deleteResponseById(Request $request, Response $response, array $args): Response
    {
        $slug = $args['slug'];
        $formId = $args['formId'];
        $responseId = $args['id'];
        $app = $this->appService->getAppBySlug($slug);

        if (!$app || $app['status'] !== 'published') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found'], 404);
        }

        if (!$this->verifyFormBelongsToApp($app['id'], $formId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found'], 404);
        }

        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        if (!$this->appUserService->hasPermission($app['id'], $userId, AppPermissions::DELETE_RESPONSES, $formId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Permission denied'], 403);
        }

        $deleted = $this->appResponseService->deleteResponse($formId, $responseId);
        if (!$deleted) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Response not found'], 404);
        }

        return $this->jsonResponse($response, ['success' => true, 'message' => 'Response deleted']);
    }

    public function manifest(Request $request, Response $response, array $args): Response
    {
        $slug = $args['slug'];
        $app = $this->appService->getAppBySlug($slug);

        if (!$app) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found'], 404);
        }

        $theme = $app['theme'] ?? [];
        $settings = $app['settings'] ?? [];

        $manifest = [
            'name' => $app['name'],
            'short_name' => $settings['pwaShortName'] ?? substr($app['name'], 0, 12),
            'description' => $app['description'] ?? '',
            'start_url' => '/app/' . $slug,
            'scope' => '/app/' . $slug,
            'display' => 'standalone',
            'background_color' => $theme['backgroundColor'] ?? '#ffffff',
            'theme_color' => $settings['pwaThemeColor'] ?? $theme['primaryColor'] ?? '#6366f1',
            'icons' => [],
        ];

        if (!empty($app['logoUrl'])) {
            $manifest['icons'][] = [
                'src' => $app['logoUrl'],
                'sizes' => '192x192',
                'type' => 'image/png',
            ];
            $manifest['icons'][] = [
                'src' => $app['logoUrl'],
                'sizes' => '512x512',
                'type' => 'image/png',
            ];
        }

        $response->getBody()->write(json_encode($manifest));
        return $response
            ->withStatus(200)
            ->withHeader('Content-Type', 'application/manifest+json');
    }

    private function verifyFormBelongsToApp(string $appId, string $formId): bool
    {
        $forms = $this->appService->getAppForms($appId);
        foreach ($forms as $form) {
            if ($form['formId'] === $formId) {
                return true;
            }
        }
        return false;
    }

    private function jsonResponse(Response $response, array $data, int $status = 200): Response
    {
        $response->getBody()->write(json_encode($data));
        return $response
            ->withStatus($status)
            ->withHeader('Content-Type', 'application/json');
    }
}

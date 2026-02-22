<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\AppResponseService;
use FormLogic\Services\ResponseService;
use FormLogic\Services\FormService;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Constants\AppPermissions;
use FormLogic\Helpers\IpResolver;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use PDO;

class AppPublicController
{
    private AppService $appService;
    private AppUserService $appUserService;
    private AppResponseService $appResponseService;
    private FormService $formService;
    private ResponseService $responseService;
    private PDO $mysql;
    private SQLiteConnection $sqlite;

    public function __construct(
        AppService $appService,
        AppUserService $appUserService,
        AppResponseService $appResponseService,
        FormService $formService,
        ResponseService $responseService,
        MySQLConnection $mysql,
        SQLiteConnection $sqlite
    ) {
        $this->appService = $appService;
        $this->appUserService = $appUserService;
        $this->appResponseService = $appResponseService;
        $this->formService = $formService;
        $this->responseService = $responseService;
        $this->mysql = $mysql->getConnection();
        $this->sqlite = $sqlite;
    }

    /**
     * Validate app slug format to avoid unnecessary DB queries.
     */
    private function validateSlug(string $slug): bool
    {
        return (bool) preg_match('/^[a-z0-9][a-z0-9-]{0,60}$/', $slug);
    }

    public function getApp(Request $request, Response $response, array $args): Response
    {
        $slug = $args['slug'];
        if (!$this->validateSlug($slug)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found'], 404);
        }
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
                    'icon' => $formData['icon'] ?? null,
                    'description' => $formData['description'] ?? null,
                ];
            }
        }

        // Strip internal fields from app data for non-owner users
        $safeApp = $app;
        if ($userId !== ($app['ownerId'] ?? null)) {
            unset($safeApp['ownerId']);
        }

        return $this->jsonResponse($response, [
            'app' => $safeApp,
            'forms' => $runtimeForms,
            'user' => $appUser,
            'permissions' => $permissions,
        ]);
    }

    public function getMyPermissions(Request $request, Response $response, array $args): Response
    {
        $slug = $args['slug'];
        if (!$this->validateSlug($slug)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found'], 404);
        }
        $app = $this->appService->getAppBySlug($slug);

        if (!$app || $app['status'] !== 'published') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found'], 404);
        }

        $userId = $request->getAttribute('userId');
        if (!$userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Authentication required'], 401);
        }

        // Verify user is an active member of the app
        $appUser = $this->appUserService->getAppUser($app['id'], $userId);
        if (!$appUser || $appUser['status'] !== 'active') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Not a member of this app'], 403);
        }

        $permissions = $this->appUserService->getUserPermissions($app['id'], $userId);
        return $this->jsonResponse($response, ['permissions' => $permissions]);
    }

    public function getForm(Request $request, Response $response, array $args): Response
    {
        $slug = $args['slug'];
        if (!$this->validateSlug($slug)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found'], 404);
        }
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

        // Strip sensitive fields from runtime response
        unset($form['logicScript'], $form['logicPrompt']);

        return $this->jsonResponse($response, ['form' => $form]);
    }

    public function createResponse(Request $request, Response $response, array $args): Response
    {
        $slug = $args['slug'];
        if (!$this->validateSlug($slug)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found'], 404);
        }
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
        $data['ipAddress'] = IpResolver::fromEnvironment()->getClientIp($request);
        $data['userAgent'] = $request->getHeaderLine('User-Agent');

        // Get form's logic script if any
        $form = $this->formService->getForm($formId);
        $script = $form ? ($form['logicScript'] ?? null) : null;

        // Validate answers against form fields
        if ($form) {
            $validationErrors = $this->validateAnswers($form['fields'] ?? [], $data['answers'] ?? []);
            if (!empty($validationErrors)) {
                return $this->jsonResponse($response, [
                    'error' => true,
                    'message' => 'Validation failed',
                    'errors' => $validationErrors,
                ], 400);
            }
        }

        // Check if form is closed
        if ($form) {
            $settings = $form['settings'] ?? [];
            if (!empty($settings['isClosed'])) {
                $closedMessage = $settings['closedMessage'] ?? 'This form is no longer accepting responses.';
                return $this->jsonResponse($response, ['error' => true, 'message' => $closedMessage], 403);
            }

            // Check quota limit
            if (!empty($settings['quotaLimit'])) {
                $responseCount = $this->responseService->getResponseCount($formId);
                if ($responseCount >= (int)$settings['quotaLimit']) {
                    $closedMessage = $settings['closedMessage'] ?? 'This form has reached its maximum number of responses.';
                    return $this->jsonResponse($response, ['error' => true, 'message' => $closedMessage], 403);
                }
            }
        }

        try {
            $result = $this->appResponseService->createResponse($app['id'], $formId, $data, $userId, $script);

            if ($result instanceof \FormLogic\Services\ScriptRejection) {
                return $this->jsonResponse($response, ['error' => true, 'message' => $result->message, 'rejected' => true], 422);
            }

            return $this->jsonResponse($response, ['response' => $result], 201);
        } catch (\Exception $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to save response'], 500);
        }
    }

    public function listResponses(Request $request, Response $response, array $args): Response
    {
        $slug = $args['slug'];
        if (!$this->validateSlug($slug)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found'], 404);
        }
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
            'limit' => max(1, min((int)($queryParams['limit'] ?? 100), 1000)),
            'offset' => max(0, (int)($queryParams['offset'] ?? 0)),
        ];

        $responses = $this->appResponseService->getResponses($formId, $scope, $userId, $options);

        // Resolve linked records if requested
        if (($queryParams['resolve'] ?? '') === 'linked') {
            $form = $this->formService->getForm($formId);
            if ($form) {
                $responses = $this->resolveLinkedRecords($responses, $form, $app['id'], $userId);
            }
        }

        return $this->jsonResponse($response, ['responses' => $responses, 'count' => count($responses), 'scope' => $scope]);
    }

    public function getResponseById(Request $request, Response $response, array $args): Response
    {
        $slug = $args['slug'];
        if (!$this->validateSlug($slug)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found'], 404);
        }
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

        // Resolve linked records if requested
        $queryParams = $request->getQueryParams();
        if (($queryParams['resolve'] ?? '') === 'linked') {
            $form = $this->formService->getForm($formId);
            if ($form) {
                $resolved = $this->resolveLinkedRecords([$resp], $form, $app['id'], $userId);
                $resp = $resolved[0];
            }
        }

        return $this->jsonResponse($response, ['response' => $resp]);
    }

    public function updateResponseById(Request $request, Response $response, array $args): Response
    {
        $slug = $args['slug'];
        if (!$this->validateSlug($slug)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found'], 404);
        }
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

        // Ownership check: users can only edit their own responses unless they have VIEW_ALL_RESPONSES
        $existingResp = $this->appResponseService->getResponse($formId, $responseId);
        if (!$existingResp) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Response not found'], 404);
        }
        $isOwn = ($existingResp['metadata']['submittedByUserId'] ?? null) === $userId;
        $canViewAll = $this->appUserService->hasPermission($app['id'], $userId, AppPermissions::VIEW_ALL_RESPONSES, $formId);
        if (!$isOwn && !$canViewAll) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Permission denied'], 403);
        }

        $data = $request->getParsedBody();

        // Validate answers against form fields if answers are being updated
        if (isset($data['answers'])) {
            $form = $this->formService->getForm($formId);
            if ($form) {
                $validationErrors = $this->validateAnswers($form['fields'] ?? [], $data['answers']);
                if (!empty($validationErrors)) {
                    return $this->jsonResponse($response, [
                        'error' => true,
                        'message' => 'Validation failed',
                        'errors' => $validationErrors,
                    ], 400);
                }
            }
        }

        $updated = $this->appResponseService->updateResponse($formId, $responseId, $data);

        if (!$updated) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Response not found'], 404);
        }

        return $this->jsonResponse($response, ['response' => $updated]);
    }

    public function deleteResponseById(Request $request, Response $response, array $args): Response
    {
        $slug = $args['slug'];
        if (!$this->validateSlug($slug)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found'], 404);
        }
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

        // Ownership check: users can only delete their own responses unless they have VIEW_ALL_RESPONSES
        $existingResp = $this->appResponseService->getResponse($formId, $responseId);
        if (!$existingResp) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Response not found'], 404);
        }
        $isOwn = ($existingResp['metadata']['submittedByUserId'] ?? null) === $userId;
        $canViewAll = $this->appUserService->hasPermission($app['id'], $userId, AppPermissions::VIEW_ALL_RESPONSES, $formId);
        if (!$isOwn && !$canViewAll) {
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
        if (!$this->validateSlug($slug)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found'], 404);
        }
        $app = $this->appService->getAppBySlug($slug);

        if (!$app || $app['status'] !== 'published') {
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

    public function lookupRecords(Request $request, Response $response, array $args): Response
    {
        $slug = $args['slug'];
        if (!$this->validateSlug($slug)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found'], 404);
        }
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

        $queryParams = $request->getQueryParams();
        $targetFormId = $queryParams['targetFormId'] ?? '';

        if (!$targetFormId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'targetFormId is required'], 400);
        }

        // Verify target form belongs to same app
        if (!$this->verifyFormBelongsToApp($app['id'], $targetFormId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Target form not found in this app'], 404);
        }

        // Check permission on target form
        $canViewAll = $this->appUserService->hasPermission($app['id'], $userId, AppPermissions::VIEW_ALL_RESPONSES, $targetFormId);
        $canViewOwn = $this->appUserService->hasPermission($app['id'], $userId, AppPermissions::VIEW_OWN_RESPONSES, $targetFormId);

        if (!$canViewAll && !$canViewOwn) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Permission denied'], 403);
        }

        $displayFieldIds = !empty($queryParams['displayFieldIds']) ? explode(',', $queryParams['displayFieldIds']) : [];
        $searchFieldIds = !empty($queryParams['searchFieldIds']) ? explode(',', $queryParams['searchFieldIds']) : [];
        $searchQuery = $queryParams['q'] ?? '';
        $idsParam = $queryParams['ids'] ?? '';
        $limit = max(1, min((int)($queryParams['limit'] ?? 20), 100));
        $offset = max(0, (int)($queryParams['offset'] ?? 0));

        // Get target form to know field structure
        $targetForm = $this->formService->getForm($targetFormId);
        if (!$targetForm) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Target form not found'], 404);
        }

        // Validate that requested field IDs actually belong to the target form
        $validFieldIds = array_column($targetForm['fields'] ?? [], 'id');
        if (!empty($displayFieldIds)) {
            $displayFieldIds = array_intersect($displayFieldIds, $validFieldIds);
        }
        if (!empty($searchFieldIds)) {
            $searchFieldIds = array_intersect($searchFieldIds, $validFieldIds);
        }

        // Use SQL-level search when a query is provided
        $scope = $canViewAll ? 'all' : 'own';

        // Resolve specific IDs mode — fetch records by explicit ID list
        if ($idsParam !== '') {
            $requestedIds = array_filter(array_map('trim', explode(',', $idsParam)), fn($id) => $id !== '');
            $matchedResponses = $this->responseService->getResponsesByIds($targetFormId, $requestedIds);
            // Apply scope filtering: if user can only view own, filter out others' responses
            if ($scope === 'own') {
                $matchedResponses = array_filter($matchedResponses, function ($r) use ($userId) {
                    return ($r['metadata']['submittedByUserId'] ?? null) === $userId;
                });
                $matchedResponses = array_values($matchedResponses);
            }
            $totalCount = count($matchedResponses);
        } elseif ($searchQuery !== '') {
            // Push search to SQL via json_extract
            $effectiveSearchFields = !empty($searchFieldIds) ? $searchFieldIds : [];
            $searchOptions = ['limit' => $limit, 'offset' => $offset];
            // Push scope filtering into SQL to avoid post-pagination filtering
            if ($scope === 'own') {
                $searchOptions['submittedByUserId'] = $userId;
            }
            $result = $this->responseService->getFormResponsesSearchable(
                $targetFormId,
                $searchQuery,
                $effectiveSearchFields,
                $searchOptions
            );
            $matchedResponses = $result['responses'];
            $totalCount = $result['total'];
        } else {
            // No search — use existing pagination at SQL level
            $matchedResponses = $this->appResponseService->getResponses($targetFormId, $scope, $userId, [
                'limit' => $limit,
                'offset' => $offset,
            ]);
            // Get total count for pagination (scoped to user if scope=own)
            $totalCount = $this->responseService->getResponseCount(
                $targetFormId,
                $scope === 'own' ? $userId : null
            );
        }

        // Build display labels for results
        $records = [];
        foreach ($matchedResponses as $resp) {
            $answers = $resp['answers'] ?? [];

            $displayParts = [];
            if (!empty($displayFieldIds)) {
                foreach ($displayFieldIds as $fieldId) {
                    $val = $answers[$fieldId] ?? null;
                    if ($val !== null && $val !== '') {
                        $displayParts[] = is_array($val) ? implode(', ', $val) : (string)$val;
                    }
                }
            } else {
                $count = 0;
                foreach ($targetForm['fields'] as $field) {
                    if ($count >= 2) break;
                    if (in_array($field['type'], ['short_text', 'long_text', 'email', 'phone', 'number', 'url'])) {
                        $val = $answers[$field['id']] ?? null;
                        if ($val !== null && $val !== '') {
                            $displayParts[] = is_array($val) ? implode(', ', $val) : (string)$val;
                            $count++;
                        }
                    }
                }
            }

            $fieldData = [];
            foreach ($displayFieldIds as $fid) {
                $fieldData[$fid] = $answers[$fid] ?? null;
            }

            $records[] = [
                'id' => $resp['id'],
                'display' => implode(' - ', $displayParts) ?: ('Record ' . substr($resp['id'], 0, 8)),
                'fields' => $fieldData,
                'submittedAt' => $resp['submittedAt'] ?? '',
            ];
        }

        return $this->jsonResponse($response, [
            'records' => array_values($records),
            'count' => $totalCount,
        ]);
    }

    public function getRelatedRecords(Request $request, Response $response, array $args): Response
    {
        $slug = $args['slug'];
        if (!$this->validateSlug($slug)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found'], 404);
        }
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

        // Verify the response actually belongs to this form
        $targetResp = $this->responseService->getResponse($formId, $responseId);
        if (!$targetResp) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Response not found'], 404);
        }

        // Check view permission and ownership
        $canViewAll = $this->appUserService->hasPermission($app['id'], $userId, AppPermissions::VIEW_ALL_RESPONSES, $formId);
        $canViewOwn = $this->appUserService->hasPermission($app['id'], $userId, AppPermissions::VIEW_OWN_RESPONSES, $formId);
        if (!$canViewAll && !$canViewOwn) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Permission denied'], 403);
        }

        // If user only has VIEW_OWN, verify this response belongs to them
        if (!$canViewAll) {
            $isOwn = ($targetResp['metadata']['submittedByUserId'] ?? null) === $userId;
            if (!$isOwn) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'Permission denied'], 403);
            }
        }

        // Pagination parameters
        $queryParams = $request->getQueryParams();
        $limit = max(1, min((int)($queryParams['limit'] ?? 50), 200));
        $offset = max(0, (int)($queryParams['offset'] ?? 0));

        // Use response_links table for efficient inverse lookup with pagination
        $stmt = $this->mysql->prepare(
            "SELECT source_form_id, source_response_id, field_id FROM response_links WHERE target_form_id = :target_form_id AND target_response_id = :target_response_id LIMIT :lim OFFSET :off"
        );
        $stmt->bindValue('target_form_id', $formId);
        $stmt->bindValue('target_response_id', $responseId);
        $stmt->bindValue('lim', $limit, PDO::PARAM_INT);
        $stmt->bindValue('off', $offset, PDO::PARAM_INT);
        $stmt->execute();
        $links = $stmt->fetchAll();

        if (empty($links)) {
            return $this->jsonResponse($response, ['related' => []]);
        }

        // Group links by source form
        $linksByForm = [];
        foreach ($links as $link) {
            $linksByForm[$link['source_form_id']][] = $link;
        }

        // Build app forms lookup for display names and form data
        $appForms = $this->appService->getAppForms($app['id']);
        $appFormMap = [];
        foreach ($appForms as $af) {
            $appFormMap[$af['formId']] = $af;
        }

        // Batch-load all needed source forms upfront to avoid N+1 queries
        $sourceFormIds = array_keys($linksByForm);
        $sourceFormDataMap = [];
        foreach ($sourceFormIds as $sfId) {
            if (isset($appFormMap[$sfId])) {
                $formData = $this->formService->getForm($sfId);
                if ($formData) {
                    $sourceFormDataMap[$sfId] = $formData;
                }
            }
        }

        $related = [];
        foreach ($linksByForm as $sourceFormId => $formLinks) {
            // Only include forms that belong to this app
            if (!isset($appFormMap[$sourceFormId])) continue;

            // Check if user has permission to view the source form's responses
            $canViewAllSource = $this->appUserService->hasPermission($app['id'], $userId, AppPermissions::VIEW_ALL_RESPONSES, $sourceFormId);
            $canViewOwnSource = $this->appUserService->hasPermission($app['id'], $userId, AppPermissions::VIEW_OWN_RESPONSES, $sourceFormId);
            if (!$canViewAllSource && !$canViewOwnSource) continue;

            $sourceForm = $sourceFormDataMap[$sourceFormId] ?? null;
            if (!$sourceForm) continue;

            // Get the field info for display
            $fieldId = $formLinks[0]['field_id'];
            $fieldLabel = $fieldId;
            $displayFieldIds = [];
            foreach ($sourceForm['fields'] as $f) {
                if ($f['id'] === $fieldId) {
                    $fieldLabel = $f['label'] ?? $fieldId;
                    $displayFieldIds = isset($f['properties']) ? ($f['properties']['displayFieldIds'] ?? []) : [];
                    break;
                }
            }

            // Batch-fetch source responses
            $sourceResponseIds = array_unique(array_column($formLinks, 'source_response_id'));
            $sourceResponses = $this->responseService->getResponsesByIds($sourceFormId, $sourceResponseIds);

            // Filter by ownership if user only has VIEW_OWN_RESPONSES
            if (!$canViewAllSource) {
                $sourceResponses = array_filter($sourceResponses, fn($r) => ($r['metadata']['submittedByUserId'] ?? null) === $userId);
                if (empty($sourceResponses)) continue;
            }

            $matchingRecords = [];
            foreach ($sourceResponses as $sr) {
                $answers = $sr['answers'] ?? [];
                $parts = [];
                if (!empty($displayFieldIds)) {
                    foreach ($displayFieldIds as $dfid) {
                        $val = $answers[$dfid] ?? null;
                        if ($val !== null) $parts[] = is_array($val) ? implode(', ', $val) : (string)$val;
                    }
                }
                if (empty($parts)) {
                    $count = 0;
                    foreach ($sourceForm['fields'] as $f) {
                        if ($count >= 2) break;
                        if (in_array($f['type'], ['short_text', 'long_text', 'email', 'phone', 'url', 'number'])) {
                            $val = $answers[$f['id']] ?? null;
                            if ($val !== null) { $parts[] = (string)$val; $count++; }
                        }
                    }
                }

                $matchingRecords[] = [
                    'id' => $sr['id'],
                    'display' => implode(' - ', $parts) ?: ('Record ' . substr($sr['id'], 0, 8)),
                    'submittedAt' => $sr['submittedAt'] ?? '',
                ];
            }

            if (!empty($matchingRecords)) {
                $appForm = $appFormMap[$sourceFormId];
                $related[$sourceFormId] = [
                    'formId' => $sourceFormId,
                    'displayName' => $appForm['displayName'] ?? $sourceForm['title'],
                    'fieldLabel' => $fieldLabel,
                    'records' => $matchingRecords,
                    'count' => count($matchingRecords),
                ];
            }
        }

        return $this->jsonResponse($response, ['related' => $related]);
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

    /**
     * Resolve linked record fields in responses by batch-loading display values.
     */
    private function resolveLinkedRecords(array $responses, array $form, string $appId, string $userId): array
    {
        // Find linked_record fields
        $linkedFields = [];
        foreach ($form['fields'] as $field) {
            if ($field['type'] === 'linked_record' && !empty($field['properties']['targetFormId'])) {
                $linkedFields[] = $field;
            }
        }

        if (empty($linkedFields)) {
            return $responses;
        }

        // Collect all referenced response IDs grouped by target form
        $refsByForm = []; // targetFormId => [responseId => true]
        foreach ($responses as $resp) {
            $answers = $resp['answers'] ?? [];
            foreach ($linkedFields as $field) {
                $targetFormId = $field['properties']['targetFormId'] ?? null;
                if (!$targetFormId) continue;
                $val = $answers[$field['id']] ?? null;
                if ($val === null) continue;

                if (!isset($refsByForm[$targetFormId])) {
                    $refsByForm[$targetFormId] = [];
                }

                if (is_array($val)) {
                    foreach ($val as $id) {
                        if (is_string($id) && $id !== '') {
                            $refsByForm[$targetFormId][$id] = true;
                        }
                    }
                } elseif (is_string($val) && $val !== '') {
                    $refsByForm[$targetFormId][$val] = true;
                }
            }
        }

        // Batch-load referenced records
        $resolvedCache = []; // targetFormId => responseId => { id, display }
        foreach ($refsByForm as $targetFormId => $idMap) {
            $resolvedCache[$targetFormId] = [];
            $targetForm = $this->formService->getForm($targetFormId);
            if (!$targetForm) continue;

            // Find display field IDs from the linked field config
            $displayFieldIds = [];
            foreach ($linkedFields as $field) {
                if (isset($field['properties']['targetFormId']) && $field['properties']['targetFormId'] === $targetFormId) {
                    $displayFieldIds = $field['properties']['displayFieldIds'] ?? [];
                    break;
                }
            }

            // Check permissions before loading target responses
            $canViewAllTarget = $this->appUserService->hasPermission($appId, $userId, AppPermissions::VIEW_ALL_RESPONSES, $targetFormId);
            $canViewOwnTarget = $this->appUserService->hasPermission($appId, $userId, AppPermissions::VIEW_OWN_RESPONSES, $targetFormId);

            if (!$canViewAllTarget && !$canViewOwnTarget) {
                // User has no permission on target form — skip resolving these records
                continue;
            }

            $targetResponses = $this->responseService->getResponsesByIds($targetFormId, array_keys($idMap));

            // Filter by ownership if user only has VIEW_OWN_RESPONSES
            if (!$canViewAllTarget) {
                $targetResponses = array_filter($targetResponses, fn($r) => ($r['metadata']['submittedByUserId'] ?? null) === $userId);
            }

            $resolvedCache[$targetFormId] = [];

            foreach ($targetResponses as $tr) {
                $answers = $tr['answers'] ?? [];
                $parts = [];
                if (!empty($displayFieldIds)) {
                    foreach ($displayFieldIds as $dfid) {
                        $val = $answers[$dfid] ?? null;
                        if ($val !== null && $val !== '') {
                            $parts[] = is_array($val) ? implode(', ', $val) : (string)$val;
                        }
                    }
                } else {
                    $count = 0;
                    foreach ($targetForm['fields'] as $f) {
                        if ($count >= 2) break;
                        if (in_array($f['type'], ['short_text', 'long_text', 'email', 'phone', 'url', 'number'])) {
                            $val = $answers[$f['id']] ?? null;
                            if ($val !== null) { $parts[] = (string)$val; $count++; }
                        }
                    }
                }

                $resolvedCache[$targetFormId][$tr['id']] = [
                    'id' => $tr['id'],
                    'display' => implode(' - ', $parts) ?: ('Record ' . substr($tr['id'], 0, 8)),
                ];
            }
        }

        // Inject _resolved into each response
        foreach ($responses as &$resp) {
            $answers = $resp['answers'] ?? [];
            $resolved = [];

            foreach ($linkedFields as $field) {
                $targetFormId = $field['properties']['targetFormId'] ?? null;
                if (!$targetFormId) continue;
                $val = $answers[$field['id']] ?? null;
                if ($val === null) continue;

                if (is_array($val)) {
                    $resolvedItems = [];
                    foreach ($val as $id) {
                        $resolvedItems[] = $resolvedCache[$targetFormId][$id] ?? [
                            'id' => $id,
                            'display' => 'Record not found',
                        ];
                    }
                    $resolved[$field['id']] = $resolvedItems;
                } else {
                    $resolved[$field['id']] = $resolvedCache[$targetFormId][$val] ?? [
                        'id' => $val,
                        'display' => 'Record not found',
                    ];
                }
            }

            if (!empty($resolved)) {
                $resp['_resolved'] = $resolved;
            }
        }
        unset($resp);

        return $responses;
    }

    /**
     * Validate answers against form field definitions
     */
    private function validateAnswers(array $fields, array $answers): array
    {
        $errors = [];

        foreach ($fields as $field) {
            $fieldId = $field['id'] ?? null;
            if (!$fieldId) {
                continue;
            }

            $isRequired = $field['required'] ?? false;
            $fieldType = $field['type'] ?? 'short_text';

            // Skip validation for non-input field types
            if (in_array($fieldType, ['statement', 'welcome_screen', 'thank_you', 'calculated'], true)) {
                continue;
            }

            $value = $answers[$fieldId] ?? null;

            // Check required fields
            if ($isRequired && ($value === null || $value === '' || $value === [] || (is_string($value) && trim($value) === ''))) {
                $errors[$fieldId] = 'This field is required';
                continue;
            }

            // Skip further validation if empty and not required
            if ($value === null || $value === '' || $value === [] || (is_string($value) && trim($value) === '')) {
                continue;
            }

            // Type-specific validation
            $typeError = $this->validateFieldType($field, $value);
            if ($typeError) {
                $errors[$fieldId] = $typeError;
            }
        }

        return $errors;
    }

    /**
     * Validate a field value against its type
     */
    private function validateFieldType(array $field, $value): ?string
    {
        $type = $field['type'] ?? 'short_text';

        switch ($type) {
            case 'email':
                if (!filter_var($value, FILTER_VALIDATE_EMAIL)) {
                    return 'Invalid email address';
                }
                break;
            case 'url':
                if (!filter_var($value, FILTER_VALIDATE_URL)) {
                    return 'Invalid URL';
                }
                break;
            case 'number':
                if (!is_numeric($value)) {
                    return 'Must be a number';
                }
                break;
            case 'phone':
                if (!preg_match('/^\+[1-9]\d{6,14}$/', $value) &&
                    !preg_match('/^[\d\s\-\+\(\)\.]+$/', $value)) {
                    return 'Invalid phone number format';
                }
                if (!preg_match('/^\+[1-9]\d{6,14}$/', $value)) {
                    $digitCount = preg_match_all('/\d/', $value);
                    if ($digitCount < 6) {
                        return 'Phone number must contain at least 6 digits';
                    }
                }
                break;
            case 'date':
            case 'datetime':
            case 'time':
                if (is_string($value) && strlen($value) > 100) {
                    return 'Invalid date/time format';
                }
                break;
            case 'rating':
                $properties = $field['properties'] ?? [];
                $maxStars = $properties['maxStars'] ?? 5;
                if (!is_numeric($value) || $value < 1 || $value > $maxStars) {
                    return "Rating must be between 1 and {$maxStars}";
                }
                break;
            case 'scale':
                $properties = $field['properties'] ?? [];
                $min = $properties['scaleStart'] ?? 1;
                $max = $properties['scaleEnd'] ?? 10;
                if (!is_numeric($value) || $value < $min || $value > $max) {
                    return "Value must be between {$min} and {$max}";
                }
                break;
            case 'dropdown':
            case 'multiple_choice':
                $properties = $field['properties'] ?? [];
                $options = $properties['options'] ?? [];
                $allowedValues = array_column($options, 'value');
                if (!in_array($value, $allowedValues, true)) {
                    return 'Invalid selection';
                }
                break;
            case 'checkboxes':
                if (!is_array($value)) {
                    return 'Invalid selection format';
                }
                $properties = $field['properties'] ?? [];
                $options = $properties['options'] ?? [];
                $allowedValues = array_column($options, 'value');
                foreach ($value as $selected) {
                    if (!in_array($selected, $allowedValues, true)) {
                        return 'Invalid selection';
                    }
                }
                break;
            case 'short_text':
            case 'long_text':
                if (is_string($value)) {
                    $maxLength = $type === 'short_text' ? 1000 : 50000;
                    if (strlen($value) > $maxLength) {
                        return "Text exceeds maximum length of {$maxLength} characters";
                    }
                }
                break;
            case 'location':
                if (!is_array($value)) {
                    return 'Invalid location format';
                }
                if (!isset($value['latitude']) || !isset($value['longitude'])) {
                    return 'Location must include latitude and longitude';
                }
                if (!is_numeric($value['latitude']) || !is_numeric($value['longitude'])) {
                    return 'Latitude and longitude must be numbers';
                }
                if ($value['latitude'] < -90 || $value['latitude'] > 90) {
                    return 'Latitude must be between -90 and 90';
                }
                if ($value['longitude'] < -180 || $value['longitude'] > 180) {
                    return 'Longitude must be between -180 and 180';
                }
                break;
            case 'file_upload':
                if (!is_array($value)) {
                    return 'Invalid file upload format';
                }
                // Validate each file metadata entry
                foreach ($value as $item) {
                    if (!is_array($item) || !isset($item['id']) || !isset($item['originalFilename'])) {
                        return 'Invalid file metadata';
                    }
                }
                break;
        }

        return null;
    }

    private function jsonResponse(Response $response, array $data, int $status = 200): Response
    {
        $response->getBody()->write(json_encode($data));
        return $response
            ->withStatus($status)
            ->withHeader('Content-Type', 'application/json');
    }
}

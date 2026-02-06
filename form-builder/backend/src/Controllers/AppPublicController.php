<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\AppResponseService;
use FormLogic\Services\ResponseService;
use FormLogic\Services\FormService;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Constants\AppPermissions;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

class AppPublicController
{
    private AppService $appService;
    private AppUserService $appUserService;
    private AppResponseService $appResponseService;
    private FormService $formService;
    private ResponseService $responseService;
    private SQLiteConnection $sqlite;

    public function __construct(
        AppService $appService,
        AppUserService $appUserService,
        AppResponseService $appResponseService,
        FormService $formService,
        ResponseService $responseService,
        SQLiteConnection $sqlite
    ) {
        $this->appService = $appService;
        $this->appUserService = $appUserService;
        $this->appResponseService = $appResponseService;
        $this->formService = $formService;
        $this->responseService = $responseService;
        $this->sqlite = $sqlite;
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

    public function lookupRecords(Request $request, Response $response, array $args): Response
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
        $limit = min((int)($queryParams['limit'] ?? 20), 100);
        $offset = (int)($queryParams['offset'] ?? 0);

        // Get target form to know field structure
        $targetForm = $this->formService->getForm($targetFormId);
        if (!$targetForm) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Target form not found'], 404);
        }

        // Fetch responses from target form
        $scope = $canViewAll ? 'all' : 'own';
        $allResponses = $this->appResponseService->getResponses($targetFormId, $scope, $userId, [
            'limit' => 500, // reasonable upper bound for lookup
        ]);

        // Build display labels and filter by search query
        $records = [];
        foreach ($allResponses as $resp) {
            $answers = $resp['answers'] ?? [];

            // Build display string from display fields
            $displayParts = [];
            if (!empty($displayFieldIds)) {
                foreach ($displayFieldIds as $fieldId) {
                    $val = $answers[$fieldId] ?? null;
                    if ($val !== null && $val !== '') {
                        $displayParts[] = is_array($val) ? implode(', ', $val) : (string)$val;
                    }
                }
            } else {
                // Default: use first 2 text fields
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

            $display = implode(' - ', $displayParts) ?: ('Record ' . substr($resp['id'], 0, 8));

            // Search filter
            if ($searchQuery !== '') {
                $matchFound = mb_stripos($display, $searchQuery) !== false;

                if (!$matchFound) {
                    if (!empty($searchFieldIds)) {
                        // Search only in the configured search fields
                        foreach ($searchFieldIds as $sfid) {
                            $val = $answers[$sfid] ?? null;
                            if ($val !== null && !is_array($val) && mb_stripos((string)$val, $searchQuery) !== false) {
                                $matchFound = true;
                                break;
                            }
                        }
                    } else {
                        // Fallback: search across all answer values
                        foreach ($answers as $val) {
                            if ($val !== null && !is_array($val) && mb_stripos((string)$val, $searchQuery) !== false) {
                                $matchFound = true;
                                break;
                            }
                        }
                    }
                }

                if (!$matchFound) {
                    continue;
                }
            }

            $fieldData = [];
            foreach ($displayFieldIds as $fid) {
                $fieldData[$fid] = $answers[$fid] ?? null;
            }

            $records[] = [
                'id' => $resp['id'],
                'display' => $display,
                'fields' => $fieldData,
            ];
        }

        $totalCount = count($records);

        // Apply pagination
        $records = array_slice($records, $offset, $limit);

        return $this->jsonResponse($response, [
            'records' => array_values($records),
            'count' => $totalCount,
        ]);
    }

    public function getRelatedRecords(Request $request, Response $response, array $args): Response
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

        // Check view permission
        $canViewAll = $this->appUserService->hasPermission($app['id'], $userId, AppPermissions::VIEW_ALL_RESPONSES, $formId);
        $canViewOwn = $this->appUserService->hasPermission($app['id'], $userId, AppPermissions::VIEW_OWN_RESPONSES, $formId);
        if (!$canViewAll && !$canViewOwn) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Permission denied'], 403);
        }

        // Discover inverse relations: scan app forms for linked_record fields pointing at this form
        $appForms = $this->appService->getAppForms($app['id']);
        $related = [];

        foreach ($appForms as $appForm) {
            $otherFormId = $appForm['formId'];
            if ($otherFormId === $formId) continue;

            $otherForm = $this->formService->getForm($otherFormId);
            if (!$otherForm) continue;

            foreach ($otherForm['fields'] as $field) {
                if ($field['type'] !== 'linked_record') continue;
                $targetId = $field['properties']['targetFormId'] ?? null;
                if ($targetId !== $formId) continue;

                // This form has a linked_record field pointing at our form
                // Check if user has permission to view the other form's responses
                $canViewOther = $this->appUserService->hasPermission($app['id'], $userId, AppPermissions::VIEW_ALL_RESPONSES, $otherFormId)
                    || $this->appUserService->hasPermission($app['id'], $userId, AppPermissions::VIEW_OWN_RESPONSES, $otherFormId);
                if (!$canViewOther) continue;

                // Search responses of otherForm for ones that reference $responseId
                $otherResponses = $this->appResponseService->getResponses($otherFormId, 'all', $userId, ['limit' => 500]);
                $matchingRecords = [];

                foreach ($otherResponses as $otherResp) {
                    $answers = $otherResp['answers'] ?? [];
                    $linkedVal = $answers[$field['id']] ?? null;

                    $matches = false;
                    if (is_array($linkedVal)) {
                        $matches = in_array($responseId, $linkedVal);
                    } else {
                        $matches = $linkedVal === $responseId;
                    }

                    if ($matches) {
                        // Build display
                        $displayFieldIds = $field['properties']['displayFieldIds'] ?? [];
                        $parts = [];
                        if (!empty($displayFieldIds)) {
                            foreach ($displayFieldIds as $dfid) {
                                $val = $answers[$dfid] ?? null;
                                if ($val !== null) $parts[] = is_array($val) ? implode(', ', $val) : (string)$val;
                            }
                        }
                        // Use first text fields as fallback
                        if (empty($parts)) {
                            $count = 0;
                            foreach ($otherForm['fields'] as $f) {
                                if ($count >= 2) break;
                                if (in_array($f['type'], ['short_text', 'long_text', 'email', 'number'])) {
                                    $val = $answers[$f['id']] ?? null;
                                    if ($val !== null) { $parts[] = (string)$val; $count++; }
                                }
                            }
                        }

                        $matchingRecords[] = [
                            'id' => $otherResp['id'],
                            'display' => implode(' - ', $parts) ?: ('Record ' . substr($otherResp['id'], 0, 8)),
                            'submittedAt' => $otherResp['submittedAt'] ?? '',
                        ];
                    }
                }

                if (!empty($matchingRecords)) {
                    $related[$otherFormId] = [
                        'formId' => $otherFormId,
                        'displayName' => $appForm['displayName'] ?? $otherForm['title'],
                        'fieldLabel' => $field['label'],
                        'records' => $matchingRecords,
                        'count' => count($matchingRecords),
                    ];
                }
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
                $targetFormId = $field['properties']['targetFormId'];
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
            $targetForm = $this->formService->getForm($targetFormId);
            if (!$targetForm) continue;

            // Find display field IDs from the linked field config
            $displayFieldIds = [];
            foreach ($linkedFields as $field) {
                if ($field['properties']['targetFormId'] === $targetFormId) {
                    $displayFieldIds = $field['properties']['displayFieldIds'] ?? [];
                    break;
                }
            }

            $targetResponses = $this->appResponseService->getResponses($targetFormId, 'all', $userId, ['limit' => 500]);
            $resolvedCache[$targetFormId] = [];

            foreach ($targetResponses as $tr) {
                if (!isset($idMap[$tr['id']])) continue;

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
                        if (in_array($f['type'], ['short_text', 'long_text', 'email', 'number'])) {
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
                $targetFormId = $field['properties']['targetFormId'];
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

    private function jsonResponse(Response $response, array $data, int $status = 200): Response
    {
        $response->getBody()->write(json_encode($data));
        return $response
            ->withStatus($status)
            ->withHeader('Content-Type', 'application/json');
    }
}

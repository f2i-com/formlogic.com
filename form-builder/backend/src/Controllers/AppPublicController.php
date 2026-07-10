<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\AppService;
use FormLogic\Services\AppDomainService;
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
    use JsonResponseTrait;

    private AppService $appService;
    private AppUserService $appUserService;
    private AppResponseService $appResponseService;
    private FormService $formService;
    private ResponseService $responseService;
    private PDO $mysql;
    private SQLiteConnection $sqlite;
    private AppDomainService $appDomains;

    public function __construct(
        AppService $appService,
        AppUserService $appUserService,
        AppResponseService $appResponseService,
        FormService $formService,
        ResponseService $responseService,
        MySQLConnection $mysql,
        SQLiteConnection $sqlite,
        AppDomainService $appDomains
    ) {
        $this->appService = $appService;
        $this->appUserService = $appUserService;
        $this->appResponseService = $appResponseService;
        $this->formService = $formService;
        $this->responseService = $responseService;
        $this->mysql = $mysql->getConnection();
        $this->sqlite = $sqlite;
        $this->appDomains = $appDomains;
    }

    /**
     * Validate app slug format to avoid unnecessary DB queries.
     */
    private function validateSlug(string $slug): bool
    {
        return (bool) preg_match('/^[a-z0-9][a-z0-9-]{0,60}$/', $slug);
    }

    /**
     * Whether an app member should receive $formId's schema in the runtime config. True if they hold
     * any per-form permission on it (submit/view/edit/delete/export/analytics), or an app-wide grant
     * that covers all forms (manage_app / view_analytics / an app-level form permission). The owner's
     * permission set is ALL, so owners always pass.
     */
    private function memberCanSeeForm(array $permissions, string $formId): bool
    {
        $appLevel = $permissions['appLevel'] ?? [];
        if (in_array(AppPermissions::MANAGE_APP, $appLevel, true) || in_array(AppPermissions::VIEW_ANALYTICS, $appLevel, true)) {
            return true;
        }
        $relevant = array_merge(AppPermissions::FORM_LEVEL, [AppPermissions::VIEW_ANALYTICS]);
        $formLevel = $permissions['formLevel'][$formId] ?? [];
        foreach ($relevant as $perm) {
            if (in_array($perm, $appLevel, true) || in_array($perm, $formLevel, true)) {
                return true;
            }
        }
        return false;
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

        // Build runtime forms with form field data. A member only receives the schema (fields/
        // settings/custom screen) of forms they have SOME permission on — not every visible form —
        // so a limited role can't inspect the operational structure of forms it can't use.
        $runtimeForms = [];
        foreach ($forms as $form) {
            if (!$form['isVisible']) {
                continue;
            }
            if (!$this->memberCanSeeForm($permissions, $form['formId'])) {
                continue;
            }
            $formData = $this->formService->getForm($form['formId']);
            if ($formData) {
                // Don't leak the owner's private notification settings (e.g.
                // notificationEmail) to app members.
                if (isset($formData['settings']) && is_array($formData['settings'])) {
                    unset($formData['settings']['notifications']);
                }
                $runtimeForms[] = [
                    'formId' => $form['formId'],
                    'displayName' => $form['displayName'],
                    'sortOrder' => $form['sortOrder'],
                    'fields' => $formData['fields'],
                    'settings' => $formData['settings'],
                    'theme' => $formData['theme'],
                    'icon' => $formData['icon'] ?? null,
                    'description' => $formData['description'] ?? null,
                    'customScreen' => $formData['customScreen'] ?? null,
                    // Form-scoped app-logic (runs only for this form) — owner-authored, sandboxed.
                    'customLogic' => (!empty($formData['customLogic'])) ? $formData['customLogic'] : null,
                ];
            }
        }

        // Explicit management capability so the client doesn't have to infer ownership from the
        // presence of the (stripped-for-members) ownerId. Owner-only today, matching the server-side
        // update/save checks (AppController gates writes on owner_id).
        $safeApp = $app;
        $isOwner = ($userId === ($app['ownerId'] ?? null));
        $safeApp['canManage'] = $isOwner;
        // Strip internal fields + narrow the app payload for non-owner members: the nav, dashboard
        // widgets, saved report specs, and landing page must not reveal the structure (form ids, field
        // names, queries) of forms the member can't see. Owners get the full app.
        if (!$isOwner) {
            unset($safeApp['ownerId']);
            $accessible = array_column($runtimeForms, 'formId');
            $safeApp = $this->filterAppForMember($safeApp, $accessible);
        }

        return $this->jsonResponse($response, [
            'app' => $safeApp,
            'forms' => $runtimeForms,
            'user' => $appUser,
            'permissions' => $permissions,
        ]);
    }

    /**
     * Narrow an app's payload to what a non-owner member may see, given the form ids they can access.
     * Drops nav items, dashboard widgets, and report specs bound to forms they can't use, and resets a
     * landing page that points at an inaccessible form — so no hidden form id / field name / query
     * leaks through the app config. (Custom CODE screens are owner-authored, app-wide trusted content;
     * the SDK's form context is already filtered via `forms`.)
     *
     * @param array    $safeApp
     * @param string[] $accessible
     */
    private function filterAppForMember(array $safeApp, array $accessible): array
    {
        $ok = fn($fid) => $fid === null || $fid === '' || in_array($fid, $accessible, true);

        // Nav: accessible forms only.
        if (isset($safeApp['navConfig']) && is_array($safeApp['navConfig'])) {
            $safeApp['navConfig'] = array_values(array_filter(
                $safeApp['navConfig'],
                fn($item) => is_array($item) && in_array($item['formId'] ?? null, $accessible, true)
            ));
        }

        // Landing page: fall back to the dashboard if it targets an inaccessible form.
        if (isset($safeApp['settings']) && is_array($safeApp['settings'])) {
            $lp = $safeApp['settings']['landingPage'] ?? null;
            if (is_string($lp) && $lp !== 'dashboard' && !in_array($lp, $accessible, true)) {
                $safeApp['settings']['landingPage'] = 'dashboard';
            }
        }

        // Reports: drop chart specs whose base/join form is inaccessible; then drop document blocks
        // that referenced a dropped report.
        if (isset($safeApp['reports']) && is_array($safeApp['reports'])) {
            $specUsesAccessibleForms = function ($spec) use ($ok): bool {
                if (!is_array($spec)) { return true; }
                if (!$ok($spec['formId'] ?? null)) { return false; }
                foreach (($spec['joins'] ?? []) as $j) {
                    if (is_array($j) && !$ok($j['formId'] ?? null)) { return false; }
                }
                return true;
            };
            $keptReportIds = [];
            $charts = [];
            $docs = [];
            foreach ($safeApp['reports'] as $item) {
                if (!is_array($item)) { continue; }
                if (($item['type'] ?? null) === 'document') { $docs[] = $item; continue; }
                if ($specUsesAccessibleForms($item['spec'] ?? null)) {
                    $charts[] = $item;
                    if (isset($item['id'])) { $keptReportIds[$item['id']] = true; }
                }
            }
            foreach ($docs as &$doc) {
                if (isset($doc['blocks']) && is_array($doc['blocks'])) {
                    $doc['blocks'] = array_values(array_filter($doc['blocks'], function ($b) use ($keptReportIds) {
                        if (!is_array($b)) { return false; }
                        if (($b['kind'] ?? null) === 'report') {
                            return isset($b['reportId'], $keptReportIds[$b['reportId']]);
                        }
                        return true; // text blocks stay
                    }));
                }
            }
            unset($doc);
            $safeApp['reports'] = array_merge(array_values($charts), array_values($docs));
        }

        // Dashboard home screen: drop widgets bound to inaccessible forms.
        if (isset($safeApp['customScreen']) && is_array($safeApp['customScreen'])) {
            $cs = $safeApp['customScreen'];
            if (($cs['kind'] ?? null) === 'dashboard' && isset($cs['dashboard']['widgets']) && is_array($cs['dashboard']['widgets'])) {
                $cs['dashboard']['widgets'] = array_values(array_filter($cs['dashboard']['widgets'], function ($w) use ($ok) {
                    if (!is_array($w)) { return false; }
                    $kind = $w['kind'] ?? null;
                    if ($kind === 'report') {
                        $spec = $w['spec'] ?? null;
                        if (!is_array($spec)) { return true; }
                        if (!$ok($spec['formId'] ?? null)) { return false; }
                        foreach (($spec['joins'] ?? []) as $j) {
                            if (is_array($j) && !$ok($j['formId'] ?? null)) { return false; }
                        }
                        return true;
                    }
                    if ($kind === 'list') {
                        return $ok($w['list']['formId'] ?? null);
                    }
                    return true; // text/actions/activity derive only from accessible forms
                }));
                $safeApp['customScreen'] = $cs;
            }
        }

        return $safeApp;
    }

    /**
     * Report the caller's membership status + whether they can self-register.
     * Does NOT require existing membership (so non-members can discover joinability).
     * GET /api/app/{slug}/membership
     */
    public function membership(Request $request, Response $response, array $args): Response
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

        $appUser = $this->appUserService->getAppUser($app['id'], $userId);
        $status = $appUser ? (string) $appUser['status'] : 'none';
        $settings = $app['settings'] ?? [];
        return $this->jsonResponse($response, [
            'appName' => $app['name'],
            'status' => $status,
            'isMember' => $appUser && $status === 'active',
            'canSelfRegister' => !$appUser && !empty($settings['allowSelfRegistration']),
        ]);
    }

    /**
     * Self-register the caller into the app (when allowed).
     * POST /api/app/{slug}/join
     */
    public function join(Request $request, Response $response, array $args): Response
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

        $settings = $app['settings'] ?? [];
        if (empty($settings['allowSelfRegistration'])) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'This app does not allow self-registration'], 403);
        }

        try {
            $result = $this->appUserService->selfRegister(
                $app['id'],
                $userId,
                $settings['defaultRoleId'] ?? null,
                !empty($settings['requireApproval'])
            );
            return $this->jsonResponse($response, ['success' => true, 'status' => $result['status']]);
        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
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

    /**
     * GET /api/app/{slug}/activity?limit=N — the most recent submissions across every form the
     * CALLER can view, newest-first (an app-wide activity feed). Server-side permission
     * filtering: a form contributes rows only if it passes the SAME runtime-config gate as
     * getApp (visible + memberCanSeeForm) AND the caller holds a view permission on it —
     * view_all → everyone's rows, view_own → only the caller's (a submit-only member must
     * never see other members' records). Per-form reads are capped at the requested limit
     * (newest-first in SQL), so a big app never scans whole response stores.
     */
    public function activity(Request $request, Response $response, array $args): Response
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
        $appUser = $this->appUserService->getAppUser($app['id'], $userId);
        if (!$appUser || $appUser['status'] !== 'active') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Not a member of this app'], 403);
        }

        $limit = max(1, min((int) ($request->getQueryParams()['limit'] ?? 8), 25));

        // Accessible forms: the runtime-config gate + a view permission (scope per form).
        $permissions = $this->appUserService->getUserPermissions($app['id'], $userId);
        $accessible = []; // formId => ['displayName' => string, 'scope' => 'all'|'own']
        foreach ($this->appService->getAppForms($app['id']) as $form) {
            $formId = $form['formId'];
            if (!$form['isVisible'] || !$this->memberCanSeeForm($permissions, $formId)) {
                continue;
            }
            $canViewAll = $this->appUserService->hasPermission($app['id'], $userId, AppPermissions::VIEW_ALL_RESPONSES, $formId);
            $canViewOwn = $canViewAll
                || $this->appUserService->hasPermission($app['id'], $userId, AppPermissions::VIEW_OWN_RESPONSES, $formId);
            if (!$canViewOwn) {
                continue; // submit-only: no record visibility
            }
            $accessible[$formId] = [
                'displayName' => (string) $form['displayName'],
                'scope' => $canViewAll ? 'all' : 'own',
            ];
        }

        // ONE batched MySQL read for the field definitions used to label records.
        $formsById = $this->formService->getFormsByIds(array_keys($accessible));

        $activity = [];
        foreach ($accessible as $formId => $meta) {
            // Newest ~limit rows per form (SQL-ordered submitted_at DESC), merged + re-sliced below.
            $rows = $this->appResponseService->getResponses($formId, $meta['scope'], $userId, ['limit' => $limit]);
            $fields = is_array($formsById[$formId]['fields'] ?? null) ? $formsById[$formId]['fields'] : [];
            foreach ($rows as $row) {
                $recordId = (string) ($row['id'] ?? '');
                $answers = is_array($row['answers'] ?? null) ? $row['answers'] : [];
                $activity[] = [
                    'formId' => $formId,
                    'formName' => $meta['displayName'],
                    'recordId' => $recordId,
                    'title' => $this->recordLabel($fields, $answers, $recordId),
                    'submittedAt' => (string) ($row['submittedAt'] ?? ''),
                ];
            }
        }

        // Global newest-first across all accessible forms ('Y-m-d H:i:s' sorts lexicographically).
        usort($activity, static fn (array $a, array $b): int => strcmp($b['submittedAt'], $a['submittedAt']));

        return $this->jsonResponse($response, ['activity' => array_slice($activity, 0, $limit)]);
    }

    /**
     * Best-effort human label for a record — the same default the linked-record lookup uses:
     * the first two non-empty text-ish answers joined with " - ", else "Record <id-prefix>".
     */
    private function recordLabel(array $fields, array $answers, string $responseId): string
    {
        $parts = [];
        foreach ($fields as $field) {
            if (count($parts) >= 2) {
                break;
            }
            if (!is_array($field) || !in_array($field['type'] ?? '', ['short_text', 'long_text', 'email', 'phone', 'number', 'url'], true)) {
                continue;
            }
            $val = $answers[$field['id'] ?? ''] ?? null;
            if ($val !== null && $val !== '') {
                $parts[] = is_array($val) ? implode(', ', $val) : (string) $val;
            }
        }
        return implode(' - ', $parts) ?: ('Record ' . substr($responseId, 0, 8));
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

        // Schema access requires SOME permission on this form — mere app membership isn't enough, so a
        // member can't fetch the fields/settings/screen of a form they can't use (mirrors getApp's
        // per-form filter). 404 (not 403) so it's indistinguishable from a form not in the app.
        $permissions = $this->appUserService->getUserPermissions($app['id'], $userId);
        if (!$this->memberCanSeeForm($permissions, $formId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found'], 404);
        }

        $form = $this->formService->getForm($formId);
        if (!$form) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found'], 404);
        }

        // Record a view for analytics (best-effort; never blocks form serving).
        $this->responseService->recordView($formId);

        // Strip sensitive fields from runtime response (incl. the owner's private
        // notification settings, e.g. notificationEmail).
        unset($form['logicScript'], $form['logicPrompt'], $form['userId']);
        if (isset($form['settings']) && is_array($form['settings'])) {
            unset($form['settings']['notifications']);
        }

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

        $data = $request->getParsedBody() ?? [];
        $data['ipAddress'] = IpResolver::fromEnvironment()->getClientIp($request);
        $data['userAgent'] = $request->getHeaderLine('User-Agent');

        $result = $this->processSubmission($app, $formId, $data, $userId);
        return $this->jsonResponse($response, $result['payload'], $result['status']);
    }

    /**
     * The full server-authoritative submission pipeline, shared by the single-submit endpoint and the
     * offline sync-batch endpoint. Returns ['status'=>int, 'payload'=>array] instead of a Response so
     * the batch caller can collect per-item results. Idempotent: when the caller supplies
     * data['idempotencyKey'], a replay returns the original response instead of creating a duplicate.
     *
     * @param array<string,mixed> $app
     * @param array<string,mixed> $data
     * @return array{status:int, payload:array<string,mixed>}
     */
    private function processSubmission(array $app, string $formId, array $data, string $userId): array
    {
        $key = (isset($data['idempotencyKey']) && is_string($data['idempotencyKey']) && $data['idempotencyKey'] !== '')
            ? $data['idempotencyKey'] : null;

        // No key: run the pipeline directly (no idempotency guarantees).
        if ($key === null) {
            return $this->runSubmissionPipeline($app, $formId, $data, $userId);
        }

        // Reserve the key BEFORE any work, using the table's UNIQUE(app_id, form_id, idempotency_key)
        // constraint as the atomic gate. This closes the check-then-act race (two concurrent replays
        // both passing a prior SELECT and each creating a duplicate response) and makes the ledger
        // payload-hash aware. The hash is over the RAW client answers so an exact replay matches and a
        // reused key with a different body is detected as a conflict.
        $payloadHash = hash('sha256', (string) json_encode($data['answers'] ?? []));
        $reserved = $this->idempotencyReserve($app['id'], $formId, $userId, $key, $payloadHash);
        if (is_array($reserved)) {
            // A row already exists for this (app, form, key).
            if (($reserved['payload_hash'] ?? '') !== $payloadHash) {
                return ['status' => 409, 'payload' => ['error' => true, 'conflict' => true,
                    'message' => 'This idempotency key was already used with a different submission.']];
            }
            if (is_string($reserved['response_id'] ?? null) && $reserved['response_id'] !== '') {
                // Completed replay — return the original response, create nothing new.
                return ['status' => 200, 'payload' => ['response' => ['id' => $reserved['response_id']], 'idempotent' => true]];
            }
            // Same payload, reservation still 'pending'. A YOUNG row means a concurrent submit is
            // genuinely in flight — ask the caller to retry. A STALE row is an ABANDONED reservation
            // (the owning request died between reserve and complete/release — crash, OOM, timeout);
            // without a takeover the client would loop on 409 processing forever (the offline queues
            // deliberately keep 'processing' items attempt-neutral). Retake it atomically: the DELETE
            // is guarded on status='pending' + age entirely DB-side, so two racers can't both win —
            // only the one whose DELETE removed the row (or who subsequently wins the re-reserve)
            // proceeds as owner.
            $takenOver = false;
            try {
                $del = $this->mysql->prepare(
                    "DELETE FROM app_submission_idempotency
                     WHERE app_id = :a AND form_id = :f AND idempotency_key = :k
                       AND status = 'pending' AND created_at < (NOW() - INTERVAL 600 SECOND)"
                );
                $del->execute(['a' => $app['id'], 'f' => $formId, 'k' => $key]);
                if ($del->rowCount() > 0) {
                    $takenOver = ($this->idempotencyReserve($app['id'], $formId, $userId, $key, $payloadHash) === 'owner');
                }
            } catch (\Throwable $e) {
                // Takeover is best-effort; fall through to the normal processing response.
            }
            if (!$takenOver) {
                return ['status' => 409, 'payload' => ['error' => true, 'processing' => true,
                    'message' => 'This submission is already being processed. Please retry in a moment.']];
            }
            $reserved = 'owner';
        }
        if ($reserved === 'unavailable') {
            // Audit FL-004/C-11: the ledger is the ONLY duplicate gate for replayed
            // submissions (service-worker background sync + manual retries carry the
            // same key). Failing open during a ledger outage could persist the same
            // submission twice — fail CLOSED and retryable instead; the offline
            // queues treat a 5xx as retry-later.
            return ['status' => 503, 'payload' => ['error' => true, 'retryable' => true,
                'message' => 'The submission ledger is temporarily unavailable — please retry.']];
        }
        $ownsReservation = ($reserved === 'owner');

        $result = $this->runSubmissionPipeline($app, $formId, $data, $userId);

        if ($ownsReservation) {
            $respId = ($result['status'] === 201) ? ($result['payload']['response']['id'] ?? null) : null;
            if (is_string($respId) && $respId !== '') {
                $this->idempotencyComplete($app['id'], $formId, $key, $respId);
            } else {
                // Validation / quota / rejection / error: release the reservation so a legitimate retry
                // of a genuinely-failed submit isn't poisoned by a stale 'pending' row.
                $this->idempotencyRelease($app['id'], $formId, $key);
            }
        }
        return $result;
    }

    /**
     * The server-authoritative submission pipeline (validation, quota, persistence, onSubmit script),
     * independent of idempotency. Returns ['status'=>int, 'payload'=>array] so both the wrapper above
     * and the sync-batch caller can collect per-item results.
     *
     * @param array<string,mixed> $app
     * @param array<string,mixed> $data
     * @return array{status:int, payload:array<string,mixed>}
     */
    private function runSubmissionPipeline(array $app, string $formId, array $data, string $userId): array
    {
        // Get form's logic script if any
        $form = $this->formService->getForm($formId);
        $script = $form ? ($form['logicScript'] ?? null) : null;
        $settings = $form['settings'] ?? [];

        if ($form) {
            // In an app the APP is the unit of publication: the form is reachable
            // only through the published app (checked above) and gated by the user's
            // SUBMIT permission. So — unlike the standalone/public + external-API
            // paths — we do NOT require the form's own status to be 'published';
            // app forms are commonly drafts that are never shared standalone, and
            // requiring per-form publishing silently rejected every submission with
            // "This form is not accepting responses." Only an explicitly archived
            // (retired) form is refused; use the form's isClosed setting (below) to
            // stop collecting without archiving.
            if (($form['status'] ?? '') === 'archived') {
                return ['status' => 403, 'payload' => ['error' => true, 'message' => 'This form is no longer accepting responses.']];
            }

            // Drop answers for non-input/unknown fields (e.g. forged calculated
            // values or arbitrary field IDs) before validating and persisting.
            $data['answers'] = $this->sanitizeAnswers($form['fields'] ?? [], $data['answers'] ?? []);
            // Re-derive file URLs server-side (don't trust client-supplied url) — parity
            // with the standalone path; prevents stored reviewer-facing phishing links.
            $data['answers'] = $this->responseService->normalizeAnswers($form['fields'] ?? [], $data['answers'], (string) ($form['id'] ?? ''));
            // Recompute calculated fields server-side (sanitize just stripped any
            // client-sent values) so app-runtime submissions persist them too —
            // parity with the standalone and External API submission paths.
            $data['answers'] = $this->responseService->applyCalculatedFields($form['fields'] ?? [], $data['answers']);
            $__fe = $this->responseService->validateFileAnswers($form['fields'] ?? [], $data['answers'], (string) ($form['id'] ?? ''));
            if (!empty($__fe)) {
                return ['status' => 400, 'payload' => ['error' => true, 'message' => 'Validation failed', 'errors' => $__fe]];
            }
            if ($this->responseService->answersTooLarge($data['answers'])) {
                return ['status' => 413, 'payload' => ['error' => true, 'message' => 'Submission is too large.']];
            }

            // Validate answers against form fields
            $validationErrors = $this->validateAnswers($form['fields'] ?? [], $data['answers'] ?? []);
            if (!empty($validationErrors)) {
                return ['status' => 400, 'payload' => ['error' => true, 'message' => 'Validation failed', 'errors' => $validationErrors]];
            }

            // Check if form is closed
            if (!empty($settings['isClosed'])) {
                $closedMessage = $settings['closedMessage'] ?? 'This form is no longer accepting responses.';
                return ['status' => 403, 'payload' => ['error' => true, 'message' => $closedMessage]];
            }

            // Check quota limit
            if (!empty($settings['quotaLimit'])) {
                $responseCount = $this->responseService->getResponseCount($formId);
                if ($responseCount >= (int) $settings['quotaLimit']) {
                    $closedMessage = $settings['closedMessage'] ?? 'This form has reached its maximum number of responses.';
                    return ['status' => 403, 'payload' => ['error' => true, 'message' => $closedMessage]];
                }
            }
        }

        try {
            // Atomic quota enforcement: re-check the count under a per-form lock so
            // concurrent submissions cannot both pass the earlier check and overshoot
            // quotaLimit (the lock fails open under contention).
            $quotaLock = null;
            if ($form && !empty($settings['quotaLimit'])) {
                $quotaLock = $this->responseService->acquireFormLock($formId);
                if ($quotaLock === null) {
                    // Audit FL-004/C-11: without the mutex, concurrent submissions can
                    // both pass the re-check and overshoot a HARD cap — fail closed.
                    return ['status' => 503, 'payload' => ['error' => true, 'retryable' => true,
                        'message' => 'The form is busy — please retry in a moment.']];
                }
                if ($this->responseService->getResponseCount($formId) >= (int) $settings['quotaLimit']) {
                    $this->responseService->releaseFormLock($quotaLock);
                    $closedMessage = $settings['closedMessage'] ?? 'This form has reached its maximum number of responses.';
                    return ['status' => 403, 'payload' => ['error' => true, 'message' => $closedMessage]];
                }
            }
            try {
                $result = $this->appResponseService->createResponse($app['id'], $formId, $data, $userId, $script);
            } finally {
                $this->responseService->releaseFormLock($quotaLock);
            }

            if ($result instanceof \FormLogic\Services\ScriptRejection) {
                return ['status' => 422, 'payload' => ['error' => true, 'message' => $result->message, 'rejected' => true]];
            }

            return ['status' => 201, 'payload' => ['response' => $result]];
        } catch (\Throwable $e) {
            // \Throwable (not \Exception): an \Error escaping here would skip processSubmission's
            // reservation release and strand a 'pending' idempotency row (forever-409-processing until
            // the stale-takeover window). Returning a result keeps the release path on every failure.
            return ['status' => 500, 'payload' => ['error' => true, 'message' => 'Failed to save response']];
        }
    }

    /**
     * Offline sync: submit a batch of queued responses in one request. Each item runs the SAME
     * server-authoritative pipeline as a single submit and is idempotent by its key.
     * POST /api/app/{slug}/sync/batch  { items: [{ idempotencyKey, formId, answers }] }
     */
    public function syncBatch(Request $request, Response $response, array $args): Response
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

        $body = $request->getParsedBody() ?? [];
        $items = is_array($body['items'] ?? null) ? $body['items'] : [];
        if (count($items) > 100) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Too many items (max 100 per batch)'], 400);
        }

        $ip = IpResolver::fromEnvironment()->getClientIp($request);
        $ua = $request->getHeaderLine('User-Agent');
        $results = [];
        foreach ($items as $item) {
            $key = is_array($item) ? ($item['idempotencyKey'] ?? null) : null;
            $formId = is_array($item) ? (string) ($item['formId'] ?? '') : '';
            if ($formId === '' || !$this->verifyFormBelongsToApp($app['id'], $formId)) {
                $results[] = [
                    'idempotencyKey' => $key, 'success' => false, 'responseId' => null,
                    'error' => 'Unknown form', 'status' => 404,
                    'conflict' => false, 'processing' => false, 'idempotent' => false,
                ];
                continue;
            }
            if (!$this->appUserService->hasPermission($app['id'], $userId, AppPermissions::SUBMIT_RESPONSES, $formId)) {
                $results[] = [
                    'idempotencyKey' => $key, 'success' => false, 'responseId' => null,
                    'error' => 'Permission denied', 'status' => 403,
                    'conflict' => false, 'processing' => false, 'idempotent' => false,
                ];
                continue;
            }
            $data = [
                'answers' => (is_array($item) && is_array($item['answers'] ?? null)) ? $item['answers'] : [],
                'idempotencyKey' => is_string($key) ? $key : null,
                'ipAddress' => $ip,
                'userAgent' => $ua,
            ];
            $r = $this->processSubmission($app, $formId, $data, $userId);
            $status = (int) $r['status'];
            $payload = is_array($r['payload'] ?? null) ? $r['payload'] : [];
            // 200 = idempotent replay of an already-persisted response; 201 = freshly created. Both mean
            // the server holds this submission, so the client queue can drop the item.
            $ok = $status === 201 || $status === 200;
            // Surface processSubmission's idempotency distinctions verbatim so the native offline queue
            // can act on them precisely (see nativeOfflineQueue.flushNativeQueue): ACK success/idempotent,
            // terminally FAIL a `conflict` (a reused key with a different body — never succeeds on retry),
            // and KEEP a `processing` item (an in-flight duplicate a later flush should retry, not fail).
            $results[] = [
                'idempotencyKey' => $key,
                'success' => $ok,
                'responseId' => $ok ? ($payload['response']['id'] ?? null) : null,
                'error' => $ok ? null : ($payload['message'] ?? 'Failed'),
                'status' => $status,
                'conflict' => ($payload['conflict'] ?? false) === true,
                'processing' => ($payload['processing'] ?? false) === true,
                'idempotent' => ($payload['idempotent'] ?? false) === true,
            ];
        }

        return $this->jsonResponse($response, ['results' => $results]);
    }

    /**
     * Reserve an idempotency key by inserting a 'pending' row; the UNIQUE(app_id, form_id,
     * idempotency_key) constraint is the atomic gate. Returns:
     *   'owner'        — we won the reservation (caller must complete or release it),
     *   'unavailable'  — the ledger write failed for a non-duplicate reason (caller should fail open),
     *   array{response_id:?string, payload_hash:string, status:string} — an existing row (replay/conflict/in-flight).
     * @return string|array<string,mixed>
     */
    private function idempotencyReserve(string $appId, string $formId, string $userId, string $key, string $payloadHash)
    {
        try {
            $stmt = $this->mysql->prepare(
                "INSERT INTO app_submission_idempotency (id, app_id, form_id, user_id, idempotency_key, response_id, payload_hash, status, created_at)
                 VALUES (:id, :a, :f, :u, :k, NULL, :h, 'pending', NOW())"
            );
            $stmt->execute([
                'id' => $this->uuidV4(),
                'a' => $appId, 'f' => $formId, 'u' => $userId, 'k' => $key, 'h' => $payloadHash,
            ]);
            return 'owner';
        } catch (\PDOException $e) {
            // 23000 / MySQL 1062 = duplicate key → a row already exists for this key.
            $dup = $e->getCode() === '23000' || (isset($e->errorInfo[1]) && (int) $e->errorInfo[1] === 1062);
            if ($dup) {
                // If it vanished between the failed insert and this read (a racing release), fail open.
                return $this->idempotencyFind($appId, $formId, $key) ?? 'unavailable';
            }
            // Any other DB error: fail open — idempotency is best-effort, never block a real submit.
            return 'unavailable';
        }
    }

    /** @return array{response_id:?string, payload_hash:string, status:string}|null */
    private function idempotencyFind(string $appId, string $formId, string $key): ?array
    {
        $stmt = $this->mysql->prepare(
            "SELECT response_id, payload_hash, status FROM app_submission_idempotency
             WHERE app_id = :a AND form_id = :f AND idempotency_key = :k LIMIT 1"
        );
        $stmt->execute(['a' => $appId, 'f' => $formId, 'k' => $key]);
        $row = $stmt->fetch(\PDO::FETCH_ASSOC);
        if (!is_array($row)) {
            return null;
        }
        return [
            'response_id' => is_string($row['response_id'] ?? null) ? $row['response_id'] : null,
            'payload_hash' => (string) ($row['payload_hash'] ?? ''),
            'status' => (string) ($row['status'] ?? ''),
        ];
    }

    /** Mark a reservation completed, pointing it at the created response. Best-effort. */
    private function idempotencyComplete(string $appId, string $formId, string $key, string $responseId): void
    {
        try {
            $stmt = $this->mysql->prepare(
                "UPDATE app_submission_idempotency SET response_id = :r, status = 'completed'
                 WHERE app_id = :a AND form_id = :f AND idempotency_key = :k"
            );
            $stmt->execute(['r' => $responseId, 'a' => $appId, 'f' => $formId, 'k' => $key]);
        } catch (\Throwable $e) {
            // ignore — the response is already persisted; a failed ledger update only risks a future
            // duplicate on replay, never data loss.
        }
    }

    /** Release an unfulfilled reservation (only our own 'pending' row) so a retry can proceed. */
    private function idempotencyRelease(string $appId, string $formId, string $key): void
    {
        try {
            $stmt = $this->mysql->prepare(
                "DELETE FROM app_submission_idempotency
                 WHERE app_id = :a AND form_id = :f AND idempotency_key = :k AND status = 'pending'"
            );
            $stmt->execute(['a' => $appId, 'f' => $formId, 'k' => $key]);
        } catch (\Throwable $e) {
            // ignore
        }
    }

    private function uuidV4(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
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
            'limit' => max(1, min((int)($queryParams['limit'] ?? 100), 200)),
            'offset' => max(0, (int)($queryParams['offset'] ?? 0)),
        ];
        // Own-scope callers only see their own rows — pushed into SQL for correct pagination + count.
        if ($scope === 'own') {
            $options['submittedByUserId'] = $userId;
        }

        // Server-side search + total (so the records grid paginates + searches across ALL rows, fast).
        // Empty search field list → the searchable query falls back to matching the whole answers JSON.
        $search = trim((string)($queryParams['search'] ?? ''));

        // Make linked-record DISPLAY text + choice-field LABELS searchable too (not just raw stored
        // ids/option values): resolve the term to matching values and OR them into the query.
        $extraMatches = [];
        if ($search !== '') {
            $form = $this->formService->getForm($formId);
            $fields = is_array($form['fields'] ?? null) ? $form['fields'] : [];
            $appFormIds = [];
            foreach ($this->appService->getAppForms($app['id']) as $af) {
                $appFormIds[$af['formId']] = true;
            }
            $lowerSearch = mb_strtolower($search);
            $choiceTypes = ['dropdown', 'multiple_choice', 'checkbox', 'checkboxes', 'radio'];
            $multiTypes = ['multiple_choice', 'checkbox', 'checkboxes'];
            foreach ($fields as $field) {
                $fid = (string) ($field['id'] ?? '');
                $type = (string) ($field['type'] ?? '');
                if ($fid === '') { continue; }

                if ($type === 'linked_record') {
                    $tf = $field['properties']['targetFormId'] ?? null;
                    // Cross-tenant guard: only search a target form that belongs to this app + the caller can view.
                    if (!$tf || empty($appFormIds[$tf])) { continue; }
                    $tCanAll = $this->appUserService->hasPermission($app['id'], $userId, AppPermissions::VIEW_ALL_RESPONSES, $tf);
                    $tCanOwn = $this->appUserService->hasPermission($app['id'], $userId, AppPermissions::VIEW_OWN_RESPONSES, $tf);
                    if (!$tCanAll && !$tCanOwn) { continue; }
                    $ids = $this->responseService->findMatchingResponseIds($tf, $search, $tCanAll ? null : $userId);
                    if ($ids) {
                        $extraMatches[] = ['field' => $fid, 'values' => $ids, 'multi' => ($field['properties']['allowMultiple'] ?? false) === true];
                    }
                } elseif (in_array($type, $choiceTypes, true)) {
                    $vals = [];
                    foreach (($field['properties']['options'] ?? []) as $o) {
                        if (!is_array($o)) { continue; }
                        $label = (string) ($o['label'] ?? '');
                        if (isset($o['value']) && $label !== '' && str_contains(mb_strtolower($label), $lowerSearch)) {
                            $vals[] = (string) $o['value'];
                        }
                    }
                    if ($vals) {
                        $extraMatches[] = ['field' => $fid, 'values' => $vals, 'multi' => in_array($type, $multiTypes, true)];
                    }
                }
            }
        }

        $result = $this->responseService->getFormResponsesSearchable($formId, $search, [], $options, $extraMatches);
        $responses = $result['responses'];
        $total = (int) ($result['total'] ?? count($responses));

        // Resolve linked records if requested (only for the current page).
        if (($queryParams['resolve'] ?? '') === 'linked') {
            $form = $this->formService->getForm($formId);
            if ($form) {
                $responses = $this->resolveLinkedRecords($responses, $form, $app['id'], $userId);
            }
        }

        $responses = array_map([$this, 'stripSensitiveMetadata'], $responses);
        return $this->jsonResponse($response, ['responses' => $responses, 'count' => count($responses), 'total' => $total, 'scope' => $scope]);
    }

    /**
     * Export an app form's responses as CSV — gated on the EXPORT_RESPONSES permission
     * (this is what makes that role permission actually enforce something in the runtime).
     */
    public function exportResponses(Request $request, Response $response, array $args): Response
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
        if (!$this->appUserService->hasPermission($app['id'], $userId, AppPermissions::EXPORT_RESPONSES, $formId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Permission denied'], 403);
        }
        $form = $this->formService->getForm($formId);
        if (!$form) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found'], 404);
        }

        $safeTitle = preg_replace('/[^A-Za-z0-9_-]+/', '-', (string) ($form['title'] ?? 'form')) ?: 'form';
        $filename = trim($safeTitle, '-') . '-responses.csv';
        $stream = fopen('php://temp', 'r+');
        $this->responseService->exportResponsesStreaming($formId, $form['fields'] ?? [], $stream);
        rewind($stream);

        return $response
            ->withBody(new \Slim\Psr7\Stream($stream))
            ->withHeader('Content-Type', 'text/csv; charset=utf-8')
            ->withHeader('Content-Disposition', 'attachment; filename="' . $filename . '"');
    }

    /**
     * Aggregate analytics for an app form — gated on the VIEW_ANALYTICS permission (so that
     * role permission enforces something). Returns aggregates only, never individual answers.
     */
    public function analytics(Request $request, Response $response, array $args): Response
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
        if (!$this->appUserService->hasPermission($app['id'], $userId, AppPermissions::VIEW_ANALYTICS, $formId)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Permission denied'], 403);
        }
        $queryParams = $request->getQueryParams();
        $analytics = $this->responseService->getFormAnalytics($formId, [
            'from' => $queryParams['from'] ?? null,
            'to' => $queryParams['to'] ?? null,
        ]);
        return $this->jsonResponse($response, ['analytics' => $analytics]);
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

        $resp = $this->stripSensitiveMetadata($resp);
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

        // Normalize: an empty/non-JSON body parses to null, which would raise an
        // uncaught \TypeError (HTTP 500) when passed to the array-typed service.
        $data = $request->getParsedBody() ?? [];

        // Review-workflow status (approve/reject/review/archive) is a REVIEWER
        // action — gate it on VIEW_ALL_RESPONSES so a submitter with edit rights
        // on their own records can't self-approve. Editors without VIEW_ALL keep
        // their answer-edit ability; the status field is just dropped for them.
        if (isset($data['status'])) {
            if (!$canViewAll || !in_array($data['status'], ['submitted', 'reviewed', 'approved', 'rejected', 'archived'], true)) {
                unset($data['status']);
            }
        }

        // Validate answers against form fields if answers are being updated
        if (isset($data['answers'])) {
            $form = $this->formService->getForm($formId);
            if ($form) {
                // PATCH semantics: callers (record editors, app-logic effects, flow output
                // actions) may send only the fields they change. Merge over the STORED
                // answers before validating, so a partial update like {status, ended_at}
                // isn't rejected for omitting an unrelated required field. Required fields
                // can still only be cleared by an explicit empty value, never by omission.
                if (is_array($data['answers'])) {
                    $existingAnswers = is_array($existingResp['answers'] ?? null) ? $existingResp['answers'] : [];
                    $data['answers'] = array_merge($existingAnswers, $data['answers']);
                }
                // Drop non-input/unknown field answers before validating/persisting
                $data['answers'] = $this->sanitizeAnswers($form['fields'] ?? [], $data['answers']);
                $data['answers'] = $this->responseService->normalizeAnswers($form['fields'] ?? [], $data['answers'], $formId);
                $data['answers'] = $this->responseService->applyCalculatedFields($form['fields'] ?? [], $data['answers']);
                $__fe = $this->responseService->validateFileAnswers($form['fields'] ?? [], $data['answers'], (string) ($form['id'] ?? ''));
                if (!empty($__fe)) {
                    return $this->jsonResponse($response, ['error' => true, 'message' => 'Validation failed', 'errors' => $__fe], 400);
                }
                if ($this->responseService->answersTooLarge($data['answers'])) {
                    return $this->jsonResponse($response, ['error' => true, 'message' => 'Submission is too large.'], 413);
                }
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

        $updated = $this->stripSensitiveMetadata($updated);
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

        // The manifest is served from the API origin, but the app runs on the FRONTEND
        // origin. Per the manifest spec, relative start_url/scope/icons resolve against
        // the manifest's (API) origin — which puts the installing document out of scope
        // and makes Chrome refuse to install. Resolve everything to the frontend origin.
        $base = null;
        try { $base = rtrim(\FormLogic\Helpers\AppUrl::frontendBase($request), '/'); } catch (\Throwable $e) { $base = null; }
        $appPath = '/app/' . $slug;

        $manifest = $this->buildPwaManifest($app, $base ?? '', $appPath, $appPath);

        $json = json_encode($manifest);
        if ($json === false) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to build manifest'], 500);
        }
        $response->getBody()->write($json);
        return $response
            ->withStatus(200)
            ->withHeader('Content-Type', 'application/manifest+json');
    }

    /**
     * PWA manifest served at a CUSTOM DOMAIN root: GET /manifest.json. Resolves the request Host
     * (or ?host=) to a connected+active domain of a PUBLISHED app and returns a same-origin
     * installable manifest rooted at "/" (the branded launch page). Chrome refuses a cross-origin
     * scope, so start_url/scope/icons are built from the request scheme + verified Host — NOT
     * AppUrl::frontendBase (which deliberately ignores the Host). On a platform host (no custom
     * domain) this 404s; the VitePWA /manifest.webmanifest stays the platform default.
     */
    public function manifestByHost(Request $request, Response $response): Response
    {
        $hostHeader = $request->getHeaderLine('Host');
        $resolveHost = trim((string) ($request->getQueryParams()['host'] ?? ''));
        if ($resolveHost === '') {
            $resolveHost = $hostHeader;
        }
        $resolved = $resolveHost !== '' ? $this->appDomains->resolveAppSlugByHost($resolveHost) : null;
        if (!$resolved) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Not found'], 404);
        }
        $app = $this->appService->getAppBySlug($resolved['slug']);
        if (!$app || ($app['status'] ?? '') !== 'published') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Not found'], 404);
        }

        // Same-origin base from the request scheme + the (verified) Host. Prefer the actual Host
        // header for the authority so the origin matches the installing document exactly.
        $authorityHost = $hostHeader !== '' ? $hostHeader : $resolveHost;
        $base = $this->sameOriginBase($request, $authorityHost);
        // The custom-domain PWA installs at the branded root ("/").
        $manifest = $this->buildPwaManifest($app, $base, '/', '/');

        $json = json_encode($manifest);
        if ($json === false) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Failed to build manifest'], 500);
        }
        $response->getBody()->write($json);
        return $response
            ->withStatus(200)
            ->withHeader('Content-Type', 'application/manifest+json');
    }

    /**
     * Build a PWA web-app manifest for $app. $base is the ABSOLUTE origin that start_url/scope/icons
     * resolve against (the server-trusted frontend origin for the platform slug route; the same-origin
     * custom domain for the by-host route); pass '' when no trusted base is available. $startPath and
     * $scopePath are document paths within that origin. Never includes any form schema/field data.
     *
     * @param array<string,mixed> $app
     * @return array<string,mixed>
     */
    private function buildPwaManifest(array $app, string $base, string $startPath, string $scopePath): array
    {
        $theme = is_array($app['theme'] ?? null) ? $app['theme'] : [];
        $settings = is_array($app['settings'] ?? null) ? $app['settings'] : [];
        $base = rtrim($base, '/');

        // Defense-in-depth: a malformed stored hex would produce an invalid manifest
        // (browsers reject it). Fall back to a safe default if it isn't a valid hex.
        $hex = static fn(?string $v, string $default): string =>
            (is_string($v) && preg_match('/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/', $v)) ? $v : $default;

        $manifest = [
            'name' => $app['name'],
            // mb_substr (not substr): a byte-cut multibyte name would be invalid UTF-8,
            // which makes json_encode() return false -> an empty/broken manifest.
            'short_name' => $settings['pwaShortName'] ?? mb_substr((string) $app['name'], 0, 12),
            'description' => $app['description'] ?? '',
            'start_url' => $base . $startPath,
            'scope' => $base . $scopePath,
            'display' => 'standalone',
            'background_color' => $hex($theme['backgroundColor'] ?? null, '#ffffff'),
            'theme_color' => $hex($settings['pwaThemeColor'] ?? $theme['primaryColor'] ?? null, '#6366f1'),
            'icons' => [],
        ];

        $icons = [];
        // The app's own logo first (branding), when set.
        if (!empty($app['logoUrl'])) {
            $icons[] = ['src' => $app['logoUrl'], 'sizes' => '192x192', 'type' => 'image/png'];
            $icons[] = ['src' => $app['logoUrl'], 'sizes' => '512x512', 'type' => 'image/png'];
        }
        // ALWAYS include the platform icons (absolute) so the manifest carries the 192 + 512 +
        // maskable icons Chrome requires to be installable — without these an app with no logo is
        // silently un-installable, even though the Deploy UI offers "Add to Home Screen".
        if ($base !== '') {
            $icons[] = ['src' => $base . '/pwa-192x192.png', 'sizes' => '192x192', 'type' => 'image/png', 'purpose' => 'any'];
            $icons[] = ['src' => $base . '/pwa-512x512.png', 'sizes' => '512x512', 'type' => 'image/png', 'purpose' => 'any'];
            $icons[] = ['src' => $base . '/pwa-512x512.png', 'sizes' => '512x512', 'type' => 'image/png', 'purpose' => 'maskable'];
        }
        $manifest['icons'] = $icons;

        return $manifest;
    }

    /**
     * Same-origin absolute base (scheme://authority) for a custom-domain manifest. The authority is the
     * verified Host; the scheme comes from X-Forwarded-Proto when proxied, else the request URI scheme,
     * defaulting to https (custom domains require HTTPS in production).
     */
    private function sameOriginBase(Request $request, string $host): string
    {
        // Upgrade-only: X-Forwarded-Proto is honored only to CONFIRM https (a proxy forwarding http on the
        // wire); a spoofed "X-Forwarded-Proto: http" must not downgrade a same-origin manifest to cleartext.
        $proto = strtolower(trim(explode(',', $request->getHeaderLine('X-Forwarded-Proto'))[0]));
        if ($proto === 'https') {
            return 'https://' . $host;
        }
        // Production default-https (hardening #4): a TLS-terminating proxy that does NOT set
        // X-Forwarded-Proto shows the backend plain http, but a live custom domain is always served over
        // TLS in production — so only development may ever emit http (keeps http://formlogic.local
        // working). Mirrors config/settings.php's safe-by-default env read: anything other than an
        // explicit APP_ENV=development counts as production.
        if (($_ENV['APP_ENV'] ?? (getenv('APP_ENV') ?: 'production')) !== 'development') {
            return 'https://' . $host;
        }
        return (strtolower($request->getUri()->getScheme()) === 'http' ? 'http' : 'https') . '://' . $host;
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
            // Cap the number of IDs to prevent memory exhaustion
            $requestedIds = array_slice($requestedIds, 0, 500);
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

    /**
     * POST /api/app/{slug}/reports/run
     * Run a no-code report spec against one of the app's forms. Read-only (a scoped SELECT); the spec
     * is data, never SQL. Permission-scoped per form (view-all → all rows, view-own → the caller's).
     */
    public function runReport(Request $request, Response $response, array $args): Response
    {
        $slug = $args['slug'] ?? '';
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

        $body = $request->getParsedBody() ?? [];
        $spec = is_array($body['spec'] ?? null) ? $body['spec'] : (is_array($body) ? $body : []);
        if (!isset($spec['formId']) && isset($body['formId'])) { $spec['formId'] = $body['formId']; }
        $r = $this->resolveAndRunSpec($app, (string) $userId, is_array($spec) ? $spec : []);
        return $this->jsonResponse($response, $r['body'], $r['status']);
    }

    /**
     * POST /api/app/{slug}/reports/run-batch
     * Run several report specs in one round (one request per dashboard, not one per widget). Same
     * permission scoping as run; a spec that fails individually yields an {error:true} entry rather
     * than failing the whole batch, so one broken widget can't blank the dashboard.
     */
    public function runReportBatch(Request $request, Response $response, array $args): Response
    {
        $slug = $args['slug'] ?? '';
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
        $body = $request->getParsedBody() ?? [];
        $specs = is_array($body['specs'] ?? null) ? array_slice($body['specs'], 0, 40) : [];
        $results = [];
        foreach ($specs as $spec) {
            if (!is_array($spec)) { $results[] = ['error' => true]; continue; }
            $r = $this->resolveAndRunSpec($app, (string) $userId, $spec);
            $results[] = $r['status'] === 200 ? $r['body'] : ['viz' => (string) ($spec['viz'] ?? 'kpi'), 'error' => true];
        }
        return $this->jsonResponse($response, ['results' => $results]);
    }

    /**
     * Shared per-spec resolve → permission-check → join-authorise → run. Returns
     * ['status' => int, 'body' => array] so both the single and batch endpoints reuse identical
     * scoping (joins re-derived server-side; the spec's declared joins are never trusted).
     */
    private function resolveAndRunSpec(array $app, string $userId, array $spec): array
    {
        $formId = (string) ($spec['formId'] ?? '');
        if ($formId === '') {
            return ['status' => 400, 'body' => ['error' => true, 'message' => 'formId is required']];
        }
        if (!$this->verifyFormBelongsToApp($app['id'], $formId)) {
            return ['status' => 404, 'body' => ['error' => true, 'message' => 'Form not found in this app']];
        }

        $canViewAll = $this->appUserService->hasPermission($app['id'], $userId, AppPermissions::VIEW_ALL_RESPONSES, $formId);
        $canViewOwn = $this->appUserService->hasPermission($app['id'], $userId, AppPermissions::VIEW_OWN_RESPONSES, $formId);
        if (!$canViewAll && !$canViewOwn) {
            return ['status' => 403, 'body' => ['error' => true, 'message' => 'Permission denied']];
        }

        $form = $this->formService->getForm($formId);
        if (!$form) {
            return ['status' => 404, 'body' => ['error' => true, 'message' => 'Form not found']];
        }

        // Resolve + authorise cross-form joins. A join is only allowed ALONG a real linked_record
        // relationship on the base form (via field → target form), and the joined form must be in this
        // app and viewable by the caller. Anything not meeting that is silently dropped (no error).
        $baseLinked = [];
        foreach ($form['fields'] ?? [] as $f) {
            if (($f['type'] ?? '') === 'linked_record' && !empty($f['properties']['targetFormId'])) {
                $baseLinked[$f['id']] = (string) $f['properties']['targetFormId'];
            }
        }
        $resolvedJoins = [];
        $seenJoinForms = [];
        foreach ($spec['joins'] ?? [] as $j) {
            if (!is_array($j)) { continue; }
            $via = (string) ($j['via'] ?? '');
            $jFormId = (string) ($j['formId'] ?? '');
            if (!isset($baseLinked[$via]) || $baseLinked[$via] !== $jFormId) { continue; } // must be a real link
            if (isset($seenJoinForms[$jFormId])) { continue; } // one join per target form (MVP)
            if (!$this->verifyFormBelongsToApp($app['id'], $jFormId)) { continue; }
            $jViewAll = $this->appUserService->hasPermission($app['id'], $userId, AppPermissions::VIEW_ALL_RESPONSES, $jFormId);
            $jViewOwn = $this->appUserService->hasPermission($app['id'], $userId, AppPermissions::VIEW_OWN_RESPONSES, $jFormId);
            if (!$jViewAll && !$jViewOwn) { continue; }
            $jForm = $this->formService->getForm($jFormId);
            if (!$jForm) { continue; }
            $seenJoinForms[$jFormId] = true;
            $resolvedJoins[] = [
                'formId' => $jFormId,
                'via' => $via,
                'type' => (($j['type'] ?? 'left') === 'inner') ? 'inner' : 'left',
                // A view-own caller must only see their own rows of the joined form too.
                'scope' => $jViewAll ? 'all' : 'own',
                'fields' => $jForm['fields'] ?? [],
                'path' => $this->sqlite->getFormDbPath($jFormId),
            ];
        }

        // Linked-record labels in table cells may only reveal target forms this member can view (else
        // the label leaks a hidden record's name). Build that allowlist from the member's permissions.
        $perms = $this->appUserService->getUserPermissions($app['id'], $userId);
        $appLevel = $perms['appLevel'] ?? [];
        $viewAppWide = in_array(AppPermissions::VIEW_ALL_RESPONSES, $appLevel, true)
            || in_array(AppPermissions::VIEW_OWN_RESPONSES, $appLevel, true)
            || in_array(AppPermissions::MANAGE_APP, $appLevel, true);
        $resolvableFormIds = [];
        foreach ($this->appService->getAppForms($app['id']) as $af) {
            $fid = (string) ($af['formId'] ?? '');
            $fl = $perms['formLevel'][$fid] ?? [];
            if ($fid !== '' && ($viewAppWide
                || in_array(AppPermissions::VIEW_ALL_RESPONSES, $fl, true)
                || in_array(AppPermissions::VIEW_OWN_RESPONSES, $fl, true))) {
                $resolvableFormIds[] = $fid;
            }
        }

        try {
            // Relative date filters are evaluated in the app's timezone (falls back to UTC).
            $tz = (string) ($app['settings']['timezone'] ?? 'UTC') ?: 'UTC';
            $svc = new \FormLogic\Services\ReportService($this->sqlite, $this->formService);
            $result = $svc->runReport($spec, $form['fields'] ?? [], $formId, $canViewAll ? 'all' : 'own', $userId, $resolvedJoins, $tz, $resolvableFormIds);
            return ['status' => 200, 'body' => $result];
        } catch (\Throwable $e) {
            return ['status' => 500, 'body' => ['error' => true, 'message' => 'Failed to run report']];
        }
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
            "SELECT source_form_id, source_response_id, field_id FROM response_links WHERE target_form_id = :target_form_id AND target_response_id = :target_response_id ORDER BY source_form_id, source_response_id, field_id LIMIT :lim OFFSET :off"
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
        // Cheap boolean check (indexed) instead of fetching + scanning the full
        // getAppForms JOIN just to test membership.
        return $this->appService->formBelongsToApp($appId, $formId);
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

        // Build set of forms that belong to this app (cross-tenant guard)
        $appForms = $this->appService->getAppForms($appId);
        $appFormIds = [];
        foreach ($appForms as $af) {
            $appFormIds[$af['formId']] = true;
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

            // Cross-tenant guard: only resolve forms that belong to this app
            if (!isset($appFormIds[$targetFormId])) {
                continue;
            }

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
                    // No display fields configured — derive a smart label (prefers name fields,
                    // first+last concat, etc.), falling back to the first text field.
                    $guess = \FormLogic\Helpers\RecordLabel::guess($targetForm['fields'], $answers);
                    if ($guess !== null && $guess !== '') { $parts[] = $guess; }
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

        // Resolve conditional visibility from the submitted answers so we don't
        // enforce required (or type validation) on fields the user couldn't see —
        // and so 'require' actions are honored. Parity with the standalone + external
        // API paths; without it a conditionally-hidden required field makes an
        // app form permanently unsubmittable.
        $visibility = $this->responseService->computeFieldVisibility($fields, $answers);

        foreach ($fields as $field) {
            $fieldId = $field['id'] ?? null;
            if (!$fieldId) {
                continue;
            }

            $fieldType = $field['type'] ?? 'short_text';

            // Skip validation for non-input field types
            if (in_array($fieldType, ['statement', 'welcome_screen', 'thank_you', 'calculated', 'hidden'], true)) {
                continue;
            }

            // Skip fields hidden by conditional logic (can't be filled -> dead-end);
            // use the logic-derived effective-required (honors 'require' actions).
            $fieldVis = $visibility[$fieldId] ?? ['visible' => true, 'required' => (bool)($field['required'] ?? false)];
            if (!$fieldVis['visible']) {
                continue;
            }
            $isRequired = $fieldVis['required'];

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
                continue;
            }
            // Builder-configured rules (min/maxLength, min/max, pattern, number bounds, date format)
            $ruleError = $this->responseService->validateFieldRules($field, $value);
            if ($ruleError) {
                $errors[$fieldId] = $ruleError;
            }
        }

        return $errors;
    }

    /**
     * Drop answers that don't correspond to a real input field (calculated /
     * statement / welcome / thank-you fields and unknown ids), so clients can't
     * persist forged computed values or arbitrary keys. Mirrors ResponseController.
     */
    private function sanitizeAnswers(array $fields, array $answers): array
    {
        if (!is_array($answers)) {
            return [];
        }
        $inputFieldIds = [];
        $nonInputTypes = ['calculated', 'statement', 'welcome_screen', 'thank_you', 'hidden'];
        foreach ($fields as $field) {
            $id = $field['id'] ?? null;
            if (!$id) {
                continue;
            }
            if (!in_array($field['type'] ?? 'short_text', $nonInputTypes, true)) {
                $inputFieldIds[$id] = true;
            }
        }
        $sanitized = [];
        foreach ($answers as $fieldId => $value) {
            if (isset($inputFieldIds[$fieldId])) {
                $sanitized[$fieldId] = $value;
            }
        }
        return $sanitized;
    }

    /**
     * Validate a field value against its type
     */
    private function validateFieldType(array $field, $value): ?string
    {
        $type = $field['type'] ?? 'short_text';

        // Scalar-typed fields must receive a scalar value. A client submitting an
        // array/object for e.g. a phone field would otherwise reach preg_match()
        // and throw an uncaught TypeError (HTTP 500). Reject it cleanly as a 400.
        // (Mirrors the standalone and External API validators.)
        $scalarTypes = ['short_text', 'long_text', 'email', 'url', 'number', 'phone', 'date', 'datetime', 'time'];
        if (in_array($type, $scalarTypes, true) && !is_scalar($value)) {
            return 'Invalid value';
        }

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
                if (count($value) > max(count($allowedValues), 1)) {
                    return 'Too many selections';
                }
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
                // Honor the field's allowMultiple setting server-side.
                if (empty($field['properties']['allowMultiple']) && count($value) > 1) {
                    return 'Only one file is allowed for this field';
                }
                // Cap the file count (mirrors the standalone submission path).
                $maxFiles = $field['properties']['maxFiles'] ?? 20;
                if (count($value) > $maxFiles) {
                    return "Maximum of {$maxFiles} files allowed";
                }
                // Validate each file metadata entry
                foreach ($value as $item) {
                    if (!is_array($item) || !isset($item['id']) || !isset($item['originalFilename'])) {
                        return 'Invalid file metadata';
                    }
                    if (!is_string($item['originalFilename']) || strlen($item['originalFilename']) > 255) {
                        return 'Invalid file name';
                    }
                }
                break;
        }

        return null;
    }

    /**
     * Strip sensitive metadata (IP, user agent, referrer) from response data.
     */
    private function stripSensitiveMetadata(array $resp): array
    {
        if (isset($resp['metadata']) && is_array($resp['metadata'])) {
            unset($resp['metadata']['ipAddress'], $resp['metadata']['userAgent'], $resp['metadata']['referrer']);
        }
        return $resp;
    }
}

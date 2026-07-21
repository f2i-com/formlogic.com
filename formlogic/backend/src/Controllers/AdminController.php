<?php

declare(strict_types=1);

namespace FormLogic\Controllers;

use FormLogic\Controllers\Concerns\JsonResponseTrait;
use FormLogic\Services\AccountBackupService;
use FormLogic\Services\AdminService;
use FormLogic\Services\AppService;
use FormLogic\Services\AuditService;
use FormLogic\Services\AuthService;
use FormLogic\Services\FlowService;
use FormLogic\Services\FormService;
use FormLogic\Services\MaintenanceService;
use FormLogic\Services\ResponseService;
use FormLogic\Services\ScheduledBackupService;
use FormLogic\Services\UpgradeService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Log\LoggerInterface;

/**
 * Admin panel API (/api/admin/* — AuthMiddleware + AdminGateMiddleware).
 *
 * Oversight boundary: admins see users, their apps/forms/flows STRUCTURE and
 * record COUNTS (usage/quota signals) and may edit structure on the owner's
 * behalf — but no endpoint here returns or exports anyone's response DATA.
 * Every mutation lands in the audit log as admin.*.
 */
class AdminController
{
    use JsonResponseTrait;

    public function __construct(
        private AdminService $admin,
        private AuthService $auth,
        private MaintenanceService $maintenance,
        private UpgradeService $upgrade,
        private FormService $forms,
        private AppService $apps,
        private FlowService $flows,
        private ResponseService $responses,
        private ?AuditService $auditService = null,
        private ?LoggerInterface $logger = null,
        private ?AccountBackupService $backup = null,
        private ?ScheduledBackupService $scheduledBackup = null,
        private ?\FormLogic\Services\MfaService $mfaService = null,
        private ?\FormLogic\Services\AccountErasureService $erasure = null,
        private ?\FormLogic\Services\EmailService $email = null,
        private ?\FormLogic\Services\PlanService $planService = null,
    ) {
    }

    // ── Overview + users ─────────────────────────────────────────────────────

    public function overview(Request $request, Response $response): Response
    {
        return $this->jsonResponse($response, [
            'stats' => $this->admin->overview(),
            'maintenance' => $this->maintenance->status(),
            'version' => $this->upgrade->currentVersion(),
            'sessionEpoch' => $this->auth->getSessionEpoch(),
        ]);
    }

    public function listUsers(Request $request, Response $response): Response
    {
        $q = $request->getQueryParams();
        return $this->jsonResponse($response, $this->admin->listUsers(
            trim((string) ($q['search'] ?? '')),
            max(1, (int) ($q['page'] ?? 1)),
            // Clamped: a hostile/typo'd limit must not turn into LIMIT 0 or a full scan.
            max(1, min(100, (int) ($q['limit'] ?? 25)))
        ));
    }

    public function getUser(Request $request, Response $response, array $args): Response
    {
        $user = $this->admin->getUserOverview((string) $args['id']);
        if ($user === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'User not found'], 404);
        }
        return $this->jsonResponse($response, ['user' => $user]);
    }

    public function setAdmin(Request $request, Response $response, array $args): Response
    {
        $body = $request->getParsedBody() ?? [];
        $isAdmin = ($body['isAdmin'] ?? null) === true;
        try {
            $this->admin->setAdminFlag((string) $args['id'], $isAdmin, (string) $request->getAttribute('userId'));
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
        $this->audit($request, $isAdmin ? 'admin.grant_admin' : 'admin.revoke_admin', (string) $args['id']);
        return $this->jsonResponse($response, ['success' => true, 'isAdmin' => $isAdmin]);
    }

    /**
     * POST /api/admin/users/{id}/mfa/reset { password } — lockout recovery:
     * switch the user's two-factor auth OFF (secret, recovery codes, pending
     * challenges and every remembered browser wiped; their sessions revoked)
     * so they can sign in with just their password and re-enroll.
     *
     * Step-up required (audit MFA-001): the acting admin re-enters THEIR OWN
     * password — a hijacked admin tab alone cannot strip a user's second
     * factor. Self-reset is refused (Settings → Security is the audited,
     * password+code-gated path for your own account), and the affected user
     * is notified by email when transactional mail is configured.
     */
    public function resetMfa(Request $request, Response $response, array $args): Response
    {
        if ($this->mfaService === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Two-factor authentication is not available'], 503);
        }
        $userId = (string) $args['id'];
        $target = $this->admin->accountRow($userId);
        if ($target === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'User not found'], 404);
        }
        $adminId = (string) $request->getAttribute('userId');
        if ($adminId === $userId) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Use Settings → Security to manage your own two-factor authentication'], 400);
        }
        $body = $request->getParsedBody() ?? [];
        if (!$this->auth->verifyPassword($adminId, (string) ($body['password'] ?? ''))) {
            $this->audit($request, 'admin.mfa_reset_denied', $userId, ['reason' => 'step_up_failed']);
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Enter your own password to confirm this reset'], 401);
        }
        $wasEnabled = $this->mfaService->isEnabled($userId);
        $this->mfaService->disable($userId); // transactional; bumps token_version = sessions + pending tokens revoked
        $this->audit($request, 'admin.mfa_reset', $userId, ['wasEnabled' => $wasEnabled]);
        if ($wasEnabled && $this->email !== null && is_string($target['email'] ?? null)) {
            // Best-effort notification — the reset must not fail on mail trouble.
            try {
                $this->email->send(
                    (string) $target['email'],
                    'Two-factor authentication was reset on your account',
                    '<p>An administrator reset two-factor authentication on your FormLogic account. '
                    . 'You can sign in with your password and re-enable it under Settings → Security.</p>'
                    . '<p>If you did not request this, contact your administrator immediately.</p>',
                    "An administrator reset two-factor authentication on your FormLogic account.\n"
                    . "You can sign in with your password and re-enable it under Settings → Security.\n"
                    . "If you did not request this, contact your administrator immediately."
                );
            } catch (\Throwable $e) {
                $this->logger?->warning('Admin MFA reset: notification email failed', ['error' => $e->getMessage()]);
            }
        }
        return $this->jsonResponse($response, ['success' => true, 'mfaEnabled' => false]);
    }

    // ── Account tools (support operations) ───────────────────────────────────

    /** Shared guard: the target row, or an error response. Demo refusable. */
    private function accountTarget(Response $response, string $userId, bool $refuseDemo = true): array|Response
    {
        $row = $this->admin->accountRow($userId);
        if ($row === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'User not found'], 404);
        }
        if ($refuseDemo && $this->admin->isDemoRow($row)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'The shared demo account cannot be modified'], 403);
        }
        return $row;
    }

    /**
     * POST /api/admin/users/{id}/password — lockout recovery: set a new password
     * (provided, validated against the policy) or generate a temporary one
     * (returned ONCE, never stored in plaintext or logged). Every outstanding
     * session for the user is revoked.
     */
    public function resetPassword(Request $request, Response $response, array $args): Response
    {
        $target = $this->accountTarget($response, (string) $args['id']);
        if ($target instanceof Response) {
            return $target;
        }
        $body = $request->getParsedBody() ?? [];
        $provided = (string) ($body['password'] ?? '');
        $generated = $provided === '';
        if ($generated) {
            // Unambiguous alphabet, 16 chars — comfortably past the policy.
            $alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
            $provided = '';
            for ($i = 0; $i < 16; $i++) {
                $provided .= $alphabet[random_int(0, strlen($alphabet) - 1)];
            }
        } elseif (($pwError = AuthService::passwordError($provided)) !== null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $pwError], 400);
        }
        $this->admin->setUserPassword($target['id'], $provided);
        // Sign the user out everywhere — old sessions must not survive a support reset.
        $this->auth->revokeTokens($target['id']);
        $this->audit($request, 'admin.password_reset', $target['id'], ['generated' => $generated]);
        return $this->jsonResponse($response, ['success' => true] + ($generated ? ['tempPassword' => $provided] : []));
    }

    /** PUT /api/admin/users/{id}/email — change the account's email address (sessions revoked). */
    public function updateEmail(Request $request, Response $response, array $args): Response
    {
        $target = $this->accountTarget($response, (string) $args['id']);
        if ($target instanceof Response) {
            return $target;
        }
        $body = $request->getParsedBody() ?? [];
        $email = trim((string) ($body['email'] ?? ''));
        try {
            $this->admin->setUserEmail($target['id'], $email);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
        $this->auth->revokeTokens($target['id']);
        $this->audit($request, 'admin.email_change', $target['id'], ['from' => $target['email'], 'to' => $email]);
        return $this->jsonResponse($response, ['success' => true, 'email' => $email]);
    }

    /** GET /api/admin/users/{id}/payments — the payment ledger + plan/complimentary state. */
    public function listPayments(Request $request, Response $response, array $args): Response
    {
        $target = $this->accountTarget($response, (string) $args['id'], false);
        if ($target instanceof Response) {
            return $target;
        }
        return $this->jsonResponse($response, [
            'payments' => $this->admin->listPayments($target['id']),
            'plan' => (string) ($target['plan'] ?? 'personal'),
            'cloudUntil' => $target['cloud_until'] ?? null,
            'complimentary' => $this->admin->isComplimentary($target['cloud_until'] ?? null),
        ]);
    }

    /**
     * POST /api/admin/users/{id}/complimentary — free access without payments:
     * ON pushes cloud_until ~100 years out; OFF sets it to now (paid time, if
     * any, is superseded — the ledger itself is never touched).
     */
    public function setComplimentary(Request $request, Response $response, array $args): Response
    {
        $target = $this->accountTarget($response, (string) $args['id']);
        if ($target instanceof Response) {
            return $target;
        }
        $enabled = (($request->getParsedBody() ?? [])['enabled'] ?? null) === true;
        $this->admin->setComplimentary($target['id'], $enabled);
        $this->audit($request, 'admin.complimentary', $target['id'], ['enabled' => $enabled]);
        return $this->jsonResponse($response, ['success' => true, 'complimentary' => $enabled]);
    }

    /** GET /api/admin/allowances — the per-plan monthly AI/cloud-credit allowance rows. */
    public function listAllowances(Request $request, Response $response): Response
    {
        if ($this->planService === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Plan allowances are not available'], 503);
        }
        return $this->jsonResponse($response, ['allowances' => $this->planService->listAllowances()]);
    }

    /**
     * PUT /api/admin/allowances {plan, metric, monthlyValue, enabled} — upsert one row.
     * monthlyValue -1 = unlimited; enabled=false = the metric is off for that plan.
     * Enforcement still rides the global planEnforced gate; this only edits the caps.
     */
    public function putAllowance(Request $request, Response $response): Response
    {
        if ($this->planService === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Plan allowances are not available'], 503);
        }
        $body = $request->getParsedBody() ?? [];
        if (!is_array($body)) {
            $body = [];
        }
        $plan = is_string($body['plan'] ?? null) ? trim((string) $body['plan']) : '';
        $metric = is_string($body['metric'] ?? null) ? trim((string) $body['metric']) : '';
        $monthlyValue = filter_var($body['monthlyValue'] ?? null, FILTER_VALIDATE_INT);
        $enabled = ($body['enabled'] ?? null) === true;
        if ($plan === '' || $metric === '' || $monthlyValue === false || $monthlyValue === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'plan, metric and an integer monthlyValue are required'], 400);
        }
        try {
            $this->planService->setAllowance($plan, $metric, (int) $monthlyValue, $enabled);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
        $this->audit($request, 'admin.allowance_update', $plan . '/' . $metric, [
            'plan' => $plan,
            'metric' => $metric,
            'monthlyValue' => (int) $monthlyValue,
            'enabled' => $enabled,
        ]);
        return $this->jsonResponse($response, [
            'success' => true,
            'allowance' => ['plan' => $plan, 'metric' => $metric, 'monthlyValue' => (int) $monthlyValue, 'enabled' => $enabled],
        ]);
    }

    /**
     * POST /api/admin/users/{id}/delete — permanently erase an account and ALL
     * its data (apps, forms incl. per-form databases + uploads, recycle bin),
     * through the same truthful/resumable engine as self-service deletion.
     * HEAVILY gated: admin-only route, never yourself, never the demo account,
     * never another administrator (revoke their admin flag first), and the
     * request must carry the target's EXACT email as confirmation.
     */
    public function deleteUser(Request $request, Response $response, array $args): Response
    {
        if ($this->erasure === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Account erasure is not available'], 503);
        }
        $target = $this->accountTarget($response, (string) $args['id']);
        if ($target instanceof Response) {
            return $target;
        }
        if ($target['id'] === (string) $request->getAttribute('userId')) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'You cannot delete your own account from the admin panel — use Settings'], 400);
        }
        if (!empty($target['is_admin'])) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'This user is an administrator — remove their admin access first'], 400);
        }
        $confirm = trim((string) (($request->getParsedBody() ?? [])['confirmEmail'] ?? ''));
        if ($confirm === '' || strcasecmp($confirm, (string) $target['email']) !== 0) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Type the account\'s email address exactly to confirm deletion'], 400);
        }

        $result = $this->erasure->erase($target['id']);
        if (!$result['completed']) {
            $this->audit($request, 'admin.user_delete_incomplete', $target['id'], ['email' => $target['email']] + $result);
            return $this->jsonResponse($response, [
                'error' => true,
                'status' => 'failed',
                'retryable' => true,
                'failedApps' => $result['failedApps'],
                'failedForms' => $result['failedForms'],
                'pendingCleanup' => $result['pendingCleanup'],
                'pendingTrash' => $result['pendingTrash'],
                'message' => 'Some of the account\'s data could not be deleted, so it was NOT closed. Nothing is lost — retry to resume where it left off.',
            ], 503);
        }
        $this->audit($request, 'admin.user_delete', $target['id'], ['email' => $target['email']]);
        return $this->jsonResponse($response, ['status' => 'completed', 'message' => 'The account and all its data have been deleted.']);
    }

    /**
     * GET /api/admin/users/{id}/backup-manifest — the user's full SCHEMA (forms
     * incl. fields/settings, apps, flows) plus the sqlite/uploads file PATHS
     * and sizes per form, so an operator with server access can match data up
     * manually. Never the sqlite contents, answers, or uploaded files — the
     * admin panel lists, it does not export data.
     */
    public function backupManifest(Request $request, Response $response, array $args): Response
    {
        if ($this->backup === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Backups are not configured'], 500);
        }
        $manifest = $this->backup->adminBackupManifest((string) $args['id']);
        if ($manifest === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'User not found'], 404);
        }
        $this->audit($request, 'admin.backup_manifest', (string) $args['id']);
        return $this->jsonResponse($response, ['manifest' => $manifest]);
    }

    // ── Scheduled backups (nightly cron; structure/summaries only) ──────────

    /** GET /api/admin/backups — the retained day-folders + heartbeat. */
    public function listScheduledBackups(Request $request, Response $response): Response
    {
        if ($this->scheduledBackup === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Scheduled backups are not configured'], 500);
        }
        return $this->jsonResponse($response, [
            'runs' => $this->scheduledBackup->listRuns(),
        ] + $this->scheduledBackup->lastRun());
    }

    /** POST /api/admin/backups/run — run a backup pass now (same as the cron). */
    public function runScheduledBackup(Request $request, Response $response): Response
    {
        if ($this->scheduledBackup === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Scheduled backups are not configured'], 500);
        }
        @set_time_limit(600);
        try {
            $summary = $this->scheduledBackup->run();
        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 500);
        }
        $this->audit($request, 'admin.scheduled_backup_run', null, [
            'date' => $summary['date'], 'ok' => $summary['ok'], 'failed' => $summary['failed'],
        ]);
        return $this->jsonResponse($response, ['summary' => $summary]);
    }

    /**
     * POST /api/admin/backups/restore {userId, date} — restore ONE account from a
     * scheduled backup INTO that user's account (new copies, never overwrites;
     * the same import pipeline as Settings → Restore). The admin only receives
     * the structure summary — never record data.
     */
    public function restoreScheduledBackup(Request $request, Response $response): Response
    {
        if ($this->scheduledBackup === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Scheduled backups are not configured'], 500);
        }
        $body = $request->getParsedBody() ?? [];
        $userId = (string) ($body['userId'] ?? '');
        $date = (string) ($body['date'] ?? '');
        if ($userId === '' || $date === '') {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'userId and date are required'], 400);
        }
        $target = $this->auth->getUserById($userId);
        if ($target === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'User not found'], 404);
        }
        $demoEmail = strtolower((string) ($_ENV['DEMO_EMAIL'] ?? 'demo@formlogic.local'));
        if (strtolower($target->email) === $demoEmail) {
            return $this->jsonResponse($response, ['error' => true, 'code' => 'demo_readonly', 'message' => 'The shared demo account is provisioning-managed.'], 403);
        }
        @set_time_limit(600);
        try {
            $summary = $this->scheduledBackup->restoreAccount($date, $userId);
        } catch (\InvalidArgumentException | \RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
        $this->audit($request, 'admin.backup_restore', $userId, [
            'date' => $date,
            'apps' => count($summary['apps']),
            'forms' => count($summary['forms']),
            'responses' => $summary['responses'],
        ]);
        return $this->jsonResponse($response, $summary);
    }

    // ── Structure views (counts, never records) ─────────────────────────────

    public function getFormStructure(Request $request, Response $response, array $args): Response
    {
        $form = $this->forms->getForm((string) $args['id']);
        if (!$form) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found'], 404);
        }
        // Structure + usage count only. The one thing an admin never gets here
        // is the response DATA itself.
        $form['responseCount'] = $this->safeResponseCount((string) $args['id']);
        return $this->jsonResponse($response, ['form' => $form, 'ownerId' => $form['userId'] ?? null]);
    }

    public function updateForm(Request $request, Response $response, array $args): Response
    {
        $formId = (string) $args['id'];
        $form = $this->forms->getForm($formId);
        if (!$form) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Form not found'], 404);
        }
        $body = $request->getParsedBody() ?? [];
        $input = [];
        foreach (['title', 'description', 'status', 'logicScript', 'settings', 'theme', 'fields'] as $k) {
            if (array_key_exists($k, $body)) {
                $input[$k] = $body[$k];
            }
        }
        if ($input === []) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Nothing to update'], 400);
        }
        // Same shape/size caps the owner-facing write paths enforce.
        if (isset($input['title']) && (!is_string($input['title']) || strlen($input['title']) > 500)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'title must be a string up to 500 characters'], 400);
        }
        if (isset($input['status']) && !in_array($input['status'], ['draft', 'published', 'archived'], true)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'status must be draft, published or archived'], 400);
        }
        if (isset($input['logicScript']) && (!is_string($input['logicScript']) || strlen($input['logicScript']) > 102400)) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'logicScript must be a string up to 100KB'], 400);
        }
        if (isset($input['fields'])) {
            if (!is_array($input['fields']) || count($input['fields']) > 200) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'fields must be an array of at most 200 items'], 400);
            }
            foreach ($input['fields'] as $i => $f) {
                if (!is_array($f) || !isset($f['type'])) {
                    return $this->jsonResponse($response, ['error' => true, 'message' => "field at index {$i} is malformed (must be an object with a type)"], 400);
                }
            }
            if (strlen((string) json_encode($input['fields'])) > 512000) {
                return $this->jsonResponse($response, ['error' => true, 'message' => 'fields exceed the 500KB limit'], 400);
            }
        }
        foreach (['settings', 'theme'] as $k) {
            if (isset($input[$k]) && !is_array($input[$k])) {
                return $this->jsonResponse($response, ['error' => true, 'message' => "{$k} must be an object"], 400);
            }
        }

        try {
            $updated = $this->forms->updateForm($formId, $input);
        } catch (\InvalidArgumentException | \RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
        $this->audit($request, 'admin.update_form', $formId, ['ownerId' => $form['userId'] ?? null, 'keys' => array_keys($input)]);
        return $this->jsonResponse($response, ['form' => $updated]);
    }

    public function getAppStructure(Request $request, Response $response, array $args): Response
    {
        $app = $this->apps->getApp((string) $args['id']);
        if (!$app) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found'], 404);
        }
        $forms = array_map(fn (array $f) => [
            'formId' => $f['formId'],
            'displayName' => $f['displayName'] ?? null,
            'formStatus' => $f['formStatus'] ?? null,
            'responseCount' => $this->safeResponseCount((string) $f['formId']),
        ], $this->apps->getAppForms((string) $args['id']));
        return $this->jsonResponse($response, [
            'app' => $app,
            'ownerId' => $app['ownerId'] ?? null,
            'forms' => $forms,
            'flows' => $this->flows->listFlows((string) $args['id']),
            'bindings' => $this->flows->listBindings((string) $args['id']),
        ]);
    }

    public function updateApp(Request $request, Response $response, array $args): Response
    {
        $appId = (string) $args['id'];
        $app = $this->apps->getApp($appId);
        if (!$app) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'App not found'], 404);
        }
        $body = $request->getParsedBody() ?? [];
        $upd = [];
        foreach (['name', 'description', 'slug', 'status'] as $k) {
            if (array_key_exists($k, $body)) {
                $upd[$k] = $body[$k];
            }
        }
        if ($upd === []) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Nothing to update (name, description, slug, status)'], 400);
        }
        try {
            $updated = $this->apps->updateApp($appId, $upd);
        } catch (\InvalidArgumentException | \RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
        $this->audit($request, 'admin.update_app', $appId, ['ownerId' => $app['ownerId'] ?? null, 'keys' => array_keys($upd)]);
        return $this->jsonResponse($response, ['app' => $updated]);
    }

    public function getFlowStructure(Request $request, Response $response, array $args): Response
    {
        $flowId = (string) $args['id'];
        $appId = $this->admin->flowAppId($flowId);
        $owner = $this->admin->resourceOwner('flow_definitions', $flowId);
        if ($owner === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Flow not found'], 404);
        }
        $flow = $appId !== null
            ? $this->flows->getFlow($appId, $flowId)
            : $this->flows->getWorkspaceFlow($owner, $flowId);
        if (!$flow) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Flow not found'], 404);
        }
        return $this->jsonResponse($response, ['flow' => $flow, 'ownerId' => $owner]);
    }

    public function updateFlow(Request $request, Response $response, array $args): Response
    {
        $flowId = (string) $args['id'];
        $appId = $this->admin->flowAppId($flowId);
        $owner = $this->admin->resourceOwner('flow_definitions', $flowId);
        if ($owner === null) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Flow not found'], 404);
        }
        $body = $request->getParsedBody() ?? [];
        $input = [];
        foreach (['name', 'slug', 'description', 'flowJson', 'nodeCapabilities', 'enabled'] as $k) {
            if (array_key_exists($k, $body)) {
                $input[$k] = $body[$k];
            }
        }
        if ($input === []) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Nothing to update'], 400);
        }
        try {
            $flow = $appId !== null
                ? $this->flows->updateFlow($appId, $flowId, $input)
                : $this->flows->updateWorkspaceFlow($owner, $flowId, $input);
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
        if (!$flow) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Flow not found'], 404);
        }
        $this->audit($request, 'admin.update_flow', $flowId, ['ownerId' => $owner, 'keys' => array_keys($input)]);
        return $this->jsonResponse($response, ['flow' => $flow]);
    }

    // ── Maintenance + sessions + notices ─────────────────────────────────────

    public function getMaintenance(Request $request, Response $response): Response
    {
        return $this->jsonResponse($response, [
            'maintenance' => $this->maintenance->status(),
            'onlineUsers' => $this->admin->onlineUserCount(),
        ]);
    }

    public function setMaintenance(Request $request, Response $response): Response
    {
        $body = $request->getParsedBody() ?? [];
        $enabled = ($body['enabled'] ?? null) === true;
        $message = is_string($body['message'] ?? null) ? $body['message'] : '';
        $userId = (string) $request->getAttribute('userId');
        try {
            $status = $enabled
                ? $this->maintenance->enable($message, $userId)
                : $this->maintenance->disable($userId);
        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 500);
        }
        $this->audit($request, $enabled ? 'admin.maintenance_on' : 'admin.maintenance_off', null, ['message' => $status['message']]);
        return $this->jsonResponse($response, ['maintenance' => $status]);
    }

    /** Sign every non-admin user out everywhere (global session epoch bump). */
    public function bootSessions(Request $request, Response $response): Response
    {
        $epoch = $this->auth->bootAllSessions();
        $this->audit($request, 'admin.boot_sessions', null, ['epoch' => $epoch]);
        return $this->jsonResponse($response, ['success' => true, 'epoch' => $epoch]);
    }

    public function listNotices(Request $request, Response $response): Response
    {
        return $this->jsonResponse($response, ['notices' => $this->admin->listNotices()]);
    }

    public function createNotice(Request $request, Response $response): Response
    {
        $body = $request->getParsedBody() ?? [];
        try {
            $notice = $this->admin->createNotice(
                (string) ($body['message'] ?? ''),
                (string) ($body['level'] ?? 'info'),
                (string) ($body['audience'] ?? 'online'),
                (string) $request->getAttribute('userId'),
                isset($body['expiresMinutes']) ? (int) $body['expiresMinutes'] : null
            );
        } catch (\InvalidArgumentException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
        $this->audit($request, 'admin.notice_create', $notice['id'] ?? null, ['audience' => $notice['audience'] ?? null]);
        return $this->jsonResponse($response, ['notice' => $notice], 201);
    }

    public function revokeNotice(Request $request, Response $response, array $args): Response
    {
        $ok = $this->admin->revokeNotice((string) $args['id']);
        if ($ok) {
            $this->audit($request, 'admin.notice_revoke', (string) $args['id']);
        }
        return $this->jsonResponse($response, ['success' => $ok]);
    }

    // ── Upgrades ─────────────────────────────────────────────────────────────

    public function upgradeStatus(Request $request, Response $response): Response
    {
        return $this->jsonResponse($response, $this->upgrade->status());
    }

    public function upgradeUpload(Request $request, Response $response): Response
    {
        $files = $request->getUploadedFiles();
        $file = $files['package'] ?? null;
        if ($file === null || $file->getError() !== UPLOAD_ERR_OK) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Upload a release zip as the "package" field (check post_max_size/upload_max_filesize if a large file vanished)'], 400);
        }
        $dir = $this->upgrade->uploadsDir();
        if (!is_dir($dir)) {
            @mkdir($dir, 0750, true);
        }
        $zipPath = $dir . '/package.zip';
        try {
            $file->moveTo($zipPath);
            $info = $this->upgrade->stageUploadedPackage($zipPath);
        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        } finally {
            @unlink($zipPath);
        }
        $this->audit($request, 'admin.upgrade_upload', null, ['version' => $info['version'], 'integrity' => $info['integrity']]);
        return $this->jsonResponse($response, ['staged' => $info]);
    }

    public function upgradeApply(Request $request, Response $response): Response
    {
        $body = $request->getParsedBody() ?? [];
        if (($body['confirm'] ?? null) !== true) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Send confirm: true to apply the staged upgrade'], 400);
        }
        try {
            $result = $this->upgrade->apply(
                (string) $request->getAttribute('userId'),
                ($body['keepMaintenanceOn'] ?? null) === true
            );
        } catch (\RuntimeException $e) {
            $this->audit($request, 'admin.upgrade_failed', null, ['error' => mb_substr($e->getMessage(), 0, 300)]);
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 500);
        }
        $this->audit($request, 'admin.upgrade_apply', null, [
            'from' => $result['fromVersion'], 'to' => $result['toVersion'], 'backupId' => $result['backupId'],
        ]);
        return $this->jsonResponse($response, $result);
    }

    public function upgradeRollback(Request $request, Response $response): Response
    {
        $body = $request->getParsedBody() ?? [];
        $backupId = (string) ($body['backupId'] ?? '');
        if ($backupId === '' || ($body['confirm'] ?? null) !== true) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Send backupId and confirm: true'], 400);
        }
        try {
            $result = $this->upgrade->rollback($backupId, (string) $request->getAttribute('userId'));
        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
        $this->audit($request, 'admin.upgrade_rollback', null, ['backupId' => $backupId]);
        return $this->jsonResponse($response, $result);
    }

    public function upgradeRestoreDb(Request $request, Response $response): Response
    {
        $body = $request->getParsedBody() ?? [];
        try {
            $result = $this->upgrade->restoreDatabase(
                (string) ($body['backupId'] ?? ''),
                (string) ($body['confirm'] ?? ''),
                (string) $request->getAttribute('userId')
            );
        } catch (\RuntimeException $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => $e->getMessage()], 400);
        }
        $this->audit($request, 'admin.restore_database', null, ['backupId' => (string) ($body['backupId'] ?? '')]);
        return $this->jsonResponse($response, $result);
    }

    public function upgradeExportDb(Request $request, Response $response): Response
    {
        try {
            $result = $this->upgrade->exportDatabaseBackup((string) $request->getAttribute('userId'));
        } catch (\Throwable $e) {
            return $this->jsonResponse($response, ['error' => true, 'message' => 'Database export failed: ' . $e->getMessage()], 500);
        }
        $this->audit($request, 'admin.db_export', null, ['backupId' => $result['backupId']]);
        return $this->jsonResponse($response, $result);
    }

    public function upgradeDiscard(Request $request, Response $response): Response
    {
        $this->upgrade->discardStagedPackage();
        return $this->jsonResponse($response, ['success' => true]);
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    private function safeResponseCount(string $formId): ?int
    {
        try {
            return $this->responses->getResponseCount($formId);
        } catch (\Throwable) {
            return null; // per-form store unreadable — count is informational
        }
    }

    private function audit(Request $request, string $action, ?string $resourceId = null, array $details = []): void
    {
        try {
            $sp = $request->getServerParams();
            $this->auditService?->log($action, 'admin', $resourceId, $request->getAttribute('userId'), $sp['REMOTE_ADDR'] ?? null, $details);
        } catch (\Throwable) {
            // audit is best-effort
        }
    }
}

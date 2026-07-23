<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * Shared build/read tool handlers (plan Phase 6 §5.4) — the MCP tool implementations
 * extracted MECHANICALLY from McpController::callTool so two surfaces run the same code:
 *
 *   - MCP (McpController): delegates every non-transport tool here, threading its token
 *     session through a ChatToolsContext (scope closure throws McpDeniedException, audits
 *     land as 'mcp.<action>', creator-token bookkeeping rides recordCreated). Behavior is
 *     deliberately identical to the pre-extraction controller — same checks, same order,
 *     same messages.
 *   - Site chat (ChatToolsController::execute + AIController's hosted tool loop): calls
 *     callChatTool(), which restricts to the v1 CHAT_TOOL_NAMES subset and adds the
 *     non-destructive update_form guard, then runs the same handlers as the granting/
 *     session user (account-wide: no app scoping, no creator mode).
 *
 * Denials (scope/ownership/policy) throw ChatToolDeniedException with a stable reason
 * code; ordinary input-validation failures throw plain \Exception with a user-safe
 * message (the long-standing MCP convention both surfaces rely on).
 *
 * The transport-specific MCP tools (get_started, desktop_status, connector_command) stay
 * in McpController — they are about the MCP session/relay, not the account's content.
 */
class ChatToolsService
{
    // Which scope each tool requires (a token without it can't see or call the tool).
    // Includes the McpController-resident transport tools so the scope model has one home.
    public const TOOL_SCOPES = [
        'list_forms' => 'forms:read', 'get_form' => 'forms:read',
        'create_form' => 'forms:write', 'update_form' => 'forms:write', 'create_app_form' => 'forms:write',
        'list_apps' => 'apps:read', 'create_app' => 'apps:write',
        'update_app' => 'apps:write', 'add_form_to_app' => 'apps:write',
        'create_report' => 'apps:write', 'create_document' => 'apps:write',
        'set_app_home' => 'screens:write', 'set_form_screen' => 'screens:write',
        'list_responses' => 'responses:read',
        // Flows are app configuration, so they ride the apps scopes: any builder token that can
        // shape an app can automate it too (no scope migration for existing tokens).
        'list_flows' => 'apps:read', 'get_flow' => 'apps:read',
        'create_flow' => 'apps:write', 'update_flow' => 'apps:write', 'delete_flow' => 'apps:write',
        'blueprint_propose_elements' => 'apps:write',
        'list_blueprints' => 'apps:read', 'get_blueprint' => 'apps:read',
        'list_flow_bindings' => 'apps:read', 'create_flow_binding' => 'apps:write',
        'update_flow_binding' => 'apps:write', 'delete_flow_binding' => 'apps:write',
        // Record writes are an explicit opt-in scope (never in DEFAULT_SCOPES) and run the SAME
        // pipeline as the external API: sanitize → normalize → calc → validate → onSubmit script.
        'add_response' => 'responses:write', 'update_response' => 'responses:write',
        'delete_response' => 'responses:write',
        'connector_command' => 'connector:command', 'desktop_status' => 'connector:command',
    ];

    /** The v1 chat tool subset (plan §5.4): additive/read + guarded writes, exactly these ten. */
    public const CHAT_TOOL_NAMES = [
        'list_apps', 'list_forms', 'get_form', 'create_app', 'create_app_form',
        'create_form', 'update_form', 'add_form_to_app', 'create_flow', 'list_responses',
        // §25 step 8: the Copilot's Blueprint proposals ride the typed operation gateway
        // (validate-preview first, user-approved commit second — origin 'copilot').
        'blueprint_propose_elements',
        // Diagram read access: the AI must SEE a diagram (elements + semanticRevision)
        // before proposing changes to it, and find the right one by name.
        'list_blueprints', 'get_blueprint',
        // Custom screens (2026-07-23): the chat is THE AI surface for screen authoring —
        // set_form_screen / set_app_home write sandboxed screen projects for forms/apps,
        // and update_app lets the chat publish/rename/hideNav the app it just built
        // (archiving refused by callChatTool, mirroring the update_form guard).
        'set_form_screen', 'set_app_home', 'update_app',
    ];

    public function __construct(
        private FormService $formService,
        private AppService $appService,
        private ResponseService $responseService,
        private ?AppReportService $reportValidator = null,
        private ?PlanService $planService = null,
        private ?FlowService $flowService = null,
        private ?TrashService $trashService = null,
        private ?BlueprintService $blueprintService = null,
    ) {}

    // ── Chat-surface entry (subset-restricted) ──────────────────────────────────────────

    /**
     * Run one tool for the CHAT surface: only the v1 subset exists here, and update_form is
     * non-destructive (archiving refused with a typed denial — noted in the catalog too).
     * Everything else behaves exactly like the shared handler.
     *
     * @throws ChatToolDeniedException reason 'unknown_tool' | 'archive_refused' | ownership/policy denials
     * @throws \Exception user-safe validation failures
     */
    public function callChatTool(string $name, array $args, ChatToolsContext $ctx): mixed
    {
        if (!in_array($name, self::CHAT_TOOL_NAMES, true)) {
            throw new ChatToolDeniedException("Unknown chat tool: {$name}", 'unknown_tool');
        }
        if ($name === 'update_form' && (($args['status'] ?? null) === 'archived')) {
            throw new ChatToolDeniedException(
                "Archiving a form is not available from chat — unpublish with status:'draft' instead, or archive it in the form builder.",
                'archive_refused'
            );
        }
        if ($name === 'update_app' && (($args['status'] ?? null) === 'archived')) {
            throw new ChatToolDeniedException(
                "Archiving an app is not available from chat — unpublish with status:'draft' instead, or archive it from the app's settings.",
                'archive_refused'
            );
        }
        return $this->call($name, $args, $ctx);
    }

    // ── Shared handler switch (moved verbatim from McpController::callTool) ─────────────

    /**
     * Execute a tool as $ctx->userId, under the context's scope model + app confinement.
     * Returns the tool's result data; throws ChatToolDeniedException on denials and plain
     * \Exception on validation failures (both user-safe).
     */
    public function call(string $name, array $args, ChatToolsContext $ctx): mixed
    {
        $userId = $ctx->userId;
        $scopedApp = $ctx->scopedAppId;
        $creatorMode = $ctx->creatorMode;
        $ctx->requireScope(self::TOOL_SCOPES[$name] ?? '__none__');
        // Cloud entitlement (audit FL-003/C-10): mutating tools require an ACTIVE
        // cloud account, the SAME policy as every web/API write path — the count
        // quota alone let a lapsed account keep building through MCP. Read tools
        // stay available (mirrors CloudWriteGate's read/export/delete allowance).
        $toolScope = self::TOOL_SCOPES[$name] ?? '';
        if (
            (str_ends_with($toolScope, ':write') || $toolScope === 'connector:command')
            && $this->planService !== null
            && $this->planService->isEnforced()
            && !$this->planService->isCloudActive($userId)
        ) {
            throw new ChatToolDeniedException('Cloud access for this account has lapsed — renew to make changes', 'cloud_lapsed');
        }
        switch ($name) {
            case 'list_forms':
                if ($scopedApp !== null) {
                    $data = array_map(static fn ($f) => ['id' => $f['formId'], 'title' => $f['displayName'], 'status' => $f['formStatus'] ?? 'draft'], $this->appService->getAppForms($scopedApp));
                } else {
                    $forms = $this->formService->getAllForms($userId);
                    if ($creatorMode) {
                        $allowed = $this->creatorFormIds($ctx);
                        $forms = array_values(array_filter($forms, static fn ($f) => isset($allowed[$f['id']])));
                    }
                    $data = array_map(static fn ($f) => ['id' => $f['id'], 'title' => $f['title'], 'status' => $f['status'] ?? 'draft', 'fieldCount' => $f['fieldCount'] ?? count($f['fields'] ?? [])], $forms);
                }
                break;
            case 'get_form':
                $this->assertFormInScope($ctx, (string) ($args['formId'] ?? ''));
                $data = $this->ownForm((string) ($args['formId'] ?? ''), $userId);
                break;
            case 'create_form':
                $this->checkFormQuota($userId);
                $this->validateFormInput($args);
                $data = $this->createFormSanitized($args, $userId);
                // App-scoped token: auto-attach the new form to the scoped app so it's usable + stays in scope.
                if ($scopedApp !== null && !empty($data['id'])) {
                    $this->appService->addFormToApp($scopedApp, (string) $data['id']);
                }
                // Creator token: remember the form so the token can keep editing it (and attach it later).
                if ($creatorMode && !empty($data['id'])) {
                    $ctx->recordCreated('forms', (string) $data['id']);
                }
                $ctx->audit('create_form', ['formId' => $data['id'] ?? null, 'appId' => $scopedApp]);
                break;
            case 'create_app_form': {
                // Create a form AND attach it to an app in one call (preferred for app building).
                $target = (string) ($args['appId'] ?? '');
                if ($target === '' && $scopedApp !== null) {
                    $target = $scopedApp;
                }
                if ($target === '' && $creatorMode && count($ctx->createdApps) === 1) {
                    $target = (string) $ctx->createdApps[0];
                }
                $ctx->requireScope('apps:write');
                $this->assertAppScope($ctx, $target);
                $this->ownApp($target, $userId);
                $this->checkFormQuota($userId);
                $this->validateFormInput($args);
                $form = $this->createFormSanitized($args, $userId);
                $this->appService->addFormToApp($target, (string) $form['id'], $args['displayName'] ?? null);
                if ($creatorMode && !empty($form['id'])) {
                    $ctx->recordCreated('forms', (string) $form['id']);
                }
                $data = ['form' => $form, 'appId' => $target];
                $ctx->audit('create_app_form', ['formId' => $form['id'] ?? null, 'appId' => $target]);
                break;
            }
            case 'update_form':
                $this->assertFormInScope($ctx, (string) ($args['formId'] ?? ''));
                $this->ownForm((string) ($args['formId'] ?? ''), $userId);
                $this->validateFormInput($args);
                $input = $this->formInput($args);
                if (is_array($input['customScreen'] ?? null)) {
                    $input['customScreen'] = $this->sanitizeSectionScreen($input['customScreen'], (string) $args['formId']);
                }
                $data = $this->formService->updateForm((string) $args['formId'], $input);
                $ctx->audit('update_form', ['formId' => $args['formId'] ?? null]);
                break;
            case 'list_apps':
                $apps = $this->appService->getAllApps($userId);
                if ($scopedApp !== null) {
                    $apps = array_values(array_filter($apps, static fn ($a) => $a['id'] === $scopedApp));
                } elseif ($creatorMode) {
                    $mine = $ctx->createdApps;
                    $apps = array_values(array_filter($apps, static fn ($a) => in_array($a['id'], $mine, true)));
                }
                $data = array_map(static fn ($a) => ['id' => $a['id'], 'name' => $a['name'], 'slug' => $a['slug'] ?? null, 'status' => $a['status'] ?? 'draft'], $apps);
                break;
            case 'create_app':
                if ($scopedApp !== null) {
                    throw new \Exception('This token is scoped to one app and cannot create new apps');
                }
                $input = ['name' => (string) ($args['name'] ?? 'Untitled App'), 'description' => $args['description'] ?? null];
                // Optional settings.appKind audience tag. The service would silently drop an invalid
                // value; over MCP a clear error is more useful to the AI, so validate here.
                if (isset($args['appKind'])) {
                    if (!is_string($args['appKind']) || !in_array($args['appKind'], AppService::APP_KINDS, true)) {
                        throw new \Exception('appKind must be one of: ' . implode(', ', AppService::APP_KINDS));
                    }
                    $input['appKind'] = $args['appKind'];
                }
                $data = $this->appService->createApp($input, $userId);
                // Creator token: confine future access to this newly-created app.
                if ($creatorMode && !empty($data['id'])) {
                    $ctx->recordCreated('apps', (string) $data['id']);
                }
                $ctx->audit('create_app', ['appId' => $data['id'] ?? null]);
                break;
            case 'update_app':
                $this->assertAppScope($ctx, (string) ($args['appId'] ?? ''));
                $app = $this->ownApp((string) ($args['appId'] ?? ''), $userId);
                $upd = [];
                foreach (['name', 'description', 'status', 'slug'] as $k) {
                    if (array_key_exists($k, $args)) {
                        $upd[$k] = $args[$k];
                    }
                }
                if (array_key_exists('hideNav', $args)) {
                    $settings = is_array($app['settings'] ?? null) ? $app['settings'] : [];
                    $settings['hideNav'] = (bool) $args['hideNav'];
                    $upd['settings'] = $settings;
                }
                if (array_key_exists('customLogic', $args) && is_array($args['customLogic'])) {
                    $bundle = \FormLogic\Helpers\CustomLogicSanitizer::sanitize($args['customLogic']);
                    if (!\FormLogic\Helpers\CustomLogicSanitizer::withinSizeCap($bundle)) {
                        throw new \Exception('customLogic exceeds the 256KB limit');
                    }
                    $upd['customLogic'] = $bundle;
                }
                $data = $this->appService->updateApp((string) $args['appId'], $upd);
                $ctx->audit('update_app', ['appId' => $args['appId'] ?? null]);
                break;
            case 'add_form_to_app':
                $this->assertAppScope($ctx, (string) ($args['appId'] ?? ''));
                $this->ownApp((string) ($args['appId'] ?? ''), $userId);
                $this->ownForm((string) ($args['formId'] ?? ''), $userId);
                $data = $this->appService->addFormToApp((string) $args['appId'], (string) $args['formId'], $args['displayName'] ?? null);
                $ctx->audit('add_form_to_app', ['appId' => $args['appId'] ?? null, 'formId' => $args['formId'] ?? null]);
                break;
            case 'set_app_home':
                $this->assertAppScope($ctx, (string) ($args['appId'] ?? ''));
                $this->ownApp((string) ($args['appId'] ?? ''), $userId);
                $cs = is_array($args['customScreen'] ?? null) ? $args['customScreen'] : [];
                $this->validateCustomScreen($cs);
                // A widget dashboard is data, not code — sanitize its specs against this app so no
                // widget can query a form/field outside it (the same save boundary as the UI's
                // AppController::update path).
                if (($cs['kind'] ?? '') === 'dashboard' && is_array($cs['dashboard'] ?? null) && $this->reportValidator !== null) {
                    $cs['dashboard'] = $this->reportValidator->sanitizeDashboardForApp($cs['dashboard'], (string) $args['appId']);
                }
                $data = $this->appService->updateApp((string) $args['appId'], ['customScreen' => $cs]);
                $ctx->audit('set_app_home', ['appId' => $args['appId'] ?? null]);
                break;
            case 'set_form_screen':
                // The form-side twin of set_app_home: replace the form's whole customScreen.
                // Same save boundary as update_form's customScreen path — a widget dashboard
                // is sanitized against the form's own fields before it persists.
                $this->assertFormInScope($ctx, (string) ($args['formId'] ?? ''));
                $this->ownForm((string) ($args['formId'] ?? ''), $userId);
                $cs = is_array($args['customScreen'] ?? null) ? $args['customScreen'] : [];
                $this->validateCustomScreen($cs);
                $data = $this->formService->updateForm((string) $args['formId'], [
                    'customScreen' => $this->sanitizeSectionScreen($cs, (string) $args['formId']),
                ]);
                $ctx->audit('set_form_screen', ['formId' => $args['formId'] ?? null]);
                break;
            case 'create_report': {
                // Add a chart report to the app's Reports section. Spec uses REAL form ids.
                $appId = (string) ($args['appId'] ?? '');
                $this->assertAppScope($ctx, $appId);
                $app = $this->ownApp($appId, $userId);
                $spec = is_array($args['spec'] ?? null) ? $args['spec'] : [];
                if (empty($spec['formId']) || !is_string($spec['formId'])) {
                    throw new \Exception('spec.formId is required (a form id in this app)');
                }
                if (!in_array($spec['viz'] ?? 'bar', ['table', 'bar', 'line', 'area', 'pie', 'donut', 'kpi'], true)) {
                    throw new \Exception('spec.viz must be one of: table, bar, line, area, pie, donut, kpi');
                }
                // Validate the spec against the app: base form must belong to it; joins/field-refs are
                // checked + sanitized (foreign form / bad field refs are rejected, not stored).
                if ($this->reportValidator !== null) {
                    $v = $this->reportValidator->validateChartSpec($spec, $appId);
                    if (!$v['ok']) { throw new \Exception($v['error'] ?? 'Invalid report spec'); }
                    $spec = $v['spec'];
                }
                $item = ['id' => 'rep_' . bin2hex(random_bytes(6)), 'name' => (string) ($args['name'] ?? 'Report'), 'type' => 'builder', 'spec' => $spec];
                if (!empty($args['description'])) { $item['description'] = (string) $args['description']; }
                $reports = is_array($app['reports'] ?? null) ? $app['reports'] : [];
                $reports[] = $item;
                if (strlen((string) json_encode($reports)) > 262144) { throw new \Exception('Reports exceed the 256KB limit'); }
                $this->appService->updateApp($appId, ['reports' => $reports]);
                $data = $item;
                $ctx->audit('create_report', ['appId' => $appId, 'reportId' => $item['id']]);
                break;
            }
            case 'create_document': {
                // Add a PDF document (text + chart blocks referencing existing reports) to the app.
                $appId = (string) ($args['appId'] ?? '');
                $this->assertAppScope($ctx, $appId);
                $app = $this->ownApp($appId, $userId);
                $reports = is_array($app['reports'] ?? null) ? $app['reports'] : [];
                $existingIds = [];
                foreach ($reports as $r) { if (!empty($r['id'])) { $existingIds[(string) $r['id']] = true; } }
                $blocks = [];
                foreach ((is_array($args['blocks'] ?? null) ? $args['blocks'] : []) as $b) {
                    $kind = $b['kind'] ?? '';
                    if ($kind === 'text') {
                        $blocks[] = ['id' => 'blk_' . bin2hex(random_bytes(5)), 'kind' => 'text', 'title' => $b['title'] ?? null, 'body' => (string) ($b['body'] ?? '')];
                    } elseif ($kind === 'report') {
                        $rid = (string) ($b['reportId'] ?? '');
                        if (!isset($existingIds[$rid])) { throw new \Exception("Document references unknown reportId '{$rid}' — create the chart report first"); }
                        $blocks[] = ['id' => 'blk_' . bin2hex(random_bytes(5)), 'kind' => 'report', 'reportId' => $rid, 'caption' => $b['caption'] ?? null];
                    }
                }
                if (!$blocks) { throw new \Exception('A document needs at least one block (text or report)'); }
                $item = ['id' => 'doc_' . bin2hex(random_bytes(6)), 'name' => (string) ($args['name'] ?? 'Document'), 'type' => 'document', 'blocks' => $blocks];
                if (!empty($args['description'])) { $item['description'] = (string) $args['description']; }
                $reports[] = $item;
                // Defense-in-depth: sanitize the whole set against the app (drops broken refs, clamps text).
                if ($this->reportValidator !== null) {
                    $reports = $this->reportValidator->sanitizeReports($reports, $appId);
                }
                if (strlen((string) json_encode($reports)) > 262144) { throw new \Exception('Reports exceed the 256KB limit'); }
                $this->appService->updateApp($appId, ['reports' => $reports]);
                $data = $item;
                $ctx->audit('create_document', ['appId' => $appId, 'documentId' => $item['id']]);
                break;
            }
            case 'list_flows': {
                $appId = $this->resolveAppId($args, $ctx);
                $this->assertAppScope($ctx, $appId);
                $this->ownApp($appId, $userId);
                // Summaries only — flowJson can be up to 256KB per flow; use get_flow for the graph.
                $data = array_map(static fn ($f) => [
                    'id' => $f['id'], 'name' => $f['name'], 'slug' => $f['slug'],
                    'description' => $f['description'], 'enabled' => $f['enabled'], 'version' => $f['version'],
                ], $this->flows()->listFlows($appId));
                break;
            }
            case 'get_flow': {
                $appId = $this->resolveAppId($args, $ctx);
                $this->assertAppScope($ctx, $appId);
                $this->ownApp($appId, $userId);
                $data = $this->flows()->getFlow($appId, (string) ($args['flowId'] ?? ''));
                if (!$data) {
                    throw new \Exception('Flow not found in this app');
                }
                break;
            }
            case 'list_blueprints': {
                $blueprints = $this->blueprintService
                    ?? throw new \InvalidArgumentException('Blueprints are unavailable in this context');
                $data = ['blueprints' => array_map(static fn (array $b): array => [
                    'blueprintId' => $b['id'],
                    'name' => $b['name'],
                    'appId' => $b['appId'],
                    'semanticRevision' => $b['semanticRevision'],
                    'updatedAt' => $b['updatedAt'],
                ], $blueprints->listBlueprints($userId))];
                break;
            }
            case 'get_blueprint': {
                $blueprints = $this->blueprintService
                    ?? throw new \InvalidArgumentException('Blueprints are unavailable in this context');
                $blueprintId = is_string($args['blueprintId'] ?? null) ? trim((string) $args['blueprintId']) : '';
                if ($blueprintId === '') {
                    throw new \InvalidArgumentException('blueprintId is required');
                }
                $data = $blueprints->getBlueprint($userId, $blueprintId)
                    ?? throw new \Exception('Blueprint not found');
                break;
            }
            case 'blueprint_propose_elements': {
                // §25 step 8: ONE Copilot tool through the typed Blueprint gateway. The
                // model previews (commit=false → validate, writes nothing) and only a
                // user-approved re-call commits — with origin 'copilot' in the audit log.
                $blueprints = $this->blueprintService
                    ?? throw new \InvalidArgumentException('Blueprints are unavailable in this context');
                $blueprintId = is_string($args['blueprintId'] ?? null) ? trim((string) $args['blueprintId']) : '';
                if ($blueprintId === '' && is_string($args['createBlueprintName'] ?? null) && trim((string) $args['createBlueprintName']) !== '') {
                    $created = $blueprints->createBlueprint($userId, ['name' => trim((string) $args['createBlueprintName'])]);
                    $blueprintId = (string) $created['id'];
                }
                if ($blueprintId === '') {
                    throw new \InvalidArgumentException('Pass blueprintId (or createBlueprintName to start a new blueprint)');
                }
                $batch = [
                    'operations' => is_array($args['operations'] ?? null) ? $args['operations'] : [],
                    'origin' => 'copilot',
                ];
                if (array_key_exists('baseSemanticRevision', $args)) {
                    $batch['baseSemanticRevision'] = $args['baseSemanticRevision'];
                }
                $commit = ($args['commit'] ?? false) === true;
                if (!$commit && is_string($args['summary'] ?? null)) {
                    $batch['summary'] = $args['summary'];
                }
                try {
                    // §12: a non-commit call VALIDATES and PARKS the batch as a proposed
                    // change set — the diagram canvas renders it as ghosts with its own
                    // Apply/Discard, so approval can happen in chat OR on the canvas.
                    $result = $commit
                        ? $blueprints->commitOperations($userId, $blueprintId, $batch)
                        : $blueprints->proposeChangeSet($userId, $blueprintId, $batch);
                } catch (BlueprintRevisionConflictException $e) {
                    throw new \InvalidArgumentException(
                        "revision_conflict: the blueprint is at semanticRevision {$e->currentRevision} — re-read it and retry with that baseSemanticRevision"
                    );
                }
                $data = ['blueprintId' => $blueprintId, 'committed' => $commit] + $result;
                $ctx->audit('blueprint_propose_elements', ['blueprintId' => $blueprintId, 'committed' => $commit]);
                break;
            }
            case 'create_flow': {
                $appId = $this->resolveAppId($args, $ctx);
                $this->assertAppScope($ctx, $appId);
                $this->ownApp($appId, $userId);
                $input = [];
                foreach (['name', 'slug', 'description', 'flowJson', 'enabled', 'inputSchema', 'nodeCapabilities'] as $k) {
                    if (array_key_exists($k, $args)) {
                        $input[$k] = $args[$k];
                    }
                }
                $data = $this->flows()->createFlow($appId, $userId, $input);
                $ctx->audit('create_flow', ['appId' => $appId, 'flowId' => $data['id'] ?? null]);
                break;
            }
            case 'update_flow': {
                $appId = $this->resolveAppId($args, $ctx);
                $this->assertAppScope($ctx, $appId);
                $this->ownApp($appId, $userId);
                $input = [];
                foreach (['name', 'slug', 'description', 'flowJson', 'enabled', 'inputSchema', 'nodeCapabilities'] as $k) {
                    if (array_key_exists($k, $args)) {
                        $input[$k] = $args[$k];
                    }
                }
                $data = $this->flows()->updateFlow($appId, (string) ($args['flowId'] ?? ''), $input);
                if (!$data) {
                    throw new \Exception('Flow not found in this app');
                }
                $ctx->audit('update_flow', ['appId' => $appId, 'flowId' => $args['flowId'] ?? null]);
                break;
            }
            case 'delete_flow': {
                $appId = $this->resolveAppId($args, $ctx);
                $this->assertAppScope($ctx, $appId);
                $this->ownApp($appId, $userId);
                // Recycle bin: snapshot before the hard delete (parity with the web surface).
                $flowDeleted = $this->trashService !== null
                    ? $this->trashService->trashFlow($appId, (string) ($args['flowId'] ?? ''), $userId)
                    : $this->flows()->deleteFlow($appId, (string) ($args['flowId'] ?? ''));
                if (!$flowDeleted) {
                    throw new \Exception('Flow not found in this app');
                }
                $data = ['deleted' => true, 'flowId' => (string) ($args['flowId'] ?? '')];
                $ctx->audit('delete_flow', ['appId' => $appId, 'flowId' => $args['flowId'] ?? null]);
                break;
            }
            case 'list_flow_bindings': {
                $appId = $this->resolveAppId($args, $ctx);
                $this->assertAppScope($ctx, $appId);
                $this->ownApp($appId, $userId);
                $data = $this->flows()->listBindings($appId);
                break;
            }
            case 'create_flow_binding': {
                $appId = $this->resolveAppId($args, $ctx);
                $this->assertAppScope($ctx, $appId);
                $this->ownApp($appId, $userId);
                $input = [];
                foreach (['flow', 'event', 'mode', 'formId', 'connectorId', 'condition', 'inputMap',
                          'outputActions', 'timeoutMs', 'retryPolicy', 'fallbackPolicy', 'enabled', 'sortOrder'] as $k) {
                    if (array_key_exists($k, $args)) {
                        $input[$k] = $args[$k];
                    }
                }
                if (!isset($input['mode'])) {
                    $input['mode'] = 'async'; // the forgiving default; sync/background/manual are opt-in
                }
                $data = $this->flows()->createBinding($appId, $input);
                $ctx->audit('create_flow_binding', ['appId' => $appId, 'bindingId' => $data['id'] ?? null, 'event' => $input['event'] ?? null]);
                break;
            }
            case 'update_flow_binding': {
                $appId = $this->resolveAppId($args, $ctx);
                $this->assertAppScope($ctx, $appId);
                $this->ownApp($appId, $userId);
                $input = [];
                foreach (['flow', 'event', 'mode', 'formId', 'connectorId', 'condition', 'inputMap',
                          'outputActions', 'timeoutMs', 'retryPolicy', 'fallbackPolicy', 'enabled', 'sortOrder'] as $k) {
                    if (array_key_exists($k, $args)) {
                        $input[$k] = $args[$k];
                    }
                }
                $data = $this->flows()->updateBinding($appId, (string) ($args['bindingId'] ?? ''), $input);
                if (!$data) {
                    throw new \Exception('Flow binding not found in this app');
                }
                $ctx->audit('update_flow_binding', ['appId' => $appId, 'bindingId' => $args['bindingId'] ?? null]);
                break;
            }
            case 'delete_flow_binding': {
                $appId = $this->resolveAppId($args, $ctx);
                $this->assertAppScope($ctx, $appId);
                $this->ownApp($appId, $userId);
                if (!$this->flows()->deleteBinding($appId, (string) ($args['bindingId'] ?? ''))) {
                    throw new \Exception('Flow binding not found in this app');
                }
                $data = ['deleted' => true, 'bindingId' => (string) ($args['bindingId'] ?? '')];
                $ctx->audit('delete_flow_binding', ['appId' => $appId, 'bindingId' => $args['bindingId'] ?? null]);
                break;
            }
            case 'list_responses':
                $this->assertFormInScope($ctx, (string) ($args['formId'] ?? ''));
                $this->ownForm((string) ($args['formId'] ?? ''), $userId);
                $this->assertNotPrivateForm((string) ($args['formId'] ?? ''));
                $data = $this->responseService->getFormResponses((string) $args['formId'], ['limit' => min(200, max(1, (int) ($args['limit'] ?? 50)))]);
                break;
            case 'add_response': {
                $formId = (string) ($args['formId'] ?? '');
                $this->assertFormInScope($ctx, $formId);
                $form = $this->ownForm($formId, $userId);
                $this->assertNotPrivateForm($formId);
                // Owner PROGRAMMATIC write (same stance as the external API): only an explicitly
                // archived form refuses; app-internal forms are typically 'draft' and must accept.
                if (($form['status'] ?? '') === 'archived') {
                    throw new \Exception('Form is archived and not accepting responses');
                }
                $settings = is_array($form['settings'] ?? null) ? $form['settings'] : [];
                if (!empty($settings['isClosed'])) {
                    throw new \Exception('This form is closed and not accepting responses');
                }
                if (!is_array($args['answers'] ?? null)) {
                    throw new \Exception('answers must be an object of field id → value');
                }
                $answers = $this->preparedAnswers($form, $args['answers']);
                // Atomic quota enforcement, mirroring the external API path (fail closed, retryable).
                $quotaLock = null;
                if (!empty($settings['quotaLimit'])) {
                    $quotaLock = $this->responseService->acquireFormLock($formId);
                    if ($quotaLock === null) {
                        throw new \Exception('The form is busy — please retry in a moment.');
                    }
                    if ($this->responseService->getResponseCount($formId) >= (int) $settings['quotaLimit']) {
                        $this->responseService->releaseFormLock($quotaLock);
                        throw new \Exception('This form has reached its maximum number of responses.');
                    }
                }
                try {
                    $result = $this->responseService->createResponse(
                        $formId,
                        ['answers' => $answers, 'ipAddress' => $ctx->ip, 'userAgent' => $ctx->userAgent],
                        $form['logicScript'] ?? null
                    );
                } finally {
                    $this->responseService->releaseFormLock($quotaLock);
                }
                if ($result instanceof ScriptRejection) {
                    throw new \Exception("Submission rejected by the form's onSubmit script: " . $result->message);
                }
                // {store:false} scripts persist nothing — no source row to link from.
                if (($result['stored'] ?? true) !== false) {
                    $this->responseService->syncResponseLinks($formId, (string) ($result['id'] ?? ''), $form['fields'] ?? [], $answers);
                }
                $data = $result;
                $ctx->audit('add_response', ['formId' => $formId, 'responseId' => $result['id'] ?? null]);
                break;
            }
            case 'update_response': {
                $formId = (string) ($args['formId'] ?? '');
                $responseId = (string) ($args['responseId'] ?? '');
                $this->assertFormInScope($ctx, $formId);
                $form = $this->ownForm($formId, $userId);
                $this->assertNotPrivateForm($formId);
                $existing = $responseId !== '' ? $this->responseService->getResponse($formId, $responseId) : null;
                if (!$existing) {
                    throw new \Exception('Response not found');
                }
                $upd = [];
                if (isset($args['answers']) && is_array($args['answers'])) {
                    // PATCH semantics: merge the patch over the STORED answers before validating,
                    // so a partial update isn't rejected for omitting an unrelated required field
                    // (mirrors the external API and AppPublicController::updateResponseById).
                    $existingAnswers = is_array($existing['answers'] ?? null) ? $existing['answers'] : [];
                    $upd['answers'] = $this->preparedAnswers($form, array_merge($existingAnswers, $args['answers']));
                }
                if (array_key_exists('status', $args)) {
                    $upd['status'] = $args['status'];
                }
                if ($upd === []) {
                    throw new \Exception('Nothing to update — provide answers (a partial patch) and/or status');
                }
                $data = $this->responseService->updateResponse($formId, $responseId, $upd);
                if (!$data) {
                    throw new \Exception('Response not found');
                }
                if (isset($upd['answers'])) {
                    $this->responseService->syncResponseLinks($formId, $responseId, $form['fields'] ?? [], $upd['answers']);
                }
                $ctx->audit('update_response', ['formId' => $formId, 'responseId' => $responseId]);
                break;
            }
            case 'delete_response': {
                $formId = (string) ($args['formId'] ?? '');
                $responseId = (string) ($args['responseId'] ?? '');
                $this->assertFormInScope($ctx, $formId);
                $this->ownForm($formId, $userId);
                $this->assertNotPrivateForm($formId);
                if ($responseId === '' || !$this->responseService->deleteResponse($formId, $responseId)) {
                    throw new \Exception('Response not found');
                }
                $data = ['deleted' => true, 'responseId' => $responseId];
                $ctx->audit('delete_response', ['formId' => $formId, 'responseId' => $responseId]);
                break;
            }
            default:
                throw new \Exception("Unknown or unavailable tool: {$name}");
        }
        return $data;
    }

    /**
     * E2EE §9.2 gate (docs/E2EE_PRIVATE_FORMS_PLAN.md): record tools never touch a
     * private form — reads would feed ciphertext to models, writes would smuggle
     * plaintext past the envelope pipeline. Ownership is checked FIRST by the
     * callers, so this never leaks another account's privacy state.
     *
     * @throws ChatToolDeniedException reason 'private_form_encrypted'
     */
    private function assertNotPrivateForm(string $formId): void
    {
        if ($formId !== '' && $this->responseService->isPrivateForm($formId)) {
            throw new ChatToolDeniedException(
                'This form is end-to-end encrypted — its records cannot be read or written by chat/MCP tools.',
                'private_form_encrypted'
            );
        }
    }

    // ── Helpers (moved verbatim from McpController) ─────────────────────────────────────

    /** Same form-count quota FormController::checkFormQuota enforces on the web create path — a
     *  no-op unless $this->planService is set AND plan enforcement is on (self-hosted default). */
    private function checkFormQuota(string $userId): void
    {
        if ($this->planService && !$this->planService->canCreateForms($userId, 1)) {
            throw new \Exception('You\'ve reached your plan\'s limit of ' . $this->planService->formLimit($userId) . ' forms. Delete a form or upgrade to add more.');
        }
    }

    /** The FlowService, or a clean error on a server where it isn't wired (older test harnesses). */
    private function flows(): FlowService
    {
        if ($this->flowService === null) {
            throw new \Exception('Flows are not available on this server.');
        }
        return $this->flowService;
    }

    /**
     * The app a flow/binding tool targets: an explicit appId wins; an app-scoped token falls back
     * to its app; a creator token that has made exactly one app falls back to that app (the same
     * convenience create_app_form provides).
     */
    private function resolveAppId(array $args, ChatToolsContext $ctx): string
    {
        $appId = (string) ($args['appId'] ?? '');
        if ($appId === '' && is_string($ctx->scopedAppId)) {
            $appId = $ctx->scopedAppId;
        }
        if ($appId === '' && $ctx->creatorMode && count($ctx->createdApps) === 1) {
            $appId = (string) $ctx->createdApps[0];
        }
        return $appId;
    }

    /**
     * Run submitted answers through the SAME pipeline as the external API write path:
     * sanitize (drop non-input/unknown fields) → normalize (file urls, checkbox dedupe) →
     * calculated fields → file validation → size cap → full field validation. Throws a
     * user-safe \Exception carrying the per-field errors on failure.
     */
    private function preparedAnswers(array $form, array $answers): array
    {
        $fields = $form['fields'] ?? [];
        $formId = (string) ($form['id'] ?? '');
        $answers = $this->responseService->sanitizeSubmittedAnswers($fields, $answers);
        $answers = $this->responseService->normalizeAnswers($fields, $answers, $formId);
        $answers = $this->responseService->applyCalculatedFields($fields, $answers);
        // Every write path calls ownForm() first, so this is an owner programmatic
        // write → owner attachment rules (FILE-PRIV-001).
        $fileErrors = $this->responseService->validateFileAnswers($fields, $answers, $formId, ['isOwner' => true]);
        if (!empty($fileErrors)) {
            throw new \Exception('Validation failed: ' . json_encode($fileErrors, JSON_UNESCAPED_SLASHES));
        }
        if ($this->responseService->answersTooLarge($answers)) {
            throw new \Exception('Submission is too large.');
        }
        $errors = $this->responseService->validateSubmittedAnswers($fields, $answers);
        if (!empty($errors)) {
            throw new \Exception('Validation failed: ' . json_encode($errors, JSON_UNESCAPED_SLASHES));
        }
        return $answers;
    }

    /** The target app must be in scope: the one scoped app, or (creator token) an app it created. */
    private function assertAppScope(ChatToolsContext $ctx, string $appId): void
    {
        if ($ctx->creatorMode) {
            if ($appId === '' || !in_array($appId, $ctx->createdApps, true)) {
                throw new ChatToolDeniedException('This MCP link can only manage the app(s) it created', 'app_scope');
            }
            return;
        }
        $scoped = $ctx->scopedAppId;
        if ($scoped !== null && $scoped !== $appId) {
            throw new ChatToolDeniedException('This MCP token is scoped to a single app and cannot touch other apps', 'app_scope');
        }
    }

    /** The target form must be in scope: belong to the scoped app, or (creator token) be one it created
     *  / belong to an app it created. */
    private function assertFormInScope(ChatToolsContext $ctx, string $formId): void
    {
        if ($ctx->creatorMode) {
            $createdForms = $ctx->createdForms;
            if ($formId !== '' && (in_array($formId, $createdForms, true) || $this->formInAnyApp($ctx->createdApps, $formId))) {
                return;
            }
            throw new ChatToolDeniedException('This MCP link can only touch forms it created (or forms in apps it created)', 'form_scope');
        }
        $scoped = $ctx->scopedAppId;
        if ($scoped !== null && ($formId === '' || !$this->appService->formBelongsToApp($scoped, $formId))) {
            throw new ChatToolDeniedException('This MCP token is scoped to an app; that form is not part of it', 'form_scope');
        }
    }

    /** True if $formId belongs to any of the given apps. */
    private function formInAnyApp(array $appIds, string $formId): bool
    {
        foreach ($appIds as $aid) {
            if ($this->appService->formBelongsToApp((string) $aid, $formId)) {
                return true;
            }
        }
        return false;
    }

    /** The set (formId => true) a creator token may read in list_forms: forms it created + forms in its apps. */
    private function creatorFormIds(ChatToolsContext $ctx): array
    {
        $set = [];
        foreach ($ctx->createdForms as $fid) {
            $set[(string) $fid] = true;
        }
        foreach ($ctx->createdApps as $aid) {
            foreach ($this->appService->getAppForms((string) $aid) as $f) {
                $set[$f['formId']] = true;
            }
        }
        return $set;
    }

    /** Size caps for MCP-created/updated forms (MCP bypasses FormController, so enforce here). */
    /** Mirror FormController's shape/type/size rules (MCP bypasses that controller, calling services directly). */
    private function validateFormInput(array $args): void
    {
        if (array_key_exists('title', $args) && (!is_string($args['title']) || strlen($args['title']) > 500)) {
            throw new \Exception('title must be a string up to 500 characters');
        }
        if (array_key_exists('description', $args) && $args['description'] !== null && !is_string($args['description'])) {
            throw new \Exception('description must be a string or null');
        }
        if (array_key_exists('status', $args) && !in_array($args['status'], ['draft', 'published', 'archived'], true)) {
            throw new \Exception('status must be draft, published, or archived');
        }
        if (array_key_exists('icon', $args) && $args['icon'] !== null && (!is_string($args['icon']) || strlen($args['icon']) > 100)) {
            throw new \Exception('icon must be a string up to 100 characters');
        }
        if (isset($args['logicScript']) && (!is_string($args['logicScript']) || strlen($args['logicScript']) > 102400)) {
            throw new \Exception('logicScript must be a string up to 100KB');
        }
        if (array_key_exists('fields', $args)) {
            if (!is_array($args['fields'])) {
                throw new \Exception('fields must be an array');
            }
            if (count($args['fields']) > 200) {
                throw new \Exception('a form cannot have more than 200 fields');
            }
            foreach ($args['fields'] as $i => $f) {
                if (!is_array($f) || !isset($f['type'])) {
                    throw new \Exception("field at index {$i} is malformed (must be an object with a type)");
                }
            }
            if (strlen((string) json_encode($args['fields'])) > 512000) {
                throw new \Exception('fields exceed the 500KB limit');
            }
        }
        if (isset($args['customScreen'])) {
            if (!is_array($args['customScreen'])) {
                throw new \Exception('customScreen must be an object');
            }
            $this->validateCustomScreen($args['customScreen']);
        }
    }

    /** Shared customScreen shape check (form section screens AND the app home): key whitelist + size cap. */
    private function validateCustomScreen(array $cs): void
    {
        $allowed = ['enabled', 'html', 'css', 'js', 'ts', 'files', 'entry', 'publicRecords', 'publicRecordFields', 'kind', 'dashboard', 'recordScreen', 'allowNewResponses'];
        $unknown = array_diff(array_keys($cs), $allowed);
        if (!empty($unknown)) {
            throw new \Exception('customScreen has unknown keys: ' . implode(', ', $unknown) . ' (a widget dashboard is { kind:"dashboard", dashboard:{ cols, widgets } })');
        }
        // 2MB: screens may carry image assets as data: URIs in `files` (base64 inflates ~4/3).
        if (strlen((string) json_encode($cs)) > 2097152) {
            throw new \Exception('customScreen exceeds the 2MB limit');
        }
    }

    /**
     * Mirror FormController::sanitizeDashboardScreen: a section-screen widget dashboard
     * (customScreen.kind === 'dashboard') is sanitized against the form's own fields
     * (+ its linked_record target forms) before it persists, so no widget can query outside them.
     */
    private function sanitizeSectionScreen(array $screen, string $formId): array
    {
        if (($screen['kind'] ?? '') === 'dashboard' && is_array($screen['dashboard'] ?? null) && $this->reportValidator !== null) {
            $screen['dashboard'] = $this->reportValidator->sanitizeDashboard(
                $screen['dashboard'],
                $this->reportValidator->formFieldMap($formId)
            );
        }
        return $screen;
    }

    /**
     * Create a form for create_form / create_app_form. When the customScreen is a widget DASHBOARD its
     * specs must be sanitized against the form's REAL stored fields — which don't exist until the form
     * does — so the screen is held back from the insert and attached right after (create → sanitize →
     * patch): an unsanitized dashboard never persists. Code screens pass straight through (sandboxed).
     */
    private function createFormSanitized(array $args, string $userId): array
    {
        $input = array_merge($this->formInput($args), ['userId' => $userId]);
        $screen = null;
        if (is_array($input['customScreen'] ?? null) && ($input['customScreen']['kind'] ?? '') === 'dashboard') {
            $screen = $input['customScreen'];
            unset($input['customScreen']);
        }
        $form = $this->formService->createForm($input);
        if ($screen !== null && !empty($form['id'])) {
            $form = $this->formService->updateForm((string) $form['id'], [
                'customScreen' => $this->sanitizeSectionScreen($screen, (string) $form['id']),
            ]) ?? $form;
        }
        return $form;
    }

    private function ownForm(string $formId, string $userId): array
    {
        $f = $formId !== '' ? $this->formService->getForm($formId) : null;
        if (!$f || ($f['userId'] ?? null) !== $userId) {
            throw new ChatToolDeniedException('Form not found or access denied', 'not_found');
        }
        return $f;
    }

    private function ownApp(string $appId, string $userId): array
    {
        $a = $appId !== '' ? $this->appService->getApp($appId) : null;
        if (!$a || ($a['ownerId'] ?? null) !== $userId) {
            throw new ChatToolDeniedException('App not found or access denied', 'not_found');
        }
        return $a;
    }

    /** Pick the writable form fields from tool args. */
    private function formInput(array $args): array
    {
        $out = [];
        foreach (['title', 'description', 'logicScript', 'status', 'icon'] as $k) {
            if (array_key_exists($k, $args)) {
                $out[$k] = $args[$k];
            }
        }
        if (array_key_exists('fields', $args) && is_array($args['fields'])) {
            $out['fields'] = $args['fields'];
        }
        if (array_key_exists('customScreen', $args) && is_array($args['customScreen'])) {
            $out['customScreen'] = $args['customScreen'];
        }
        return $out;
    }

    // ── Tool catalogs ───────────────────────────────────────────────────────────────────

    /**
     * The full tool-definition list (moved verbatim from McpController::toolDefs' $all):
     * every entry carries {name, scope, description, inputSchema}. The MCP surface filters
     * by session scopes and strips 'scope'; the chat catalog (chatCatalog()) draws its
     * subset from the same source so the two can never drift.
     */
    public static function toolDefinitions(): array
    {
        $field = ['type' => 'object', 'description' => 'A field: { id, type, label, required, properties? }'];
        $screen = ['type' => 'object', 'description' => "Custom screen — two kinds. (1) PREFERRED no-code widget DASHBOARD: { kind:'dashboard', dashboard:{ cols?:12, widgets:[{ kind:'report'|'list'|'text'|'actions'|'activity', layout:{x,y,w,h}, title?, … }] } } — 'report' embeds a chart/KPI/table via `spec` (the SAME shape as create_report's spec), 'list' shows recent records via `list`:{formId,limit?,titleField?,subtitleField?,metaField?}, 'text' a note via `text`:{body}, 'actions' new-record buttons, 'activity' a latest-records feed (both config-free, app home only). Widget specs are validated against the in-scope forms on save; out-of-scope widgets are dropped. (2) CODE screen — a sandboxed full frontend: EITHER `ts` (a single TypeScript/TSX file) OR `files` (a multi-file project: an array of { path, content } with .tsx/.ts/.css files, folders + relative imports allowed, entry index.tsx). React-style TSX components WORK: 'react', 'react-dom/client', 'preact', 'preact/hooks' are built-in (react aliases to Preact); other npm packages resolve via esm.sh at compile time (pin versions). Image assets: .svg as text files, binary images as data: URI content — importing an image file yields its data: URI. No index.html needed (a <div id=\"root\"></div> shell is automatic; entry must createRoot(...).render(<App/>)). Compiled/bundled to runnable JS automatically. Talks to the backend via window.FormLogic (submit/records/currentUser/context/toast)."];
        $obj = static fn (array $props, array $req = []) => array_filter(['type' => 'object', 'properties' => $props, 'required' => $req], static fn ($v) => $v !== []);
        $flowGraph = ['type' => 'object', 'description' => "The automation graph: { nodes:[{ id, type, data:{ …node config } }], edges:[{ source, target, sourceHandle? }] }. Node ids are unique strings; node config lives under data; every edge references existing node ids; a condition node routes downstream via sourceHandle 'true' / 'false'. Node types + their config: see the get_started guide (§ Flows)."];
        $customLogic = ['type' => 'object', 'description' => "App-logic bundle: { version:1, scripts:[{ id?, hook, source, permissions?, enabled? }], permissions?:[…], connector?:{ manifest, demoDriver? } }. hook ∈ onAppStart|onScreenEnter|onScreenLeave|onButtonClick|onBeforeSubmit|onAfterSubmit|onConnectorEvent|onSyncConflict|mapConnectorDataToForm|calculateDashboardState. source = sandboxed QuickJS (≤50KB/script, ≤256KB total). permissions grant what the scripts may do (e.g. 'formlogic.responses.write', 'connector.aokie.call.answer'). connector (optional) declares a pack-embedded connector: manifest { connectorId, kind, label, commands[], journalledCommands?, demoEvents?, demoCeremonies?, captions? } + demoDriver (a QuickJS 'function run(ctx)' simulator, ≤128KB) — the demo driver only activates with the reviewable grant 'connector.<id>.driver.demo' and only inside an explicit simulator session; real hardware always routes host-side via FormLogic Desktop."];
        // Ordered deliberately: the core BUILD path first (create_app → create_app_form →
        // set_app_home → update_app → flows), because some MCP clients (e.g. Claude) surface only
        // the first batch of tool schemas eagerly and lazy-load the rest — a fresh app build should
        // never stall on a deferred schema.
        return [
            ['name' => 'create_app', 'scope' => 'apps:write', 'description' => 'Create an app (container for forms). Optional appKind tags the audience the app serves.', 'inputSchema' => $obj(['name' => ['type' => 'string'], 'description' => ['type' => 'string'], 'appKind' => ['type' => 'string', 'enum' => AppService::APP_KINDS, 'description' => 'Optional audience tag: admin console, client portal, staff field app, public intake, internal, or custom.']], ['name'])],
            ['name' => 'create_app_form', 'scope' => 'forms:write', 'description' => "PREFERRED for building an app: create a form AND attach it to an app in one call (no orphan form). appId defaults to the token's app when app-scoped; required for account-wide tokens. Same fields as create_form + displayName.", 'inputSchema' => $obj(['appId' => ['type' => 'string'], 'displayName' => ['type' => 'string'], 'title' => ['type' => 'string'], 'description' => ['type' => 'string'], 'fields' => ['type' => 'array', 'items' => $field], 'logicScript' => ['type' => 'string'], 'customScreen' => $screen, 'status' => ['type' => 'string', 'enum' => ['draft', 'published']]], ['title'])],
            ['name' => 'set_app_home', 'scope' => 'screens:write', 'description' => "Set the app's home screen. PREFERRED: a no-code widget DASHBOARD ({ kind:'dashboard', dashboard:{ cols, widgets } } — charts/KPIs/lists the host renders natively; report widgets take the same spec as create_report). ALTERNATIVE: a full sandboxed CODE frontend (HTML/CSS/TypeScript) over the app's forms — its SDK spans all the app's forms: submit(formId,answers)/records(formId)/navigate(formId)/context()/forms()/currentUser(). Build a whole app here; you don't need a screen per form.", 'inputSchema' => $obj(['appId' => ['type' => 'string'], 'customScreen' => $screen], ['appId', 'customScreen'])],
            ['name' => 'set_form_screen', 'scope' => 'screens:write', 'description' => "Set a FORM's custom screen — a sandboxed frontend rendered INSTEAD of the default field UI on the form's public link, embeds and previews when enabled:true (enabled:false keeps it a draft the owner can preview in the Studio). Same two kinds as set_app_home: a no-code widget DASHBOARD, or a CODE screen (TSX files talking to window.FormLogic: submit(answers)/records()/context()/currentUser()/toast). publicRecords + publicRecordFields opt anonymous visitors into reading the whitelisted answer fields (leaderboards). REPLACES the form's whole customScreen — send the complete screen every time (read the current one with get_form first when editing).", 'inputSchema' => $obj(['formId' => ['type' => 'string'], 'customScreen' => $screen], ['formId', 'customScreen'])],
            ['name' => 'update_app', 'scope' => 'apps:write', 'description' => 'Update an app: rename, set description, change the URL slug, publish (status: draft|published|archived), hide the sidebar/menu (hideNav: true for a self-contained custom-home app), or set its app-logic bundle (customLogic — sandboxed QuickJS event handlers, e.g. reacting to connector events).', 'inputSchema' => $obj(['appId' => ['type' => 'string'], 'name' => ['type' => 'string'], 'description' => ['type' => 'string'], 'slug' => ['type' => 'string', 'description' => 'URL slug: lowercase letters, digits, hyphens.'], 'status' => ['type' => 'string', 'enum' => ['draft', 'published', 'archived']], 'hideNav' => ['type' => 'boolean', 'description' => 'Render the app full-screen without the sidebar/menu.'], 'customLogic' => $customLogic], ['appId'])],
            ['name' => 'create_flow', 'scope' => 'apps:write', 'description' => "Create a FLOW (automation) in an app: a graph of nodes — LLM chat, find/submit/update records, condition, template, QuickJS logic, HTTP, connector commands, speech — that runs when a bound trigger event fires. After creating it, wire it to its trigger with create_flow_binding. Set nodeCapabilities to the union of the capabilities your nodes need (see get_started § Flows), e.g. ['formlogic.responses.read','formlogic.responses.write'].", 'inputSchema' => $obj(['appId' => ['type' => 'string', 'description' => "Defaults to the token's app when app-scoped."], 'name' => ['type' => 'string'], 'slug' => ['type' => 'string', 'description' => 'lowercase letters/digits/hyphens; defaults from name.'], 'description' => ['type' => 'string'], 'flowJson' => $flowGraph, 'nodeCapabilities' => ['type' => 'array', 'items' => ['type' => 'string'], 'description' => "Capabilities the flow's nodes need: formlogic.responses.read / formlogic.responses.write / formlogic.kv.write / model.llm.local / connector.<id>.<command>."], 'enabled' => ['type' => 'boolean']], ['name'])],
            ['name' => 'list_blueprints', 'scope' => 'apps:read', 'description' => "List the owner's blueprints (DIAGRAMS — the visual sketches of apps at /diagrams): blueprintId, name, appId (null until materialised into a real app), semanticRevision, updatedAt. Use get_blueprint before proposing changes.", 'inputSchema' => $obj([])],
            ['name' => 'get_blueprint', 'scope' => 'apps:read', 'description' => 'Get one blueprint (diagram) including its elements (nodes AND relationship edges) and current semanticRevision — you need that revision for blueprint_propose_elements.', 'inputSchema' => $obj(['blueprintId' => ['type' => 'string']], ['blueprintId'])],
            ['name' => 'blueprint_propose_elements', 'scope' => 'apps:write', 'description' => "Propose (and, after user approval, commit) elements on a BLUEPRINT — the high-level diagram of what's being built. Operations are typed entries: blueprint.element.create {operationId, targetId (you mint, e.g. 'el-orders'), elementType (app|form|screen|event|flow|intelligence|service|actor|decision|group|note|edge), properties {title,...}, resourceRef? {kind,id}, layout? {x,y}}, blueprint.element.update, blueprint.element.delete, blueprint.layout.set. Edge elements express relationships via properties {edgeType: contains|triggers|sends-data|success|failure|invokes|uses|relation|exposes, sourceId, targetId} — endpoints must be existing non-edge elements. ALWAYS call with commit=false first: it validates the whole batch and PARKS it as a proposed change set the user sees as a GHOST PREVIEW on their diagram canvas (with its own Apply/Discard buttons) - describe the plan, and the user approves on the canvas, or you re-call with commit=true and the SAME operations after they approve in chat. Pass a short `summary` describing the proposal. Semantic batches require baseSemanticRevision = the blueprint's current semanticRevision.", 'inputSchema' => $obj(['blueprintId' => ['type' => 'string', 'description' => 'An existing blueprint id.'], 'createBlueprintName' => ['type' => 'string', 'description' => 'Create a new blueprint with this name instead of passing blueprintId.'], 'baseSemanticRevision' => ['type' => 'number', 'description' => "The blueprint's current semanticRevision (required for element create/update/delete)."], 'commit' => ['type' => 'boolean', 'description' => 'false (default) = validate + park as a ghost-preview change set; true = apply after the user approved.'], 'summary' => ['type' => 'string', 'description' => 'Short human summary of the proposal (shown on the canvas approval bar).'], 'operations' => ['type' => 'array', 'items' => ['type' => 'object'], 'description' => 'The typed operation batch (see tool description).']], ['operations'])],
            ['name' => 'create_flow_binding', 'scope' => 'apps:write', 'description' => "Make a flow RUN automatically by binding it to a trigger EVENT. Common triggers: event 'form.submitted' + formId (a form received a new record), or a connector event + connectorId (e.g. event 'aokie.call.incoming', connectorId 'aokie' — an incoming phone call). flow = the flow's SLUG (not id). mode: async (default) | sync (the triggering caller waits for the result) | background | manual. inputMap maps the flow's trigger inputs from the event, e.g. { callerPhone: '\$event.data.from', name: '\$event.data.answers.name' }. outputActions (optional) run with the flow result, e.g. [{ type:'formlogic.submitResponse', form:'<formId>', answers:{ note:'\$result.summary' } }] — types: formlogic.submitResponse | formlogic.updateResponse | formlogic.toast | connector.request | call.speak | formlogic.store.", 'inputSchema' => $obj(['appId' => ['type' => 'string', 'description' => "Defaults to the token's app when app-scoped."], 'flow' => ['type' => 'string', 'description' => "The flow's slug."], 'event' => ['type' => 'string', 'description' => "e.g. form.submitted, aokie.call.incoming, aokie.call.ended"], 'formId' => ['type' => 'string', 'description' => 'For form events: the form this binding listens to (must belong to the app).'], 'connectorId' => ['type' => 'string', 'description' => "For connector events: e.g. 'aokie'."], 'mode' => ['type' => 'string', 'enum' => ['sync', 'async', 'background', 'manual'], 'description' => 'Default async.'], 'condition' => ['type' => 'object', 'description' => "Optional gate: { type:'expression', expr:'<QuickJS boolean over event>' }."], 'inputMap' => ['type' => 'object', 'description' => 'flow input name → $event selector.'], 'outputActions' => ['type' => 'array', 'items' => ['type' => 'object'], 'description' => 'Actions run with the flow result (see tool description).'], 'timeoutMs' => ['type' => 'number', 'description' => '250–300000 (default 30000).'], 'enabled' => ['type' => 'boolean']], ['flow', 'event'])],
            ['name' => 'create_report', 'scope' => 'apps:write', 'description' => "Add a chart report to the app's Reports section (bar/line/area/pie/donut chart, a KPI number, or a table). spec = { formId, viz, groupBy?:{field,bucket?}, measure?:{fn,field?}, joins?:[{via,formId,type}], filters?:[{field,op,value?}], columns?:[…], seriesSort?, sort?, limit? }. viz: bar|line|area|pie|donut|kpi|table. fn: count|countDistinct|sum|avg|min|max. Use the REAL form ids you created. joins[].via = a linked_record field id on the base form; joins[].formId = the linked form. Field refs (group/measure/filter/columns) are a base field id, a joined ref \"<joinFormId>::<fieldId>\", or the pseudo-fields __submitted_at / __status. Returns the created report incl. its id.", 'inputSchema' => $obj(['appId' => ['type' => 'string'], 'name' => ['type' => 'string'], 'description' => ['type' => 'string'], 'spec' => ['type' => 'object', 'description' => 'Report spec (see tool description).']], ['appId', 'name', 'spec'])],
            ['name' => 'create_document', 'scope' => 'apps:write', 'description' => "Add a PDF document (a report page combining multiple charts + explanatory text) to the app's Reports section. blocks[] render in order: { kind:'text', title?, body } for a heading/paragraph, or { kind:'report', reportId, caption? } to embed a chart — reportId is the id returned by create_report. Create the chart reports FIRST, then reference them here.", 'inputSchema' => $obj(['appId' => ['type' => 'string'], 'name' => ['type' => 'string'], 'description' => ['type' => 'string'], 'blocks' => ['type' => 'array', 'items' => ['type' => 'object', 'description' => "{ kind:'text', title?, body } | { kind:'report', reportId, caption? }"]]], ['appId', 'name', 'blocks'])],
            ['name' => 'list_apps', 'scope' => 'apps:read', 'description' => "List the owner's apps (only the scoped app when app-scoped).", 'inputSchema' => $obj([])],
            ['name' => 'list_forms', 'scope' => 'forms:read', 'description' => "List the owner's forms (only this app's forms when the token is app-scoped).", 'inputSchema' => $obj([])],
            ['name' => 'get_form', 'scope' => 'forms:read', 'description' => 'Get one form (fields, logicScript, customScreen).', 'inputSchema' => $obj(['formId' => ['type' => 'string']], ['formId'])],
            ['name' => 'create_form', 'scope' => 'forms:write', 'description' => 'Create a standalone form (prefer create_app_form when building an app). Provide title and optional fields[], logicScript (QuickJS onSubmit), customScreen, status.', 'inputSchema' => $obj(['title' => ['type' => 'string'], 'description' => ['type' => 'string'], 'fields' => ['type' => 'array', 'items' => $field], 'logicScript' => ['type' => 'string'], 'customScreen' => $screen, 'status' => ['type' => 'string', 'enum' => ['draft', 'published']]], ['title'])],
            ['name' => 'update_form', 'scope' => 'forms:write', 'description' => 'Update a form (any of fields, logicScript, customScreen, title, status).', 'inputSchema' => $obj(['formId' => ['type' => 'string'], 'title' => ['type' => 'string'], 'fields' => ['type' => 'array', 'items' => $field], 'logicScript' => ['type' => 'string'], 'customScreen' => $screen, 'status' => ['type' => 'string', 'enum' => ['draft', 'published', 'archived']]], ['formId'])],
            ['name' => 'add_form_to_app', 'scope' => 'apps:write', 'description' => 'Attach an existing form to an app.', 'inputSchema' => $obj(['appId' => ['type' => 'string'], 'formId' => ['type' => 'string'], 'displayName' => ['type' => 'string']], ['appId', 'formId'])],
            ['name' => 'list_flows', 'scope' => 'apps:read', 'description' => "List an app's flows (automations) — id, name, slug, enabled, version. Use get_flow for a flow's graph.", 'inputSchema' => $obj(['appId' => ['type' => 'string', 'description' => "Defaults to the token's app when app-scoped."]])],
            ['name' => 'get_flow', 'scope' => 'apps:read', 'description' => 'Get one flow including its flowJson graph and nodeCapabilities.', 'inputSchema' => $obj(['appId' => ['type' => 'string'], 'flowId' => ['type' => 'string']], ['flowId'])],
            ['name' => 'update_flow', 'scope' => 'apps:write', 'description' => 'Update a flow (any of name, slug, description, flowJson, nodeCapabilities, enabled). Changing flowJson bumps the version.', 'inputSchema' => $obj(['appId' => ['type' => 'string'], 'flowId' => ['type' => 'string'], 'name' => ['type' => 'string'], 'slug' => ['type' => 'string'], 'description' => ['type' => 'string'], 'flowJson' => $flowGraph, 'nodeCapabilities' => ['type' => 'array', 'items' => ['type' => 'string']], 'enabled' => ['type' => 'boolean']], ['flowId'])],
            ['name' => 'delete_flow', 'scope' => 'apps:write', 'description' => 'Delete a flow from an app (its bindings are removed with it).', 'inputSchema' => $obj(['appId' => ['type' => 'string'], 'flowId' => ['type' => 'string']], ['flowId'])],
            ['name' => 'list_flow_bindings', 'scope' => 'apps:read', 'description' => "List an app's flow bindings (which events trigger which flows).", 'inputSchema' => $obj(['appId' => ['type' => 'string', 'description' => "Defaults to the token's app when app-scoped."]])],
            ['name' => 'update_flow_binding', 'scope' => 'apps:write', 'description' => 'Update a flow binding (partial: any of flow, event, formId, connectorId, mode, condition, inputMap, outputActions, timeoutMs, enabled).', 'inputSchema' => $obj(['appId' => ['type' => 'string'], 'bindingId' => ['type' => 'string'], 'flow' => ['type' => 'string'], 'event' => ['type' => 'string'], 'formId' => ['type' => 'string'], 'connectorId' => ['type' => 'string'], 'mode' => ['type' => 'string', 'enum' => ['sync', 'async', 'background', 'manual']], 'condition' => ['type' => 'object'], 'inputMap' => ['type' => 'object'], 'outputActions' => ['type' => 'array', 'items' => ['type' => 'object']], 'timeoutMs' => ['type' => 'number'], 'enabled' => ['type' => 'boolean']], ['bindingId'])],
            ['name' => 'delete_flow_binding', 'scope' => 'apps:write', 'description' => 'Delete a flow binding (the flow itself stays).', 'inputSchema' => $obj(['appId' => ['type' => 'string'], 'bindingId' => ['type' => 'string']], ['bindingId'])],
            ['name' => 'list_responses', 'scope' => 'responses:read', 'description' => "List a form's responses (records).", 'inputSchema' => $obj(['formId' => ['type' => 'string'], 'limit' => ['type' => 'number']], ['formId'])],
            ['name' => 'add_response', 'scope' => 'responses:write', 'description' => "Create a record (response) in a form. Runs the FULL submission pipeline — field validation, calculated fields, and the form's onSubmit script — exactly like the external API. answers = { <fieldId>: value }. NOT idempotent: repeating the call creates another record.", 'inputSchema' => $obj(['formId' => ['type' => 'string'], 'answers' => ['type' => 'object', 'description' => 'Field id → value.']], ['formId', 'answers'])],
            ['name' => 'update_response', 'scope' => 'responses:write', 'description' => 'Patch a record: answers is a PARTIAL object merged over the stored answers (send only the fields you change), validated like a submission. Optionally set the workflow status.', 'inputSchema' => $obj(['formId' => ['type' => 'string'], 'responseId' => ['type' => 'string'], 'answers' => ['type' => 'object', 'description' => 'Partial patch: field id → new value.'], 'status' => ['type' => 'string']], ['formId', 'responseId'])],
            ['name' => 'delete_response', 'scope' => 'responses:write', 'description' => 'Permanently delete one record (response) from a form.', 'inputSchema' => $obj(['formId' => ['type' => 'string'], 'responseId' => ['type' => 'string']], ['formId', 'responseId'])],
            ['name' => 'desktop_status', 'scope' => 'connector:command', 'description' => "Check whether the owner's FormLogic Desktop is online (currently polling the connector relay). Call this BEFORE connector_command to know if commands will reach a desktop. Returns { online, lastSeenSecondsAgo }.", 'inputSchema' => $obj([])],
            ['name' => 'connector_command', 'scope' => 'connector:command', 'description' => "Send a command to a hardware/service CONNECTOR on the owner's linked FormLogic Desktop and wait for the result (the desktop must be RUNNING + LINKED). connectorId names the connector (e.g. 'aokie' — the Bluetooth phone bridge). command + payload are connector-specific; for aokie: call.answer, call.reject, call.hangup, call.operatorSpeak {text}, sms.send {to, body}, sms.thread {threadId}, call.current, phone.status, dongle.list, dongle.diagnostics {simulate:'call'}. This is how you REMOTELY control the phone: e.g. hang up the current call, or speak a message to the caller. Returns the connector's result, or a note that it is still pending (desktop offline/slow).", 'inputSchema' => $obj(['connectorId' => ['type' => 'string', 'description' => "Connector id, e.g. 'aokie'."], 'command' => ['type' => 'string', 'description' => 'Connector command, e.g. call.hangup.'], 'payload' => ['type' => 'object', 'description' => 'Command arguments (connector-specific).'], 'waitMs' => ['type' => 'number', 'description' => 'Max ms to wait for the desktop result (default 15000, max 25000).']], ['connectorId', 'command'])],
        ];
    }

    /**
     * The v1 CHAT catalog (plan §5.4): exactly the CHAT_TOOL_NAMES subset, in plan order,
     * as {name, description, inputSchema} — shapes drawn from toolDefinitions(), with
     * MCP-token/scope phrasing rewritten for the chat surface and the update_form schema
     * narrowed to the non-destructive statuses (archiving is refused by callChatTool()).
     * Served TOP-LEVEL as {"tools":[…]} by GET /api/ai/chat-tools/catalog.
     */
    public static function chatCatalog(): array
    {
        $byName = [];
        foreach (self::toolDefinitions() as $def) {
            $byName[$def['name']] = $def;
        }
        // Chat-surface descriptions: same capability, minus MCP token/scope talk.
        $overrides = [
            'list_apps' => "List the account's apps.",
            'list_forms' => "List the account's forms.",
            'create_app_form' => 'PREFERRED for building an app: create a form AND attach it to an app in one call (no orphan form). Same fields as create_form + displayName; appId is required.',
            'update_form' => "Update a form (any of fields, logicScript, customScreen, title, status). Non-destructive from chat: archiving (status:'archived') is refused — unpublish with status:'draft' instead.",
            'update_app' => "Update an app: rename, set description, change the URL slug, publish (status: draft|published), hide the sidebar/menu (hideNav: true for a self-contained custom-home app), or set its app-logic bundle (customLogic). Non-destructive from chat: archiving (status:'archived') is refused — unpublish with status:'draft' instead.",
            'create_flow' => "Create a FLOW (automation) in an app: a graph of nodes — LLM chat, find/submit/update records, condition, template, QuickJS logic, HTTP, connector commands, speech — that runs when a bound trigger event fires. Set nodeCapabilities to the union of the capabilities your nodes need, e.g. ['formlogic.responses.read','formlogic.responses.write'].",
        ];
        $out = [];
        foreach (self::CHAT_TOOL_NAMES as $name) {
            $def = $byName[$name];
            $schema = $def['inputSchema'];
            if ($name === 'update_form' && isset($schema['properties']['status']['enum'])) {
                $schema['properties']['status']['enum'] = ['draft', 'published'];
            }
            if ($name === 'update_app' && isset($schema['properties']['status']['enum'])) {
                $schema['properties']['status']['enum'] = ['draft', 'published'];
            }
            if ($name === 'create_flow' && isset($schema['properties']['appId']['description'])) {
                $schema['properties']['appId']['description'] = 'The app id.';
            }
            $out[] = [
                'name' => $name,
                'description' => $overrides[$name] ?? $def['description'],
                'inputSchema' => $schema,
            ];
        }
        return $out;
    }
}

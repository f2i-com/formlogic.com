<?php

declare(strict_types=1);

namespace FormLogic\Http;

use FormLogic\Controllers\AppController;
use FormLogic\Controllers\AppDomainController;
use FormLogic\Controllers\AppUserController;
use FormLogic\Controllers\FlowController;
use FormLogic\Controllers\FormController;
use FormLogic\Controllers\TrashController;
use FormLogic\Controllers\WebhookController;
use FormLogic\Middleware\AdminRunLogRedactionMiddleware;
use Psr\Container\ContainerInterface;
use Slim\Routing\RouteCollectorProxy;

/**
 * The admin acting-as route ALLOWLIST — mirrors of owner endpoints mounted
 * under /api/admin/users/{ownerId}/... and dispatched to the SAME owner
 * controllers after AdminActAsMiddleware swaps the effective user to the
 * owner. This table is the platform's no-response-data boundary for
 * administrators:
 *
 *   - Only routes listed here are admin-reachable on behalf of a user.
 *     A new owner endpoint is NOT mirrored until a row is added (default-deny).
 *   - Record-data surfaces are deliberately ABSENT and must stay absent:
 *     responses (list/show/export/import/recompute), files, lookup, analytics,
 *     report execution, script tests, app exports (packs can embed seeded
 *     records), the /api/app/{slug} runtime, api-keys/mcp-tokens/oauth
 *     (minting owner credentials would bypass the boundary via /api/v1),
 *     flow-run queue/claim (their purpose is handing answer snapshots to an
 *     executor) and flow-kv (state can carry record-derived values).
 *   - Routes that RETURN flow runs are flagged REDACT_RUNS: run metadata is
 *     visible, but inputSnapshot/result/outputActions/error are stripped by
 *     AdminRunLogRedactionMiddleware (submission answers live in there).
 *
 * AdminActingAsTest locks all of this: every row must reject non-admins, and
 * a planted-secret sweep asserts no row can return record contents.
 */
final class AdminActingAsRoutes
{
    public const REDACT_RUNS = 'redactRuns';

    /**
     * [method, pattern, controller class, controller method, flags[]]
     *
     * Registration order preserves the owner files' order — FastRoute matches
     * the first registered route, so static segments (form-usage, relations,
     * reorder, {flowId}/bindings) must precede their {param} siblings exactly
     * as they do on the owner surface.
     */
    public const ROUTES = [
        // ── Forms (FormController — structure only; responses live elsewhere) ──
        ['GET',    '/forms',                                   FormController::class,      'index'],
        ['POST',   '/forms',                                   FormController::class,      'create'],
        ['GET',    '/forms/{id}',                              FormController::class,      'show'],
        ['PUT',    '/forms/{id}',                              FormController::class,      'update'],
        ['DELETE', '/forms/{id}',                              FormController::class,      'delete'],
        ['POST',   '/forms/{id}/duplicate',                    FormController::class,      'duplicate'],
        ['GET',    '/forms/{formId}/app-contexts',             AppController::class,       'formAppContexts'],

        // ── Form webhooks (config + delivery METADATA — payload columns are never selected) ──
        ['GET',    '/forms/{id}/webhooks',                     WebhookController::class,   'listWebhooks'],
        ['POST',   '/forms/{id}/webhooks',                     WebhookController::class,   'createWebhook'],
        ['PUT',    '/forms/{id}/webhooks/{webhookId}',         WebhookController::class,   'updateWebhook'],
        ['DELETE', '/forms/{id}/webhooks/{webhookId}',         WebhookController::class,   'deleteWebhook'],
        ['GET',    '/forms/{id}/webhooks/{webhookId}/deliveries', WebhookController::class, 'getDeliveries'],

        // ── Standalone-form flow bindings ──
        ['GET',    '/forms/{id}/flow-bindings',                FlowController::class,      'listFormBindings'],
        ['POST',   '/forms/{id}/flow-bindings',                FlowController::class,      'createFormBinding'],
        ['PUT',    '/forms/{id}/flow-bindings/{bindingId}',    FlowController::class,      'updateFormBinding'],
        ['DELETE', '/forms/{id}/flow-bindings/{bindingId}',    FlowController::class,      'deleteFormBinding'],

        // ── Form versions (structure snapshots: fields/settings/theme/logicScript) ──
        ['GET',    '/forms/{id}/versions',                     FormController::class,      'listVersions'],
        ['GET',    '/forms/{id}/versions/{version}',           FormController::class,      'getVersion'],
        ['POST',   '/forms/{id}/versions/{version}/restore',   FormController::class,      'restoreVersion'],

        // ── Apps (AppController; static /form-usage before /{id}) ──
        ['GET',    '/apps',                                    AppController::class,       'index'],
        ['POST',   '/apps',                                    AppController::class,       'create'],
        ['GET',    '/apps/form-usage',                         AppController::class,       'formUsage'],
        ['GET',    '/apps/{id}',                               AppController::class,       'show'],
        ['PUT',    '/apps/{id}',                               AppController::class,       'update'],
        ['DELETE', '/apps/{id}',                               AppController::class,       'delete'],
        ['POST',   '/apps/{id}/companion',                     AppController::class,       'createCompanion'],

        // ── Custom domains ──
        ['GET',    '/apps/{id}/domains',                       AppDomainController::class, 'index'],
        ['POST',   '/apps/{id}/domains',                       AppDomainController::class, 'create'],
        ['PUT',    '/apps/{id}/domains/{domainId}',            AppDomainController::class, 'update'],
        ['POST',   '/apps/{id}/domains/{domainId}/verify',     AppDomainController::class, 'verify'],
        ['DELETE', '/apps/{id}/domains/{domainId}',            AppDomainController::class, 'delete'],

        // ── App flows + bindings + run history (runs REDACTED to metadata) ──
        ['GET',    '/apps/{id}/flows',                         FlowController::class,      'listFlows'],
        ['POST',   '/apps/{id}/flows',                         FlowController::class,      'createFlow'],
        ['GET',    '/apps/{id}/flows/{flowId}',                FlowController::class,      'getFlow'],
        ['PUT',    '/apps/{id}/flows/{flowId}',                FlowController::class,      'updateFlow'],
        ['DELETE', '/apps/{id}/flows/{flowId}',                FlowController::class,      'deleteFlow'],
        ['POST',   '/apps/{id}/flows/{flowId}/test-run',       FlowController::class,      'testRun', [self::REDACT_RUNS]],
        ['GET',    '/apps/{id}/flow-bindings',                 FlowController::class,      'listBindings'],
        ['POST',   '/apps/{id}/flow-bindings',                 FlowController::class,      'createBinding'],
        ['PUT',    '/apps/{id}/flow-bindings/{bindingId}',     FlowController::class,      'updateBinding'],
        ['DELETE', '/apps/{id}/flow-bindings/{bindingId}',     FlowController::class,      'deleteBinding'],
        ['GET',    '/apps/{id}/flow-runs',                     FlowController::class,      'listRuns', [self::REDACT_RUNS]],

        // ── App ↔ form attachments (static /relations + /reorder before /{formId}) ──
        ['GET',    '/apps/{id}/forms',                         AppController::class,       'listForms'],
        ['GET',    '/apps/{id}/forms/relations',               AppController::class,       'formRelations'],
        ['POST',   '/apps/{id}/forms',                         AppController::class,       'addForm'],
        ['PUT',    '/apps/{id}/forms/reorder',                 AppController::class,       'reorderForms'],
        ['PUT',    '/apps/{id}/forms/{formId}',                AppController::class,       'updateForm'],
        ['DELETE', '/apps/{id}/forms/{formId}',                AppController::class,       'removeForm'],

        // ── Roles + permissions (owner passes AppUserController::hasPermission) ──
        ['GET',    '/apps/{appId}/roles',                      AppUserController::class,   'listRoles'],
        ['POST',   '/apps/{appId}/roles',                      AppUserController::class,   'createRole'],
        ['PUT',    '/apps/{appId}/roles/{roleId}',             AppUserController::class,   'updateRole'],
        ['DELETE', '/apps/{appId}/roles/{roleId}',             AppUserController::class,   'deleteRole'],
        ['GET',    '/apps/{appId}/roles/{roleId}/permissions', AppUserController::class,   'getPermissions'],
        ['PUT',    '/apps/{appId}/roles/{roleId}/permissions', AppUserController::class,   'setPermissions'],

        // ── Members / invitations / groups ──
        ['GET',    '/apps/{appId}/users',                      AppUserController::class,   'listUsers'],
        ['PUT',    '/apps/{appId}/users/{id}',                 AppUserController::class,   'updateUser'],
        ['DELETE', '/apps/{appId}/users/{id}',                 AppUserController::class,   'removeUser'],
        ['GET',    '/apps/{appId}/invitations',                AppUserController::class,   'listInvitations'],
        ['POST',   '/apps/{appId}/invitations',                AppUserController::class,   'createInvitation'],
        ['DELETE', '/apps/{appId}/invitations/{id}',           AppUserController::class,   'revokeInvitation'],
        ['GET',    '/apps/{appId}/groups',                     AppUserController::class,   'listGroups'],
        ['POST',   '/apps/{appId}/groups',                     AppUserController::class,   'createGroup'],
        ['PUT',    '/apps/{appId}/groups/{id}',                AppUserController::class,   'updateGroup'],
        ['DELETE', '/apps/{appId}/groups/{id}',                AppUserController::class,   'deleteGroup'],
        ['GET',    '/apps/{appId}/groups/{id}/members',        AppUserController::class,   'listGroupMembers'],
        ['POST',   '/apps/{appId}/groups/{id}/members/{memberId}', AppUserController::class, 'addGroupMember'],
        ['DELETE', '/apps/{appId}/groups/{id}/members/{memberId}', AppUserController::class, 'removeGroupMember'],

        // ── Workspace flows (static {flowId}/bindings before {flowId}) ──
        ['GET',    '/flows',                                   FlowController::class,      'listWorkspaceFlows'],
        ['POST',   '/flows',                                   FlowController::class,      'createWorkspaceFlow'],
        ['GET',    '/flows/{flowId}/bindings',                 FlowController::class,      'listFlowBindingsForFlow'],
        ['GET',    '/flows/{flowId}',                          FlowController::class,      'getWorkspaceFlow'],
        ['PUT',    '/flows/{flowId}',                          FlowController::class,      'updateWorkspaceFlow'],
        ['DELETE', '/flows/{flowId}',                          FlowController::class,      'deleteWorkspaceFlow'],

        // ── Owner-wide run history + completion (REDACTED; no /queued, no /claim) ──
        ['GET',    '/flow-runs',                               FlowController::class,      'listOwnerRuns', [self::REDACT_RUNS]],
        ['PATCH',  '/flow-runs/{runId}',                       FlowController::class,      'completeOwnerRun', [self::REDACT_RUNS]],

        // ── Recycle bin (names/kinds/counts only — snapshot CONTENTS have no
        //    mirror and no download endpoint anywhere; restore consumes the item) ──
        ['GET',    '/trash',                                   TrashController::class,     'index'],
        ['POST',   '/trash/{id}/restore',                      TrashController::class,     'restore'],
        ['DELETE', '/trash/{id}',                              TrashController::class,     'purge'],
    ];

    public static function register(RouteCollectorProxy $group, ContainerInterface $container): void
    {
        $redactor = new AdminRunLogRedactionMiddleware();
        foreach (self::ROUTES as $row) {
            [$method, $pattern, $class, $fn] = $row;
            $flags = $row[4] ?? [];
            // NOTE: closure params MUST be named $request/$response — the PHP-DI
            // bridge invoker injects by parameter name.
            $route = $group->map([$method], $pattern, function ($request, $response) use ($container, $class, $fn) {
                $args = \Slim\Routing\RouteContext::fromRequest($request)->getRoute()->getArguments();
                return $container->get($class)->{$fn}($request, $response, $args);
            });
            if (in_array(self::REDACT_RUNS, $flags, true)) {
                $route->add($redactor);
            }
        }
    }
}

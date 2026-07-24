<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use FormLogic\Helpers\CustomLogicSanitizer;
use FormLogic\Helpers\PackCapabilities;
use PDO;

class PackService
{
    private PDO $mysql;
    private FormService $formService;
    private AppService $appService;
    private AppUserService $appUserService;

    public function __construct(
        MySQLConnection $mysql,
        FormService $formService,
        AppService $appService,
        AppUserService $appUserService
    ) {
        $this->mysql = $mysql->getConnection();
        $this->formService = $formService;
        $this->appService = $appService;
        $this->appUserService = $appUserService;
    }

    /**
     * Import a pack: create forms, apps, roles, and permissions.
     * Records the installation for future management/uninstall.
     *
     * @param array  $packData Full pack JSON structure
     * @param string $userId   Authenticated user importing the pack
     * @return array { installationId, forms: [{id, title}], apps: [{id, name}] }
     */
    /**
     * @param list<string>|null $approvedConnectorGrants APP-502: when non-null,
     *   the ONLY connector.<id>.<command> grants that may become active — every
     *   requested connector grant not in this set is stripped from BOTH carriers
     *   (app customLogic permissions AND role connector grants) before persist.
     *   Non-connector permissions always pass through.
     *   ⚠ SAFE-001: null (= no review, every requested grant activates) is
     *   reserved for TRUSTED INTERNAL callers only (bundled sample fixtures,
     *   CLI provisioning). Every HTTP import boundary MUST pass an explicit
     *   array — PackController fails closed with 400 grant_review_required
     *   when a request omits it.
     */
    public function importPack(
        array $packData,
        string $userId,
        ?string $catalogId = null,
        ?string $versionId = null,
        ?string $verifiedScreenTrust = null,
        ?array $approvedConnectorGrants = null
    ): array
    {
        // Validate structure
        $this->validatePack($packData);

        $createdFormIds = [];
        $createdAppIds = [];

        // APP-502 grant review: normalize the approved-grant allow-list (null =
        // no review). $withheldGrants accumulates every connector grant the pack
        // requested but the importer did NOT approve, surfaced in the result.
        $approvedSet = $this->normalizeApprovedGrants($approvedConnectorGrants);
        $withheldGrants = [];

        // Prevent duplicate imports of the same pack. A plain SELECT does not lock a
        // not-yet-existing row, so a named lock (per user+pack) serializes concurrent
        // imports — the check-then-insert is otherwise a TOCTOU race (no UNIQUE key).
        $meta = $packData['packMeta'];
        // Marketplace installs dedup on the trusted catalog_id (a community pack
        // may have no packMeta.id, which would otherwise fall back to matching by
        // name); direct JSON imports fall back to the embedded id/name.
        $dedupeKey = $catalogId ?? ($meta['id'] ?? $meta['name'] ?? 'custom');
        $installLock = ($dedupeKey !== 'custom') ? $this->acquireInstallLock($dedupeKey, $userId) : null;
        [$screenTrust, $screenProvenance] = $verifiedScreenTrust !== null
            ? [$verifiedScreenTrust, ['source' => 'signed-package', 'trust' => $verifiedScreenTrust]]
            : $this->screenTrustForImport($catalogId, $versionId, $userId);
        // APP-501: a pack may embed a vendor signature over its screen-
        // component digests — a verified component on an otherwise-untrusted
        // DIRECT import stamps 'verified' honestly (signed-package archives
        // carry their own verdict, so the block is ignored there). Each
        // component is judged by its OWN bytes at stamp time.
        $packSigning = $verifiedScreenTrust !== null ? null : $this->verifyPackSigning($packData);

        $this->mysql->beginTransaction();

        $alreadyInstalled = $catalogId !== null
            ? $this->isCatalogPackInstalled($catalogId, $userId)
            : ($dedupeKey !== 'custom' ? $this->isPackInstalled($dedupeKey, $userId) : null);
        if ($alreadyInstalled) {
            $this->mysql->rollBack();
            $this->releaseInstallLock($installLock);
            throw new \RuntimeException('This pack is already installed');
        }

        try {
            // 1. Build form ID map: packFormId → new UUID
            $formIdMap = [];
            foreach ($packData['forms'] as $packForm) {
                $formIdMap[$packForm['packFormId']] = $this->generateUuid();
            }

            // 2. Create each form
            $formSummary = [];
            foreach ($packData['forms'] as $packForm) {
                $newFormId = $formIdMap[$packForm['packFormId']];

                // Remap @pack: references in linked_record fields
                $fields = $this->remapFieldReferences($packForm['fields'] ?? [], $formIdMap);

                // Strip the pack author's private notification settings (e.g.
                // notificationEmail) so installs don't silently route the installer's
                // response notifications to the author. (Mirrors the output-side
                // stripping; this is the untrusted-input vector.)
                $importSettings = $packForm['settings'] ?? [];
                if (is_array($importSettings)) {
                    unset($importSettings['notifications']);
                }

                $formData = [
                    'id' => $newFormId,
                    'userId' => $userId,
                    'title' => $packForm['title'],
                    'description' => $packForm['description'] ?? null,
                    'status' => 'draft',
                    'settings' => $importSettings,
                    'theme' => $packForm['theme'] ?? [],
                    'logicScript' => $packForm['logicScript'] ?? null,
                    'customScreen' => $this->resolveCustomScreen($packForm['customScreen'] ?? null, $formIdMap),
                    'icon' => $packForm['icon'] ?? null,
                    'fields' => $fields,
                ];

                $this->formService->createForm($formData);
                if (!empty($formData['customScreen'])) {
                    [$formScreenTrust, $formScreenProv] = $this->componentScreenTrust(
                        'form:' . (string) $packForm['packFormId'],
                        $packSigning,
                        $formData['customScreen'],
                        $screenTrust,
                        $screenProvenance
                    );
                    $this->formService->setCustomScreenTrust($newFormId, $formScreenTrust, $formScreenProv);
                }
                $createdFormIds[] = $newFormId;
                $formSummary[] = ['id' => $newFormId, 'title' => $packForm['title']];
            }

            // 3. Create each app
            $appSummary = [];
            $appIdByPackId = [];
            foreach ($packData['apps'] ?? [] as $packApp) {
                // App settings: strip the author's notifications, remap landingPage (@pack:->UUID),
                // and defer defaultRoleId until roles exist (carried as defaultRoleName).
                $appSettings = is_array($packApp['settings'] ?? null) ? $packApp['settings'] : [];
                unset($appSettings['notifications']);
                $lp = $appSettings['landingPage'] ?? null;
                if (is_string($lp) && str_starts_with($lp, '@pack:')) {
                    $appSettings['landingPage'] = $formIdMap[substr($lp, 6)] ?? 'dashboard';
                }
                $defaultRoleName = $appSettings['defaultRoleName'] ?? null;
                unset($appSettings['defaultRoleName'], $appSettings['defaultRoleId']);

                // Pack services (wave 1): compose the owner-facing enable/disable map from the
                // pack's declaration. The declaration is authoritative — any raw settings.services
                // riding in the pack's app settings is dropped first (an absent entry means
                // ENABLED at runtime, so dropping strays is behavior-neutral and un-spoofable).
                unset($appSettings['services']);
                // PKG-102: `features` is the v2 name for App Feature declarations; `services` is
                // the accepted v1 alias. Runtime storage stays settings.services (unchanged key).
                $declaredServices = is_array($packApp['features'] ?? null)
                    ? $packApp['features']
                    : (is_array($packApp['services'] ?? null) ? $packApp['services'] : []);
                if ($declaredServices !== []) {
                    $servicesMap = [];
                    foreach ($declaredServices as $svc) {
                        $servicesMap[(string) $svc['id']] = [
                            'enabled' => ($svc['defaultEnabled'] ?? true) !== false,
                            'title' => (string) $svc['title'],
                            'description' => (string) $svc['description'],
                        ];
                    }
                    $appSettings['services'] = $servicesMap;
                }

                // navConfig: remap each item.formId (@pack:->UUID); drop items pointing at a missing form.
                $navConfig = [];
                foreach ((is_array($packApp['navConfig'] ?? null) ? $packApp['navConfig'] : []) as $item) {
                    $fid = $item['formId'] ?? null;
                    if (is_string($fid) && str_starts_with($fid, '@pack:')) {
                        $key = substr($fid, 6);
                        if (!isset($formIdMap[$key])) {
                            continue;
                        }
                        $item['formId'] = $formIdMap[$key];
                    }
                    $navConfig[] = $item;
                }

                $appData = [
                    'name' => $packApp['name'],
                    'description' => $packApp['description'] ?? null,
                    'settings' => $appSettings,
                    'theme' => $packApp['theme'] ?? [],
                    'logoUrl' => $packApp['logoUrl'] ?? null,
                    'navConfig' => $navConfig,
                    'customScreen' => $this->resolveCustomScreen($packApp['customScreen'] ?? null, $formIdMap),
                    // Sandboxed QuickJS app-logic bundle. References fields by their stable ids (not @pack:
                    // remapped) and is bounded by the client sandbox + permission model at runtime.
                    // APP-502: unapproved connector grants are stripped here before persist.
                    'customLogic' => $this->reviewCustomLogicGrants(
                        is_array($packApp['customLogic'] ?? null) ? $packApp['customLogic'] : null,
                        $approvedSet,
                        $withheldGrants
                    ),
                ];
                $app = $this->appService->createApp($appData, $userId);
                $appId = $app['id'];
                if (!empty($appData['customScreen'])) {
                    [$appScreenTrust, $appScreenProv] = $this->componentScreenTrust(
                        'app:' . (string) $packApp['packAppId'],
                        $packSigning,
                        $appData['customScreen'],
                        $screenTrust,
                        $screenProvenance
                    );
                    $this->appService->setCustomScreenTrust($appId, $appScreenTrust, $appScreenProv);
                }
                $createdAppIds[] = $appId;
                $appIdByPackId[(string) $packApp['packAppId']] = $appId;

                // 4. Add forms to app with remapped IDs, preserving order + visibility + per-form settings.
                $memberForms = $packApp['forms'] ?? [];
                usort($memberForms, fn ($a, $b) => ($a['sortOrder'] ?? 0) <=> ($b['sortOrder'] ?? 0));
                foreach ($memberForms as $appForm) {
                    $realFormId = $formIdMap[$appForm['packFormId']] ?? null;
                    if ($realFormId) {
                        $this->appService->addFormToApp(
                            $appId,
                            $realFormId,
                            $appForm['displayName'] ?? null
                        );
                        $meta = [];
                        if (array_key_exists('isVisible', $appForm)) {
                            $meta['isVisible'] = (bool) $appForm['isVisible'];
                        }
                        // Stable machine alias (audit FL-007): the pack's form key
                        // is stamped into app_forms.settings so app-logic resolves
                        // records by it forever — retitling the form changes nothing.
                        $settings = isset($appForm['settings']) && is_array($appForm['settings'])
                            ? $appForm['settings']
                            : [];
                        $settings['packFormId'] = (string) $appForm['packFormId'];
                        $meta['settings'] = $settings;
                        $this->appService->updateAppForm($appId, $realFormId, $meta);
                    }
                }

                // 5. Roles: custom roles are created; a `system` role (Admin/Member) applies its permission
                //    overrides to the same-named system role createApp already made (so customizations
                //    round-trip). Owner is never in the pack (recreated with all permissions).
                $sysRolesByName = null; // lazily fetched map name => role
                foreach ($packApp['roles'] ?? [] as $packRole) {
                    $permissions = [];
                    foreach ($packRole['permissions'] ?? [] as $perm) {
                        if (isset($perm['packFormId']) && $perm['packFormId'] !== null) {
                            $realFormId = $formIdMap[$perm['packFormId']] ?? null;
                            if ($realFormId) {
                                $permissions[] = ['formId' => $realFormId, 'permission' => $perm['permission']];
                            }
                        } else {
                            $permissions[] = ['formId' => null, 'permission' => $perm['permission']];
                        }
                    }
                    // Packs ship working flows: their roles predate the execute_flows permission
                    // (FL-AUTH-001), so grant it to every imported role that gets ANY permissions
                    // unless the pack says otherwise. Owners can revoke it in the role editor.
                    $hasExecuteFlows = false;
                    foreach ($permissions as $p) {
                        if (($p['permission'] ?? null) === \FormLogic\Constants\AppPermissions::EXECUTE_FLOWS) {
                            $hasExecuteFlows = true;
                            break;
                        }
                    }
                    if (!empty($permissions) && !$hasExecuteFlows) {
                        $permissions[] = ['formId' => null, 'permission' => \FormLogic\Constants\AppPermissions::EXECUTE_FLOWS];
                    }

                    // APP-502: strip unapproved connector grants from the role's
                    // permission set — this feeds BOTH setRolePermissions and
                    // setConnectorGrants, so a withheld grant persists in neither.
                    if ($approvedSet !== null) {
                        $kept = [];
                        foreach ($permissions as $p) {
                            $perm = (string) ($p['permission'] ?? '');
                            if (!$this->isReviewableConnectorGrant($perm) || isset($approvedSet[$perm])) {
                                $kept[] = $p;
                            } else {
                                $withheldGrants[$perm] = true;
                            }
                        }
                        $permissions = $kept;
                    }

                    if (!empty($packRole['system'])) {
                        if ($sysRolesByName === null) {
                            $sysRolesByName = [];
                            foreach ($this->appUserService->getRoles($appId) as $sr) {
                                if (!empty($sr['isSystem'])) {
                                    $sysRolesByName[$sr['name']] = $sr;
                                }
                            }
                        }
                        $target = $sysRolesByName[$packRole['name'] ?? ''] ?? null;
                        // Never let an import escalate Owner; only Admin/Member overrides apply.
                        if ($target && ($target['name'] ?? '') !== 'Owner' && !empty($permissions)) {
                            $this->appUserService->setRolePermissions($target['id'], $permissions, true);
                            // Connector capability grants (connector.<id>.<command>) go through the
                            // owner-only path so pack-defined member connector access actually persists.
                            $this->appUserService->setConnectorGrants($target['id'], $permissions, true);
                        }
                        continue;
                    }

                    $role = $this->appUserService->createRole($appId, [
                        'name' => $packRole['name'],
                        'description' => $packRole['description'] ?? null,
                    ]);
                    if (!empty($permissions)) {
                        // The importer owns the freshly created app, so they may grant the app-level
                        // permissions the pack defines (else an admin-style role would be uninstallable).
                        $this->appUserService->setRolePermissions($role['id'], $permissions, true);
                        // ...and the connector capability grants (owner-only path).
                        $this->appUserService->setConnectorGrants($role['id'], $permissions, true);
                    }
                }

                // Resolve the default role (carried by name) to the new role id now that roles exist.
                if ($defaultRoleName !== null && $defaultRoleName !== '') {
                    foreach ($this->appUserService->getRoles($appId) as $rn) {
                        if (($rn['name'] ?? null) === $defaultRoleName) {
                            $appSettings['defaultRoleId'] = $rn['id'];
                            $this->appService->updateApp($appId, ['settings' => $appSettings]);
                            break;
                        }
                    }
                }

                // 6. Pre-configured reports (charts + PDF documents): resolve @pack: refs → real form ids.
                if (!empty($packApp['reports']) && is_array($packApp['reports'])) {
                    $reports = $this->resolvePackReports($packApp['reports'], $formIdMap);
                    if ($reports) {
                        $this->appService->updateApp($appId, ['reports' => $reports]);
                    }
                }

                $appSummary[] = ['id' => $appId, 'name' => $packApp['name']];
            }

            // 6. FormLogic Flows: flow definitions + event bindings for the imported app(s), created
            //    inside the SAME transaction with @pack: form refs remapped to the new form ids.
            $this->importPackFlows($packData, $appIdByPackId, $formIdMap, $userId);

            // 7. Record the installation
            $installationId = $this->generateUuid();
            $meta = $packData['packMeta'];
            $stmt = $this->mysql->prepare("
                INSERT INTO pack_installations (id, user_id, pack_id, catalog_id, version_id, pack_name, pack_version, pack_description, form_ids, app_ids)
                VALUES (:id, :user_id, :pack_id, :catalog_id, :version_id, :pack_name, :pack_version, :pack_description, :form_ids, :app_ids)
            ");
            $stmt->execute([
                'id' => $installationId,
                'user_id' => $userId,
                'pack_id' => $meta['id'] ?? $meta['name'] ?? 'custom',
                'catalog_id' => $catalogId,
                'version_id' => $versionId,
                'pack_name' => $meta['name'] ?? 'Unknown Pack',
                'pack_version' => $meta['version'] ?? '1.0.0',
                'pack_description' => $meta['description'] ?? null,
                'form_ids' => json_encode($createdFormIds),
                'app_ids' => json_encode($createdAppIds),
            ]);

            $this->mysql->commit();
            $this->releaseInstallLock($installLock);

            $withheld = array_keys($withheldGrants);
            sort($withheld, SORT_STRING);
            return [
                'installationId' => $installationId,
                'forms' => $formSummary,
                'apps' => $appSummary,
                // APP-502: connector grants the pack requested that the importer
                // did not approve (empty when no review ran / all approved).
                'withheldGrants' => $withheld,
            ];

        } catch (\Exception $e) {
            $this->mysql->rollBack();
            $this->releaseInstallLock($installLock);

            // Clean up any created forms (SQLite databases)
            foreach ($createdFormIds as $fid) {
                try {
                    $this->formService->deleteForm($fid);
                } catch (\Exception $cleanupError) {
                    // Ignore cleanup errors
                }
            }

            throw $e;
        }
    }

    /**
     * FormLogic Flows: create flow_definitions + app_flow_bindings for imported apps (called INSIDE
     * importPack's transaction so a failed flow insert rolls the whole import back). Re-runs the
     * FlowService sanitizers (defense in depth over validatePack) and remaps @pack:<packFormId>
     * references — the binding's formId and every outputActions[].form — to the new form ids.
     * Raw (non-@pack:) form refs from a pack are never trusted: the binding formId is dropped and
     * an action pointing at an unknown pack form fails the import loudly.
     *
     * @param array<string,string> $appIdByPackId packAppId => new app id
     * @param array<string,string> $formIdMap     packFormId => new form id
     */
    private function importPackFlows(array $packData, array $appIdByPackId, array $formIdMap, string $userId): void
    {
        $packFlows = is_array($packData['flows'] ?? null) ? $packData['flows'] : [];
        $packBindings = is_array($packData['flowBindings'] ?? null) ? $packData['flowBindings'] : [];
        if (empty($packFlows) && empty($packBindings)) {
            return;
        }
        $firstAppId = array_values($appIdByPackId)[0] ?? null;
        if ($firstAppId === null) {
            throw new \RuntimeException('Pack flows require at least one app');
        }
        $resolveApp = function (mixed $packAppId) use ($appIdByPackId, $firstAppId): string {
            if (!is_string($packAppId) || $packAppId === '') {
                return $firstAppId;
            }
            return $appIdByPackId[$packAppId]
                ?? throw new \RuntimeException("Flow references unknown packAppId '{$packAppId}'");
        };

        // Flows first (bindings reference them by slug within their app).
        $flowIdBySlug = []; // "<appId>|<slug>" => flow id
        foreach ($packFlows as $packFlow) {
            if (!is_array($packFlow)) {
                continue;
            }
            $appId = $resolveApp($packFlow['packAppId'] ?? null);
            $slug = FlowService::sanitizeSlug($packFlow['slug'] ?? null);
            $flowJson = FlowService::sanitizeFlowJson($packFlow['flowJson'] ?? ['nodes' => [], 'edges' => []]);
            // Node-level form refs (formlogic_list/submit/update nodes carry data.form/formId as
            // '@pack:<packFormId>') are remapped like binding formIds; an unknown ref fails loudly.
            $flowJson = $this->resolveFlowJsonFormRefs($flowJson, $formIdMap, $slug);
            $nodeCaps = null;
            if (is_array($packFlow['nodeCapabilities'] ?? null)) {
                $caps = array_values(array_filter($packFlow['nodeCapabilities'], static fn ($c) => is_string($c) && $c !== '' && strlen($c) <= 128));
                $nodeCaps = $caps !== [] ? array_slice($caps, 0, 64) : null;
            }
            $flowId = $this->generateUuid();
            $stmt = $this->mysql->prepare("
                INSERT INTO flow_definitions
                    (id, owner_user_id, app_id, name, slug, description, engine, flow_json, input_schema, output_schema, node_capabilities, version, enabled)
                VALUES
                    (:id, :owner, :app, :name, :slug, :descr, 'f2i', :flow_json, :input_schema, :output_schema, :node_caps, 1, :enabled)
            ");
            $stmt->execute([
                'id' => $flowId,
                'owner' => $userId,
                'app' => $appId,
                'name' => (string) ($packFlow['name'] ?? $slug),
                'slug' => $slug,
                'descr' => isset($packFlow['description']) && is_string($packFlow['description']) ? substr($packFlow['description'], 0, 2000) : null,
                'flow_json' => json_encode($flowJson),
                'input_schema' => is_array($packFlow['inputSchema'] ?? null) ? json_encode($packFlow['inputSchema']) : null,
                'output_schema' => is_array($packFlow['outputSchema'] ?? null) ? json_encode($packFlow['outputSchema']) : null,
                'node_caps' => $nodeCaps !== null ? json_encode($nodeCaps) : null,
                'enabled' => (array_key_exists('enabled', $packFlow) ? (bool) $packFlow['enabled'] : true) ? 1 : 0,
            ]);
            $flowIdBySlug[$appId . '|' . $slug] = $flowId;
        }

        foreach ($packBindings as $packBinding) {
            if (!is_array($packBinding)) {
                continue;
            }
            $appId = $resolveApp($packBinding['packAppId'] ?? null);
            $clean = FlowService::sanitizeBinding($packBinding);
            $flowId = $flowIdBySlug[$appId . '|' . $clean['flow']]
                ?? throw new \RuntimeException("Flow binding references unknown flow '{$clean['flow']}'");

            // Binding formId: only @pack: refs are honored (never trust a raw UUID from a pack).
            $formId = null;
            $fRef = $packBinding['formId'] ?? null;
            if (is_string($fRef) && str_starts_with($fRef, '@pack:')) {
                $formId = $formIdMap[substr($fRef, 6)]
                    ?? throw new \RuntimeException("Flow binding references unknown packFormId '" . substr($fRef, 6) . "'");
            }

            // outputActions[].form: remap @pack: refs; an unknown ref fails loudly, a raw id is dropped.
            $actions = $clean['outputActions'];
            if ($actions !== null) {
                foreach ($actions as &$action) {
                    $ref = $action['form'] ?? null;
                    if (is_string($ref) && str_starts_with($ref, '@pack:')) {
                        $action['form'] = $formIdMap[substr($ref, 6)]
                            ?? throw new \RuntimeException("Flow binding output action references unknown packFormId '" . substr($ref, 6) . "'");
                    } elseif ($ref !== null) {
                        unset($action['form']);
                    }
                }
                unset($action);
            }

            $connectorId = (isset($packBinding['connectorId']) && is_string($packBinding['connectorId']) && $packBinding['connectorId'] !== '')
                ? substr($packBinding['connectorId'], 0, 64) : null;

            $stmt = $this->mysql->prepare("
                INSERT INTO app_flow_bindings
                    (id, app_id, form_id, connector_id, flow_definition_id, event_name, mode, condition_json,
                     input_map_json, output_actions_json, timeout_ms, retry_policy_json, fallback_policy_json, enabled, sort_order)
                VALUES
                    (:id, :app, :form, :connector, :flow, :event, :mode, :cond, :input_map, :actions, :timeout, :retry, :fallback, :enabled, :sort)
            ");
            $stmt->execute([
                'id' => $this->generateUuid(),
                'app' => $appId,
                'form' => $formId,
                'connector' => $connectorId,
                'flow' => $flowId,
                'event' => $clean['event'],
                'mode' => $clean['mode'],
                'cond' => $clean['condition'] !== null ? json_encode($clean['condition']) : null,
                'input_map' => $clean['inputMap'] !== null ? json_encode($clean['inputMap']) : null,
                'actions' => $actions !== null ? json_encode($actions) : null,
                'timeout' => $clean['timeoutMs'],
                'retry' => $clean['retryPolicy'] !== null ? json_encode($clean['retryPolicy']) : null,
                'fallback' => $clean['fallbackPolicy'] !== null ? json_encode($clean['fallbackPolicy']) : null,
                'enabled' => $clean['enabled'] ? 1 : 0,
                'sort' => (int) ($packBinding['sortOrder'] ?? 0),
            ]);
        }
    }

    /**
     * Remap '@pack:<packFormId>' form references inside a flow graph's node data (the
     * `form` / `formId` keys used by formlogic_list_responses / formlogic_submit_response /
     * formlogic_update_response nodes) to the freshly created form ids. An unknown ref fails
     * the import loudly — a flow silently pointing at a missing form would only fail at run
     * time. Non-@pack strings pass through untouched (selectors like '$inputs.formId').
     *
     * @param array<string,string> $formIdMap packFormId => new form id
     */
    public function resolveFlowJsonFormRefs(array $flowJson, array $formIdMap, string $flowSlug): array
    {
        foreach ($flowJson['nodes'] as &$node) {
            if (!is_array($node) || !is_array($node['data'] ?? null)) {
                continue;
            }
            foreach (['form', 'formId'] as $key) {
                $ref = $node['data'][$key] ?? null;
                if (is_string($ref) && str_starts_with($ref, '@pack:')) {
                    $node['data'][$key] = $formIdMap[substr($ref, 6)]
                        ?? throw new \RuntimeException(
                            "Flow '{$flowSlug}' node '" . ($node['id'] ?? '?') . "' references unknown packFormId '" . substr($ref, 6) . "'"
                        );
                }
            }
        }
        unset($node);
        return $flowJson;
    }

    /**
     * Inverse of resolveFlowJsonFormRefs for export: rewrite real form ids in flow node data to
     * portable '@pack:<key>' refs. A ref to a form outside the exported set is left for the
     * caller's leak scrub only if unknown — since flows are app-scoped and the export covers
     * every member form, unknown refs are dropped to avoid leaking foreign UUIDs.
     *
     * @param array<string,string> $realToPackKey real form id => packFormId
     */
    private function packifyFlowJsonFormRefs(array $flowJson, array $realToPackKey): array
    {
        if (!is_array($flowJson['nodes'] ?? null)) {
            return $flowJson;
        }
        foreach ($flowJson['nodes'] as &$node) {
            if (!is_array($node) || !is_array($node['data'] ?? null)) {
                continue;
            }
            foreach (['form', 'formId'] as $key) {
                $ref = $node['data'][$key] ?? null;
                if (!is_string($ref) || $ref === '' || str_starts_with($ref, '@pack:') || str_starts_with($ref, '$')) {
                    continue;
                }
                if (isset($realToPackKey[$ref])) {
                    $node['data'][$key] = '@pack:' . $realToPackKey[$ref];
                } else {
                    unset($node['data'][$key]); // foreign/unknown id — never leak it
                }
            }
        }
        unset($node);
        return $flowJson;
    }

    /**
     * Export a whole app as a self-contained Pack (the app + ALL its member forms incl. fields,
     * logicScript and customScreen, the app's custom home screen / settings / theme / navConfig,
     * membership metadata, and custom roles). The result round-trips through importPack().
     *
     * Portable + safe by construction: this WHITELISTS fields and emits only local pack keys and
     * @pack: references — never real UUIDs, owner ids, members, responses, or secrets.
     *
     * @return array PackData
     */
    public function exportApp(string $appId, string $userId): array
    {
        $app = $this->appService->getApp($appId);
        if (!$app || ($app['ownerId'] ?? null) !== $userId) {
            throw new \RuntimeException('App not found');
        }

        $appForms = $this->appService->getAppForms($appId); // ordered by sort_order

        // Stable real-formId -> packFormId (slug) map, built first so cross-form links resolve.
        $realToPackKey = [];
        $usedKeys = [];
        $loadedForms = [];
        foreach ($appForms as $af) {
            $form = $this->formService->getForm($af['formId']);
            if (!$form) {
                continue;
            }
            $loadedForms[$af['formId']] = $form;
            $realToPackKey[$af['formId']] = $this->uniqueSlug((string) ($form['title'] ?? 'form'), $usedKeys);
        }

        // Build pack forms (whitelist; strip the author's notification settings).
        $packForms = [];
        foreach ($appForms as $af) {
            $form = $loadedForms[$af['formId']] ?? null;
            if (!$form) {
                continue;
            }
            $settings = is_array($form['settings'] ?? null) ? $form['settings'] : [];
            unset($settings['notifications']);
            $entry = [
                'packFormId' => $realToPackKey[$af['formId']],
                'title' => $form['title'] ?? 'Untitled',
                'description' => $form['description'] ?? null,
                'icon' => $form['icon'] ?? null,
                'settings' => $this->jsonObject($settings),
                'theme' => $this->jsonObject($form['theme'] ?? []),
                'fields' => $this->packifyFieldReferences($form['fields'] ?? [], $realToPackKey),
            ];
            if (!empty($form['logicScript'])) {
                $entry['logicScript'] = $form['logicScript'];
            }
            if (!empty($form['customScreen'])) {
                $entry['customScreen'] = $this->packifyCustomScreen($form['customScreen'], $realToPackKey);
            }
            $packForms[] = $entry;
        }

        if (empty($packForms)) {
            throw new \RuntimeException('This app has no forms to export');
        }

        // Roles (for default-role name mapping + exporting custom roles).
        $roles = $this->appUserService->getRoles($appId);
        $roleNameById = [];
        foreach ($roles as $r) {
            $roleNameById[$r['id']] = $r['name'] ?? null;
        }

        // App settings: drop PII + remap instance ids to portable references.
        $appSettings = is_array($app['settings'] ?? null) ? $app['settings'] : [];
        unset($appSettings['notifications'], $appSettings['notificationEmail']);
        if (!empty($appSettings['defaultRoleId']) && isset($roleNameById[$appSettings['defaultRoleId']])) {
            $appSettings['defaultRoleName'] = $roleNameById[$appSettings['defaultRoleId']];
        }
        unset($appSettings['defaultRoleId']);
        $lp = $appSettings['landingPage'] ?? null;
        if (is_string($lp) && $lp !== '' && $lp !== 'dashboard') {
            $appSettings['landingPage'] = isset($realToPackKey[$lp]) ? '@pack:' . $realToPackKey[$lp] : 'dashboard';
        }

        // Pack services: settings.services (the installed enable/disable map) exports as the
        // portable `services` DECLARATION — defaultEnabled reflects the CURRENT enabled state
        // so importing the export reproduces this app's behavior. The raw map never rides in
        // the exported settings (import recomposes it from the declaration).
        $exportServices = [];
        foreach ((is_array($appSettings['services'] ?? null) ? $appSettings['services'] : []) as $sid => $svc) {
            if (!is_string($sid) || $sid === '' || !is_array($svc)) {
                continue;
            }
            $exportServices[] = [
                'id' => $sid,
                'title' => is_string($svc['title'] ?? null) && $svc['title'] !== '' ? $svc['title'] : $sid,
                'description' => is_string($svc['description'] ?? null) ? $svc['description'] : '',
                'defaultEnabled' => ($svc['enabled'] ?? true) !== false,
            ];
        }
        unset($appSettings['services']);

        // navConfig: remap each item.formId to @pack:<key>; drop items pointing outside the app.
        $navConfig = [];
        foreach ((is_array($app['navConfig'] ?? null) ? $app['navConfig'] : []) as $item) {
            $fid = $item['formId'] ?? null;
            if ($fid !== null && $fid !== '') {
                if (!isset($realToPackKey[$fid])) {
                    continue;
                }
                $item['formId'] = '@pack:' . $realToPackKey[$fid];
            }
            $navConfig[] = $item;
        }

        // Membership metadata.
        $packAppForms = [];
        foreach ($appForms as $af) {
            if (!isset($realToPackKey[$af['formId']])) {
                continue;
            }
            $packAppForms[] = [
                'packFormId' => $realToPackKey[$af['formId']],
                'displayName' => $af['displayName'] ?? null,
                'sortOrder' => $af['sortOrder'] ?? 0,
                'isVisible' => $af['isVisible'] ?? true,
                'settings' => $this->jsonObject($af['settings'] ?? []),
            ];
        }

        // Custom roles + non-Owner system roles (Admin/Member) so permission customizations round-trip.
        // Owner is skipped (recreated with all permissions; never an import-escalation path).
        $packRoles = [];
        foreach ($roles as $r) {
            if (!empty($r['isSystem']) && ($r['name'] ?? '') === 'Owner') {
                continue;
            }
            $perms = [];
            foreach ($r['permissions'] ?? [] as $p) {
                $fid = $p['formId'] ?? null;
                if ($fid !== null && $fid !== '') {
                    if (!isset($realToPackKey[$fid])) {
                        continue; // permission on a form outside the app
                    }
                    $perms[] = ['packFormId' => $realToPackKey[$fid], 'permission' => $p['permission']];
                } else {
                    $perms[] = ['packFormId' => null, 'permission' => $p['permission']];
                }
            }
            $packRoles[] = [
                'name' => $r['name'] ?? 'Role',
                'description' => $r['description'] ?? null,
                'system' => !empty($r['isSystem']),
                'permissions' => $perms,
            ];
        }

        $packApp = [
            'packAppId' => $this->slugify((string) ($app['name'] ?? 'app')),
            'name' => $app['name'] ?? 'App',
            'description' => $app['description'] ?? null,
            'logoUrl' => $app['logoUrl'] ?? null,
            'settings' => $this->jsonObject($appSettings),
            'theme' => $this->jsonObject($app['theme'] ?? []),
            'navConfig' => $navConfig,
            'forms' => $packAppForms,
            'roles' => $packRoles,
        ];
        if ($exportServices !== []) {
            $packApp['services'] = $exportServices;
        }
        if (!empty($app['customScreen'])) {
            $packApp['customScreen'] = $this->packifyCustomScreen($app['customScreen'], $realToPackKey);
        }
        // Custom app-logic round-trips verbatim: it references form fields by their stable string ids
        // (not @pack: refs), so there is nothing to remap.
        if (!empty($app['customLogic']) && is_array($app['customLogic'])) {
            $packApp['customLogic'] = $app['customLogic'];
        }
        // Reports (charts + PDF documents): rewrite real form ids → @pack: refs so they round-trip.
        if (!empty($app['reports']) && is_array($app['reports'])) {
            $packReports = $this->packifyReports($app['reports'], $realToPackKey);
            if ($packReports) {
                $packApp['reports'] = $packReports;
            }
        }

        $pack = [
            'formatVersion' => 1,
            'packMeta' => [
                'name' => $app['name'] ?? 'App',
                'description' => $app['description'] ?? '',
                'version' => '1.0.0',
                'tags' => [],
            ],
            'forms' => $packForms,
            'apps' => [$packApp],
        ];

        // FormLogic Flows: export the app's flow library + bindings with @pack: form refs.
        [$packFlows, $packFlowBindings] = $this->packifyFlows($appId, $realToPackKey);
        if (!empty($packFlows)) {
            $pack['flows'] = $packFlows;
        }
        if (!empty($packFlowBindings)) {
            $pack['flowBindings'] = $packFlowBindings;
        }

        // Fail fast with a clear message if the app exceeds pack size caps.
        $this->validatePack($pack);

        return $pack;
    }

    /**
     * Export an app's flow definitions + bindings as portable pack entries. Form references (the
     * binding's formId + outputActions[].form) are rewritten to @pack:<key>; a binding whose formId
     * points outside the app is dropped, and an action's foreign form ref is stripped — real UUIDs
     * never leak into a pack (mirrors packifyFieldReferences).
     *
     * @param array<string,string> $realToPackKey real form id => packFormId (slug)
     * @return array{0: array[], 1: array[]} [flows, flowBindings]
     */
    private function packifyFlows(string $appId, array $realToPackKey): array
    {
        $flowStmt = $this->mysql->prepare("SELECT * FROM flow_definitions WHERE app_id = :a ORDER BY created_at ASC, id ASC");
        $flowStmt->execute(['a' => $appId]);
        $flowRows = $flowStmt->fetchAll();
        if (empty($flowRows)) {
            return [[], []];
        }

        $packFlows = [];
        foreach ($flowRows as $fr) {
            $flowJson = json_decode((string) $fr['flow_json'], true);
            $entry = [
                'slug' => $fr['slug'],
                'name' => $fr['name'],
                'engine' => $fr['engine'],
                // Node-level form refs become portable '@pack:<key>' (inverse of the import remap).
                'flowJson' => is_array($flowJson)
                    ? $this->packifyFlowJsonFormRefs($flowJson, $realToPackKey)
                    : ['nodes' => [], 'edges' => []],
                'enabled' => (bool) $fr['enabled'],
            ];
            if (!empty($fr['description'])) {
                $entry['description'] = $fr['description'];
            }
            foreach (['input_schema' => 'inputSchema', 'output_schema' => 'outputSchema', 'node_capabilities' => 'nodeCapabilities'] as $col => $key) {
                if (!empty($fr[$col])) {
                    $decoded = json_decode((string) $fr[$col], true);
                    if (is_array($decoded)) {
                        $entry[$key] = $decoded;
                    }
                }
            }
            $packFlows[] = $entry;
        }

        $bStmt = $this->mysql->prepare("
            SELECT b.*, f.slug AS flow_slug
            FROM app_flow_bindings b
            JOIN flow_definitions f ON f.id = b.flow_definition_id
            WHERE b.app_id = :a
            ORDER BY b.sort_order ASC, b.created_at ASC, b.id ASC
        ");
        $bStmt->execute(['a' => $appId]);

        $packBindings = [];
        foreach ($bStmt->fetchAll() as $row) {
            $entry = [
                'flow' => $row['flow_slug'],
                'event' => $row['event_name'],
                'mode' => $row['mode'],
                'timeoutMs' => (int) $row['timeout_ms'],
                'enabled' => (bool) $row['enabled'],
                'sortOrder' => (int) $row['sort_order'],
            ];
            if (!empty($row['form_id'])) {
                if (!isset($realToPackKey[$row['form_id']])) {
                    continue; // binding on a form outside the app — never leak the UUID
                }
                $entry['formId'] = '@pack:' . $realToPackKey[$row['form_id']];
            }
            if (!empty($row['connector_id'])) {
                $entry['connectorId'] = $row['connector_id'];
            }
            foreach (['condition_json' => 'condition', 'input_map_json' => 'inputMap', 'retry_policy_json' => 'retryPolicy', 'fallback_policy_json' => 'fallbackPolicy'] as $col => $key) {
                if (!empty($row[$col])) {
                    $decoded = json_decode((string) $row[$col], true);
                    if (is_array($decoded)) {
                        $entry[$key] = $decoded;
                    }
                }
            }
            if (!empty($row['output_actions_json'])) {
                $actions = json_decode((string) $row['output_actions_json'], true);
                if (is_array($actions)) {
                    foreach ($actions as &$action) {
                        $ref = $action['form'] ?? null;
                        if (is_string($ref) && $ref !== '') {
                            if (isset($realToPackKey[$ref])) {
                                $action['form'] = '@pack:' . $realToPackKey[$ref];
                            } else {
                                unset($action['form']); // foreign form — strip, never leak
                            }
                        }
                    }
                    unset($action);
                    $entry['outputActions'] = array_values($actions);
                }
            }
            $packBindings[] = $entry;
        }

        return [$packFlows, $packBindings];
    }

    /**
     * Export an app as a full .formlogic ARCHIVE (spec §29): a ZIP bundling
     *   manifest.json  — the ApplicationPackageManifest (id/name/version/description + a content hash)
     *   pack.json      — the existing exportApp() payload (the atomic importer's source of truth)
     *   quickjs/customLogic.json — the app's sandboxed QuickJS bundle, if any
     *   assets/*       — inline data-URI assets decoded to real files, if any
     *   launch.json / native.json — launch + native runtime config, if present on the app
     *   signature.json — a DETACHED signature over the CANONICAL manifest.json (SigningService). The manifest
     *                    carries a sha256 of EVERY archive entry (manifest.entries), so the single detached
     *                    signature transitively covers pack.json AND every envelope file — a tampered
     *                    quickjs/launch/native/asset is detected on import even though it lives outside pack.json.
     * Returns the path to a temp .zip the caller must stream then delete.
     *
     * $signing is passed in (not a constructor dep) so the export/import surface stays additive over the
     * existing PackService wiring; when absent the archive is unsigned (importers treat it as community).
     */
    public function exportApplicationPackage(string $appId, string $userId, ?SigningService $signing = null): string
    {
        // Reuse the owner-checked, whitelisted, @pack:-remapped pack builder verbatim.
        $pack = $this->exportApp($appId, $userId);
        $app = $this->appService->getApp($appId) ?? [];
        $packApp = $pack['apps'][0] ?? [];

        $name = (string) ($pack['packMeta']['name'] ?? 'App');
        $version = (string) ($pack['packMeta']['version'] ?? '1.0.0');
        $slug = $this->slugify((string) ($packApp['packAppId'] ?? $name));

        // Canonical pack JSON (unescaped slashes) — hashed into the manifest and covered by the signed manifest.
        $packJson = (string) json_encode($pack, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);

        // Collect EVERY archive entry (name => bytes) the importer may consume, so the manifest can carry a
        // sha256 of each and the detached signature (over the manifest) transitively covers all of them. This
        // closes the gap where a signature over pack.json alone left the envelope files (quickjs/launch/native/
        // assets) tamperable inside an otherwise "signed" ZIP.
        $entries = ['pack.json' => $packJson];

        // quickjs/ — the sandboxed app-logic bundle (also embedded in pack.json for the atomic import;
        // surfaced here as a discrete file for external tooling / capability review).
        if (!empty($packApp['customLogic']) && is_array($packApp['customLogic'])) {
            $entries['quickjs/customLogic.json'] = (string) json_encode($packApp['customLogic'], JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
        }

        // launch.json / native.json — only if the app record carries them (per-domain configs live
        // elsewhere; these are future-proofed and simply omitted when absent).
        if (is_array($app['launch'] ?? null) && !empty($app['launch'])) {
            $entries['launch.json'] = (string) json_encode($app['launch'], JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
        }
        if (is_array($app['native'] ?? null) && !empty($app['native'])) {
            $entries['native.json'] = (string) json_encode($app['native'], JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
        }

        // assets/ — decode any inline data-URI assets to real files under a safe key.
        foreach ((is_array($app['assets'] ?? null) ? $app['assets'] : []) as $key => $dataUri) {
            if (!is_string($key) || !is_string($dataUri) || !PackFileService::isSafeZipEntryName('assets/' . $key)) {
                continue;
            }
            $decoded = $this->decodeDataUri($dataUri);
            if ($decoded !== null && strlen($decoded) <= PackFileService::MAX_ASSET_BYTES) {
                $entries['assets/' . $key] = $decoded;
            }
        }

        // Per-entry content hashes: the SIGNED manifest binds each archive entry, so a tampered envelope
        // file is detected on import (its recomputed sha256 will not match the signed hash).
        $entryHashes = [];
        foreach ($entries as $entryName => $bytes) {
            $entryHashes[$entryName] = hash('sha256', $bytes);
        }
        $contentHash = 'sha256:' . $entryHashes['pack.json'];

        $manifest = [
            'version' => 1,
            'kind' => 'formlogic.applicationPackage',
            'id' => $slug,
            'name' => $name,
            'description' => (string) ($pack['packMeta']['description'] ?? ''),
            'packVersion' => $version,
            'contentHash' => $contentHash,
            // Signed per-entry manifest (Option A): { "pack.json": "<sha256hex>", ... } for every entry above.
            'entries' => $entryHashes,
            'capabilities' => PackCapabilities::describe($pack),
        ];

        $zipPath = (string) tempnam(sys_get_temp_dir(), 'flapp_');
        $zip = new \ZipArchive();
        if ($zip->open($zipPath, \ZipArchive::CREATE | \ZipArchive::OVERWRITE) !== true) {
            @unlink($zipPath);
            throw new \RuntimeException('Failed to create application package archive');
        }

        $zip->addFromString('manifest.json', (string) json_encode($manifest, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT));
        foreach ($entries as $entryName => $bytes) {
            $zip->addFromString($entryName, $bytes);
        }

        // Detached signature over the CANONICAL manifest (which binds every entry via its sha256). A verifier
        // can therefore trust manifest.entries and, through it, every file the importer consumes.
        if ($signing !== null) {
            $signed = $signing->sign($manifest);
            $zip->addFromString('signature.json', (string) json_encode([
                'signature' => $signed['signature'],
                'alg' => $signed['alg'],
                'keyId' => $signed['keyId'],
                'contentHash' => $contentHash,
            ], JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT));
        }

        $zip->close();
        return $zipPath;
    }

    /**
     * Parse + verify a .formlogic ARCHIVE without importing anything. Shared by the describe/review
     * path (SAFE-001: an archive must be reviewable BEFORE install) and importApplicationPackage(),
     * so review and import can never diverge on what an archive contains. Opens the ZIP, validates
     * EVERY entry with the shared PackFileService zip-slip + zip-bomb guard, then — when signature.json is
     * present — verifies the detached signature over the CANONICAL manifest.json and enforces the manifest's
     * per-entry sha256 hashes for pack.json AND every envelope file the importer will consume (quickjs/
     * customLogic.json, launch.json, native.json, assets/*). A tampered file, or an applicable envelope file
     * that is PRESENT but NOT listed in the signed manifest (an unsigned extra), is rejected.
     * READ-ONLY: no import, no workspace policy (the import path owns policy enforcement).
     *
     * @return array{pack: array<string,mixed>, trust: string, envelope: array<string,mixed>}
     */
    public function parseApplicationPackageArchive(string $zipPath, ?SigningService $signing = null): array
    {
        $zip = new \ZipArchive();
        if ($zip->open($zipPath) !== true) {
            throw new \RuntimeException('Failed to open the application package');
        }

        try {
            // 1. Zip-slip + zip-bomb guard over every entry BEFORE reading anything out.
            PackFileService::assertSafeArchive($zip);

            // 2. pack.json is the atomic importer's source of truth (required).
            $packJson = $zip->getFromName('pack.json');
            if ($packJson === false) {
                throw new \RuntimeException('Application package is missing pack.json');
            }
            $pack = json_decode($packJson, true, 128);
            if (!is_array($pack)) {
                throw new \RuntimeException('pack.json is not valid JSON');
            }

            // 3. Detached signature over the CANONICAL manifest.json (which binds every entry via a per-entry
            //    sha256). When present it MUST verify; then each entry the importer consumes must match its
            //    signed hash — so a tampered envelope file (quickjs/launch/native/asset) is rejected even
            //    though it lives outside pack.json. $signatureCovers stays null for an unsigned (community)
            //    archive, and is the covered-entry set for a signed one (drives the "unsigned extra" check).
            $trust = 'community';
            $signatureCovers = null;
            $sigRaw = $zip->getFromName('signature.json');
            if ($sigRaw !== false) {
                $sig = json_decode($sigRaw, true);
                if (!is_array($sig) || !isset($sig['signature'], $sig['alg'])) {
                    throw new \RuntimeException('signature.json is malformed');
                }

                $manifestRaw = $zip->getFromName('manifest.json');
                $manifest = is_string($manifestRaw) ? json_decode($manifestRaw, true) : null;
                if (!is_array($manifest)) {
                    throw new \RuntimeException('Application package signature verification failed: manifest.json is missing or invalid');
                }

                $ok = $signing !== null && $signing->verify([
                    'payload' => $manifest,
                    'signature' => (string) $sig['signature'],
                    'alg' => (string) $sig['alg'],
                ]);
                if (!$ok) {
                    throw new \RuntimeException('Application package signature verification failed');
                }
                // Only reached when the signature verified: Ed25519 => official, HS256 => local-only.
                // Same classifier as describe + the JSON import path (single source of truth).
                $trust = self::classifyTrust(true, true, (string) $sig['alg']);

                // The signed manifest carries a sha256 of every covered entry. Enforce it for pack.json AND
                // every envelope file — recompute + require an exact match; reject any mismatch (tamper).
                $entryHashes = is_array($manifest['entries'] ?? null) ? $manifest['entries'] : [];
                if (empty($entryHashes) || !isset($entryHashes['pack.json'])) {
                    throw new \RuntimeException('Application package signature verification failed: the signed manifest does not cover pack.json');
                }
                $signatureCovers = $this->verifyEntryHashes($zip, $entryHashes);
            }

            // 4. Envelope metadata that lives OUTSIDE pack.json (discrete archive entries). Read it INSIDE
            //    the zip-slip-guarded block so every entry name was already validated by assertSafeArchive.
            //    For a signed archive, only entries covered by the verified manifest are honored — a present-
            //    but-unlisted applicable file is an unsigned extra and is rejected.
            $envelope = $this->readArchiveEnvelope($zip, $signatureCovers);
        } finally {
            $zip->close();
        }

        return ['pack' => $pack, 'trust' => $trust, 'envelope' => $envelope];
    }

    /**
     * Import a .formlogic ARCHIVE (the inverse of exportApplicationPackage). Parses + verifies via
     * parseApplicationPackageArchive() (zip-slip/zip-bomb guard, detached-signature + per-entry hash
     * enforcement), then delegates to the ATOMIC importPack() (remapping / rollback / quota unchanged)
     * and applies the (signature-covered) envelope metadata.
     *
     * @param list<string>|null $approvedConnectorGrants SAFE-001: the reviewed connector-grant
     *   allow-list (see importPack()). HTTP callers must always pass an array; null is reserved for
     *   trusted internal callers.
     * @return array importPack() result plus 'trust' (official|local-only|community).
     */
    public function importApplicationPackage(
        string $zipPath,
        string $userId,
        ?SigningService $signing = null,
        ?string $catalogId = null,
        ?string $versionId = null,
        ?array $approvedConnectorGrants = null
    ): array {
        $parsed = $this->parseApplicationPackageArchive($zipPath, $signing);
        $pack = $parsed['pack'];
        $trust = $parsed['trust'];
        $envelope = $parsed['envelope'];

        // Workspace policy (pre-commit): reject an unverified/community archive BEFORE the atomic import, so
        // a failed policy check never leaves a committed import behind. Positively-verified (signed) only.
        if ((($_ENV['REQUIRE_VERIFIED_PACKAGES'] ?? getenv('REQUIRE_VERIFIED_PACKAGES')) === 'true')
            && !in_array($trust, ['official', 'local-only'], true)) {
            throw new \RuntimeException('This workspace only allows verified (signed) application packages.');
        }

        // 5. Delegate to the existing atomic importer (customLogic embedded in pack.json is applied there).
        $screenTrust = in_array($trust, ['official', 'local-only'], true) ? 'verified' : 'untrusted';
        $result = $this->importPack($pack, $userId, $catalogId, $versionId, $screenTrust, $approvedConnectorGrants);
        $result['trust'] = $trust;

        // 6. Apply the envelope metadata (quickjs/customLogic.json, launch.json, native.json, assets/logo)
        //    to the created app(s); anything without a runtime target comes back as a warning. The approved
        //    grant set applies here too — the envelope is the third grant carrier (SAFE-001).
        $envelopeWithheld = [];
        $warnings = $this->applyPackageMetadata($envelope, $result['apps'], $userId, $approvedConnectorGrants, $envelopeWithheld);
        if (!empty($envelopeWithheld)) {
            $merged = array_values(array_unique(array_merge($result['withheldGrants'] ?? [], $envelopeWithheld)));
            sort($merged, SORT_STRING);
            $result['withheldGrants'] = $merged;
        }
        if (!empty($warnings)) {
            $result['warnings'] = $warnings;
        }
        return $result;
    }

    /**
     * Read an application-package archive's ENVELOPE metadata (the parts that live OUTSIDE pack.json):
     * quickjs/customLogic.json, launch.json, native.json, and assets/* (a logo asset is decoded to a
     * data: URI; other assets are noted so the caller can warn). Every entry name was already validated
     * by PackFileService::assertSafeArchive before this runs, so reads here are within the zip-slip guard.
     *
     * @param array<string,bool>|null $signatureCovers For a SIGNED archive, the set of entry names the
     *        verified manifest covers (from verifyEntryHashes). An applicable envelope/asset file that is
     *        PRESENT but NOT in this set is an unsigned extra (tamper) and is rejected. null => unsigned
     *        (community) archive, so no coverage constraint applies.
     * @return array{customLogic?:array, launch?:array, native?:array, logo?:string, assets?:array<string,bool>}
     */
    private function readArchiveEnvelope(\ZipArchive $zip, ?array $signatureCovers = null): array
    {
        $signed = $signatureCovers !== null;
        $envelope = [];
        foreach (['customLogic' => 'quickjs/customLogic.json', 'launch' => 'launch.json', 'native' => 'native.json'] as $key => $entry) {
            $raw = $zip->getFromName($entry);
            if ($raw === false) {
                continue;
            }
            // A signed archive may only carry envelope files hashed into the verified manifest; an
            // unlisted-but-present applicable file is an unsigned extra injected into a signed ZIP.
            if ($signed && !isset($signatureCovers[$entry])) {
                throw new \RuntimeException('Application package signature verification failed: unsigned "' . $entry . '" not covered by the signed manifest');
            }
            $decoded = json_decode($raw, true);
            if (is_array($decoded) && !empty($decoded)) {
                $envelope[$key] = $decoded;
            }
        }

        // assets/* — surface a logo asset as a data: URI (the only asset with a storage target today);
        // record the presence of any other asset so the caller can warn (no storage target for those yet).
        $assets = [];
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $name = $zip->getNameIndex($i);
            if (!is_string($name) || !str_starts_with($name, 'assets/') || !PackFileService::isSafeZipEntryName($name)) {
                continue;
            }
            $assetKey = substr($name, strlen('assets/'));
            if ($assetKey === '') {
                continue;
            }
            // An asset present in a signed archive but not covered by the verified manifest is an unsigned
            // extra — reject rather than consume it (matches the envelope-file rule above).
            if ($signed && !isset($signatureCovers[$name])) {
                throw new \RuntimeException('Application package signature verification failed: unsigned asset "' . $name . '" not covered by the signed manifest');
            }
            $assets[$assetKey] = true;
            if (!isset($envelope['logo']) && preg_match('/^logo\.(png|jpe?g|gif|webp|svg)$/i', $assetKey, $m)) {
                $raw = $zip->getFromName($name);
                if (is_string($raw) && $raw !== '' && strlen($raw) <= PackFileService::MAX_ASSET_BYTES) {
                    $mime = strtolower($m[1]);
                    $mime = $mime === 'svg' ? 'image/svg+xml' : ($mime === 'jpg' ? 'image/jpeg' : 'image/' . $mime);
                    $envelope['logo'] = 'data:' . $mime . ';base64,' . base64_encode($raw);
                }
            }
        }
        if (!empty($assets)) {
            $envelope['assets'] = $assets;
        }
        return $envelope;
    }

    /**
     * Enforce a SIGNED manifest's per-entry sha256 hashes. For every entry the manifest claims to cover,
     * recompute the archive member's sha256 and require an exact match; reject on any mismatch (a tampered
     * file) or a covered entry that is missing from the archive. The manifest itself was already verified
     * by the detached signature, so its hashes are trusted — this binds every consumed file to that
     * signature. Returns the covered-entry set (name => true) so readArchiveEnvelope can reject any
     * applicable envelope/asset file that is present but NOT covered (an unsigned extra).
     *
     * @param array<string,mixed> $entryHashes manifest.entries { entryName => sha256hex }
     * @return array<string,bool> covered entry names
     */
    private function verifyEntryHashes(\ZipArchive $zip, array $entryHashes): array
    {
        $covered = [];
        foreach ($entryHashes as $entryName => $expected) {
            if (!is_string($entryName) || $entryName === '' || !is_string($expected) || $expected === '') {
                throw new \RuntimeException('Application package signature verification failed: the signed manifest has a malformed entry hash');
            }
            // Defense in depth: a covered name must itself be a safe zip path (assertSafeArchive validated the
            // ARCHIVE's own entry names, but manifest.entries is attacker-influenced input parsed separately).
            if (!PackFileService::isSafeZipEntryName($entryName)) {
                throw new \RuntimeException('Application package signature verification failed: the signed manifest lists an unsafe entry name');
            }
            $bytes = $zip->getFromName($entryName);
            if ($bytes === false) {
                throw new \RuntimeException('Application package signature verification failed: covered entry "' . $entryName . '" is missing from the archive');
            }
            if (!hash_equals(strtolower($expected), hash('sha256', $bytes))) {
                throw new \RuntimeException('Application package signature verification failed: entry "' . $entryName . '" does not match its signed hash');
            }
            $covered[$entryName] = true;
        }
        return $covered;
    }

    /**
     * Classify import / marketplace TRUST from a signature outcome. Single source of truth shared by
     * PackController::describe(), the JSON import path, and importApplicationPackage() so they cannot
     * diverge: an Ed25519 signature that verifies is publicly / native-verifiable ('official'); a
     * verifying HS256 fallback only re-checks on THIS same server ('local-only'); a present-but-failing
     * signature is 'unverified'; no signature at all is 'community'.
     */
    public static function classifyTrust(bool $hasSignature, bool $verified, string $alg): string
    {
        if (!$hasSignature) {
            return 'community';
        }
        if (!$verified) {
            return 'unverified';
        }
        return $alg === 'Ed25519' ? 'official' : 'local-only';
    }

    /**
     * Apply an application package's ENVELOPE-level metadata — the parts that live OUTSIDE pack.json — to
     * the app(s) importPack() just created. Only metadata with a runtime target today is persisted; the
     * rest is returned as human-readable warnings so nothing is silently dropped:
     *   - customLogic  → sanitized (CustomLogicSanitizer) + saved to apps.custom_logic (fills only when the
     *                    created app carries none, so pack.json-embedded logic is never clobbered).
     *   - logo/logoUrl → saved to apps.logo_url when the app has none (data: URIs are size-guarded).
     *   - launch/native→ no app-level target yet (they live per-domain on app_domains) → WARNING.
     *   - other assets → no storage target yet → WARNING.
     * For the ZIP path the envelope is now genuinely signature-covered (each entry's sha256 is bound by the
     * signed manifest and hash-checked in importApplicationPackage); for the JSON path the envelope is part of
     * the one signed `package` object. Either way it is still sanitized/guarded defensively here (never trust
     * asset paths or oversized logic).
     *
     * @param array $envelope The signed envelope (bare Pack => no envelope keys => no-op) or ApplicationPackage.
     * @param array $apps      importPack() result 'apps' ([{id,name}, ...]).
     * @param string $userId   Owner of every app importPack() created.
     * @return string[]        Warnings for metadata that has no runtime target (empty when all applied).
     */
    public function applyPackageMetadata(array $envelope, array $apps, string $userId, ?array $approvedConnectorGrants = null, array &$withheldGrants = []): array
    {
        $warnings = [];

        // customLogic living outside pack.json — sanitize to the known-safe shape + size before storing,
        // then run the SAME APP-502 grant review as the in-pack carriers (SAFE-001: the envelope is the
        // third grant carrier — without this, a grant stripped from pack.json's app customLogic would
        // ride back in untouched through quickjs/customLogic.json).
        $customLogic = null;
        if (is_array($envelope['customLogic'] ?? null) && !empty($envelope['customLogic'])) {
            $sanitized = CustomLogicSanitizer::sanitize($envelope['customLogic']);
            if (!empty($sanitized['scripts']) && CustomLogicSanitizer::withinSizeCap($sanitized)) {
                $withheld = [];
                $customLogic = $this->reviewCustomLogicGrants(
                    $sanitized,
                    $this->normalizeApprovedGrants($approvedConnectorGrants),
                    $withheld
                );
                if (!empty($withheld)) {
                    $keys = array_keys($withheld);
                    sort($keys, SORT_STRING);
                    $withheldGrants = $keys;
                    $warnings[] = 'Package-level custom logic requested connector grants that were not approved and were removed: ' . implode(', ', $keys) . '.';
                }
            } else {
                $warnings[] = 'Package-level custom logic was empty or over the size cap and was not applied.';
            }
        }

        // A logo asset (data: URI or http(s) URL) maps to logo_url — the only asset with a storage target.
        $logoUrl = null;
        $logo = null;
        foreach (['logo', 'logoUrl'] as $lk) {
            if (is_string($envelope[$lk] ?? null) && $envelope[$lk] !== '') {
                $logo = $envelope[$lk];
                break;
            }
        }
        if ($logo !== null) {
            if (str_starts_with($logo, 'data:')) {
                $decoded = $this->decodeDataUri($logo);
                if ($decoded !== null && strlen($decoded) <= PackFileService::MAX_ASSET_BYTES) {
                    $logoUrl = $logo;
                } else {
                    $warnings[] = 'Package logo asset was invalid or over the size cap and was not applied.';
                }
            } elseif (preg_match('#^https?://#i', $logo)) {
                $logoUrl = $logo;
            } else {
                $warnings[] = 'Package logo reference was not a data: URI or http(s) URL and was not applied.';
            }
        }

        $appliedToApp = false;
        foreach ($apps as $a) {
            $appId = is_array($a) ? ($a['id'] ?? null) : null;
            if (!is_string($appId) || $appId === '') {
                continue;
            }
            try {
                // Owner check: only mutate an app the importer owns (importPack just created these under $userId).
                $app = $this->appService->getApp($appId);
                if (!$app || ($app['ownerId'] ?? null) !== $userId) {
                    continue;
                }
                $update = [];
                if ($customLogic !== null && empty($app['customLogic'])) {
                    $update['customLogic'] = $customLogic;
                }
                if ($logoUrl !== null && empty($app['logoUrl'])) {
                    $update['logoUrl'] = $logoUrl;
                }
                if (!empty($update)) {
                    $this->appService->updateApp($appId, $update);
                    $appliedToApp = true;
                }
            } catch (\Throwable $e) {
                // The forms/apps are already committed by importPack (this runs post-commit, outside its
                // transaction), so a metadata-apply failure must NOT surface as an import failure — that
                // would make the user retry and duplicate everything. Warn and move on.
                $warnings[] = 'App imported, but applying package metadata (logo / custom logic) failed — reconfigure it in app settings.';
            }
        }
        if (($customLogic !== null || $logoUrl !== null) && !$appliedToApp) {
            $warnings[] = 'Package metadata could not be attached: the package created no owned app to apply it to.';
        }

        // launch / native have no app-level runtime target today (they are configured per custom domain
        // on app_domains, which an import does not create). Surface rather than drop.
        if (!empty($envelope['launch'])) {
            $warnings[] = 'Package launch defaults were received but have no app-level target yet; configure them per custom domain after install.';
        }
        if (!empty($envelope['native'])) {
            $warnings[] = 'Package native defaults were received but have no app-level target yet; configure them per custom domain after install.';
        }

        // Non-logo assets have no storage target today.
        $extraAssets = array_values(array_filter(
            array_keys(is_array($envelope['assets'] ?? null) ? $envelope['assets'] : []),
            static fn ($k) => !preg_match('/^logo\.(png|jpe?g|gif|webp|svg)$/i', (string) $k)
        ));
        if (!empty($extraAssets)) {
            $warnings[] = 'Package assets (' . implode(', ', array_map('strval', $extraAssets)) . ') have no storage target and were not imported.';
        }

        return $warnings;
    }

    /** Decode a data: URI to raw bytes; returns null if it is not a well-formed base64 data URI. */
    private function decodeDataUri(string $uri): ?string
    {
        if (!preg_match('#^data:[^,]*;base64,(.*)$#s', $uri, $m)) {
            return null;
        }
        $decoded = base64_decode($m[1], true);
        return $decoded === false ? null : $decoded;
    }

    /**
     * Publish an app the user owns (used by the sample-app install so it opens running immediately).
     * Ordinary pack import stays draft; only the explicit "Try a sample" flow publishes.
     */
    public function publishApp(string $appId, string $userId): void
    {
        $app = $this->appService->getApp($appId);
        if ($app && ($app['ownerId'] ?? null) === $userId) {
            $this->appService->updateApp($appId, ['status' => 'published']);
        }
    }

    /**
     * Get all pack installations for a user.
     *
     * @return array List of installation records
     */
    public function getInstalledPacks(string $userId): array
    {
        $stmt = $this->mysql->prepare("
            SELECT id, pack_id, catalog_id, version_id, pack_name, pack_version, pack_description,
                   form_ids, app_ids, installed_at
            FROM pack_installations
            WHERE user_id = :user_id
            ORDER BY installed_at DESC
        ");
        $stmt->execute(['user_id' => $userId]);
        $rows = $stmt->fetchAll();

        // Batch-fetch the latest version per catalog (one query, not N+1) so we
        // can flag updates. Keyed by catalog_id => ['id','version','changelog'].
        $latestByCatalog = [];
        $catalogIds = array_values(array_unique(array_filter(array_map(fn ($r) => $r['catalog_id'] ?? null, $rows))));
        if (!empty($catalogIds)) {
            $placeholders = implode(',', array_fill(0, count($catalogIds), '?'));
            $vStmt = $this->mysql->prepare("
                SELECT pv.catalog_id, pv.id, pv.version, pv.changelog
                FROM pack_versions pv
                JOIN (
                    SELECT catalog_id, MAX(created_at) AS mc
                    FROM pack_versions
                    WHERE catalog_id IN ($placeholders)
                    GROUP BY catalog_id
                ) m ON m.catalog_id = pv.catalog_id AND m.mc = pv.created_at
            ");
            $vStmt->execute($catalogIds);
            foreach ($vStmt->fetchAll() as $v) {
                // Keep the first per catalog (guards the rare same-second tie).
                $latestByCatalog[$v['catalog_id']] ??= $v;
            }
        }

        // Batch existence checks: one query for all forms, one for all apps,
        // instead of 2 COUNT(*) per installation row (N+1).
        $allFormIds = [];
        $allAppIds = [];
        foreach ($rows as $row) {
            foreach (json_decode($row['form_ids'], true) ?? [] as $fid) { $allFormIds[$fid] = true; }
            foreach (json_decode($row['app_ids'], true) ?? [] as $aid) { $allAppIds[$aid] = true; }
        }
        $existingFormIds = $this->existingIds('forms', array_keys($allFormIds));
        $existingAppIds = $this->existingIds('apps', array_keys($allAppIds));

        $installations = [];
        foreach ($rows as $row) {
            $formIds = json_decode($row['form_ids'], true) ?? [];
            $appIds = json_decode($row['app_ids'], true) ?? [];

            // Count which forms/apps still exist (from the batched sets above)
            $existingForms = count(array_intersect_key(array_flip($formIds), $existingFormIds));
            $existingApps = count(array_intersect_key(array_flip($appIds), $existingAppIds));

            // Flag an update by VERSION IDENTITY (latest version row vs the
            // installed version_id), not version strings — the embedded
            // packMeta.version often differs from the catalog version, which
            // produced false "update available" badges right after install.
            $updateAvailable = null;
            $latest = (!empty($row['catalog_id']) && isset($latestByCatalog[$row['catalog_id']]))
                ? $latestByCatalog[$row['catalog_id']] : null;
            if ($latest && !empty($row['version_id']) && (string) $latest['id'] !== (string) $row['version_id']) {
                $updateAvailable = ['version' => $latest['version'], 'changelog' => $latest['changelog']];
            }

            $installations[] = [
                'id' => $row['id'],
                'packId' => $row['pack_id'],
                'catalogId' => $row['catalog_id'] ?? null,
                'versionId' => $row['version_id'] ?? null,
                'packName' => $row['pack_name'],
                'packVersion' => $row['pack_version'],
                'packDescription' => $row['pack_description'],
                'formCount' => count($formIds),
                'appCount' => count($appIds),
                'existingFormCount' => $existingForms,
                'existingAppCount' => $existingApps,
                'formIds' => $formIds,
                'appIds' => $appIds,
                'installedAt' => $row['installed_at'],
                'updateAvailable' => $updateAvailable,
            ];
        }

        return $installations;
    }

    /**
     * Uninstall a pack: delete all forms and apps created by it.
     *
     * @return array { formsDeleted: int, appsDeleted: int }
     */
    public function uninstallPack(string $installationId, string $userId): array
    {
        // Verify the installation belongs to this user
        $stmt = $this->mysql->prepare("
            SELECT id, form_ids, app_ids
            FROM pack_installations
            WHERE id = :id AND user_id = :user_id
        ");
        $stmt->execute(['id' => $installationId, 'user_id' => $userId]);
        $installation = $stmt->fetch();

        if (!$installation) {
            throw new \RuntimeException('Installation not found');
        }

        $formIds = json_decode($installation['form_ids'], true) ?? [];
        $appIds = json_decode($installation['app_ids'], true) ?? [];

        $formsDeleted = 0;
        $appsDeleted = 0;

        // Delete apps first (they reference forms via app_forms)
        // Verify ownership before deleting to prevent deletion of other users' resources
        foreach ($appIds as $appId) {
            try {
                $checkStmt = $this->mysql->prepare("SELECT id FROM apps WHERE id = :id AND owner_id = :owner_id");
                $checkStmt->execute(['id' => $appId, 'owner_id' => $userId]);
                if (!$checkStmt->fetch()) continue; // Skip if not owned or already deleted
                $this->appService->deleteApp($appId);
                $appsDeleted++;
            } catch (\Exception $e) {
                // App may have been manually deleted already
            }
        }

        // Delete forms (and their SQLite databases)
        // Verify ownership before deleting
        foreach ($formIds as $formId) {
            try {
                $checkStmt = $this->mysql->prepare("SELECT id FROM forms WHERE id = :id AND user_id = :user_id");
                $checkStmt->execute(['id' => $formId, 'user_id' => $userId]);
                if (!$checkStmt->fetch()) continue; // Skip if not owned or already deleted
                $this->formService->deleteForm($formId);
                $formsDeleted++;
            } catch (\Exception $e) {
                // Form may have been manually deleted already
            }
        }

        // Remove the installation record
        $stmt = $this->mysql->prepare("DELETE FROM pack_installations WHERE id = :id");
        $stmt->execute(['id' => $installationId]);

        return [
            'formsDeleted' => $formsDeleted,
            'appsDeleted' => $appsDeleted,
        ];
    }

    /**
     * Adopt an existing (pre-tracking) pack installation.
     * Matches pack form titles against user's existing forms and creates
     * an installation record without creating new forms/apps.
     *
     * @param array  $packData Full pack JSON structure
     * @param string $userId   Authenticated user
     * @return array { installationId, formsMatched, appsMatched }
     */
    public function adoptExistingPack(array $packData, string $userId): array
    {
        $this->validatePack($packData);

        $meta = $packData['packMeta'];
        $packId = $meta['id'] ?? $meta['name'] ?? 'custom';

        // Serialize against concurrent adopt/import of the same pack by this user.
        $installLock = $this->acquireInstallLock($packId, $userId);
        try {
            // Don't adopt if already tracked
            if ($this->isPackInstalled($packId, $userId)) {
                throw new \RuntimeException('Pack is already tracked');
            }

            return $this->adoptExistingPackLocked($packData, $userId, $packId, $meta);
        } finally {
            $this->releaseInstallLock($installLock);
        }
    }

    private function adoptExistingPackLocked(array $packData, string $userId, string $packId, array $meta): array
    {
        // Match forms by title
        $formIds = [];
        foreach ($packData['forms'] as $packForm) {
            $stmt = $this->mysql->prepare("
                SELECT id FROM forms
                WHERE user_id = :user_id AND title = :title
                ORDER BY created_at DESC
                LIMIT 1
            ");
            $stmt->execute(['user_id' => $userId, 'title' => $packForm['title']]);
            $row = $stmt->fetch();
            if ($row) {
                $formIds[] = $row['id'];
            }
        }

        // Match apps by name
        $appIds = [];
        foreach ($packData['apps'] ?? [] as $packApp) {
            $stmt = $this->mysql->prepare("
                SELECT id FROM apps
                WHERE owner_id = :user_id AND name = :name
                ORDER BY created_at DESC
                LIMIT 1
            ");
            $stmt->execute(['user_id' => $userId, 'name' => $packApp['name']]);
            $row = $stmt->fetch();
            if ($row) {
                $appIds[] = $row['id'];
            }
        }

        // Must match at least some forms to consider it an existing install
        if (empty($formIds)) {
            throw new \RuntimeException('No matching forms found for this pack');
        }

        // Create installation record
        $installationId = $this->generateUuid();
        $stmt = $this->mysql->prepare("
            INSERT INTO pack_installations (id, user_id, pack_id, pack_name, pack_version, pack_description, form_ids, app_ids)
            VALUES (:id, :user_id, :pack_id, :pack_name, :pack_version, :pack_description, :form_ids, :app_ids)
        ");
        $stmt->execute([
            'id' => $installationId,
            'user_id' => $userId,
            'pack_id' => $packId,
            'pack_name' => $meta['name'] ?? 'Unknown Pack',
            'pack_version' => $meta['version'] ?? '1.0.0',
            'pack_description' => $meta['description'] ?? null,
            'form_ids' => json_encode($formIds),
            'app_ids' => json_encode($appIds),
        ]);

        return [
            'installationId' => $installationId,
            'formsMatched' => count($formIds),
            'appsMatched' => count($appIds),
        ];
    }

    /**
     * Serialize concurrent install/adopt of the same pack by the same user so the
     * isPackInstalled() check-then-insert cannot race into duplicate installations
     * (there is no UNIQUE constraint on pack_installations). Mirrors the audit-chain
     * GET_LOCK pattern. Fails open (returns null) so a lock-server hiccup never
     * blocks legitimate installs.
     */
    private function acquireInstallLock(string $packId, string $userId): ?string
    {
        // GET_LOCK names are capped at 64 chars; hash to stay well within that.
        $name = 'fl_pack_install_' . hash('sha256', $packId . '|' . $userId);
        $name = substr($name, 0, 60);
        try {
            $stmt = $this->mysql->prepare("SELECT GET_LOCK(:n, 5)");
            $stmt->execute(['n' => $name]);
            return ((int) $stmt->fetchColumn() === 1) ? $name : null;
        } catch (\Exception $e) {
            return null;
        }
    }

    private function releaseInstallLock(?string $name): void
    {
        if ($name === null) {
            return;
        }
        try {
            $stmt = $this->mysql->prepare("SELECT RELEASE_LOCK(:n)");
            $stmt->execute(['n' => $name]);
        } catch (\Exception $e) {
            // best-effort; the lock also releases on connection close
        }
    }

    /**
     * Check if a pack (by pack_id) is installed for a user.
     */
    public function isPackInstalled(string $packId, string $userId): ?array
    {
        $stmt = $this->mysql->prepare("
            SELECT id, installed_at
            FROM pack_installations
            WHERE pack_id = :pack_id AND user_id = :user_id
            ORDER BY installed_at DESC
            LIMIT 1
        ");
        $stmt->execute(['pack_id' => $packId, 'user_id' => $userId]);
        $row = $stmt->fetch();

        return $row ?: null;
    }

    /**
     * Check if a marketplace pack (by catalog_id) is installed for a user.
     */
    public function isCatalogPackInstalled(string $catalogId, string $userId): ?array
    {
        $stmt = $this->mysql->prepare("
            SELECT id, installed_at
            FROM pack_installations
            WHERE catalog_id = :catalog_id AND user_id = :user_id
            ORDER BY installed_at DESC
            LIMIT 1
        ");
        $stmt->execute(['catalog_id' => $catalogId, 'user_id' => $userId]);
        return $stmt->fetch() ?: null;
    }

    /**
     * Validate pack data structure
     */
    private function validatePack(array $packData): void
    {
        if (($packData['formatVersion'] ?? null) !== 1) {
            throw new \RuntimeException('Unsupported pack format version');
        }

        if (!isset($packData['packMeta']) || !is_array($packData['packMeta'])) {
            throw new \RuntimeException('Pack is missing packMeta');
        }

        if (empty($packData['forms']) || !is_array($packData['forms'])) {
            throw new \RuntimeException('Pack must contain at least one form');
        }

        // Enforce size limits to prevent resource exhaustion
        if (count($packData['forms']) > 50) {
            throw new \RuntimeException('Pack cannot contain more than 50 forms');
        }
        if (isset($packData['apps']) && is_array($packData['apps']) && count($packData['apps']) > 20) {
            throw new \RuntimeException('Pack cannot contain more than 20 apps');
        }

        // Check for duplicate packFormIds
        $seenFormIds = [];
        foreach ($packData['forms'] as $i => $form) {
            if (!isset($form['packFormId']) || $form['packFormId'] === '') {
                throw new \RuntimeException("Form at index {$i} is missing packFormId");
            }
            if (empty($form['title'])) {
                throw new \RuntimeException("Form '{$form['packFormId']}' is missing title");
            }
            if (isset($form['fields']) && is_array($form['fields']) && count($form['fields']) > 200) {
                throw new \RuntimeException("Form '{$form['packFormId']}' has too many fields (max 200)");
            }
            // Enforce per-form field size limits (same as FormController)
            if (isset($form['logicScript']) && is_string($form['logicScript']) && strlen($form['logicScript']) > 102400) {
                throw new \RuntimeException("Form '{$form['packFormId']}' logic script exceeds 100KB limit");
            }
            if (isset($form['fields']) && is_array($form['fields'])) {
                $fieldsJson = json_encode($form['fields']);
                if ($fieldsJson !== false && strlen($fieldsJson) > 512000) {
                    throw new \RuntimeException("Form '{$form['packFormId']}' fields data exceeds 500KB limit");
                }
            }
            if (isset($form['settings'])) {
                $settingsJson = json_encode($form['settings']);
                if ($settingsJson !== false && strlen($settingsJson) > 10240) {
                    throw new \RuntimeException("Form '{$form['packFormId']}' settings exceeds 10KB limit");
                }
            }
            if (isset($form['theme'])) {
                $themeJson = json_encode($form['theme']);
                if ($themeJson !== false && strlen($themeJson) > 10240) {
                    throw new \RuntimeException("Form '{$form['packFormId']}' theme exceeds 10KB limit");
                }
            }
            if (isset($form['customScreen'])) {
                $screenJson = json_encode($form['customScreen']);
                // 2MB: screens may carry image assets as data: URIs in `files`.
                if ($screenJson !== false && strlen($screenJson) > 2097152) {
                    throw new \RuntimeException("Form '{$form['packFormId']}' custom screen exceeds 2MB limit");
                }
            }
            if (isset($seenFormIds[$form['packFormId']])) {
                throw new \RuntimeException("Duplicate packFormId: '{$form['packFormId']}'");
            }
            $seenFormIds[$form['packFormId']] = true;
        }

        $seenAppIds = [];
        foreach ($packData['apps'] ?? [] as $i => $app) {
            if (!isset($app['packAppId']) || $app['packAppId'] === '') {
                throw new \RuntimeException("App at index {$i} is missing packAppId");
            }
            // Duplicate packAppId is malformed AND a trust-confusion vector:
            // component signing keys on packAppId, so two apps sharing an id
            // must never coexist (each app becomes its own record — mirror the
            // packFormId guard above).
            if (isset($seenAppIds[$app['packAppId']])) {
                throw new \RuntimeException("Duplicate packAppId: '{$app['packAppId']}'");
            }
            $seenAppIds[$app['packAppId']] = true;
            if (empty($app['name'])) {
                throw new \RuntimeException("App '{$app['packAppId']}' is missing name");
            }
            // App Features (PKG-102 / ADR-010): an optional list of included feature toggles the
            // importer composes into settings.services. `features` is the v2 name; `services`
            // remains the accepted v1 alias (these are NOT Desktop services). Declaring both is
            // ambiguous and refused. Strict shape — unknown keys rejected so a pack can never
            // smuggle extra semantics through an entry.
            if (array_key_exists('features', $app) && array_key_exists('services', $app)) {
                throw new \RuntimeException("App '{$app['packAppId']}' declares both 'features' and its v1 alias 'services' — use one");
            }
            $featureKey = array_key_exists('features', $app) ? 'features' : (array_key_exists('services', $app) ? 'services' : null);
            if ($featureKey !== null) {
                if (!is_array($app[$featureKey]) || !array_is_list($app[$featureKey])) {
                    throw new \RuntimeException("App '{$app['packAppId']}' {$featureKey} must be a list");
                }
                if (count($app[$featureKey]) > 8) {
                    throw new \RuntimeException("App '{$app['packAppId']}' cannot declare more than 8 {$featureKey}");
                }
                $seenServiceIds = [];
                foreach ($app[$featureKey] as $si => $svc) {
                    if (!is_array($svc)) {
                        throw new \RuntimeException("App '{$app['packAppId']}' service at index {$si} must be an object");
                    }
                    $unknown = array_diff(array_keys($svc), ['id', 'title', 'description', 'defaultEnabled']);
                    if ($unknown !== []) {
                        throw new \RuntimeException("App '{$app['packAppId']}' service at index {$si} has unknown keys: " . implode(', ', $unknown));
                    }
                    $sid = $svc['id'] ?? null;
                    if (!is_string($sid) || !preg_match('/^[a-z0-9][a-z0-9-]{1,40}$/', $sid)) {
                        throw new \RuntimeException("App '{$app['packAppId']}' service at index {$si} needs a slug id (lowercase letters, digits, hyphens)");
                    }
                    if (isset($seenServiceIds[$sid])) {
                        throw new \RuntimeException("App '{$app['packAppId']}' declares duplicate service id '{$sid}'");
                    }
                    $seenServiceIds[$sid] = true;
                    if (!is_string($svc['title'] ?? null) || trim($svc['title']) === '' || strlen($svc['title']) > 120) {
                        throw new \RuntimeException("App '{$app['packAppId']}' service '{$sid}' needs a title (max 120 chars)");
                    }
                    if (!is_string($svc['description'] ?? null) || strlen($svc['description']) > 2000) {
                        throw new \RuntimeException("App '{$app['packAppId']}' service '{$sid}' needs a description string (max 2000 chars)");
                    }
                    if (array_key_exists('defaultEnabled', $svc) && !is_bool($svc['defaultEnabled'])) {
                        throw new \RuntimeException("App '{$app['packAppId']}' service '{$sid}' defaultEnabled must be a boolean");
                    }
                }
            }
            // Per-app size caps (mirror the form caps) — the app home screen ships executable HTML/CSS/JS.
            if (isset($app['customScreen'])) {
                $screenJson = json_encode($app['customScreen']);
                // 2MB: screens may carry image assets as data: URIs in `files`.
                if ($screenJson !== false && strlen($screenJson) > 2097152) {
                    throw new \RuntimeException("App '{$app['packAppId']}' custom screen exceeds 2MB limit");
                }
            }
            // Custom app-logic is code (sandboxed at runtime); 256KB covers the QuickJS
            // scripts plus an optional pack connector demo driver (CustomLogicSanitizer caps).
            if (isset($app['customLogic'])) {
                $logicJson = json_encode($app['customLogic']);
                if ($logicJson !== false && strlen($logicJson) > CustomLogicSanitizer::MAX_BUNDLE_BYTES) {
                    throw new \RuntimeException("App '{$app['packAppId']}' custom logic exceeds 256KB limit");
                }
            }
            foreach (['navConfig' => 10240, 'settings' => 10240, 'theme' => 10240, 'reports' => 262144] as $key => $cap) {
                if (isset($app[$key])) {
                    $json = json_encode($app[$key]);
                    if ($json !== false && strlen($json) > $cap) {
                        throw new \RuntimeException("App '{$app['packAppId']}' {$key} exceeds " . ($cap / 1024) . "KB limit");
                    }
                }
            }
        }

        // FormLogic Flows (docs/FORMLOGIC_FLOWS.md §6): optional flows[] + flowBindings[]. Enforced
        // with the SAME FlowService sanitizers as the owner CRUD API so a pack can never smuggle a
        // flow/binding the API would reject (slug pattern, graph shape + 256KB cap, event pattern,
        // mode enum, outputAction whitelist, timeout bounds, 16KB per-column caps).
        $seenFlowSlugs = [];
        if (isset($packData['flows'])) {
            if (!is_array($packData['flows'])) {
                throw new \RuntimeException('Pack flows must be an array');
            }
            if (count($packData['flows']) > 20) {
                throw new \RuntimeException('Pack cannot contain more than 20 flows');
            }
            if (empty($packData['flows']) === false && empty($packData['apps'])) {
                throw new \RuntimeException('Pack flows require at least one app');
            }
            foreach ($packData['flows'] as $i => $flow) {
                if (!is_array($flow)) {
                    throw new \RuntimeException("Flow at index {$i} must be an object");
                }
                try {
                    $slug = FlowService::sanitizeSlug($flow['slug'] ?? null);
                    $flowJson = FlowService::sanitizeFlowJson($flow['flowJson'] ?? ['nodes' => [], 'edges' => []]);
                } catch (\InvalidArgumentException $e) {
                    throw new \RuntimeException("Flow at index {$i}: " . $e->getMessage());
                }
                if (empty($flow['name']) || !is_string($flow['name'])) {
                    throw new \RuntimeException("Flow '{$slug}' is missing name");
                }
                // Node-level '@pack:' form refs must point at forms declared in THIS pack
                // (mirrors the binding formId check below; the importer remaps them).
                foreach ($flowJson['nodes'] as $node) {
                    if (!is_array($node) || !is_array($node['data'] ?? null)) {
                        continue;
                    }
                    foreach (['form', 'formId'] as $key) {
                        $ref = $node['data'][$key] ?? null;
                        if (is_string($ref) && str_starts_with($ref, '@pack:') && !isset($seenFormIds[substr($ref, 6)])) {
                            throw new \RuntimeException("Flow '{$slug}' node '" . ($node['id'] ?? '?') . "' references unknown packFormId '" . substr($ref, 6) . "'");
                        }
                    }
                }
                if (isset($seenFlowSlugs[$slug])) {
                    throw new \RuntimeException("Duplicate flow slug: '{$slug}'");
                }
                $seenFlowSlugs[$slug] = true;
            }
        }
        if (isset($packData['flowBindings'])) {
            if (!is_array($packData['flowBindings'])) {
                throw new \RuntimeException('Pack flowBindings must be an array');
            }
            if (count($packData['flowBindings']) > 40) {
                throw new \RuntimeException('Pack cannot contain more than 40 flow bindings');
            }
            if (empty($packData['flowBindings']) === false && empty($packData['apps'])) {
                throw new \RuntimeException('Pack flow bindings require at least one app');
            }
            foreach ($packData['flowBindings'] as $i => $binding) {
                if (!is_array($binding)) {
                    throw new \RuntimeException("Flow binding at index {$i} must be an object");
                }
                try {
                    $clean = FlowService::sanitizeBinding($binding);
                } catch (\InvalidArgumentException $e) {
                    throw new \RuntimeException("Flow binding at index {$i}: " . $e->getMessage());
                }
                if (!isset($seenFlowSlugs[$clean['flow']])) {
                    throw new \RuntimeException("Flow binding at index {$i} references unknown flow '{$clean['flow']}'");
                }
                $fRef = $binding['formId'] ?? null;
                if (is_string($fRef) && str_starts_with($fRef, '@pack:') && !isset($seenFormIds[substr($fRef, 6)])) {
                    throw new \RuntimeException("Flow binding at index {$i} references unknown packFormId '" . substr($fRef, 6) . "'");
                }
            }
        }
    }

    /**
     * Remap @pack: prefixed targetFormId references in linked_record fields
     */
    private function remapFieldReferences(array $fields, array $formIdMap): array
    {
        foreach ($fields as &$field) {
            if (($field['type'] ?? '') === 'linked_record') {
                $targetFormId = $field['properties']['targetFormId'] ?? null;
                if (is_string($targetFormId) && str_starts_with($targetFormId, '@pack:')) {
                    $packFormId = substr($targetFormId, 6);
                    if (!isset($formIdMap[$packFormId])) {
                        throw new \RuntimeException(
                            "Linked record field '{$field['id']}' references unknown packFormId '{$packFormId}'"
                        );
                    }
                    $field['properties']['targetFormId'] = $formIdMap[$packFormId];
                }
            }
        }
        unset($field);
        return $fields;
    }

    /**
     * Inverse of remapFieldReferences: rewrite a linked_record's real targetFormId to a portable
     * '@pack:<key>' reference. A reference to a form OUTSIDE the exported set is stripped (never leak a
     * foreign/internal UUID, and never emit a dangling import).
     */
    private function packifyFieldReferences(array $fields, array $realToPackKey): array
    {
        foreach ($fields as &$field) {
            if (($field['type'] ?? '') === 'linked_record') {
                $tid = $field['properties']['targetFormId'] ?? null;
                if (is_string($tid) && $tid !== '') {
                    if (isset($realToPackKey[$tid])) {
                        $field['properties']['targetFormId'] = '@pack:' . $realToPackKey[$tid];
                    } else {
                        unset($field['properties']['targetFormId']);
                    }
                }
            }
            // Empty properties should export as `{}`, not `[]`.
            if (array_key_exists('properties', $field)) {
                $field['properties'] = $this->jsonObject($field['properties']);
            }
        }
        unset($field);
        return $fields;
    }

    /**
     * Resolve a pack's report items (charts + PDF documents) into installable `apps.reports` items,
     * rewriting every `@pack:<packFormId>` reference to the real form id via $formIdMap. A report whose
     * form/join/field ref can't be resolved is dropped (never emit a broken spec). Document blocks that
     * reference a dropped/unknown chart are dropped; a document left with no blocks is dropped.
     *
     * @param array         $packReports PackReportItem[] (each: { reportId, kind, name, description?, spec?|blocks? })
     * @param array<string,string> $formIdMap packFormId => real form id
     * @param callable|null $idFor  optional (packReportId) => stable item id; defaults to a fresh UUID
     * @return array AppReportItem[] ready to persist to apps.reports
     */
    public function resolvePackReports(array $packReports, array $formIdMap, ?callable $idFor = null): array
    {
        $idFor ??= fn (string $rid) => $this->generateUuid();

        // Pack-local reportId => resolved item id (so document blocks can point at the right chart).
        $itemIdByPackId = [];
        foreach ($packReports as $r) {
            if (!empty($r['reportId'])) {
                $itemIdByPackId[$r['reportId']] = $idFor((string) $r['reportId']);
            }
        }

        // "@pack:key" => real form id (null if unknown).
        $resolveForm = static function (mixed $ref) use ($formIdMap): ?string {
            if (!is_string($ref) || !str_starts_with($ref, '@pack:')) { return null; }
            return $formIdMap[substr($ref, 6)] ?? null;
        };
        // Field ref: "@pack:key::field" => "realId::field"; bare "field"/"__pseudo" unchanged; unknown => null.
        $resolveFieldRef = static function (mixed $ref) use ($formIdMap): ?string {
            if (!is_string($ref) || $ref === '') { return null; }
            if (!str_contains($ref, '::')) { return $ref; }
            [$fp, $fid] = explode('::', $ref, 2);
            if (!str_starts_with($fp, '@pack:')) { return null; }
            $id = $formIdMap[substr($fp, 6)] ?? null;
            return $id !== null ? $id . '::' . $fid : null;
        };

        $out = [];
        foreach ($packReports as $r) {
            $id = $itemIdByPackId[$r['reportId'] ?? ''] ?? null;
            if ($id === null) { continue; }
            $kind = $r['kind'] ?? 'chart';

            if ($kind === 'document') {
                $blocks = [];
                foreach ($r['blocks'] ?? [] as $b) {
                    $bk = $b['kind'] ?? '';
                    if ($bk === 'text') {
                        $blocks[] = ['id' => $this->generateUuid(), 'kind' => 'text', 'title' => $b['title'] ?? null, 'body' => (string) ($b['body'] ?? '')];
                    } elseif ($bk === 'report') {
                        $rid = $itemIdByPackId[$b['reportId'] ?? ''] ?? null;
                        if ($rid !== null) {
                            $blocks[] = ['id' => $this->generateUuid(), 'kind' => 'report', 'reportId' => $rid, 'caption' => $b['caption'] ?? null];
                        }
                    }
                }
                if ($blocks) {
                    $out[] = ['id' => $id, 'name' => $r['name'] ?? 'Document', 'description' => $r['description'] ?? null, 'type' => 'document', 'blocks' => $blocks];
                }
                continue;
            }

            // chart
            $spec = is_array($r['spec'] ?? null) ? $r['spec'] : null;
            if (!$spec) { continue; }
            $base = $resolveForm($spec['formId'] ?? null);
            if ($base === null) { continue; }
            $ns = ['formId' => $base, 'viz' => in_array($spec['viz'] ?? '', ['table', 'bar', 'line', 'area', 'pie', 'donut', 'kpi'], true) ? $spec['viz'] : 'bar'];

            $ok = true;
            if (!empty($spec['joins'])) {
                $joins = [];
                foreach ($spec['joins'] as $j) {
                    $jf = $resolveForm($j['formId'] ?? null);
                    if ($jf === null) { $ok = false; break; }
                    $joins[] = ['via' => (string) ($j['via'] ?? ''), 'formId' => $jf, 'type' => ($j['type'] ?? 'left') === 'inner' ? 'inner' : 'left'];
                }
                if (!$ok) { continue; }
                $ns['joins'] = $joins;
            }
            if (!empty($spec['groupBy']['field'])) {
                $gf = $resolveFieldRef($spec['groupBy']['field']);
                if ($gf === null) { continue; }
                $ns['groupBy'] = ['field' => $gf];
                if (!empty($spec['groupBy']['bucket'])) { $ns['groupBy']['bucket'] = $spec['groupBy']['bucket']; }
            }
            if (!empty($spec['measure'])) {
                $m = $spec['measure'];
                if (isset($m['field'])) {
                    $mf = $resolveFieldRef($m['field']);
                    if ($mf === null) { continue; }
                    $m['field'] = $mf;
                }
                $ns['measure'] = $m;
            }
            if (!empty($spec['filters'])) {
                $filters = [];
                foreach ($spec['filters'] as $f) {
                    $ff = $resolveFieldRef($f['field'] ?? null);
                    if ($ff === null) { continue; }
                    $filters[] = ['field' => $ff, 'op' => (string) ($f['op'] ?? 'eq'), 'value' => (string) ($f['value'] ?? '')];
                }
                if ($filters) { $ns['filters'] = $filters; }
            }
            if (!empty($spec['columns'])) {
                $cols = [];
                foreach ($spec['columns'] as $c) {
                    $cf = $resolveFieldRef($c);
                    if ($cf !== null) { $cols[] = $cf; }
                }
                if ($cols) { $ns['columns'] = $cols; }
            }
            if (!empty($spec['seriesSort'])) { $ns['seriesSort'] = $spec['seriesSort']; }
            if (isset($spec['sort'])) {
                if (is_string($spec['sort'])) {
                    $ns['sort'] = $spec['sort'];
                } elseif (is_array($spec['sort']) && isset($spec['sort']['by'])) {
                    $sb = $resolveFieldRef($spec['sort']['by']);
                    if ($sb !== null) { $ns['sort'] = ['by' => $sb, 'dir' => ($spec['sort']['dir'] ?? 'asc') === 'desc' ? 'desc' : 'asc']; }
                }
            }
            if (!empty($spec['having']) && is_array($spec['having']) && isset($spec['having']['op'])) {
                $ns['having'] = ['op' => (string) $spec['having']['op'], 'value' => $spec['having']['value'] ?? 0];
            }
            if (isset($spec['limit'])) { $ns['limit'] = (int) $spec['limit']; }

            $out[] = ['id' => $id, 'name' => $r['name'] ?? 'Report', 'description' => $r['description'] ?? null, 'type' => 'builder', 'spec' => $ns];
        }
        return $out;
    }

    /**
     * Resolve @pack: refs in ONE report/widget spec → real ids. Returns null if the base form (or a
     * declared join / required field ref) can't be resolved. Mirrors the chart branch of
     * resolvePackReports so widget-dashboard specs remap identically.
     */
    private function resolveSpecRefs(array $spec, callable $resolveForm, callable $resolveFieldRef): ?array
    {
        $base = $resolveForm($spec['formId'] ?? null);
        if ($base === null) { return null; }
        $ns = ['formId' => $base, 'viz' => in_array($spec['viz'] ?? '', ['table', 'bar', 'line', 'area', 'pie', 'donut', 'kpi'], true) ? $spec['viz'] : 'bar'];
        if (!empty($spec['joins'])) {
            $joins = [];
            foreach ($spec['joins'] as $j) {
                $jf = $resolveForm($j['formId'] ?? null);
                if ($jf === null) { return null; }
                $joins[] = ['via' => (string) ($j['via'] ?? ''), 'formId' => $jf, 'type' => ($j['type'] ?? 'left') === 'inner' ? 'inner' : 'left'];
            }
            $ns['joins'] = $joins;
        }
        if (!empty($spec['groupBy']['field'])) {
            $gf = $resolveFieldRef($spec['groupBy']['field']);
            if ($gf === null) { return null; }
            $ns['groupBy'] = ['field' => $gf];
            if (!empty($spec['groupBy']['bucket'])) { $ns['groupBy']['bucket'] = $spec['groupBy']['bucket']; }
        }
        if (!empty($spec['measure'])) {
            $m = $spec['measure'];
            if (isset($m['field'])) { $mf = $resolveFieldRef($m['field']); if ($mf === null) { return null; } $m['field'] = $mf; }
            $ns['measure'] = $m;
        }
        if (!empty($spec['filters'])) {
            $filters = [];
            foreach ($spec['filters'] as $f) {
                $ff = $resolveFieldRef($f['field'] ?? null);
                if ($ff === null) { continue; }
                $filters[] = ['field' => $ff, 'op' => (string) ($f['op'] ?? 'eq'), 'value' => (string) ($f['value'] ?? '')];
            }
            if ($filters) { $ns['filters'] = $filters; }
        }
        if (!empty($spec['columns'])) {
            $cols = [];
            foreach ($spec['columns'] as $c) { $cf = $resolveFieldRef($c); if ($cf !== null) { $cols[] = $cf; } }
            if ($cols) { $ns['columns'] = $cols; }
        }
        if (!empty($spec['seriesSort'])) { $ns['seriesSort'] = $spec['seriesSort']; }
        if (isset($spec['sort'])) {
            if (is_string($spec['sort'])) { $ns['sort'] = $spec['sort']; }
            elseif (is_array($spec['sort']) && isset($spec['sort']['by'])) {
                $sb = $resolveFieldRef($spec['sort']['by']);
                if ($sb !== null) { $ns['sort'] = ['by' => $sb, 'dir' => ($spec['sort']['dir'] ?? 'asc') === 'desc' ? 'desc' : 'asc']; }
            }
        }
        if (!empty($spec['having']) && is_array($spec['having']) && isset($spec['having']['op'])) {
            $ns['having'] = ['op' => (string) $spec['having']['op'], 'value' => $spec['having']['value'] ?? 0];
        }
        if (isset($spec['limit'])) { $ns['limit'] = (int) $spec['limit']; }
        return $ns;
    }

    /** Resolve @pack: refs inside a widget-dashboard config → real ids (install/refresh side). */
    public function resolvePackDashboard(array $dashboard, array $formIdMap): array
    {
        $resolveForm = static function (mixed $ref) use ($formIdMap): ?string {
            if (!is_string($ref) || $ref === '') { return null; }
            if (str_starts_with($ref, '@pack:')) { return $formIdMap[substr($ref, 6)] ?? null; }
            return $ref; // already a real id (defensive)
        };
        $resolveFieldRef = static function (mixed $ref) use ($formIdMap): ?string {
            if (!is_string($ref) || $ref === '') { return null; }
            if (!str_contains($ref, '::')) { return $ref; }
            [$fp, $fid] = explode('::', $ref, 2);
            if (!str_starts_with($fp, '@pack:')) { return $ref; }
            $id = $formIdMap[substr($fp, 6)] ?? null;
            return $id !== null ? $id . '::' . $fid : null;
        };
        $widgets = [];
        foreach ($dashboard['widgets'] ?? [] as $w) {
            if (!is_array($w)) { continue; }
            $kind = $w['kind'] ?? '';
            if ($kind === 'report' && is_array($w['spec'] ?? null)) {
                $ns = $this->resolveSpecRefs($w['spec'], $resolveForm, $resolveFieldRef);
                if ($ns === null) { continue; }
                $w['spec'] = $ns;
            } elseif ($kind === 'list' && is_array($w['list'] ?? null)) {
                $lf = $resolveForm($w['list']['formId'] ?? null);
                if ($lf === null) { continue; }
                $w['list']['formId'] = $lf;
            }
            $widgets[] = $w;
        }
        return ['version' => 1, 'cols' => (int) ($dashboard['cols'] ?? 12), 'widgets' => array_values($widgets)];
    }

    /** Resolve @pack: refs in a customScreen (only widget dashboards carry them). */
    private function resolveCustomScreen(?array $cs, array $formIdMap): ?array
    {
        if (empty($cs)) { return null; }
        if (($cs['kind'] ?? '') === 'dashboard' && is_array($cs['dashboard'] ?? null)) {
            $cs['dashboard'] = $this->resolvePackDashboard($cs['dashboard'], $formIdMap);
        }
        return $cs;
    }

    /** First-party vendor keys whose pack signatures may upgrade screen trust
     *  (base64 raw Ed25519 public keys). Deployments extend the set via
     *  FORMLOGIC_TRUSTED_PACK_PUBLISHERS (comma-separated base64 keys). */
    private const TRUSTED_PACK_PUBLISHER_KEYS = [
        'eamh+xP/gXSntFtyIW3NajOAZHID9co9rMxZljWCXKw=', // fl-packs-2026a
    ];

    private const PACK_SIGNING_FORMAT = 'formlogic-pack-vendor/1';

    /** Netstring framing `<byte-length>:<value>,` — INJECTIVE (a value that
     *  contains the delimiter or a NUL can never be read as a field boundary).
     *  strlen() is a byte count and matches JS Buffer.byteLength(…,'utf8'). */
    private function frameToken(string $s): string
    {
        return strlen($s) . ':' . $s . ',';
    }

    /**
     * sha256 hex over a customScreen's EXECUTABLE surfaces (top-level +
     * recordScreen: kind/entry/html/css/js/ts + files) — byte-for-byte the
     * recipe in formlogic/ui/scripts/packSigning.mjs (netstring-framed tokens).
     * Keep the two in lock-step: PackVendorSigningTest recomputes every emitted
     * marketplace pack's digests here and fails on any drift. Deliberately NOT
     * canonical-JSON — a self-delimiting token stream has no cross-language
     * serialization surface to rot.
     */
    private function customScreenDigest(array $screen): string
    {
        $tokens = [];
        $scopes = [['', $screen]];
        $record = $screen['recordScreen'] ?? null;
        if (is_array($record)) {
            $scopes[] = ['record.', $record];
        }
        foreach ($scopes as [$prefix, $scope]) {
            foreach (['kind', 'entry', 'html', 'css', 'js', 'ts'] as $k) {
                if (is_string($scope[$k] ?? null)) {
                    $tokens[] = $prefix . $k;
                    $tokens[] = $scope[$k];
                }
            }
            // ONLY a LIST of {path,content} string entries contributes — a
            // json_decode'd JSON object is an array in PHP, so array_is_list
            // + the string guards keep parity with JS's Array.isArray/typeof.
            $files = $scope['files'] ?? null;
            if (is_array($files) && array_is_list($files)) {
                foreach ($files as $f) {
                    if (is_array($f) && is_string($f['path'] ?? null) && is_string($f['content'] ?? null)) {
                        $tokens[] = $prefix . 'file';
                        $tokens[] = $f['path'];
                        $tokens[] = $f['content'];
                    }
                }
            }
        }
        return hash('sha256', implode('', array_map([$this, 'frameToken'], $tokens)));
    }

    /** The signed bytes for a pack's component-digest manifest (mirrors
     *  packSigning.mjs signingMessage — netstring-framed, byte-sorted keys). */
    private function packSigningMessage(string $packId, string $version, array $components): string
    {
        $tokens = [self::PACK_SIGNING_FORMAT, $packId, $version];
        $keys = array_keys($components);
        sort($keys, SORT_STRING);
        foreach ($keys as $k) {
            $tokens[] = (string) $k;
            $tokens[] = (string) $components[$k];
        }
        return implode('', array_map([$this, 'frameToken'], $tokens));
    }

    /**
     * Verify a pack's embedded vendor-signing block (APP-501). Returns the
     * TRUSTED signed component-digest map + signing identity, or null when the
     * pack is unsigned, malformed, signed by an UNPINNED publisher, or the
     * signature fails — the import then behaves exactly as an unsigned one.
     *
     * The per-component VERDICT is deliberately NOT decided here: each created
     * form/app is judged against this map at stamp time by its OWN screen
     * bytes (componentScreenTrust), so a duplicate pack id can never let a
     * malicious component inherit a sibling's match.
     *
     * @return array{keyId:string,publisher:string,digests:array<string,string>}|null
     */
    private function verifyPackSigning(array $packData): ?array
    {
        $signing = $packData['signing'] ?? null;
        if (!is_array($signing)
            || ($signing['format'] ?? '') !== self::PACK_SIGNING_FORMAT
            || ($signing['alg'] ?? '') !== 'ed25519'
            || !function_exists('sodium_crypto_sign_verify_detached')) {
            return null;
        }
        $components = is_array($signing['components'] ?? null) ? $signing['components'] : [];
        $pub = base64_decode((string) ($signing['publisherKeyB64'] ?? ''), true);
        $sig = base64_decode((string) ($signing['signature'] ?? ''), true);
        if ($components === [] || $pub === false || $sig === false
            || strlen($pub) !== SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES
            || strlen($sig) !== SODIUM_CRYPTO_SIGN_BYTES) {
            return null;
        }
        // Only string→string digest entries are trusted (a non-string value
        // must never be treated as an expected digest).
        foreach ($components as $k => $v) {
            if (!is_string($k) || !is_string($v)) {
                return null;
            }
        }
        // The embedded key proves nothing by itself — it must be PINNED
        // (first-party constant, or deployment-extended via env).
        $trusted = self::TRUSTED_PACK_PUBLISHER_KEYS;
        $extra = (string) ($_ENV['FORMLOGIC_TRUSTED_PACK_PUBLISHERS'] ?? (getenv('FORMLOGIC_TRUSTED_PACK_PUBLISHERS') ?: ''));
        foreach (array_filter(array_map('trim', explode(',', $extra))) as $k) {
            $trusted[] = $k;
        }
        if (!in_array(base64_encode($pub), $trusted, true)) {
            return null;
        }
        $meta = is_array($packData['packMeta'] ?? null) ? $packData['packMeta'] : [];
        $message = $this->packSigningMessage(
            (string) ($meta['id'] ?? ''),
            (string) ($meta['version'] ?? ''),
            $components
        );
        if (!sodium_crypto_sign_verify_detached($sig, $message, $pub)) {
            return null;
        }
        return [
            'keyId' => (string) ($signing['keyId'] ?? ''),
            'publisher' => base64_encode($pub),
            'digests' => $components,
        ];
    }

    /**
     * Verify one custom-screen component against a trusted vendor-signed pack.
     *
     * In-place pack migrations use this public seam before replacing executable
     * screen content. It intentionally accepts neither catalog trust nor an
     * embedded public key on its own: the publisher must be pinned, the pack
     * signature must verify, and this component's executable bytes must match
     * its signed digest.
     *
     * @return array{trust:string,provenance:array<string,mixed>}
     */
    public function verifyVendorSignedScreenComponent(
        array $packData,
        string $componentKey,
        array $screen
    ): array {
        if (!preg_match('/^(form|app):[a-z0-9][a-z0-9-]{0,99}$/', $componentKey)) {
            throw new \InvalidArgumentException('Invalid signed screen component key');
        }
        $signing = $this->verifyPackSigning($packData);
        if ($signing === null) {
            throw new \RuntimeException('Pack vendor signature is missing or untrusted');
        }
        [$trust, $provenance] = $this->componentScreenTrust(
            $componentKey,
            $signing,
            $screen,
            'untrusted',
            ['source' => 'migration']
        );
        if ($trust !== 'verified') {
            throw new \RuntimeException("Pack screen component '{$componentKey}' does not match its signed digest");
        }
        return ['trust' => $trust, 'provenance' => $provenance];
    }

    /**
     * Effective trust for ONE screen component. Vendor signing may only ever
     * UPGRADE an otherwise-untrusted import to 'verified' — and ONLY when THIS
     * component's own bytes hash to the signed digest for its key. A signed
     * pack whose component was edited (or a duplicate-id sibling) stays
     * untrusted with 'vendor_modified' provenance; signing never downgrades
     * catalog/owner-derived trust, and a component absent from the manifest
     * carries no vendor claim.
     *
     * @param array{keyId:string,publisher:string,digests:array<string,string>}|null $signing
     * @param array<string,mixed> $screen The ACTUAL customScreen being stamped.
     * @return array{0:string,1:array<string,mixed>}
     */
    private function componentScreenTrust(
        string $componentKey,
        ?array $signing,
        array $screen,
        string $baseTrust,
        array $baseProvenance
    ): array {
        if ($signing === null || $baseTrust !== 'untrusted') {
            return [$baseTrust, $baseProvenance];
        }
        $expected = $signing['digests'][$componentKey] ?? null;
        if ($expected === null) {
            // Not covered by the vendor signature — no vendor claim.
            return [$baseTrust, $baseProvenance];
        }
        if (hash_equals($expected, $this->customScreenDigest($screen))) {
            return ['verified', [
                'source' => 'vendor-signed',
                'keyId' => $signing['keyId'],
                'publisher' => $signing['publisher'],
                'component' => $componentKey,
            ]];
        }
        return ['untrusted', [
            'source' => 'vendor-signed',
            'verdict' => 'vendor_modified',
            'keyId' => $signing['keyId'],
            'component' => $componentKey,
        ]];
    }

    /**
     * Normalize a reviewed connector-grant allow-list into a lookup set.
     * null (no review — trusted internal callers only) stays null.
     *
     * @param list<string>|null $grants
     * @return array<string,bool>|null perm-string => true
     */
    private function normalizeApprovedGrants(?array $grants): ?array
    {
        if ($grants === null) {
            return null;
        }
        $set = [];
        foreach ($grants as $g) {
            if (is_string($g) && $g !== '') {
                $set[$g] = true;
            }
        }
        return $set;
    }

    /**
     * APP-502: filter an app customLogic bundle so only APPROVED connector
     * grants survive (bundle-level + per-script permissions). Non-connector
     * permissions and the scripts themselves are untouched — permissions are a
     * pure grant declaration scripts never reference, so a withheld grant just
     * denies that effect/command at runtime. $approvedSet null = no review.
     *
     * @param array<string,mixed>|null $customLogic
     * @param array<string,bool>|null  $approvedSet  perm-string => true
     * @param array<string,bool>       $withheld     accumulator (by reference)
     * @return array<string,mixed>|null
     */
    private function reviewCustomLogicGrants(?array $customLogic, ?array $approvedSet, array &$withheld): ?array
    {
        if ($customLogic === null || $approvedSet === null) {
            return $customLogic;
        }
        if (isset($customLogic['permissions']) && is_array($customLogic['permissions'])) {
            $customLogic['permissions'] = $this->filterGrantList($customLogic['permissions'], $approvedSet, $withheld);
        }
        if (isset($customLogic['scripts']) && is_array($customLogic['scripts'])) {
            foreach ($customLogic['scripts'] as &$script) {
                if (is_array($script) && isset($script['permissions']) && is_array($script['permissions'])) {
                    $script['permissions'] = $this->filterGrantList($script['permissions'], $approvedSet, $withheld);
                }
            }
            unset($script);
        }
        return $customLogic;
    }

    /**
     * Keep every non-connector permission and every connector grant present in
     * $approvedSet; drop the rest (recording them in $withheld). Non-string
     * entries pass through untouched (the sanitizer owns their validation).
     *
     * @param array<int,mixed>   $perms
     * @param array<string,bool> $approvedSet
     * @param array<string,bool> $withheld
     * @return list<mixed>
     */
    private function filterGrantList(array $perms, array $approvedSet, array &$withheld): array
    {
        $out = [];
        foreach ($perms as $p) {
            // Strip (withhold) a reviewable connector grant that was not
            // approved; keep everything else (non-connector perms, non-strings,
            // and approved grants). The is_string checks here narrow $p to a
            // string for the $withheld key.
            if (is_string($p) && $this->isReviewableConnectorGrant($p) && !isset($approvedSet[$p])) {
                $withheld[$p] = true;
            } else {
                $out[] = $p;
            }
        }
        return array_values($out);
    }

    /**
     * A reviewable connector grant for APP-502: ANY 'connector.'-prefixed
     * string. Deliberately looser than AppPermissions::isConnectorGrant (which
     * VALIDATES what may persist as a role grant): the runtime client gate
     * honors wildcard grants like 'connector.*' as covering every command, and
     * the review UI presents every 'connector.'-prefixed permission as
     * declinable — so the strip filter must govern that same set, or a declined
     * wildcard/malformed grant would survive (review 2026-07-17).
     */
    private function isReviewableConnectorGrant(mixed $p): bool
    {
        return is_string($p) && strncmp($p, 'connector.', 10) === 0;
    }

    /**
     * APP-502 describe support: the embedded vendor-signing verdict for the
     * install review UI — whether the pack is vendor-signed by a PINNED
     * publisher, and which screen components verify vs. read as modified. Pure
     * (no writes); mirrors the per-component judgement importPack applies.
     *
     * @param array<string,mixed> $packData
     * @return array{signed:bool,keyId?:string,publisher?:string,verified?:list<string>,modified?:list<string>}
     */
    public function describeSigning(array $packData): array
    {
        $signing = $this->verifyPackSigning($packData);
        if ($signing === null) {
            return ['signed' => false];
        }
        $verified = [];
        $modified = [];
        $classify = function (string $key, $screen) use ($signing, &$verified, &$modified): void {
            if (!is_array($screen) || $screen === []) {
                return;
            }
            $expected = $signing['digests'][$key] ?? null;
            if ($expected === null) {
                // Not covered by the vendor signature — no vendor claim either
                // way (matches componentScreenTrust: base trust unchanged).
                return;
            }
            if (hash_equals($expected, $this->customScreenDigest($screen))) {
                $verified[] = $key;
            } else {
                $modified[] = $key;
            }
        };
        foreach ($packData['forms'] ?? [] as $form) {
            $classify('form:' . (string) ($form['packFormId'] ?? ''), $form['customScreen'] ?? null);
        }
        foreach ($packData['apps'] ?? [] as $app) {
            $classify('app:' . (string) ($app['packAppId'] ?? ''), $app['customScreen'] ?? null);
        }
        return [
            'signed' => true,
            'keyId' => $signing['keyId'],
            'publisher' => $signing['publisher'],
            'verified' => $verified,
            'modified' => $modified,
        ];
    }

    /**
     * Server-derived provenance for executable screens. Direct/community
     * imports are untrusted; a positively verified catalog publisher is
     * trusted; a publisher installing their own private pack is owner-authored.
     * Client pack JSON never participates in this decision.
     *
     * @return array{0:string,1:array<string,mixed>}
     */
    private function screenTrustForImport(?string $catalogId, ?string $versionId, string $userId): array
    {
        if ($catalogId === null) {
            return ['untrusted', ['source' => 'direct-import']];
        }
        $stmt = $this->mysql->prepare(
            'SELECT trust_level, publisher_id FROM pack_catalog WHERE id = :id LIMIT 1'
        );
        $stmt->execute(['id' => $catalogId]);
        $row = $stmt->fetch() ?: [];
        $catalogTrust = (string) ($row['trust_level'] ?? 'community');
        $trust = ((string) ($row['publisher_id'] ?? '') === $userId)
            ? 'owner'
            : (in_array($catalogTrust, ['official', 'verified'], true) ? 'verified' : 'untrusted');
        return [$trust, [
            'source' => 'catalog',
            'catalogId' => $catalogId,
            'versionId' => $versionId,
            'catalogTrust' => $catalogTrust,
        ]];
    }

    /** Inverse of resolvePackDashboard: rewrite real form ids in a dashboard → @pack: refs for export. */
    private function packifyDashboard(array $dashboard, array $realToPackKey): array
    {
        $packForm = static function (mixed $ref) use ($realToPackKey): ?string {
            if (!is_string($ref) || $ref === '') { return null; }
            if (str_starts_with($ref, '@pack:')) { return $ref; }
            return isset($realToPackKey[$ref]) ? '@pack:' . $realToPackKey[$ref] : null;
        };
        $packFieldRef = static function (mixed $ref) use ($realToPackKey): ?string {
            if (!is_string($ref) || $ref === '') { return null; }
            if (!str_contains($ref, '::')) { return $ref; }
            [$f0, $fid] = explode('::', $ref, 2);
            if (str_starts_with($f0, '@pack:')) { return $ref; }
            return isset($realToPackKey[$f0]) ? '@pack:' . $realToPackKey[$f0] . '::' . $fid : null;
        };
        $widgets = [];
        foreach ($dashboard['widgets'] ?? [] as $w) {
            if (!is_array($w)) { continue; }
            $kind = $w['kind'] ?? '';
            if ($kind === 'report' && is_array($w['spec'] ?? null)) {
                $ns = $this->resolveSpecRefs($w['spec'], $packForm, $packFieldRef);
                if ($ns === null) { continue; } // form outside the exported app → drop (never leak a UUID)
                $w['spec'] = $ns;
            } elseif ($kind === 'list' && is_array($w['list'] ?? null)) {
                $lf = $packForm($w['list']['formId'] ?? null);
                if ($lf === null) { continue; }
                $w['list']['formId'] = $lf;
            }
            $widgets[] = $w;
        }
        return ['version' => 1, 'cols' => (int) ($dashboard['cols'] ?? 12), 'widgets' => array_values($widgets)];
    }

    /** Packify a customScreen for export (only widget dashboards carry form refs to rewrite). */
    private function packifyCustomScreen(?array $cs, array $realToPackKey): ?array
    {
        if (empty($cs)) { return null; }
        if (($cs['kind'] ?? '') === 'dashboard' && is_array($cs['dashboard'] ?? null)) {
            $cs['dashboard'] = $this->packifyDashboard($cs['dashboard'], $realToPackKey);
        }
        return $cs;
    }

    /**
     * Inverse of resolvePackReports: rewrite a saved app's reports (apps.reports) into portable pack report
     * items, mapping real form ids back to `@pack:<key>`. A report referencing a form OUTSIDE the exported
     * app is dropped (never leak a foreign UUID / emit a dangling import).
     *
     * @param array $reports AppReportItem[] from apps.reports
     * @param array<string,string> $realToPackKey real form id => packFormId (slug)
     * @return array PackReportItem[]
     */
    private function packifyReports(array $reports, array $realToPackKey): array
    {
        $packForm = static function (mixed $ref) use ($realToPackKey): ?string {
            if (!is_string($ref)) { return null; }
            return isset($realToPackKey[$ref]) ? '@pack:' . $realToPackKey[$ref] : null;
        };
        $packFieldRef = static function (mixed $ref) use ($realToPackKey): ?string {
            if (!is_string($ref) || $ref === '') { return null; }
            if (!str_contains($ref, '::')) { return $ref; } // base field / pseudo-field
            [$fid0, $fid] = explode('::', $ref, 2);
            return isset($realToPackKey[$fid0]) ? '@pack:' . $realToPackKey[$fid0] . '::' . $fid : null;
        };

        $out = [];
        foreach ($reports as $item) {
            $rid = (string) ($item['id'] ?? '');
            if ($rid === '') { continue; }

            if (($item['type'] ?? '') === 'document') {
                $blocks = [];
                foreach ($item['blocks'] ?? [] as $b) {
                    if (($b['kind'] ?? '') === 'text') {
                        $blocks[] = array_filter(['kind' => 'text', 'title' => $b['title'] ?? null, 'body' => (string) ($b['body'] ?? '')], static fn ($v) => $v !== null);
                    } elseif (($b['kind'] ?? '') === 'report') {
                        $blocks[] = array_filter(['kind' => 'report', 'reportId' => (string) ($b['reportId'] ?? ''), 'caption' => $b['caption'] ?? null], static fn ($v) => $v !== null);
                    }
                }
                if ($blocks) {
                    $out[] = array_filter(['reportId' => $rid, 'kind' => 'document', 'name' => $item['name'] ?? 'Document', 'description' => $item['description'] ?? null, 'blocks' => $blocks], static fn ($v) => $v !== null);
                }
                continue;
            }

            $spec = is_array($item['spec'] ?? null) ? $item['spec'] : null;
            if (!$spec) { continue; }
            $base = $packForm($spec['formId'] ?? null);
            if ($base === null) { continue; } // form not in the exported app
            $ns = ['formId' => $base, 'viz' => $spec['viz'] ?? 'bar'];
            $ok = true;
            if (!empty($spec['joins'])) {
                $joins = [];
                foreach ($spec['joins'] as $j) {
                    $jf = $packForm($j['formId'] ?? null);
                    if ($jf === null) { $ok = false; break; }
                    $joins[] = array_filter(['via' => $j['via'] ?? '', 'formId' => $jf, 'type' => $j['type'] ?? 'left'], static fn ($v) => $v !== null);
                }
                if (!$ok) { continue; }
                $ns['joins'] = $joins;
            }
            if (!empty($spec['groupBy']['field'])) {
                $gf = $packFieldRef($spec['groupBy']['field']);
                if ($gf === null) { continue; }
                $ns['groupBy'] = ['field' => $gf];
                if (!empty($spec['groupBy']['bucket'])) { $ns['groupBy']['bucket'] = $spec['groupBy']['bucket']; }
            }
            if (!empty($spec['measure'])) {
                $m = $spec['measure'];
                if (isset($m['field'])) {
                    $mf = $packFieldRef($m['field']);
                    if ($mf === null) { continue; }
                    $m['field'] = $mf;
                }
                $ns['measure'] = $m;
            }
            if (!empty($spec['filters'])) {
                $filters = [];
                foreach ($spec['filters'] as $f) {
                    $ff = $packFieldRef($f['field'] ?? null);
                    if ($ff === null) { continue; }
                    $filters[] = array_filter(['field' => $ff, 'op' => $f['op'] ?? 'eq', 'value' => $f['value'] ?? ''], static fn ($v) => $v !== null && $v !== '');
                }
                if ($filters) { $ns['filters'] = $filters; }
            }
            if (!empty($spec['columns'])) {
                $cols = [];
                foreach ($spec['columns'] as $c) {
                    $cf = $packFieldRef($c);
                    if ($cf !== null) { $cols[] = $cf; }
                }
                if ($cols) { $ns['columns'] = $cols; }
            }
            if (!empty($spec['seriesSort'])) { $ns['seriesSort'] = $spec['seriesSort']; }
            if (isset($spec['sort'])) {
                if (is_string($spec['sort'])) {
                    $ns['sort'] = $spec['sort'];
                } elseif (is_array($spec['sort']) && isset($spec['sort']['by'])) {
                    $sb = $packFieldRef($spec['sort']['by']);
                    if ($sb !== null) { $ns['sort'] = ['by' => $sb, 'dir' => ($spec['sort']['dir'] ?? 'asc') === 'desc' ? 'desc' : 'asc']; }
                }
            }
            if (!empty($spec['having']) && is_array($spec['having']) && isset($spec['having']['op'])) {
                $ns['having'] = ['op' => (string) $spec['having']['op'], 'value' => $spec['having']['value'] ?? 0];
            }
            if (isset($spec['limit'])) { $ns['limit'] = (int) $spec['limit']; }

            $out[] = array_filter(['reportId' => $rid, 'kind' => 'chart', 'name' => $item['name'] ?? 'Report', 'description' => $item['description'] ?? null, 'spec' => $ns], static fn ($v) => $v !== null);
        }
        return $out;
    }

    /**
     * Object-shaped fields (settings/theme/properties) must serialize as a JSON object, but an empty PHP
     * array encodes as `[]`. Force empty maps to a stdClass so they export as `{}` (cleaner for validators
     * / external AI / JSON Schema). Non-empty assoc arrays already encode as objects. Lists stay arrays.
     */
    private function jsonObject(mixed $v): mixed
    {
        return (is_array($v) && $v === []) ? new \stdClass() : $v;
    }

    /** Slugify a name into a pack key (lowercase, hyphenated, max 50 chars). */
    private function slugify(string $name): string
    {
        $slug = strtolower(trim($name));
        $slug = preg_replace('/[^a-z0-9]+/', '-', $slug) ?? '';
        $slug = trim($slug, '-');
        return $slug !== '' ? substr($slug, 0, 50) : 'form';
    }

    /** A slug unique within the exported pack (appends -2, -3, … on collision). */
    private function uniqueSlug(string $name, array &$used): string
    {
        $base = $this->slugify($name);
        $key = $base;
        $n = 2;
        while (isset($used[$key])) {
            $key = $base . '-' . $n;
            $n++;
        }
        $used[$key] = true;
        return $key;
    }

    /**
     * Return a set (id => true) of which of the given ids exist in $table.
     * $table is a fixed internal value ('forms' | 'apps'), never user input.
     */
    private function existingIds(string $table, array $ids): array
    {
        if (empty($ids)) {
            return [];
        }
        $placeholders = implode(',', array_fill(0, count($ids), '?'));
        $stmt = $this->mysql->prepare("SELECT id FROM {$table} WHERE id IN ($placeholders)");
        $stmt->execute(array_values($ids));
        return array_fill_keys($stmt->fetchAll(\PDO::FETCH_COLUMN), true);
    }

    private function generateUuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use PDO;

/**
 * Narrow in-place upgrade for an already-installed Aokie Receptionist pack.
 *
 * This deliberately is not a second pack import: the installed app/form ids and
 * every response stay in place. The pack's stable app_forms.settings.packFormId
 * aliases are the only accepted source of form identity. Any missing or
 * ambiguous installation, alias, flow, or binding fails closed before writes.
 */
final class AokieReceptionistUpgradeService
{
    public const PACK_ID = 'aokie-receptionist';
    public const PACK_APP_ID = 'aokie-receptionist';
    public const SETTINGS_FORM_ID = 'receptionist-settings';

    /** @var string[] */
    public const FLOW_SLUGS = [
        'configure-receptionist',
        'call-summary-follow-up',
        'sms-auto-reply-draft',
        'sms-followup-conversation',
        'after-call-actions',
        'appointment-request-apply',
    ];

    /** @var string[] */
    private const ADDITIVE_FLOW_SLUGS = [
        'appointment-request-apply',
    ];

    /** @var string[] */
    private const SETTLED_BINDING_FLOWS = [
        'call-summary-follow-up',
        'after-call-actions',
    ];

    /** @var string[] */
    private const BACKGROUND_FIELD_IDS = [
        'background_ai_source',
        'background_ai_model',
    ];

    /** @var array<string,string[]> */
    private const ADDITIVE_FORM_FIELD_IDS = [
        'appointments' => ['request_id'],
        'follow-up-tasks' => ['request_id'],
    ];

    /**
     * Full canonical-screen digests from legacy, publisher-signed Aokie packs.
     * The sole value below is anchored by repository releases 8ec5f400 and
     * bd3cb1e5 under publisher fl-packs-2026a. It covers the exact historical
     * screen, not merely its executable files or structural shape.
     *
     * @var string[]
     */
    private const KNOWN_LEGACY_SCREEN_SHA256 = [
        'a41e8600774bf22277d42299a604da5e5e08ccfa6c1dec5ada732eacc4898af7',
    ];

    private PDO $mysql;

    public function __construct(
        MySQLConnection $mysql,
        private FormService $forms,
        private FormVersionService $versions,
        private FlowService $flows,
        private PackService $packs
    ) {
        $this->mysql = $mysql->getConnection();
    }

    /**
     * Inspect or apply the migration.
     *
     * @return array<string,mixed> bounded, content-free operator summary
     */
    public function run(
        string $appId,
        array $marketplaceRecord,
        bool $apply,
        ?string $acceptedLegacyScreenSha256 = null
    ): array
    {
        if (!preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i', $appId)) {
            throw new \InvalidArgumentException('A canonical app UUID is required');
        }
        if ($acceptedLegacyScreenSha256 !== null) {
            $acceptedLegacyScreenSha256 = strtolower(trim($acceptedLegacyScreenSha256));
            if (!preg_match('/^[0-9a-f]{64}$/', $acceptedLegacyScreenSha256)) {
                throw new \InvalidArgumentException('Accepted legacy screen SHA-256 must be 64 hexadecimal characters');
            }
            if (!in_array($acceptedLegacyScreenSha256, self::KNOWN_LEGACY_SCREEN_SHA256, true)) {
                throw new \InvalidArgumentException('Accepted screen SHA-256 is not a known legacy Aokie screen');
            }
        }

        $source = $this->validateSourcePack($marketplaceRecord);
        $installed = $this->resolveInstalledApp($appId, $source['packFormIds']);
        $desiredFlows = $this->prepareDesiredFlows($source['flows'], $installed['formMap']);
        $installedFlows = $this->resolveInstalledFlows($appId, $installed['ownerId']);
        foreach (self::ADDITIVE_FLOW_SLUGS as $slug) {
            if ($installedFlows[$slug] !== null
                && !$this->flowMatches($installedFlows[$slug], $desiredFlows[$slug])) {
                throw new \RuntimeException("Installed additive flow '{$slug}' collides with an owner-authored flow");
            }
        }
        $desiredAppointmentBinding = $this->prepareAppointmentBinding(
            $source['appointmentBinding'],
            $installed['formMap']
        );
        $bindings = $this->resolveBindings(
            $appId,
            $installedFlows,
            $desiredAppointmentBinding
        );

        $settingsForm = $this->forms->getForm($installed['formMap'][self::SETTINGS_FORM_ID]);
        if ($settingsForm === null) {
            throw new \RuntimeException('Receptionist Settings form is missing');
        }
        $legacyScreenAccepted = $this->assertPackOwnedScreen(
            $settingsForm,
            $installed['installationCatalogId'],
            $source['settingsScreen'],
            $acceptedLegacyScreenSha256
        );

        $fieldIds = [];
        foreach ($settingsForm['fields'] as $field) {
            if (is_array($field) && is_string($field['id'] ?? null)) {
                if (isset($fieldIds[$field['id']])) {
                    throw new \RuntimeException('Receptionist Settings contains duplicate field IDs');
                }
                $fieldIds[$field['id']] = true;
            }
        }
        $missingFields = [];
        foreach (self::BACKGROUND_FIELD_IDS as $fieldId) {
            if (!isset($fieldIds[$fieldId])) {
                $missingFields[] = $fieldId;
            }
        }

        $recordForms = [];
        $missingRecordFields = [];
        foreach (self::ADDITIVE_FORM_FIELD_IDS as $packFormId => $wantedFieldIds) {
            $recordForm = $this->forms->getForm($installed['formMap'][$packFormId]);
            if ($recordForm === null) {
                throw new \RuntimeException("Installed pack form '{$packFormId}' is missing");
            }
            $recordForms[$packFormId] = $recordForm;
            $byId = [];
            foreach ($recordForm['fields'] as $field) {
                $fieldId = is_array($field) ? ($field['id'] ?? null) : null;
                if (!is_string($fieldId)) {
                    continue;
                }
                if (isset($byId[$fieldId])) {
                    throw new \RuntimeException("Installed pack form '{$packFormId}' contains duplicate field IDs");
                }
                $byId[$fieldId] = $field;
            }
            foreach ($wantedFieldIds as $fieldId) {
                $desiredField = $source['additiveFields'][$packFormId][$fieldId];
                if (!isset($byId[$fieldId])) {
                    $missingRecordFields[$packFormId][] = $fieldId;
                    continue;
                }
                if (!$this->packFieldMatches($byId[$fieldId], $desiredField)) {
                    throw new \RuntimeException(
                        "Installed pack field '{$packFormId}.{$fieldId}' is owner-authored or incompatible"
                    );
                }
            }
        }

        $currentScreen = $this->screenWithoutMetadata($settingsForm['customScreen'] ?? []);
        $screenChanges = !$this->sameValue($currentScreen, $source['settingsScreen']);

        $flowChanges = [];
        foreach (self::FLOW_SLUGS as $slug) {
            if ($installedFlows[$slug] === null
                || !$this->flowMatches($installedFlows[$slug], $desiredFlows[$slug])) {
                $flowChanges[] = $slug;
            }
        }
        $bindingChanges = [];
        foreach (self::SETTLED_BINDING_FLOWS as $slug) {
            if ($bindings[$slug]['event'] !== 'aokie.call.transcript.settled') {
                $bindingChanges[] = $slug;
            }
        }
        if ($bindings['appointment-request-apply'] === null) {
            $bindingChanges[] = 'appointment-request-apply';
        }

        $summary = [
            'mode' => $apply ? 'apply' : 'dry-run',
            'packId' => self::PACK_ID,
            'packVersion' => $source['packVersion'],
            'appId' => $appId,
            'legacyScreenAccepted' => $legacyScreenAccepted,
            'changes' => [
                'settingsFields' => $missingFields,
                'recordFields' => $missingRecordFields,
                'customScreen' => $screenChanges,
                'flows' => $flowChanges,
                'bindingEvents' => $bindingChanges,
            ],
            'snapshot' => null,
            'fieldSnapshots' => [],
            'applied' => false,
        ];

        if (!$apply) {
            return $summary;
        }

        if ($missingFields !== [] || $screenChanges) {
            // Re-read immediately before the snapshot/write so a concurrent
            // owner edit cannot ride on the earlier ownership decision.
            $freshSettingsForm = $this->forms->getForm($settingsForm['id']);
            if ($freshSettingsForm === null
                || !$this->sameValue($settingsForm['fields'], $freshSettingsForm['fields'])
                || !$this->sameValue(
                    $currentScreen,
                    $this->screenWithoutMetadata($freshSettingsForm['customScreen'] ?? [])
                )) {
                throw new \RuntimeException('Receptionist Settings changed during upgrade; retry from dry-run');
            }
            if ($screenChanges) {
                $freshLegacyAccepted = $this->assertPackOwnedScreen(
                    $freshSettingsForm,
                    $installed['installationCatalogId'],
                    $source['settingsScreen'],
                    $acceptedLegacyScreenSha256
                );
                if ($freshLegacyAccepted !== $legacyScreenAccepted) {
                    throw new \RuntimeException('Receptionist Settings screen ownership changed during upgrade');
                }
            }
            $version = $this->versions->createVersion(
                $settingsForm['id'],
                $installed['ownerId'],
                'Before Aokie Receptionist background-AI pack upgrade'
            );
            $summary['snapshot'] = ['version' => $version['version']];

            $update = [];
            if ($missingFields !== []) {
                $fields = $settingsForm['fields'];
                foreach ($missingFields as $fieldId) {
                    $fields[] = $source['backgroundFields'][$fieldId];
                }
                $update['fields'] = $fields;
            }
            if ($screenChanges) {
                $update['customScreen'] = $source['settingsScreen'];
            }
            $updated = $this->forms->updateForm($settingsForm['id'], $update);
            if ($updated === null) {
                throw new \RuntimeException('Receptionist Settings update failed');
            }
            if ($screenChanges) {
                $this->forms->setCustomScreenTrust(
                    $settingsForm['id'],
                    $source['screenTrust']['trust'],
                    $source['screenTrust']['provenance']
                );
            }
        }

        foreach ($missingRecordFields as $packFormId => $fieldIdsToAdd) {
            $original = $recordForms[$packFormId];
            $fresh = $this->forms->getForm($original['id']);
            if ($fresh === null || !$this->sameValue($original['fields'], $fresh['fields'])) {
                throw new \RuntimeException("Installed pack form '{$packFormId}' changed during upgrade; retry from dry-run");
            }
            $version = $this->versions->createVersion(
                $original['id'],
                $installed['ownerId'],
                "Before Aokie Receptionist {$packFormId} request-id upgrade"
            );
            $summary['fieldSnapshots'][$packFormId] = ['version' => $version['version']];
            $fields = $fresh['fields'];
            foreach ($fieldIdsToAdd as $fieldId) {
                $fields[] = $source['additiveFields'][$packFormId][$fieldId];
            }
            if ($this->forms->updateForm($original['id'], ['fields' => $fields]) === null) {
                throw new \RuntimeException("Installed pack form '{$packFormId}' update failed");
            }
        }

        [$updatedFlows, $updatedBindings] = $this->applyFlowChanges(
            $appId,
            $installed['ownerId'],
            $desiredFlows,
            $installedFlows,
            $bindings,
            $desiredAppointmentBinding
        );
        $summary['changes']['flows'] = $updatedFlows;
        $summary['changes']['bindingEvents'] = $updatedBindings;
        $summary['applied'] = $missingFields !== [] || $missingRecordFields !== [] || $screenChanges
            || $updatedFlows !== [] || $updatedBindings !== [];

        return $summary;
    }

    /**
     * @return array{
     *   packVersion:string,
     *   packFormIds:string[],
     *   backgroundFields:array<string,array<string,mixed>>,
     *   additiveFields:array<string,array<string,array<string,mixed>>>,
     *   settingsScreen:array<string,mixed>,
     *   screenTrust:array{trust:string,provenance:array<string,mixed>},
     *   flows:array<string,array<string,mixed>>,
     *   appointmentBinding:array<string,mixed>
     * }
     */
    private function validateSourcePack(array $record): array
    {
        if (($record['id'] ?? null) !== self::PACK_ID || !is_array($record['pack'] ?? null)) {
            throw new \RuntimeException('Marketplace record is not the Aokie Receptionist pack');
        }
        $pack = $record['pack'];
        $meta = is_array($pack['packMeta'] ?? null) ? $pack['packMeta'] : [];
        if (($meta['id'] ?? null) !== self::PACK_ID) {
            throw new \RuntimeException('Embedded pack id does not match Aokie Receptionist');
        }
        $packVersion = (string) ($meta['version'] ?? '');
        if ($packVersion === '' || strlen($packVersion) > 50) {
            throw new \RuntimeException('Embedded pack version is invalid');
        }

        $apps = array_values(array_filter(
            is_array($pack['apps'] ?? null) ? $pack['apps'] : [],
            static fn ($app): bool => is_array($app) && ($app['packAppId'] ?? null) === self::PACK_APP_ID
        ));
        if (count($apps) !== 1) {
            throw new \RuntimeException('Pack must contain exactly one Aokie Receptionist app');
        }

        $formsById = [];
        foreach (is_array($pack['forms'] ?? null) ? $pack['forms'] : [] as $form) {
            if (!is_array($form) || !is_string($form['packFormId'] ?? null) || $form['packFormId'] === '') {
                throw new \RuntimeException('Pack contains an invalid form alias');
            }
            $key = $form['packFormId'];
            if (isset($formsById[$key])) {
                throw new \RuntimeException("Pack form alias '{$key}' is ambiguous");
            }
            $formsById[$key] = $form;
        }
        $settings = $formsById[self::SETTINGS_FORM_ID] ?? null;
        if (!is_array($settings)) {
            throw new \RuntimeException('Pack is missing Receptionist Settings');
        }
        $settingsScreen = $this->screenWithoutMetadata($settings['customScreen'] ?? []);
        if ($settingsScreen === []) {
            throw new \RuntimeException('Pack is missing the Receptionist Settings custom screen');
        }

        $backgroundFields = [];
        foreach (is_array($settings['fields'] ?? null) ? $settings['fields'] : [] as $field) {
            $fieldId = is_array($field) ? ($field['id'] ?? null) : null;
            if (!is_string($fieldId) || !in_array($fieldId, self::BACKGROUND_FIELD_IDS, true)) {
                continue;
            }
            if (isset($backgroundFields[$fieldId])) {
                throw new \RuntimeException("Pack field '{$fieldId}' is ambiguous");
            }
            if (FormService::fieldIdError($fieldId) !== null
                || !is_string($field['type'] ?? null) || $field['type'] === '') {
                throw new \RuntimeException("Pack field '{$fieldId}' is invalid");
            }
            $backgroundFields[$fieldId] = $field;
        }
        foreach (self::BACKGROUND_FIELD_IDS as $fieldId) {
            if (!isset($backgroundFields[$fieldId])) {
                throw new \RuntimeException("Pack is missing field '{$fieldId}'");
            }
        }

        $additiveFields = [];
        foreach (self::ADDITIVE_FORM_FIELD_IDS as $packFormId => $fieldIds) {
            $packForm = $formsById[$packFormId] ?? null;
            if (!is_array($packForm)) {
                throw new \RuntimeException("Pack is missing form '{$packFormId}'");
            }
            $fields = [];
            foreach (is_array($packForm['fields'] ?? null) ? $packForm['fields'] : [] as $field) {
                $fieldId = is_array($field) ? ($field['id'] ?? null) : null;
                if (!is_string($fieldId) || !in_array($fieldId, $fieldIds, true)) {
                    continue;
                }
                if (isset($fields[$fieldId])) {
                    throw new \RuntimeException("Pack field '{$packFormId}.{$fieldId}' is ambiguous");
                }
                if (FormService::fieldIdError($fieldId) !== null
                    || ($field['type'] ?? null) !== 'short_text'
                    || ($field['required'] ?? null) !== false) {
                    throw new \RuntimeException("Pack field '{$packFormId}.{$fieldId}' is invalid");
                }
                $fields[$fieldId] = $field;
            }
            foreach ($fieldIds as $fieldId) {
                if (!isset($fields[$fieldId])) {
                    throw new \RuntimeException("Pack is missing field '{$packFormId}.{$fieldId}'");
                }
            }
            $additiveFields[$packFormId] = $fields;
        }

        $flows = [];
        foreach (is_array($pack['flows'] ?? null) ? $pack['flows'] : [] as $flow) {
            $slug = is_array($flow) ? ($flow['slug'] ?? null) : null;
            if (!is_string($slug) || !in_array($slug, self::FLOW_SLUGS, true)) {
                continue;
            }
            if (isset($flows[$slug])) {
                throw new \RuntimeException("Pack flow '{$slug}' is ambiguous");
            }
            $flows[$slug] = $flow;
        }
        foreach (self::FLOW_SLUGS as $slug) {
            if (!isset($flows[$slug])) {
                throw new \RuntimeException("Pack is missing flow '{$slug}'");
            }
        }

        foreach (self::SETTLED_BINDING_FLOWS as $slug) {
            $matches = array_values(array_filter(
                is_array($pack['flowBindings'] ?? null) ? $pack['flowBindings'] : [],
                static fn ($binding): bool => is_array($binding)
                    && ($binding['flow'] ?? null) === $slug
                    && ($binding['connectorId'] ?? null) === 'aokie'
            ));
            if (count($matches) !== 1 || ($matches[0]['event'] ?? null) !== 'aokie.call.transcript.settled') {
                throw new \RuntimeException("Pack binding for '{$slug}' is missing or ambiguous");
            }
        }
        $appointmentBindings = array_values(array_filter(
            is_array($pack['flowBindings'] ?? null) ? $pack['flowBindings'] : [],
            static fn ($binding): bool => is_array($binding)
                && ($binding['flow'] ?? null) === 'appointment-request-apply'
                && ($binding['connectorId'] ?? null) === 'aokie'
                && ($binding['event'] ?? null) === 'aokie.appointment.requested'
        ));
        if (count($appointmentBindings) !== 1) {
            throw new \RuntimeException('Pack appointment-request binding is missing or ambiguous');
        }

        return [
            'packVersion' => $packVersion,
            'packFormIds' => array_keys($formsById),
            'backgroundFields' => $backgroundFields,
            'additiveFields' => $additiveFields,
            'settingsScreen' => $settingsScreen,
            'screenTrust' => $this->packs->verifyVendorSignedScreenComponent(
                $pack,
                'form:' . self::SETTINGS_FORM_ID,
                $settingsScreen
            ),
            'flows' => $flows,
            'appointmentBinding' => $appointmentBindings[0],
        ];
    }

    /**
     * @param string[] $packFormIds
     * @return array{ownerId:string,installationCatalogId:?string,formMap:array<string,string>}
     */
    private function resolveInstalledApp(string $appId, array $packFormIds): array
    {
        $appStmt = $this->mysql->prepare('SELECT owner_id FROM apps WHERE id = :id LIMIT 1');
        $appStmt->execute(['id' => $appId]);
        $ownerId = $appStmt->fetchColumn();
        if (!is_string($ownerId) || $ownerId === '') {
            throw new \RuntimeException('Target app was not found');
        }

        $installStmt = $this->mysql->prepare(
            'SELECT id, catalog_id, form_ids, app_ids
               FROM pack_installations
              WHERE user_id = :owner AND pack_id = :pack'
        );
        $installStmt->execute(['owner' => $ownerId, 'pack' => self::PACK_ID]);
        $matches = [];
        foreach ($installStmt->fetchAll() as $row) {
            $appIds = $this->decodeIdList($row['app_ids'] ?? null, 'installation app list');
            if (in_array($appId, $appIds, true)) {
                if (count($appIds) !== 1) {
                    throw new \RuntimeException('Aokie installation contains an unexpected app set');
                }
                $row['decoded_form_ids'] = $this->decodeIdList($row['form_ids'] ?? null, 'installation form list');
                $matches[] = $row;
            }
        }
        if (count($matches) !== 1) {
            throw new \RuntimeException('Target app does not map to exactly one Aokie pack installation');
        }
        $installation = $matches[0];
        $installedFormSet = array_fill_keys($installation['decoded_form_ids'], true);

        $formStmt = $this->mysql->prepare(
            'SELECT af.form_id, af.settings, f.user_id
               FROM app_forms af
               JOIN forms f ON f.id = af.form_id
              WHERE af.app_id = :app'
        );
        $formStmt->execute(['app' => $appId]);
        $wanted = array_fill_keys($packFormIds, true);
        $map = [];
        foreach ($formStmt->fetchAll() as $row) {
            $settings = json_decode((string) ($row['settings'] ?? ''), true);
            $alias = is_array($settings) ? ($settings['packFormId'] ?? null) : null;
            if (!is_string($alias) || !isset($wanted[$alias])) {
                continue;
            }
            if (isset($map[$alias])) {
                throw new \RuntimeException("Installed pack form alias '{$alias}' is ambiguous");
            }
            if (($row['user_id'] ?? null) !== $ownerId || !isset($installedFormSet[$row['form_id']])) {
                throw new \RuntimeException("Installed pack form alias '{$alias}' is outside the recorded installation");
            }
            $map[$alias] = (string) $row['form_id'];
        }
        foreach ($packFormIds as $alias) {
            if (!isset($map[$alias])) {
                throw new \RuntimeException("Installed pack form alias '{$alias}' is missing");
            }
        }
        if (count(array_unique(array_values($map))) !== count($map)) {
            throw new \RuntimeException('Installed pack form aliases do not map one-to-one');
        }

        return [
            'ownerId' => $ownerId,
            'installationCatalogId' => is_string($installation['catalog_id'] ?? null)
                && $installation['catalog_id'] !== '' ? $installation['catalog_id'] : null,
            'formMap' => $map,
        ];
    }

    /** @return string[] */
    private function decodeIdList(mixed $json, string $label): array
    {
        $ids = is_string($json) ? json_decode($json, true) : null;
        if (!is_array($ids) || !array_is_list($ids)) {
            throw new \RuntimeException("Recorded {$label} is invalid");
        }
        $out = [];
        foreach ($ids as $id) {
            if (!is_string($id) || $id === '' || isset($out[$id])) {
                throw new \RuntimeException("Recorded {$label} is invalid");
            }
            $out[$id] = true;
        }
        return array_keys($out);
    }

    /**
     * @param array<string,array<string,mixed>> $packFlows
     * @param array<string,string> $formMap
     * @return array<string,array<string,mixed>>
     */
    private function prepareDesiredFlows(array $packFlows, array $formMap): array
    {
        $desired = [];
        foreach (self::FLOW_SLUGS as $slug) {
            $packFlow = $packFlows[$slug];
            FlowService::sanitizeSlug($slug);
            $name = trim((string) ($packFlow['name'] ?? ''));
            if ($name === '' || strlen($name) > 255) {
                throw new \RuntimeException("Pack flow '{$slug}' has an invalid name");
            }
            $flowJson = FlowService::sanitizeFlowJson($packFlow['flowJson'] ?? null);
            $flowJson = $this->packs->resolveFlowJsonFormRefs($flowJson, $formMap, $slug);
            $inputSchema = $this->validateFlowSchema($packFlow, 'inputSchema', $slug);
            $outputSchema = $this->validateFlowSchema($packFlow, 'outputSchema', $slug);
            $nodeCapabilities = $this->validateNodeCapabilities($packFlow, $slug);
            $desired[$slug] = [
                'name' => $name,
                'description' => isset($packFlow['description']) && is_string($packFlow['description'])
                    ? substr($packFlow['description'], 0, 2000) : null,
                'flowJson' => $flowJson,
                'inputSchema' => $inputSchema,
                'outputSchema' => $outputSchema,
                'nodeCapabilities' => $nodeCapabilities,
            ];
        }
        return $desired;
    }

    /** @return array<string,mixed> */
    private function prepareAppointmentBinding(array $packBinding, array $formMap): array
    {
        $clean = FlowService::sanitizeBinding($packBinding);
        if ($clean['flow'] !== 'appointment-request-apply'
            || $clean['event'] !== 'aokie.appointment.requested'
            || ($packBinding['connectorId'] ?? null) !== 'aokie') {
            throw new \RuntimeException('Pack appointment-request binding is invalid');
        }
        $actions = $clean['outputActions'];
        if (!is_array($actions) || $actions === []) {
            throw new \RuntimeException('Pack appointment-request binding has no output actions');
        }
        foreach ($actions as &$action) {
            $ref = $action['form'] ?? null;
            if (is_string($ref) && str_starts_with($ref, '@pack:')) {
                $packFormId = substr($ref, 6);
                $action['form'] = $formMap[$packFormId]
                    ?? throw new \RuntimeException(
                        "Pack appointment-request binding references unknown pack form '{$packFormId}'"
                    );
            } elseif ($ref !== null) {
                throw new \RuntimeException('Pack appointment-request binding contains a raw form reference');
            }
        }
        unset($action);
        $clean['outputActions'] = $actions;
        $clean['connectorId'] = 'aokie';
        $clean['formId'] = null;
        $clean['sortOrder'] = (int) ($packBinding['sortOrder'] ?? 0);
        return $clean;
    }

    /** @return array<string,mixed>|null */
    private function validateFlowSchema(array $packFlow, string $key, string $slug): ?array
    {
        if (!array_key_exists($key, $packFlow) || $packFlow[$key] === null) {
            return null;
        }
        if (!is_array($packFlow[$key])) {
            throw new \RuntimeException("Pack flow '{$slug}' has an invalid {$key}");
        }
        $json = json_encode($packFlow[$key]);
        if ($json === false || strlen($json) > FlowService::MAX_BINDING_JSON_BYTES) {
            throw new \RuntimeException("Pack flow '{$slug}' {$key} exceeds the limit");
        }
        return $packFlow[$key];
    }

    /** @return string[]|null */
    private function validateNodeCapabilities(array $packFlow, string $slug): ?array
    {
        if (!array_key_exists('nodeCapabilities', $packFlow) || $packFlow['nodeCapabilities'] === null) {
            return null;
        }
        $caps = $packFlow['nodeCapabilities'];
        if (!is_array($caps) || !array_is_list($caps) || count($caps) > 64) {
            throw new \RuntimeException("Pack flow '{$slug}' has invalid nodeCapabilities");
        }
        foreach ($caps as $cap) {
            if (!is_string($cap) || $cap === '' || strlen($cap) > 128) {
                throw new \RuntimeException("Pack flow '{$slug}' has invalid nodeCapabilities");
            }
        }
        return $caps === [] ? null : array_values($caps);
    }

    /** @return array<string,array<string,mixed>|null> */
    private function resolveInstalledFlows(string $appId, string $ownerId): array
    {
        $resolved = [];
        foreach ($this->flows->listFlows($appId) as $flow) {
            $slug = $flow['slug'] ?? null;
            if (!is_string($slug) || !in_array($slug, self::FLOW_SLUGS, true)) {
                continue;
            }
            if (isset($resolved[$slug])) {
                throw new \RuntimeException("Installed flow '{$slug}' is ambiguous");
            }
            if (($flow['ownerUserId'] ?? null) !== $ownerId || ($flow['engine'] ?? null) !== 'f2i') {
                throw new \RuntimeException("Installed flow '{$slug}' is not owned by this pack app");
            }
            $resolved[$slug] = $flow;
        }
        foreach (self::FLOW_SLUGS as $slug) {
            if (!isset($resolved[$slug])) {
                if (in_array($slug, self::ADDITIVE_FLOW_SLUGS, true)) {
                    $resolved[$slug] = null;
                    continue;
                }
                throw new \RuntimeException("Installed flow '{$slug}' is missing");
            }
        }
        return $resolved;
    }

    /**
     * @param array<string,array<string,mixed>> $installedFlows
     * @return array<string,array<string,mixed>>
     */
    private function resolveBindings(
        string $appId,
        array $installedFlows,
        array $desiredAppointmentBinding
    ): array
    {
        $candidates = array_fill_keys(self::SETTLED_BINDING_FLOWS, []);
        $allBindings = $this->flows->listBindings($appId);
        foreach ($allBindings as $binding) {
            $slug = $binding['flow'] ?? null;
            if (!is_string($slug) || !isset($candidates[$slug])) {
                continue;
            }
            if (($binding['flowDefinitionId'] ?? null) !== $installedFlows[$slug]['id']
                || ($binding['connectorId'] ?? null) !== 'aokie'
                || !in_array($binding['event'] ?? null, ['aokie.call.ended', 'aokie.call.transcript.settled'], true)) {
                continue;
            }
            $candidates[$slug][] = $binding;
        }
        $resolved = [];
        foreach (self::SETTLED_BINDING_FLOWS as $slug) {
            if (count($candidates[$slug]) !== 1) {
                throw new \RuntimeException("Installed binding for '{$slug}' is missing or ambiguous");
            }
            $resolved[$slug] = $candidates[$slug][0];
        }
        $appointmentFlow = $installedFlows['appointment-request-apply'];
        $appointmentCandidates = [];
        if (is_array($appointmentFlow)) {
            foreach ($allBindings as $binding) {
                if (($binding['flowDefinitionId'] ?? null) === $appointmentFlow['id']) {
                    $appointmentCandidates[] = $binding;
                }
            }
        }
        if (count($appointmentCandidates) > 1) {
            throw new \RuntimeException("Installed binding for 'appointment-request-apply' is ambiguous");
        }
        if ($appointmentCandidates === []) {
            $resolved['appointment-request-apply'] = null;
        } else {
            $candidate = $appointmentCandidates[0];
            if (!$this->bindingMatches($candidate, $desiredAppointmentBinding)) {
                throw new \RuntimeException(
                    "Installed binding for 'appointment-request-apply' is owner-authored or incompatible"
                );
            }
            $resolved['appointment-request-apply'] = $candidate;
        }
        return $resolved;
    }

    /**
     * Refuse to overwrite an owner-authored or otherwise unrelated screen. A
     * byte-identical target is already safe/idempotent and needs no provenance
     * decision.
     *
     * @param array<string,mixed> $form
     * @param array<string,mixed> $desiredScreen
     */
    private function assertPackOwnedScreen(
        array $form,
        ?string $installationCatalogId,
        array $desiredScreen,
        ?string $acceptedLegacyScreenSha256
    ): bool {
        $current = $this->screenWithoutMetadata($form['customScreen'] ?? []);
        if ($this->sameValue($current, $desiredScreen)) {
            return false;
        }
        $screen = is_array($form['customScreen'] ?? null) ? $form['customScreen'] : [];
        $provenance = is_array($screen['_provenance'] ?? null) ? $screen['_provenance'] : [];
        $vendorOwned = ($provenance['source'] ?? null) === 'vendor-signed'
            && ($provenance['component'] ?? null) === 'form:' . self::SETTINGS_FORM_ID;
        $catalogOwned = $installationCatalogId !== null
            && ($provenance['source'] ?? null) === 'catalog'
            && ($provenance['catalogId'] ?? null) === $installationCatalogId;
        if ($vendorOwned || $catalogOwned) {
            return false;
        }
        if ($acceptedLegacyScreenSha256 !== null) {
            if ($this->acceptsKnownLegacyScreen(
                $acceptedLegacyScreenSha256,
                $this->screenDigest($current),
                $screen['_trust'] ?? null,
                $provenance,
                array_key_exists('_provenance', $screen) && is_array($screen['_provenance'])
            )) {
                return true;
            }
            throw new \RuntimeException('Installed custom screen is not the accepted known legacy Aokie screen');
        }
        throw new \RuntimeException('Receptionist Settings custom screen is owner-authored or not pack-owned');
    }

    /** @param array<string,mixed> $provenance */
    private function acceptsKnownLegacyScreen(
        string $acceptedDigest,
        string $installedDigest,
        mixed $trust,
        array $provenance,
        bool $hasProvenanceMarker
    ): bool {
        return in_array($acceptedDigest, self::KNOWN_LEGACY_SCREEN_SHA256, true)
            && hash_equals($acceptedDigest, $installedDigest)
            && $trust === 'owner'
            && $hasProvenanceMarker
            && $provenance === [];
    }

    /**
     * @param array<string,mixed> $current
     * @param array<string,mixed> $desired
     */
    private function flowMatches(array $current, array $desired): bool
    {
        foreach (['name', 'description', 'flowJson', 'inputSchema', 'outputSchema', 'nodeCapabilities'] as $key) {
            if (!$this->sameValue($current[$key] ?? null, $desired[$key] ?? null)) {
                return false;
            }
        }
        return true;
    }

    /**
     * FormService expands stored fields with order/default metadata. Compare
     * the pack-owned semantic shape while allowing only those normal defaults.
     */
    private function packFieldMatches(array $current, array $desired): bool
    {
        foreach (['id', 'type', 'label', 'required', 'properties'] as $key) {
            if (!$this->sameValue($current[$key] ?? null, $desired[$key] ?? null)) {
                return false;
            }
        }
        return ($current['description'] ?? null) === ($desired['description'] ?? null)
            && ($current['placeholder'] ?? null) === ($desired['placeholder'] ?? null)
            && $this->sameValue($current['validation'] ?? [], $desired['validation'] ?? [])
            && $this->sameValue($current['conditionalLogic'] ?? null, $desired['conditionalLogic'] ?? null);
    }

    /** @param array<string,mixed> $current @param array<string,mixed> $desired */
    private function bindingMatches(array $current, array $desired): bool
    {
        foreach ([
            'formId',
            'connectorId',
            'flow',
            'event',
            'mode',
            'condition',
            'inputMap',
            'outputActions',
            'timeoutMs',
            'retryPolicy',
            'fallbackPolicy',
            'enabled',
            'sortOrder',
        ] as $key) {
            if (!$this->sameValue($current[$key] ?? null, $desired[$key] ?? null)) {
                return false;
            }
        }
        return true;
    }

    /**
     * @param array<string,array<string,mixed>> $desiredFlows
     * @param array<string,array<string,mixed>|null> $installedFlows
     * @param array<string,array<string,mixed>|null> $bindings
     * @return array{0:string[],1:string[]}
     */
    private function applyFlowChanges(
        string $appId,
        string $ownerId,
        array $desiredFlows,
        array $installedFlows,
        array $bindings,
        array $desiredAppointmentBinding
    ): array {
        $needsFlowTransaction = false;
        foreach (self::FLOW_SLUGS as $slug) {
            $needsFlowTransaction = $needsFlowTransaction
                || $installedFlows[$slug] === null
                || !$this->flowMatches($installedFlows[$slug], $desiredFlows[$slug]);
        }
        foreach (self::SETTLED_BINDING_FLOWS as $slug) {
            $needsFlowTransaction = $needsFlowTransaction
                || $bindings[$slug]['event'] !== 'aokie.call.transcript.settled';
        }
        $needsFlowTransaction = $needsFlowTransaction
            || $bindings['appointment-request-apply'] === null;
        if (!$needsFlowTransaction) {
            return [[], []];
        }
        if ($this->mysql->inTransaction()) {
            throw new \RuntimeException('Aokie flow upgrade requires its own database transaction');
        }

        $updatedFlows = [];
        $updatedBindings = [];
        $this->mysql->beginTransaction();
        try {
            $appLock = $this->mysql->prepare('SELECT owner_id FROM apps WHERE id = :id FOR UPDATE');
            $appLock->execute(['id' => $appId]);
            if ($appLock->fetchColumn() !== $ownerId) {
                throw new \RuntimeException('Target app ownership changed during upgrade');
            }

            $flowLock = $this->mysql->prepare(
                'SELECT id, owner_user_id, engine FROM flow_definitions
                  WHERE id = :id AND app_id = :app AND slug = :slug FOR UPDATE'
            );
            foreach (self::FLOW_SLUGS as $slug) {
                if ($installedFlows[$slug] === null) {
                    if (!in_array($slug, self::ADDITIVE_FLOW_SLUGS, true)) {
                        throw new \RuntimeException("Installed flow '{$slug}' disappeared during upgrade");
                    }
                    $collisionLock = $this->mysql->prepare(
                        'SELECT id FROM flow_definitions WHERE app_id = :app AND slug = :slug FOR UPDATE'
                    );
                    $collisionLock->execute(['app' => $appId, 'slug' => $slug]);
                    if ($collisionLock->fetchColumn() !== false) {
                        throw new \RuntimeException("Installed additive flow '{$slug}' appeared during upgrade");
                    }
                    $create = $desiredFlows[$slug];
                    $create['slug'] = $slug;
                    $installedFlows[$slug] = $this->flows->createFlow($appId, $ownerId, $create);
                    $updatedFlows[] = $slug;
                    continue;
                }
                $flowLock->execute([
                    'id' => $installedFlows[$slug]['id'],
                    'app' => $appId,
                    'slug' => $slug,
                ]);
                $locked = $flowLock->fetch();
                if (!$locked || $locked['owner_user_id'] !== $ownerId || $locked['engine'] !== 'f2i') {
                    throw new \RuntimeException("Installed flow '{$slug}' changed during upgrade");
                }
                $current = $this->flows->getFlow($appId, $installedFlows[$slug]['id']);
                if ($current === null) {
                    throw new \RuntimeException("Installed flow '{$slug}' disappeared during upgrade");
                }
                if (!$this->flowMatches($current, $desiredFlows[$slug])) {
                    if (in_array($slug, self::ADDITIVE_FLOW_SLUGS, true)) {
                        throw new \RuntimeException("Installed additive flow '{$slug}' changed during upgrade");
                    }
                    if ($this->flows->updateFlow($appId, $current['id'], $desiredFlows[$slug]) === null) {
                        throw new \RuntimeException("Installed flow '{$slug}' could not be updated");
                    }
                    $updatedFlows[] = $slug;
                }
            }

            $bindingLock = $this->mysql->prepare(
                'SELECT b.id, b.connector_id, b.event_name, f.slug
                   FROM app_flow_bindings b
                   JOIN flow_definitions f ON f.id = b.flow_definition_id
                  WHERE b.id = :id AND b.app_id = :app AND b.flow_definition_id = :flow FOR UPDATE'
            );
            $bindingUpdate = $this->mysql->prepare(
                'UPDATE app_flow_bindings
                    SET event_name = :event
                  WHERE id = :id AND app_id = :app AND event_name = :old_event'
            );
            foreach (self::SETTLED_BINDING_FLOWS as $slug) {
                $bindingLock->execute([
                    'id' => $bindings[$slug]['id'],
                    'app' => $appId,
                    'flow' => $installedFlows[$slug]['id'],
                ]);
                $locked = $bindingLock->fetch();
                if (!$locked || $locked['slug'] !== $slug || $locked['connector_id'] !== 'aokie'
                    || !in_array($locked['event_name'], ['aokie.call.ended', 'aokie.call.transcript.settled'], true)) {
                    throw new \RuntimeException("Installed binding for '{$slug}' changed during upgrade");
                }
                if ($locked['event_name'] === 'aokie.call.ended') {
                    $bindingUpdate->execute([
                        'event' => 'aokie.call.transcript.settled',
                        'id' => $locked['id'],
                        'app' => $appId,
                        'old_event' => 'aokie.call.ended',
                    ]);
                    if ($bindingUpdate->rowCount() !== 1) {
                        throw new \RuntimeException("Installed binding for '{$slug}' could not be updated");
                    }
                    $updatedBindings[] = $slug;
                }
            }

            if ($bindings['appointment-request-apply'] === null) {
                $newBinding = $this->flows->createBinding($appId, $desiredAppointmentBinding);
                if (!$this->bindingMatches($newBinding, $desiredAppointmentBinding)) {
                    throw new \RuntimeException("Installed binding for 'appointment-request-apply' could not be created");
                }
                $updatedBindings[] = 'appointment-request-apply';
            }

            $this->mysql->commit();
        } catch (\Throwable $e) {
            if ($this->mysql->inTransaction()) {
                $this->mysql->rollBack();
            }
            throw $e;
        }
        return [$updatedFlows, $updatedBindings];
    }

    /** @return array<string,mixed> */
    private function screenWithoutMetadata(mixed $screen): array
    {
        if (!is_array($screen)) {
            return [];
        }
        unset($screen['_trust'], $screen['_provenance']);
        return $screen;
    }

    /** @param array<string,mixed> $screen */
    private function screenDigest(array $screen): string
    {
        return hash('sha256', json_encode(
            $this->canonicalValue($screen),
            JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR
        ));
    }

    private function canonicalValue(mixed $value): mixed
    {
        if (!is_array($value)) {
            return $value;
        }
        if (array_is_list($value)) {
            return array_map(fn (mixed $item): mixed => $this->canonicalValue($item), $value);
        }
        ksort($value, SORT_STRING);
        foreach ($value as $key => $item) {
            $value[$key] = $this->canonicalValue($item);
        }
        return $value;
    }

    private function sameValue(mixed $left, mixed $right): bool
    {
        if (gettype($left) !== gettype($right)) {
            return false;
        }
        if (!is_array($left) || !is_array($right)) {
            return $left === $right;
        }
        if (array_is_list($left) !== array_is_list($right) || count($left) !== count($right)) {
            return false;
        }
        if (array_is_list($left)) {
            foreach ($left as $index => $value) {
                if (!$this->sameValue($value, $right[$index])) {
                    return false;
                }
            }
            return true;
        }
        if (array_diff_key($left, $right) !== [] || array_diff_key($right, $left) !== []) {
            return false;
        }
        foreach ($left as $key => $value) {
            if (!$this->sameValue($value, $right[$key])) {
                return false;
            }
        }
        return true;
    }
}

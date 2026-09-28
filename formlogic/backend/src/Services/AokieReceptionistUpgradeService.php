<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Constants\AppPermissions;
use FormLogic\Database\MySQLConnection;
use PDO;

/**
 * In-place upgrade of an installed Aokie Receptionist app to the bundled pack.
 *
 * This is deliberately not a second pack import: the installed app, form and
 * flow ids and every record stay where they are. What the pack owns is brought
 * to what a fresh install of the bundled version would have:
 *
 *  - every form's pack fields: missing ones are added, changed ones take the
 *    pack's definition (keeping any choices an owner added to a dropdown, so
 *    stored answers stay valid), and they are laid out in the pack's order
 *    (a field an owner added stays after the one it followed); missing form
 *    settings are added and set ones are left alone; the form's screen is
 *    replaced when it is the pack's own (vendor-signed, catalog-installed, or
 *    the accepted legacy settings screen) and re-stamped with its signed trust;
 *  - the app's logic (scripts, grants, connector manifest and demo driver),
 *    its missing settings and included services, its home screen, its reports
 *    when it has none, and its description while it is still a former pack one;
 *  - the pack's roles and their grants (a missing grant is added, a missing
 *    role is created; nothing an owner added is taken away);
 *  - every pack flow and binding: updated in place, created when missing,
 *    each keeping whether it is enabled;
 *  - the installation's recorded version.
 *
 * Operator data is kept: records, owner-added fields, dropdown choices,
 * scripts, grants, roles, flows and bindings, display names, form titles,
 * settings an owner changed, and what is switched on or off.
 *
 * It is idempotent (a second run changes nothing) and skips rather than
 * refuses: a form, flow or screen it cannot safely touch is left as it is and
 * listed under `skipped` with the reason. It refuses only when it cannot tell
 * what to change - the app is not exactly one Aokie installation, an alias is
 * ambiguous or outside the installation, or the bundled pack is not the
 * signed Aokie pack.
 */
final class AokieReceptionistUpgradeService
{
    public const PACK_ID = 'aokie-receptionist';
    public const PACK_APP_ID = 'aokie-receptionist';
    public const SETTINGS_FORM_ID = 'receptionist-settings';

    /**
     * Bindings whose event the pack has moved: the summary and after-call
     * flows ran on aokie.call.ended before the transcript-settled event
     * existed. Such a binding is updated (event included), not duplicated.
     *
     * @var array<string,string[]>
     */
    private const MOVED_BINDING_EVENTS = [
        'call-summary-follow-up' => ['aokie.call.ended'],
        'after-call-actions' => ['aokie.call.ended'],
    ];

    /**
     * sha256 of every app description a previous release of the pack shipped
     * (only one differs from today's: "AI phone receptionist over FormLogic
     * Desktop ..."). An app still carrying one was never edited, so it takes
     * the pack's current description; any other text is the owner's.
     *
     * @var string[]
     */
    private const FORMER_APP_DESCRIPTION_SHA256 = [
        '10dbc761c6f117b79ea36ba7f8ebcedeb2dbe46e0750ea0eb82f8bbd566b6615',
    ];

    /** Field types whose `options` an owner may have added choices to. */
    private const OPTION_FIELD_TYPES = ['dropdown', 'multiple_choice', 'checkboxes', 'radio'];

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
    private AppService $apps;
    private AppUserService $appUsers;

    /** @var list<array{item:string,reason:string}> */
    private array $skipped = [];

    public function __construct(
        MySQLConnection $mysql,
        private FormService $forms,
        private FormVersionService $versions,
        private FlowService $flows,
        private PackService $packs,
        ?AppService $apps = null,
        ?AppUserService $appUsers = null
    ) {
        $this->mysql = $mysql->getConnection();
        $this->apps = $apps ?? new AppService($mysql, $forms);
        $this->appUsers = $appUsers ?? new AppUserService($mysql);
    }

    /**
     * Inspect (dry run) or apply the upgrade.
     *
     * @return array<string,mixed> bounded, content-free operator summary
     */
    public function run(
        string $appId,
        array $marketplaceRecord,
        bool $apply,
        ?string $acceptedLegacyScreenSha256 = null
    ): array {
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
        $this->skipped = [];

        $source = $this->validateSourcePack($marketplaceRecord);
        $installed = $this->resolveInstalledApp($appId, $source['packFormIds']);
        foreach ($source['packFormIds'] as $packFormId) {
            if (!isset($installed['formMap'][$packFormId])) {
                $this->skip("form:{$packFormId}", 'the installed app has no such form; everything that needs it is left out');
            }
        }

        $formPlans = [];
        $legacyScreenAccepted = false;
        foreach ($source['forms'] as $packFormId => $packForm) {
            if (!isset($installed['formMap'][$packFormId])) {
                continue;
            }
            $plan = $this->planForm(
                $packFormId,
                $packForm,
                $installed['formMap'][$packFormId],
                $installed,
                $source,
                $acceptedLegacyScreenSha256
            );
            if ($plan !== null) {
                $legacyScreenAccepted = $legacyScreenAccepted || $plan['legacyAccepted'];
                $formPlans[$packFormId] = $plan;
            }
        }
        $appPlan = $this->planApp($appId, $source, $installed);
        $rolePlans = $this->planRoles($appId, $source, $installed);
        [$flowPlans, $bindingPlans] = $this->planFlows($appId, $source, $installed);
        $versionChanges = ($installed['installation']['pack_version'] ?? null) !== $source['packVersion']
            || ($installed['installation']['pack_name'] ?? null) !== $source['packName']
            || ($installed['installation']['pack_description'] ?? null) !== $source['packDescription'];

        $changes = $this->describeChanges($formPlans, $appPlan, $rolePlans, $flowPlans, $bindingPlans, $versionChanges);
        $summary = [
            'mode' => $apply ? 'apply' : 'dry-run',
            'packId' => self::PACK_ID,
            'packVersion' => $source['packVersion'],
            'installedVersion' => (string) ($installed['installation']['pack_version'] ?? ''),
            'appId' => $appId,
            'legacyScreenAccepted' => $legacyScreenAccepted,
            'changes' => $changes,
            'skipped' => $this->skipped,
            'snapshots' => [],
            'applied' => false,
        ];
        if (!$apply || !$this->hasChanges($changes)) {
            $summary['skipped'] = $this->skipped;
            return $summary;
        }

        // Forms first (each is its own SQLite + MySQL save, snapshotted), then
        // everything that lives in MySQL alone in one transaction.
        foreach ($formPlans as $packFormId => $plan) {
            if (!$plan['hasChanges']) {
                continue;
            }
            $version = $this->applyForm($packFormId, $plan, $installed['ownerId'], $source['packVersion']);
            if ($version === null) {
                unset($changes['forms'][$packFormId]);
                continue;
            }
            $summary['snapshots'][$packFormId] = ['version' => $version];
        }
        $this->applyMysqlChanges($appId, $installed, $source, $appPlan, $rolePlans, $flowPlans, $bindingPlans, $versionChanges);

        $summary['changes'] = $changes;
        $summary['skipped'] = $this->skipped;
        $summary['applied'] = $this->hasChanges($changes);
        return $summary;
    }

    // ── The bundled pack ────────────────────────────────────────────────────

    /**
     * @return array{
     *   pack:array<string,mixed>, packVersion:string, packName:string, packDescription:?string,
     *   packFormIds:string[], forms:array<string,array<string,mixed>>, app:array<string,mixed>,
     *   flows:array<string,array<string,mixed>>, bindings:list<array<string,mixed>>
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
        // The same structural validation an import runs.
        PackService::validateDefinition($pack);

        $apps = array_values(array_filter(
            is_array($pack['apps'] ?? null) ? $pack['apps'] : [],
            static fn ($app): bool => is_array($app) && ($app['packAppId'] ?? null) === self::PACK_APP_ID
        ));
        if (count($apps) !== 1) {
            throw new \RuntimeException('Pack must contain exactly one Aokie Receptionist app');
        }

        $forms = [];
        foreach (is_array($pack['forms'] ?? null) ? $pack['forms'] : [] as $form) {
            if (!is_array($form) || !is_string($form['packFormId'] ?? null) || $form['packFormId'] === '') {
                throw new \RuntimeException('Pack contains an invalid form alias');
            }
            if (isset($forms[$form['packFormId']])) {
                throw new \RuntimeException("Pack form alias '{$form['packFormId']}' is ambiguous");
            }
            $forms[$form['packFormId']] = $form;
        }
        if (!isset($forms[self::SETTINGS_FORM_ID])) {
            throw new \RuntimeException('Pack is missing Receptionist Settings');
        }

        $flows = [];
        foreach (is_array($pack['flows'] ?? null) ? $pack['flows'] : [] as $flow) {
            $slug = is_array($flow) ? FlowService::sanitizeSlug($flow['slug'] ?? null) : null;
            if ($slug === null || isset($flows[$slug])) {
                throw new \RuntimeException('Pack flow slugs must be present and unique');
            }
            $flows[$slug] = $flow;
        }
        $bindings = [];
        foreach (is_array($pack['flowBindings'] ?? null) ? $pack['flowBindings'] : [] as $binding) {
            if (!is_array($binding) || !isset($flows[$binding['flow'] ?? ''])) {
                throw new \RuntimeException('Pack binding references an unknown flow');
            }
            $bindings[] = $binding;
        }
        // Screens are only ever installed with the trust their signature gives
        // them, so an unsigned or untrusted bundle is not an upgrade source.
        if (!is_array($pack['signing'] ?? null)) {
            throw new \RuntimeException('Pack vendor signature is missing or untrusted');
        }

        return [
            'pack' => $pack,
            'packVersion' => $packVersion,
            'packName' => (string) ($meta['name'] ?? 'Aokie Receptionist'),
            'packDescription' => isset($meta['description']) && is_string($meta['description']) ? $meta['description'] : null,
            'packFormIds' => array_keys($forms),
            'forms' => $forms,
            'app' => $apps[0],
            'flows' => $flows,
            'bindings' => $bindings,
        ];
    }

    // ── The installed app ───────────────────────────────────────────────────

    /**
     * @param string[] $packFormIds
     * @return array{ownerId:string,installation:array<string,mixed>,installationCatalogId:?string,formMap:array<string,string>}
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
            'SELECT id, catalog_id, pack_name, pack_version, pack_description, form_ids, app_ids
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
        if (count(array_unique(array_values($map))) !== count($map)) {
            throw new \RuntimeException('Installed pack form aliases do not map one-to-one');
        }

        return [
            'ownerId' => $ownerId,
            'installation' => $installation,
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

    // ── Forms ───────────────────────────────────────────────────────────────

    /**
     * @return array<string,mixed>|null
     */
    private function planForm(
        string $packFormId,
        array $packForm,
        string $formId,
        array $installed,
        array $source,
        ?string $acceptedLegacyScreenSha256
    ): ?array {
        $form = $this->forms->getForm($formId);
        if ($form === null) {
            $this->skip("form:{$packFormId}", 'the form could not be read');
            return null;
        }
        $plan = [
            'formId' => $formId,
            'before' => $form,
            'fields' => null,
            'fieldsAdded' => [],
            'fieldsUpdated' => [],
            'fieldsReordered' => false,
            'settings' => null,
            'settingsAdded' => [],
            'screen' => null,
            'screenTrust' => null,
            'legacyAccepted' => false,
            'hasChanges' => false,
        ];

        // Fields.
        $fieldPlan = $this->planFields($packFormId, $packForm, $form, $installed['formMap']);
        if ($fieldPlan !== null && ($fieldPlan['added'] !== [] || $fieldPlan['updated'] !== [] || $fieldPlan['reordered'])) {
            $plan['fields'] = $fieldPlan['fields'];
            $plan['fieldsAdded'] = $fieldPlan['added'];
            $plan['fieldsUpdated'] = $fieldPlan['updated'];
            $plan['fieldsReordered'] = $fieldPlan['reordered'];
        }

        // Settings: add what the pack sets and the form lacks; never change a set one.
        $current = is_array($form['settings'] ?? null) ? $form['settings'] : [];
        $packSettings = is_array($packForm['settings'] ?? null) ? $packForm['settings'] : [];
        unset($packSettings['notifications']);
        $added = [];
        foreach ($packSettings as $key => $value) {
            if (!array_key_exists($key, $current)) {
                $current[$key] = $value;
                $added[] = (string) $key;
            }
        }
        if ($added !== []) {
            $plan['settings'] = $current;
            $plan['settingsAdded'] = $added;
        }

        // Screen.
        $desired = $this->packs->resolveCustomScreen(
            is_array($packForm['customScreen'] ?? null) ? $packForm['customScreen'] : null,
            $installed['formMap']
        );
        if (is_array($desired) && $desired !== []) {
            $ownership = $this->screenOwnership(
                is_array($form['customScreen'] ?? null) ? $form['customScreen'] : [],
                'form:' . $packFormId,
                $installed['installationCatalogId'],
                $desired,
                $packFormId === self::SETTINGS_FORM_ID ? $acceptedLegacyScreenSha256 : null
            );
            if ($ownership === 'owner') {
                $this->skip("form:{$packFormId} screen", 'owner-authored or not pack-owned; left as it is');
            } elseif ($ownership !== 'same') {
                $trust = $this->signedTrust($source['pack'], 'form:' . $packFormId, $packForm['customScreen']);
                if ($trust !== null) {
                    $plan['screen'] = $desired;
                    $plan['screenTrust'] = $trust;
                    $plan['legacyAccepted'] = $ownership === 'legacy';
                }
            }
        }

        $plan['hasChanges'] = $plan['fields'] !== null || $plan['settings'] !== null || $plan['screen'] !== null;
        return $plan;
    }

    /**
     * The form's fields with the pack's brought in: missing ones at their pack
     * position, differing ones replaced by the pack's definition (keeping an
     * owner's extra dropdown choices), owner-added ones untouched.
     *
     * @param array<string,string> $formMap
     * @return array{fields:list<array<string,mixed>>,added:string[],updated:string[]}|null
     */
    private function planFields(string $packFormId, array $packForm, array $form, array $formMap): ?array
    {
        $installedFields = [];
        foreach (is_array($form['fields'] ?? null) ? $form['fields'] : [] as $field) {
            $id = is_array($field) ? ($field['id'] ?? null) : null;
            if (!is_string($id)) {
                continue;
            }
            if (isset($installedFields[$id])) {
                $this->skip("form:{$packFormId} fields", 'the form has duplicate field ids; left as it is');
                return null;
            }
            $installedFields[$id] = $field;
        }

        $desired = [];
        foreach (is_array($packForm['fields'] ?? null) ? $packForm['fields'] : [] as $packField) {
            $id = is_array($packField) ? ($packField['id'] ?? null) : null;
            if (!is_string($id) || FormService::fieldIdError($id) !== null) {
                continue;
            }
            try {
                $desired[$id] = $this->packs->remapFieldReferences([$packField], $formMap)[0];
            } catch (\RuntimeException) {
                $this->skip("form:{$packFormId} field {$id}", 'it links to a form the installed app does not have');
            }
        }

        $added = [];
        $updated = [];
        $merged = [];
        foreach ($installedFields as $id => $field) {
            if (!isset($desired[$id])) {
                $merged[$id] = $field;
                continue;
            }
            $want = $desired[$id];
            if (FormService::normalizeFieldType((string) ($want['type'] ?? '')) !== ($field['type'] ?? null)) {
                $this->skip("form:{$packFormId} field {$id}", 'its type differs from the pack\'s; a stored answer could not be kept');
                $merged[$id] = $field;
                continue;
            }
            $want = $this->keepOwnerOptions($want, $field);
            if ($this->packFieldMatches($field, $want)) {
                $merged[$id] = $field;
                continue;
            }
            $merged[$id] = $want;
            $updated[] = $id;
        }

        // Pack fields in the pack's order, as a fresh install lays them out (a
        // later release may have moved one); a field the owner added stays
        // right after the pack field it followed.
        $ownAfter = [];
        $anchor = '';
        foreach (array_keys($merged) as $id) {
            if (isset($desired[$id])) {
                $anchor = $id;
                continue;
            }
            $ownAfter[$anchor][] = $id;
        }
        $fields = [];
        foreach ($ownAfter[''] ?? [] as $id) {
            $fields[] = $merged[$id];
        }
        foreach (array_keys($desired) as $id) {
            if (isset($merged[$id])) {
                $fields[] = $merged[$id];
            } else {
                $fields[] = $desired[$id];
                $added[] = $id;
            }
            foreach ($ownAfter[$id] ?? [] as $ownId) {
                $fields[] = $merged[$ownId];
            }
        }
        $keptOrder = array_values(array_filter(
            array_column($fields, 'id'),
            static fn ($id): bool => isset($installedFields[$id])
        ));
        $reordered = $keptOrder !== array_keys($installedFields);
        foreach ($fields as $index => &$field) {
            $field['order'] = $index;
        }
        unset($field);

        return ['fields' => $fields, 'added' => $added, 'updated' => $updated, 'reordered' => $reordered];
    }

    /** An owner's extra choices stay on a pack dropdown, after the pack's. */
    private function keepOwnerOptions(array $want, array $current): array
    {
        if (!in_array($want['type'] ?? null, self::OPTION_FIELD_TYPES, true)) {
            return $want;
        }
        $packOptions = $want['properties']['options'] ?? null;
        $ownOptions = $current['properties']['options'] ?? null;
        if (!is_array($packOptions) || !is_array($ownOptions)) {
            return $want;
        }
        $values = [];
        foreach ($packOptions as $option) {
            if (is_array($option) && array_key_exists('value', $option)) {
                $values[(string) $option['value']] = true;
            }
        }
        foreach ($ownOptions as $option) {
            if (is_array($option) && array_key_exists('value', $option) && !isset($values[(string) $option['value']])) {
                $packOptions[] = $option;
            }
        }
        $want['properties']['options'] = $packOptions;
        return $want;
    }

    /**
     * FormService expands stored fields with order/default metadata. Compare
     * the pack-owned semantic shape while allowing only those normal defaults.
     */
    private function packFieldMatches(array $current, array $desired): bool
    {
        if (($current['type'] ?? null) !== FormService::normalizeFieldType((string) ($desired['type'] ?? ''))) {
            return false;
        }
        foreach (['id', 'label', 'properties'] as $key) {
            if (!$this->sameValue($current[$key] ?? null, $desired[$key] ?? null)) {
                return false;
            }
        }
        return (bool) ($current['required'] ?? false) === (bool) ($desired['required'] ?? false)
            && ($current['description'] ?? null) === ($desired['description'] ?? null)
            && ($current['placeholder'] ?? null) === ($desired['placeholder'] ?? null)
            && $this->sameValue($current['validation'] ?? [], $desired['validation'] ?? [])
            && $this->sameValue($current['conditionalLogic'] ?? null, $desired['conditionalLogic'] ?? null);
    }

    /** @return int|null the snapshot version, or null when the form moved on under us */
    private function applyForm(string $packFormId, array $plan, string $ownerId, string $packVersion): ?int
    {
        // Re-read immediately before the snapshot and write, so a concurrent
        // owner edit is never overwritten on the strength of an earlier read.
        $fresh = $this->forms->getForm($plan['formId']);
        $before = $plan['before'];
        if ($fresh === null
            || !$this->sameValue($before['fields'] ?? [], $fresh['fields'] ?? [])
            || !$this->sameValue($before['settings'] ?? [], $fresh['settings'] ?? [])
            || !$this->sameValue($before['customScreen'] ?? [], $fresh['customScreen'] ?? [])) {
            $this->skip("form:{$packFormId}", 'it changed while the upgrade ran; run the upgrade again');
            return null;
        }
        $version = $this->versions->createVersion(
            $plan['formId'],
            $ownerId,
            "Before Aokie Receptionist {$packVersion} upgrade"
        );
        $update = [];
        if ($plan['fields'] !== null) {
            $update['fields'] = $plan['fields'];
        }
        if ($plan['settings'] !== null) {
            $update['settings'] = $plan['settings'];
        }
        if ($plan['screen'] !== null) {
            $update['customScreen'] = $plan['screen'];
        }
        if ($this->forms->updateForm($plan['formId'], $update) === null) {
            throw new \RuntimeException("Installed pack form '{$packFormId}' update failed");
        }
        if ($plan['screen'] !== null) {
            $this->forms->setCustomScreenTrust(
                $plan['formId'],
                $plan['screenTrust']['trust'],
                $plan['screenTrust']['provenance']
            );
        }
        return (int) $version['version'];
    }

    // ── Screens ─────────────────────────────────────────────────────────────

    /**
     * Whose screen is installed: 'same' (already the pack's), 'pack' (the
     * pack installed it, or there is none), 'legacy' (the operator-accepted
     * historical settings screen) or 'owner' (someone else's; left alone).
     *
     * @param array<string,mixed> $screen the installed screen with its _trust/_provenance
     * @param array<string,mixed> $desired
     */
    private function screenOwnership(
        array $screen,
        string $componentKey,
        ?string $installationCatalogId,
        array $desired,
        ?string $acceptedLegacyScreenSha256
    ): string {
        $current = $this->screenWithoutMetadata($screen);
        if ($this->sameValue($current, $desired)) {
            return 'same';
        }
        if ($current === []) {
            return 'pack';
        }
        $provenance = is_array($screen['_provenance'] ?? null) ? $screen['_provenance'] : [];
        $vendorOwned = ($provenance['source'] ?? null) === 'vendor-signed'
            && ($provenance['component'] ?? null) === $componentKey;
        $catalogOwned = $installationCatalogId !== null
            && ($provenance['source'] ?? null) === 'catalog'
            && ($provenance['catalogId'] ?? null) === $installationCatalogId;
        if ($vendorOwned || $catalogOwned) {
            return 'pack';
        }
        if ($acceptedLegacyScreenSha256 !== null) {
            if ($this->acceptsKnownLegacyScreen(
                $acceptedLegacyScreenSha256,
                $this->screenDigest($current),
                $screen['_trust'] ?? null,
                $provenance,
                array_key_exists('_provenance', $screen) && is_array($screen['_provenance'])
            )) {
                return 'legacy';
            }
            // An explicit operator assertion that does not hold is a wrong
            // invocation, not something missing: refuse it.
            throw new \RuntimeException('Installed custom screen is not the accepted known legacy Aokie screen');
        }
        return 'owner';
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
     * The trust a fresh import would stamp on this screen: verified, from the
     * pack's pinned vendor signature over this component's exact bytes.
     *
     * @return array{trust:string,provenance:array<string,mixed>}|null
     */
    private function signedTrust(array $pack, string $componentKey, mixed $packScreen): ?array
    {
        try {
            return $this->packs->verifyVendorSignedScreenComponent(
                $pack,
                $componentKey,
                is_array($packScreen) ? $packScreen : []
            );
        } catch (\RuntimeException | \InvalidArgumentException) {
            $this->skip("{$componentKey} screen", 'the bundled screen does not match its signed digest');
            return null;
        }
    }

    // ── The app ─────────────────────────────────────────────────────────────

    /** @return array<string,mixed> */
    private function planApp(string $appId, array $source, array $installed): array
    {
        $app = $this->apps->getApp($appId);
        if ($app === null) {
            throw new \RuntimeException('Target app was not found');
        }
        $packApp = $source['app'];
        $plan = [
            'logic' => null, 'scriptsAdded' => [], 'scriptsUpdated' => [], 'permissionsAdded' => [], 'connector' => false,
            'settings' => null, 'settingsAdded' => [],
            'screen' => null, 'screenTrust' => null,
            'reports' => null, 'reportsAdded' => [],
            'description' => null,
        ];

        // Description: a former pack description (never edited) becomes today's.
        $packDescription = is_string($packApp['description'] ?? null) ? $packApp['description'] : null;
        $description = is_string($app['description'] ?? null) ? $app['description'] : '';
        if ($packDescription !== null && $description !== $packDescription) {
            if (in_array(hash('sha256', $description), self::FORMER_APP_DESCRIPTION_SHA256, true)) {
                $plan['description'] = $packDescription;
            } else {
                $this->skip('app description', 'edited by the owner; left as it is');
            }
        }

        // App logic: the pack's scripts, grants and connector; the owner's own kept.
        $packLogic = is_array($packApp['customLogic'] ?? null) ? $packApp['customLogic'] : null;
        if ($packLogic !== null) {
            $current = is_array($app['customLogic'] ?? null) ? $app['customLogic'] : [];
            $merged = $current;
            foreach ($packLogic as $key => $value) {
                if ($key !== 'scripts' && $key !== 'permissions') {
                    $merged[$key] = $value;
                }
            }
            $currentScripts = [];
            foreach (is_array($current['scripts'] ?? null) ? $current['scripts'] : [] as $script) {
                if (is_array($script) && is_string($script['id'] ?? null)) {
                    $currentScripts[$script['id']] = $script;
                }
            }
            $scripts = [];
            $packScriptIds = [];
            foreach (is_array($packLogic['scripts'] ?? null) ? $packLogic['scripts'] : [] as $script) {
                $id = is_array($script) ? ($script['id'] ?? null) : null;
                if (!is_string($id)) {
                    continue;
                }
                $packScriptIds[$id] = true;
                $scripts[] = $script;
                if (!isset($currentScripts[$id])) {
                    $plan['scriptsAdded'][] = $id;
                } elseif (!$this->sameValue($currentScripts[$id], $script)) {
                    $plan['scriptsUpdated'][] = $id;
                }
            }
            foreach (is_array($current['scripts'] ?? null) ? $current['scripts'] : [] as $script) {
                if (!is_array($script) || !isset($packScriptIds[$script['id'] ?? ''])) {
                    $scripts[] = $script;
                }
            }
            $merged['scripts'] = $scripts;
            $currentPermissions = is_array($current['permissions'] ?? null) ? $current['permissions'] : [];
            $permissions = is_array($packLogic['permissions'] ?? null) ? array_values($packLogic['permissions']) : [];
            foreach ($permissions as $permission) {
                if (!in_array($permission, $currentPermissions, true)) {
                    $plan['permissionsAdded'][] = (string) $permission;
                }
            }
            foreach ($currentPermissions as $permission) {
                if (!in_array($permission, $permissions, true)) {
                    $permissions[] = $permission;
                }
            }
            $merged['permissions'] = $permissions;
            $plan['connector'] = !$this->sameValue($current['connector'] ?? null, $packLogic['connector'] ?? null);
            if (!$this->sameValue($current, $merged)) {
                $plan['logic'] = $merged;
            }
        }

        // Settings: keys the pack sets and the app lacks, and missing included services.
        $settings = is_array($app['settings'] ?? null) ? $app['settings'] : [];
        $packSettings = is_array($packApp['settings'] ?? null) ? $packApp['settings'] : [];
        unset($packSettings['notifications'], $packSettings['services'], $packSettings['defaultRoleName'],
            $packSettings['defaultRoleId'], $packSettings['landingPage']);
        if (!isset($packApp['hostedProject'])) {
            unset($packSettings['hostedDashboard']);
        }
        foreach ($packSettings as $key => $value) {
            if (!array_key_exists($key, $settings)) {
                $settings[$key] = $value;
                $plan['settingsAdded'][] = (string) $key;
            }
        }
        $declared = is_array($packApp['features'] ?? null) ? $packApp['features']
            : (is_array($packApp['services'] ?? null) ? $packApp['services'] : []);
        foreach ($declared as $service) {
            $id = is_array($service) ? (string) ($service['id'] ?? '') : '';
            if ($id === '' || isset($settings['services'][$id])) {
                continue;
            }
            $settings['services'] = is_array($settings['services'] ?? null) ? $settings['services'] : [];
            $settings['services'][$id] = [
                'enabled' => ($service['defaultEnabled'] ?? true) !== false,
                'title' => (string) ($service['title'] ?? $id),
                'description' => (string) ($service['description'] ?? ''),
            ];
            $plan['settingsAdded'][] = 'services.' . $id;
        }
        if ($plan['settingsAdded'] !== []) {
            $plan['settings'] = $settings;
        }

        // Home screen.
        $desired = $this->packs->resolveCustomScreen(
            is_array($packApp['customScreen'] ?? null) ? $packApp['customScreen'] : null,
            $installed['formMap']
        );
        if (is_array($desired) && $desired !== []) {
            $ownership = $this->screenOwnership(
                is_array($app['customScreen'] ?? null) ? $app['customScreen'] : [],
                'app:' . self::PACK_APP_ID,
                $installed['installationCatalogId'],
                $desired,
                null
            );
            if ($ownership === 'owner') {
                $this->skip('app screen', 'owner-authored or not pack-owned; left as it is');
            } elseif ($ownership !== 'same') {
                $trust = $this->signedTrust($source['pack'], 'app:' . self::PACK_APP_ID, $packApp['customScreen']);
                if ($trust !== null) {
                    $plan['screen'] = $desired;
                    $plan['screenTrust'] = $trust;
                }
            }
        }

        // Reports: the pack's set is installed when the app has none. An app
        // with reports keeps them (they carry no pack identity to match on).
        $packReports = is_array($packApp['reports'] ?? null) ? $packApp['reports'] : [];
        $currentReports = is_array($app['reports'] ?? null) ? $app['reports'] : [];
        if ($packReports !== []) {
            if ($currentReports === []) {
                $plan['reports'] = $this->packs->resolvePackReports($packReports, $installed['formMap']);
                foreach ($plan['reports'] as $report) {
                    $plan['reportsAdded'][] = (string) ($report['name'] ?? '');
                }
            } else {
                $names = array_map(static fn ($r): string => is_array($r) ? (string) ($r['name'] ?? '') : '', $currentReports);
                foreach ($packReports as $report) {
                    if (!in_array((string) ($report['name'] ?? ''), $names, true)) {
                        $this->skip('report ' . (string) ($report['name'] ?? ''), 'the app has its own reports; left as they are');
                    }
                }
            }
        }
        return $plan;
    }

    // ── Roles ───────────────────────────────────────────────────────────────

    /** @return array<string,array{roleId:?string,permissions:list<array{formId:?string,permission:string}>,added:string[]}> */
    private function planRoles(string $appId, array $source, array $installed): array
    {
        $roles = [];
        foreach ($this->appUsers->getRoles($appId) as $role) {
            $roles[(string) ($role['name'] ?? '')][] = $role;
        }
        $plans = [];
        foreach (is_array($source['app']['roles'] ?? null) ? $source['app']['roles'] : [] as $packRole) {
            $name = (string) ($packRole['name'] ?? '');
            if ($name === '' || $name === 'Owner') {
                continue;
            }
            $wanted = [];
            foreach (is_array($packRole['permissions'] ?? null) ? $packRole['permissions'] : [] as $perm) {
                $permission = (string) ($perm['permission'] ?? '');
                // Only what a role can hold: a built-in permission or a connector
                // grant. Anything else the importer drops too (flow.*.run is app
                // logic's grant, not a role's), so asking for it would never settle.
                if (!in_array($permission, AppPermissions::ALL, true) && !AppPermissions::isConnectorGrant($permission)) {
                    continue;
                }
                $packFormId = $perm['packFormId'] ?? null;
                $formId = null;
                if ($packFormId !== null) {
                    $formId = $installed['formMap'][$packFormId] ?? null;
                    if ($formId === null) {
                        continue;
                    }
                }
                $wanted[] = ['formId' => $formId, 'permission' => $permission];
            }
            // The importer grants execute_flows to every role that gets any
            // permission (packs predate that permission); so does the upgrade.
            if ($wanted !== [] && !in_array(AppPermissions::EXECUTE_FLOWS, array_column($wanted, 'permission'), true)) {
                $wanted[] = ['formId' => null, 'permission' => AppPermissions::EXECUTE_FLOWS];
            }

            $matches = $roles[$name] ?? [];
            $matches = array_values(array_filter(
                $matches,
                static fn (array $r): bool => !empty($packRole['system']) === !empty($r['isSystem'])
            ));
            if (count($matches) > 1) {
                $this->skip("role {$name}", 'more than one role has that name; left as they are');
                continue;
            }
            if ($matches === []) {
                if (!empty($packRole['system'])) {
                    $this->skip("role {$name}", 'the built-in role is missing');
                    continue;
                }
                $plans[$name] = [
                    'roleId' => null,
                    'description' => $packRole['description'] ?? null,
                    'permissions' => $wanted,
                    'added' => array_values(array_unique(array_column($wanted, 'permission'))),
                ];
                continue;
            }
            $role = $matches[0];
            $have = [];
            $permissions = [];
            foreach ($role['permissions'] ?? [] as $perm) {
                $key = ($perm['formId'] ?? '') . '|' . $perm['permission'];
                $have[$key] = true;
                $permissions[] = ['formId' => $perm['formId'] ?? null, 'permission' => (string) $perm['permission']];
            }
            $added = [];
            foreach ($wanted as $perm) {
                $key = ($perm['formId'] ?? '') . '|' . $perm['permission'];
                if (!isset($have[$key])) {
                    $have[$key] = true;
                    $permissions[] = $perm;
                    $added[] = $perm['permission'];
                }
            }
            if ($added !== []) {
                $plans[$name] = ['roleId' => (string) $role['id'], 'description' => null, 'permissions' => $permissions, 'added' => $added];
            }
        }
        return $plans;
    }

    // ── Flows and bindings ──────────────────────────────────────────────────

    /**
     * @return array{0:array<string,array<string,mixed>>,1:list<array<string,mixed>>}
     */
    private function planFlows(string $appId, array $source, array $installed): array
    {
        $installedFlows = [];
        $duplicates = [];
        foreach ($this->flows->listFlows($appId) as $flow) {
            $slug = (string) ($flow['slug'] ?? '');
            if (isset($installedFlows[$slug])) {
                $duplicates[$slug] = true;
            }
            $installedFlows[$slug] = $flow;
        }

        $flowPlans = [];
        foreach ($source['flows'] as $slug => $packFlow) {
            if (isset($duplicates[$slug])) {
                $this->skip("flow {$slug}", 'more than one flow has that slug; left as they are');
                continue;
            }
            try {
                $desired = $this->prepareFlow($slug, $packFlow, $installed['formMap']);
            } catch (\RuntimeException | \InvalidArgumentException) {
                $this->skip("flow {$slug}", 'it reads a form the installed app does not have');
                continue;
            }
            $current = $installedFlows[$slug] ?? null;
            if ($current === null) {
                $flowPlans[$slug] = ['action' => 'create', 'flow' => null, 'desired' => $desired];
                continue;
            }
            if (($current['ownerUserId'] ?? null) !== $installed['ownerId'] || ($current['engine'] ?? null) !== 'f2i'
                || ($current['name'] ?? null) !== $desired['name']) {
                // No pack flow has ever been renamed: another name under the
                // pack's slug is someone else's flow.
                $this->skip("flow {$slug}", 'a flow with that slug is owner-authored; left as it is, with its bindings');
                continue;
            }
            $flowPlans[$slug] = [
                'action' => $this->flowMatches($current, $desired) ? 'keep' : 'update',
                'flow' => $current,
                'desired' => $desired,
            ];
        }

        $installedBindings = $this->flows->listBindings($appId);
        $claimed = [];
        $bindingPlans = [];
        foreach ($source['bindings'] as $packBinding) {
            $slug = (string) $packBinding['flow'];
            if (!isset($flowPlans[$slug])) {
                continue;
            }
            try {
                $desired = $this->prepareBinding($packBinding, $installed['formMap']);
            } catch (\RuntimeException | \InvalidArgumentException) {
                $this->skip("binding {$slug} on " . (string) ($packBinding['event'] ?? ''), 'it writes to a form the installed app does not have');
                continue;
            }
            $label = $slug . ' on ' . $desired['event'];
            $flow = $flowPlans[$slug]['flow'];
            if ($flow === null) {
                $bindingPlans[] = ['action' => 'create', 'label' => $label, 'binding' => null, 'desired' => $desired];
                continue;
            }
            $mine = array_values(array_filter(
                $installedBindings,
                static fn (array $b): bool => ($b['flowDefinitionId'] ?? null) === $flow['id'] && !isset($claimed[$b['id']])
            ));
            $sameEvent = array_values(array_filter($mine, static fn (array $b): bool => $b['event'] === $desired['event']));
            if (count($sameEvent) > 1) {
                $this->skip("binding {$label}", 'more than one binding matches; left as they are');
                continue;
            }
            $match = $sameEvent[0] ?? null;
            if ($match === null) {
                $moved = array_values(array_filter(
                    $mine,
                    static fn (array $b): bool => in_array($b['event'], self::MOVED_BINDING_EVENTS[$slug] ?? [], true)
                ));
                $match = count($moved) === 1 ? $moved[0] : null;
            }
            if ($match === null) {
                $bindingPlans[] = ['action' => 'create', 'label' => $label, 'binding' => null, 'desired' => $desired];
                continue;
            }
            $claimed[$match['id']] = true;
            if (!$this->bindingMatches($match, $desired)) {
                $bindingPlans[] = ['action' => 'update', 'label' => $label, 'binding' => $match, 'desired' => $desired];
            }
        }
        return [$flowPlans, $bindingPlans];
    }

    /** @return array<string,mixed> */
    private function prepareFlow(string $slug, array $packFlow, array $formMap): array
    {
        $name = trim((string) ($packFlow['name'] ?? ''));
        if ($name === '' || strlen($name) > 255) {
            throw new \RuntimeException("Pack flow '{$slug}' has an invalid name");
        }
        $flowJson = FlowService::sanitizeFlowJson($packFlow['flowJson'] ?? null);
        $flowJson = $this->packs->resolveFlowJsonFormRefs($flowJson, $formMap, $slug);
        $caps = null;
        if (is_array($packFlow['nodeCapabilities'] ?? null)) {
            $caps = array_values(array_filter(
                $packFlow['nodeCapabilities'],
                static fn ($c): bool => is_string($c) && $c !== '' && strlen($c) <= 128
            ));
            $caps = $caps !== [] ? array_slice($caps, 0, 64) : null;
        }
        return [
            'name' => $name,
            'description' => isset($packFlow['description']) && is_string($packFlow['description'])
                ? substr($packFlow['description'], 0, 2000) : null,
            'flowJson' => $flowJson,
            'inputSchema' => is_array($packFlow['inputSchema'] ?? null) ? $packFlow['inputSchema'] : null,
            'outputSchema' => is_array($packFlow['outputSchema'] ?? null) ? $packFlow['outputSchema'] : null,
            'nodeCapabilities' => $caps,
            'enabled' => array_key_exists('enabled', $packFlow) ? (bool) $packFlow['enabled'] : true,
        ];
    }

    /** @return array<string,mixed> */
    private function prepareBinding(array $packBinding, array $formMap): array
    {
        $clean = FlowService::sanitizeBinding($packBinding);
        $actions = $clean['outputActions'];
        if ($actions !== null) {
            foreach ($actions as &$action) {
                $ref = $action['form'] ?? null;
                if (is_string($ref) && str_starts_with($ref, '@pack:')) {
                    $action['form'] = $formMap[substr($ref, 6)]
                        ?? throw new \RuntimeException('Pack binding writes to an unknown form');
                } elseif ($ref !== null) {
                    unset($action['form']);
                }
            }
            unset($action);
        }
        $formId = null;
        $formRef = $packBinding['formId'] ?? null;
        if (is_string($formRef) && str_starts_with($formRef, '@pack:')) {
            $formId = $formMap[substr($formRef, 6)] ?? throw new \RuntimeException('Pack binding targets an unknown form');
        }
        $connectorId = is_string($packBinding['connectorId'] ?? null) && $packBinding['connectorId'] !== ''
            ? substr($packBinding['connectorId'], 0, 64) : null;
        return [
            'flow' => $clean['flow'],
            'event' => $clean['event'],
            'mode' => $clean['mode'],
            'condition' => $clean['condition'],
            'inputMap' => $clean['inputMap'],
            'outputActions' => $actions,
            'timeoutMs' => $clean['timeoutMs'],
            'retryPolicy' => $clean['retryPolicy'],
            'fallbackPolicy' => $clean['fallbackPolicy'],
            'enabled' => $clean['enabled'],
            'formId' => $formId,
            'connectorId' => $connectorId,
            'sortOrder' => (int) ($packBinding['sortOrder'] ?? 0),
        ];
    }

    private function flowMatches(array $current, array $desired): bool
    {
        foreach (['name', 'description', 'flowJson', 'inputSchema', 'outputSchema', 'nodeCapabilities'] as $key) {
            if (!$this->sameValue($current[$key] ?? null, $desired[$key] ?? null)) {
                return false;
            }
        }
        return true;
    }

    /** Everything but `enabled`, which stays the operator's. */
    private function bindingMatches(array $current, array $desired): bool
    {
        foreach ([
            'formId', 'connectorId', 'flow', 'event', 'mode', 'condition', 'inputMap',
            'outputActions', 'timeoutMs', 'retryPolicy', 'fallbackPolicy', 'sortOrder',
        ] as $key) {
            if (!$this->sameValue($current[$key] ?? null, $desired[$key] ?? null)) {
                return false;
            }
        }
        return true;
    }

    // ── Applying the MySQL side ─────────────────────────────────────────────

    private function applyMysqlChanges(
        string $appId,
        array $installed,
        array $source,
        array $appPlan,
        array $rolePlans,
        array $flowPlans,
        array $bindingPlans,
        bool $versionChanges
    ): void {
        if ($this->mysql->inTransaction()) {
            throw new \RuntimeException('The Aokie upgrade requires its own database transaction');
        }
        $this->mysql->beginTransaction();
        try {
            $lock = $this->mysql->prepare('SELECT owner_id FROM apps WHERE id = :id FOR UPDATE');
            $lock->execute(['id' => $appId]);
            if ($lock->fetchColumn() !== $installed['ownerId']) {
                throw new \RuntimeException('Target app ownership changed during upgrade');
            }

            $appUpdate = [];
            if ($appPlan['description'] !== null) {
                $appUpdate['description'] = $appPlan['description'];
            }
            if ($appPlan['logic'] !== null) {
                $appUpdate['customLogic'] = $appPlan['logic'];
            }
            if ($appPlan['settings'] !== null) {
                $appUpdate['settings'] = $appPlan['settings'];
            }
            if ($appPlan['screen'] !== null) {
                $appUpdate['customScreen'] = $appPlan['screen'];
            }
            if ($appPlan['reports'] !== null) {
                $appUpdate['reports'] = $appPlan['reports'];
            }
            if ($appUpdate !== [] && $this->apps->updateApp($appId, $appUpdate) === null) {
                throw new \RuntimeException('The app could not be updated');
            }
            if ($appPlan['screen'] !== null) {
                $this->apps->setCustomScreenTrust($appId, $appPlan['screenTrust']['trust'], $appPlan['screenTrust']['provenance']);
            }

            foreach ($rolePlans as $name => $plan) {
                $roleId = $plan['roleId'];
                if ($roleId === null) {
                    $role = $this->appUsers->createRole($appId, ['name' => $name, 'description' => $plan['description']]);
                    $roleId = (string) $role['id'];
                }
                $this->appUsers->setRolePermissions($roleId, $plan['permissions'], true);
                $this->appUsers->setConnectorGrants($roleId, $plan['permissions'], true);
            }

            $flowIds = [];
            foreach ($flowPlans as $slug => $plan) {
                if ($plan['action'] === 'create') {
                    $create = $plan['desired'];
                    $create['slug'] = $slug;
                    $flowIds[$slug] = (string) $this->flows->createFlow($appId, $installed['ownerId'], $create)['id'];
                    continue;
                }
                $flowIds[$slug] = (string) $plan['flow']['id'];
                if ($plan['action'] === 'update') {
                    $update = $plan['desired'];
                    unset($update['enabled']);
                    if ($this->flows->updateFlow($appId, $plan['flow']['id'], $update) === null) {
                        throw new \RuntimeException("Installed flow '{$slug}' could not be updated");
                    }
                }
            }
            foreach ($bindingPlans as $plan) {
                if ($plan['action'] === 'create') {
                    $this->flows->createBinding($appId, $plan['desired']);
                    continue;
                }
                $update = $plan['desired'];
                $update['enabled'] = (bool) $plan['binding']['enabled'];
                if ($this->flows->updateBinding($appId, $plan['binding']['id'], $update) === null) {
                    throw new \RuntimeException("Installed binding '{$plan['label']}' could not be updated");
                }
            }

            if ($versionChanges) {
                $this->mysql->prepare(
                    'UPDATE pack_installations
                        SET pack_version = :version, pack_name = :name, pack_description = :description
                      WHERE id = :id'
                )->execute([
                    'version' => $source['packVersion'],
                    'name' => $source['packName'],
                    'description' => $source['packDescription'],
                    'id' => $installed['installation']['id'],
                ]);
            }
            $this->mysql->commit();
        } catch (\Throwable $e) {
            if ($this->mysql->inTransaction()) {
                $this->mysql->rollBack();
            }
            throw $e;
        }
    }

    // ── The summary ─────────────────────────────────────────────────────────

    /** @return array<string,mixed> */
    private function describeChanges(
        array $formPlans,
        array $appPlan,
        array $rolePlans,
        array $flowPlans,
        array $bindingPlans,
        bool $versionChanges
    ): array {
        $forms = [];
        foreach ($formPlans as $packFormId => $plan) {
            if (!$plan['hasChanges']) {
                continue;
            }
            $forms[$packFormId] = [
                'fieldsAdded' => $plan['fieldsAdded'],
                'fieldsUpdated' => $plan['fieldsUpdated'],
                'fieldsReordered' => $plan['fieldsReordered'],
                'settingsAdded' => $plan['settingsAdded'],
                'screen' => $plan['screen'] !== null,
            ];
        }
        $roles = [];
        foreach ($rolePlans as $name => $plan) {
            $roles[$name] = ['created' => $plan['roleId'] === null, 'permissionsAdded' => $plan['added']];
        }
        $flows = ['created' => [], 'updated' => []];
        foreach ($flowPlans as $slug => $plan) {
            if ($plan['action'] === 'create') {
                $flows['created'][] = $slug;
            } elseif ($plan['action'] === 'update') {
                $flows['updated'][] = $slug;
            }
        }
        $bindings = ['created' => [], 'updated' => []];
        foreach ($bindingPlans as $plan) {
            $bindings[$plan['action'] === 'create' ? 'created' : 'updated'][] = $plan['label'];
        }
        return [
            'forms' => $forms,
            'appLogic' => [
                'scriptsAdded' => $appPlan['scriptsAdded'],
                'scriptsUpdated' => $appPlan['scriptsUpdated'],
                'permissionsAdded' => $appPlan['permissionsAdded'],
                'connector' => $appPlan['connector'],
                'changed' => $appPlan['logic'] !== null,
            ],
            'appSettings' => $appPlan['settingsAdded'],
            'appDescription' => $appPlan['description'] !== null,
            'appScreen' => $appPlan['screen'] !== null,
            'reports' => $appPlan['reportsAdded'],
            'roles' => $roles,
            'flows' => $flows,
            'bindings' => $bindings,
            'installationVersion' => $versionChanges,
        ];
    }

    private function hasChanges(array $changes): bool
    {
        return $changes['forms'] !== []
            || $changes['appLogic']['changed']
            || $changes['appSettings'] !== []
            || $changes['appDescription']
            || $changes['appScreen']
            || $changes['reports'] !== []
            || $changes['roles'] !== []
            || $changes['flows']['created'] !== [] || $changes['flows']['updated'] !== []
            || $changes['bindings']['created'] !== [] || $changes['bindings']['updated'] !== []
            || $changes['installationVersion'];
    }

    private function skip(string $item, string $reason): void
    {
        foreach ($this->skipped as $entry) {
            if ($entry['item'] === $item) {
                return;
            }
        }
        $this->skipped[] = ['item' => $item, 'reason' => $reason];
    }

    // ── Value helpers ───────────────────────────────────────────────────────

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

<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Database\MySQLConnection;
use PDO;

/**
 * Diagram materialisation (extensible-flows plan §11A D3): "Create app from diagram" —
 * the ONE sanctioned cross-aggregate actor that turns a concept sketch into real
 * resources. Concept form entities become forms (their sketched fields become real
 * fields), ER 'relation' edges become linked_record fields on the target form, and the
 * whole set attaches to a NEW app atomically (AppService::createApp's formIds attach).
 * The blueprint is then LINKED (blueprints.app_id) and its elements stamped with
 * resourceRefs through the ordinary operation gateway (origin 'launcher'), so the
 * change is audited like any other edit.
 *
 * Failure discipline: per-form SQLite means one MySQL transaction cannot cover
 * everything (the plan's §14.1 correction) — so this runs create-forms → create-app →
 * link, and COMPENSATES on failure (deletes the forms/app this call created; never
 * touches pre-existing resources). Materialisation is once-per-diagram in v1: a
 * blueprint already linked to an app refuses (deltas are the D5 slice).
 */
class BlueprintMaterializeService
{
    private PDO $mysql;

    public function __construct(
        MySQLConnection $mysql,
        private BlueprintService $blueprints,
        private FormService $forms,
        private AppService $apps,
    ) {
        $this->mysql = $mysql->getConnection();
    }

    /**
     * @return array{appId: string, appSlug: ?string, createdFormIds: string[], reusedFormIds: string[], relations: int}
     * @throws \InvalidArgumentException on refusals (unknown/linked/empty blueprint, foreign form refs)
     */
    public function materialize(string $ownerUserId, string $blueprintId): array
    {
        $blueprint = $this->blueprints->getBlueprint($ownerUserId, $blueprintId);
        if ($blueprint === null) {
            throw new \InvalidArgumentException('Unknown blueprint');
        }
        if ($blueprint['appId'] !== null) {
            throw new \InvalidArgumentException('This diagram is already linked to an app — changes apply as deltas');
        }
        $elements = $blueprint['elements'] ?? [];
        $formElements = array_values(array_filter($elements, fn (array $e) => $e['elementType'] === 'form'));
        if ($formElements === []) {
            throw new \InvalidArgumentException('Sketch at least one form entity before creating the app');
        }

        // Resolve every form element FIRST (pure validation): an existing resourceRef must
        // be the owner's form; concept entities carry their sketched field defs.
        $plans = [];
        foreach ($formElements as $element) {
            $ref = $element['resourceRef'];
            $refId = is_array($ref) && ($ref['kind'] ?? null) === 'form' && is_string($ref['id'] ?? null) ? $ref['id'] : null;
            if ($refId !== null) {
                $existing = $this->forms->getForm($refId);
                if (!$existing || ($existing['userId'] ?? null) !== $ownerUserId) {
                    throw new \InvalidArgumentException("Placed form '{$refId}' no longer exists (or isn't yours)");
                }
                $plans[] = ['elementId' => $element['id'], 'existingFormId' => $refId];
                continue;
            }
            $properties = is_array($element['properties']) ? $element['properties'] : [];
            $plans[] = [
                'elementId' => $element['id'],
                'title' => trim((string) ($properties['title'] ?? '')) !== '' ? trim((string) $properties['title']) : 'Untitled form',
                'fields' => $this->fieldDefs(is_array($properties['fields'] ?? null) ? $properties['fields'] : []),
            ];
        }

        $createdFormIds = [];
        $appId = null;
        try {
            // 1. Concept entities → real forms (standalone drafts; attached below).
            $formIdByElement = [];
            foreach ($plans as $plan) {
                if (isset($plan['existingFormId'])) {
                    $formIdByElement[$plan['elementId']] = $plan['existingFormId'];
                    continue;
                }
                $form = $this->forms->createForm([
                    'userId' => $ownerUserId,
                    'title' => $plan['title'],
                    'fields' => $plan['fields'],
                    'status' => 'draft',
                ]);
                $createdFormIds[] = (string) $form['id'];
                $formIdByElement[$plan['elementId']] = (string) $form['id'];
            }

            // 2. ER relations → linked_record fields on the TARGET form pointing at the
            //    SOURCE form. Only edges between materialised form elements apply.
            $relations = 0;
            foreach ($elements as $element) {
                if ($element['elementType'] !== 'edge') {
                    continue;
                }
                $props = is_array($element['properties']) ? $element['properties'] : [];
                if (($props['edgeType'] ?? null) !== 'relation') {
                    continue;
                }
                $sourceFormId = $formIdByElement[(string) ($props['sourceId'] ?? '')] ?? null;
                $targetFormId = $formIdByElement[(string) ($props['targetId'] ?? '')] ?? null;
                if ($sourceFormId === null || $targetFormId === null) {
                    continue;
                }
                $fkName = trim((string) ($props['fkField'] ?? ''));
                if ($fkName === '') {
                    $fkName = 'link';
                }
                $target = $this->forms->getForm($targetFormId);
                if (!$target) {
                    continue;
                }
                $fields = is_array($target['fields'] ?? null) ? $target['fields'] : [];
                $fieldId = $this->uniqueFieldId($fkName, array_column($fields, 'id'));
                $fields[] = [
                    'id' => $fieldId,
                    'type' => 'linked_record',
                    'label' => ucfirst(str_replace('_', ' ', $fkName)),
                    // Field extras ride the properties JSON (saveFormFields' storage model).
                    'properties' => ['targetFormId' => $sourceFormId],
                ];
                $this->forms->updateForm($targetFormId, ['userId' => $ownerUserId, 'fields' => $fields], $ownerUserId);
                $relations++;
            }

            // 3. The app — with every form attached ATOMICALLY in the same creation txn.
            $app = $this->apps->createApp(
                ['name' => (string) $blueprint['name'], 'formIds' => array_values(array_unique(array_values($formIdByElement)))],
                $ownerUserId
            );
            $appId = (string) $app['id'];

            // 4. Link + stamp: app id on the blueprint row, resourceRefs + materialised
            //    states through the gateway (audited, origin 'launcher'). A gateway
            //    refusal here (concurrent edit) still compensates the whole pass —
            //    materialisation is all-or-nothing.
            $operations = [];
            foreach ($plans as $plan) {
                if (isset($plan['existingFormId'])) {
                    continue;
                }
                $operations[] = [
                    'operationId' => 'op-mz-' . bin2hex(random_bytes(8)),
                    'type' => 'blueprint.element.update',
                    'targetId' => $plan['elementId'],
                    'resourceRef' => ['kind' => 'form', 'id' => $formIdByElement[$plan['elementId']]],
                ];
            }
            if ($operations !== []) {
                $this->blueprints->commitOperations($ownerUserId, $blueprintId, [
                    'baseSemanticRevision' => (int) $blueprint['semanticRevision'],
                    'origin' => 'launcher',
                    'operations' => $operations,
                ]);
            }
            $this->mysql->prepare('UPDATE blueprints SET app_id = :app, status = :status WHERE id = :id')
                ->execute(['app' => $appId, 'status' => 'materialised', 'id' => $blueprintId]);

            // §11A D4: record the element↔resource association with the version we
            // observed — pull sync compares live updated_at against it (differ = stale,
            // gone = missing) and it doubles as the reverse index for future pushes.
            $link = $this->mysql->prepare('
                INSERT INTO blueprint_resource_links
                    (blueprint_id, element_id, resource_type, resource_id, last_observed_version, materialisation_status)
                VALUES (:b, :el, :t, :r, :v, :s)
                ON DUPLICATE KEY UPDATE resource_id = VALUES(resource_id),
                    last_observed_version = VALUES(last_observed_version),
                    materialisation_status = VALUES(materialisation_status)
            ');
            foreach ($formIdByElement as $elementId => $formId) {
                $observed = $this->forms->getForm((string) $formId);
                $link->execute([
                    'b' => $blueprintId,
                    'el' => (string) $elementId,
                    't' => 'form',
                    'r' => (string) $formId,
                    'v' => is_array($observed) && is_string($observed['updatedAt'] ?? null) ? $observed['updatedAt'] : null,
                    's' => 'materialised',
                ]);
            }

            return [
                'appId' => $appId,
                'appSlug' => isset($app['slug']) && is_string($app['slug']) ? $app['slug'] : null,
                'createdFormIds' => $createdFormIds,
                'reusedFormIds' => array_values(array_diff(array_values($formIdByElement), $createdFormIds)),
                'relations' => $relations,
            ];
        } catch (\Throwable $e) {
            // Compensation: remove ONLY what this call created; pre-existing forms are
            // never touched. Best-effort — a failed cleanup logs and moves on.
            if ($appId !== null) {
                try {
                    $this->apps->deleteApp($appId);
                } catch (\Throwable $cleanup) {
                    error_log("BlueprintMaterializeService: app cleanup failed ({$appId}): " . $cleanup->getMessage());
                }
            }
            foreach ($createdFormIds as $formId) {
                try {
                    $this->forms->deleteForm($formId);
                } catch (\Throwable $cleanup) {
                    error_log("BlueprintMaterializeService: form cleanup failed ({$formId}): " . $cleanup->getMessage());
                }
            }
            throw $e;
        }
    }

    /** Sketch rows [{name, type}] → real field definitions (slug ids, human labels). */
    private function fieldDefs(array $sketch): array
    {
        $fields = [];
        $used = [];
        foreach ($sketch as $row) {
            $name = is_array($row) && is_string($row['name'] ?? null) ? trim($row['name']) : '';
            if ($name === '') {
                continue;
            }
            $type = is_array($row) && is_string($row['type'] ?? null) ? $row['type'] : 'short_text';
            $allowed = ['short_text', 'long_text', 'number', 'date', 'email', 'phone', 'checkbox', 'dropdown'];
            if (!in_array($type, $allowed, true)) {
                $type = 'short_text';
            }
            $id = $this->uniqueFieldId($name, $used);
            $used[] = $id;
            $field = [
                'id' => $id,
                'type' => $type,
                'label' => ucfirst(str_replace('_', ' ', $name)),
            ];
            if ($type === 'dropdown') {
                $field['options'] = [];
            }
            $fields[] = $field;
        }
        return $fields;
    }

    /** @param string[] $used */
    private function uniqueFieldId(string $name, array $used): string
    {
        $base = strtolower((string) preg_replace('/[^a-z0-9]+/i', '_', $name));
        $base = trim($base, '_');
        if ($base === '' || preg_match('/^[a-z]/', $base) !== 1) {
            $base = 'field' . ($base === '' ? '' : '_' . $base);
        }
        $id = $base;
        $counter = 1;
        while (in_array($id, $used, true)) {
            $id = $base . '_' . $counter;
            $counter++;
        }
        return $id;
    }
}

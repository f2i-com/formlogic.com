<?php

declare(strict_types=1);

namespace FormLogic\Helpers;

/**
 * Shared builders for the inverse "related records" grids (linked-records feature),
 * used by both the app-scoped (AppPublicController) and owner-scoped (ResponseController)
 * endpoints so the per-relationship config, column defs and record shaping stay identical.
 */
final class RelatedRecords
{
    /** Simple field types eligible as fallback grid columns / display parts. */
    private const SIMPLE_TYPES = ['short_text', 'long_text', 'email', 'phone', 'url', 'number', 'dropdown', 'date'];
    private const CHOICE_TYPES = ['dropdown', 'multiple_choice', 'checkboxes'];

    /**
     * Per-relationship sub-grid config + column definitions for a source form's linked field.
     * @return array{0: array<string,mixed>, 1: array<int,array<string,mixed>>} [config, columns]
     */
    public static function fieldConfig(array $sourceForm, string $fieldId): array
    {
        $cfg = [
            'fieldLabel' => $fieldId,
            'displayFieldIds' => [],
            'allowMultiple' => false,
            'hidden' => false,
            'allowAdd' => true,
            'allowDelete' => true,
            'pageSize' => 8,
            'columnFieldIds' => [],
        ];
        $fields = $sourceForm['fields'] ?? [];
        foreach ($fields as $f) {
            if (($f['id'] ?? null) === $fieldId) {
                $props = $f['properties'] ?? [];
                $cfg['fieldLabel'] = $f['label'] ?? $fieldId;
                // relatedColumnFieldIds names SOURCE-form fields for the sub-grid's columns/row
                // labels; displayFieldIds keeps its original meaning (TARGET-record label in
                // pickers/detail chips) but doubles as the column config for older forms that
                // predate the split.
                $related = $props['relatedColumnFieldIds'] ?? null;
                $cfg['displayFieldIds'] = is_array($related) && $related !== [] ? $related : ($props['displayFieldIds'] ?? []);
                $cfg['allowMultiple'] = !empty($props['allowMultiple']);
                $cfg['hidden'] = !empty($props['relatedHidden']);
                $cfg['allowAdd'] = ($props['relatedAllowAdd'] ?? true) !== false;
                $cfg['allowDelete'] = ($props['relatedAllowDelete'] ?? true) !== false;
                if (is_numeric($props['relatedPageSize'] ?? null)) {
                    $cfg['pageSize'] = max(1, min((int) $props['relatedPageSize'], 50));
                }
                break;
            }
        }

        // Columns: the link's displayFieldIds, else the first few simple fields.
        $columnFieldIds = $cfg['displayFieldIds'];
        if (empty($columnFieldIds)) {
            $c = 0;
            foreach ($fields as $f) {
                if ($c >= 3) break;
                if (in_array($f['type'] ?? '', self::SIMPLE_TYPES, true)) {
                    $columnFieldIds[] = $f['id'];
                    $c++;
                }
            }
        }
        $byId = [];
        foreach ($fields as $f) {
            $byId[$f['id'] ?? ''] = $f;
        }
        $columns = [];
        foreach ($columnFieldIds as $cfid) {
            $f = $byId[$cfid] ?? null;
            if (!$f) continue;
            $col = ['id' => $cfid, 'label' => $f['label'] ?? $cfid, 'type' => $f['type'] ?? 'text'];
            // Choice columns carry their option map so the UI renders labels, not "option_2".
            if (in_array($f['type'] ?? '', self::CHOICE_TYPES, true) && !empty($f['properties']['options'])) {
                $opts = [];
                foreach ($f['properties']['options'] as $o) {
                    if (isset($o['value'])) {
                        $opts[] = ['value' => (string) $o['value'], 'label' => (string) ($o['label'] ?? $o['value'])];
                    }
                }
                if ($opts) $col['options'] = $opts;
            }
            $columns[] = $col;
        }
        $cfg['columnFieldIds'] = $columnFieldIds;

        return [$cfg, $columns];
    }

    /**
     * Match-based relationships declared on a source form's linked_record fields:
     * `properties.matchField` (a field on the source form) joins records whose answer equals
     * the target record's `properties.targetMatchField` answer (defaults to matchField).
     * Lets flow-/logic-written records relate by a shared key (call_id, phone, …) without the
     * writer ever knowing the target's response id — resolved read-side, merged with explicit
     * response_links rows into the same relationship group.
     *
     * @return array<int,array{fieldId: string, matchField: string, targetMatchField: string}>
     */
    public static function matchRelations(array $sourceForm, string $targetFormId): array
    {
        $out = [];
        foreach ($sourceForm['fields'] ?? [] as $f) {
            if (($f['type'] ?? '') !== 'linked_record') {
                continue;
            }
            $props = $f['properties'] ?? [];
            if (($props['targetFormId'] ?? '') !== $targetFormId) {
                continue;
            }
            $matchField = $props['matchField'] ?? null;
            if (!is_string($matchField) || $matchField === '' || !is_string($f['id'] ?? null)) {
                continue;
            }
            $targetMatchField = $props['targetMatchField'] ?? null;
            $out[] = [
                'fieldId' => $f['id'],
                'matchField' => $matchField,
                'targetMatchField' => is_string($targetMatchField) && $targetMatchField !== '' ? $targetMatchField : $matchField,
            ];
        }
        return $out;
    }

    /**
     * Fold match-based relations for one source form into the response_links groups
     * (same `formId|fieldId` keys, so explicit links and matches dedupe together).
     * $fetchMatches performs the bounded answer-equality lookup and returns response rows.
     *
     * @param array<string,array{formId: string, fieldId: string, ids: array<string,bool>}> $groups
     */
    public static function mergeMatchGroups(
        array &$groups,
        array $sourceForm,
        string $sourceFormId,
        string $targetFormId,
        string $targetResponseId,
        array $targetAnswers,
        callable $fetchMatches
    ): void {
        foreach (self::matchRelations($sourceForm, $targetFormId) as $rel) {
            $val = $targetAnswers[$rel['targetMatchField']] ?? null;
            if (!is_scalar($val)) {
                continue;
            }
            $val = trim((string) $val);
            if ($val === '') {
                continue;
            }
            $matches = $fetchMatches($sourceFormId, $rel['matchField'], $val);
            foreach ($matches as $m) {
                $mid = $m['id'] ?? null;
                if (!is_string($mid) || $mid === '') {
                    continue;
                }
                // A record never relates to itself through a same-form join key.
                if ($sourceFormId === $targetFormId && $mid === $targetResponseId) {
                    continue;
                }
                $key = $sourceFormId . '|' . $rel['fieldId'];
                if (!isset($groups[$key])) {
                    $groups[$key] = ['formId' => $sourceFormId, 'fieldId' => $rel['fieldId'], 'ids' => []];
                }
                $groups[$key]['ids'][$mid] = true;
            }
        }
    }

    /**
     * Build the display records for one group from its source responses.
     * @return array<int,array<string,mixed>>
     */
    public static function buildRecords(array $sourceResponses, array $sourceForm, array $displayFieldIds, array $columnFieldIds): array
    {
        $out = [];
        foreach ($sourceResponses as $sr) {
            $answers = $sr['answers'] ?? [];
            $parts = [];
            foreach ($displayFieldIds as $dfid) {
                $val = $answers[$dfid] ?? null;
                if ($val !== null) $parts[] = is_array($val) ? implode(', ', $val) : (string) $val;
            }
            if (empty($parts)) {
                $c = 0;
                foreach ($sourceForm['fields'] ?? [] as $f) {
                    if ($c >= 2) break;
                    if (in_array($f['type'] ?? '', ['short_text', 'long_text', 'email', 'phone', 'url', 'number'], true)) {
                        $val = $answers[$f['id']] ?? null;
                        if ($val !== null) { $parts[] = (string) $val; $c++; }
                    }
                }
            }
            $recFields = [];
            foreach ($columnFieldIds as $cfid) {
                $recFields[$cfid] = $answers[$cfid] ?? null;
            }
            $out[] = [
                'id' => $sr['id'],
                'display' => implode(' - ', $parts) ?: ('Record ' . substr((string) $sr['id'], 0, 8)),
                'submittedAt' => $sr['submittedAt'] ?? '',
                'fields' => $recFields,
            ];
        }
        return $out;
    }
}

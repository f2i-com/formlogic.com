<?php

declare(strict_types=1);

namespace FormLogic\Helpers;

/**
 * Best-effort human label for a record referenced by a linked_record field, when the linking
 * field has no explicit displayFieldIds configured. Tries hardest to surface a person's / entity's
 * NAME (matching common field-naming patterns) before falling back to any text field, so responses
 * read "Ada Lovelace" rather than a UUID or an arbitrary column.
 *
 * Detection order:
 *   1. a single full-name field  (name / full_name / fullName / display_name)
 *   2. first + last concatenated (first_name/given/forename + last_name/surname/family)
 *   3. any other *name*-ish field (contact_name, employee_name…) excluding username/filename/etc.
 *   4. the first non-empty text-ish field
 */
class RecordLabel
{
    /** Normalized keys (letters+digits only) that denote a single full-name field. */
    private const FULL_NAME = ['fullname', 'name', 'displayname', 'fullnames', 'contactname', 'employeename', 'customername', 'personname'];
    private const FIRST = ['firstname', 'first', 'givenname', 'given', 'forename', 'fname'];
    private const LAST = ['lastname', 'last', 'surname', 'familyname', 'family', 'lname'];
    private const TEXTISH = ['short_text', 'long_text', 'email', 'phone', 'url', 'number'];
    /** Contains "name" but is never a record's display name. */
    private const NOT_NAME = ['username', 'filename', 'nickname', 'hostname', 'dbname', 'domainname', 'codename'];

    /**
     * @param array<int,array<string,mixed>> $fields  target form field definitions
     * @param array<string,mixed> $answers            the record's answers (fieldId => value)
     */
    public static function guess(array $fields, array $answers): ?string
    {
        // 1. A single full-name field.
        foreach ($fields as $f) {
            if (self::matches($f, self::FULL_NAME)) {
                $v = self::val($answers, $f);
                if ($v !== '') {
                    return $v;
                }
            }
        }

        // 2. first + last name concatenated (either alone is fine too).
        $first = null;
        $last = null;
        foreach ($fields as $f) {
            if ($first === null && self::matches($f, self::FIRST)) {
                $first = self::val($answers, $f);
            }
            if ($last === null && self::matches($f, self::LAST)) {
                $last = self::val($answers, $f);
            }
        }
        if ($first !== null || $last !== null) {
            $parts = array_values(array_filter([$first, $last], static fn ($p) => $p !== null && $p !== ''));
            if (!empty($parts)) {
                return implode(' ', $parts);
            }
        }

        // 3. Any other field that looks like a name.
        foreach ($fields as $f) {
            foreach (self::keys($f) as $k) {
                if (str_contains($k, 'name') && !in_array($k, self::NOT_NAME, true)) {
                    $v = self::val($answers, $f);
                    if ($v !== '') {
                        return $v;
                    }
                    break; // this field is a name field but empty — try the next field
                }
            }
        }

        // 4. Fallback: the first non-empty text-ish field.
        foreach ($fields as $f) {
            if (in_array($f['type'] ?? '', self::TEXTISH, true)) {
                $v = self::val($answers, $f);
                if ($v !== '') {
                    return $v;
                }
            }
        }

        return null;
    }

    /** Normalized keys for a field, derived from both its id and label (lowercased, alnum-only). */
    private static function keys(array $field): array
    {
        $out = [];
        foreach (['id', 'label'] as $src) {
            $raw = $field[$src] ?? '';
            if (!is_string($raw) || $raw === '') {
                continue;
            }
            $norm = preg_replace('/[^a-z0-9]/', '', strtolower($raw));
            if (is_string($norm) && $norm !== '') {
                $out[] = $norm;
            }
        }
        return $out;
    }

    private static function matches(array $field, array $patterns): bool
    {
        foreach (self::keys($field) as $k) {
            if (in_array($k, $patterns, true)) {
                return true;
            }
        }
        return false;
    }

    private static function val(array $answers, array $field): string
    {
        $v = $answers[$field['id'] ?? ''] ?? null;
        if ($v === null) {
            return '';
        }
        if (is_array($v)) {
            return trim(implode(', ', array_map(static fn ($x) => is_scalar($x) ? (string) $x : '', $v)));
        }
        return is_scalar($v) ? trim((string) $v) : '';
    }
}

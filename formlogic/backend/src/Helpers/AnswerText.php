<?php

declare(strict_types=1);

namespace FormLogic\Helpers;

/**
 * Stored answers read as people read them, for search and sort. The `answers` column is JSON that
 * old rows hold with every non-ASCII letter escaped, and SQLite's own LIKE and NOCASE fold ASCII
 * only, so neither can look inside it. SQLiteConnection gives each form's connection the two SQL
 * functions here, which work on what is stored already: no row needs rewriting.
 */
final class AnswerText
{
    /** What a sort falls back to without intl: everyday accented Latin, under its base letter. */
    private const BASE_LETTERS = [
        'a' => 'àáâãäåāăą', 'c' => 'çćĉċč', 'd' => 'ďđ', 'e' => 'èéêëēĕėęě', 'g' => 'ĝğġģ', 'h' => 'ĥħ',
        'i' => 'ìíîïĩīĭįı', 'j' => 'ĵ', 'k' => 'ķ', 'l' => 'ĺļľŀł', 'n' => 'ñńņňŉ', 'o' => 'òóôõöøōŏő',
        'r' => 'ŕŗř', 's' => 'śŝşš', 't' => 'ţťŧ', 'u' => 'ùúûüũūŭůűų', 'w' => 'ŵ', 'y' => 'ýÿŷ', 'z' => 'źżž',
    ];

    /** Text with case taken out, in any script, so two spellings compare equal. */
    public static function fold(string $text): string
    {
        // A search calls this for every row, and most text has no letter strtolower would miss.
        if (preg_match('/[\x80-\xFF]/', $text) !== 1) {
            return strtolower($text);
        }
        $folded = mb_convert_case($text, MB_CASE_FOLD, 'UTF-8');
        // A Mac can hand over é as e plus an accent. Without intl that spelling stays apart.
        return class_exists(\Normalizer::class) ? ((string) \Normalizer::normalize($folded) ?: $folded) : $folded;
    }

    /**
     * Whether a row's answers hold $needle, which fold() has been through: 1 or 0, for SQL. Only
     * values count, never field ids or other JSON keys, and a drawn signature's image data is not
     * text. $fieldIds, one per line, narrows the search to those fields; empty means all of them.
     */
    public static function contains(?string $answers, string $needle, string $fieldIds = ''): int
    {
        if ($answers === null || $needle === '') {
            return 0;
        }
        // Decoding every row is what a large form can't afford. A row with no \u escape or non-ASCII
        // text holds its values as they read, bar JSON's short escapes, which the first test keeps
        // out of this: so a miss in the raw text is a miss.
        if (strcspn($needle, "\"\\/\x08\x0C\n\r\t") === strlen($needle)
            && preg_match('/[\x80-\xFF]|\\\\u/', $answers) !== 1
            && stripos($answers, $needle) === false) {
            return 0;
        }
        $decoded = json_decode($answers, true);
        if (!is_array($decoded)) {
            return 0;
        }
        if ($fieldIds !== '') {
            $decoded = array_intersect_key($decoded, array_flip(explode("\n", $fieldIds)));
        }
        $text = '';
        self::appendValues($decoded, $text);
        return str_contains(self::fold($text), $needle) ? 1 : 0;
    }

    /** @param array<mixed> $values */
    private static function appendValues(array $values, string &$text): void
    {
        foreach ($values as $value) {
            if (is_array($value)) {
                self::appendValues($value, $text);
            } elseif (is_int($value) || is_float($value) || (is_string($value) && !str_starts_with($value, 'data:'))) {
                $text .= $value . "\n";
            }
        }
    }

    /**
     * What ORDER BY compares for an answer: letters in alphabetical order whatever their case or
     * accent, so Émile comes before zack. Numbers and empties pass through and sort as they did.
     */
    public static function sortKey(mixed $value): mixed
    {
        if (!is_string($value)) {
            return $value;
        }
        static $collator = null;
        $collator ??= class_exists(\Collator::class) ? new \Collator('root') : false;
        $key = $collator !== false ? $collator->getSortKey($value) : false;
        return $key !== false ? $key : self::plainSortKey($value);
    }

    /** sortKey for a PHP without intl, or text ICU refuses. Letters outside the table keep code order. */
    public static function plainSortKey(string $value): string
    {
        static $base = null;
        if ($base === null) {
            $base = ['æ' => 'ae', 'œ' => 'oe', 'þ' => 'th'];
            foreach (self::BASE_LETTERS as $letter => $accented) {
                foreach (mb_str_split($accented) as $variant) {
                    $base[$variant] = $letter;
                }
            }
        }
        return strtr(self::fold($value), $base);
    }
}

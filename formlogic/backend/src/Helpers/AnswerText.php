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

    /**
     * What Unicode normalisation can change: combining marks, Korean jamo (letters, not marks), and
     * the characters it swaps for a twin, such as CJK compatibility ideographs and Greek oxia.
     */
    private const COMPOSES = '/[\p{M}\x{1100}-\x{11FF}\x{0374}\x{037E}\x{0387}\x{0958}-\x{095F}\x{09DC}\x{09DD}\x{09DF}\x{0A33}\x{0A36}\x{0A59}-\x{0A5B}\x{0A5E}\x{0B5C}\x{0B5D}\x{0F43}\x{0F4D}\x{0F52}\x{0F57}\x{0F5C}\x{0F69}\x{1F71}-\x{1FFD}\x{2000}\x{2001}\x{2329}\x{232A}\x{2ADC}\x{F900}-\x{FAD9}\x{FB1D}-\x{FB4E}\x{1D15E}-\x{1D164}\x{1D1BB}-\x{1D1C0}\x{2F800}-\x{2FA1D}]/u';

    /** Text with case taken out, in any script, so two spellings compare equal. */
    public static function fold(string $text): string
    {
        // A search calls this for every row, and most text has no letter strtolower would miss.
        if (preg_match('/[\x80-\xFF]/', $text) !== 1) {
            return strtolower($text);
        }
        $folded = mb_convert_case($text, MB_CASE_FOLD, 'UTF-8');
        // A Mac can hand over é as e plus an accent, and Korean as separate jamo. Text with nothing
        // to compose skips this, because a search pays for it on every row: without intl it runs in
        // PHP, through the polyfill symfony/mailer brings, at 0.4 ms for 2,000 Japanese characters.
        if (preg_match(self::COMPOSES, $folded) !== 1) {
            return $folded;
        }
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

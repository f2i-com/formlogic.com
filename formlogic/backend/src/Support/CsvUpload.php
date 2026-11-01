<?php

declare(strict_types=1);

namespace FormLogic\Support;

/**
 * Reads a CSV as spreadsheets save it. Excel's plain "CSV" is in the Windows code page, and where
 * the comma is the decimal mark it separates cells with semicolons, so neither can be assumed.
 */
final class CsvUpload
{
    /** Enough lines to see which delimiter the rows agree on. */
    private const SAMPLE_LINES = 5;

    /** What Windows-1252 leaves undefined, and its ƒ † ‡ ˆ ‰ ‹ ˜ ›: Shift-JIS has letters start on these. */
    private const NOT_WESTERN = "\x81\x83\x86\x87\x88\x89\x8B\x8D\x8F\x90\x98\x9B\x9D";

    /** Signs a word doesn't hold in its middle, where Shift-JIS and Windows-1250 put them as parts of letters. */
    private const NOT_INSIDE_A_WORD = "\x80\x82\x84\x91\x93\x94\x95\x99\xA1\xA2\xA3\xA4\xA5\xA6\xA7\xA8\xA9\xAB\xAC\xAE\xAF\xB0\xB1\xB2\xB3\xB6\xB8\xB9\xBB\xBC\xBD\xBE\xBF";

    /**
     * The file's headings and rows, or null if it has no first line. Cells stay in file order and
     * every row is as long as the headings, so a column is its position: two columns can share a
     * heading (two fields with one label do, in an export). `encoding` is what it was read as, and
     * `endCut` says the file stopped part-way through a character.
     *
     * @return array{headers: list<string>, rows: list<list<string>>, encoding: string, endCut: bool}|null
     * @throws CsvEncodingRefused when reading it would mean guessing at its letters
     */
    public static function parse(string $bytes): ?array
    {
        ['text' => $text, 'encoding' => $encoding, 'endCut' => $endCut] = self::toUtf8($bytes);
        $stream = fopen('php://temp', 'r+');
        if ($stream === false) {
            throw new \RuntimeException('Could not read the CSV file');
        }
        fwrite($stream, $text);
        $delimiter = self::delimiter($stream);
        rewind($stream);

        // Match the export's RFC-4180 escaping (fputcsv with '' escape) so export→edit→re-import
        // round-trips symmetrically, and pass the arg explicitly to silence the PHP 8.4 deprecation.
        $first = fgetcsv($stream, 0, $delimiter, '"', '');
        if ($first === false) {
            fclose($stream);
            return null;
        }
        $headers = array_map(static fn (?string $cell): string => self::withoutExportApostrophe((string) $cell), $first);
        $width = count($headers);

        $rows = [];
        while (($row = fgetcsv($stream, 0, $delimiter, '"', '')) !== false) {
            if (self::isBlank($row)) {
                continue;
            }
            $rows[] = array_slice(array_pad(array_map(static fn (?string $cell): string => (string) $cell, $row), $width, ''), 0, $width);
        }
        fclose($stream);

        return ['headers' => $headers, 'rows' => $rows, 'encoding' => $encoding, 'endCut' => $endCut];
    }

    /** @param array<int, string|null> $row An empty line, or one of nothing but spaces. */
    private static function isBlank(array $row): bool
    {
        return count($row) === 1 && trim((string) $row[0]) === '';
    }

    /**
     * The export puts an apostrophe before a cell a spreadsheet would run as a formula
     * (ResponseService::exportResponsesStreaming). This takes that one off, and only that one: an
     * answer that starts with an apostrophe of its own is left alone.
     */
    public static function withoutExportApostrophe(string $cell): string
    {
        return preg_match('/^\'\s*[=+\-@\t\r]/', $cell) === 1 ? substr($cell, 1) : $cell;
    }

    /**
     * The text in UTF-8, and what it was read as. A file with no byte order mark doesn't say what it
     * is, and Excel's plain CSV is in whatever code page that Windows uses. Text that looks like
     * Western European is read as Windows-1252, which Polish, Czech and Turkish can pass for, so
     * the wizard says what was assumed. Anything else is refused: as Windows-1252 it would import
     * as gibberish with a success message.
     *
     * @return array{text: string, encoding: string, endCut: bool}
     */
    private static function toUtf8(string $bytes): array
    {
        if (str_starts_with($bytes, "\xFF\xFE\x00\x00")) {
            throw new CsvEncodingRefused(); // UTF-32, whose mark starts as UTF-16's does
        }
        if (str_starts_with($bytes, "\xFF\xFE")) {
            return ['text' => mb_convert_encoding(substr($bytes, 2), 'UTF-8', 'UTF-16LE'), 'encoding' => 'UTF-16', 'endCut' => false];
        }
        if (str_starts_with($bytes, "\xFE\xFF")) {
            return ['text' => mb_convert_encoding(substr($bytes, 2), 'UTF-8', 'UTF-16BE'), 'encoding' => 'UTF-16', 'endCut' => false];
        }
        // UTF-16 with no mark. NUL is valid UTF-8, so this imported with a NUL in every cell.
        if (str_contains($bytes, "\0")) {
            throw new CsvEncodingRefused();
        }
        if (str_starts_with($bytes, "\xEF\xBB\xBF")) {
            $bytes = substr($bytes, 3); // Excel's "CSV UTF-8", and this site's export
        }
        if (mb_check_encoding($bytes, 'UTF-8')) {
            return ['text' => $bytes, 'encoding' => 'UTF-8', 'endCut' => false];
        }
        // A last character cut in half says nothing about the rest. The start of a character alone
        // does prove nothing, though: that's also a Windows-1252 file ending in é.
        $whole = (string) preg_replace('/(?:[\xC2-\xDF]|[\xE0-\xEF][\x80-\xBF]?|[\xF0-\xF4][\x80-\xBF]{0,2})\z/', '', $bytes);
        if ($whole !== $bytes && mb_check_encoding($whole, 'UTF-8') && preg_match('/[\x80-\xFF]/', $whole) === 1) {
            return ['text' => $whole, 'encoding' => 'UTF-8', 'endCut' => true];
        }
        if (!self::looksWestern($bytes)) {
            throw new CsvEncodingRefused();
        }
        return ['text' => mb_convert_encoding($bytes, 'UTF-8', 'Windows-1252'), 'encoding' => 'Windows-1252', 'endCut' => false];
    }

    /**
     * Whether the non-ASCII bytes sit as Windows-1252 letters do: alone in a Latin word, or two
     * together beside an ASCII letter (Ação). Cyrillic, Greek, Arabic and Hebrew letters are all
     * high bytes, so they run for the length of a word, and most characters of Shift-JIS, GBK,
     * Big5 and EUC-KR are two high bytes in a row. A two-letter word of nothing else (Icelandic
     * þú, Russian Ян) could be either, so it counts for nothing and against too many.
     *
     * A run of four or more is a word of another alphabet, and a few are enough: only real Western
     * text outweighs them. Anything shorter that reads oddly is only odd: one in twenty is let by
     * among the file's plain letters too, so a † in a list of plain names doesn't cost the import.
     * A byte repeated, as –––– is, is a rule and not a word.
     */
    private static function looksWestern(string $bytes): bool
    {
        $western = 0;
        $wholeWordPairs = 0;
        $odd = 0;
        $foreign = 0;
        for ($at = 0; preg_match('/[\x80-\xFF]+/', $bytes, $found, PREG_OFFSET_CAPTURE, $at) === 1; $at = $end) {
            [$piece, $start] = $found[0];
            $end = $start + strlen($piece);
            $before = $start > 0 ? $bytes[$start - 1] : ' ';
            $after = $bytes[$end] ?? ' ';
            if (strlen($piece) > 1 && trim($piece, $piece[0]) === '') {
                continue;
            }
            if (strlen($piece) > 3) {
                $foreign += strlen($piece);
            } elseif (!self::readsAsLatin($piece, $before, $after)) {
                $odd += strlen($piece);
            } elseif (strlen($piece) === 2 && !ctype_alnum($before) && !ctype_alnum($after)) {
                $wholeWordPairs += 2;
            } else {
                $western += strlen($piece);
            }
        }
        $plainLetters = strlen((string) preg_replace('/[^A-Za-z]/', '', $bytes));
        return $foreign * 20 + $wholeWordPairs <= $western && $odd * 20 <= $western + $plainLetters;
    }

    private static function readsAsLatin(string $piece, string $before, string $after): bool
    {
        $run = strlen($piece);
        if ($run > 2 || strcspn($piece, self::NOT_WESTERN) !== $run) {
            return false;
        }
        // A pair that is one UTF-8 character: a UTF-8 file with damage in it, not Western text.
        if ($run === 2 && mb_check_encoding($piece, 'UTF-8')) {
            return false;
        }
        return !(ctype_alpha($before) && ctype_alpha($after) && strcspn($piece, self::NOT_INSIDE_A_WORD) !== $run);
    }

    /**
     * The delimiter that gives the first lines all one width, the widest if several do. The header
     * line alone can't say: a heading can hold a comma. If none does, it is whichever splits that
     * line into the most cells. A tie is a comma.
     *
     * @param resource $stream
     */
    private static function delimiter($stream): string
    {
        $even = [];
        $firstWidths = [];
        foreach ([',', ';', "\t"] as $delimiter) {
            rewind($stream);
            $widths = [];
            while (count($widths) < self::SAMPLE_LINES && ($row = fgetcsv($stream, 0, $delimiter, '"', '')) !== false) {
                if (!self::isBlank($row)) {
                    $widths[] = count($row);
                }
            }
            $firstWidths[$delimiter] = $widths[0] ?? 1;
            if (count(array_unique($widths)) === 1 && $widths[0] > 1) {
                $even[$delimiter] = $widths[0];
            }
        }
        $widths = $even !== [] ? $even : $firstWidths;
        arsort($widths); // stable, so a tie keeps the order above
        return (string) array_key_first($widths);
    }
}

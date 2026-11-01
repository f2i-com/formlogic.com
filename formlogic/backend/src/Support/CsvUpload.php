<?php

declare(strict_types=1);

namespace FormLogic\Support;

/**
 * Reads a CSV as spreadsheets save it. Excel's plain "CSV" is in the Windows code page, and where
 * the comma is the decimal mark it separates cells with semicolons, so neither can be assumed.
 */
final class CsvUpload
{
    /**
     * The file's headings and rows, or null if it has no first line. Cells stay in file order and
     * every row is as long as the headings, so a column is its position: two columns can share a
     * heading (two fields with one label do, in an export).
     *
     * @return array{headers: list<string>, rows: list<list<string>>}|null
     */
    public static function parse(string $bytes): ?array
    {
        $text = self::toUtf8($bytes);
        $delimiter = self::delimiter($text);
        $stream = fopen('php://temp', 'r+');
        if ($stream === false) {
            throw new \RuntimeException('Could not read the CSV file');
        }
        fwrite($stream, $text);
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
            if ($row === [null]) {
                continue; // a blank line
            }
            $rows[] = array_slice(array_pad(array_map(static fn (?string $cell): string => (string) $cell, $row), $width, ''), 0, $width);
        }
        fclose($stream);

        return ['headers' => $headers, 'rows' => $rows];
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

    /** Text that isn't valid UTF-8 is taken to be Windows-1252, what Excel's plain CSV writes. */
    private static function toUtf8(string $bytes): string
    {
        if (str_starts_with($bytes, "\xFF\xFE")) {
            return mb_convert_encoding(substr($bytes, 2), 'UTF-8', 'UTF-16LE');
        }
        if (str_starts_with($bytes, "\xFE\xFF")) {
            return mb_convert_encoding(substr($bytes, 2), 'UTF-8', 'UTF-16BE');
        }
        if (str_starts_with($bytes, "\xEF\xBB\xBF")) {
            $bytes = substr($bytes, 3); // Excel's "CSV UTF-8", and this site's export
        }
        return mb_check_encoding($bytes, 'UTF-8') ? $bytes : mb_convert_encoding($bytes, 'UTF-8', 'Windows-1252');
    }

    /** Whichever of comma, semicolon and tab the header line uses most, outside quotes. A tie is a comma. */
    private static function delimiter(string $text): string
    {
        $counts = [',' => 0, ';' => 0, "\t" => 0];
        $quoted = false;
        for ($i = 0, $length = strlen($text); $i < $length; $i++) {
            $char = $text[$i];
            if ($char === '"') {
                $quoted = !$quoted;
            } elseif (!$quoted && ($char === "\n" || $char === "\r")) {
                break;
            } elseif (!$quoted && isset($counts[$char])) {
                $counts[$char]++;
            }
        }
        arsort($counts); // stable, so a tie keeps the order above
        return (string) array_key_first($counts);
    }
}

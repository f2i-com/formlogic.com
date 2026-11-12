<?php
declare(strict_types=1);
namespace FormLogic\Services;

use PDO;
use RuntimeException;
use InvalidArgumentException;

/** Owner database maintenance. App-specific validation remains in the app's routes. */
final class NativeRecordStore
{
    public function __construct(private PDO $db) {}

    /**
     * Column names that hold a credential or sealed data: never listed, returned, searched,
     * sorted or filtered by, exported, or put in an automation's record preview. The structure
     * view alone names them. One rule in two parts, asked through hidden() and nowhere else, so
     * no reader can apply half of it.
     *
     * HIDDEN_NAMES hides a name that holds one of these anywhere in it. A key's digest is as much
     * a credential as a token's is (PIT FMS keeps operators' access-key digests in key_hash), and
     * so is an API, access or private key, in snake_case or camelCase (apiKey). It hides more
     * than it must (tokens_used): a known annoyance, and the safe way to be wrong.
     *
     * HIDDEN_WORDS hides a name that has one of these as a whole word, in snake_case or camelCase:
     * pin_hash, pinHash and PinHash, and not pinned_at, opinion, hashtag or shipping_address,
     * which matching anywhere in the name would take with them.
     *
     * The SoftN release's record-events.mjs keeps its own copy of an older rule (neither a key's
     * digest nor any of HIDDEN_WORDS) for the events of the app's own writes. It should follow
     * this one in a SoftN release.
     */
    private const HIDDEN_NAMES = '/password|token|secret|code_?hash|key_?hash|api_?key|access_?key|private_?key|challenge|encrypted|sealed/i';
    private const HIDDEN_WORDS = ['hash', 'salt', 'otp', 'pin', 'passcode', 'passphrase', 'credential', 'credentials'];

    /**
     * The data manager's bounds. A page is PAGE rows unless one of PAGE_SIZES is asked for, and
     * starts no further than OFFSET_LIMIT rows in. A search is SEARCH_LENGTH characters at most,
     * beside FILTERS conditions of FILTER_VALUE_LENGTH bytes each. DELETE_MANY records go in one
     * request. An export stops at EXPORT_ROWS rows of a table and EXPORT_BYTES in all, and says so.
     */
    public const PAGE = 50;
    public const PAGE_SIZES = [25, 50, 100, 250];
    public const OFFSET_LIMIT = 100000;
    public const SEARCH_LENGTH = 200;
    public const FILTERS = 8;
    public const FILTER_VALUE_LENGTH = 1000;
    public const DELETE_MANY = 250;
    public const EXPORT_ROWS = 100000;
    public const EXPORT_BYTES = 64 * 1024 * 1024;

    /** How many of a table's columns a list shows, and how many of the rest a row's stamp reads besides. */
    private const SHOWN_COLUMNS = 100;
    private const STAMPED_COLUMNS = 400;
    /**
     * A text's first 400 characters as SQLite's substr() counts them (a byte from 0xC0 up takes
     * the continuation bytes after it; any other byte is one), so a preview cut here is the one
     * substr(x,1,400) gave before lists asked for 401 to learn whether there was more.
     */
    private const PREVIEW = '/^(?:[\xC0-\xFF][\x80-\xBF]*+|[\x00-\xBF]){400}/';
    /** The filter operators that compare a column with a value. `ne` keeps the rows with no value: they are not equal to it either. */
    private const COMPARISONS = ['eq' => '=', 'ne' => 'IS NOT', 'gt' => '>', 'gte' => '>=', 'lt' => '<', 'lte' => '<='];
    private const JSON = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION | JSON_INVALID_UTF8_SUBSTITUTE | JSON_THROW_ON_ERROR;

    private static function quote(string $name): string { return '"' . str_replace('"', '""', $name) . '"'; }

    /**
     * Whether a column of this name is hidden: the whole rule (HIDDEN_NAMES, HIDDEN_WORDS), and
     * the one place it is asked. A name's words end at every character that is not a letter and
     * where camelCase begins the next one (pinHash, PinHash, userPINHash).
     */
    public static function hidden(string $name): bool
    {
        if (preg_match(self::HIDDEN_NAMES, $name)) return true;
        $words = preg_split('/[^a-z]+/', strtolower((string) preg_replace('/(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/', '_', $name)), -1, PREG_SPLIT_NO_EMPTY);
        return (bool) array_intersect($words ?: [], self::HIDDEN_WORDS);
    }


    /** The tables an owner is shown: the app's own, never SQLite's or the host's (their names start `sqlite_` or `_`). */
    public function tables(): array
    {
        return $this->db->query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND substr(name,1,1) != '_' ORDER BY name")->fetchAll(PDO::FETCH_COLUMN);
    }

    public function schema(string $table): array
    {
        if (!in_array($table, $this->tables(), true)) throw new RuntimeException('Table not found', 404);
        $columns = $this->db->query('PRAGMA table_xinfo(' . self::quote($table) . ')')->fetchAll(PDO::FETCH_ASSOC);
        $primary = array_values(array_filter($columns, static fn($c) => $c['pk'] > 0));
        usort($primary, static fn($a, $b) => $a['pk'] <=> $b['pk']);
        $canIdentify = $primary && !array_filter($primary, static fn($c) => self::hidden($c['name']) || str_contains(strtoupper($c['type']), 'BLOB'));
        $sql = $this->db->prepare('SELECT sql FROM sqlite_master WHERE name=?');
        $sql->execute([$table]);
        $primaryIndex = array_filter($this->db->query('PRAGMA index_list(' . self::quote($table) . ')')->fetchAll(PDO::FETCH_ASSOC), static fn($index) => $index['origin'] === 'pk');
        $rowidTable = !$primaryIndex && !preg_match('/WITHOUT\s+ROWID/i', (string) $sql->fetchColumn());
        $fields = [];
        foreach ($columns as $c) {
            if (self::hidden($c['name'])) continue;
            $type = strtoupper($c['type']);
            $fields[] = ['name' => $c['name'], 'type' => $type, 'primary' => (bool) $c['pk'],
                'required' => (bool) $c['notnull'], 'defaultValue' => $c['dflt_value'],
                'auto' => $rowidTable && count($primary) === 1 && $c['pk'] > 0 && $type === 'INTEGER',
                'readOnly' => $c['hidden'] > 0 || str_contains($type, 'BLOB')];
        }
        return ['fields' => $fields, 'primaryKey' => $canIdentify ? array_column($primary, 'name') : [],
            'canCreate' => !array_filter($columns, static fn($c) => (self::hidden($c['name']) || str_contains(strtoupper($c['type']), 'BLOB')) && $c['notnull'] && $c['dflt_value'] === null)];
    }

    /**
     * A table's columns as a list reads them (PRAGMA table_info, so no generated column), and the
     * names of the ones it shows: the first SHOWN_COLUMNS that are not hidden. Sorting, searching
     * and filtering take these names and no others.
     *
     * @return array{0: list<array<string, mixed>>, 1: list<string>}
     */
    private function layout(string $table): array
    {
        $columns = $this->db->query('PRAGMA table_info(' . self::quote($table) . ')')->fetchAll(PDO::FETCH_ASSOC);
        return [$columns, array_slice(array_values(array_filter(array_column($columns, 'name'), static fn($name) => !self::hidden($name))), 0, self::SHOWN_COLUMNS)];
    }

    /**
     * Rows in the order of the table's primary key (its rowid without one), after the column a
     * caller sorts by, so rows that tie on that column keep one order from page to page.
     * By the TABLE's columns (t."id"), never an output alias: an ORDER BY on a bare name that a
     * result column also carries sorts by that result (a preview, a key cast to text) and puts
     * the keys out of step with the rows.
     */
    private static function order(array $columns, ?array $sort): string
    {
        $primary = array_values(array_filter($columns, static fn($column) => $column['pk'] > 0));
        usort($primary, static fn($a, $b) => $a['pk'] <=> $b['pk']);
        $order = $primary ? implode(',', array_map(static fn($column) => 't.' . self::quote($column['name']), $primary)) : 't.rowid';
        return $sort ? 't.' . self::quote($sort['column']) . ($sort['dir'] === 'desc' ? ' DESC,' : ' ASC,') . $order : $order;
    }

    /**
     * Whether a column of this declared type gives a comparison no affinity (SQLite: no type, a
     * BLOB, or a STRICT table's ANY). Such a column keeps a number as a number and a text as a
     * text, and a text never equals a number: conditions() compares a number with it as one.
     */
    private static function typeless(string $type): bool
    {
        $type = strtoupper($type);
        return $type === '' || $type === 'ANY' || (str_contains($type, 'BLOB') && !preg_match('/INT|CHAR|CLOB|TEXT/', $type));
    }

    /**
     * What a list or an export was asked for (`sort`, `dir`, `q`, `filter`), as SQL over the
     * table's SHOWN columns: a hidden column, or one past those a list shows, is refused as a
     * column that does not exist is, so nothing here can order by, match or test a value that is
     * never shown. Names are the table's own, quoted; every value is bound. `q` finds rows where
     * any shown value that is not binary contains it (LIKE: ASCII letters in either case), with
     * `%`, `_` and the escape character itself taken literally.
     *
     * @return array{0: string, 1: list<string>, 2: array{column: string, dir: string}|null} the WHERE clause (or none), its values, the sort applied
     */
    private static function conditions(array $columns, array $visible, array $options): array
    {
        $sort = null;
        if (($options['sort'] ?? '') !== '') {
            if (!is_string($options['sort']) || !in_array($options['sort'], $visible, true)) throw new InvalidArgumentException('Unknown column');
            $sort = ['column' => $options['sort'], 'dir' => ($options['dir'] ?? null) === 'desc' ? 'desc' : 'asc'];
        }
        $like = static fn(string $text): string => strtr($text, ['\\' => '\\\\', '%' => '\\%', '_' => '\\_']);
        $terms = $bound = [];
        $q = $options['q'] ?? '';
        if (!is_string($q)) throw new InvalidArgumentException('The search must be text.');
        if ($q !== '') {
            if (mb_strlen($q, 'UTF-8') > self::SEARCH_LENGTH) throw new InvalidArgumentException('The search can be at most ' . self::SEARCH_LENGTH . ' characters.');
            $any = [];
            foreach ($visible as $name) {
                $any[] = "(typeof(t." . self::quote($name) . ") != 'blob' AND t." . self::quote($name) . " LIKE ? ESCAPE '\\')";
                $bound[] = '%' . $like($q) . '%';
            }
            $terms[] = $any ? '(' . implode(' OR ', $any) . ')' : '0';
        }
        $filter = $options['filter'] ?? [];
        if ($filter === '') $filter = [];
        if (is_string($filter)) {
            $filter = json_decode($filter, true, 8);
            if (json_last_error() !== JSON_ERROR_NONE) throw new InvalidArgumentException('The filter is not valid JSON.');
        }
        if (!is_array($filter) || !array_is_list($filter) || count($filter) > self::FILTERS) throw new InvalidArgumentException('The filter must be a list of at most ' . self::FILTERS . ' conditions.');
        $types = array_column($columns, 'type', 'name');
        foreach ($filter as $index => $condition) {
            $which = 'Filter ' . ($index + 1);
            if (!is_array($condition) || !is_string($condition['column'] ?? null) || !in_array($condition['column'], $visible, true)) throw new InvalidArgumentException($which . ' names an unknown column.');
            $column = 't.' . self::quote($condition['column']);
            $op = $condition['op'] ?? null;
            if ($op === 'empty') { $terms[] = "($column IS NULL OR $column = '')"; continue; }
            if ($op === 'notEmpty') { $terms[] = "($column IS NOT NULL AND $column != '')"; continue; }
            if (!is_string($op) || !in_array($op, ['contains', 'starts', ...array_keys(self::COMPARISONS)], true)) throw new InvalidArgumentException($which . ' has an unknown op.');
            $value = $condition['value'] ?? null;
            if (is_int($value) || is_float($value)) $value = (string) $value;
            if (!is_string($value)) throw new InvalidArgumentException($which . ' needs a value.');
            if (strlen($value) > self::FILTER_VALUE_LENGTH) throw new InvalidArgumentException($which . ' has a value longer than ' . self::FILTER_VALUE_LENGTH . ' bytes.');
            if ($op === 'contains' || $op === 'starts') {
                $terms[] = "(typeof($column) != 'blob' AND $column LIKE ? ESCAPE '\\')";
                $bound[] = ($op === 'contains' ? '%' : '') . $like($value) . '%';
                continue;
            }
            // Compared as the column compares: its affinity reads the text as a number where the
            // column holds numbers. A column with no type has no affinity to do that, so a value
            // that is a number is given one.
            $terms[] = $column . ' ' . self::COMPARISONS[$op] . (self::typeless((string) ($types[$condition['column']] ?? '')) && is_numeric($value) ? ' CAST(? AS NUMERIC)' : ' ?');
            $bound[] = $value;
        }
        return [$terms ? ' WHERE ' . implode(' AND ', $terms) : '', $bound, $sort];
    }

    /**
     * The columns a row's stamp reads: the shown ones, then the rest, hidden ones among them
     * (their previews go into the hash and nowhere else). Bounded, because SQLite gives one query
     * 2,000 result columns and a list selects two for each of these and one for each key column.
     *
     * @return list<string>
     */
    private static function stamped(array $columns, array $visible, array $keyNames): array
    {
        $rest = array_values(array_diff(array_column($columns, 'name'), $visible));
        return [...$visible, ...array_slice($rest, 0, max(0, min(self::STAMPED_COLUMNS, intdiv(1900 - count($keyNames) - 2 * count($visible), 2))))];
    }

    /**
     * One stamped column in a list query: its preview (a text's first 401 characters, which tell
     * whether 400 cut it; a binary value's length, never its bytes; anything else whole), then its
     * storage class.
     */
    private static function preview(string $name): string
    {
        $column = 't.' . self::quote($name);
        return "CASE typeof($column) WHEN 'blob' THEN length($column) WHEN 'text' THEN substr($column,1,401) ELSE $column END,typeof($column)";
    }

    /**
     * What a list shows of one row, from the pairs preview() selected for $count columns: each
     * value as it is shown, which texts were cut to their first 400 characters, and the row's
     * stamp. The stamp is a SHA-256 over every pair, so it changes whenever anything a list
     * shows of the row does, and the hidden columns' previews in it cannot be read back out.
     *
     * @return array{0: list<mixed>, 1: array<int, true>, 2: string}
     */
    private static function previews(string $table, array $values, int $count): array
    {
        $shown = $cut = [];
        $parts = [$table];
        for ($i = 0; $i < $count; $i++) {
            [$value, $type] = [$values[2 * $i], $values[2 * $i + 1]];
            if ($type === 'text' && strlen($value) > 400 && preg_match(self::PREVIEW, $value, $match) && strlen($match[0]) < strlen($value)) {
                $value = $match[0];
                $cut[$i] = true;
            }
            $parts[] = $type;
            $parts[] = $value;
            $shown[] = $type === 'blob' ? '[binary]' : $value;
        }
        return [$shown, $cut, hash('sha256', serialize($parts))];
    }

    /**
     * One page of a table. `limit` is a page size (PAGE_SIZES, else PAGE); `sort`, `dir`, `q` and
     * `filter` are conditions()'s. Beside what a page always carried it says how many rows the
     * table has (`total`) and how many pass the search and filters (`matching`), both counted
     * exactly; a `stamp` for each row that has a usable key (deleteMany's proof that the row is
     * still the one listed); which texts were `cut` to their preview; the `sort` applied; and how
     * many of the table's columns are never shown (`hiddenColumns`).
     */
    public function browse(string $table, int $offset = 0, array $options = []): array
    {
        $tables = $this->tables();
        if (!in_array($table, $tables, true)) throw new RuntimeException('Table not found', 404);
        $quoted = self::quote($table);
        [$columns, $visible] = $this->layout($table);
        [$where, $bound, $sort] = self::conditions($columns, $visible, $options);
        $limit = in_array($options['limit'] ?? null, self::PAGE_SIZES, true) ? $options['limit'] : self::PAGE;
        // Paging contract (FL-S06): the response says which offset it actually used and why it
        // stops. A requested offset past the window is clamped to it and reported, never
        // silently repeated under a new page number: `end` is 'more' (a next page exists inside
        // the window), 'limit' (rows exist beyond the window; the browser is bounded) or 'end'.
        $effective = min(self::OFFSET_LIMIT, max(0, $offset));
        $paging = ['offset' => $effective, 'limit' => $limit, 'offsetLimit' => self::OFFSET_LIMIT];
        $total = $matching = (int) $this->db->query('SELECT COUNT(*) FROM ' . $quoted)->fetchColumn();
        if ($where !== '') {
            $count = $this->db->prepare('SELECT COUNT(*) FROM ' . $quoted . ' AS t' . $where);
            $count->execute($bound);
            $matching = (int) $count->fetchColumn();
        }
        $counts = ['total' => $total, 'matching' => $matching, 'sort' => $sort,
            'hiddenColumns' => count(array_filter(array_column($this->db->query('PRAGMA table_xinfo(' . $quoted . ')')->fetchAll(PDO::FETCH_ASSOC), 'name'), self::hidden(...)))];
        if (!$visible) return ['tables' => $tables, 'columns' => [], 'rows' => [], 'hasMore' => false, 'end' => 'end'] + $paging + $counts + ['stamps' => [], 'cut' => new \stdClass()];
        $schema = $this->schema($table);
        $keyNames = $schema['primaryKey'];
        // One query gives the previews, the stamps' other columns and the keys, so the three are
        // of the same rows whatever the order. Result columns carry no names: see order().
        $stamped = $keyNames ? self::stamped($columns, $visible, $keyNames) : $visible;
        $select = [...array_map(self::preview(...), $stamped), ...array_map(static fn($name) => 'CAST(t.' . self::quote($name) . ' AS TEXT)', $keyNames)];
        $statement = $this->db->prepare('SELECT ' . implode(',', $select) . ' FROM ' . $quoted . ' AS t' . $where . ' ORDER BY ' . self::order($columns, $sort) . ' LIMIT ' . ($limit + 1) . ' OFFSET ' . $effective);
        $statement->execute($bound);
        $found = $statement->fetchAll(PDO::FETCH_NUM);
        $more = count($found) > $limit;
        $end = !$more ? 'end' : ($effective + $limit > self::OFFSET_LIMIT ? 'limit' : 'more');
        $rows = $keys = $stamps = $cut = [];
        foreach (array_slice($found, 0, $limit) as $index => $values) {
            [$shown, $clipped, $stamp] = self::previews($table, $values, count($stamped));
            $row = [];
            foreach ($visible as $i => $name) {
                $value = $shown[$i];
                if (is_string($value) && strlen($value) > 4000) { $value = mb_strcut($value, 0, 4000) . '…'; $clipped[$i] = true; }
                $row[$name] = $value;
                if (isset($clipped[$i])) $cut[$index][] = $name;
            }
            $rows[] = $row;
            $key = null;
            if ($keyNames) {
                $key = array_combine($keyNames, array_slice($values, 2 * count($stamped)));
                $keys[] = $key = in_array(null, $key, true) ? null : $key;
            }
            $stamps[] = $key === null ? null : $stamp;
        }
        // `cut` is an object in JSON whichever rows it names (row 0 alone would make it a list).
        return ['tables' => $tables, 'columns' => $visible, 'rows' => $rows, 'hasMore' => $end === 'more', 'end' => $end, 'schema' => $schema, 'keys' => $keys] + $paging + $counts + ['stamps' => $stamps, 'cut' => (object) $cut];
    }

    /**
     * The shown tables with their exact row counts and how many columns a list shows of each, and
     * how many tables are not listed at all.
     *
     * @return array{tables: list<array{name: string, rows: int, columns: int}>, hiddenTables: int}
     */
    public function overview(): array
    {
        $tables = [];
        foreach ($this->tables() as $name) {
            $tables[] = ['name' => $name, 'rows' => (int) $this->db->query('SELECT COUNT(*) FROM ' . self::quote($name))->fetchColumn(), 'columns' => count($this->layout($name)[1])];
        }
        return ['tables' => $tables, 'hiddenTables' => (int) $this->db->query("SELECT COUNT(*) FROM sqlite_master WHERE type='table'")->fetchColumn() - count($tables)];
    }

    /**
     * How a table is made: every column (a hidden one by name and type, flagged, with no default:
     * a default is a value of it), its indexes, the foreign keys it holds and the shown tables
     * whose foreign keys point at it.
     */
    public function structure(string $table): array
    {
        $tables = $this->tables();
        if (!in_array($table, $tables, true)) throw new RuntimeException('Table not found', 404);
        $quoted = self::quote($table);
        $columns = [];
        foreach ($this->db->query('PRAGMA table_xinfo(' . $quoted . ')')->fetchAll(PDO::FETCH_ASSOC) as $c) {
            $hidden = self::hidden($c['name']);
            $columns[] = ['name' => $c['name'], 'type' => strtoupper($c['type']), 'notNull' => (bool) $c['notnull'], 'defaultValue' => $hidden ? null : $c['dflt_value'],
                'primaryKey' => (int) $c['pk'], 'hidden' => $hidden, 'generated' => in_array((int) $c['hidden'], [2, 3], true)];
        }
        $indexes = [];
        foreach ($this->db->query('PRAGMA index_list(' . $quoted . ')')->fetchAll(PDO::FETCH_ASSOC) as $index) {
            // An indexed expression has no column name to give.
            $indexes[] = ['name' => $index['name'], 'unique' => (bool) $index['unique'], 'origin' => $index['origin'],
                'columns' => array_map(static fn($name) => $name ?? '(expression)', $this->db->query('PRAGMA index_info(' . self::quote($index['name']) . ')')->fetchAll(PDO::FETCH_COLUMN, 2))];
        }
        $referencedBy = [];
        foreach ($tables as $other) {
            if ($other === $table) continue;
            foreach ($this->foreignKeys($other) as $key) if (strcasecmp($key['table'], $table) === 0) $referencedBy[] = ['table' => $other, 'columns' => $key['columns'], 'to' => $key['to']];
        }
        return ['table' => $table, 'rows' => (int) $this->db->query('SELECT COUNT(*) FROM ' . $quoted)->fetchColumn(), 'columns' => $columns, 'indexes' => $indexes,
            'foreignKeys' => $this->foreignKeys($table), 'referencedBy' => $referencedBy];
    }

    /**
     * A table's foreign keys, one entry for each with its columns in order. One that names no
     * column of its parent points at the parent's primary key, which is what `to` then says.
     *
     * @return list<array{columns: list<string>, table: string, to: list<string>, onUpdate: string, onDelete: string}>
     */
    private function foreignKeys(string $table): array
    {
        $keys = [];
        foreach ($this->db->query('PRAGMA foreign_key_list(' . self::quote($table) . ')')->fetchAll(PDO::FETCH_ASSOC) as $part) {
            $keys[$part['id']] ??= ['columns' => [], 'table' => $part['table'], 'to' => [], 'onUpdate' => $part['on_update'], 'onDelete' => $part['on_delete']];
            $keys[$part['id']]['columns'][(int) $part['seq']] = $part['from'];
            $keys[$part['id']]['to'][(int) $part['seq']] = $part['to'];
        }
        ksort($keys);
        foreach ($keys as &$key) {
            ksort($key['columns']);
            ksort($key['to']);
            $key['columns'] = array_values($key['columns']);
            if (in_array(null, $key['to'], true)) {
                $parent = array_filter($this->db->query('PRAGMA table_xinfo(' . self::quote($key['table']) . ')')->fetchAll(PDO::FETCH_ASSOC), static fn($c) => $c['pk'] > 0);
                usort($parent, static fn($a, $b) => $a['pk'] <=> $b['pk']);
                $key['to'] = array_column($parent, 'name');
            } else $key['to'] = array_values($key['to']);
        }
        unset($key);
        return array_values($keys);
    }

    /**
     * A table as a file written to $out, or every shown table with no table named (JSON alone):
     * every column that is not hidden, its text whole, a binary value left out (an empty cell,
     * `null`). One table takes the search, filters and sort a list takes. It stops at $maxRows
     * rows of a table and $maxBytes in all, always at the end of a row and as a file that still
     * reads, and returns whether either limit cut it short.
     *
     * CSV is UTF-8 behind a byte order mark, quoted as RFC 4180 says, the column names first. JSON
     * is `[{…}]` for a table and `{"tables":{"name":[{…}]}}` for them all.
     *
     * @param resource $out
     */
    public function export($out, ?string $table, string $format, array $options = [], int $maxRows = self::EXPORT_ROWS, int $maxBytes = self::EXPORT_BYTES): bool
    {
        if ($format !== 'csv' && $format !== 'json') throw new InvalidArgumentException('Export as csv or json.');
        $tables = $this->tables();
        $room = $maxBytes;
        if ($table !== null) {
            if (!in_array($table, $tables, true)) throw new RuntimeException('Table not found', 404);
            return $this->exportTable($out, $room, $table, $format, $options, $maxRows, $format === 'json' ? 1 : 0);
        }
        if ($format !== 'json') throw new InvalidArgumentException('Every table at once is exported as json.');
        // A search or a sort names one table's columns. Leaving them out here would hand over
        // every row where the caller asked for some.
        foreach (['q', 'filter', 'sort'] as $name) if (!in_array($options[$name] ?? '', ['', '[]', []], true)) throw new InvalidArgumentException('A search, filters and a sort are for one table: export every table without them.');
        $cut = false;
        self::put($out, '{"tables":{', $room);
        foreach ($tables as $index => $name) {
            $label = ($index ? ',' : '') . json_encode((string) $name, self::JSON) . ':';
            // Room for the table's name, its two brackets and the two that close the file, or it is left out.
            if (strlen($label) + 4 > $room) { $cut = true; break; }
            self::put($out, $label, $room);
            $cut = $this->exportTable($out, $room, $name, 'json', [], $maxRows, 3) || $cut;
        }
        self::put($out, '}}', $room);
        return $cut;
    }

    /** @param resource $out */
    private static function put($out, string $bytes, int &$room): void
    {
        if (fwrite($out, $bytes) !== strlen($bytes)) throw new RuntimeException('The export could not be written');
        $room -= strlen($bytes);
    }

    /**
     * One table of an export. A row that would pass either limit is where it stops; $closing
     * bytes of the room are kept for the brackets that end a JSON file after its last row.
     *
     * @param resource $out
     */
    private function exportTable($out, int &$room, string $table, string $format, array $options, int $maxRows, int $closing): bool
    {
        [$columns, $visible] = $this->layout($table);
        [$where, $bound, $sort] = self::conditions($columns, $visible, $options);
        // Every column that is not hidden, past the SHOWN_COLUMNS a list stops at: a file has room for them.
        $names = array_values(array_filter(array_column($columns, 'name'), static fn($name) => !self::hidden($name)));
        self::put($out, $format === 'csv' ? "\xEF\xBB\xBF" . self::csvLine($names) : '[', $room);
        $cut = false;
        if ($names) {
            $labels = array_map(static fn($name) => json_encode((string) $name, self::JSON) . ':', $names);
            $select = implode(',', array_map(static fn($name) => 'CASE WHEN typeof(t.' . self::quote($name) . ")='blob' THEN NULL ELSE t." . self::quote($name) . ' END', $names));
            $statement = $this->db->prepare('SELECT ' . $select . ' FROM ' . self::quote($table) . ' AS t' . $where . ' ORDER BY ' . self::order($columns, $sort) . ' LIMIT ' . ($maxRows + 1));
            $statement->execute($bound);
            for ($count = 0; ($values = $statement->fetch(PDO::FETCH_NUM)) !== false; $count++) {
                $line = $format === 'csv' ? self::csvLine($values) : ($count ? ',' : '') . self::jsonRow($labels, $values);
                if ($count === $maxRows || strlen($line) + $closing > $room) { $cut = true; break; }
                self::put($out, $line, $room);
            }
            $statement->closeCursor();
        }
        if ($format === 'json') self::put($out, ']', $room);
        return $cut;
    }

    /**
     * One CSV record as RFC 4180 writes it: a field holding a quote, a comma or a line break is
     * quoted and its quotes doubled, NULL is an empty field, CRLF ends the record. A text a
     * spreadsheet would run as a formula gets the apostrophe the responses export puts before one
     * (ResponseService::exportResponsesStreaming): these are values an app's visitors typed, and
     * the owner opens the file. A number is written as it is.
     */
    private static function csvLine(array $cells): string
    {
        foreach ($cells as &$cell) {
            if ($cell === null) $cell = '';
            elseif (is_float($cell)) $cell = is_finite($cell) ? json_encode($cell, self::JSON) : (string) $cell;
            elseif (!is_string($cell)) $cell = (string) $cell;
            else {
                if (!mb_check_encoding($cell, 'UTF-8')) $cell = mb_scrub($cell, 'UTF-8');
                if (preg_match('/^\s*[=+\-@\t\r]/', $cell)) $cell = "'" . $cell;
                if (strpbrk($cell, "\",\r\n") !== false) $cell = '"' . str_replace('"', '""', $cell) . '"';
            }
        }
        unset($cell);
        return implode(',', $cells) . "\r\n";
    }

    /**
     * One row as a JSON object under its columns' names ($labels, each encoded with its colon):
     * written by hand so columns named 0, 1, 2 still make an object. A number JSON has no way to
     * write (an infinity) is null.
     */
    private static function jsonRow(array $labels, array $values): string
    {
        $pairs = [];
        foreach ($labels as $i => $label) $pairs[] = $label . json_encode(is_float($values[$i]) && !is_finite($values[$i]) ? null : $values[$i], self::JSON);
        return '{' . implode(',', $pairs) . '}';
    }

    /**
     * The WHERE that names one record by its primary key, and the key's values for it.
     *
     * @return array{0: string, 1: list<scalar>}
     */
    private static function locate(array $schema, mixed $key): array
    {
        $names = $schema['primaryKey'];
        if (!$names || !is_array($key) || count($key) !== count($names)) throw new InvalidArgumentException('A complete primary key is required to edit this record.');
        foreach ($names as $name) if (!isset($key[$name]) || !is_scalar($key[$name])) throw new InvalidArgumentException('A complete primary key is required to edit this record.');
        return [implode(' AND ', array_map(static fn($name) => self::quote($name) . ' = ?', $names)), array_map(static fn($name) => $key[$name], $names)];
    }

    private function find(string $table, array $schema, mixed $key): array
    {
        [$where, $values] = self::locate($schema, $key);
        $stmt = $this->db->prepare('SELECT * FROM ' . self::quote($table) . ' WHERE ' . $where . ' LIMIT 2');
        $stmt->execute($values);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        if (count($rows) !== 1) throw new RuntimeException('This record no longer exists. Refresh the records.', 409);
        return [$rows[0], $where, $values];
    }

    private function revision(array $row): string { return hash('sha256', serialize($row)); }

    public function operate(array $input, array $subscriptions = []): array
    {
        $table = $input['table'] ?? null;
        $action = $input['action'] ?? null;
        if (!is_string($table) || !in_array($action, ['read', 'create', 'update', 'delete', 'deleteMany'], true)) throw new InvalidArgumentException('Choose a table and record action.');
        $schema = $this->schema($table);
        if ($action === 'deleteMany') {
            // Refused for its shape before the database is asked for its write lock.
            $rows = $input['rows'] ?? null;
            if (!is_array($rows) || !array_is_list($rows) || !$rows || count($rows) > self::DELETE_MANY) throw new InvalidArgumentException('Choose between 1 and ' . self::DELETE_MANY . ' records to delete.');
            foreach ($rows as $row) {
                if (!is_array($row) || !is_string($row['stamp'] ?? null)) throw new InvalidArgumentException('Each record to delete needs its key and the stamp its list gave it.');
                self::locate($schema, $row['key'] ?? null);
            }
        }
        $this->db->exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1500');
        $began = false;
        try {
            $this->db->exec($action === 'read' ? 'BEGIN' : 'BEGIN IMMEDIATE');
            $began = true;
            if ($action === 'deleteMany') {
                $result = $this->deleteMany($table, $schema, $input['rows'], $subscriptions);
                $this->db->exec('COMMIT');
                return $result;
            }
            if ($action !== 'create') {
                [$row, $where, $keys] = $this->find($table, $schema, $input['key'] ?? null);
                $types = $this->db->prepare('SELECT ' . implode(',', array_map(static fn($field) => 'typeof(' . self::quote($field['name']) . ') AS ' . self::quote($field['name']), $schema['fields'])) . ' FROM ' . self::quote($table) . ' WHERE ' . $where);
                $types->execute($keys);
                $storageTypes = $types->fetch(PDO::FETCH_ASSOC);
                foreach ($schema['fields'] as &$field) if (($storageTypes[$field['name']] ?? '') === 'blob') $field['readOnly'] = true;
                unset($field);
                if ($action === 'read') {
                    $values = [];
                    foreach ($schema['fields'] as &$field) {
                        $value = $row[$field['name']];
                        // Never turn a preview or a binary value into editable source.
                        if ($field['readOnly'] || (is_string($value) && (strlen($value) > 100000 || !mb_check_encoding($value, 'UTF-8')))) { $field['readOnly'] = true; continue; }
                        $values[$field['name']] = $value === null ? null : (is_float($value) ? json_encode($value, JSON_THROW_ON_ERROR | JSON_PRESERVE_ZERO_FRACTION) : (string) $value);
                    }
                    unset($field);
                    $result = ['record' => ['values' => (object) $values, 'revision' => $this->revision($row), 'fields' => $schema['fields']]];
                } elseif (!is_string($input['revision'] ?? null) || !hash_equals($this->revision($row), $input['revision'])) {
                    throw new RuntimeException('This record changed since you opened it. Close the editor and refresh before trying again.', 409);
                }
            }
            if ($action !== 'read') {
                $this->captureEvents($subscriptions);
                if ($action === 'delete') {
                    $stmt = $this->db->prepare('DELETE FROM ' . self::quote($table) . ' WHERE ' . $where);
                    $stmt->execute($keys);
                } else {
                    if ($action === 'create' && !$schema['canCreate']) throw new InvalidArgumentException('This table requires private or binary fields. Create records through the app instead.');
                    $values = $input['values'] ?? null;
                    if (!is_array($values) || count($values) > 100) throw new InvalidArgumentException('Provide record field values.');
                    $fields = array_column($schema['fields'], null, 'name');
                    foreach ($values as $name => $value) {
                        $field = $fields[$name] ?? null;
                        if (!$field || $field['readOnly'] || ($action === 'update' && $field['primary'])) throw new InvalidArgumentException('This field cannot be edited: ' . $name);
                        if ($value !== null && (!is_scalar($value) || strlen((string) $value) > 100000)) throw new InvalidArgumentException('Field values must be text, numbers, or null (up to 100 KB).');
                        if ($value === null && $field['required']) throw new InvalidArgumentException($name . ' is required.');
                        if ($value !== null && str_contains($field['type'], 'INT') && !preg_match('/^-?\d+$/D', (string) $value)) throw new InvalidArgumentException($name . ' must be a whole number.');
                        if ($value !== null && str_contains($field['type'], 'INT')) {
                            $digits = ltrim(ltrim((string) $value, '-'), '0') ?: '0';
                            $limit = str_starts_with((string) $value, '-') ? '9223372036854775808' : '9223372036854775807';
                            if (strlen($digits) > 19 || (strlen($digits) === 19 && strcmp($digits, $limit) > 0)) throw new InvalidArgumentException($name . ' is outside the SQLite integer range.');
                        }
                        if ($value !== null && preg_match('/REAL|FLOA|DOUB|NUMERIC|DECIMAL/', $field['type']) && (!is_numeric($value) || !is_finite((float) $value))) throw new InvalidArgumentException($name . ' must be a number.');
                    }
                    if ($action === 'create') {
                        $sql = $values ? 'INSERT INTO ' . self::quote($table) . ' (' . implode(',', array_map(self::quote(...), array_keys($values))) . ') VALUES (' . implode(',', array_fill(0, count($values), '?')) . ')' : 'INSERT INTO ' . self::quote($table) . ' DEFAULT VALUES';
                        $params = array_values($values);
                    } else {
                        if (!$values) throw new InvalidArgumentException('Change at least one field before saving.');
                        $sql = 'UPDATE ' . self::quote($table) . ' SET ' . implode(',', array_map(static fn($name) => self::quote($name) . ' = ?', array_keys($values))) . ' WHERE ' . $where;
                        $params = [...array_values($values), ...$keys];
                    }
                    $stmt = $this->db->prepare($sql);
                    foreach ($params as $i => $value) $stmt->bindValue($i + 1, $value, $value === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
                    $stmt->execute();
                }
                $result = ['saved' => true];
            }
            $this->db->exec('COMMIT');
            return $result;
        } catch (\Throwable $error) {
            if ($began) $this->db->exec('ROLLBACK');
            if ($error instanceof \PDOException) {
                if (($error->errorInfo[1] ?? 0) === 19) throw new RuntimeException('The database rejected this change. Check required fields, unique values, references, and table rules.', 422);
                if (in_array($error->errorInfo[1] ?? 0, [5, 6], true)) throw new RuntimeException('The database is busy. Please try again.', 409);
            }
            throw $error;
        }
    }

    /**
     * Several records deleted inside the caller's transaction, all or none. Each is named by its
     * key and carries the stamp a list gave it (browse()): a record that is gone, or whose stamp
     * is no longer the row's, refuses them all, as a stale revision refuses one delete. The same
     * record named twice is one record. The automations' triggers are set before the first row
     * goes, as for one delete, so each deletion (and what it cascades to) is an event.
     *
     * @param list<array{key: mixed, stamp: string}> $rows as operate() has checked them
     */
    private function deleteMany(string $table, array $schema, array $rows, array $subscriptions): array
    {
        [$columns, $visible] = $this->layout($table);
        $stamped = self::stamped($columns, $visible, $schema['primaryKey']);
        $select = [...array_map(self::preview(...), $stamped), ...array_map(static fn($name) => 'CAST(t.' . self::quote($name) . ' AS TEXT)', $schema['primaryKey'])];
        $where = self::locate($schema, $rows[0]['key'])[0];
        $look = $this->db->prepare('SELECT ' . implode(',', $select) . ' FROM ' . self::quote($table) . ' AS t WHERE ' . $where . ' LIMIT 2');
        $targets = [];
        $stale = 0;
        foreach ($rows as $row) {
            $keys = self::locate($schema, $row['key'])[1];
            $look->execute($keys);
            $found = $look->fetchAll(PDO::FETCH_NUM);
            if (count($found) !== 1 || !hash_equals(self::previews($table, $found[0], count($stamped))[2], $row['stamp'])) { $stale++; continue; }
            // Under the key the database gives the row, so two spellings of one key ('7', '07') are one target.
            $targets[serialize(array_slice($found[0], 2 * count($stamped)))] = $keys;
        }
        if ($stale) throw new RuntimeException(($stale === 1 ? '1 record has' : $stale . ' records have') . ' changed or gone since the list was loaded, so nothing was deleted. Refresh the records and try again.', 409);
        $this->captureEvents($subscriptions);
        $delete = $this->db->prepare('DELETE FROM ' . self::quote($table) . ' WHERE ' . $where);
        foreach ($targets as $keys) $delete->execute($keys);
        return ['saved' => true, 'deleted' => count($targets)];
    }

    /** Same durable, redacted event contract as the ZIPP host, including cascaded writes. */
    private function captureEvents(array $subscriptions): void
    {
        if (!$subscriptions) return;
        $this->db->exec('CREATE TABLE IF NOT EXISTS _formlogic_record_events(id TEXT PRIMARY KEY,event_name TEXT NOT NULL,data_json TEXT NOT NULL,bindings_json TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT');
        $tables = $this->db->query("SELECT name FROM sqlite_master WHERE type='table'")->fetchAll(PDO::FETCH_COLUMN);
        foreach ($subscriptions as $index => $subscription) {
            if (!preg_match('/^app\.record\.(created|updated|deleted)\.([A-Za-z][A-Za-z0-9_]{0,62})$/D', $subscription['event'] ?? '', $match) || !in_array($match[2], $tables, true) || empty($subscription['bindings'])) continue;
            [, $operation, $table] = $match;
            $fields = $this->schema($table)['fields'];
            usort($fields, static fn($a, $b) => $b['primary'] <=> $a['primary']);
            $pairs = [];
            foreach (array_slice($fields, 0, 40) as $field) {
                $value = ($operation === 'deleted' ? 'OLD.' : 'NEW.') . self::quote($field['name']);
                $pairs[] = $this->db->quote($field['name']);
                $pairs[] = "CASE WHEN typeof($value)='blob' THEN NULL WHEN typeof($value)='text' THEN substr($value,1,400) ELSE $value END";
            }
            $event = $this->db->quote($subscription['event']);
            $bindings = $this->db->quote(json_encode($subscription['bindings'], JSON_THROW_ON_ERROR));
            $action = ['created' => 'INSERT', 'updated' => 'UPDATE', 'deleted' => 'DELETE'][$operation];
            $this->db->exec('CREATE TEMP TRIGGER ' . self::quote('_formlogic_admin_capture_' . $index) . ' AFTER ' . $action . ' ON ' . self::quote($table) . " BEGIN
                SELECT CASE WHEN (SELECT count(*) FROM _formlogic_record_events)>=10000 THEN RAISE(ABORT,'Record automation queue is full') END;
                INSERT INTO _formlogic_record_events VALUES(lower(hex(randomblob(16))),$event,json_object('table'," . $this->db->quote($table) . ",'operation'," . $this->db->quote($operation) . ",'record',json_object(" . implode(',', $pairs) . "),'recordPreview',json('true')),$bindings,unixepoch()); END");
        }
    }
}

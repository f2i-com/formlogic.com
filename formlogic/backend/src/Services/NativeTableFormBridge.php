<?php

declare(strict_types=1);

namespace FormLogic\Services;

use PDO;

/**
 * Bridges FormLogic Forms (`forms.settings.nativeTableBinding`) directly to a hosted SoftN or
 * container app's live SQLite table so FormLogic forms, responses tables, CRUD screens, reports,
 * charts, and external APIs operate directly on the app's real SQLite records.
 *
 * Security invariants:
 *  - The form's owner (`forms.user_id`) MUST match the target app's owner (`apps.owner_id`).
 *  - Every bound column is validated against `NativeRecordStore::hidden()` and table schema.
 *  - Private (E2EE) forms cannot bind to a native table.
 *  - All writes flow through `NativeAppService::manageRecord()` and dispatch committed
 *    `app.record.*` events through `NativeRecordEventRouter`. The one exception is a bulk clear:
 *    it goes through `NativeRecordStore::clear()`, under the same guards, and queues no events.
 */
class NativeTableFormBridge
{
    /** The most rows one list gives: what a form's own store gives, and what the routes let a client ask for. */
    private const LIST_LIMIT = 1000;

    /**
     * @param null|\Closure(): ?NativeRecordEventRouter $recordEventsResolver
     */
    public function __construct(
        private PDO $mysql,
        private NativeAppService $native,
        private ?AppService $apps = null,
        private ?FlowService $flows = null,
        private ?NativeRecordEventRouter $recordEvents = null,
        private ?\Closure $recordEventsResolver = null,
    ) {}

    /**
     * Resolve and authorize the `nativeTableBinding` for `$formId`, or return null for ordinary forms.
     *
     * @return array{
     *   formId: string,
     *   ownerId: string,
     *   appId: string,
     *   databaseAppId: string,
     *   table: string,
     *   primaryKey: list<string>,
     *   columns: array<string, string>,
     *   createdAtColumn: ?string,
     *   statusColumn: ?string,
     *   managedByForm: bool
     * }|null
     *
     * `managedByForm`: the table was made for the form, and holds its own records (an app's
     * Unified SQLite database: FormSqliteDatabaseService::syncSingleFormSchema), where any other
     * binding names a table of the app's own.
     */
    public function resolveBinding(string $formId): ?array
    {
        if ($formId === '') return null;
        // Private (E2EE) forms store ciphertext envelopes in their dedicated per-form SQLite
        // store and must never route through a plaintext SoftN native table binding.
        try {
            $encStmt = $this->mysql->prepare('SELECT 1 FROM form_encryption WHERE form_id = :id LIMIT 1');
            $encStmt->execute(['id' => $formId]);
            if ($encStmt->fetchColumn() !== false) {
                return null;
            }
        } catch (\Throwable $e) {
            $msg = strtolower($e->getMessage());
            $missingTable = str_contains($msg, 'no such table')
                || str_contains($msg, "doesn't exist")
                || str_contains($msg, 'base table or view not found');
            if (!$missingTable) {
                return null;
            }
        }
        try {
            $stmt = $this->mysql->prepare('SELECT user_id, settings FROM forms WHERE id = :id LIMIT 1');
            $stmt->execute(['id' => $formId]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
        } catch (\Throwable) {
            return null;
        }
        if (!is_array($row)) return null;
        $settings = is_string($row['settings'] ?? null) ? json_decode($row['settings'], true) : (is_array($row['settings'] ?? null) ? $row['settings'] : null);
        if (!is_array($settings) || !is_array($settings['nativeTableBinding'] ?? null)) {
            return null;
        }
        $raw = $settings['nativeTableBinding'];
        $appId = is_string($raw['appId'] ?? null) ? trim($raw['appId']) : '';
        $table = is_string($raw['table'] ?? null) ? trim($raw['table']) : '';
        $formOwner = (string) ($row['user_id'] ?? '');
        if ($appId === '' || $table === '' || $formOwner === '' || preg_match('/^[A-Za-z][A-Za-z0-9_]{0,62}$/D', $table) !== 1) {
            return null;
        }
        // Strictly verify same-account ownership between the form and the target SoftN app.
        try {
            $appStmt = $this->mysql->prepare('SELECT owner_id FROM apps WHERE id = :id LIMIT 1');
            $appStmt->execute(['id' => $appId]);
            $appOwner = $appStmt->fetchColumn();
        } catch (\Throwable) {
            return null;
        }
        if (!is_string($appOwner) || $appOwner !== $formOwner) {
            return null;
        }

        $columns = [];
        if (is_array($raw['columns'] ?? null)) {
            foreach ($raw['columns'] as $fieldId => $colName) {
                if (!is_string($fieldId) || !is_string($colName)) continue;
                if (preg_match('/^[A-Za-z_][A-Za-z0-9_]{0,62}$/D', $colName) !== 1) continue;
                if (NativeRecordStore::hidden($colName)) continue;
                $columns[$fieldId] = $colName;
            }
        }
        $pk = [];
        if (is_array($raw['primaryKey'] ?? null)) {
            foreach ($raw['primaryKey'] as $k) {
                if (is_string($k) && preg_match('/^[A-Za-z_][A-Za-z0-9_]{0,62}$/D', $k) === 1 && !NativeRecordStore::hidden($k)) {
                    $pk[] = $k;
                }
            }
        }
        $createdAtCol = is_string($raw['createdAtColumn'] ?? null)
            && preg_match('/^[A-Za-z_][A-Za-z0-9_]{0,62}$/D', $raw['createdAtColumn']) === 1
            && !NativeRecordStore::hidden($raw['createdAtColumn'])
            ? $raw['createdAtColumn']
            : null;
        $statusCol = is_string($raw['statusColumn'] ?? null)
            && preg_match('/^[A-Za-z_][A-Za-z0-9_]{0,62}$/D', $raw['statusColumn']) === 1
            && !NativeRecordStore::hidden($raw['statusColumn'])
            ? $raw['statusColumn']
            : null;

        return [
            'formId' => $formId,
            'ownerId' => $formOwner,
            'appId' => $appId,
            'databaseAppId' => $this->native->databaseAppId($appId),
            'table' => $table,
            'primaryKey' => $pk,
            'columns' => $columns,
            'createdAtColumn' => $createdAtCol,
            'statusColumn' => $statusCol,
            'managedByForm' => ($raw['managedByForm'] ?? false) === true,
        ];
    }

    /** Encode a primary-key map into a URL-safe FormLogic response ID. */
    public static function encodeKey(array $keyMap, array $pkNames): string
    {
        if (count($pkNames) === 1) {
            $val = (string) ($keyMap[$pkNames[0]] ?? '');
            if ($val !== '' && preg_match('/^[A-Za-z0-9._-]{1,120}$/D', $val) === 1) {
                return $val;
            }
        }
        return 'nk_' . rtrim(strtr(base64_encode(json_encode($keyMap, JSON_THROW_ON_ERROR)), '+/', '-_'), '=');
    }

    /** Decode a FormLogic response ID back into a NativeRecordStore primary-key map. */
    public static function decodeKey(string $responseId, array $pkNames): ?array
    {
        if ($pkNames === [] || $responseId === '') return null;
        if (str_starts_with($responseId, 'nk_')) {
            $b64 = strtr(substr($responseId, 3), '-_', '+/');
            $pad = strlen($b64) % 4;
            if ($pad > 0) $b64 .= str_repeat('=', 4 - $pad);
            $decoded = json_decode((string) base64_decode($b64, true), true);
            if (!is_array($decoded)) return null;
            $out = [];
            foreach ($pkNames as $col) {
                if (!array_key_exists($col, $decoded) || !is_scalar($decoded[$col])) return null;
                $out[$col] = (string) $decoded[$col];
            }
            return $out;
        }
        if (count($pkNames) === 1) {
            return [$pkNames[0] => $responseId];
        }
        return null;
    }

    /**
     * Resolve an authoritative submitter user-ID column (`_submitted_by_user_id` or `submitted_by_user_id`)
     * on the bound SQLite table, or null if the table has none.
     */
    private function resolveSubmitterColumn(array $binding): ?string
    {
        try {
            $schemas = $this->native->tableSchemas($binding['appId']);
            $tableSchema = $schemas[$binding['table']] ?? null;
            if (!is_array($tableSchema)) return null;
            foreach ((array) ($tableSchema['fields'] ?? []) as $f) {
                $name = (string) ($f['name'] ?? '');
                if ($name === '_submitted_by_user_id' || $name === 'submitted_by_user_id') {
                    return $name;
                }
            }
        } catch (\Throwable) {
            return null;
        }
        return null;
    }

    /**
     * List rows from the bound SQLite table in canonical FormLogic Response format.
     *
     * Everything a form's own store filters, orders and pages a list by
     * (ResponseService::getFormResponses) is answered from the table (storeQuery) or refused
     * (ResponseListRefused). Left unread, as most of it was, whoever asked for some rows was
     * given all of them: an automation's lookup, a sync's "changed since", a page of one status.
     *
     * @param array<string, mixed> $binding
     * @param array<string, mixed> $options
     * @return list<array<string, mixed>>
     * @throws ResponseListRefused when the table cannot answer what was asked
     */
    public function listResponses(array $binding, array $options = []): array
    {
        return $this->read($binding, $options, false)['responses'];
    }

    /**
     * listResponses(), and how many rows match what was asked (`total`), for a list that pages:
     * the app's records, a linked-record search. Counted once, by the store's first page, in the
     * table under the conditions the rows are read by (NativeRecordStore::browse's `matching`):
     * one COUNT(*), as a form's own store counts its own (ResponseService::getFormResponsesSearchable).
     * What the exact checks drop after the read (a phone number's digits, a non-date range bound)
     * is counted, as a form's own store counts its coarse match.
     *
     * @param array<string, mixed> $binding
     * @param array<string, mixed> $options
     * @return array{responses: list<array<string, mixed>>, total: int}
     * @throws ResponseListRefused when the table cannot answer what was asked
     */
    public function listResponsesWithTotal(array $binding, array $options = []): array
    {
        return $this->read($binding, $options, true);
    }

    /**
     * @param array<string, mixed> $binding
     * @param array<string, mixed> $options
     * @param bool $count whether to count the rows that match; with no count, `total` is 0 and no
     *   read counts the table (an export reads it a page at a time, and counted it on every page)
     * @return array{responses: list<array<string, mixed>>, total: int}
     * @throws ResponseListRefused
     */
    private function read(array $binding, array $options, bool $count): array
    {
        $limit = max(1, min((int) ($options['limit'] ?? 50), self::LIST_LIMIT));
        $offset = max(0, (int) ($options['offset'] ?? 0));
        // The store reads no further than OFFSET_LIMIT rows in, and answers an offset past it with
        // the page AT it: the same rows again for every later page a client asks for by offset.
        if ($offset > NativeRecordStore::OFFSET_LIMIT) {
            throw self::pastOffsetLimit();
        }
        $query = $this->storeQuery($binding, $options);
        if ($query === null) {
            return ['responses' => [], 'total' => 0];
        }
        $start = $offset;
        $total = 0;
        // Each value whole. A page of the data manager gives the first 400 characters of a text,
        // which was every list of the form, its exports and its API: what they gave as a record
        // was cut, and nothing said so.
        $query['options']['whole'] = true;
        // The record store reads a page of one of its own sizes and no other, so the rows asked for
        // are read a page at a time: the smallest page that holds what is still wanted, the largest
        // when none does. One read of at most 250 rows answered every request before, and whoever
        // asked for 1000 (the Responses page, an API client) took the short answer for the end.
        $out = [];
        // Rows of the table read so far: `limit` and `offset` count these, as a form's own store
        // counts the rows of its query, before the exact check below drops any.
        $read = 0;
        while ($read < $limit) {
            $wanted = $limit - $read;
            $pageSize = max(NativeRecordStore::PAGE_SIZES);
            foreach (NativeRecordStore::PAGE_SIZES as $size) {
                if ($size >= $wanted && $size < $pageSize) $pageSize = $size;
            }
            // The first page counts, when asked to; the store counts no other.
            $counts = $count && $offset === $start;
            try {
                $res = $this->native->records($binding['appId'], $binding['table'], $offset, null, ['limit' => $pageSize, 'count' => $counts] + $query['options']);
            } catch (\InvalidArgumentException $e) {
                // The store's own refusal of a condition: a column it does not show, too many of them.
                throw new ResponseListRefused('This form\'s records are kept in an app\'s table, which cannot be listed that way: ' . $e->getMessage());
            } catch (\RuntimeException $e) {
                // No database to read is no rows. A page that fails after others were read is
                // not the end of the list, and is not passed off as one.
                if ($read === 0) return ['responses' => [], 'total' => 0];
                throw $e;
            }
            if ($counts) {
                $total = (int) ($res['matching'] ?? 0);
            }
            $rows = is_array($res['rows'] ?? null) ? $res['rows'] : [];
            // The key's columns are the schema's: the answer carries no `primaryKey` of its own.
            $pkNames = is_array($res['schema']['primaryKey'] ?? null) && $res['schema']['primaryKey'] !== []
                ? $res['schema']['primaryKey']
                : $binding['primaryKey'];
            $keys = is_array($res['keys'] ?? null) ? $res['keys'] : [];
            foreach ($rows as $idx => $row) {
                if ($read >= $limit) break;
                $read++;
                if (!is_array($row)) continue;
                if ($query['submitter'] !== null && (string) ($row[$query['submitterColumn']] ?? '') !== $query['submitter']) {
                    continue;
                }
                $keyMap = is_array($keys[$idx] ?? null) ? $keys[$idx] : $this->extractKeyFromRow($row, $pkNames);
                $response = $this->formatRow($binding, $row, $keyMap, $pkNames, (string) ($idx + $offset + 1));
                if ($query['passes'] !== null && !$query['passes']($response)) {
                    continue;
                }
                $out[] = $response;
            }
            // The store says why a page stops: another follows ('more'), the table ends, or rows
            // remain that it does not read by offset ('limit').
            $end = $res['end'] ?? (($res['hasMore'] ?? false) === true ? 'more' : 'end');
            if ($end === 'more') {
                $offset += $pageSize;
                continue;
            }
            // Rows were asked for that lie past what the store reads. A short page here would be
            // taken for the end of the list.
            if ($end === 'limit' && $read < $limit) {
                throw self::pastOffsetLimit();
            }
            break;
        }
        return ['responses' => $out, 'total' => $total];
    }

    private static function pastOffsetLimit(): ResponseListRefused
    {
        return new ResponseListRefused(
            'This form\'s records are kept in an app\'s table, which is read by offset no further than '
                . number_format(NativeRecordStore::OFFSET_LIMIT) . ' rows in. Narrow the list with a filter to reach the rest.',
            ResponseListRefused::PAST_OFFSET_LIMIT
        );
    }

    /** The field ids of one answer filter that a form's own store reads too: machine keys, nothing else. */
    private static function answerFilter(array $options, string $name): array
    {
        $filter = is_array($options[$name] ?? null) ? $options[$name] : [];
        return array_filter($filter, static fn ($fieldId): bool => preg_match('/^[A-Za-z0-9_]{1,64}$/', (string) $fieldId) === 1, ARRAY_FILTER_USE_KEY);
    }

    /**
     * What a list of the form's responses was asked for, as the record store reads its table.
     *
     * A response's status, times and answers are the row's columns (formatRow), so each filter
     * becomes a condition on the column behind it, compared as that column compares:
     *
     *  - `answersEq`: the field's column equals the value. A field with no column has no answer
     *    in any row, so nothing matches.
     *  - `status`: the rows statusOf() lists with that status, the rule a row's own status is
     *    given by. The column narrows them (it equals the status as the column compares it, or
     *    'submitted' and also no value), and statusOf() decides each row read: a column of
     *    numbers reads '01' as 1, which is listed as '1'. With no status column every row is
     *    'submitted'. '0' is a status like any other.
     *  - `from`, `to`: the created-at column, as seconds where the column holds numbers and as
     *    text otherwise (what a form's own store compares). Refused with no such column: a row
     *    then says nothing about when it was made.
     *  - `updatedSince`: the rows whose `updated_at` is at or after it, oldest change first, and
     *    the rows with none (when they changed is not known, and a sync must not miss them).
     *    Refused with no `updated_at` column. `afterId`, which pages such a read by the last
     *    record's time and id together, is refused: the table is paged by offset.
     *  - `sort`, `sortDir`: the column behind 'submittedAt', 'status' or a field. With no column
     *    behind it every row has the one value, and the order is the table's own.
     *  - `answersGte`, `answersLte`, `answersPhoneEq`: as a form's own store answers them. The
     *    table narrows the rows it can before the limit (a date-shaped bound on a column that is
     *    not a number's; the last digits of the phone number), and the exact rule is then checked
     *    on each row read (`passes`), so a row that fails it is never listed.
     *
     * @param array<string, mixed> $binding
     * @param array<string, mixed> $options
     * @return array{options: array<string, mixed>, submitterColumn: ?string, submitter: ?string, passes: ?\Closure}|null
     *         null when no row can match
     * @throws ResponseListRefused
     */
    private function storeQuery(array $binding, array $options): ?array
    {
        $columns = $binding['columns'];
        $native = [];
        if (isset($options['search']) && is_string($options['search']) && trim($options['search']) !== '') {
            $native['q'] = trim($options['search']);
        }
        // Conditions a row passes all of, and groups of which it passes one or more.
        $all = $anyOf = [];
        // The table's columns and their declared types, read when a filter needs them.
        $types = null;
        $type = function (string $column) use (&$types, $binding): ?string {
            $types ??= $this->columnTypes($binding);
            return $types[$column] ?? null;
        };
        $holdsNumbers = static fn (string $column): bool => preg_match('/INT|REAL|FLOA|DOUB|NUMERIC|DECIMAL/', (string) $type($column)) === 1;
        $time = static function (string $column, string $value, string $name) use ($holdsNumbers): string {
            if (!$holdsNumbers($column)) {
                return $value;
            }
            try {
                if (preg_match('/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/D', $value) !== 1) {
                    throw new \InvalidArgumentException('not a date');
                }
                return (string) (new \DateTimeImmutable($value, new \DateTimeZone('UTC')))->getTimestamp();
            } catch (\Exception) {
                throw new ResponseListRefused("`{$name}` is a UTC date or time: YYYY-MM-DD, YYYY-MM-DD HH:MM:SS or ISO 8601.");
            }
        };

        // Enforce view_own_responses scope strictly: fail closed if the bound SQLite table lacks
        // an authoritative submitter column so other members' rows are never exposed.
        $submitter = is_string($options['submittedByUserId'] ?? null) && $options['submittedByUserId'] !== ''
            ? $options['submittedByUserId']
            : null;
        $submitterColumn = null;
        if ($submitter !== null) {
            $submitterColumn = $this->resolveSubmitterColumn($binding);
            if ($submitterColumn === null) {
                return null;
            }
            $all[] = ['column' => $submitterColumn, 'op' => 'eq', 'value' => $submitter];
        }

        foreach (self::answerFilter($options, 'answersEq') as $fieldId => $value) {
            $column = $columns[(string) $fieldId] ?? null;
            if ($column === null || !is_scalar($value)) {
                return null;
            }
            $all[] = ['column' => $column, 'op' => 'eq', 'value' => (string) $value];
        }

        // The status the rows must be listed with, where the column only narrows them.
        $exactStatus = null;
        if (!in_array($options['status'] ?? null, [null, '', false], true)) {
            if (!is_scalar($options['status'])) {
                throw new ResponseListRefused('`status` is one status.');
            }
            $status = (string) $options['status'];
            $statusColumn = $binding['statusColumn'];
            if ($statusColumn === null) {
                if ($status !== 'submitted') {
                    return null;
                }
            } elseif ($status === 'submitted') {
                $anyOf[] = [['column' => $statusColumn, 'op' => 'eq', 'value' => $status], ['column' => $statusColumn, 'op' => 'empty']];
                $exactStatus = $status;
            } else {
                $all[] = ['column' => $statusColumn, 'op' => 'eq', 'value' => $status];
                $exactStatus = $status;
            }
        }

        foreach (['from' => 'gte', 'to' => 'lte'] as $name => $op) {
            if (empty($options[$name])) {
                continue;
            }
            if (!is_string($options[$name])) {
                throw new ResponseListRefused("`{$name}` is a UTC date or time.");
            }
            if ($binding['createdAtColumn'] === null) {
                throw new ResponseListRefused("This form's records are kept in an app's table with no column that says when a row was made, so they cannot be listed by `{$name}`.");
            }
            $all[] = ['column' => $binding['createdAtColumn'], 'op' => $op, 'value' => $time($binding['createdAtColumn'], $options[$name], $name)];
        }

        if (is_array($options['before'] ?? null)) {
            throw new ResponseListRefused('This form\'s records are kept in an app\'s table, which is not paged from a record (`before`). Page it with `offset`.');
        }

        $changedSince = is_string($options['updatedSince'] ?? null) && $options['updatedSince'] !== '';
        if ($changedSince) {
            if (is_string($options['afterId'] ?? null) && $options['afterId'] !== '') {
                throw new ResponseListRefused('This form\'s records are kept in an app\'s table, which is not paged by `afterId`. Page what changed with `offset`.');
            }
            if ($type('updated_at') === null) {
                throw new ResponseListRefused('This form\'s records are kept in an app\'s table with no `updated_at` column, so it cannot say which changed since a time. List them without `updatedSince`.');
            }
            $anyOf[] = [
                ['column' => 'updated_at', 'op' => 'gte', 'value' => $time('updated_at', $options['updatedSince'], 'updatedSince')],
                ['column' => 'updated_at', 'op' => 'empty'],
            ];
            $native['sort'] = 'updated_at';
            $native['dir'] = 'asc';
        } elseif (is_string($options['sort'] ?? null) && $options['sort'] !== '') {
            $sort = $options['sort'];
            $sortColumn = match (true) {
                $sort === 'submittedAt' || $sort === 'submitted_at' => $binding['createdAtColumn'],
                $sort === 'status' => $binding['statusColumn'],
                default => $columns[$sort] ?? null,
            };
            if ($sortColumn !== null) {
                $native['sort'] = $sortColumn;
                // Newest or largest first unless asked otherwise, as a form's own store sorts.
                $native['dir'] = strtolower((string) ($options['sortDir'] ?? 'desc')) === 'asc' ? 'asc' : 'desc';
            }
        }

        // What narrows the rows before the limit without deciding them: `passes` decides.
        $narrowAll = $narrowAny = $phones = $range = [];
        foreach (is_array($options['answersPhoneEq'] ?? null) ? $options['answersPhoneEq'] : [] as $fieldId => $wanted) {
            $digits = preg_replace('/\D+/', '', is_scalar($wanted) ? (string) $wanted : '') ?? '';
            $column = $columns[(string) $fieldId] ?? null;
            // Fewer than six digits match no number (ResponseService::phoneDigitsMatch), and a
            // field with no column has no number in any row.
            if ($column === null || strlen($digits) < 6) {
                return null;
            }
            $phones[(string) $fieldId] = $digits;
            // A number that matches ends in these digits, so it holds each of them.
            foreach (array_unique(str_split(substr($digits, -4))) as $digit) {
                $narrowAll[] = ['column' => $column, 'op' => 'contains', 'value' => $digit];
            }
        }
        foreach (['answersGte' => 'gte', 'answersLte' => 'lte'] as $name => $op) {
            if (empty($options[$name]) || !is_array($options[$name])) {
                continue;
            }
            $range[$name] = $options[$name];
            foreach (self::answerFilter($options, $name) as $fieldId => $bound) {
                $column = $columns[(string) $fieldId] ?? null;
                // Only a date-shaped bound on a column that is not a number's: there the column's
                // own comparison is the text comparison the exact rule makes. Any other bound is
                // left to that rule alone, as a form's own store leaves it.
                if ($column === null || !is_string($bound) || preg_match('/^\d{4}-\d{2}-\d{2}/', $bound) !== 1 || $holdsNumbers($column)) {
                    continue;
                }
                if ($op === 'gte') {
                    $narrowAll[] = ['column' => $column, 'op' => 'gte', 'value' => $bound];
                } else {
                    // A row with no value passes `lte`: nothing sorts before any bound.
                    $narrowAny[] = [['column' => $column, 'op' => 'lte', 'value' => $bound], ['column' => $column, 'op' => 'empty']];
                }
            }
        }
        // The store takes so many conditions. Narrowing ones give way to the ones that decide.
        foreach ($narrowAll as $condition) {
            if (count($all) < NativeRecordStore::FILTERS) $all[] = $condition;
        }
        foreach ($narrowAny as $group) {
            if (count($anyOf) < NativeRecordStore::FILTERS) $anyOf[] = $group;
        }
        if ($all !== []) {
            $native['filter'] = $all;
        }
        if ($anyOf !== []) {
            $native['anyOf'] = $anyOf;
        }

        // Each row read, as formatRow() gives it: its status by statusOf(), its answers.
        $passes = $phones === [] && $range === [] && $exactStatus === null ? null : static function (array $response) use ($phones, $range, $exactStatus): bool {
            if ($exactStatus !== null && $response['status'] !== $exactStatus) {
                return false;
            }
            $answers = $response['answers'];
            foreach ($phones as $fieldId => $digits) {
                $stored = $answers[$fieldId] ?? '';
                if (!ResponseService::phoneDigitsMatch(is_scalar($stored) ? (string) $stored : '', $digits)) {
                    return false;
                }
            }
            return $range === [] || ResponseService::answersWithinRange($answers, $range);
        };

        return ['options' => $native, 'submitterColumn' => $submitterColumn, 'submitter' => $submitter, 'passes' => $passes];
    }

    /**
     * The bound table's shown columns and their declared types, or none when it cannot be read.
     *
     * @return array<string, string>
     */
    private function columnTypes(array $binding): array
    {
        try {
            $fields = $this->native->tableSchemas($binding['appId'])[$binding['table']]['fields'] ?? [];
        } catch (\Throwable) {
            return [];
        }
        $types = [];
        foreach (is_array($fields) ? $fields : [] as $field) {
            $types[(string) ($field['name'] ?? '')] = strtoupper((string) ($field['type'] ?? ''));
        }
        return $types;
    }

    /**
     * Read one row by response ID from the bound SQLite table, each value whole as a list gives
     * it (NativeRecordStore::wholeRecord). The record editor's read gives every value as text and
     * none past 100 KB, so a response read that way lost such an answer.
     */
    public function getResponse(array $binding, string $responseId): ?array
    {
        $pkNames = $this->resolvePrimaryKey($binding);
        $keyMap = self::decodeKey($responseId, $pkNames);
        if ($keyMap === null) return null;
        try {
            $values = $this->native->withDatabase($binding['appId'], static function (PDO $db) use ($binding, $keyMap): ?array {
                $store = new NativeRecordStore($db);
                try { return $store->wholeRecord($binding['table'], $keyMap); }
                finally { $store->close(); }
            });
        } catch (\Throwable) {
            return null;
        }
        return is_array($values) ? $this->formatRow($binding, $values, $keyMap, $pkNames, $responseId) : null;
    }

    /**
     * Several records by response id, each as getResponse() reads it, in one read of the table:
     * every one asked for that is there, in the order asked, an id asked twice once, as a form's
     * own store gives them (ResponseService::getResponsesByIds). Read one at a time, the first 250
     * ids were read and the rest left out without a word: a linked record's label, a related
     * list, a lookup of the ids a client named.
     *
     * @param array<int, mixed> $responseIds
     * @return list<array<string, mixed>>
     */
    public function getResponses(array $binding, array $responseIds): array
    {
        $pkNames = $this->resolvePrimaryKey($binding);
        $wanted = [];
        foreach ($responseIds as $responseId) {
            if (!is_string($responseId) || isset($wanted[$responseId])) continue;
            $keyMap = self::decodeKey($responseId, $pkNames);
            if ($keyMap !== null) $wanted[$responseId] = $keyMap;
        }
        if ($wanted === []) return [];
        try {
            $rows = $this->native->withDatabase($binding['appId'], static function (PDO $db) use ($binding, $wanted): array {
                $store = new NativeRecordStore($db);
                try { return $store->wholeRecords($binding['table'], array_values($wanted)); }
                finally { $store->close(); }
            });
        } catch (\Throwable) {
            // As getResponse() answers a table it cannot read.
            return [];
        }
        $out = [];
        $row = 0;
        foreach ($wanted as $responseId => $keyMap) {
            $values = is_array($rows) ? ($rows[$row++] ?? null) : null;
            if (is_array($values)) {
                $out[] = $this->formatRow($binding, $values, $keyMap, $pkNames, (string) $responseId);
            }
        }
        return $out;
    }

    /** Create a new row in the bound SQLite table and dispatch committed record events. */
    public function createResponse(array $binding, array $data): array
    {
        $answers = is_array($data['answers'] ?? null) ? $data['answers'] : [];
        $schemas = $this->native->tableSchemas($binding['appId']);
        $tableSchema = $schemas[$binding['table']] ?? ['fields' => [], 'primaryKey' => $binding['primaryKey'], 'canCreate' => true];
        $fieldsByName = [];
        foreach ($tableSchema['fields'] as $f) {
            $fieldsByName[(string) $f['name']] = $f;
        }
        $values = $this->mapAnswersToColumns($binding, $answers, $fieldsByName, false);
        // A status given with the record (an onSubmit script's, one an import carries) is written
        // to the status column as statusOf() reads it back, and only so: never 'submitted', which
        // statusOf() gives a row with none (the column keeps its default), never a word into a
        // column of numbers, which would refuse the record, and never over an answer given for
        // the column, which is the record's own value for it. An import sent 'submitted' with
        // every row: a column of numbers refused them all, and one of text lost what was imported.
        $status = is_string($data['status'] ?? null) ? $data['status'] : '';
        if ($status !== '' && $status !== 'submitted' && $binding['statusColumn'] !== null) {
            $statusCol = $binding['statusColumn'];
            $statusMeta = $fieldsByName[$statusCol] ?? null;
            $answered = isset($values[$statusCol]) && $values[$statusCol] !== '';
            $holdsNumbers = preg_match('/INT|REAL|FLOA|DOUB|NUMERIC|DECIMAL/', strtoupper((string) ($statusMeta['type'] ?? ''))) === 1;
            if (!$answered && ($statusMeta === null || empty($statusMeta['readOnly'])) && (!$holdsNumbers || is_numeric($status))) {
                $values[$statusCol] = $status;
            }
        }
        // Record server-derived submitter identity when the table carries an authoritative owner column.
        $submitterId = is_string($data['submittedByUserId'] ?? null) && $data['submittedByUserId'] !== ''
            ? $data['submittedByUserId']
            : null;
        if ($submitterId !== null) {
            foreach (['_submitted_by_user_id', 'submitted_by_user_id'] as $subCol) {
                if (isset($fieldsByName[$subCol]) && empty($fieldsByName[$subCol]['readOnly'])) {
                    $values[$subCol] = $submitterId;
                }
            }
        }
        // If the table has a non-auto text primary key that wasn't provided, supply a UUID.
        $pkNames = $tableSchema['primaryKey'] !== [] ? $tableSchema['primaryKey'] : $binding['primaryKey'];
        if (count($pkNames) === 1) {
            $pkCol = $pkNames[0];
            $pkMeta = $fieldsByName[$pkCol] ?? null;
            if ($pkMeta !== null && empty($pkMeta['auto']) && !array_key_exists($pkCol, $values) && empty($pkMeta['defaultValue'])) {
                if (str_contains(strtoupper((string) ($pkMeta['type'] ?? '')), 'TEXT') || str_contains(strtoupper((string) ($pkMeta['type'] ?? '')), 'CHAR') || ($pkMeta['type'] ?? '') === '') {
                    $values[$pkCol] = $this->uuid();
                }
            }
        }
        // Automatically supply required system/audit columns (created_at, updated_at, is_sample,
        // sequence numbers, and any other NOT NULL columns without defaults) so FormLogic forms
        // write cleanly into both form-managed SQLite tables and full SoftN business app schemas.
        $nowEpoch = time();
        $nowIso = gmdate('Y-m-d H:i:s', $nowEpoch);
        $today = gmdate('Y-m-d', $nowEpoch);
        foreach ($fieldsByName as $colName => $colMeta) {
            if (array_key_exists($colName, $values) && $values[$colName] !== null && $values[$colName] !== '') {
                continue;
            }
            if (!empty($colMeta['auto']) || !empty($colMeta['readOnly'])) {
                continue;
            }
            $isRequired = !empty($colMeta['required']);
            $hasDefault = array_key_exists('defaultValue', $colMeta) && $colMeta['defaultValue'] !== null;
            $lower = strtolower($colName);
            $sqlType = strtoupper((string) ($colMeta['type'] ?? 'TEXT'));
            $isNumericType = preg_match('/INT|REAL|FLOA|DOUB|NUMERIC|DECIMAL/', $sqlType) === 1;

            if ($lower === 'created_at' || $lower === 'updated_at') {
                $values[$colName] = $isNumericType ? $nowEpoch : $nowIso;
                continue;
            }
            if ($lower === 'is_sample' && !array_key_exists($colName, $values)) {
                $values[$colName] = 0;
                continue;
            }
            if (!$isRequired || $hasDefault) {
                continue;
            }
            if (preg_match('/(?:_number|_code|_ref|^code$|^ref$)$/', $lower) === 1 && !$isNumericType) {
                $prefix = strtoupper(substr(preg_replace('/[^a-zA-Z]/', '', $binding['table']) ?: 'REC', 0, 3));
                $values[$colName] = $prefix . '-' . strtoupper(substr(bin2hex(random_bytes(3)), 0, 6));
            } elseif (preg_match('/_date$|^date$/', $lower) === 1 && !$isNumericType) {
                $values[$colName] = $today;
            } elseif ($isNumericType) {
                $values[$colName] = 0;
            } else {
                $values[$colName] = '';
            }
        }
        $subscriptions = $this->subscriptionsFor($binding['appId']);
        $res = $this->native->manageRecord($binding['appId'], [
            'table' => $binding['table'],
            'action' => 'create',
            'values' => $values,
        ], $subscriptions);
        $this->dispatchEvents($binding['appId']);

        $keyMap = is_array($res['key'] ?? null) ? $res['key'] : $this->extractKeyFromRow($values, $pkNames);
        $id = $keyMap !== [] ? self::encodeKey($keyMap, $pkNames) : $this->uuid();
        if ($keyMap !== []) {
            $fetched = $this->getResponse($binding, $id);
            if ($fetched !== null) return $fetched;
        }
        return $this->formatRow($binding, $values, $keyMap, $pkNames, $id);
    }

    /**
     * Update an existing row in the bound SQLite table and dispatch committed record events.
     *
     * With `$ifMatch` (an etag, ResponseService::etagOf, of the record as a list or a read gives
     * it) the row is written only while it is still that version, as a form's own store writes
     * only over the version a client read. The record the row makes is compared inside the
     * write's own transaction, under the database's write lock (NativeRecordStore::operate's
     * `expect`), so a change that lands between this read and the write is never written over:
     * ResponseVersionConflict carries the record as it is then, and nothing is written. Unread,
     * as it was, a client's stale write overwrote whatever had changed since it read the record,
     * and a merged edit (ResponseService::mergeEdit) lost the edit that landed before it.
     *
     * @throws ResponseVersionConflict
     */
    public function updateResponse(array $binding, string $responseId, array $data, ?string $ifMatch = null): ?array
    {
        $pkNames = $this->resolvePrimaryKey($binding);
        $keyMap = self::decodeKey($responseId, $pkNames);
        if ($keyMap === null) return null;
        try {
            $current = $this->native->manageRecord($binding['appId'], [
                'table' => $binding['table'],
                'action' => 'read',
                'key' => $keyMap,
            ]);
        } catch (\Throwable) {
            return null;
        }
        $revision = (string) ($current['record']['revision'] ?? '');
        $fieldsByName = [];
        foreach (is_array($current['record']['fields'] ?? null) ? $current['record']['fields'] : [] as $f) {
            $fieldsByName[(string) $f['name']] = $f;
        }
        $answers = is_array($data['answers'] ?? null) ? $data['answers'] : [];
        $values = $this->mapAnswersToColumns($binding, $answers, $fieldsByName, true);
        if (isset($data['status']) && is_string($data['status']) && $binding['statusColumn'] !== null) {
            $statusCol = $binding['statusColumn'];
            $statusMeta = $fieldsByName[$statusCol] ?? null;
            if ($statusMeta === null || empty($statusMeta['readOnly'])) {
                $values[$statusCol] = $data['status'];
            }
        }
        if ($values !== [] && isset($fieldsByName['updated_at']) && !array_key_exists('updated_at', $values) && empty($fieldsByName['updated_at']['readOnly'])) {
            $uType = strtoupper((string) ($fieldsByName['updated_at']['type'] ?? 'TEXT'));
            $values['updated_at'] = preg_match('/INT|REAL|FLOA|DOUB|NUMERIC|DECIMAL/', $uType) === 1 ? time() : gmdate('Y-m-d H:i:s');
        }
        if ($values === []) {
            // Nothing to write: the record as any read gives it, not as the editor's read did,
            // and a conflict if it is not the version asked for, as a form's own store answers.
            $now = $this->getResponse($binding, $responseId);
            if ($now !== null && $ifMatch !== null && !hash_equals(ResponseService::etagOf($now), $ifMatch)) {
                throw new ResponseVersionConflict($now);
            }
            return $now;
        }
        $write = [
            'table' => $binding['table'],
            'action' => 'update',
            'key' => $keyMap,
            'revision' => $revision,
            'values' => $values,
        ];
        if ($ifMatch !== null) {
            $write['expect'] = function (array $row) use ($binding, $keyMap, $pkNames, $responseId, $ifMatch): void {
                $now = $this->formatRow($binding, $row, $keyMap, $pkNames, $responseId);
                if (!hash_equals(ResponseService::etagOf($now), $ifMatch)) {
                    throw new ResponseVersionConflict($now);
                }
            };
        }
        $subscriptions = $this->subscriptionsFor($binding['appId']);
        try {
            $this->native->manageRecord($binding['appId'], $write, $subscriptions);
        } catch (\RuntimeException $e) {
            // Deleted since it was read: not there, as a form's own store answers a record that
            // is gone. A conflict, or anything else, is the caller's to hear.
            if ($ifMatch !== null && !$e instanceof ResponseVersionConflict && $e->getCode() === 409 && $this->getResponse($binding, $responseId) === null) {
                return null;
            }
            throw $e;
        }
        $this->dispatchEvents($binding['appId']);
        return $this->getResponse($binding, $responseId);
    }

    /** Delete a row from the bound SQLite table and dispatch committed record events. */
    public function deleteResponse(array $binding, string $responseId): bool
    {
        $pkNames = $this->resolvePrimaryKey($binding);
        $keyMap = self::decodeKey($responseId, $pkNames);
        if ($keyMap === null) return false;
        try {
            $current = $this->native->manageRecord($binding['appId'], [
                'table' => $binding['table'],
                'action' => 'read',
                'key' => $keyMap,
            ]);
        } catch (\Throwable) {
            return false;
        }
        $revision = (string) ($current['record']['revision'] ?? '');
        $subscriptions = $this->subscriptionsFor($binding['appId']);
        $this->native->manageRecord($binding['appId'], [
            'table' => $binding['table'],
            'action' => 'delete',
            'key' => $keyMap,
            'revision' => $revision,
        ], $subscriptions);
        $this->dispatchEvents($binding['appId']);
        return true;
    }

    /**
     * Delete all rows from the bound SQLite table. Returns the number of rows removed.
     *
     * Through the record store, as every other write here is, so the table's foreign keys hold
     * (NativeRecordStore::clear). It queues no record events, so there are none to dispatch.
     *
     * @param list<string>|null $ids given, the response id of each record that went, as a list
     *   names it, read in the clear's own transaction: what a client that syncs is told is gone
     */
    public function deleteAllResponses(array $binding, ?array &$ids = null): int
    {
        $keys = $ids === null ? null : [];
        $deleted = (int) $this->native->withDatabase($binding['appId'], static function (PDO $db) use ($binding, &$keys): int {
            $store = new NativeRecordStore($db);
            try { return $store->clear($binding['table'], $keys); }
            finally { $store->close(); }
        });
        if ($ids !== null) {
            $ids = array_map(static fn (array $key): string => self::encodeKey($key, array_keys($key)), $keys ?? []);
        }
        return $deleted;
    }

    /**
     * Which of these response ids name no row of the bound table now. A record deleted through
     * the form leaves a tombstone, and the table can give its key to a row again (the app's own
     * insert, a whole-number key SQLite numbers on from the largest): a client told that id is
     * gone deletes its copy of the new row, and skips the row itself. An id that names no key is
     * gone. When the table cannot be read, none is said to be gone.
     *
     * @param list<string> $ids
     * @return list<string>
     */
    public function stillGone(array $binding, array $ids): array
    {
        if ($ids === []) return [];
        try {
            $pkNames = $this->resolvePrimaryKey($binding);
            return array_values((array) $this->native->withDatabase($binding['appId'], static function (PDO $db) use ($binding, $pkNames, $ids): array {
                if ($pkNames === []) return $ids;
                $where = implode(' AND ', array_map(static fn (string $name): string => '"' . str_replace('"', '""', $name) . '" = ?', $pkNames));
                $look = $db->prepare('SELECT 1 FROM "' . str_replace('"', '""', $binding['table']) . '" WHERE ' . $where . ' LIMIT 1');
                $gone = [];
                foreach ($ids as $id) {
                    $key = self::decodeKey($id, $pkNames);
                    if ($key !== null) {
                        $look->execute(array_values($key));
                        $found = $look->fetchColumn() !== false;
                        $look->closeCursor();
                        if ($found) continue;
                    }
                    $gone[] = $id;
                }
                return $gone;
            }));
        } catch (\Throwable) {
            return [];
        }
    }

    /**
     * How many rows the bound table has, as countResponses() counts them, or null when the table
     * cannot be read: for a caller that writes the count down (the form's `response_count`), where
     * countResponses()'s 0 for a table it could not read would be taken for an empty table.
     */
    public function countRows(array $binding): ?int
    {
        try {
            return (int) $this->native->withDatabase($binding['appId'], static function (PDO $db) use ($binding): int {
                $quoted = '"' . str_replace('"', '""', $binding['table']) . '"';
                return (int) $db->query("SELECT COUNT(*) FROM {$quoted}")->fetchColumn();
            });
        } catch (\Throwable) {
            return null;
        }
    }

    /** Count all rows (or rows owned by $submittedByUserId) in the bound SQLite table. */
    public function countResponses(array $binding, ?string $submittedByUserId = null): int
    {
        if ($submittedByUserId !== null && $submittedByUserId !== '') {
            $submitterCol = $this->resolveSubmitterColumn($binding);
            if ($submitterCol === null) {
                return 0;
            }
            try {
                return (int) $this->native->withDatabase($binding['appId'], static function (PDO $db) use ($binding, $submitterCol, $submittedByUserId): int {
                    $quoted = '"' . str_replace('"', '""', $binding['table']) . '"';
                    $qCol = '"' . str_replace('"', '""', $submitterCol) . '"';
                    $stmt = $db->prepare("SELECT COUNT(*) FROM {$quoted} WHERE {$qCol} = ?");
                    $stmt->execute([$submittedByUserId]);
                    return (int) $stmt->fetchColumn();
                });
            } catch (\Throwable) {
                return 0;
            }
        }
        return $this->countRows($binding) ?? 0;
    }

    /**
     * Build a FormLogic form definition (fields + nativeTableBinding + starter report specs)
     * directly from a SoftN app SQLite table's schema.
     *
     * @param array{fields: list<array<string, mixed>>, primaryKey: list<string>, canCreate: bool} $schema
     * @return array{
     *   fields: list<array<string, mixed>>,
     *   binding: array<string, mixed>,
     *   numericFields: list<array{id: string, label: string}>,
     *   categoryFields: list<array{id: string, label: string}>
     * }
     */
    public static function buildFormDefinitionFromTable(string $databaseAppId, string $table, array $schema): array
    {
        $fields = [];
        $columns = [];
        $taken = [];
        $createdAtCol = null;
        $statusCol = null;
        $numericFields = [];
        $categoryFields = [];

        foreach ($schema['fields'] as $col) {
            $colName = (string) ($col['name'] ?? '');
            if ($colName === '' || NativeRecordStore::hidden($colName)) continue;
            $type = strtoupper((string) ($col['type'] ?? ''));
            if (str_contains($type, 'BLOB')) continue;

            $lower = strtolower($colName);
            // Never expose authoritative submitter-ownership columns as user-editable form fields.
            if ($lower === '_submitted_by_user_id' || $lower === 'submitted_by_user_id') {
                continue;
            }
            if ($createdAtCol === null && preg_match('/^(?:created_?at|submitted_?at|inserted_?at|date_?created|timestamp)$/', $lower) === 1) {
                $createdAtCol = $colName;
            }
            if ($statusCol === null && preg_match('/^(?:status|state|stage|priority|category|type)$/', $lower) === 1) {
                $statusCol = $colName;
            }
            // Skip auto-increment primary keys from editable form fields (they are tracked as primaryKey).
            if (!empty($col['auto']) && !empty($col['primary'])) {
                continue;
            }
            if (!empty($col['readOnly'])) {
                continue;
            }

            $fieldId = FormService::newFieldId($colName, $taken);
            $taken[$fieldId] = true;
            $label = ucwords(str_replace(['_', '-'], ' ', (string) preg_replace('/(?<=[a-z])(?=[A-Z])/', ' ', $colName)));
            $fieldType = self::inferFieldType($colName, $type);
            $required = !empty($col['required']) && ($col['defaultValue'] ?? null) === null && empty($col['primary']);

            $fields[] = [
                'id' => $fieldId,
                'type' => $fieldType,
                'label' => $label,
                'required' => $required,
                'order' => count($fields),
                'properties' => [],
            ];
            $columns[$fieldId] = $colName;

            if ($fieldType === 'number') {
                $numericFields[] = ['id' => $fieldId, 'label' => $label];
            } elseif (in_array($fieldType, ['short_text', 'dropdown'], true) && !preg_match('/email|phone|url|name|title|id$/i', $lower)) {
                $categoryFields[] = ['id' => $fieldId, 'label' => $label];
            }
        }

        // Prioritize status/priority/category/type columns for starter breakdown charts.
        usort($categoryFields, static function (array $a, array $b) use ($columns): int {
            $score = static fn(string $id): int => preg_match('/status|state|stage|priority|category|type/i', $columns[$id] ?? '') === 1 ? 0 : 1;
            return $score($a['id']) <=> $score($b['id']);
        });

        return [
            'fields' => $fields,
            'binding' => [
                'appId' => $databaseAppId,
                'table' => $table,
                'primaryKey' => $schema['primaryKey'],
                'columns' => $columns,
                'createdAtColumn' => $createdAtCol,
                'statusColumn' => $statusCol,
            ],
            'numericFields' => $numericFields,
            'categoryFields' => $categoryFields,
        ];
    }

    private static function inferFieldType(string $colName, string $sqlType): string
    {
        $lower = strtolower($colName);
        if (str_contains($lower, 'email')) return 'email';
        if (preg_match('/phone|mobile|tel$/', $lower) === 1) return 'phone';
        if (preg_match('/url|website|link/', $lower) === 1) return 'url';
        if (preg_match('/INT|REAL|FLOA|DOUB|NUMERIC|DECIMAL/', $sqlType) === 1 && !preg_match('/_at$|timestamp|date/', $lower)) {
            return 'number';
        }
        if (preg_match('/_date$|^date$|due_?date|start_?date|end_?date/', $lower) === 1) return 'date';
        if (preg_match('/description|notes|details|body|comment|message|address|summary/', $lower) === 1) return 'long_text';
        return 'short_text';
    }

    /** @return list<string> */
    private function resolvePrimaryKey(array $binding): array
    {
        if ($binding['primaryKey'] !== []) return $binding['primaryKey'];
        $schemas = $this->native->tableSchemas($binding['appId']);
        return $schemas[$binding['table']]['primaryKey'] ?? [];
    }

    /**
     * The status a row is listed with, and so the rows a list of one status gives (storeQuery):
     * the status column's value as text, or 'submitted' where the row has none (no such column,
     * NULL, ''). A column of numbers (a stage, a priority) gives its numbers, as a report groups
     * them and the data manager shows them, a number that is not whole as JSON writes it. Taken
     * from a text alone, every numbered row was listed as 'submitted', which a list of
     * 'submitted' then did not give.
     */
    private static function statusOf(array $binding, array $row): string
    {
        $value = $binding['statusColumn'] !== null ? ($row[$binding['statusColumn']] ?? null) : null;
        if (is_float($value)) {
            $value = json_encode($value) ?: (string) $value;
        }
        return (is_string($value) || is_int($value)) && (string) $value !== '' ? (string) $value : 'submitted';
    }

    /** @return array<string, mixed> */
    private function formatRow(array $binding, array $row, array $keyMap, array $pkNames, string $fallbackId): array
    {
        $answers = [];
        foreach ($binding['columns'] as $fieldId => $colName) {
            if (array_key_exists($colName, $row)) {
                $answers[$fieldId] = $row[$colName];
            }
        }
        $id = $keyMap !== [] ? self::encodeKey($keyMap, $pkNames) : $fallbackId;
        $rawCreated = ($binding['createdAtColumn'] !== null && isset($row[$binding['createdAtColumn']]) && is_scalar($row[$binding['createdAtColumn']]))
            ? $row[$binding['createdAtColumn']]
            : null;
        if ($rawCreated !== null && is_numeric($rawCreated) && (int) $rawCreated > 946684800 && (int) $rawCreated < 4102444800) {
            $createdAt = gmdate('Y-m-d H:i:s', (int) $rawCreated);
        } elseif ($rawCreated !== null && trim((string) $rawCreated) !== '') {
            $createdAt = (string) $rawCreated;
        } else {
            $createdAt = gmdate('Y-m-d H:i:s');
        }
        $rawUpdated = isset($row['updated_at']) && is_scalar($row['updated_at']) ? $row['updated_at'] : null;
        $timeUnknown = false;
        if ($rawUpdated !== null && is_numeric($rawUpdated) && (int) $rawUpdated > 946684800 && (int) $rawUpdated < 4102444800) {
            $updatedAt = gmdate('Y-m-d H:i:s', (int) $rawUpdated);
        } elseif ($rawUpdated !== null && trim((string) $rawUpdated) !== '') {
            $updatedAt = (string) $rawUpdated;
        } else {
            $updatedAt = $createdAt;
            // Neither time is the row's: both are the time of this read.
            $timeUnknown = $rawCreated === null || trim((string) $rawCreated) === '';
        }
        $status = self::statusOf($binding, $row);

        $metadata = [
            'nativeTable' => $binding['table'],
            'nativeAppId' => $binding['databaseAppId'],
            'nativeKey' => $keyMap,
        ];
        // Says so, so that the time read is never taken for a version (ResponseService::etagOf):
        // no two reads of the row would share it, and a client's If-Match never matched.
        if ($timeUnknown) {
            $metadata['timeUnknown'] = true;
        }
        $rowSubmitter = $row['_submitted_by_user_id'] ?? $row['submitted_by_user_id'] ?? null;
        if (is_string($rowSubmitter) && $rowSubmitter !== '') {
            $metadata['submittedByUserId'] = $rowSubmitter;
        }

        return [
            'id' => $id,
            'formId' => $binding['formId'],
            'answers' => $answers,
            'status' => $status,
            'submittedAt' => $createdAt,
            'updatedAt' => $updatedAt,
            'metadata' => $metadata,
        ];
    }

    /** @return array<string, mixed> */
    private function mapAnswersToColumns(array $binding, array $answers, array $fieldsByName, bool $isUpdate): array
    {
        $values = [];
        foreach ($binding['columns'] as $fieldId => $colName) {
            if (!array_key_exists($fieldId, $answers)) continue;
            $colLower = strtolower((string) $colName);
            // Authoritative submitter columns are set exclusively server-side on create.
            if ($colLower === '_submitted_by_user_id' || $colLower === 'submitted_by_user_id') {
                continue;
            }
            $meta = $fieldsByName[$colName] ?? null;
            if ($meta !== null) {
                if (!empty($meta['readOnly'])) continue;
                if ($isUpdate && !empty($meta['primary'])) continue;
            }
            $val = $answers[$fieldId];
            $sqlType = $meta !== null ? strtoupper((string) ($meta['type'] ?? '')) : '';
            $isInt = str_contains($sqlType, 'INT');
            $isReal = preg_match('/REAL|FLOA|DOUB|NUMERIC|DECIMAL/', $sqlType) === 1;
            // Unwrap linked_record answer shapes (`{ id: "3" }` or `["3"]`) for FK columns.
            if (is_array($val)) {
                if (isset($val['id']) && is_scalar($val['id'])) {
                    $val = $val['id'];
                } elseif (($isInt || $isReal || str_ends_with(strtolower($colName), '_id')) && array_is_list($val) && count($val) === 1) {
                    $first = $val[0];
                    $val = is_array($first) && isset($first['id']) && is_scalar($first['id']) ? $first['id'] : (is_scalar($first) ? $first : json_encode($val, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
                } else {
                    $val = json_encode($val, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
                }
            } elseif (is_bool($val)) {
                $val = $val ? 1 : 0;
            }
            if ($val === '' && ($isInt || $isReal)) {
                $val = null;
            } elseif ($isInt && is_string($val) && preg_match('/^-?\d+$/D', trim($val)) === 1) {
                $val = (int) trim($val);
            } elseif ($isReal && is_string($val) && is_numeric(trim($val))) {
                $val = (float) trim($val);
            }
            $values[$colName] = $val;
        }
        return $values;
    }

    /** @return array<string, string> */
    private function extractKeyFromRow(array $row, array $pkNames): array
    {
        $out = [];
        foreach ($pkNames as $col) {
            if (isset($row[$col]) && is_scalar($row[$col])) {
                $out[$col] = (string) $row[$col];
            }
        }
        return $out;
    }

    /** @return list<array{event: string, bindings: list<string>}> */
    private function subscriptionsFor(string $appId): array
    {
        if ($this->flows === null) return [];
        $group = $this->apps !== null ? $this->apps->sharedDatabaseGroupAppIds($appId) : [$appId];
        return $this->flows->nativeRecordSubscriptionsForApps($group);
    }

    private function dispatchEvents(string $appId): void
    {
        if (NativeAppService::hasSandboxRootOverrides()) {
            return;
        }
        $router = $this->recordEvents ?? ($this->recordEventsResolver !== null ? ($this->recordEventsResolver)() : null);
        if ($router === null) return;
        try {
            $this->native->dispatchRecordEvents($appId, $router->for($appId));
        } catch (\Throwable $e) {
            error_log('NativeTableFormBridge: event dispatch pending for app ' . $appId . ': ' . $e->getMessage());
        }
    }

    private function uuid(): string
    {
        $d = random_bytes(16);
        $d[6] = chr((ord($d[6]) & 0x0f) | 0x40);
        $d[8] = chr((ord($d[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($d), 4));
    }
}

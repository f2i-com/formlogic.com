<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\ReportService;
use PHPUnit\Framework\TestCase;

/**
 * Engine behaviour of the OPTIONAL spec.filterMode against real per-form SQLite (no MySQL):
 *  - 'any' with 2+ validated user filters ORs THOSE filters together in one parenthesized group,
 *  - 'all' / absent / junk modes / a single surviving filter behave exactly like today (AND chain),
 *  - the base conditions stay AND'd OUTSIDE the OR group: dateRange still constrains, own-scope still
 *    restricts, and an invalid filter (dropped by validation) never counts toward the 2+ threshold.
 */
class ReportFilterModeTest extends TestCase
{
    private string $tmp = '';
    private SQLiteConnection $sqlite;

    /** @var array<int, array<string, mixed>> */
    private array $fields = [
        ['id' => 'dept', 'type' => 'short_text', 'label' => 'Dept'],
        ['id' => 'stat', 'type' => 'short_text', 'label' => 'Stat'],
    ];

    protected function setUp(): void
    {
        $this->tmp = sys_get_temp_dir() . '/fl-filtermode-' . bin2hex(random_bytes(6));
        @mkdir($this->tmp, 0777, true);
        $this->sqlite = new SQLiteConnection($this->tmp);
    }

    protected function tearDown(): void
    {
        foreach (glob($this->tmp . '/*') ?: [] as $f) { @unlink($f); }
        @rmdir($this->tmp);
    }

    private function service(): ReportService
    {
        return new ReportService($this->sqlite);
    }

    private function insert(string $formId, string $id, array $answers, ?string $submittedAt = null, string $metadata = '{}'): void
    {
        $this->sqlite->getFormDatabase($formId)
            ->prepare("INSERT INTO responses (id, answers, metadata, status, submitted_at) VALUES (?, ?, ?, 'submitted', ?)")
            ->execute([$id, json_encode($answers), $metadata, $submittedAt ?? gmdate('Y-m-d H:i:s')]);
    }

    private function kpi(array $extra, string $formId, string $scope = 'all', ?string $userId = null): float
    {
        $spec = array_merge(['viz' => 'kpi', 'measure' => ['fn' => 'count']], $extra);
        $r = $this->service()->runReport($spec, $this->fields, $formId, $scope, $userId);
        return (float) $r['value'];
    }

    /** @var array<int, array{0:string,1:string}> dept/stat pairs: a+s1, a+s2, b+s1, b+s2 */
    private const GRID = [['a', 's1'], ['a', 's2'], ['b', 's1'], ['b', 's2']];

    private function seedGrid(string $form): void
    {
        foreach (self::GRID as $i => [$dept, $stat]) {
            $this->insert($form, 'r' . $i, ['dept' => $dept, 'stat' => $stat]);
        }
    }

    private const TWO_FILTERS = [
        ['field' => 'dept', 'op' => 'eq', 'value' => 'a'],
        ['field' => 'stat', 'op' => 'eq', 'value' => 's1'],
    ];

    public function testAnyModeMatchesEitherFilterWhileAllModeRequiresBoth(): void
    {
        $form = 'fmodegrid1';
        $this->seedGrid($form);

        $this->assertSame(1.0, $this->kpi(['filters' => self::TWO_FILTERS], $form), 'absent filterMode = AND: only a+s1');
        $this->assertSame(1.0, $this->kpi(['filters' => self::TWO_FILTERS, 'filterMode' => 'all'], $form), "'all' = AND: only a+s1");
        $this->assertSame(3.0, $this->kpi(['filters' => self::TWO_FILTERS, 'filterMode' => 'any'], $form), "'any' = OR: a+s1, a+s2, b+s1");
        $this->assertSame(1.0, $this->kpi(['filters' => self::TWO_FILTERS, 'filterMode' => 'or'], $form), 'junk modes behave like the default AND');
        $this->assertSame(1.0, $this->kpi(['filters' => self::TWO_FILTERS, 'filterMode' => 'ANY'], $form), 'the enum is case-sensitive');
    }

    public function testSingleFilterAnyEqualsAll(): void
    {
        $form = 'fmodegrid2';
        $this->seedGrid($form);
        $one = [['field' => 'dept', 'op' => 'eq', 'value' => 'a']];

        $this->assertSame(
            $this->kpi(['filters' => $one], $form),
            $this->kpi(['filters' => $one, 'filterMode' => 'any'], $form),
            'a single filter under any-mode is identical to all-mode'
        );
        $this->assertSame(2.0, $this->kpi(['filters' => $one, 'filterMode' => 'any'], $form));
        $this->assertSame(4.0, $this->kpi(['filterMode' => 'any'], $form), 'no filters at all: any-mode adds nothing');
    }

    public function testInvalidFilterDoesNotCountTowardTheAnyGroup(): void
    {
        $form = 'fmodegrid3';
        $this->seedGrid($form);
        // The second filter references an unknown field → dropped by validation, so only ONE validated
        // filter survives and any-mode must behave exactly like all-mode (no OR group).
        $filters = [
            ['field' => 'dept', 'op' => 'eq', 'value' => 'a'],
            ['field' => 'not_a_field', 'op' => 'eq', 'value' => 's1'],
        ];
        $this->assertSame(2.0, $this->kpi(['filters' => $filters, 'filterMode' => 'any'], $form));
    }

    public function testDateRangeStillConstrainsUnderAnyMode(): void
    {
        $form = 'fmoderange1';
        // Fresh: a+s1 (matches both). Stale (10 days old): a+s2 and b+s1 (each matches ONE filter).
        // Fresh b+s2 matches neither.
        $this->insert($form, 'r1', ['dept' => 'a', 'stat' => 's1']);
        $this->insert($form, 'r2', ['dept' => 'a', 'stat' => 's2'], gmdate('Y-m-d H:i:s', strtotime('-10 days')));
        $this->insert($form, 'r3', ['dept' => 'b', 'stat' => 's1'], gmdate('Y-m-d H:i:s', strtotime('-10 days')));
        $this->insert($form, 'r4', ['dept' => 'b', 'stat' => 's2']);

        $any = ['filters' => self::TWO_FILTERS, 'filterMode' => 'any'];
        $this->assertSame(3.0, $this->kpi($any, $form), 'without a range the OR group matches r1–r3');
        $this->assertSame(
            1.0,
            $this->kpi(array_merge($any, ['dateRange' => ['preset' => '7d']]), $form),
            'dateRange is AND\'d OUTSIDE the OR group: the stale single-filter matches drop out'
        );
    }

    public function testOwnScopeStaysAndedOutsideTheAnyGroup(): void
    {
        $form = 'fmodescope1';
        $meta = static fn (string $uid): string => json_encode(['submittedByUserId' => $uid]);
        $this->insert($form, 'r1', ['dept' => 'a', 'stat' => 's2'], null, $meta('u1'));
        $this->insert($form, 'r2', ['dept' => 'b', 'stat' => 's1'], null, $meta('u1'));
        $this->insert($form, 'r3', ['dept' => 'a', 'stat' => 's1'], null, $meta('u2'));

        $any = ['filters' => self::TWO_FILTERS, 'filterMode' => 'any'];
        $this->assertSame(3.0, $this->kpi($any, $form), 'owner scope sees every OR match');
        $this->assertSame(2.0, $this->kpi($any, $form, 'own', 'u1'), "own-scope excludes u2's row even though it matches both filters");
    }

    public function testAnyModeAppliesToChartSeriesToo(): void
    {
        $form = 'fmodeseries1';
        $this->seedGrid($form);
        $spec = [
            'viz' => 'bar',
            'groupBy' => ['field' => 'dept'],
            'measure' => ['fn' => 'count'],
            'filters' => self::TWO_FILTERS,
            'filterMode' => 'any',
            'seriesSort' => 'label',
        ];
        $r = $this->service()->runReport($spec, $this->fields, $form, 'all', null);
        $this->assertSame([
            ['label' => 'a', 'value' => 2.0],
            ['label' => 'b', 'value' => 1.0],
        ], $r['series'], 'the OR group feeds the grouped aggregation: a+s1, a+s2, b+s1');
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\ReportService;
use PHPUnit\Framework\TestCase;

/**
 * Engine behaviour of the OPTIONAL dateRange preset + seriesBy second dimension against real per-form
 * SQLite (no MySQL):
 *  - dateRange '7d' excludes older rows; 'thisMonth' starts at the 1st; 'all'/absent change nothing,
 *  - dateRange.field carries the range when it's a date-typed field, else falls back to __submitted_at,
 *  - seriesBy returns FLAT rows { label, value, series }, keeps the top-N series by total value and
 *    buckets the remainder into a literal 'Other',
 *  - seriesBy is IGNORED for pie (single-dim series) and kpi (plain value) — legacy shapes unchanged.
 */
class ReportDateRangeSeriesTest extends TestCase
{
    private string $tmp = '';
    private SQLiteConnection $sqlite;

    protected function setUp(): void
    {
        $this->tmp = sys_get_temp_dir() . '/fl-rangeseries-' . bin2hex(random_bytes(6));
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

    private function insert(string $formId, string $id, array $answers, string $submittedAt): void
    {
        $this->sqlite->getFormDatabase($formId)
            ->prepare("INSERT INTO responses (id, answers, metadata, status, submitted_at) VALUES (?, ?, '{}', 'submitted', ?)")
            ->execute([$id, json_encode($answers), $submittedAt]);
    }

    private function kpi(array $extra, array $fields, string $formId): float
    {
        $spec = array_merge(['viz' => 'kpi', 'measure' => ['fn' => 'count']], $extra);
        $r = $this->service()->runReport($spec, $fields, $formId, 'all', null);
        return (float) $r['value'];
    }

    // ── dateRange ────────────────────────────────────────────────────────────

    public function testDateRange7dExcludesOlderRows(): void
    {
        $form = 'rangeform7d1';
        $fields = [['id' => 'nm', 'type' => 'short_text', 'label' => 'Name']];
        $this->insert($form, 'r1', ['nm' => 'fresh'], gmdate('Y-m-d H:i:s', strtotime('-1 day')));
        $this->insert($form, 'r2', ['nm' => 'recent'], gmdate('Y-m-d H:i:s', strtotime('-3 days')));
        $this->insert($form, 'r3', ['nm' => 'stale'], gmdate('Y-m-d H:i:s', strtotime('-10 days')));
        $this->insert($form, 'r4', ['nm' => 'old'], gmdate('Y-m-d H:i:s', strtotime('-40 days')));

        $this->assertSame(2.0, $this->kpi(['dateRange' => ['preset' => '7d']], $fields, $form), '7d keeps only the last-7-days rows');
        $this->assertSame(3.0, $this->kpi(['dateRange' => ['preset' => '30d']], $fields, $form));
        $this->assertSame(4.0, $this->kpi(['dateRange' => ['preset' => 'all']], $fields, $form), "'all' adds no constraint");
        $this->assertSame(4.0, $this->kpi([], $fields, $form), 'absent dateRange = legacy behaviour');
        $this->assertSame(4.0, $this->kpi(['dateRange' => ['preset' => '14d']], $fields, $form), 'unknown presets are ignored');
    }

    public function testDateRangeThisMonthStartsAtTheFirst(): void
    {
        $form = 'rangeformmon1';
        $fields = [['id' => 'nm', 'type' => 'short_text', 'label' => 'Name']];
        $monthStartTs = strtotime(gmdate('Y-m-01 00:00:00'));
        $this->insert($form, 'r1', ['nm' => 'boundary'], gmdate('Y-m-01') . ' 00:00:00');           // 1st, 00:00 → in
        $this->insert($form, 'r2', ['nm' => 'lastmonth'], gmdate('Y-m-d H:i:s', $monthStartTs - 1)); // 1 second before → out
        $this->insert($form, 'r3', ['nm' => 'now'], gmdate('Y-m-d H:i:s'));                          // today → in

        $this->assertSame(2.0, $this->kpi(['dateRange' => ['preset' => 'thisMonth']], $fields, $form));
    }

    public function testKpiSparklineReturnsBucketedTrend(): void
    {
        $form = 'sparkform1';
        $fields = [['id' => 'nm', 'type' => 'short_text', 'label' => 'Name']];
        $this->insert($form, 'r1', ['nm' => 'a'], gmdate('Y-m-d H:i:s', strtotime('-2 days')));
        $this->insert($form, 'r2', ['nm' => 'b'], gmdate('Y-m-d H:i:s', strtotime('-1 day')));
        $this->insert($form, 'r3', ['nm' => 'c'], gmdate('Y-m-d H:i:s', strtotime('-1 day')));
        $this->insert($form, 'r4', ['nm' => 'd'], gmdate('Y-m-d H:i:s'));

        $spec = ['viz' => 'kpi', 'measure' => ['fn' => 'count'], 'sparkline' => true,
            'groupBy' => ['field' => '__submitted_at', 'bucket' => 'day']];
        $r = $this->service()->runReport($spec, $fields, $form, 'all', null);

        $this->assertSame(4.0, (float) $r['value'], 'the big number stays the plain total');
        $this->assertArrayHasKey('series', $r, 'sparkline + date-bucketed groupBy returns the trend');
        $this->assertCount(3, $r['series'], 'one point per day bucket');
        $this->assertSame([1.0, 2.0, 1.0], array_map(static fn ($p) => (float) $p['value'], $r['series']), 'chronological');

        // Without sparkline (legacy) or without a date bucket, the KPI shape is unchanged.
        $legacy = $this->service()->runReport(['viz' => 'kpi', 'measure' => ['fn' => 'count']], $fields, $form, 'all', null);
        $this->assertArrayNotHasKey('series', $legacy);
        $noBucket = $this->service()->runReport(array_merge($spec, ['groupBy' => ['field' => 'nm']]), $fields, $form, 'all', null);
        $this->assertArrayNotHasKey('series', $noBucket, 'a non-date-bucketed groupBy adds no sparkline');
    }

    public function testDateRangeFieldUsesDateFieldOrFallsBackToSubmittedAt(): void
    {
        $form = 'rangeformfld1';
        $fields = [
            ['id' => 'due', 'type' => 'date', 'label' => 'Due'],
            ['id' => 'nm', 'type' => 'short_text', 'label' => 'Name'],
        ];
        // Both rows submitted long ago; only r1's date FIELD is recent.
        $this->insert($form, 'r1', ['due' => gmdate('Y-m-d'), 'nm' => 'a'], gmdate('Y-m-d H:i:s', strtotime('-100 days')));
        $this->insert($form, 'r2', ['due' => gmdate('Y-m-d', strtotime('-50 days')), 'nm' => 'b'], gmdate('Y-m-d H:i:s', strtotime('-100 days')));

        $this->assertSame(1.0, $this->kpi(['dateRange' => ['preset' => '30d', 'field' => 'due']], $fields, $form), 'a date-typed field carries the range');
        $this->assertSame(0.0, $this->kpi(['dateRange' => ['preset' => '30d', 'field' => 'nm']], $fields, $form), 'a non-date field falls back to __submitted_at');
        $this->assertSame(0.0, $this->kpi(['dateRange' => ['preset' => '30d', 'field' => 'nope']], $fields, $form), 'an unknown ref falls back to __submitted_at');
        $this->assertSame(0.0, $this->kpi(['dateRange' => ['preset' => '30d']], $fields, $form), 'default is __submitted_at');
    }

    // ── seriesBy ─────────────────────────────────────────────────────────────

    /** @var array<int, array<string, mixed>> */
    private array $seriesFields = [
        ['id' => 'dept', 'type' => 'dropdown', 'label' => 'Dept', 'properties' => ['options' => [
            ['value' => 'a', 'label' => 'Alpha'],
            ['value' => 'b', 'label' => 'Beta'],
        ]]],
        ['id' => 'stat', 'type' => 'short_text', 'label' => 'Stat'],
    ];

    private function seedSeriesForm(string $form): void
    {
        $now = gmdate('Y-m-d H:i:s');
        $i = 0;
        $rows = [
            // dept a: s1 ×5, s2 ×3, s3 ×1 (total 9) — dept b: s1 ×2, s3 ×1 (total 3)
            ...array_fill(0, 5, ['a', 's1']),
            ...array_fill(0, 3, ['a', 's2']),
            ['a', 's3'],
            ...array_fill(0, 2, ['b', 's1']),
            ['b', 's3'],
        ];
        foreach ($rows as [$dept, $stat]) {
            $this->insert($form, 'r' . $i++, ['dept' => $dept, 'stat' => $stat], $now);
        }
    }

    public function testSeriesByReturnsFlatRowsAndBucketsOverflowIntoOther(): void
    {
        $form = 'seriesform111';
        $this->seedSeriesForm($form);
        $spec = [
            'viz' => 'bar',
            'groupBy' => ['field' => 'dept'],
            'measure' => ['fn' => 'count'],
            'seriesBy' => ['field' => 'stat', 'limit' => 2],
        ];
        $r = $this->service()->runReport($spec, $this->seriesFields, $form, 'all', null);
        $this->assertSame('bar', $r['viz']);
        // Series totals: s1=7, s2=3, s3=2 → top-2 kept (s1, s2), s3 → 'Other'. Labels by total desc
        // (Alpha 9, Beta 3) and mapped to option labels; rows stay FLAT with a 'series' key.
        $this->assertSame([
            ['label' => 'Alpha', 'value' => 5.0, 'series' => 's1'],
            ['label' => 'Alpha', 'value' => 3.0, 'series' => 's2'],
            ['label' => 'Alpha', 'value' => 1.0, 'series' => 'Other'],
            ['label' => 'Beta', 'value' => 2.0, 'series' => 's1'],
            ['label' => 'Beta', 'value' => 1.0, 'series' => 'Other'],
        ], $r['series']);
    }

    public function testSeriesByWithinLimitHasNoOtherBucket(): void
    {
        $form = 'seriesform222';
        $this->seedSeriesForm($form);
        $spec = [
            'viz' => 'bar',
            'groupBy' => ['field' => 'dept'],
            'measure' => ['fn' => 'count'],
            'seriesBy' => ['field' => 'stat'], // default limit 5 ≥ 3 distinct series
        ];
        $r = $this->service()->runReport($spec, $this->seriesFields, $form, 'all', null);
        $names = array_unique(array_column($r['series'], 'series'));
        $this->assertNotContains('Other', $names);
        $this->assertSame(12.0, array_sum(array_column($r['series'], 'value')), 'every response is represented exactly once');
    }

    public function testSeriesByIsIgnoredForPieAndKpi(): void
    {
        $form = 'seriesform333';
        $this->seedSeriesForm($form);
        $base = [
            'groupBy' => ['field' => 'dept'],
            'measure' => ['fn' => 'count'],
            'seriesBy' => ['field' => 'stat', 'limit' => 2],
        ];

        $pie = $this->service()->runReport(array_merge($base, ['viz' => 'pie']), $this->seriesFields, $form, 'all', null);
        $this->assertSame([
            ['label' => 'Alpha', 'value' => 9.0],
            ['label' => 'Beta', 'value' => 3.0],
        ], $pie['series'], 'pie stays single-dimension: no series key on rows');

        $kpi = $this->service()->runReport(array_merge($base, ['viz' => 'kpi']), $this->seriesFields, $form, 'all', null);
        $this->assertSame(['viz' => 'kpi', 'value' => 12.0], $kpi, 'kpi shape is unchanged');
    }

    public function testSeriesByUnknownFieldFallsBackToSingleDimension(): void
    {
        $form = 'seriesform444';
        $this->seedSeriesForm($form);
        $spec = [
            'viz' => 'bar',
            'groupBy' => ['field' => 'dept'],
            'measure' => ['fn' => 'count'],
            'seriesBy' => ['field' => 'not_a_field'],
        ];
        $r = $this->service()->runReport($spec, $this->seriesFields, $form, 'all', null);
        $this->assertSame([
            ['label' => 'Alpha', 'value' => 9.0],
            ['label' => 'Beta', 'value' => 3.0],
        ], $r['series'], 'an unresolvable seriesBy ref never reaches SQL — legacy single-dim result');
    }
}

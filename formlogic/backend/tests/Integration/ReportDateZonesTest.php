<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\ReportService;
use PHPUnit\Framework\TestCase;

/**
 * What a report does with time, on real per-form SQLite. A date answer is a calendar date and a
 * zone-less datetime answer a wall clock, so the app's zone must not move them. Only a submission
 * time is an instant, and it moves into the app's zone by the offset of its own moment.
 */
class ReportDateZonesTest extends TestCase
{
    private string $tmp = '';
    private SQLiteConnection $sqlite;

    /** @var array<int, array<string, mixed>> */
    private array $fields = [
        ['id' => 'day', 'type' => 'date', 'label' => 'Day'],
        ['id' => 'at', 'type' => 'datetime', 'label' => 'At'],
        ['id' => 'amount', 'type' => 'number', 'label' => 'Amount'],
    ];

    protected function setUp(): void
    {
        $this->tmp = sys_get_temp_dir() . '/fl-reportzones-' . bin2hex(random_bytes(6));
        @mkdir($this->tmp, 0777, true);
        $this->sqlite = new SQLiteConnection($this->tmp);
    }

    protected function tearDown(): void
    {
        foreach (glob($this->tmp . '/*') ?: [] as $f) { @unlink($f); }
        @rmdir($this->tmp);
    }

    private function insert(string $form, array $answers, string $submittedAt = '2026-03-15 12:00:00'): void
    {
        $this->sqlite->getFormDatabase($form)
            ->prepare("INSERT INTO responses (id, answers, metadata, status, submitted_at) VALUES (?, ?, '{}', 'submitted', ?)")
            ->execute([bin2hex(random_bytes(8)), json_encode($answers), $submittedAt]);
    }

    /** @return array<string, float> label => value */
    private function series(string $form, string $field, string $bucket, string $zone, array $measure = ['fn' => 'sum', 'field' => 'amount']): array
    {
        $spec = ['viz' => 'bar', 'groupBy' => ['field' => $field, 'bucket' => $bucket], 'measure' => $measure];
        $out = [];
        foreach ((new ReportService($this->sqlite))->runReport($spec, $this->fields, $form, 'all', null, [], $zone)['series'] as $point) {
            $out[$point['label']] = $point['value'];
        }
        return $out;
    }

    private function matching(string $form, array $spec, string $zone): float
    {
        $spec += ['viz' => 'kpi', 'measure' => ['fn' => 'count']];
        return (float) (new ReportService($this->sqlite))->runReport($spec, $this->fields, $form, 'all', null, [], $zone)['value'];
    }

    /** Amounts 100 on 1 March, 200 on 31 March and 400 on 1 April. */
    private function seedAmounts(string $form): void
    {
        foreach ([['2026-03-01', 100], ['2026-03-31', 200], ['2026-04-01', 400]] as [$day, $amount]) {
            $this->insert($form, ['day' => $day, 'at' => $day . 'T14:30', 'amount' => $amount]);
        }
    }

    public static function zones(): array
    {
        return [
            'UTC' => ['UTC'],
            'west of Greenwich' => ['America/New_York'],
            'far east' => ['Australia/Sydney'],
            'half an hour off' => ['Asia/Kolkata'],
            'an offset, not a named zone' => ['+09:30'],
        ];
    }

    /** @dataProvider zones */
    public function testADateAnswerStaysOnItsOwnDayInEveryZone(string $zone): void
    {
        $this->seedAmounts('dates');
        $this->assertSame(['2026-03' => 300.0, '2026-04' => 400.0], $this->series('dates', 'day', 'month', $zone));
        $this->assertSame(['2026-03-01' => 100.0, '2026-03-31' => 200.0, '2026-04-01' => 400.0], $this->series('dates', 'day', 'day', $zone));
    }

    /** @dataProvider zones */
    public function testAWallClockAnswerStaysOnItsOwnDayInEveryZone(string $zone): void
    {
        $this->seedAmounts('clocks');
        $this->assertSame(['2026-03' => 300.0, '2026-04' => 400.0], $this->series('clocks', 'at', 'month', $zone));
        $this->assertSame(['2026-03-01' => 100.0, '2026-03-31' => 200.0, '2026-04-01' => 400.0], $this->series('clocks', 'at', 'day', $zone));
    }

    public function testAClockWrittenWithoutALeadingZeroStillHasADay(): void
    {
        $this->insert('short', ['at' => '2026-03-31 9:30', 'amount' => 5]);
        $this->assertSame(['2026-03-31' => 5.0], $this->series('short', 'at', 'day', 'Australia/Sydney'));
    }

    public function testADatetimeAnswerThatNamesAZoneIsAnInstant(): void
    {
        $this->insert('zoned', ['at' => '2026-03-31T23:30:00Z', 'amount' => 5]);
        $this->insert('zoned', ['at' => '2026-03-31T23:30:00+11:00', 'amount' => 7]);
        // 23:30 UTC is the next morning in Sydney; 23:30 at +11 is that evening there.
        $this->assertSame(['2026-03-31' => 7.0, '2026-04-01' => 5.0], $this->series('zoned', 'at', 'day', 'Australia/Sydney'));
    }

    public function testTodayOnADateFieldIsTheAppsToday(): void
    {
        $today = (new \DateTimeImmutable('now', new \DateTimeZone('America/New_York')))->format('Y-m-d');
        $this->insert('today', ['day' => $today, 'at' => $today . 'T00:15']);
        $this->insert('today', ['day' => '2020-01-01', 'at' => '2020-01-01T23:45']);
        $filter = static fn (string $field): array => ['filters' => [['field' => $field, 'op' => 'today']]];
        $this->assertSame(1.0, $this->matching('today', $filter('day'), 'America/New_York'));
        $this->assertSame(1.0, $this->matching('today', $filter('at'), 'America/New_York'));
    }

    public function testRelativeFiltersOnASubmissionUseTheAppsZoneForTheBoundary(): void
    {
        $tz = new \DateTimeZone('Pacific/Auckland');
        $now = new \DateTimeImmutable('now', $tz);
        // Each row sits one minute inside or outside the app's day, wherever UTC's day is then.
        $startOfDay = $now->setTime(0, 0);
        $utc = static fn (\DateTimeImmutable $t): string => $t->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s');
        $this->insert('relative', [], $utc($startOfDay->modify('+1 minute')));
        $this->insert('relative', [], $utc($startOfDay->modify('-1 minute')));
        $this->assertSame(1.0, $this->matching('relative', ['filters' => [['field' => '__submitted_at', 'op' => 'today']]], 'Pacific/Auckland'));
        $startOfMonth = $now->modify('first day of this month')->setTime(0, 0);
        $this->insert('month', [], $utc($startOfMonth->modify('+1 minute')));
        $this->insert('month', [], $utc($startOfMonth->modify('-1 minute')));
        $this->assertSame(1.0, $this->matching('month', ['filters' => [['field' => '__submitted_at', 'op' => 'this_month']]], 'Pacific/Auckland'));
        $this->assertSame(1.0, $this->matching('month', ['dateRange' => ['preset' => 'thisMonth']], 'Pacific/Auckland'));
    }

    public function testASubmissionTakesTheOffsetOfItsOwnMoment(): void
    {
        // 23:30 on 30 June at +10, and 00:30 on 1 February at +11: no one offset files both right.
        $this->insert('own', ['amount' => 1], '2026-06-30 13:30:00');
        $this->insert('own', ['amount' => 2], '2026-01-31 13:30:00');
        $this->assertSame(['2026-02' => 2.0, '2026-06' => 1.0], $this->series('own', '__submitted_at', 'month', 'Australia/Sydney'));
        $this->assertSame(['2026-02-01' => 2.0, '2026-06-30' => 1.0], $this->series('own', '__submitted_at', 'day', 'Australia/Sydney'));
    }

    public function testZonesWithHalfHourSummerTimeAndDifferentHemispheres(): void
    {
        // Lord Howe moves by half an hour: +11 in January, +10:30 in June.
        $this->insert('howe', ['amount' => 1], '2026-01-31 13:15:00');
        $this->insert('howe', ['amount' => 2], '2026-06-30 13:15:00');
        $this->assertSame(['2026-02-01' => 1.0, '2026-06-30' => 2.0], $this->series('howe', '__submitted_at', 'day', 'Australia/Lord_Howe'));
        // New York: -5 in January, -4 in July.
        $this->insert('york', ['amount' => 1], '2026-02-01 04:30:00');
        $this->insert('york', ['amount' => 2], '2026-08-01 03:30:00');
        $this->assertSame(['2026-01-31' => 1.0, '2026-07-31' => 2.0], $this->series('york', '__submitted_at', 'day', 'America/New_York'));
    }

    public function testTheChangeOfClocksFallsOnTheRightSecond(): void
    {
        // Havana's clocks go back at 01:00 on 1 November 2026 (05:00 UTC), to midnight: an hour of
        // that day happens twice, and neither side of the change lands in October.
        $this->insert('havana', ['amount' => 1], '2026-11-01 03:59:59');
        $this->insert('havana', ['amount' => 2], '2026-11-01 04:00:00');
        $this->insert('havana', ['amount' => 4], '2026-11-01 05:00:00');
        $this->assertSame(['2026-10-31' => 1.0, '2026-11-01' => 6.0], $this->series('havana', '__submitted_at', 'day', 'America/Havana'));
    }

    public function testAMonthlyTotalReadsTheSameAcrossTheYearsAFormSpans(): void
    {
        // Summer time ended on 25 March in 2007 and ends on 5 April in 2026, so the same evening
        // has a different offset in each year. Both rows are 00:30 on 1 April.
        $this->insert('years', ['amount' => 1], '2007-03-31 14:30:00');
        $this->insert('years', ['amount' => 2], '2026-03-31 13:30:00');
        $this->assertSame(['2007-04' => 1.0, '2026-04' => 2.0], $this->series('years', '__submitted_at', 'month', 'Australia/Sydney'));
    }

    public function testADateFilterOnASubmissionAgreesWithItsBucket(): void
    {
        $this->insert('agree', [], '2026-03-31 14:00:00'); // 1 April in Sydney
        $on = static fn (string $op, string $value): array => ['filters' => [['field' => '__submitted_at', 'op' => $op, 'value' => $value]]];
        $this->assertSame(1.0, $this->matching('agree', $on('eq', '2026-04-01'), 'Australia/Sydney'));
        $this->assertSame(0.0, $this->matching('agree', $on('eq', '2026-03-31'), 'Australia/Sydney'));
    }

    public function testADateFilterOnADateAnswerComparesTheDateItSays(): void
    {
        $this->seedAmounts('compare');
        $on = static fn (string $field, string $value): array => ['filters' => [['field' => $field, 'op' => 'eq', 'value' => $value]]];
        $this->assertSame(1.0, $this->matching('compare', $on('day', '2026-03-31'), 'America/New_York'));
        $this->assertSame(1.0, $this->matching('compare', $on('at', '2026-03-31'), 'Australia/Sydney'));
    }

    public function testATableShowsASubmissionOnTheAppsClock(): void
    {
        $this->insert('table', [], '2026-03-31 14:00:00');
        $this->insert('table', [], '2026-06-30 13:30:00');
        $result = (new ReportService($this->sqlite))->runReport(
            ['viz' => 'table', 'columns' => ['__submitted_at']],
            $this->fields,
            'table',
            'all',
            null,
            [],
            'Australia/Sydney'
        );
        $this->assertSame(['2026-06-30 23:30:00', '2026-04-01 01:00:00'], array_column($result['rows'], 'c0'));
    }

    public function testASparklineBucketsAsTheChartDoes(): void
    {
        $this->seedAmounts('spark');
        $result = (new ReportService($this->sqlite))->runReport(
            ['viz' => 'kpi', 'measure' => ['fn' => 'sum', 'field' => 'amount'], 'sparkline' => true, 'groupBy' => ['field' => 'day', 'bucket' => 'month']],
            $this->fields,
            'spark',
            'all',
            null,
            [],
            'America/New_York'
        );
        $this->assertSame([['label' => '2026-03', 'value' => 300.0], ['label' => '2026-04', 'value' => 400.0]], $result['series']);
    }

    public function testAnUnknownZoneReadsAsUtc(): void
    {
        $this->insert('junk', ['amount' => 1], '2026-03-31 23:30:00');
        $this->assertSame(['2026-03-31' => 1.0], $this->series('junk', '__submitted_at', 'day', 'Not/AZone'));
    }
}

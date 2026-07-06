<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\AppReportService;
use FormLogic\Services\AppService;
use FormLogic\Services\FormService;
use PHPUnit\Framework\TestCase;

/**
 * Save-boundary whitelisting of the OPTIONAL dashboard-range/series additions: dateRange (preset enum +
 * field-ref validated), seriesBy (field-ref validated, limit clamped 2..8), sparkline / showRangePicker /
 * linkToRecords booleans, and the list widget's metaField. Covers cleanChartSpec (via sanitizeDashboard)
 * AND the anonymous public path, whose field validator additionally restricts refs to the
 * publicRecordFields whitelist.
 */
class ReportRangeSeriesSanitizeTest extends TestCase
{
    private function service(): AppReportService
    {
        // sanitizeDashboard/sanitizePublicSpec take fields directly and never touch these collaborators.
        return new AppReportService(
            $this->createMock(AppService::class),
            $this->createMock(FormService::class)
        );
    }

    /** [formId => [fieldId => fieldDef]] */
    private function formFields(): array
    {
        return [
            'formA' => [
                'status' => ['id' => 'status', 'type' => 'dropdown', 'properties' => ['options' => [['value' => 'open', 'label' => 'Open']]]],
                'amount' => ['id' => 'amount', 'type' => 'number'],
                'when' => ['id' => 'when', 'type' => 'date'],
            ],
        ];
    }

    private function sanitizeWidgetSpec(array $spec): array
    {
        $dash = ['version' => 1, 'widgets' => [[
            'id' => 'w1', 'kind' => 'report',
            'layout' => ['x' => 0, 'y' => 0, 'w' => 6, 'h' => 3],
            'spec' => $spec,
        ]]];
        $out = $this->service()->sanitizeDashboard($dash, $this->formFields());
        $this->assertCount(1, $out['widgets']);
        return $out['widgets'][0]['spec'];
    }

    public function testValidDateRangeSeriesByAndSparklineSurviveTheSave(): void
    {
        $spec = $this->sanitizeWidgetSpec([
            'formId' => 'formA', 'viz' => 'bar',
            'groupBy' => ['field' => 'when', 'bucket' => 'month'], 'measure' => ['fn' => 'count'],
            'dateRange' => ['preset' => '30d', 'field' => 'when'],
            'seriesBy' => ['field' => 'status', 'limit' => 99], // clamped to 8
            'sparkline' => true,
        ]);
        $this->assertSame(['preset' => '30d', 'field' => 'when'], $spec['dateRange']);
        $this->assertSame(['field' => 'status', 'limit' => 8], $spec['seriesBy']);
        $this->assertTrue($spec['sparkline']);
    }

    public function testSeriesByLimitClampsLowAndDefaultsToAbsent(): void
    {
        $spec = $this->sanitizeWidgetSpec([
            'formId' => 'formA', 'viz' => 'bar',
            'groupBy' => ['field' => 'status'], 'measure' => ['fn' => 'count'],
            'seriesBy' => ['field' => 'status', 'limit' => 0],
        ]);
        $this->assertSame(2, $spec['seriesBy']['limit']);

        $spec = $this->sanitizeWidgetSpec([
            'formId' => 'formA', 'viz' => 'bar',
            'groupBy' => ['field' => 'status'], 'measure' => ['fn' => 'count'],
            'seriesBy' => ['field' => 'status'],
        ]);
        $this->assertArrayNotHasKey('limit', $spec['seriesBy'], 'absent limit stays absent (engine default 5)');
    }

    public function testInvalidRangeOrSeriesPiecesAreDropped(): void
    {
        $spec = $this->sanitizeWidgetSpec([
            'formId' => 'formA', 'viz' => 'bar',
            'groupBy' => ['field' => 'status'], 'measure' => ['fn' => 'count'],
            'dateRange' => ['preset' => '14d'],                    // not in the preset enum → dropped
            'seriesBy' => ['field' => 'not_a_field'],              // unknown ref → dropped
            'sparkline' => 'yes',                                  // non-boolean → dropped
        ]);
        $this->assertArrayNotHasKey('dateRange', $spec);
        $this->assertArrayNotHasKey('seriesBy', $spec);
        $this->assertArrayNotHasKey('sparkline', $spec);

        // A bad dateRange FIELD is dropped but the preset survives (engine defaults to __submitted_at);
        // an undeclared-join seriesBy ref is rejected the same way groupBy would reject it.
        $spec = $this->sanitizeWidgetSpec([
            'formId' => 'formA', 'viz' => 'line',
            'groupBy' => ['field' => 'when', 'bucket' => 'day'], 'measure' => ['fn' => 'count'],
            'dateRange' => ['preset' => '7d', 'field' => 'not_a_field'],
            'seriesBy' => ['field' => 'otherform::status'],
        ]);
        $this->assertSame(['preset' => '7d'], $spec['dateRange']);
        $this->assertArrayNotHasKey('seriesBy', $spec);
    }

    public function testPublicSanitizeRejectsNonWhitelistedRangeAndSeriesFields(): void
    {
        $out = $this->service()->sanitizePublicSpec([
            'formId' => 'formA', 'viz' => 'bar',
            'groupBy' => ['field' => 'status'], 'measure' => ['fn' => 'count'],
            'dateRange' => ['preset' => '90d', 'field' => 'secret'],  // field NOT in publicRecordFields → dropped
            'seriesBy' => ['field' => 'secret', 'limit' => 3],        // field NOT in publicRecordFields → whole seriesBy dropped
            'sparkline' => true,
        ], 'formA', ['status']);
        $this->assertSame(['preset' => '90d'], $out['dateRange'], 'the preset is safe; the private field ref is not');
        $this->assertArrayNotHasKey('seriesBy', $out);
        $this->assertTrue($out['sparkline']);
    }

    public function testPublicSanitizeKeepsWhitelistedRangeAndSeriesFields(): void
    {
        $out = $this->service()->sanitizePublicSpec([
            'formId' => 'formA', 'viz' => 'area',
            'groupBy' => ['field' => '__submitted_at', 'bucket' => 'month'], 'measure' => ['fn' => 'count'],
            'dateRange' => ['preset' => 'ytd'],                       // field defaults to __submitted_at
            'seriesBy' => ['field' => 'status', 'limit' => 3],
        ], 'formA', ['status']);
        $this->assertSame(['preset' => 'ytd'], $out['dateRange']);
        $this->assertSame(['field' => 'status', 'limit' => 3], $out['seriesBy']);
    }

    public function testShowRangePickerAndListAdditionsSurviveSanitize(): void
    {
        $dash = [
            'version' => 1,
            'showRangePicker' => false,
            'widgets' => [[
                'id' => 'w1', 'kind' => 'list',
                'layout' => ['x' => 0, 'y' => 0, 'w' => 4, 'h' => 3],
                'list' => ['formId' => 'formA', 'titleField' => 'status', 'metaField' => 'amount', 'linkToRecords' => true],
            ]],
        ];
        $out = $this->service()->sanitizeDashboard($dash, $this->formFields());
        $this->assertFalse($out['showRangePicker']);
        $this->assertSame('amount', $out['widgets'][0]['list']['metaField']);
        $this->assertTrue($out['widgets'][0]['list']['linkToRecords']);
    }

    public function testHostileShowRangePickerAndListAdditionsAreDropped(): void
    {
        $dash = [
            'version' => 1,
            'showRangePicker' => 'nah',                                // non-boolean → dropped
            'widgets' => [[
                'id' => 'w1', 'kind' => 'list',
                'layout' => ['x' => 0, 'y' => 0, 'w' => 4, 'h' => 3],
                'list' => ['formId' => 'formA', 'metaField' => 'nope', 'linkToRecords' => 1],
            ]],
        ];
        $out = $this->service()->sanitizeDashboard($dash, $this->formFields());
        $this->assertArrayNotHasKey('showRangePicker', $out);
        $this->assertArrayNotHasKey('metaField', $out['widgets'][0]['list']);
        $this->assertArrayNotHasKey('linkToRecords', $out['widgets'][0]['list']);
    }
}

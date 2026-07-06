<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\AppReportService;
use FormLogic\Services\AppService;
use FormLogic\Services\FormService;
use PHPUnit\Framework\TestCase;

/**
 * The OPTIONAL presentation fields on a report spec (color/format/decimals/prefix/suffix/
 * showDataLabels/target/horizontal/seriesOrder) must round-trip the save boundary — the whitelist
 * keeps valid values (so the customizer's choices persist) and rejects hostile/malformed ones.
 * Covers both cleanChartSpec (via sanitizeDashboard) and the anonymous public path.
 */
class ReportPresentationSanitizeTest extends TestCase
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

    public function testValidPresentationFieldsSurviveTheSave(): void
    {
        $spec = $this->sanitizeWidgetSpec([
            'formId' => 'formA', 'viz' => 'bar',
            'groupBy' => ['field' => 'status', 'bucket' => 'none'], 'measure' => ['fn' => 'count'],
            'color' => 'teal',
            'format' => 'currency',
            'decimals' => 2,
            'prefix' => '€',
            'suffix' => 'kg',
            'showDataLabels' => false,
            'target' => 150.5,
            'horizontal' => false,
            'seriesOrder' => 'label_desc',
        ]);
        $this->assertSame('teal', $spec['color']);
        $this->assertSame('currency', $spec['format']);
        $this->assertSame(2, $spec['decimals']);
        $this->assertSame('€', $spec['prefix']);
        $this->assertSame('kg', $spec['suffix']);
        $this->assertFalse($spec['showDataLabels']);
        $this->assertSame(150.5, $spec['target']);
        $this->assertFalse($spec['horizontal']);
        $this->assertSame('label_desc', $spec['seriesOrder']);
    }

    public function testHostileOrMalformedPresentationValuesAreDroppedOrClamped(): void
    {
        $spec = $this->sanitizeWidgetSpec([
            'formId' => 'formA', 'viz' => 'bar',
            'groupBy' => ['field' => 'status', 'bucket' => 'none'], 'measure' => ['fn' => 'count'],
            'color' => '#ff0000;<script>',        // not in the named-accent enum → dropped
            'format' => 'exponential',            // not a known format → dropped
            'decimals' => 99,                     // clamped to 2
            'prefix' => str_repeat('A', 500),     // clamped to 8 chars
            'suffix' => ['nested' => 'array'],    // non-scalar → dropped by the is_scalar guard
            'showDataLabels' => 'yes',            // non-boolean → dropped
            'target' => 'DROP TABLE',             // non-numeric → dropped
            'horizontal' => 0,                    // non-boolean → dropped
            'seriesOrder' => 'rand()',            // not in the enum → dropped
        ]);
        $this->assertArrayNotHasKey('color', $spec);
        $this->assertArrayNotHasKey('format', $spec);
        $this->assertSame(2, $spec['decimals']);
        $this->assertSame(8, mb_strlen($spec['prefix']));
        $this->assertArrayNotHasKey('suffix', $spec);
        $this->assertArrayNotHasKey('showDataLabels', $spec);
        $this->assertArrayNotHasKey('target', $spec);
        $this->assertArrayNotHasKey('horizontal', $spec);
        $this->assertArrayNotHasKey('seriesOrder', $spec);
    }

    public function testInfiniteTargetIsRejected(): void
    {
        $spec = $this->sanitizeWidgetSpec([
            'formId' => 'formA', 'viz' => 'kpi', 'measure' => ['fn' => 'count'],
            'target' => '1e999', // numeric string that overflows to INF → rejected
        ]);
        $this->assertArrayNotHasKey('target', $spec);
    }

    public function testPublicSpecPassesPresentationThroughTheSameWhitelist(): void
    {
        $out = $this->service()->sanitizePublicSpec([
            'formId' => 'formA', 'viz' => 'area',
            'groupBy' => ['field' => 'status', 'bucket' => 'none'], 'measure' => ['fn' => 'count'],
            'color' => 'green',
            'format' => 'percent',
            'target' => 80,
            'seriesOrder' => 'value_asc',
            'horizontal' => 'DROP',   // non-boolean → dropped even publicly
        ], 'formA', ['status']);
        $this->assertSame('green', $out['color']);
        $this->assertSame('percent', $out['format']);
        $this->assertSame(80, $out['target']);
        $this->assertSame('value_asc', $out['seriesOrder']);
        $this->assertArrayNotHasKey('horizontal', $out);
    }
}

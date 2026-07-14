<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\AppReportService;
use FormLogic\Services\AppService;
use FormLogic\Services\FormService;
use PHPUnit\Framework\TestCase;

/**
 * Save-boundary whitelisting of the OPTIONAL filterMode + dashboard refreshInterval additions:
 *  - filterMode: only the literal 'any' persists ('all' is the engine default and is omitted; junk is
 *    dropped) — enforced on BOTH the app save path (cleanChartSpec via sanitizeDashboard) and the
 *    anonymous public path (sanitizePublicSpec),
 *  - refreshInterval: dashboard-level, integer seconds, only 30 | 60 | 300 persist.
 */
class FilterModeRefreshSanitizeTest extends TestCase
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

    private function baseSpec(array $extra): array
    {
        return array_merge([
            'formId' => 'formA', 'viz' => 'bar',
            'groupBy' => ['field' => 'status'], 'measure' => ['fn' => 'count'],
            'filters' => [
                ['field' => 'status', 'op' => 'eq', 'value' => 'open'],
                ['field' => 'amount', 'op' => 'gt', 'value' => '5'],
            ],
        ], $extra);
    }

    // ── filterMode ───────────────────────────────────────────────────────────

    public function testFilterModeAnySurvivesTheAppSave(): void
    {
        $spec = $this->sanitizeWidgetSpec($this->baseSpec(['filterMode' => 'any']));
        $this->assertSame('any', $spec['filterMode']);
        $this->assertCount(2, $spec['filters']);
    }

    public function testFilterModeAllAndJunkModesAreOmitted(): void
    {
        // 'all' is the default → never stored.
        $spec = $this->sanitizeWidgetSpec($this->baseSpec(['filterMode' => 'all']));
        $this->assertArrayNotHasKey('filterMode', $spec);

        foreach (['or', 'ANY', 'Any', '', 1, true, ['any'], null] as $junk) {
            $spec = $this->sanitizeWidgetSpec($this->baseSpec(['filterMode' => $junk]));
            $this->assertArrayNotHasKey('filterMode', $spec, 'junk mode must be dropped: ' . var_export($junk, true));
        }
    }

    public function testPublicSanitizeKeepsAnyAndDropsJunkModes(): void
    {
        $svc = $this->service();
        $spec = [
            'formId' => 'formA', 'viz' => 'bar',
            'groupBy' => ['field' => 'status'], 'measure' => ['fn' => 'count'],
            'filters' => [
                ['field' => 'status', 'op' => 'eq', 'value' => 'open'],
                ['field' => 'status', 'op' => 'eq', 'value' => 'closed'],
            ],
            'filterMode' => 'any',
        ];
        $out = $svc->sanitizePublicSpec($spec, 'formA', ['status']);
        $this->assertSame('any', $out['filterMode'], 'an OR of whitelisted filters is safe on the public link');

        $out = $svc->sanitizePublicSpec(array_merge($spec, ['filterMode' => 'or']), 'formA', ['status']);
        $this->assertArrayNotHasKey('filterMode', $out);
    }

    // ── refreshInterval ──────────────────────────────────────────────────────

    private function sanitizeDash(array $extra): array
    {
        $dash = array_merge(['version' => 1, 'widgets' => []], $extra);
        return $this->service()->sanitizeDashboard($dash, $this->formFields());
    }

    public function testRefreshIntervalKeepsTheThreeAllowedSteps(): void
    {
        foreach ([30, 60, 300] as $secs) {
            $out = $this->sanitizeDash(['refreshInterval' => $secs]);
            $this->assertSame($secs, $out['refreshInterval']);
        }
    }

    public function testRefreshIntervalDropsJunkValues(): void
    {
        foreach ([0, -30, 45, 90, 3000, 30.5, '5m', 'soon', true, [30], null] as $junk) {
            $out = $this->sanitizeDash(['refreshInterval' => $junk]);
            $this->assertArrayNotHasKey('refreshInterval', $out, 'junk interval must be dropped: ' . var_export($junk, true));
        }
        $out = $this->sanitizeDash([]);
        $this->assertArrayNotHasKey('refreshInterval', $out, 'absent stays absent (= off)');
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\AppReportService;
use FormLogic\Services\AppService;
use FormLogic\Services\FormService;
use PHPUnit\Framework\TestCase;

/**
 * The widget-dashboard save boundary + public-link report execution must be safe by construction:
 *  - sanitizeDashboard drops widgets whose report spec / list form isn't in scope and clamps geometry.
 *  - sanitizePublicSpec restricts field refs to the publicRecordFields whitelist, strips cross-form
 *    joins, and never exposes __status on an anonymous public link.
 * Both operate on data passed in, so they can be unit-tested without a database.
 */
class DashboardSanitizeTest extends TestCase
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

    public function testDashboardKeepsValidReportWidgetAndClampsLayout(): void
    {
        $svc = $this->service();
        $dash = [
            'version' => 1,
            'cols' => 12,
            'widgets' => [[
                'id' => 'w1',
                'kind' => 'report',
                'title' => 'By status',
                'layout' => ['x' => 20, 'y' => -3, 'w' => 40, 'h' => 99], // out of bounds → clamped
                'spec' => ['formId' => 'formA', 'viz' => 'bar', 'groupBy' => ['field' => 'status', 'bucket' => 'none'], 'measure' => ['fn' => 'count']],
            ]],
        ];
        $out = $svc->sanitizeDashboard($dash, $this->formFields());
        $this->assertCount(1, $out['widgets']);
        $w = $out['widgets'][0];
        $this->assertSame('report', $w['kind']);
        $this->assertGreaterThanOrEqual(0, $w['layout']['x']);
        $this->assertLessThanOrEqual(12, $w['layout']['x'] + $w['layout']['w']); // fits the grid
        $this->assertLessThanOrEqual(12, $w['layout']['h']);
        $this->assertSame('formA', $w['spec']['formId']);
    }

    public function testDashboardDropsWidgetForOutOfScopeForm(): void
    {
        $svc = $this->service();
        $dash = ['version' => 1, 'widgets' => [
            ['id' => 'ok', 'kind' => 'report', 'layout' => ['x' => 0, 'y' => 0, 'w' => 4, 'h' => 2], 'spec' => ['formId' => 'formA', 'viz' => 'kpi', 'measure' => ['fn' => 'count']]],
            ['id' => 'bad', 'kind' => 'report', 'layout' => ['x' => 4, 'y' => 0, 'w' => 4, 'h' => 2], 'spec' => ['formId' => 'formEVIL', 'viz' => 'kpi', 'measure' => ['fn' => 'count']]],
            ['id' => 'badlist', 'kind' => 'list', 'layout' => ['x' => 8, 'y' => 0, 'w' => 4, 'h' => 2], 'list' => ['formId' => 'formEVIL']],
        ]];
        $out = $svc->sanitizeDashboard($dash, $this->formFields());
        $ids = array_column($out['widgets'], 'id');
        $this->assertContains('ok', $ids);
        $this->assertNotContains('bad', $ids);      // foreign base form dropped
        $this->assertNotContains('badlist', $ids);  // foreign list form dropped
    }

    public function testPublicSpecDropsNonWhitelistedRefs(): void
    {
        $svc = $this->service();
        // Whitelist exposes ONLY 'status'. A groupBy on the non-whitelisted 'amount' must not survive.
        $spec = ['formId' => 'formA', 'viz' => 'bar', 'groupBy' => ['field' => 'amount', 'bucket' => 'none'], 'measure' => ['fn' => 'count']];
        $out = $svc->sanitizePublicSpec($spec, 'formA', ['status']);
        $this->assertArrayNotHasKey('groupBy', $out); // amount is not public → dropped
        $this->assertSame('formA', $out['formId']);

        // A whitelisted groupBy survives.
        $spec2 = ['formId' => 'formA', 'viz' => 'bar', 'groupBy' => ['field' => 'status', 'bucket' => 'none'], 'measure' => ['fn' => 'count']];
        $out2 = $svc->sanitizePublicSpec($spec2, 'formA', ['status']);
        $this->assertSame('status', $out2['groupBy']['field']);
    }

    public function testPublicSpecStripsJoinsAndStatusPseudo(): void
    {
        $svc = $this->service();
        $spec = [
            'formId' => 'formA',
            'viz' => 'table',
            'joins' => [['via' => 'link', 'formId' => 'formB', 'type' => 'left']],
            'columns' => ['status', '__status', '__submitted_at', 'formB::secret'],
            'filters' => [['field' => '__status', 'op' => 'eq', 'value' => 'open']],
        ];
        $out = $svc->sanitizePublicSpec($spec, 'formA', ['status']);
        $this->assertArrayNotHasKey('joins', $out);                 // no cross-form joins publicly
        $this->assertSame(['status', '__submitted_at'], $out['columns']); // __status + joined ref removed
        $this->assertArrayNotHasKey('filters', $out);               // the only filter referenced __status → dropped
    }

    public function testPublicSpecDegradesSumOnNonWhitelistedFieldToCount(): void
    {
        $svc = $this->service();
        // 'amount' is NOT whitelisted → a sum over it can't run publicly, so it degrades to count.
        $spec = ['formId' => 'formA', 'viz' => 'kpi', 'measure' => ['fn' => 'sum', 'field' => 'amount']];
        $out = $svc->sanitizePublicSpec($spec, 'formA', ['status']);
        $this->assertSame('count', $out['measure']['fn']);
        $this->assertArrayNotHasKey('field', $out['measure']);
    }
}

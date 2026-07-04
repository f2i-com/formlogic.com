<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\AppPublicController;
use PHPUnit\Framework\TestCase;
use ReflectionClass;
use ReflectionMethod;

/**
 * Unit-tests the pure member-visibility filters on AppPublicController — memberCanSeeForm() and
 * filterAppForMember() — which stop a limited member from learning the structure (form ids, field
 * names, report specs, dashboard widgets) of forms they can't use. No DB: the methods are pure, so we
 * instantiate the controller without its constructor and invoke via reflection.
 */
class AppMemberFilterTest extends TestCase
{
    private AppPublicController $c;

    protected function setUp(): void
    {
        $this->c = (new ReflectionClass(AppPublicController::class))->newInstanceWithoutConstructor();
    }

    private function call(string $method, array $args)
    {
        $m = new ReflectionMethod(AppPublicController::class, $method);
        $m->setAccessible(true);
        return $m->invoke($this->c, ...$args);
    }

    public function testMemberCanSeeForm(): void
    {
        // A per-form grant on A → sees A, not B.
        $p = ['appLevel' => [], 'formLevel' => ['A' => ['submit_responses']]];
        $this->assertTrue($this->call('memberCanSeeForm', [$p, 'A']));
        $this->assertFalse($this->call('memberCanSeeForm', [$p, 'B']));

        // App-level form permission covers every form.
        $p = ['appLevel' => ['view_all_responses'], 'formLevel' => []];
        $this->assertTrue($this->call('memberCanSeeForm', [$p, 'anything']));

        // Manage / analytics at app level implies visibility of all forms.
        $this->assertTrue($this->call('memberCanSeeForm', [['appLevel' => ['manage_app'], 'formLevel' => []], 'x']));
        $this->assertTrue($this->call('memberCanSeeForm', [['appLevel' => ['view_analytics'], 'formLevel' => []], 'x']));

        // No relevant permission → hidden.
        $this->assertFalse($this->call('memberCanSeeForm', [['appLevel' => ['manage_users'], 'formLevel' => []], 'x']));
        $this->assertFalse($this->call('memberCanSeeForm', [['appLevel' => [], 'formLevel' => []], 'x']));
    }

    public function testFilterAppForMemberDropsInaccessibleStructure(): void
    {
        $app = [
            'navConfig' => [['formId' => 'A'], ['formId' => 'B']],
            'settings' => ['landingPage' => 'B', 'other' => 1],
            'reports' => [
                ['id' => 'r1', 'type' => 'builder', 'spec' => ['formId' => 'A', 'viz' => 'bar']],
                ['id' => 'r2', 'type' => 'builder', 'spec' => ['formId' => 'B', 'viz' => 'bar']],
                ['id' => 'r3', 'type' => 'builder', 'spec' => ['formId' => 'A', 'viz' => 'bar', 'joins' => [['via' => 'f', 'formId' => 'B', 'type' => 'left']]]],
                ['id' => 'd1', 'type' => 'document', 'blocks' => [
                    ['id' => 'b1', 'kind' => 'report', 'reportId' => 'r1'],
                    ['id' => 'b2', 'kind' => 'report', 'reportId' => 'r2'],
                    ['id' => 'b3', 'kind' => 'text', 'body' => 'hi'],
                ]],
            ],
            'customScreen' => ['enabled' => true, 'kind' => 'dashboard', 'dashboard' => ['version' => 1, 'widgets' => [
                ['id' => 'w1', 'kind' => 'report', 'spec' => ['formId' => 'A', 'viz' => 'kpi'], 'layout' => []],
                ['id' => 'w2', 'kind' => 'report', 'spec' => ['formId' => 'B', 'viz' => 'kpi'], 'layout' => []],
                ['id' => 'w3', 'kind' => 'list', 'list' => ['formId' => 'B'], 'layout' => []],
                ['id' => 'w4', 'kind' => 'list', 'list' => ['formId' => 'A'], 'layout' => []],
                ['id' => 'w5', 'kind' => 'text', 'text' => ['body' => 'x'], 'layout' => []],
                ['id' => 'w6', 'kind' => 'activity', 'layout' => []],
            ]]],
        ];

        $out = $this->call('filterAppForMember', [$app, ['A']]);

        // Nav: only A.
        $this->assertSame(['A'], array_column($out['navConfig'], 'formId'));

        // Landing page: reset to dashboard (pointed at inaccessible B).
        $this->assertSame('dashboard', $out['settings']['landingPage']);
        $this->assertSame(1, $out['settings']['other']); // unrelated settings untouched

        // Reports: only chart r1 kept (r2 = B, r3 = joins B); document survives with its accessible +
        // text blocks, but the block referencing the dropped r2 is gone.
        $ids = array_map(fn($r) => $r['id'], $out['reports']);
        $this->assertContains('r1', $ids);
        $this->assertNotContains('r2', $ids);
        $this->assertNotContains('r3', $ids);
        $this->assertContains('d1', $ids);
        $doc = $out['reports'][array_search('d1', $ids, true)];
        $blockIds = array_map(fn($b) => $b['id'], $doc['blocks']);
        $this->assertSame(['b1', 'b3'], $blockIds);

        // Dashboard widgets: report/list on B dropped; A widgets + text/activity kept.
        $widgetIds = array_map(fn($w) => $w['id'], $out['customScreen']['dashboard']['widgets']);
        $this->assertSame(['w1', 'w4', 'w5', 'w6'], $widgetIds);
    }

    public function testOwnerFilterIsNotAppliedElsewhere_ownerBypassIsInGetApp(): void
    {
        // Sanity: with everything accessible, nothing is dropped (the owner path passes all form ids).
        $app = [
            'navConfig' => [['formId' => 'A'], ['formId' => 'B']],
            'reports' => [['id' => 'r1', 'type' => 'builder', 'spec' => ['formId' => 'B', 'viz' => 'bar']]],
        ];
        $out = $this->call('filterAppForMember', [$app, ['A', 'B']]);
        $this->assertCount(2, $out['navConfig']);
        $this->assertCount(1, $out['reports']);
    }
}

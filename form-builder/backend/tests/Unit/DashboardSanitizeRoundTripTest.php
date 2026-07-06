<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\AppReportService;
use FormLogic\Services\AppService;
use FormLogic\Services\FormService;
use PHPUnit\Framework\TestCase;

/**
 * Round-trip + structural-cap coverage for AppReportService::sanitizeDashboard, complementing (never
 * duplicating) the existing sanitize suites:
 *
 *  - DashboardSanitizeTest already pins: foreign-form report widget dropped, foreign-form LIST
 *    widget dropped, layout clamps (x/w/h vs cols), and the public-spec whitelist.
 *  - FilterModeRefreshSanitizeTest already pins: refreshInterval persists ONLY as 30 | 60 | 300,
 *    and filterMode 'any'/junk handling.
 *  - ReportPresentationSanitizeTest / ReportRangeSeriesSanitizeTest already pin the presentation
 *    and dateRange/seriesBy sub-objects.
 *
 * What is pinned HERE (previous gaps):
 *  - a fully-valid dashboard survives sanitization unchanged, and the sanitizer is idempotent
 *    (canonical output re-sanitizes to the identical array — the save/load/save round trip)
 *  - widget count is capped (MAX_WIDGETS = 60)
 *  - cols clamps to 1..24 and widgets are re-fitted to the clamped grid
 *  - unknown / malformed widget kinds and non-array widget entries are dropped; a missing id is
 *    regenerated server-side
 *  - a report widget with an invalid spec (missing / non-array / no formId) is dropped
 *  - invalid spec SUB-parts are stripped without killing the widget (junk viz → bar, unknown
 *    refs dropped, junk aggregate → count, limit clamped)
 *  - joins survive ONLY along a real linked_record field pointing at the declared target form
 *  - list widget field refs are validated against the list's form and its limit clamps to 1..25
 *  - widget titles clamp to 200 chars; blank titles are omitted
 */
class DashboardSanitizeRoundTripTest extends TestCase
{
    private function service(): AppReportService
    {
        // sanitizeDashboard takes the field map directly and never touches these collaborators.
        return new AppReportService(
            $this->createMock(AppService::class),
            $this->createMock(FormService::class)
        );
    }

    /** [formId => [fieldId => fieldDef]] — formA.client is a real linked_record to formB. */
    private function formFields(): array
    {
        return [
            'formA' => [
                'status' => ['id' => 'status', 'type' => 'dropdown', 'properties' => ['options' => [['value' => 'open', 'label' => 'Open']]]],
                'amount' => ['id' => 'amount', 'type' => 'number'],
                'client' => ['id' => 'client', 'type' => 'linked_record', 'properties' => ['targetFormId' => 'formB']],
            ],
            'formB' => [
                'name' => ['id' => 'name', 'type' => 'short_text'],
            ],
        ];
    }

    private function sanitize(array $dash): array
    {
        return $this->service()->sanitizeDashboard($dash, $this->formFields());
    }

    /** Sanitize a dashboard holding one report widget and return that widget's cleaned spec. */
    private function sanitizeSpec(array $spec): array
    {
        $out = $this->sanitize(['version' => 1, 'widgets' => [[
            'id' => 'w1', 'kind' => 'report', 'layout' => ['x' => 0, 'y' => 0, 'w' => 6, 'h' => 3], 'spec' => $spec,
        ]]]);
        $this->assertCount(1, $out['widgets'], 'widget with a valid base form must survive');
        return $out['widgets'][0]['spec'];
    }

    // ── Round trip ────────────────────────────────────────────────────────────

    public function testValidDashboardSurvivesTheRoundTripAndSanitizeIsIdempotent(): void
    {
        // Canonical form: exactly the keys the sanitizer emits, all values in range.
        $dash = [
            'version' => 1,
            'cols' => 12,
            'widgets' => [
                [
                    'id' => 'w1', 'kind' => 'report',
                    'layout' => ['x' => 0, 'y' => 0, 'w' => 6, 'h' => 3],
                    'title' => 'By status',
                    'spec' => ['formId' => 'formA', 'viz' => 'bar', 'groupBy' => ['field' => 'status', 'bucket' => 'none'], 'measure' => ['fn' => 'count']],
                ],
                [
                    'id' => 'w2', 'kind' => 'list',
                    'layout' => ['x' => 6, 'y' => 0, 'w' => 6, 'h' => 3],
                    'list' => ['formId' => 'formA', 'limit' => 6, 'titleField' => 'status', 'linkToRecords' => true],
                ],
                ['id' => 'w3', 'kind' => 'text', 'layout' => ['x' => 0, 'y' => 3, 'w' => 12, 'h' => 1], 'text' => ['body' => 'Shift notes']],
                ['id' => 'w4', 'kind' => 'activity', 'layout' => ['x' => 0, 'y' => 4, 'w' => 6, 'h' => 2]],
                ['id' => 'w5', 'kind' => 'actions', 'layout' => ['x' => 6, 'y' => 4, 'w' => 6, 'h' => 2]],
            ],
            'showRangePicker' => true,
            'refreshInterval' => 60,
        ];

        $once = $this->sanitize($dash);
        // Nothing dropped, nothing rewritten (assertEquals: assoc key ORDER may differ, values must not).
        $this->assertEquals($dash, $once, 'a fully-valid dashboard must survive the save boundary unchanged');

        // Idempotent: the canonical output re-sanitizes to the IDENTICAL array (===, order included) —
        // so save → load → save never mutates a clean dashboard.
        $twice = $this->sanitize($once);
        $this->assertSame($once, $twice);
    }

    // ── Structural caps ───────────────────────────────────────────────────────

    public function testWidgetCountIsCappedAtSixty(): void
    {
        $widgets = [];
        for ($i = 0; $i < 70; $i++) {
            $widgets[] = ['id' => 'w' . $i, 'kind' => 'text', 'layout' => ['x' => 0, 'y' => $i, 'w' => 4, 'h' => 1], 'text' => ['body' => 'x']];
        }
        $out = $this->sanitize(['version' => 1, 'widgets' => $widgets]);
        $this->assertCount(60, $out['widgets']);
        $this->assertSame('w0', $out['widgets'][0]['id']);
        $this->assertSame('w59', $out['widgets'][59]['id'], 'cap keeps the FIRST 60 widgets');
    }

    public function testColsClampsAndWidgetsAreRefittedToTheClampedGrid(): void
    {
        $out = $this->sanitize(['version' => 1, 'cols' => 100, 'widgets' => [
            ['id' => 'w1', 'kind' => 'text', 'layout' => ['x' => 90, 'y' => -2, 'w' => 50, 'h' => 99], 'text' => ['body' => 'x']],
        ]]);
        $this->assertSame(24, $out['cols'], 'cols clamps to at most 24');
        $l = $out['widgets'][0]['layout'];
        $this->assertLessThanOrEqual(24, $l['x'] + $l['w'], 'widget must fit the CLAMPED grid');
        $this->assertGreaterThanOrEqual(0, $l['x']);
        $this->assertGreaterThanOrEqual(0, $l['y']);
        $this->assertLessThanOrEqual(12, $l['h']);

        $tiny = $this->sanitize(['version' => 1, 'cols' => 0, 'widgets' => [
            ['id' => 'w1', 'kind' => 'text', 'layout' => ['x' => 3, 'y' => 0, 'w' => 4, 'h' => 2], 'text' => ['body' => 'x']],
        ]]);
        $this->assertSame(1, $tiny['cols'], 'cols clamps to at least 1');
        $this->assertSame(['x' => 0, 'y' => 0, 'w' => 1, 'h' => 2], $tiny['widgets'][0]['layout']);

        $default = $this->sanitize(['version' => 1, 'widgets' => []]);
        $this->assertSame(12, $default['cols'], 'absent cols defaults to 12');
    }

    // ── Widget-shape validation ───────────────────────────────────────────────

    public function testUnknownKindsAndMalformedEntriesAreDroppedAndMissingIdsRegenerated(): void
    {
        $out = $this->sanitize(['version' => 1, 'widgets' => [
            ['id' => 'ok', 'kind' => 'text', 'layout' => ['x' => 0, 'y' => 0, 'w' => 4, 'h' => 1], 'text' => ['body' => 'x']],
            ['id' => 'bad1', 'kind' => 'iframe', 'layout' => [], 'src' => 'https://evil.example'],
            ['id' => 'bad2', 'kind' => '', 'layout' => []],
            ['id' => 'bad3', 'layout' => []],           // kind missing
            'junk-not-an-array',
            ['kind' => 'text', 'layout' => ['x' => 0, 'y' => 1, 'w' => 4, 'h' => 1], 'text' => ['body' => 'y']], // id missing
        ]]);
        $ids = array_column($out['widgets'], 'id');
        $this->assertCount(2, $out['widgets'], 'only the two text widgets survive');
        $this->assertSame('ok', $ids[0]);
        $this->assertNotSame('', $ids[1], 'a missing widget id is regenerated server-side');
        $this->assertIsString($ids[1]);
    }

    public function testReportWidgetWithMissingOrInvalidSpecIsDropped(): void
    {
        // (A spec whose formId is a FOREIGN form is already pinned by DashboardSanitizeTest.)
        $out = $this->sanitize(['version' => 1, 'widgets' => [
            ['id' => 'noSpec', 'kind' => 'report', 'layout' => ['x' => 0, 'y' => 0, 'w' => 4, 'h' => 2]],
            ['id' => 'strSpec', 'kind' => 'report', 'layout' => ['x' => 0, 'y' => 0, 'w' => 4, 'h' => 2], 'spec' => 'SELECT * FROM users'],
            ['id' => 'noForm', 'kind' => 'report', 'layout' => ['x' => 0, 'y' => 0, 'w' => 4, 'h' => 2], 'spec' => ['viz' => 'bar', 'measure' => ['fn' => 'count']]],
            ['id' => 'ok', 'kind' => 'report', 'layout' => ['x' => 0, 'y' => 0, 'w' => 4, 'h' => 2], 'spec' => ['formId' => 'formA', 'viz' => 'kpi', 'measure' => ['fn' => 'count']]],
        ]]);
        $this->assertSame(['ok'], array_column($out['widgets'], 'id'));
    }

    // ── Spec sub-part stripping (invalid parts drop, the widget survives) ─────

    public function testInvalidSpecSubPartsAreStrippedWithoutKillingTheWidget(): void
    {
        $spec = $this->sanitizeSpec([
            'formId' => 'formA',
            'viz' => 'evil-viz',                                     // unknown → bar
            'groupBy' => ['field' => 'not_a_field', 'bucket' => 'day'], // unknown ref → whole groupBy dropped
            'measure' => ['fn' => 'system', 'field' => 'amount'],    // unknown fn → count (valid field ref kept)
            'filters' => [['field' => 'status', 'op' => 'regex', 'value' => '.*']], // unknown op → filter dropped
            'columns' => ['not_a_field', 'also_missing'],            // nothing resolves → columns omitted
            'sort' => ['by' => 'not_a_field', 'dir' => 'desc'],      // unknown ref → dropped
            'having' => ['op' => 'like', 'value' => 3],              // unknown op → dropped
            'limit' => 99999,                                        // clamped to 1000
        ]);

        $this->assertSame('bar', $spec['viz']);
        $this->assertArrayNotHasKey('groupBy', $spec);
        $this->assertSame(['fn' => 'count', 'field' => 'amount'], $spec['measure']);
        $this->assertArrayNotHasKey('filters', $spec);
        $this->assertArrayNotHasKey('columns', $spec);
        $this->assertArrayNotHasKey('sort', $spec);
        $this->assertArrayNotHasKey('having', $spec);
        $this->assertSame(1000, $spec['limit']);

        // An aggregate that needs a field but whose ref is invalid degrades to count without a field.
        $degraded = $this->sanitizeSpec(['formId' => 'formA', 'viz' => 'kpi', 'measure' => ['fn' => 'sum', 'field' => 'not_a_field']]);
        $this->assertSame(['fn' => 'count'], $degraded['measure']);
    }

    public function testJoinsSurviveOnlyAlongARealLinkedRecordToTheDeclaredTarget(): void
    {
        // Real relationship: formA.client (linked_record) → formB. Joined refs then resolve.
        $good = $this->sanitizeSpec([
            'formId' => 'formA', 'viz' => 'table',
            'joins' => [['via' => 'client', 'formId' => 'formB', 'type' => 'cross']], // junk type → left
            'groupBy' => ['field' => 'formB::name'],
        ]);
        $this->assertSame([['via' => 'client', 'formId' => 'formB', 'type' => 'left']], $good['joins']);
        $this->assertSame('formB::name', $good['groupBy']['field']);

        // via a non-linked_record field → join dropped, and the joined ref no longer resolves.
        $badVia = $this->sanitizeSpec([
            'formId' => 'formA', 'viz' => 'table',
            'joins' => [['via' => 'status', 'formId' => 'formB', 'type' => 'left']],
            'groupBy' => ['field' => 'formB::name'],
        ]);
        $this->assertArrayNotHasKey('joins', $badVia);
        $this->assertArrayNotHasKey('groupBy', $badVia, 'a ref into an undeclared join must not survive');

        // via the right field but the WRONG declared target → dropped.
        $badTarget = $this->sanitizeSpec([
            'formId' => 'formA', 'viz' => 'table',
            'joins' => [['via' => 'client', 'formId' => 'formA', 'type' => 'left']],
        ]);
        $this->assertArrayNotHasKey('joins', $badTarget);
    }

    // ── List widget ───────────────────────────────────────────────────────────

    public function testListWidgetFieldRefsAreValidatedAndLimitClamps(): void
    {
        $out = $this->sanitize(['version' => 1, 'widgets' => [[
            'id' => 'l1', 'kind' => 'list', 'layout' => ['x' => 0, 'y' => 0, 'w' => 4, 'h' => 3],
            'list' => [
                'formId' => 'formA',
                'titleField' => 'status',      // valid → kept
                'subtitleField' => 'nope',     // unknown → dropped
                'metaField' => 'name',         // exists on formB, NOT on formA → dropped
                'limit' => 999,                // clamped to 25
                'linkToRecords' => 'yes',      // non-bool → dropped
            ],
        ]]]);
        $list = $out['widgets'][0]['list'];
        $this->assertSame('status', $list['titleField']);
        $this->assertArrayNotHasKey('subtitleField', $list);
        $this->assertArrayNotHasKey('metaField', $list, 'field refs validate against the LIST form, not any in-scope form');
        $this->assertSame(25, $list['limit']);
        $this->assertArrayNotHasKey('linkToRecords', $list);

        $low = $this->sanitize(['version' => 1, 'widgets' => [[
            'id' => 'l2', 'kind' => 'list', 'layout' => ['x' => 0, 'y' => 0, 'w' => 4, 'h' => 3],
            'list' => ['formId' => 'formA', 'limit' => 0],
        ]]]);
        $this->assertSame(1, $low['widgets'][0]['list']['limit']);
    }

    // ── Title clamp ───────────────────────────────────────────────────────────

    public function testWidgetTitleClampsTo200CharsAndBlankTitlesAreOmitted(): void
    {
        $out = $this->sanitize(['version' => 1, 'widgets' => [
            ['id' => 'w1', 'kind' => 'text', 'layout' => ['x' => 0, 'y' => 0, 'w' => 4, 'h' => 1], 'title' => str_repeat('T', 250), 'text' => ['body' => 'x']],
            ['id' => 'w2', 'kind' => 'text', 'layout' => ['x' => 0, 'y' => 1, 'w' => 4, 'h' => 1], 'title' => '   ', 'text' => ['body' => 'y']],
        ]]);
        $this->assertSame(200, mb_strlen($out['widgets'][0]['title']));
        $this->assertArrayNotHasKey('title', $out['widgets'][1], 'whitespace-only title is omitted');
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\FormService;
use FormLogic\Services\ReportService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * A table report resolves linked_record columns to human labels (not raw target-record ids), gated by
 * the caller's resolvable-forms allowlist. SQLite-only (no MySQL): the target form's fields come from a
 * mocked FormService; its records + the base records live in real per-form SQLite.
 */
class ReportLinkedRecordTest extends TestCase
{
    private string $tmp = '';
    private SQLiteConnection $sqlite;
    private string $baseForm = 'baseform111';
    private string $targetForm = 'targetform22';

    protected function setUp(): void
    {
        $this->tmp = sys_get_temp_dir() . '/fl-report-' . bin2hex(random_bytes(6));
        @mkdir($this->tmp, 0777, true);
        $this->sqlite = new SQLiteConnection($this->tmp);

        // Target form: one record with a name.
        $t = $this->sqlite->getFormDatabase($this->targetForm);
        $t->prepare("INSERT INTO responses (id, answers, metadata, status, submitted_at) VALUES (?, ?, '{}', 'submitted', '2024-01-01 00:00:00')")
            ->execute(['t1', json_encode(['nm' => 'Ada Lovelace'])]);

        // Base form: one record whose linked_record field 'client' references t1.
        $b = $this->sqlite->getFormDatabase($this->baseForm);
        $b->prepare("INSERT INTO responses (id, answers, metadata, status, submitted_at) VALUES (?, ?, '{}', 'submitted', '2024-02-01 00:00:00')")
            ->execute(['b1', json_encode(['client' => 't1'])]);
    }

    protected function tearDown(): void
    {
        // Best-effort temp cleanup.
        foreach (glob($this->tmp . '/*') ?: [] as $f) { @unlink($f); }
        @rmdir($this->tmp);
    }

    private function service(): ReportService
    {
        $formService = $this->createMock(FormService::class);
        $formService->method('getForm')->willReturnCallback(function (string $id) {
            if ($id === $this->targetForm) {
                return ['id' => $id, 'fields' => [['id' => 'nm', 'type' => 'short_text', 'label' => 'Name']]];
            }
            return null;
        });
        return new ReportService($this->sqlite, $formService);
    }

    private array $baseFields = [
        ['id' => 'client', 'type' => 'linked_record', 'label' => 'Client', 'properties' => ['targetFormId' => 'targetform22']],
    ];

    public function testTableResolvesLinkedRecordLabelWhenAllowed(): void
    {
        $spec = ['viz' => 'table', 'columns' => ['client']];
        // null allowlist = owner may resolve any target.
        $r = $this->service()->runReport($spec, $this->baseFields, $this->baseForm, 'all', null, [], 'UTC', null);
        $this->assertSame('table', $r['viz']);
        $this->assertCount(1, $r['rows']);
        $this->assertSame('Ada Lovelace', $r['rows'][0]['c0'], 'linked record should show the label, not the id');
    }

    public function testTableResolvesWhenTargetInAllowlist(): void
    {
        $spec = ['viz' => 'table', 'columns' => ['client']];
        $r = $this->service()->runReport($spec, $this->baseFields, $this->baseForm, 'all', null, [], 'UTC', [$this->targetForm]);
        $this->assertSame('Ada Lovelace', $r['rows'][0]['c0']);
    }

    public function testTableHidesLabelWhenTargetNotAllowed(): void
    {
        $spec = ['viz' => 'table', 'columns' => ['client']];
        // Empty allowlist = may resolve nothing → placeholder, and NEVER the raw id.
        $r = $this->service()->runReport($spec, $this->baseFields, $this->baseForm, 'all', null, [], 'UTC', []);
        $this->assertSame('Linked record', $r['rows'][0]['c0']);
        $this->assertStringNotContainsString('t1', $r['rows'][0]['c0']);
    }
}

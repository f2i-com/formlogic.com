<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppResponseService;
use FormLogic\Services\FormEncryptionService;
use FormLogic\Services\ResponseService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * response_links and response_metadata hold every account's records, and a record's id is not
 * one record across them: a form bound to an app's table names its records by the table's key
 * ("5"), which every other account's table has too. Deleting a record, clearing a form and
 * re-syncing a record's links each cleaned those tables up by id alone, so they took the rows of
 * every other form's record of the same id. Each now names the form as well.
 */
final class ResponseLinksScopeTest extends TestCase
{
    private string $dir;
    private SQLiteConnection $sqlite;
    private PDO $shared;
    private ResponseService $responses;
    private AppResponseService $appResponses;

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/fl-links-scope-' . bin2hex(random_bytes(5));
        $this->sqlite = new SQLiteConnection($this->dir);
        // The shared database, as far as these clean-ups read and write it.
        $this->shared = new PDO('sqlite::memory:');
        $this->shared->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->shared->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $this->shared->exec('CREATE TABLE form_encryption (form_id TEXT PRIMARY KEY, state TEXT)');
        $this->shared->exec('CREATE TABLE forms (id TEXT PRIMARY KEY, response_count INTEGER, updated_at TEXT)');
        $this->shared->exec('CREATE TABLE response_metadata (id TEXT PRIMARY KEY, form_id TEXT, status TEXT)');
        $this->shared->exec('CREATE TABLE response_links (id TEXT PRIMARY KEY, source_form_id TEXT, source_response_id TEXT, target_form_id TEXT, target_response_id TEXT, field_id TEXT)');
        $mysql = $this->createStub(MySQLConnection::class);
        $mysql->method('getConnection')->willReturn($this->shared);
        $this->responses = new ResponseService($mysql, $this->sqlite);
        $this->appResponses = new AppResponseService($mysql, $this->sqlite, $this->responses);
        FormEncryptionService::invalidateCache();

        // Two accounts' forms, each with a record "5"; the forms those records link to and from.
        foreach (['form-mine' => ['5', '6'], 'form-theirs' => ['5'], 'form-target' => ['t1', 't2'], 'form-other' => ['o1']] as $formId => $ids) {
            $this->shared->exec("INSERT INTO forms (id, response_count) VALUES ('{$formId}', " . count($ids) . ')');
            foreach ($ids as $id) {
                $this->sqlite->getFormDatabase($formId)->exec("INSERT INTO responses (id, answers) VALUES ('{$id}', '{}')");
            }
        }
        // The index has one row an id; here it is the other account's.
        $this->shared->exec("INSERT INTO response_metadata (id, form_id, status) VALUES ('5', 'form-theirs', 'submitted'), ('6', 'form-mine', 'submitted')");
        $this->shared->exec("INSERT INTO response_links (id, source_form_id, source_response_id, target_form_id, target_response_id, field_id) VALUES
            ('mine-out',   'form-mine',   '5',  'form-target', 't1', 'link'),
            ('mine-in',    'form-other',  'o1', 'form-mine',   '5',  'link'),
            ('theirs-out', 'form-theirs', '5',  'form-other',  'o1', 'link'),
            ('theirs-in',  'form-other',  'o1', 'form-theirs', '5',  'link')");
    }

    protected function tearDown(): void
    {
        $this->sqlite->closeAll();
        foreach (glob($this->dir . '/*') ?: [] as $f) {
            @unlink($f);
        }
        @rmdir($this->dir);
        FormEncryptionService::invalidateCache();
    }

    /** @return list<string> */
    private function links(): array
    {
        return $this->shared->query('SELECT id FROM response_links ORDER BY id')->fetchAll(PDO::FETCH_COLUMN);
    }

    /** @return array<string, string> the index rows, id => form */
    private function indexed(): array
    {
        return $this->shared->query('SELECT id, form_id FROM response_metadata ORDER BY id')->fetchAll(PDO::FETCH_KEY_PAIR);
    }

    public function testDeletingARecordLeavesAnotherFormsRecordOfThatIdAlone(): void
    {
        $this->assertTrue($this->responses->deleteResponse('form-mine', '5'));

        $this->assertSame(['theirs-in', 'theirs-out'], $this->links());
        $this->assertSame(['5' => 'form-theirs', '6' => 'form-mine'], $this->indexed());
    }

    public function testAnAppDeletingARecordLeavesAnotherFormsRecordOfThatIdAlone(): void
    {
        $this->assertTrue($this->appResponses->deleteResponse('form-mine', '5'));

        $this->assertSame(['theirs-in', 'theirs-out'], $this->links());
        $this->assertSame(['5' => 'form-theirs', '6' => 'form-mine'], $this->indexed());
    }

    public function testClearingAFormLeavesAnotherFormsRecordsAlone(): void
    {
        $this->assertSame(2, $this->responses->deleteAllResponses('form-mine'));

        $this->assertSame(['theirs-in', 'theirs-out'], $this->links());
        $this->assertSame(['5' => 'form-theirs'], $this->indexed());
    }

    public function testSyncingARecordsLinksReplacesItsOwnOnly(): void
    {
        $fields = [['id' => 'link', 'type' => 'linked_record', 'properties' => ['targetFormId' => 'form-target']]];

        $this->responses->syncResponseLinks('form-mine', '5', $fields, ['link' => 't2']);

        $mine = $this->shared->query("SELECT target_response_id FROM response_links WHERE source_form_id = 'form-mine' AND source_response_id = '5'")->fetchAll(PDO::FETCH_COLUMN);
        $this->assertSame(['t2'], $mine, 'the record\'s own link is the new one');
        $kept = array_values(array_intersect($this->links(), ['mine-in', 'theirs-in', 'theirs-out']));
        $this->assertSame(['mine-in', 'theirs-in', 'theirs-out'], $kept, 'and no other record\'s link went');
    }
}

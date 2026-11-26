<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\FormEncryptionService;
use FormLogic\Services\ResponseService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * A record's id comes from the caller, and the caller is only checked against the form in the
 * address. A status change sent for an id the form does not have changed nothing in that form,
 * and then went on to set the status in the shared index (response_metadata) by id alone: the
 * index row of another form's record, another account's included. The change now stops when the
 * form has no such record, and the index is only ever written by form and id.
 */
final class ResponseStatusMirrorScopeTest extends TestCase
{
    private string $dir;
    private SQLiteConnection $sqlite;
    private PDO $index;
    private ResponseService $responses;

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/fl-status-scope-' . bin2hex(random_bytes(5));
        $this->sqlite = new SQLiteConnection($this->dir);
        // The shared database, as far as a status change reads and writes it.
        $this->index = new PDO('sqlite::memory:');
        $this->index->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->index->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $this->index->exec('CREATE TABLE form_encryption (form_id TEXT PRIMARY KEY, state TEXT)');
        $this->index->exec('CREATE TABLE response_metadata (id TEXT, form_id TEXT, status TEXT)');
        $mysql = $this->createStub(MySQLConnection::class);
        $mysql->method('getConnection')->willReturn($this->index);
        $this->responses = new ResponseService($mysql, $this->sqlite);
        FormEncryptionService::invalidateCache();

        foreach (['form-mine' => 'r-mine', 'form-theirs' => 'r-theirs'] as $formId => $responseId) {
            $this->sqlite->getFormDatabase($formId)->exec("INSERT INTO responses (id, answers, status) VALUES ('{$responseId}', '{\"name\":\"Ada\"}', 'submitted')");
            $this->index->exec("INSERT INTO response_metadata (id, form_id, status) VALUES ('{$responseId}', '{$formId}', 'submitted')");
        }
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

    private function indexed(string $responseId): string
    {
        return (string) $this->index->query("SELECT status FROM response_metadata WHERE id = '{$responseId}'")->fetchColumn();
    }

    public function testAStatusChangeForAnotherFormsRecordChangesNothing(): void
    {
        // The caller may write form-mine; the id is a record of form-theirs.
        $this->assertNull($this->responses->updateResponse('form-mine', 'r-theirs', ['status' => 'spam']));

        $this->assertSame('submitted', $this->indexed('r-theirs'), 'the other form\'s index row');
        $this->assertSame('submitted', $this->sqlite->getFormDatabase('form-theirs')->query("SELECT status FROM responses WHERE id = 'r-theirs'")->fetchColumn());
        $this->assertSame('submitted', $this->indexed('r-mine'));
    }

    public function testAnIdTwoFormsShareIsChangedInTheNamedFormOnly(): void
    {
        // A form bound to an app's table names its records by the table's key ("5"), so ids of
        // different forms can be equal. The index is written for the form the caller named.
        $this->sqlite->getFormDatabase('form-mine')->exec("INSERT INTO responses (id, answers, status) VALUES ('5', '{}', 'submitted')");
        $this->index->exec("INSERT INTO response_metadata (id, form_id, status) VALUES ('5', 'form-mine', 'submitted'), ('5', 'form-theirs', 'submitted')");

        $updated = $this->responses->updateResponse('form-mine', '5', ['status' => 'approved']);

        $this->assertSame('approved', $updated['status'] ?? null);
        $rows = $this->index->query("SELECT form_id, status FROM response_metadata WHERE id = '5' ORDER BY form_id")->fetchAll(PDO::FETCH_KEY_PAIR);
        $this->assertSame(['form-mine' => 'approved', 'form-theirs' => 'submitted'], $rows);
    }

    public function testAStatusChangeForTheFormsOwnRecordStillReachesTheIndex(): void
    {
        $updated = $this->responses->updateResponse('form-mine', 'r-mine', ['status' => 'reviewed']);

        $this->assertSame('reviewed', $updated['status'] ?? null);
        $this->assertSame('reviewed', $this->indexed('r-mine'));
        $this->assertSame('submitted', $this->indexed('r-theirs'));
    }

    public function testAnAnswersChangeForARecordTheFormDoesNotHaveIsNotThere(): void
    {
        $this->assertNull($this->responses->updateResponse('form-mine', 'r-theirs', ['answers' => ['name' => 'Bo']]));
        $this->assertNull($this->responses->updateResponse('form-mine', 'never-existed', ['answers' => ['name' => 'Bo'], 'status' => 'spam']));
        $this->assertSame('{"name":"Ada"}', $this->sqlite->getFormDatabase('form-theirs')->query("SELECT answers FROM responses WHERE id = 'r-theirs'")->fetchColumn());
    }
}

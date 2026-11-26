<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\FormEncryptionService;
use FormLogic\Services\NativeAppService;
use FormLogic\Services\NativeTableFormBridge;
use FormLogic\Services\ResponseService;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * A form's `response_count` is what the forms list shows and sorts "Most responses" by, kept beside
 * the form as each write changes how many records it has. For a form bound to an app's table only a
 * clear and the two imports kept it: a record made or deleted through the form left it where it was.
 * Both now count the table again, as a form's own store recounts its own.
 */
final class NativeTableResponseCountTest extends TestCase
{
    private string $dir;
    private PDO $shared;
    private ResponseService $responses;
    /** The bound table's rows, as the bridge below keeps them. */
    private int $rows = 5;

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/fl-count-' . bin2hex(random_bytes(5));
        $this->shared = new PDO('sqlite::memory:');
        $this->shared->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->shared->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $this->shared->exec('CREATE TABLE form_encryption (form_id TEXT PRIMARY KEY, state TEXT)');
        $this->shared->exec('CREATE TABLE forms (id TEXT PRIMARY KEY, response_count INTEGER, updated_at TEXT)');
        $this->shared->exec('CREATE TABLE response_links (id TEXT PRIMARY KEY, source_form_id TEXT, source_response_id TEXT, target_form_id TEXT, target_response_id TEXT, field_id TEXT)');
        $this->shared->exec("INSERT INTO forms (id, response_count, updated_at) VALUES ('form-1', 5, '2026-01-01 00:00:00')");
        $mysql = $this->createStub(MySQLConnection::class);
        $mysql->method('getConnection')->willReturn($this->shared);
        $this->responses = new ResponseService($mysql, new SQLiteConnection($this->dir));
        FormEncryptionService::invalidateCache();

        $bridge = $this->createStub(NativeTableFormBridge::class);
        $bridge->method('resolveBinding')->willReturnCallback(
            static fn (string $formId): ?array => $formId === 'form-1' ? ['formId' => $formId, 'appId' => 'app-1', 'table' => 'jobs'] : null
        );
        $bridge->method('createResponse')->willReturnCallback(function (): array {
            $this->rows++;
            return ['id' => (string) (100 + $this->rows), 'answers' => ['title' => 'New'], 'status' => 'submitted'];
        });
        $bridge->method('deleteResponse')->willReturnCallback(function (array $binding, string $id): bool {
            if ($id === 'gone') {
                return false;
            }
            $this->rows--;
            return true;
        });
        $bridge->method('countResponses')->willReturnCallback(fn (): int => $this->rows);
        $this->responses->setNativeTableBridge($bridge);
    }

    protected function tearDown(): void
    {
        NativeAppService::clearSandboxRootOverrides();
        foreach (glob($this->dir . '/*') ?: [] as $f) {
            @unlink($f);
        }
        @rmdir($this->dir);
        FormEncryptionService::invalidateCache();
    }

    private function stored(): int
    {
        return (int) $this->shared->query("SELECT response_count FROM forms WHERE id = 'form-1'")->fetchColumn();
    }

    public function testARecordMadeThroughTheFormIsCounted(): void
    {
        $this->responses->createResponse('form-1', ['answers' => ['title' => 'New']]);
        $this->responses->createResponse('form-1', ['answers' => ['title' => 'Newer']]);

        self::assertSame(7, $this->stored(), 'the count stayed at the five it had');
        self::assertSame('2026-01-01 00:00:00', $this->shared->query("SELECT updated_at FROM forms WHERE id = 'form-1'")->fetchColumn(), 'a record is not an edit of the form');
    }

    public function testARecordDeletedThroughTheFormIsCounted(): void
    {
        self::assertTrue($this->responses->deleteResponse('form-1', '3'));
        self::assertSame(4, $this->stored());

        // A row the table no longer had is no change to count.
        $this->rows = 2;
        self::assertFalse($this->responses->deleteResponse('form-1', 'gone'));
        self::assertSame(4, $this->stored());
    }

    public function testADemoVisitorsCopyOfTheTableIsNotTheFormsCount(): void
    {
        // A demo visitor writes to their own copy of the table. The count is the real form's.
        NativeAppService::setSandboxRootOverride('app-1', $this->dir);
        $this->responses->createResponse('form-1', ['answers' => ['title' => 'Visitor']]);
        self::assertTrue($this->responses->deleteResponse('form-1', '3'));
        $this->responses->deleteResponse('form-1', '4');

        self::assertSame(5, $this->stored());
    }
}

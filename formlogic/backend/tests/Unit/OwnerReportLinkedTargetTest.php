<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\FormReportController;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AppReportService;
use FormLogic\Services\AppService;
use FormLogic\Services\FormService;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response as SlimResponse;

/**
 * The owner's form report resolves a linked_record column to labels read from the target form's
 * records. A form's linked_record field may name ANY form id as its target (nothing checks it on
 * save), so the owner path must resolve only targets the caller owns: otherwise a user who learns
 * another account's form and record ids reads those records' names through their own report.
 */
class OwnerReportLinkedTargetTest extends TestCase
{
    private string $tmp = '';
    private SQLiteConnection $sqlite;

    protected function setUp(): void
    {
        $this->tmp = sys_get_temp_dir() . '/fl-owner-report-' . bin2hex(random_bytes(6));
        @mkdir($this->tmp, 0777, true);
        $this->sqlite = new SQLiteConnection($this->tmp);

        $this->sqlite->getFormDatabase('victimform')
            ->prepare("INSERT INTO responses (id, answers, metadata, status, submitted_at) VALUES ('v1', ?, '{}', 'submitted', '2024-01-01 00:00:00')")
            ->execute([json_encode(['nm' => 'Victim Record Name'])]);
        $this->sqlite->getFormDatabase('ownclients')
            ->prepare("INSERT INTO responses (id, answers, metadata, status, submitted_at) VALUES ('c1', ?, '{}', 'submitted', '2024-01-01 00:00:00')")
            ->execute([json_encode(['nm' => 'Own Client'])]);
        $this->sqlite->getFormDatabase('attackform')
            ->prepare("INSERT INTO responses (id, answers, metadata, status, submitted_at) VALUES ('a1', ?, '{}', 'submitted', '2024-02-01 00:00:00')")
            ->execute([json_encode(['theirs' => 'v1', 'mine' => 'c1'])]);
    }

    protected function tearDown(): void
    {
        foreach (glob($this->tmp . '/*') ?: [] as $f) { @unlink($f); }
        @rmdir($this->tmp);
    }

    public function testOwnerReportResolvesLabelsOnlyFromFormsTheCallerOwns(): void
    {
        $forms = [
            'attackform' => ['id' => 'attackform', 'userId' => 'attacker', 'status' => 'draft', 'fields' => [
                ['id' => 'theirs', 'type' => 'linked_record', 'label' => 'Theirs', 'properties' => ['targetFormId' => 'victimform']],
                ['id' => 'mine', 'type' => 'linked_record', 'label' => 'Mine', 'properties' => ['targetFormId' => 'ownclients']],
            ]],
            'victimform' => ['id' => 'victimform', 'userId' => 'victim', 'status' => 'published', 'fields' => [
                ['id' => 'nm', 'type' => 'short_text', 'label' => 'Name'],
            ]],
            'ownclients' => ['id' => 'ownclients', 'userId' => 'attacker', 'status' => 'draft', 'fields' => [
                ['id' => 'nm', 'type' => 'short_text', 'label' => 'Name'],
            ]],
        ];
        $formService = $this->createMock(FormService::class);
        $formService->method('getForm')->willReturnCallback(fn (string $id) => $forms[$id] ?? null);
        $controller = new FormReportController(
            $formService,
            $this->sqlite,
            $this->createMock(AppService::class),
            $this->createMock(AppReportService::class)
        );

        $request = (new ServerRequestFactory())->createServerRequest('POST', '/api/forms/attackform/reports/run')
            ->withAttribute('userId', 'attacker')
            ->withParsedBody(['spec' => ['viz' => 'table', 'columns' => ['theirs', 'mine']]]);
        $response = $controller->runOwner($request, new SlimResponse(), ['id' => 'attackform']);
        $this->assertSame(200, $response->getStatusCode());
        $body = json_decode((string) $response->getBody(), true);

        $this->assertSame('Own Client', $body['rows'][0]['c1'] ?? null, 'a target the caller owns still resolves');
        $this->assertSame('Linked record', $body['rows'][0]['c0'] ?? null, "another account's record name must not be read");
    }
}

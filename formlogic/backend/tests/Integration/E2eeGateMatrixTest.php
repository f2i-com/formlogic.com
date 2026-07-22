<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Services\AppDataExportService;
use FormLogic\Services\ChatToolDeniedException;
use FormLogic\Services\ChatToolsContext;
use FormLogic\Services\ChatToolsService;
use FormLogic\Services\FormEncryptionService;
use FormLogic\Services\PrivateFormEncryptedException;
use FormLogic\Services\ReportService;
use Psr\Log\NullLogger;

/**
 * §9.2 fail-closed gate matrix (plan gate: "every §9.2 surface returns
 * private_form_encrypted — matrix-driven phpunit test"). One enabled private
 * form; every content-dependent surface must throw/refuse with the typed code —
 * never silently return wrong/empty results over ciphertext. Non-content
 * operations (list by non-content columns, counts, delete) stay allowed and are
 * asserted as controls.
 */
class E2eeGateMatrixTest extends E2eeTestCase
{
    private string $formId = '';
    private string $appId = '';

    protected function setUp(): void
    {
        parent::setUp();
        $form = $this->makeDraftForm();
        $this->formId = (string) $form['id'];
        $this->enablePrivateForm($this->formId);
        // One ciphertext row so read paths have something to (not) touch.
        self::$responses->createEncryptedResponse($this->formId, $this->makeEnvelope($this->formId), null, '203.0.113.9');
        $app = self::$apps->createApp(['name' => 'Matrix app'], $this->userId);
        $this->appId = (string) $app['id'];
    }

    /**
     * The matrix: [surface, refusal kind]. Each closure must refuse the private
     * form — typed PrivateFormEncryptedException, or ChatToolDeniedException
     * carrying reason private_form_encrypted (the chat/MCP denial channel).
     *
     * @return iterable<string, array{\Closure(string): void}>
     */
    public static function privateSurfaces(): iterable
    {
        yield 'plaintext response write (createResponse)' => [fn (string $f) => self::$responses->createResponse($f, ['answers' => ['name' => 'x']], null)];
        yield 'plaintext response write (updateResponse)' => [fn (string $f) => self::$responses->updateResponse($f, 'whatever', ['answers' => ['name' => 'y']])];
        yield 'answersEq filter' => [fn (string $f) => self::$responses->getFormResponses($f, ['answersEq' => ['name' => 'x']])];
        yield 'answersGte filter' => [fn (string $f) => self::$responses->getFormResponses($f, ['answersGte' => ['name' => '2024-01-01']])];
        yield 'answersPhoneEq filter' => [fn (string $f) => self::$responses->getFormResponses($f, ['answersPhoneEq' => ['name' => '5551234']])];
        yield 'answer-field sort' => [fn (string $f) => self::$responses->getFormResponses($f, ['sort' => 'name', 'sortDir' => 'asc'])];
        yield 'whole-answers search (findMatchingResponseIds)' => [fn (string $f) => self::$responses->findMatchingResponseIds($f, 'alice')];
        yield 'searchable list with query' => [fn (string $f) => self::$responses->getFormResponsesSearchable($f, 'alice', [], ['limit' => 10])];
        yield 'field-value count' => [fn (string $f) => self::$responses->countResponsesWithFieldValue($f, 'name')];
        yield 'field-data purge (would corrupt envelopes)' => [fn (string $f) => self::$responses->purgeFieldData($f, 'name')];
        yield 'script recompute' => [fn (string $f) => self::$responses->recomputeResponse($f, 'whatever', 'return {};')];
        yield 'CSV export (streaming)' => [function (string $f) {
            $stream = fopen('php://temp', 'r+');
            self::$responses->exportResponsesStreaming($f, [['id' => 'name', 'type' => 'short_text']], $stream);
        }];
        yield 'CSV import (plaintext in)' => [fn (string $f) => self::$responses->importResponses($f, [['name' => 'x']], ['name' => 'name'], [['id' => 'name', 'type' => 'short_text']])];
        yield 'webhook creation' => [fn (string $f) => self::$webhooks->createWebhook($f, self::staticUserId(), 'https://example.com/hook', ['response.created'])];
        yield 'workspace flow binding creation' => [fn (string $f) => self::$flows->createFormBinding(self::staticUserId(), $f, ['flow' => 'mx', 'event' => 'form.submitted', 'mode' => 'async'])];
        yield 'app flow binding creation (formId)' => [fn (string $f) => self::$flows->createBinding(self::staticAppId(), ['flow' => 'mx', 'event' => 'form.submitted', 'mode' => 'async', 'formId' => $f])];
        yield 'app attach (standalone-only in P3)' => [fn (string $f) => self::$apps->addFormToApp(self::staticAppId(), $f)];
        yield 'report execution (base form)' => [fn (string $f) => (new ReportService(self::$sqlite, self::$forms, self::$pdo))->runReport(['viz' => 'kpi', 'measure' => ['fn' => 'count']], [], $f, 'all', null)];
        yield 'report execution (joined form)' => [fn (string $f) => (new ReportService(self::$sqlite, self::$forms, self::$pdo))->runReport(['viz' => 'kpi', 'measure' => ['fn' => 'count']], [], 'unrelated-form', 'all', null, [['formId' => $f, 'via' => 'x', 'type' => 'left', 'scope' => 'all', 'fields' => [], 'path' => '/nope']])];
        yield 'blocked field type added post-enable' => [fn (string $f) => self::$forms->updateForm($f, ['fields' => [['id' => 'up', 'type' => 'file_upload', 'label' => 'Upload']]])];
        yield 'linked_record field added post-enable' => [fn (string $f) => self::$forms->updateForm($f, ['fields' => [['id' => 'lr', 'type' => 'linked_record', 'label' => 'Link', 'properties' => ['targetFormId' => 'x']]]])];
    }

    /** Static bridges so the data-provider closures can reach the fixtures. */
    private static string $staticUserId = '';
    private static string $staticAppId = '';
    private static function staticUserId(): string
    {
        return self::$staticUserId;
    }
    private static function staticAppId(): string
    {
        return self::$staticAppId;
    }

    /**
     * @dataProvider privateSurfaces
     */
    public function testSurfaceRefusesPrivateForm(\Closure $invoke): void
    {
        self::$staticUserId = $this->userId;
        self::$staticAppId = $this->appId;
        // The workspace/app flows used by the binding-creation rows.
        try {
            self::$flows->createWorkspaceFlow($this->userId, ['name' => 'mx', 'slug' => 'mx']);
        } catch (\Throwable) { /* already exists in a prior matrix row */ }
        try {
            self::$flows->createFlow($this->appId, $this->userId, ['name' => 'mx app', 'slug' => 'mx']);
        } catch (\Throwable) { /* already exists */ }

        try {
            $invoke($this->formId);
            $this->fail('surface did not refuse the private form');
        } catch (PrivateFormEncryptedException $e) {
            $this->assertSame('private_form_encrypted', PrivateFormEncryptedException::ERROR_CODE);
            $this->assertStringContainsString('private_form_encrypted', $e->getMessage());
        } catch (ChatToolDeniedException $e) {
            $this->assertSame('private_form_encrypted', $e->getReasonCode());
        }
    }

    private function chatTools(): ChatToolsService
    {
        return new ChatToolsService(self::$forms, self::$apps, self::$responses);
    }

    private function chatCtx(): ChatToolsContext
    {
        return new ChatToolsContext($this->userId);
    }

    public static function chatRecordTools(): iterable
    {
        yield 'chat list_responses' => ['list_responses'];
        yield 'chat add_response' => ['add_response'];
        yield 'chat update_response' => ['update_response'];
        yield 'chat delete_response' => ['delete_response'];
    }

    /** @dataProvider chatRecordTools */
    public function testChatToolsRefusePrivateForm(string $tool): void
    {
        $args = ['formId' => $this->formId, 'responseId' => 'r1', 'answers' => ['name' => 'x']];
        try {
            $this->chatTools()->call($tool, $args, $this->chatCtx());
            $this->fail("{$tool} did not refuse the private form");
        } catch (ChatToolDeniedException $e) {
            $this->assertSame('private_form_encrypted', $e->getReasonCode());
        }
    }

    public function testAppSqlDumpRefusesWhenAppContainsPrivateForm(): void
    {
        // A private form can never be app-attached through ANY API (preflight +
        // addFormToApp gate), so simulate legacy/foreign data: attach FIRST,
        // then mark the form private directly — the dump must still refuse.
        $plain = $this->makeDraftForm();
        self::$apps->addFormToApp($this->appId, (string) $plain['id']);
        self::$pdo->prepare("INSERT INTO form_encryption (form_id, mode, state, enabled_by, enabled_at) VALUES (?, 'private', 'active', ?, NOW())")
            ->execute([$plain['id'], $this->userId]);
        FormEncryptionService::invalidateCache();

        $svc = new AppDataExportService(self::$mysql, self::$sqlite, self::$forms, self::$apps, self::$uploadsPath, new NullLogger());
        try {
            $svc->exportSqlDump(self::$apps->getApp($this->appId), 'mysql');
            $this->fail('SQL dump over an app containing a private form must refuse');
        } catch (PrivateFormEncryptedException $e) {
            $this->assertStringContainsString('private_form_encrypted', $e->getMessage());
        }
    }

    // ── Controls: non-content operations stay fully available (plan §9.2) ────

    public function testPlainListingByNonContentColumnsStaysAllowed(): void
    {
        $rows = self::$responses->getFormResponses($this->formId, ['limit' => 10]);
        $this->assertCount(1, $rows);
        // The answers column is the sealed envelope, verbatim.
        $this->assertSame(1, $rows[0]['answers']['__flenc'] ?? null);

        $sorted = self::$responses->getFormResponses($this->formId, ['sort' => 'submittedAt', 'sortDir' => 'desc']);
        $this->assertCount(1, $sorted);
        $this->assertSame(1, self::$responses->getResponseCount($this->formId));
    }

    public function testGetResponseReturnsCiphertextRow(): void
    {
        $rows = self::$responses->getFormResponses($this->formId, ['limit' => 1]);
        $one = self::$responses->getResponse($this->formId, (string) $rows[0]['id']);
        $this->assertNotNull($one);
        $this->assertSame(1, $one['answers']['__flenc'] ?? null);
    }

    public function testDeleteStaysAllowed(): void
    {
        $rows = self::$responses->getFormResponses($this->formId, ['limit' => 1]);
        $this->assertTrue(self::$responses->deleteResponse($this->formId, (string) $rows[0]['id']));
        $this->assertSame(0, self::$responses->getResponseCount($this->formId));
    }

    public function testSqliteBundleExportStaysAllowed(): void
    {
        // Verbatim-ciphertext exports (sqlite bundle) are explicitly allowed.
        $svc = new AppDataExportService(self::$mysql, self::$sqlite, self::$forms, self::$apps, self::$uploadsPath, new NullLogger());
        $plain = $this->makeDraftForm();
        self::$apps->addFormToApp($this->appId, (string) $plain['id']);
        $zip = $svc->exportSqliteBundle(self::$apps->getApp($this->appId));
        $this->assertFileExists($zip);
        @unlink($zip);
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Controllers\FormController;
use FormLogic\Controllers\ResponseController;
use FormLogic\Services\FormLogicRuntime;
use FormLogic\Services\ResponseService;
use FormLogic\Services\ScriptResult;
use FormLogic\Services\WebhookService;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * Where a record's data goes after the record: logs, retention, exports, what a submitter gets
 * back, and what a syncing copy hears.
 */
final class DataLifecycleTest extends E2eeTestCase
{
    private function aForm(array $settings = [], array $fields = []): string
    {
        $form = self::$forms->createForm([
            'title' => 'Lifecycle',
            'userId' => $this->userId,
            'status' => 'published',
            'settings' => $settings,
            'fields' => $fields ?: [['id' => 'name', 'type' => 'short_text', 'label' => 'Name', 'required' => false]],
        ]);
        return (string) $form['id'];
    }

    private function delivery(string $status, string $age = '0'): string
    {
        $formId = $this->aForm();
        $webhookId = 'wh-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO webhooks (id, form_id, user_id, url, secret, events, is_active) VALUES (?, ?, ?, 'https://example.com/hook', 'whsec', '[]', 1)")
            ->execute([$webhookId, $formId, $this->userId]);
        $id = 'whd-' . bin2hex(random_bytes(12));
        self::$pdo->prepare("INSERT INTO webhook_deliveries (id, webhook_id, event, payload, success, status, created_at) VALUES (?, ?, 'response.created', '{\"answers\":1}', 0, ?, NOW() - INTERVAL {$age} DAY)")
            ->execute([$id, $webhookId, $status]);
        return $id;
    }

    private function payloadOf(string $id): mixed
    {
        $stmt = self::$pdo->prepare('SELECT payload FROM webhook_deliveries WHERE id = ?');
        $stmt->execute([$id]);
        return $stmt->fetchColumn();
    }

    public function testADeliveryKeepsItsAnswersOnlyWhileItCanBeRetried(): void
    {
        $service = new WebhookService(self::$mysql);
        $update = new \ReflectionMethod($service, 'updateDeliveryResult');

        $retrying = $this->delivery('failed');
        $update->invoke($service, $retrying, false, 500, null, 1, 'HTTP 500', 'failed', 2, date('Y-m-d H:i:s'));
        $this->assertNotNull($this->payloadOf($retrying), 'the next attempt needs it');

        foreach (['success', 'exhausted', 'abandoned'] as $status) {
            $id = $this->delivery('retrying');
            $update->invoke($service, $id, $status === 'success', 200, null, 1, null, $status, 3, null);
            $this->assertNull($this->payloadOf($id), $status);
        }

        $log = new \ReflectionMethod($service, 'logDelivery');
        foreach (['success' => false, 'failed' => true] as $status => $kept) {
            $id = 'whd-' . bin2hex(random_bytes(12));
            $webhookId = (string) self::$pdo->query('SELECT webhook_id FROM webhook_deliveries LIMIT 1')->fetchColumn();
            $log->invoke($service, $id, $webhookId, 'response.created', '{"answers":1}', 200, null, 1, $status === 'success', null, $status);
            $this->assertSame($kept, $this->payloadOf($id) !== null, $status);
        }
    }

    public function testTheNightlyJobClearsOldDeliveries(): void
    {
        $old = $this->delivery('success');
        $stale = $this->delivery('failed', '31');
        $waiting = $this->delivery('failed');

        $this->assertSame(1, (new WebhookService(self::$mysql))->purgeDeliveries());

        $this->assertNull($this->payloadOf($old), 'one written before they stopped being kept');
        $this->assertFalse($this->payloadOf($stale), 'gone: nothing retries after a month');
        $this->assertNotNull($this->payloadOf($waiting));
    }

    public function testRetentionReachesAFormThatHasGoneQuiet(): void
    {
        $formId = $this->aForm(['retentionDays' => 30]);
        self::$responses->createResponse($formId, ['answers' => ['name' => 'new']], null);
        $db = self::$sqlite->getFormDatabase($formId);
        $db->beginTransaction();
        $insert = $db->prepare("INSERT INTO responses (id, answers, metadata, status, submitted_at, updated_at) VALUES (?, '{}', '{}', 'submitted', '2001-01-01 00:00:00', '2001-01-01 00:00:00')");
        for ($i = 0; $i < 501; $i++) {
            $insert->execute(['old-' . $i]);
        }
        $db->commit();

        $this->assertSame(501, self::$responses->purgeAllExpired($formId), 'past one batch, and with nothing new arriving');
        $this->assertSame(1, (int) $db->query('SELECT COUNT(*) FROM responses')->fetchColumn());
        $this->assertSame(0, self::$responses->purgeAllExpired($this->aForm()), 'no retention set');
    }

    public function testTheSqliteDownloadHasEveryCommittedRowWhileAReaderHoldsTheWal(): void
    {
        $formId = $this->aForm();
        self::$responses->createResponse($formId, ['answers' => ['name' => 'first']], null);
        $path = self::$sqlite->getFormDbPath($formId);
        $reader = new \PDO('sqlite:' . $path);
        $reader->beginTransaction();
        $reader->query('SELECT COUNT(*) FROM responses')->fetchColumn();
        self::$responses->createResponse($formId, ['answers' => ['name' => 'second']], null);

        $controller = new ResponseController(self::$responses, self::$forms, self::$sqlite);
        $request = (new ServerRequestFactory())->createServerRequest('GET', 'http://localhost/x')->withAttribute('userId', $this->userId);
        $response = $controller->exportSqlite($request, (new ResponseFactory())->createResponse(), ['formId' => $formId]);
        $reader->rollBack();

        $this->assertSame(200, $response->getStatusCode());
        $copy = tempnam(self::$tmpRoot, 'export');
        $response->getBody()->rewind();
        file_put_contents($copy, (string) $response->getBody());
        $this->assertSame((string) strlen((string) file_get_contents($copy)), $response->getHeaderLine('Content-Length'));
        $this->assertSame(2, (int) (new \PDO('sqlite:' . $copy))->query('SELECT COUNT(*) FROM responses')->fetchColumn());
    }

    public function testACsvCutShortSaysSo(): void
    {
        $formId = $this->aForm();
        $db = self::$sqlite->getFormDatabase($formId);
        $db->beginTransaction();
        $insert = $db->prepare("INSERT INTO responses (id, answers, metadata, status, submitted_at, updated_at) VALUES (?, '{}', '{}', 'submitted', '2001-01-01 00:00:00', '2001-01-01 00:00:00')");
        for ($i = 0; $i < 501; $i++) {
            $insert->execute(['row-' . $i]);
        }
        $db->commit();
        $fields = self::$forms->getForm($formId)['fields'];
        $export = function (int $max) use ($formId, $fields): string {
            $out = fopen('php://memory', 'w+b');
            self::$responses->exportResponsesStreaming($formId, $fields, $out, null, null, $max);
            rewind($out);
            return (string) stream_get_contents($out);
        };

        $this->assertStringNotContainsString('Export stopped', $export(1000));
        $this->assertStringContainsString('Export stopped at 500 rows', $export(500));
    }

    public function testCsvImportValidatesOutsideTheWriteTransaction(): void
    {
        $formId = $this->aForm([], [['id' => 'name', 'type' => 'short_text', 'label' => 'Name', 'required' => true]]);
        $fields = self::$forms->getForm($formId)['fields'];
        $service = new class (self::$mysql, self::$sqlite) extends ResponseService {
            public array $inTransaction = [];
            public ?\PDO $watching = null;
            public function validateSubmittedAnswers(array $fields, array $answers): array
            {
                $this->inTransaction[] = $this->watching?->inTransaction();
                return parent::validateSubmittedAnswers($fields, $answers);
            }
        };
        $service->watching = self::$sqlite->getFormDatabase($formId);

        $result = $service->importResponses($formId, [['n' => 'one'], ['n' => ''], ['n' => 'three']], ['n' => 'name'], $fields);

        $this->assertSame([false, false], $service->inTransaction);
        $this->assertSame(2, $result['created']);
    }

    /** @return callable(?string): array{0: int, 1: array<string, mixed>} a POST of the public route, as this caller. */
    private function submitter(string $formId, ScriptResult $script): callable
    {
        $runtime = $this->createStub(FormLogicRuntime::class);
        $runtime->method('execute')->willReturn($script);
        $controller = new ResponseController(new ResponseService(self::$mysql, self::$sqlite, $runtime), self::$forms, self::$sqlite);
        return static function (?string $userId) use ($controller, $formId): array {
            $request = (new ServerRequestFactory())->createServerRequest('POST', 'http://localhost/x')
                ->withParsedBody(['answers' => ['name' => 'someone', 'ref' => 'forged', 'ghost' => 'not a field']]);
            if ($userId !== null) {
                $request = $request->withAttribute('userId', $userId);
            }
            $response = $controller->create($request, (new ResponseFactory())->createResponse(), ['formId' => $formId]);
            $response->getBody()->rewind();
            return [$response->getStatusCode(), json_decode((string) $response->getBody(), true)['response']];
        };
    }

    private function aQuiz(): string
    {
        return (string) self::$forms->createForm([
            'title' => 'Quiz', 'userId' => $this->userId, 'status' => 'published', 'logicScript' => 'function onSubmit(ctx) { return {}; }',
            'fields' => [
                ['id' => 'name', 'type' => 'short_text', 'label' => 'Name', 'required' => false],
                ['id' => 'ref', 'type' => 'hidden', 'label' => 'Ref', 'required' => false, 'properties' => ['defaultValue' => 'staff-only']],
            ],
        ])['id'];
    }

    public function testASubmitterGetsBackWhatTheySentAndNothingAScriptStored(): void
    {
        $submit = $this->submitter($this->aQuiz(), ScriptResult::success(fields: ['fetched' => 'private'], tags: ['vip'], status: 'reviewed'));

        [$status, $public] = $submit(null);
        $this->assertSame(201, $status);
        $this->assertEqualsCanonicalizing(['id', 'status', 'submittedAt', 'updatedAt', 'answers'], array_keys($public));
        $this->assertNotEmpty($public['id']);
        $this->assertSame('reviewed', $public['status']);
        $this->assertSame(['name' => 'someone'], $public['answers'], 'not what the server filled in, nor what it dropped');

        [, $owner] = $submit($this->userId);
        $this->assertSame('staff-only', $owner['answers']['ref'], 'the owner still gets the record');
        $this->assertSame(['fetched' => 'private'], $owner['computed']);
        $this->assertSame(['vip'], $owner['tags']);
    }

    public function testASubmitterIsToldNothingWasStored(): void
    {
        $submit = $this->submitter($this->aQuiz(), ScriptResult::success(store: false));

        [$status, $public] = $submit(null);
        $this->assertSame(201, $status);
        $this->assertFalse($public['stored']);
        $this->assertSame(['name' => 'someone'], $public['answers']);
    }

    public function testASaveFromAnOlderCopyOfTheFieldsIsRefused(): void
    {
        $formId = $this->aForm();
        $controller = new FormController(self::$forms);
        $call = function (string $method, array $body = []) use ($controller, $formId): array {
            $request = (new ServerRequestFactory())->createServerRequest($method, 'http://localhost/x')
                ->withAttribute('userId', $this->userId)->withParsedBody($body);
            $response = $method === 'GET'
                ? $controller->show($request, (new ResponseFactory())->createResponse(), ['id' => $formId])
                : $controller->update($request, (new ResponseFactory())->createResponse(), ['id' => $formId]);
            $response->getBody()->rewind();
            return [$response->getStatusCode(), json_decode((string) $response->getBody(), true)];
        };
        $field = static fn (string $id): array => ['id' => $id, 'type' => 'short_text', 'label' => $id, 'required' => false];

        $tabA = $call('GET')[1]['form']['fieldsRevision'];
        $tabB = $tabA;
        [$status, $saved] = $call('PUT', ['fields' => [$field('name'), $field('from_b')], 'expectedFieldsRevision' => $tabB]);
        $this->assertSame(200, $status);
        $tabB = $saved['form']['fieldsRevision'];
        $this->assertNotSame($tabA, $tabB);

        [$status, $refused] = $call('PUT', ['fields' => [$field('name')], 'expectedFieldsRevision' => $tabA]);
        $this->assertSame(409, $status);
        $this->assertSame('form_changed', $refused['code']);
        $this->assertSame(['name', 'from_b'], array_column(self::$forms->getForm($formId)['fields'], 'id'));

        $this->assertSame(200, $call('PUT', ['fields' => [$field('name'), $field('from_b'), $field('more')], 'expectedFieldsRevision' => $tabB])[0], 'its own last save is where it is now');
        $this->assertSame(200, $call('PUT', ['title' => 'Renamed', 'expectedFieldsRevision' => $tabA])[0], 'a save that leaves the fields alone takes nothing out');
        $this->assertSame(200, $call('PUT', ['fields' => [$field('name')]])[0], 'nor is a caller checked that names no revision');
        self::$responses->createResponse($formId, ['answers' => ['name' => 'x']], null);
        $here = $call('GET')[1]['form']['fieldsRevision'];
        self::$responses->createResponse($formId, ['answers' => ['name' => 'y']], null);
        $this->assertSame($here, $call('GET')[1]['form']['fieldsRevision'], 'a submission changes nothing about the fields');
    }

    public function testAPurgedFieldReachesACopySyncingByTime(): void
    {
        $formId = $this->aForm();
        $row = self::$responses->createResponse($formId, ['answers' => ['name' => 'x']], null);
        self::$sqlite->getFormDatabase($formId)->exec("UPDATE responses SET updated_at = '2001-01-01 00:00:00'");

        self::$responses->purgeFieldData($formId, 'name');

        $stmt = self::$sqlite->getFormDatabase($formId)->prepare('SELECT updated_at FROM responses WHERE id = ?');
        $stmt->execute([$row['id']]);
        $this->assertNotSame('2001-01-01 00:00:00', $stmt->fetchColumn());
    }

    public function testARestoredFormDoesNotClaimADeletionHistoryItLost(): void
    {
        $formId = $this->aForm();
        self::$responses->restoreResponses($formId, [[
            'id' => 'restored-1', 'answers' => [], 'metadata' => [], 'status' => 'submitted',
            'submittedAt' => '2020-01-01 00:00:00', 'updatedAt' => '2020-01-01 00:00:00',
        ]]);
        $history = self::$responses->getResponseTombstones($formId, '2000-01-01 00:00:00');
        $this->assertGreaterThan(gmdate('Y-m-d H:i:s', time() - 3600), $history['since'], 'a copy older than this has to read everything again');
    }

    /** @dataProvider patterns */
    public function testAPatternGivesTheBrowsersVerdict(string $pattern, string $value, bool $passes): void
    {
        $formId = $this->aForm([], [[
            'id' => 'name', 'type' => 'short_text', 'label' => 'Name', 'required' => false,
            'validation' => [['type' => 'pattern', 'value' => $pattern, 'message' => 'no']],
        ]]);
        $fields = self::$forms->getForm($formId)['fields'];
        $this->assertSame($passes, self::$responses->validateSubmittedAnswers($fields, ['name' => $value]) === [], "{$pattern} on " . json_encode($value));
    }

    public static function patterns(): array
    {
        return [
            'an escaped slash' => ['^\\d{2}\\/\\d{2}\\/\\d{4}$', '01/02/2024', true],
            'a bare slash' => ['^\\d{2}/\\d{2}$', '01/02', true],
            'an escaped backslash then a slash' => ['^a\\\\/b$', 'a\\/b', true],
            'a slash in a class' => ['^[/]+$', '//', true],
            '\\u in a class' => ['^[A-Za-z\\u00C0-\\u017F ]+$', 'José', true],
            '\\u outside the class' => ['^[A-Za-z\\u00C0-\\u017F ]+$', 'Jos9', false],
            'characters not bytes' => ['^.{1,5}$', '日本語', true],
            'too many characters' => ['^.{1,2}$', '日本語', false],
            'no trailing newline' => ['^\\d{3}$', "123\n", false],
            'a plain match' => ['^\\d{3}$', '123', true],
            'a class of quantifier characters' => ['^[+*]+$', '+*', true],
            'a choice repeated' => ['^(foo|bar)*$', 'foobar', true],
            'an Arabic digit is not a \\d' => ['^\\d{4}$', '١٢٣٤', false],
            'an accented letter is not a \\w' => ['^\\w+$', 'héllo', false],
            'nor a \\W in a class' => ['^[\\W]+$', 'é', true],
            'a boundary is the browser\'s' => ['\\bcat\\b', 'écat', true],
            'a \\u with no code is a u' => ['^\\user$', 'user', true],
            'a surrogate pair is one character' => ['^\\uD83D\\uDE00$', '😀', true],
            'any character' => ['^[^]$', 'x', true],
            'a class that matches nothing' => ['^a[]', 'ab', false],
            'a bracket in a class' => ['^[[]$', '[', true],
            'a letter that means nothing' => ['^\\y$', 'y', true],
            'a letter that means something to PCRE alone' => ['^\\h$', 'h', true],
            'a backspace in a class' => ['^[\\b]$', "\x08", true],
            'something PCRE cannot read is the browser\'s to judge' => ['(?<=a+)b', 'xb', true],
            'a shape the browser will not run' => ['^(a+)+$', 'aaaa', true],
            'and on an answer that would run away' => ['^(a+)+$', str_repeat('a', 40) . '!', false],
        ];
    }

    public function testLengthIsMeasuredAsTheBrowserMeasuresIt(): void
    {
        $formId = $this->aForm([], [[
            'id' => 'name', 'type' => 'short_text', 'label' => 'Name', 'required' => false,
            'validation' => [['type' => 'minLength', 'value' => 3, 'message' => 'short'], ['type' => 'maxLength', 'value' => 4, 'message' => 'long']],
        ]]);
        $fields = self::$forms->getForm($formId)['fields'];
        $this->assertSame([], self::$responses->validateSubmittedAnswers($fields, ['name' => '😀😀']), 'four units to the browser');
        $this->assertNotSame([], self::$responses->validateSubmittedAnswers($fields, ['name' => '😀😀😀']), 'six');
    }
}

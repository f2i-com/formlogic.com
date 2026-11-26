<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\AppController;
use FormLogic\Services\AppService;
use FormLogic\Services\ChatToolsContext;
use FormLogic\Services\ChatToolsService;
use FormLogic\Services\CloudFlowRunner;
use FormLogic\Services\DbContextCapture;
use FormLogic\Services\DesktopCommandService;
use FormLogic\Services\FlowKvService;
use FormLogic\Services\FlowService;
use FormLogic\Services\FormService;
use FormLogic\Services\PackService;
use FormLogic\Services\PlanService;
use FormLogic\Services\ResponseService;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * What a caller SENDS is held to a size the same way as what a computer sends back
 * (RelayResultSizeTest): the JSON as UTF-8 text. Measured with PHP's default escapes, each
 * non-ASCII character is six bytes and each `/` two, so a command's payload, a flow graph, a
 * binding or a run's inputs in any language but English was refused at a third of the documented
 * limit, and a submission's answers were dropped from the run that was meant to read them.
 * No database: the connection is a double that keeps what each statement is given.
 */
final class JsonSizeCapTest extends TestCase
{
    private const PLAIN = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES;

    /** @var list<array{sql: string, params: array<int|string, mixed>}> */
    private array $statements = [];

    /** A value whose JSON is exactly $bytes of UTF-8, nearly all of it three-byte characters. */
    private static function textOf(int $bytes, string $key = 'text'): array
    {
        $room = $bytes - strlen('{"' . $key . '":""}');
        return [$key => str_repeat('语', intdiv($room, 3)) . str_repeat('a', $room % 3)];
    }

    /**
     * @param callable(string): mixed $row what a statement's fetch() answers, by its SQL
     */
    private function connection(callable $row): \PDO
    {
        $this->statements = [];
        $pdo = $this->createMock(\PDO::class);
        $pdo->method('prepare')->willReturnCallback(function (string $sql) use ($row): \PDOStatement {
            $statement = $this->createMock(\PDOStatement::class);
            $statement->method('execute')->willReturnCallback(function (?array $params = null) use ($sql): bool {
                $this->statements[] = ['sql' => $sql, 'params' => $params ?? []];
                return true;
            });
            $statement->method('fetch')->willReturnCallback(static fn () => $row($sql));
            $statement->method('fetchAll')->willReturnCallback(static function () use ($row, $sql): array {
                $found = $row($sql);
                return is_array($found) ? [$found] : [];
            });
            $statement->method('fetchColumn')->willReturn(false);
            $statement->method('rowCount')->willReturn(1);
            return $statement;
        });
        return $pdo;
    }

    /** The parameters of the one statement that wrote to $table. */
    private function written(string $table): array
    {
        $found = array_values(array_filter($this->statements, static fn (array $s): bool => str_contains($s['sql'], 'INSERT INTO ' . $table)));
        $this->assertCount(1, $found, 'one row written to ' . $table);
        return $found[0]['params'];
    }

    private function flows(): FlowService
    {
        $flow = [
            'id' => 'flow-1', 'owner_user_id' => 'owner-1', 'app_id' => 'app-1', 'name' => 'Triage', 'slug' => 'triage',
            'description' => null, 'engine' => 'formlogic', 'flow_json' => '{"nodes":[],"edges":[]}', 'input_schema' => null,
            'output_schema' => null, 'node_capabilities' => null, 'version' => 1, 'enabled' => 1, 'execution_location' => 'auto',
            'created_at' => '2026-01-01 00:00:00', 'updated_at' => '2026-01-01 00:00:00',
        ];
        $service = (new \ReflectionClass(FlowService::class))->newInstanceWithoutConstructor();
        (new \ReflectionProperty(FlowService::class, 'mysql'))->setValue($service, $this->connection(function (string $sql) use ($flow) {
            if (str_contains($sql, 'FROM app_flow_bindings b')) {
                return $flow + ['binding_id' => 'binding-1', 'binding_app_id' => 'app-1'];
            }
            if (str_contains($sql, 'FROM flow_definitions WHERE app_id = :a AND slug = :s')) {
                return $flow;
            }
            if (str_contains($sql, 'FROM flow_run_logs r') && str_contains($sql, 'WHERE r.id = :id')) {
                // The run just written, as it would be read back.
                $run = $this->written('flow_run_logs');
                return [
                    'id' => $run['id'], 'app_id' => $run['app'], 'form_id' => $run['form'], 'response_id' => $run['resp'],
                    'binding_id' => $run['binding'], 'flow_definition_id' => $run['flow'], 'flow_slug' => 'triage',
                    'trigger_event' => $run['event'], 'correlation_id' => $run['corr'], 'idempotency_key' => $run['key'],
                    'status' => $run['status'], 'input_snapshot_json' => $run['input'], 'output_actions_json' => null,
                    'error_json' => null, 'started_at' => null, 'finished_at' => null, 'created_at' => '2026-01-01 00:00:00',
                ];
            }
            return false; // no revision row, no parent run
        }));
        return $service;
    }

    public function testAConnectorCommandsPayloadIsMeasuredAsUtf8Text(): void
    {
        $service = (new \ReflectionClass(DesktopCommandService::class))->newInstanceWithoutConstructor();
        (new \ReflectionProperty(DesktopCommandService::class, 'mysql'))->setValue($service, $this->connection(function (string $sql) {
            $row = $this->written('desktop_commands');
            return [
                'id' => $row['id'], 'owner_user_id' => $row['owner'], 'app_id' => $row['app'], 'connector_id' => $row['connector'],
                'command' => $row['command'], 'payload_json' => $row['payload'], 'idempotency_key' => $row['key'], 'status' => 'pending',
                'result_json' => null, 'error_json' => null, 'requested_by_user_id' => $row['req'], 'created_at' => '2026-01-01 00:00:00',
                'expires_at' => $row['exp'],
            ];
        }));
        $send = static fn (array $payload): array => $service->enqueue('owner-1', 'member-1', 'app-1', [
            'connectorId' => 'notes', 'command' => 'note.add', 'payload' => $payload,
        ]);

        // 15,000 bytes of text, 30,000 once escaped: over the 16 KiB limit only as PHP wrote it.
        $payload = ['text' => str_repeat('语', 5000), 'link' => 'https://example.com/notes/1'];
        $this->assertGreaterThan(DesktopCommandService::MAX_PAYLOAD_BYTES, strlen((string) json_encode($payload)));
        $queued = $send($payload);
        $this->assertTrue($queued['created']);
        $this->assertSame($payload, $queued['command']['payload']);
        $this->assertSame(json_encode($payload, self::PLAIN), $this->written('desktop_commands')['payload']);

        // Up to the limit in its own bytes, and no further.
        $this->statements = [];
        $this->assertTrue($send(self::textOf(DesktopCommandService::MAX_PAYLOAD_BYTES))['created']);
        $this->assertSame(DesktopCommandService::MAX_PAYLOAD_BYTES, strlen($this->written('desktop_commands')['payload']));
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('payload exceeds the 16384-byte limit');
        $send(self::textOf(DesktopCommandService::MAX_PAYLOAD_BYTES + 1));
    }

    public function testAFlowGraphIsMeasuredAsUtf8Text(): void
    {
        $graph = static fn (array $data): array => ['nodes' => [['id' => 'n1', 'type' => 'template', 'data' => $data]], 'edges' => []];

        // 180,000 bytes of text, 360,000 once escaped: over the 256 KiB limit only as PHP wrote it.
        $wide = $graph(['template' => str_repeat('语', 60000), 'help' => 'https://example.com/help/1']);
        $this->assertGreaterThan(FlowService::MAX_FLOW_JSON_BYTES, strlen((string) json_encode($wide)));
        $this->assertSame($wide, FlowService::sanitizeFlowJson($wide));

        $around = strlen((string) json_encode($graph(['template' => '']), self::PLAIN)) - strlen('{"template":""}');
        $atLimit = $graph(self::textOf(FlowService::MAX_FLOW_JSON_BYTES - $around, 'template'));
        $this->assertSame(FlowService::MAX_FLOW_JSON_BYTES, strlen((string) json_encode($atLimit, self::PLAIN)));
        $this->assertSame($atLimit, FlowService::sanitizeFlowJson($atLimit));
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('flowJson exceeds the 256KB limit');
        FlowService::sanitizeFlowJson($graph(self::textOf(FlowService::MAX_FLOW_JSON_BYTES - $around + 1, 'template')));
    }

    public function testABindingsColumnsAreMeasuredAsUtf8Text(): void
    {
        $binding = static fn (array $inputMap): array => FlowService::sanitizeBinding([
            'event' => 'aokie.call.ended', 'flow' => 'call-triage', 'mode' => 'async', 'inputMap' => $inputMap,
        ]);

        // 12,000 bytes of text, 24,000 once escaped: over the 16 KiB limit only as PHP wrote it.
        $wide = ['greeting' => str_repeat('语', 4000), 'help' => 'https://example.com/help/1'];
        $this->assertGreaterThan(FlowService::MAX_BINDING_JSON_BYTES, strlen((string) json_encode($wide)));
        $this->assertSame($wide, $binding($wide)['inputMap']);

        $atLimit = self::textOf(FlowService::MAX_BINDING_JSON_BYTES, 'greeting');
        $this->assertSame($atLimit, $binding($atLimit)['inputMap']);
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('Binding inputMap exceeds the 16KB limit');
        $binding(self::textOf(FlowService::MAX_BINDING_JSON_BYTES + 1, 'greeting'));
    }

    public function testAFlowsSchemasAreMeasuredAsUtf8Text(): void
    {
        $service = (new \ReflectionClass(FlowService::class))->newInstanceWithoutConstructor();
        $meta = static fn (array $data): array => (new \ReflectionMethod(FlowService::class, 'sanitizeFlowMeta'))->invoke($service, $data);

        $wide = ['type' => 'object', 'description' => str_repeat('语', 4000), '$id' => 'https://example.com/schemas/1'];
        $this->assertGreaterThan(FlowService::MAX_BINDING_JSON_BYTES, strlen((string) json_encode($wide)));
        $this->assertSame([$wide, $wide, null], $meta(['inputSchema' => $wide, 'outputSchema' => $wide]));

        $atLimit = self::textOf(FlowService::MAX_BINDING_JSON_BYTES, 'description');
        $this->assertSame([null, $atLimit, null], $meta(['outputSchema' => $atLimit]));
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('outputSchema exceeds the 16KB limit');
        $meta(['outputSchema' => self::textOf(FlowService::MAX_BINDING_JSON_BYTES + 1, 'description')]);
    }

    /** @return array<string, array{string}> */
    public static function reservers(): array
    {
        return ['an app\'s run' => ['app'], 'an owner\'s run' => ['owner']];
    }

    #[\PHPUnit\Framework\Attributes\DataProvider('reservers')]
    public function testAReservedRunsInputsAreMeasuredAsUtf8Text(string $as): void
    {
        $service = $this->flows();
        $reserve = static function (array $snapshot) use ($service, $as): array {
            $data = [
                'flowSlug' => 'triage', 'triggerEvent' => 'manual', 'correlationId' => 'c-1', 'idempotencyKey' => 'k-1',
                'queued' => true, 'inputSnapshot' => $snapshot,
            ];
            return $as === 'app' ? $service->reserveRun('app-1', 'owner-1', $data) : $service->reserveOwnerRun('owner-1', $data + ['appId' => 'app-1']);
        };

        // 45,000 bytes of text, 90,000 once escaped: over the 64 KiB limit only as PHP wrote it.
        $inputs = ['note' => str_repeat('语', 15000), 'source' => 'https://example.com/notes/1'];
        $this->assertGreaterThan(FlowService::MAX_INPUT_SNAPSHOT_BYTES, strlen((string) json_encode($inputs)));
        $reserved = $reserve($inputs);
        $this->assertTrue($reserved['created']);
        $this->assertSame($inputs, $reserved['run']['inputSnapshot']);
        $this->assertSame(json_encode($inputs, self::PLAIN), $this->written('flow_run_logs')['input']);

        $this->statements = [];
        $reserve(self::textOf(FlowService::MAX_INPUT_SNAPSHOT_BYTES, 'note'));
        $this->assertSame(FlowService::MAX_INPUT_SNAPSHOT_BYTES, strlen($this->written('flow_run_logs')['input']));
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('inputSnapshot exceeds the 64KB limit');
        $reserve(self::textOf(FlowService::MAX_INPUT_SNAPSHOT_BYTES + 1, 'note'));
    }

    public function testASubmissionsAnswersReachTheRunWhenTheyFitAsUtf8Text(): void
    {
        $service = $this->flows();

        // 45,000 bytes of answers, 90,000 once escaped. They were dropped as "too large".
        $answers = ['comments' => str_repeat('语', 15000), 'site' => 'https://example.com/a/b'];
        $this->assertGreaterThan(FlowService::MAX_INPUT_SNAPSHOT_BYTES, strlen((string) json_encode($answers)));
        $this->assertSame(1, $service->enqueueSubmissionBindings('form-1', 'response-1', $answers));
        $stored = $this->written('flow_run_logs')['input'];
        $this->assertSame(
            ['event' => ['name' => 'form.submitted', 'data' => ['formId' => 'form-1', 'responseId' => 'response-1', 'answers' => $answers]]],
            json_decode((string) $stored, true)
        );
        $this->assertStringNotContainsString('\\u', (string) $stored);
        $this->assertStringNotContainsString('\\/', (string) $stored);

        // Past the limit in their own bytes the envelope is still kept, without them.
        $this->statements = [];
        $this->assertSame(1, $service->enqueueSubmissionBindings('form-1', 'response-2', ['comments' => str_repeat('语', 22000)]));
        $this->assertSame(
            ['event' => ['name' => 'form.submitted', 'data' => ['formId' => 'form-1', 'responseId' => 'response-2', 'answersTruncated' => true]]],
            json_decode((string) $this->written('flow_run_logs')['input'], true)
        );
    }

    public function testARecordEventsRecordReachesTheRunWhenItFitsAsUtf8Text(): void
    {
        $service = $this->flows();
        $eventId = str_repeat('a', 32);

        $record = ['id' => 7, 'notes' => str_repeat('语', 15000), 'link' => 'https://example.com/a/b'];
        $this->assertGreaterThan(FlowService::MAX_INPUT_SNAPSHOT_BYTES, strlen((string) json_encode($record)));
        $this->assertSame(1, $service->enqueueNativeRecordEvent('app-1', $eventId, 'app.record.created.Notes', ['record' => $record], ['binding-1']));
        $data = json_decode((string) $this->written('flow_run_logs')['input'], true)['event']['data'];
        $this->assertSame($record, $data['record']);
        $this->assertArrayNotHasKey('recordTruncated', $data);

        $this->statements = [];
        $service->enqueueNativeRecordEvent('app-1', $eventId, 'app.record.created.Notes', ['record' => ['notes' => str_repeat('语', 22000)]], ['binding-1']);
        $data = json_decode((string) $this->written('flow_run_logs')['input'], true)['event']['data'];
        $this->assertSame([], $data['record']);
        $this->assertTrue($data['recordTruncated']);
    }

    public function testACloudRunsInputsAreMeasuredAsUtf8Text(): void
    {
        // The allowance is asked for straight after the size check, and nothing is written before it.
        $plans = $this->createMock(PlanService::class);
        $plans->method('checkAndIncrement')->willThrowException(new \RuntimeException('reached the allowance'));
        $runner = (new \ReflectionClass(CloudFlowRunner::class))->newInstanceWithoutConstructor();
        (new \ReflectionProperty(CloudFlowRunner::class, 'flowService'))->setValue($runner, $this->flows());
        (new \ReflectionProperty(CloudFlowRunner::class, 'plans'))->setValue($runner, $plans);
        $flow = ['id' => 'flow-1', 'appId' => 'app-1', 'flowJson' => ['nodes' => [], 'edges' => []]];

        $inputs = ['note' => str_repeat('语', 15000), 'source' => 'https://example.com/notes/1'];
        $this->assertGreaterThan(FlowService::MAX_INPUT_SNAPSHOT_BYTES, strlen((string) json_encode($inputs)));
        foreach ([$inputs, self::textOf(FlowService::MAX_INPUT_SNAPSHOT_BYTES, 'note')] as $fits) {
            try {
                $runner->run($flow, 'owner-1', $fits);
                $this->fail('the allowance was never asked for');
            } catch (\RuntimeException $e) {
                $this->assertSame('reached the allowance', $e->getMessage());
            }
        }
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('inputs exceed the 64KB limit');
        $runner->run($flow, 'owner-1', self::textOf(FlowService::MAX_INPUT_SNAPSHOT_BYTES + 1, 'note'));
    }

    public function testAScriptsFlowRunInputIsMeasuredAsUtf8Text(): void
    {
        $limit = 16384; // DbContextCapture's cap on one ctx.flows.run() input: docs/FORMLOGIC_FLOWS.md §11
        $capture = new DbContextCapture();

        // 12,000 bytes of text, 24,000 once escaped: over the 16 KiB limit only as PHP wrote it.
        $input = ['note' => str_repeat('语', 4000), 'source' => 'https://example.com/notes/1'];
        $this->assertGreaterThan($limit, strlen((string) json_encode($input)));
        $this->assertSame(['queued' => true], $capture->addFlowRun('triage', $input));
        $this->assertSame([['slug' => 'triage', 'input' => $input]], $capture->getFlowRuns());

        // Up to the limit in its own bytes, and no further.
        $this->assertSame(['queued' => true], $capture->addFlowRun('follow-up', self::textOf($limit, 'note')));
        $this->assertSame(['queued' => false, 'error' => 'flow input exceeds the 16KB limit'], $capture->addFlowRun('escalate', self::textOf($limit + 1, 'note')));
    }

    public function testAFlowKvValueIsMeasuredAndKeptAsUtf8Text(): void
    {
        $kv = (new \ReflectionClass(FlowKvService::class))->newInstanceWithoutConstructor();
        (new \ReflectionProperty(FlowKvService::class, 'maxKeysPerScope'))->setValue($kv, FlowKvService::MAX_KEYS_PER_SCOPE);
        (new \ReflectionProperty(FlowKvService::class, 'maxKeysPerStore'))->setValue($kv, FlowKvService::MAX_KEYS_PER_STORE);
        (new \ReflectionProperty(FlowKvService::class, 'mysql'))->setValue($kv, $this->connection(function () {
            // The entry just written, as it would be read back.
            $row = $this->written('flow_kv');
            return ['app_id' => $row['a'], 'scope' => $row['s'], 'k' => $row['k'], 'v' => $row['v'], 'updated_at' => '2026-01-01 00:00:00'];
        }));
        $put = static fn (array $value): array => $kv->put('owner-1', 'app-1', 'flow:triage', 'last-note', $value);

        // 45,000 bytes of text, 90,000 once escaped: over the 64 KiB limit only as PHP wrote it.
        $value = ['note' => str_repeat('语', 15000), 'source' => 'https://example.com/notes/1'];
        $this->assertGreaterThan(FlowKvService::MAX_VALUE_BYTES, strlen((string) json_encode($value)));
        $this->assertSame($value, $put($value)['v']);
        $this->assertSame(json_encode($value, self::PLAIN), $this->written('flow_kv')['v']);

        // Up to the limit in its own bytes, and no further.
        $this->statements = [];
        $atLimit = self::textOf(FlowKvService::MAX_VALUE_BYTES, 'note');
        $this->assertSame($atLimit, $put($atLimit)['v']);
        $this->assertSame(FlowKvService::MAX_VALUE_BYTES, strlen($this->written('flow_kv')['v']));
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('Value exceeds the 64KB limit');
        $put(self::textOf(FlowKvService::MAX_VALUE_BYTES + 1, 'note'));
    }

    /** An app's reports: one document of text, the list's JSON exactly $bytes of UTF-8. */
    private static function reportsOf(int $bytes): array
    {
        $document = static fn (string $body): array => ['id' => 'doc_1', 'name' => '月报', 'type' => 'document', 'blocks' => [['id' => 'blk_1', 'kind' => 'text', 'title' => null, 'body' => $body]]];
        $room = $bytes - strlen((string) json_encode([$document('')], self::PLAIN));
        return [$document(str_repeat('语', intdiv($room, 3)) . str_repeat('a', $room % 3))];
    }

    /**
     * The AI's report tools over an app that holds $reports. What a save would write is put in
     * $saved; a save the tool refuses leaves it as it was.
     *
     * @param list<array<string, mixed>>|null $saved
     */
    private function reportTools(array $reports, ?array &$saved): ChatToolsService
    {
        $app = ['id' => 'app-1', 'ownerId' => 'owner-1', 'name' => 'Clinic', 'reports' => $reports];
        $apps = $this->createMock(AppService::class);
        $apps->method('getApp')->willReturn($app);
        $apps->method('updateAppLocked')->willReturnCallback(static function (string $id, callable $change) use ($app, &$saved): array {
            $saved = $change($app)['reports'];
            return $app;
        });
        return new ChatToolsService($this->createMock(FormService::class), $apps, $this->createMock(ResponseService::class));
    }

    /**
     * An app's reports are one document wherever they are saved: by the AI's tools, by the owner,
     * and in a pack (exported from the app, and imported). The limit is docs/PACK_FORMAT.md's 256 KB.
     */
    public function testAnAppsReportsAreMeasuredAsUtf8TextWhereverTheyAreSaved(): void
    {
        $cap = 262144;
        // 180,000 bytes of text, 360,000 once escaped: over the limit only as PHP wrote it.
        $wide = self::reportsOf(180000);
        $this->assertGreaterThan($cap, strlen((string) json_encode($wide)));

        // The AI adds a chart, or a document, to what the app has.
        $owner = new ChatToolsContext('owner-1');
        $chart = ['appId' => 'app-1', 'name' => 'Visits', 'spec' => ['formId' => 'form-1', 'viz' => 'bar']];
        $saved = null;
        $this->reportTools($wide, $saved)->call('create_report', $chart, $owner);
        $this->assertSame(['document', 'builder'], array_column((array) $saved, 'type'));
        $saved = null;
        $this->reportTools($wide, $saved)->call('create_document', ['appId' => 'app-1', 'name' => '周报', 'blocks' => [['kind' => 'text', 'body' => '本周的来访']]], $owner);
        $this->assertSame(['document', 'document'], array_column((array) $saved, 'type'));
        // Up to the limit in their own bytes, and no further (a chart's entry is as long whatever its id).
        $entry = strlen((string) json_encode(['id' => 'rep_' . str_repeat('0', 12), 'name' => 'Visits', 'type' => 'builder', 'spec' => $chart['spec']], self::PLAIN));
        $this->reportTools(self::reportsOf($cap - 1 - $entry), $saved)->call('create_report', $chart, $owner);
        $this->assertSame($cap, strlen((string) json_encode($saved, self::PLAIN)));
        try {
            $this->reportTools(self::reportsOf($cap - $entry), $saved)->call('create_report', $chart, $owner);
            $this->fail('reports past the limit were saved');
        } catch (\Exception $e) {
            $this->assertSame('Reports exceed the 256KB limit', $e->getMessage());
        }

        // The owner saves them.
        $apps = $this->createMock(AppService::class);
        $apps->method('getApp')->willReturn(['id' => 'app-1', 'ownerId' => 'owner-1', 'name' => 'Clinic', 'settings' => []]);
        $apps->method('updateApp')->willReturnCallback(static fn (string $id, array $data): array => ['id' => $id, 'ownerId' => 'owner-1', 'name' => 'Clinic', 'settings' => []] + $data);
        $controller = new AppController($apps);
        $save = static function (array $reports) use ($controller): array {
            $answer = $controller->update(
                (new ServerRequestFactory())->createServerRequest('PUT', '/api/apps/app-1')->withAttribute('userId', 'owner-1')->withParsedBody(['reports' => $reports]),
                (new ResponseFactory())->createResponse(),
                ['id' => 'app-1'],
            );
            return [$answer->getStatusCode(), json_decode((string) $answer->getBody(), true)['message'] ?? null];
        };
        $this->assertSame([200, null], $save($wide));
        $this->assertSame([200, null], $save(self::reportsOf($cap)));
        $this->assertSame([400, 'Reports data is too large'], $save(self::reportsOf($cap + 1)));

        // A pack carries them.
        $pack = static fn (array $reports): array => [
            'formatVersion' => 1, 'packMeta' => ['id' => 'clinic', 'name' => 'Clinic'],
            'forms' => [['packFormId' => 'visits', 'title' => 'Visits']],
            'apps' => [['packAppId' => 'clinic', 'name' => 'Clinic', 'reports' => $reports]],
        ];
        PackService::validateDefinition($pack($wide));
        PackService::validateDefinition($pack(self::reportsOf($cap)));
        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage("App 'clinic' reports exceeds 256KB limit");
        PackService::validateDefinition($pack(self::reportsOf($cap + 1)));
    }

    /**
     * An app's custom logic and a form's or an app's screen are code and markup: each `/` of a
     * comment, a closing tag or an address was two bytes, and each character of a label in another
     * language six. Every save and a pack hold them to the one measure, UTF-8 text, so what one
     * accepts the other does not refuse.
     */
    public function testCustomLogicAndScreensAreMeasuredAsUtf8TextBySavesAndPacksAlike(): void
    {
        $cap = \FormLogic\Helpers\CustomLogicSanitizer::MAX_BUNDLE_BYTES;
        // One rule for the owner's save, the AI's and a pack's: withinSizeCap.
        $this->assertTrue(\FormLogic\Helpers\CustomLogicSanitizer::withinSizeCap(self::textOf($cap, 'scripts')));
        $slashes = ['scripts' => str_repeat('/', $cap - strlen('{"scripts":""}'))];
        $this->assertTrue(\FormLogic\Helpers\CustomLogicSanitizer::withinSizeCap($slashes), 'a slash is one byte');
        $this->assertFalse(\FormLogic\Helpers\CustomLogicSanitizer::withinSizeCap(self::textOf($cap + 1, 'scripts')));

        $pack = static fn (array $form, array $app): array => [
            'formatVersion' => 1, 'packMeta' => ['id' => 'clinic', 'name' => 'Clinic'],
            'forms' => [['packFormId' => 'visits', 'title' => 'Visits'] + $form],
            'apps' => [['packAppId' => 'clinic', 'name' => 'Clinic'] + $app],
        ];
        $screen = 2097152;
        PackService::validateDefinition($pack(['customScreen' => self::textOf($screen, 'html')], ['customScreen' => self::textOf($screen, 'html')]));
        PackService::validateDefinition($pack(['fields' => [self::textOf($screen - 2, 'label')]], []));
        $refused = static function (array $definition): string {
            try { PackService::validateDefinition($definition); }
            catch (\RuntimeException $e) { return $e->getMessage(); }
            return 'kept';
        };
        $this->assertSame("Form 'visits' custom screen exceeds 2MB limit", $refused($pack(['customScreen' => self::textOf($screen + 1, 'html')], [])));
        $this->assertSame("App 'clinic' custom screen exceeds 2MB limit", $refused($pack([], ['customScreen' => self::textOf($screen + 1, 'html')])));
        $this->assertSame("Form 'visits' fields data exceeds 2MB limit", $refused($pack(['fields' => [self::textOf($screen - 1, 'label')]], [])));
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\CloudFlowRunner;
use FormLogic\Services\FlowService;
use FormLogic\Services\PlanService;
use FormLogic\Services\ResponseListRefused;
use FormLogic\Services\ResponseService;
use PHPUnit\Framework\TestCase;

/**
 * A cloud flow's list of a form's records (formlogic_list_responses) where the form is kept in an
 * app's table that refuses the list (ResponseListRefused: a filter the table has no answer for,
 * rows past what it reads by offset). The refusal is the node's failure, in its own words and
 * with its code, as every node's failure is reported. It was the run's "The flow run failed",
 * with no node named and nothing said of why. No database: the connection keeps what each
 * statement is given.
 */
final class CloudFlowListRefusalTest extends TestCase
{
    /** @var list<array{sql: string, params: array<int|string, mixed>}> */
    private array $statements = [];

    private function runner(\Throwable|array $listed): CloudFlowRunner
    {
        $this->statements = [];
        $pdo = $this->createMock(\PDO::class);
        $pdo->method('prepare')->willReturnCallback(function (string $sql): \PDOStatement {
            $statement = $this->createMock(\PDOStatement::class);
            $statement->method('execute')->willReturnCallback(function (?array $params = null) use ($sql): bool {
                $this->statements[] = ['sql' => $sql, 'params' => $params ?? []];
                return true;
            });
            // The form is the flow owner's own, and not an encrypted one.
            $statement->method('fetchColumn')->willReturn(str_contains($sql, 'FROM forms') ? 'owner-1' : false);
            $statement->method('fetch')->willReturn(false);
            return $statement;
        });
        $responses = $this->createMock(ResponseService::class);
        $listing = $responses->method('getFormResponses');
        $listed instanceof \Throwable ? $listing->willThrowException($listed) : $listing->willReturn($listed);
        $flows = $this->createMock(FlowService::class);
        $flows->method('compiledIrForCurrentVersion')->willReturn(null);
        $flows->method('ensureFlowVersion')->willReturn('version-1');
        $runner = (new \ReflectionClass(CloudFlowRunner::class))->newInstanceWithoutConstructor();
        foreach (['mysql' => $pdo, 'responses' => $responses, 'flowService' => $flows, 'plans' => $this->createMock(PlanService::class), 'maxWallClockSeconds' => 30] as $name => $value) {
            (new \ReflectionProperty(CloudFlowRunner::class, $name))->setValue($runner, $value);
        }
        return $runner;
    }

    /** A workspace flow that lists one form's records by a caller's phone number. */
    private static function flow(string $formId): array
    {
        return ['id' => 'flow-' . $formId, 'appId' => null, 'ownerUserId' => 'owner-1', 'flowJson' => ['nodes' => [
            ['id' => 'find-caller', 'type' => 'formlogic_list_responses', 'data' => ['formId' => $formId, 'filters' => [['field' => 'phone', 'op' => 'phone_eq', 'value' => '+61400000000']]]],
        ], 'edges' => []]];
    }

    /** The error the run ended with, as it was written to its row. */
    private function recorded(): ?array
    {
        $finals = array_values(array_filter($this->statements, static fn (array $s): bool => str_contains($s['sql'], 'UPDATE flow_run_logs')));
        $this->assertCount(1, $finals, 'the run was ended once');
        return json_decode((string) $finals[0]['params']['error'], true);
    }

    /** @return array<string, array{ResponseListRefused}> */
    public static function refusals(): array
    {
        return [
            'a filter the table has no answer for' => [new ResponseListRefused('This form\'s records are kept in an app\'s table, which cannot be listed that way: `phone` is not a column of `contacts`.')],
            'rows past what the table reads by offset' => [new ResponseListRefused('This form\'s records are kept in an app\'s table, which is read by offset no further than 10,000 rows in. Narrow the list with a filter to reach the rest.', ResponseListRefused::PAST_OFFSET_LIMIT)],
        ];
    }

    #[\PHPUnit\Framework\Attributes\DataProvider('refusals')]
    public function testAListTheFormsTableRefusesIsThatNodesFailureInItsOwnWords(ResponseListRefused $refused): void
    {
        $formId = 'form-' . bin2hex(random_bytes(6));
        $outcome = $this->runner($refused)->run(self::flow($formId), 'owner-1', []);

        $error = ['code' => 'node_failed', 'message' => "Node 'find-caller': " . $refused->getMessage() . ' (' . $refused->errorCode . ')', 'nodeId' => 'find-caller'];
        $this->assertSame(['ok' => true, 'status' => 'error', 'error' => $error], ['ok' => $outcome['ok'], 'status' => $outcome['status'], 'error' => $outcome['error']]);
        $this->assertSame($error, $this->recorded());
    }

    /** What is no list refusal is still kept from the run's log: its detail goes to the server log alone. */
    public function testAnyOtherFailureOfTheListIsStillNotSaidToTheOwner(): void
    {
        $before = (string) ini_get('error_log');
        $log = sys_get_temp_dir() . '/fl-cloud-list-' . bin2hex(random_bytes(4)) . '.log';
        ini_set('error_log', $log);
        try {
            $outcome = $this->runner(new \RuntimeException('SQLSTATE[HY000]: database is locked at /srv/storage/x.sqlite'))->run(self::flow('form-' . bin2hex(random_bytes(6))), 'owner-1', []);
        } finally {
            ini_set('error_log', $before);
            @unlink($log);
        }
        $this->assertSame(['code' => 'node_failed', 'message' => 'The flow run failed'], $outcome['error']);
        $this->assertSame(['code' => 'node_failed', 'message' => 'The flow run failed'], $this->recorded());

        // And a list that is answered is the node's output, as before.
        $done = $this->runner([['id' => 'r1', 'answers' => ['phone' => '+61400000000', 'name' => 'Ana']]])->run(self::flow('form-' . bin2hex(random_bytes(6))), 'owner-1', []);
        $this->assertSame('done', $done['status']);
        $this->assertSame(1, $done['result']['count']);
    }
}

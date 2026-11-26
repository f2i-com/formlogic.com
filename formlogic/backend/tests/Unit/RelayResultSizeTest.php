<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\DesktopCommandService;
use FormLogic\Services\FlowService;
use PHPUnit\Framework\TestCase;

/**
 * What a computer sends back when it finishes a flow run or a connector command is held to a size,
 * and that size is the JSON as UTF-8 text, the way the computer measured it before sending. PHP's
 * default escapes write each non-ASCII character as \uXXXX (and each `/` as `\/`), so the same
 * result measured that way is up to three times as long, and one in any language but English was
 * refused well under the limit. No database: the statement is a double that keeps what it is given.
 */
final class RelayResultSizeTest extends TestCase
{
    /** @return array{status: string, resultJson: ?string, errorJson: ?string, actionsJson: ?string} */
    private static function completion(array $data): array
    {
        $service = (new \ReflectionClass(FlowService::class))->newInstanceWithoutConstructor();
        return (new \ReflectionMethod(FlowService::class, 'sanitizeCompletion'))->invoke($service, $data);
    }

    public function testAFlowRunsResultIsMeasuredAsUtf8Text(): void
    {
        // 120,000 bytes of text, 360,000 once escaped: over the 256 KiB limit only as PHP wrote it.
        $result = ['text' => str_repeat('é', 60000), 'source' => 'https://example.com/notes/1'];
        $this->assertGreaterThan(FlowService::MAX_FLOW_JSON_BYTES, strlen((string) json_encode($result)));
        $clean = self::completion(['status' => 'done', 'result' => $result]);
        $this->assertSame(json_encode($result, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), $clean['resultJson']);
        $this->assertSame($result, json_decode((string) $clean['resultJson'], true));

        // Up to the limit in its own bytes, and no further.
        $room = FlowService::MAX_FLOW_JSON_BYTES - strlen('{"text":""}');
        $this->assertSame(FlowService::MAX_FLOW_JSON_BYTES, strlen((string) self::completion(['status' => 'done', 'result' => ['text' => str_repeat('语', intdiv($room, 3)) . str_repeat('a', $room % 3)]])['resultJson']));
        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('result exceeds the 256KB limit');
        self::completion(['status' => 'done', 'result' => ['text' => str_repeat('语', intdiv($room, 3) + 1)]]);
    }

    public function testAConnectorCommandsResultAndErrorAreMeasuredAsUtf8Text(): void
    {
        $bound = [];
        $statement = $this->createMock(\PDOStatement::class);
        $statement->method('execute')->willReturnCallback(static function (?array $params = null) use (&$bound): bool {
            if (isset($params['s'])) $bound = $params;
            return true;
        });
        $statement->method('rowCount')->willReturn(1);
        $statement->method('fetch')->willReturn(false);
        $pdo = $this->createMock(\PDO::class);
        $pdo->method('prepare')->willReturn($statement);
        $service = (new \ReflectionClass(DesktopCommandService::class))->newInstanceWithoutConstructor();
        (new \ReflectionProperty(DesktopCommandService::class, 'mysql'))->setValue($service, $pdo);

        // 60,000 bytes of text, 120,000 once escaped: over the 64 KiB limit only as PHP wrote it.
        $result = ['transcript' => str_repeat('语', 20000), 'recording' => 'https://example.com/r/1'];
        $error = ['message' => str_repeat('é', 30000)];
        $this->assertGreaterThan(DesktopCommandService::MAX_RESULT_BYTES, strlen((string) json_encode($result)));
        $this->assertGreaterThan(DesktopCommandService::MAX_RESULT_BYTES, strlen((string) json_encode($error)));
        $service->complete('command-1', 'owner-1', ['status' => 'done', 'result' => $result, 'error' => $error]);
        $this->assertSame(json_encode($result, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), $bound['result']);
        $this->assertSame(json_encode($error, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), $bound['error']);

        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('result exceeds the 65536-byte limit');
        $service->complete('command-1', 'owner-1', ['status' => 'done', 'result' => ['transcript' => str_repeat('语', 22000)]]);
    }
}

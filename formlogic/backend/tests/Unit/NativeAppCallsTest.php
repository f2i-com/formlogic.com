<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Database\MySQLConnection;
use FormLogic\Services\NativeAppCalls;
use PHPUnit\Framework\TestCase;

/**
 * The record of an app's calls, apart from MySQL (Integration\NativeAppCallsTest writes and trims
 * it for real): what of a failed call's answer is kept, and that writing it down never fails the
 * call it is about.
 */
final class NativeAppCallsTest extends TestCase
{
    public function testAFailedCallKeepsTheFirstWordsOfItsErrorOnOneLine(): void
    {
        // SoftN's handlers answer {error: "…"}; some answer {message: "…"}, or an error that is itself an object.
        $this->assertSame('Give a title of 1 to 200 characters', NativeAppCalls::errorOf(['error' => 'Give a title of 1 to 200 characters']));
        $this->assertSame('No such task', NativeAppCalls::errorOf((object) ['error' => 'No such task', 'code' => 'not_found']));
        $this->assertSame('The list is full', NativeAppCalls::errorOf(['message' => 'The list is full']));
        $this->assertSame('Bad date', NativeAppCalls::errorOf(['error' => ['message' => 'Bad date', 'field' => 'when']]));
        $this->assertSame('Bad date', NativeAppCalls::errorOf((object) ['error' => (object) ['message' => 'Bad date']]));
        // An answer that is text is its own error.
        $this->assertSame('Service unavailable', NativeAppCalls::errorOf("  Service\n\tunavailable \r\n"));
        // An answer that says nothing in words keeps nothing.
        foreach ([null, [], ['error' => true], ['error' => 7], (object) [], ['items' => []], 42, '', "  \n "] as $silent) {
            $this->assertNull(NativeAppCalls::errorOf($silent), var_export($silent, true));
        }
    }

    public function testAnErrorIsCutToTwoHundredCharactersAndIsAlwaysValidText(): void
    {
        $long = str_repeat('word ', 100);
        $short = NativeAppCalls::shortError($long);
        $this->assertSame(NativeAppCalls::ERROR_LENGTH, mb_strlen((string) $short));
        $this->assertStringEndsWith('…', (string) $short);
        $this->assertSame(str_repeat('é', 200), NativeAppCalls::shortError(str_repeat('é', 200)), 'two hundred characters are kept whole, however many bytes they are');
        $this->assertSame(200, mb_strlen((string) NativeAppCalls::shortError(str_repeat('é', 201))));
        // Control characters and broken UTF-8 never reach the record, or the page's JSON.
        $this->assertSame('a b', NativeAppCalls::shortError("a\x00\x07b"));
        $broken = NativeAppCalls::shortError("caf\xC3 au lait");
        $this->assertTrue(mb_check_encoding((string) $broken, 'UTF-8'));
        $this->assertStringContainsString('au lait', (string) $broken);
        $this->assertNull(NativeAppCalls::shortError(null));
    }

    public function testACallThatCannotBeWrittenDownIsNotAnErrorAndSaysWhyInTheLog(): void
    {
        $mysql = $this->createMock(MySQLConnection::class);
        $mysql->method('getConnection')->willThrowException(new \PDOException('MySQL Connection failed'));
        $calls = new NativeAppCalls($mysql);
        $log = tempnam(sys_get_temp_dir(), 'fl-calls-log-');
        $previous = ini_set('error_log', (string) $log);
        try {
            $this->assertFalse($calls->record('app-1', 'POST', '/api/items', 201, 12, null, 'owner'));
        } finally {
            ini_set('error_log', $previous === false ? '' : $previous);
        }
        $said = (string) file_get_contents((string) $log);
        unlink((string) $log);
        $this->assertStringContainsString('App call not recorded for app app-1', $said);
    }

    public function testOnlyTheMethodsAndCallersThereAreAreWrittenDown(): void
    {
        $mysql = $this->createMock(MySQLConnection::class);
        $mysql->expects($this->never())->method('getConnection');
        $calls = new NativeAppCalls($mysql);
        $this->assertFalse($calls->record('app-1', 'PATCH', '/api/items', 200, 1, null, 'owner'));
        $this->assertFalse($calls->record('app-1', 'GET', '/api/items', 200, 1, null, 'admin'));
        $this->assertFalse($calls->record('', 'GET', '/api/items', 200, 1, null, 'owner'));
    }

    public function testAReadThatFailsIsAFailureNotAnEmptyRecord(): void
    {
        $mysql = $this->createMock(MySQLConnection::class);
        $mysql->method('getConnection')->willThrowException(new \PDOException('MySQL Connection failed'));
        $this->expectException(\PDOException::class);
        (new NativeAppCalls($mysql))->recent('app-1');
    }
}

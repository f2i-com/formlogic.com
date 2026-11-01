<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Support\StartupFailure;
use PHPUnit\Framework\TestCase;

final class StartupFailureTest extends TestCase
{
    public function testADatabaseThatIsDownIsATryAgainNotAFault(): void
    {
        $answer = StartupFailure::answerTo(new \PDOException('MySQL Connection failed'));

        $this->assertSame(503, $answer['status']);
        $this->assertSame(30, $answer['retryAfter']);
        $this->assertTrue($answer['body']['retryable']);
        $this->assertStringNotContainsString('MySQL', $answer['body']['message']);
    }

    public function testAnythingElseSaysNothingOfWhatHappened(): void
    {
        $answer = StartupFailure::answerTo(new \RuntimeException('/var/www/formlogic/backend/config/settings.php: secret'));

        $this->assertSame(500, $answer['status']);
        $this->assertNull($answer['retryAfter']);
        $this->assertSame(['error' => true, 'message' => 'An unexpected error occurred'], $answer['body']);
    }

    /** The whole entry point, against a database nobody is listening for, with PHP set to show errors. */
    public function testTheEntryPointAnswersInJsonWhenTheDatabaseIsDown(): void
    {
        $backend = dirname(__DIR__, 2);
        $environment = array_merge(array_filter(getenv(), 'is_string'), [
            'APP_ENV' => 'production',
            'DB_HOST' => '127.0.0.1',
            'DB_PORT' => '1',
            'DB_DATABASE' => 'formlogic',
            'DB_USERNAME' => 'formlogic',
            'DB_PASSWORD' => 'not-the-example-password',
            'JWT_SECRET' => str_repeat('a1b2c3d4', 8),
            'REQUEST_URI' => '/api/health',
            'REQUEST_METHOD' => 'GET',
            'HTTP_HOST' => 'localhost',
            'SCRIPT_NAME' => '/api/index.php',
        ]);
        $process = proc_open(
            [PHP_BINARY, '-d', 'display_errors=1', '-d', 'log_errors=0', $backend . '/public/index.php'],
            [1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
            $pipes,
            $backend,
            $environment
        );
        $this->assertIsResource($process);
        $output = (string) stream_get_contents($pipes[1]);
        stream_get_contents($pipes[2]);
        proc_close($process);

        $this->assertStringNotContainsString('Stack trace', $output);
        $this->assertStringNotContainsString($backend, $output);
        $answer = json_decode($output, true);
        $this->assertIsArray($answer, $output);
        $this->assertTrue($answer['retryable']);
    }
}

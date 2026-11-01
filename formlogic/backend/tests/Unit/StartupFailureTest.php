<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Database\MigrationInProgressException;
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

    public function testAMigrationStillRunningIsATryAgainSoon(): void
    {
        $answer = StartupFailure::answerTo(new MigrationInProgressException('on another worker'));

        $this->assertSame(503, $answer['status']);
        $this->assertSame(5, $answer['retryAfter']);
        $this->assertTrue($answer['body']['error']);
        $this->assertTrue($answer['body']['retryable']);
        $this->assertSame('migration_in_progress', $answer['body']['code']);
        $this->assertStringNotContainsString('worker', $answer['body']['message']);
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
        $answer = json_decode($this->entryPointOutput([]), true);
        $this->assertIsArray($answer);
        $this->assertTrue($answer['retryable']);
    }

    /** A host can disable ini_set, and the line meant to make failures clean must not be one. */
    public function testAHostWithIniSetDisabledStillAnswers(): void
    {
        $output = $this->entryPointOutput(['-d', 'disable_functions=ini_set,ini_restore']);
        $this->assertStringNotContainsString('undefined function', $output);
        $this->assertIsArray(json_decode($output, true), $output);
    }

    /** @param list<string> $phpOptions */
    private function entryPointOutput(array $phpOptions): string
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
            [PHP_BINARY, ...$phpOptions, '-d', 'display_errors=1', '-d', 'log_errors=0', $backend . '/public/index.php'],
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
        return $output;
    }
}

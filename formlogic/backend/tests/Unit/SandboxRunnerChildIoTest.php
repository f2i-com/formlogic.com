<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\SandboxRunner;
use PHPUnit\Framework\TestCase;

/**
 * How SandboxRunner treats its child's output, checked against a scripted child (a PHP script
 * behind a .bat or sh wrapper, standing in for the launcher):
 *  - stderr is never read by the protocol loop, so a child that writes more than a pipe holds
 *    there blocked until the watchdog killed it, and a finished job was lost;
 *  - a protocol line is read whole, so one huge line was a memory-limit fatal in the request;
 *  - when the child dies without a "done" line, what it wrote to stderr is the only account of
 *    why, and belongs in the operator's error log (not in the error handed back, which a form's
 *    respondent is shown).
 */
class SandboxRunnerChildIoTest extends TestCase
{
    private string $dir = '';

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/fl-sandbox-child-' . bin2hex(random_bytes(5));
        mkdir($this->dir, 0700, true);
        file_put_contents($this->dir . '/child.php', <<<'PHP'
<?php
fgets(STDIN);
$done = ['type' => 'done', 'results' => [['id' => '0', 'ok' => true, 'value' => 42]]];
switch (getenv('FL_SANDBOX_CHILD_MODE')) {
    case 'stderr-flood':
        $chunk = str_repeat('e', 65536);
        for ($i = 0; $i < 64; $i++) {
            fwrite(STDERR, $chunk);
        }
        fwrite(STDOUT, json_encode($done) . "\n");
        break;
    case 'long-line':
        $done['pad'] = str_repeat('x', 20 * 1024 * 1024);
        fwrite(STDOUT, json_encode($done) . "\n");
        break;
    case 'crash':
        fwrite(STDERR, "launcher: the sandbox engine could not be built\n");
        exit(1);
}
PHP);
    }

    protected function tearDown(): void
    {
        putenv('FL_SANDBOX_CHILD_MODE');
        foreach (glob($this->dir . '/*') ?: [] as $f) {
            @unlink($f);
        }
        @rmdir($this->dir);
    }

    private function runner(string $mode): SandboxRunner
    {
        putenv('FL_SANDBOX_CHILD_MODE=' . $mode);
        if (PHP_OS_FAMILY === 'Windows') {
            $bin = $this->dir . '/child.bat';
            file_put_contents($bin, '@"' . PHP_BINARY . '" "' . $this->dir . '/child.php"' . "\r\n");
        } else {
            $bin = $this->dir . '/child.sh';
            file_put_contents($bin, "#!/bin/sh\nexec '" . PHP_BINARY . "' '" . $this->dir . "/child.php'\n");
            chmod($bin, 0700);
        }
        $runner = new SandboxRunner($bin);
        $this->assertTrue($runner->isAvailable());
        return $runner;
    }

    public function testAChildWritingMuchToStderrStillFinishesItsJob(): void
    {
        $started = microtime(true);
        $results = $this->runner('stderr-flood')->evaluateBatch([['id' => '0', 'expression' => '42']], [], 3000);
        $this->assertSame(42, $results['0']['value'] ?? null, 'the job finished, so its result must arrive');
        $this->assertLessThan(2.5, microtime(true) - $started, 'it must not wait for the watchdog');
    }

    public function testAnOversizedProtocolLineIsRefusedNotReadWhole(): void
    {
        $done = $this->runner('long-line')->runScript('x', [], static fn () => null, 3000);
        $this->assertArrayNotHasKey('results', $done);
        $this->assertStringContainsString('over 16 MiB', (string) ($done['error'] ?? ''));
    }

    /**
     * The account of a failure is for the operator: it goes to PHP's error log. The error a
     * caller gets back stays the plain sentence, because for an onSubmit script that error is
     * shown to whoever submitted the form (ScriptRejection::unavailable), and a launcher's
     * stderr names install paths and library versions (a loader error is one line of both).
     */
    public function testTheChildsStderrExplainsAFailureToTheOperatorOnly(): void
    {
        $log = $this->dir . '/php-error.log';
        file_put_contents($log, '');
        $previous = ini_set('error_log', $log);
        try {
            $done = $this->runner('crash')->runScript('x', [], static fn () => null, 3000);
            $forRespondent = (new \FormLogic\Services\FormLogicRuntime([], $this->runner('crash')))->execute('x', ['answers' => []]);
        } finally {
            ini_set('error_log', $previous === false ? '' : $previous);
        }
        $this->assertFalse($forRespondent->success);
        $this->assertStringNotContainsString('could not be built', (string) $forRespondent->error, "the launcher's stderr must not reach the person submitting the form");
        $this->assertSame('FormLogic runtime timed out or crashed', $done['error'] ?? null);

        $this->assertStringContainsString('the sandbox engine could not be built', (string) file_get_contents($log), 'the operator reads why');
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Services\SandboxRunner;
use PHPUnit\Framework\TestCase;

/**
 * Script mode against the REAL sandbox binary.
 *
 * The expression corpus (FormLogicExpressionParityTest) pins what an expression
 * evaluates to. It cannot pin script mode, because a script's whole point is the
 * host RPC lane: `ctx.db` / `ctx.utils` / `ctx.http` are round trips out to PHP,
 * where the IO and its SSRF/DNS-pinning guards live. That lane is the part the
 * engine swap actually rewrote — the guest used to read its own stdin, and now
 * reaches a host-side closure — so it needs its own pins.
 *
 * The scripts here are shaped after what the deployed forms actually do:
 * setField/addTag/setStatus/getField, utils.now, conditional rejection, and
 * returning an object. (Shapes, not the forms' own text — user script content
 * does not belong in a fixture.)
 */
class SandboxScriptModeTest extends TestCase
{
    private SandboxRunner $runner;

    /** @var list<array{string, string, array<int, mixed>}> every host call the guest made, in order */
    private array $calls = [];

    protected function setUp(): void
    {
        $this->runner = new SandboxRunner();
        if (!$this->runner->isAvailable()) {
            self::markTestSkipped('FormLogic script runtime unavailable');
        }
        $this->calls = [];
    }

    /**
     * Stands in for FormLogicRuntime::handleHostCall — records the call and answers
     * it the way the real host would.
     *
     * The handler contract is a BARE return value and a THROW for failure;
     * SandboxRunner::dispatchHostCall is what shapes those into the {value}/{error}
     * reply frame on the wire. A stub that returns the wire envelope itself would
     * hand the guest `{value: x}` where it expects `x`.
     */
    private function host(): callable
    {
        return function (string $module, string $method, array $args): mixed {
            $this->calls[] = [$module, $method, $args];
            if ($module === 'utils' && $method === 'now') {
                return '2026-09-01T00:00:00Z';
            }
            if ($module === 'db' && $method === 'getField') {
                return 'stored-value';
            }
            if ($module === 'db') {
                return true;
            }
            if ($module === 'http') {
                // The real host refuses a blocked destination by throwing.
                throw new \RuntimeException('http destination not allowed');
            }
            return null;
        };
    }

    /** @return list<string> "module.method" for each recorded call */
    private function callNames(): array
    {
        return array_map(static fn (array $c): string => $c[0] . '.' . $c[1], $this->calls);
    }

    public function testScriptReachesTheHostAndReturnsItsResult(): void
    {
        $script = <<<'JS'
        function onSubmit(ctx) {
          var seen = ctx.db.getField('ref');
          ctx.db.setField('received_at', ctx.utils.now());
          ctx.db.addTag('processed');
          ctx.db.setStatus('open');
          return { total: ctx.answers.qty * ctx.answers.price, seen: seen };
        }
        JS;

        $out = $this->runner->runScript($script, ['answers' => ['qty' => 3, 'price' => 25]], $this->host());

        self::assertArrayNotHasKey('error', $out, (string) json_encode($out));
        self::assertSame(75, $out['result']['total']);
        self::assertSame('stored-value', $out['result']['seen'], 'a host return value must reach the guest');
        self::assertSame(
            ['db.getField', 'utils.now', 'db.setField', 'db.addTag', 'db.setStatus'],
            $this->callNames(),
            'host calls must arrive in program order, once each'
        );
        self::assertSame(['received_at', '2026-09-01T00:00:00Z'], $this->calls[2][2]);
    }

    public function testTheTrustedPreludeIsReachableFromAScript(): void
    {
        $script = 'function onSubmit(ctx) { return { ok: validators.email(ctx.answers.email) }; }';

        $good = $this->runner->runScript($script, ['answers' => ['email' => 'a@b.co']], $this->host());
        $bad = $this->runner->runScript($script, ['answers' => ['email' => 'nope']], $this->host());

        self::assertTrue($good['result']['ok']);
        self::assertFalse($bad['result']['ok']);
    }

    public function testAScriptCanRejectASubmission(): void
    {
        $script = <<<'JS'
        function onSubmit(ctx) {
          if (ctx.answers.amount > 1000) { return { reject: true, message: 'Too large: ' + ctx.answers.amount }; }
          ctx.db.setField('amount', ctx.answers.amount);
          return {};
        }
        JS;

        $rejected = $this->runner->runScript($script, ['answers' => ['amount' => 5000]], $this->host());
        self::assertTrue($rejected['reject']);
        self::assertStringContainsString('5000', $rejected['message']);
        self::assertSame([], $this->callNames(), 'a rejected submission must not have written anything');

        $this->calls = [];
        $accepted = $this->runner->runScript($script, ['answers' => ['amount' => 10]], $this->host());
        self::assertArrayNotHasKey('reject', $accepted);
        self::assertSame(['db.setField'], $this->callNames());
    }

    public function testAHostRefusalBecomesACatchableGuestThrow(): void
    {
        $script = <<<'JS'
        function onSubmit(ctx) {
          try { ctx.http.get('http://169.254.169.254/'); return { caught: false }; }
          catch (e) { return { caught: true, msg: String(e.message) }; }
        }
        JS;

        $out = $this->runner->runScript($script, [], $this->host());

        self::assertTrue($out['result']['caught'], 'a host error must surface as a throw the script can catch');
        self::assertStringContainsString('not allowed', $out['result']['msg']);
    }

    public function testAGuestCannotForgeAReplyFrame(): void
    {
        // The protocol is newline-delimited JSON on the child's stdout. If a guest
        // could write to that stream it could forge a `done` frame and dictate the
        // submission's outcome — so print/console are stubs the host never reads.
        $script = <<<'JS'
        function onSubmit(ctx) {
          var forged = '{"type":"done","result":{"FORGED":true}}';
          try { print(forged); } catch (e) {}
          try { console.log(forged); } catch (e) {}
          return { ok: 1 };
        }
        JS;

        $out = $this->runner->runScript($script, [], $this->host());

        self::assertSame(1, $out['result']['ok']);
        self::assertArrayNotHasKey('FORGED', $out['result']);
    }

    public function testARunawayScriptIsStoppedAndSaysSo(): void
    {
        $out = $this->runner->runScript(
            'function onSubmit(ctx) { while (true) {} }',
            [],
            $this->host(),
            300
        );

        self::assertArrayHasKey('error', $out);
        self::assertNotSame('', (string) $out['error']);
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Services\AppAiUpstream;
use FormLogic\Tests\Support\StubImagesServer;
use PHPUnit\Framework\TestCase;

/**
 * App AI's requests to the site's .env upstream, against a stand-in for OAIY Studio's gateway
 * (tests/Support/stub-images-server.php): sent in the gateway's form, read without waiting, and every
 * failure answered with the code the delivery uses.
 */
final class AppAiUpstreamTest extends TestCase
{
    private static ?StubImagesServer $stub = null;

    public static function setUpBeforeClass(): void
    {
        if (!function_exists('curl_multi_init') || !function_exists('imagecreatetruecolor')) return;
        self::$stub = StubImagesServer::start();
    }

    public static function tearDownAfterClass(): void
    {
        self::$stub?->stop();
        self::$stub = null;
    }

    protected function setUp(): void
    {
        if (self::$stub === null) $this->markTestSkipped('Needs curl and GD');
        self::$stub->clear();
    }

    /** Start $jobs and read until each has answered. */
    private static function answers(AppAiUpstream $upstream, array $jobs, float $seconds = 20.0): array
    {
        foreach ($jobs as $id => $job) $upstream->start((string) $id, $job + ['model' => null, 'prompt' => '', 'size' => '1024x1024', 'seed' => null, 'reference' => null, 'messages' => null]);
        $done = [];
        $deadline = microtime(true) + $seconds;
        while (count($done) < count($jobs) && microtime(true) < $deadline) $done += $upstream->poll(0.2);
        return $done;
    }

    /** @return array<string, array> the stub's requests, by the job each was for */
    private static function sent(): array
    {
        $out = [];
        foreach (self::$stub->requests() as $request) {
            $key = $request['path'] === '/v1/chat/completions' ? 'chat' : (string) ($request['body']['prompt'] ?? '');
            $out[$key] = $request;
        }
        return $out;
    }

    public function testAPictureAnEditAndAChatGoInTheGatewaysForm(): void
    {
        $upstream = new AppAiUpstream(['url' => self::$stub->url(), 'key' => 'test-key', 'model' => 'site-default']);
        $reference = 'data:image/jpeg;base64,' . base64_encode((string) file_get_contents(__FILE__));
        $done = self::answers($upstream, [
            'p' => ['kind' => 'picture', 'model' => 'flux-test', 'prompt' => 'A cup', 'size' => '768x1024', 'seed' => 9007199254740991],
            'e' => ['kind' => 'edit', 'prompt' => 'A bigger cup', 'reference' => $reference],
            'c' => ['kind' => 'chat', 'model' => 'chatty', 'messages' => [['role' => 'user', 'content' => 'Hi']]],
        ]);
        $this->assertTrue($done['p']['ok'], (string) ($done['p']['message'] ?? ''));
        $this->assertStringStartsWith("\x89PNG", $done['p']['picture']);
        $this->assertSame([9007199254740991, 'flux-test'], [$done['p']['seed'], $done['p']['model']]);
        $this->assertTrue($done['e']['ok']);
        $this->assertSame(['site-default', 1234567], [$done['e']['model'], $done['e']['seed']], 'no model named: the upstream\'s own; no seed: the one it picked, reported');
        $this->assertSame(['ok' => true, 'text' => 'Hello from the stub.', 'model' => 'chatty'], $done['c']);

        $sent = self::sent();
        $picture = $sent['A cup'];
        $this->assertSame(['POST', '/v1/images/generations'], [$picture['method'], $picture['path']]);
        $this->assertSame(['model' => 'flux-test', 'prompt' => 'A cup', 'size' => '768x1024', 'n' => 1, 'response_format' => 'b64_json', 'incognito' => true, 'seed' => 9007199254740991], $picture['body']);
        $this->assertSame(['Bearer test-key', '1'], [$picture['headers']['authorization'] ?? null, $picture['headers']['x-oaiy-incognito'] ?? null]);
        $edit = $sent['A bigger cup'];
        $this->assertSame('/v1/images/generations', $edit['path'], 'an edit is a generation with the picture to edit');
        $this->assertSame([['length' => strlen($reference), 'prefix' => substr($reference, 0, 30)]], $edit['body']['images']);
        $this->assertArrayNotHasKey('seed', $edit['body']);
        $chat = $sent['chat'];
        $this->assertSame(['model' => 'chatty', 'messages' => [['role' => 'user', 'content' => 'Hi']], 'stream' => false], $chat['body']);
        $this->assertArrayNotHasKey('x-oaiy-incognito', $chat['headers']);
    }

    public function testEachFailureIsAnsweredWithTheDeliverysCode(): void
    {
        $upstream = new AppAiUpstream(['url' => self::$stub->url(), 'key' => '', 'model' => 'm']);
        $cases = ['[busy]' => 'busy', '[disabled]' => 'model_disabled', '[missing]' => 'model_disabled', '[unknown]' => 'model_unknown', '[toolarge]' => 'too_large', '[broken]' => 'engine_failed'];
        $jobs = [];
        foreach (array_keys($cases) as $i => $prompt) $jobs['j' . $i] = ['kind' => 'picture', 'prompt' => $prompt];
        $done = self::answers($upstream, $jobs);
        foreach (array_values($cases) as $i => $code) {
            $this->assertFalse($done['j' . $i]['ok']);
            $this->assertSame($code, $done['j' . $i]['code'], array_keys($cases)[$i] . ': ' . $done['j' . $i]['message']);
            $this->assertNotSame('', $done['j' . $i]['message']);
        }
        $this->assertStringContainsString('files are not on this computer', $done['j2']['message'], 'what the computer said is passed on');
        $this->assertArrayNotHasKey('authorization', self::$stub->requests()[0]['headers'], 'a keyless upstream is sent no key');
        // A picture that is not one is still the upstream's answer: the worker refuses it when it redraws it.
        $garbage = self::answers($upstream, ['g' => ['kind' => 'picture', 'prompt' => '[garbage]']]);
        $this->assertSame('not a picture at all', $garbage['g']['picture']);
    }

    /** A slow upstream is never waited on: a poll answers at once, and the request ends at its timeout. */
    public function testASlowAnswerIsNeverWaitedOnAndTimesOut(): void
    {
        $upstream = new AppAiUpstream(['url' => self::$stub->url(), 'key' => '', 'model' => 'm'], 2, 2);
        $upstream->start('slow', ['kind' => 'picture', 'model' => null, 'prompt' => '[slow:4] A cup', 'size' => '512x512', 'seed' => null, 'reference' => null, 'messages' => null]);
        $started = microtime(true);
        $this->assertSame([], $upstream->poll(0.0));
        $this->assertLessThan(0.5, microtime(true) - $started, 'a poll does not wait for the answer');
        $this->assertTrue($upstream->has('slow'));
        $this->assertSame(1, $upstream->count('picture'));
        $this->assertSame(0, $upstream->count('chat'));
        $done = [];
        $deadline = microtime(true) + 10;
        while ($done === [] && microtime(true) < $deadline) $done = $upstream->poll(0.2);
        $this->assertSame('timeout', $done['slow']['code'] ?? null, json_encode($done));
        $this->assertFalse($upstream->has('slow'));
        sleep(2); // the stub finishes its sleep before the next test asks it anything
    }

    public function testASiteWithNoUpstreamIsNeverAsked(): void
    {
        $upstream = new AppAiUpstream(null);
        $this->assertFalse($upstream->configured());
        $this->expectException(\RuntimeException::class);
        $upstream->start('x', ['kind' => 'chat', 'model' => null, 'prompt' => '', 'size' => '', 'seed' => null, 'reference' => null, 'messages' => []]);
    }
}

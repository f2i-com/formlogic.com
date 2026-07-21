<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\AIController;
use FormLogic\Services\AIService;
use PHPUnit\Framework\TestCase;

/**
 * Hosted chat on AIService (plan Phase 2): message validation bounds, the request payload
 * shape (stream flag + stream_options), the OpenAI-SSE line parser, and the controller's
 * SSE event encoders. The HTTP transport is faked by subclassing — no network happens here.
 */
class AiChatServiceTest extends TestCase
{
    /** @var array<string, string|false> */
    private array $envBackup = [];

    protected function setUp(): void
    {
        foreach (['AI_BASE_URL', 'OPENAI_API_URL', 'AI_API_KEY', 'OPENAI_API_KEY', 'AI_MODEL', 'OPENAI_MODEL'] as $key) {
            $this->envBackup[$key] = $_ENV[$key] ?? false;
            unset($_ENV[$key]);
        }
    }

    protected function tearDown(): void
    {
        foreach ($this->envBackup as $key => $value) {
            if ($value === false) {
                unset($_ENV[$key]);
            } else {
                $_ENV[$key] = $value;
            }
        }
    }

    private function fakeService(): FakeAiService
    {
        // A keyless local endpoint makes isConfigured() true without any credential.
        $_ENV['AI_BASE_URL'] = 'http://127.0.0.1:9';
        return new FakeAiService();
    }

    // ── validation ──

    public function testValidateChatMessagesBounds(): void
    {
        try {
            AIService::validateChatMessages([]);
            $this->fail('empty messages rejected');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('1..', $e->getMessage());
        }
        try {
            AIService::validateChatMessages(array_fill(0, 51, ['role' => 'user', 'content' => 'x']));
            $this->fail('over-long history rejected');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('1..', $e->getMessage());
        }
        try {
            AIService::validateChatMessages([['role' => 'tool', 'content' => 'x']]);
            $this->fail('unknown role rejected');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('role', $e->getMessage());
        }
        try {
            AIService::validateChatMessages([['role' => 'user', 'content' => '']]);
            $this->fail('empty content rejected');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('non-empty', $e->getMessage());
        }
        try {
            AIService::validateChatMessages([['role' => 'user', 'content' => str_repeat('x', 32001)]]);
            $this->fail('oversized content rejected');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('32000', $e->getMessage());
        }
        $big = str_repeat('y', 30000);
        try {
            AIService::validateChatMessages(array_fill(0, 5, ['role' => 'user', 'content' => $big]));
            $this->fail('oversized total rejected');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('in total', $e->getMessage());
        }

        $clean = AIService::validateChatMessages([
            ['role' => 'system', 'content' => 'You are helpful.', 'extra' => 'dropped'],
            ['role' => 'user', 'content' => 'Hi'],
        ]);
        $this->assertSame([
            ['role' => 'system', 'content' => 'You are helpful.'],
            ['role' => 'user', 'content' => 'Hi'],
        ], $clean);
    }

    // ── chat() over the fake transport ──

    public function testChatBuildsThePayloadAndReturnsUsage(): void
    {
        $ai = $this->fakeService();
        $ai->reply = ['content' => 'Hello back', 'usage' => ['promptTokens' => 12, 'completionTokens' => 5, 'totalTokens' => 17]];
        $result = $ai->chat([['role' => 'user', 'content' => 'Hello']], false);
        $this->assertSame('Hello back', $result['content']);
        $this->assertSame(12, $result['usage']['promptTokens']);
        $this->assertFalse($ai->lastPayload['stream']);
        $this->assertArrayNotHasKey('stream_options', $ai->lastPayload);
        $this->assertSame([['role' => 'user', 'content' => 'Hello']], $ai->lastPayload['messages']);
        $this->assertSame(AIService::CHAT_MAX_TOKENS, $ai->lastPayload['max_tokens']);
    }

    public function testChatStreamFlagsAndDeltaForwarding(): void
    {
        $ai = $this->fakeService();
        $ai->reply = ['content' => 'abc', 'usage' => ['promptTokens' => 1, 'completionTokens' => 2, 'totalTokens' => 3]];
        $deltas = [];
        $result = $ai->chat([['role' => 'user', 'content' => 'Hi']], true, function (string $d) use (&$deltas) {
            $deltas[] = $d;
        });
        $this->assertTrue($ai->lastPayload['stream']);
        $this->assertSame(['include_usage' => true], $ai->lastPayload['stream_options']);
        $this->assertSame(['a', 'b', 'c'], $deltas); // the fake streams one delta per char
        $this->assertSame('abc', $result['content']);
        $this->assertSame(3, $result['usage']['totalTokens']);
    }

    public function testChatThrowsWhenNotConfigured(): void
    {
        // No AI_BASE_URL at all → the default api.openai.com endpoint without a key.
        $ai = new FakeAiService();
        $this->expectException(\Exception::class);
        $this->expectExceptionMessageMatches('/not configured/');
        $ai->chat([['role' => 'user', 'content' => 'Hi']], false);
    }

    // ── SSE line parser ──

    public function testParseChatStreamLine(): void
    {
        $this->assertSame(['delta' => 'Hello'], AIService::parseChatStreamLine('data: {"choices":[{"delta":{"content":"Hello"}}]}'));
        $this->assertSame(['done' => true], AIService::parseChatStreamLine('data: [DONE]'));
        $usage = AIService::parseChatStreamLine('data: {"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}');
        $this->assertSame(['usage' => ['promptTokens' => 10, 'completionTokens' => 4, 'totalTokens' => 14]], $usage);
        // Keepalives, blanks, role-only deltas, empty deltas, malformed JSON, non-data lines.
        $this->assertNull(AIService::parseChatStreamLine(': keepalive'));
        $this->assertNull(AIService::parseChatStreamLine(''));
        $this->assertNull(AIService::parseChatStreamLine('data: {"choices":[{"delta":{"role":"assistant"}}]}'));
        $this->assertNull(AIService::parseChatStreamLine('data: {"choices":[{"delta":{"content":""}}]}'));
        $this->assertNull(AIService::parseChatStreamLine('data: {not json'));
        $this->assertNull(AIService::parseChatStreamLine('event: delta'));
    }

    // ── controller SSE encoders ──

    public function testSseEventEncoders(): void
    {
        $this->assertSame(
            'event: delta' . "\n" . 'data: {"content":"Hi there"}' . "\n\n",
            AIController::sseChatDelta('Hi there')
        );
        $this->assertSame(
            'event: done' . "\n" . 'data: {"usage":{"promptTokens":1,"completionTokens":2,"totalTokens":3}}' . "\n\n",
            AIController::sseChatDone(['promptTokens' => 1, 'completionTokens' => 2, 'totalTokens' => 3])
        );
        $this->assertSame(
            'event: error' . "\n" . 'data: {"message":"boom"}' . "\n\n",
            AIController::sseChatError('boom')
        );
    }
}

/** AIService with the HTTP transport stubbed out (streams one delta per content char). */
class FakeAiService extends AIService
{
    /** @var array{content: string, usage: array} */
    public array $reply = ['content' => '', 'usage' => ['promptTokens' => 0, 'completionTokens' => 0, 'totalTokens' => 0]];
    /** @var array<string, mixed> */
    public array $lastPayload = [];

    protected function chatCompletionsRequest(array $payload, bool $stream, ?callable $onDelta, ?callable $onHeartbeat): array
    {
        $this->lastPayload = $payload;
        if ($stream && $onDelta !== null) {
            foreach (mb_str_split($this->reply['content']) as $char) {
                if ($char !== '') {
                    $onDelta($char);
                }
            }
        }
        return $this->reply;
    }
}

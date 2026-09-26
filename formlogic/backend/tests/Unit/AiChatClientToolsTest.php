<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\AIController;
use FormLogic\Services\AIService;
use FormLogic\Services\DocumentConverter;
use FormLogic\Services\PlatformPlansService;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * POST /api/ai/chat with `aiTools: 1` — one round of the hosted Softn Studio editor's own
 * tool loop: the caller's tools and conversation go to the OpenAI-compatible upstream, the
 * model's tool calls come back unexecuted. Pins the neutral → OpenAI mapping, the reply
 * shape, the validation that refuses malformed shapes before anything is charged or sent,
 * and that a request without `aiTools` still takes the plain chat path. No network, no DB:
 * the transport is faked by subclassing and plan enforcement is off.
 */
class AiChatClientToolsTest extends TestCase
{
    /** @var array<string, string|false> */
    private array $envBackup = [];

    protected function setUp(): void
    {
        foreach (['AI_BASE_URL', 'OPENAI_API_URL', 'AI_API_KEY', 'OPENAI_API_KEY', 'AI_MODEL', 'OPENAI_MODEL', 'AI_ENABLED', 'AI_EDITOR_MAX_OUTPUT_TOKENS'] as $key) {
            $this->envBackup[$key] = $_ENV[$key] ?? false;
            unset($_ENV[$key]);
        }
        // A keyless local endpoint makes isConfigured() true without any credential.
        $_ENV['AI_BASE_URL'] = 'http://127.0.0.1:9';
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

    private function service(): FakeClientToolsAiService
    {
        $plans = $this->createMock(PlatformPlansService::class);
        $plans->method('status')->willReturn(array_replace(PlatformPlansService::defaults(), ['siteAiEnabled' => true]));
        return new FakeClientToolsAiService($plans);
    }

    /** @return array{status: int, body: array<string, mixed>} */
    private function chat(AIService $ai, array $body): array
    {
        $ctrl = new AIController($ai, new DocumentConverter());
        $req = (new ServerRequestFactory())->createServerRequest('POST', 'http://localhost/api/ai/chat')
            ->withParsedBody($body)
            ->withAttribute('userId', 'u-test');
        $resp = $ctrl->chat($req, (new ResponseFactory())->createResponse());
        return ['status' => $resp->getStatusCode(), 'body' => self::decode($resp)];
    }

    private static function decode(ResponseInterface $resp): array
    {
        $resp->getBody()->rewind();
        return json_decode((string) $resp->getBody(), true) ?: [];
    }

    /** @return array<int, array<string, mixed>> */
    private static function tools(): array
    {
        return [
            ['name' => 'read_file', 'description' => 'Read a file.', 'inputSchema' => ['type' => 'object', 'properties' => ['path' => ['type' => 'string', 'description' => 'Path']], 'required' => ['path']]],
            ['name' => 'list_files', 'description' => 'List files.', 'inputSchema' => ['type' => 'object', 'properties' => [], 'required' => []]],
        ];
    }

    public function testAScriptedStudioConversationMapsToOpenAiAndReturnsTheCalls(): void
    {
        $ai = $this->service();
        $ai->replyBody = [
            'choices' => [[
                'message' => ['content' => null, 'tool_calls' => [
                    ['id' => 'call_2', 'type' => 'function', 'function' => ['name' => 'read_file', 'arguments' => '{"path":"ui/main.ui"}']],
                ]],
                'finish_reason' => 'tool_calls',
            ]],
            'usage' => ['prompt_tokens' => 120, 'completion_tokens' => 14, 'total_tokens' => 134],
        ];
        $result = $this->chat($ai, [
            'aiTools' => 1,
            'stream' => false,
            'maxOutputTokens' => 999999,
            'tools' => self::tools(),
            'messages' => [
                ['role' => 'system', 'content' => 'You edit Softn apps.'],
                ['role' => 'user', 'content' => 'Add a title.'],
                ['role' => 'assistant', 'content' => '', 'toolCalls' => [['id' => 'call_1', 'name' => 'list_files', 'arguments' => []]]],
                ['role' => 'tool', 'toolCallId' => 'call_1', 'name' => 'list_files', 'content' => 'no such dir', 'isError' => true],
                ['role' => 'assistant', 'content' => 'Retrying.', 'toolCalls' => [['id' => 'call_1b', 'name' => 'list_files', 'arguments' => ['dir' => 'ui']]]],
                ['role' => 'tool', 'toolCallId' => 'call_1b', 'name' => 'list_files', 'content' => 'ui/main.ui'],
            ],
        ]);

        $this->assertSame(200, $result['status']);
        $this->assertSame([
            'content' => '',
            'toolCalls' => [['id' => 'call_2', 'name' => 'read_file', 'arguments' => '{"path":"ui/main.ui"}']],
            'stopReason' => 'tool_calls',
            'usage' => ['promptTokens' => 120, 'completionTokens' => 14, 'totalTokens' => 134],
        ], $result['body']['data']);

        $payload = $ai->lastPayload;
        // The output cap is the operator's: a larger request is clamped, never raised.
        $this->assertSame(AIService::EDITOR_DEFAULT_OUTPUT_TOKENS, $payload['max_tokens']);
        $this->assertArrayNotHasKey('stream', $payload);
        $this->assertSame([
            ['role' => 'system', 'content' => 'You edit Softn apps.'],
            ['role' => 'user', 'content' => 'Add a title.'],
            ['role' => 'assistant', 'content' => null, 'tool_calls' => [['id' => 'call_1', 'type' => 'function', 'function' => ['name' => 'list_files', 'arguments' => '{}']]]],
            ['role' => 'tool', 'tool_call_id' => 'call_1', 'content' => 'Error: no such dir'],
            ['role' => 'assistant', 'content' => 'Retrying.', 'tool_calls' => [['id' => 'call_1b', 'type' => 'function', 'function' => ['name' => 'list_files', 'arguments' => '{"dir":"ui"}']]]],
            ['role' => 'tool', 'tool_call_id' => 'call_1b', 'content' => 'ui/main.ui'],
        ], $payload['messages']);
        $this->assertSame('read_file', $payload['tools'][0]['function']['name']);
        $this->assertSame('function', $payload['tools'][0]['type']);
        // An empty `properties` goes out as {} — not the [] an empty PHP array encodes as.
        $this->assertStringContainsString('"properties":{}', (string) json_encode($payload['tools'][1]));
    }

    public function testAFinalTextRoundAndAnInvalidUpstreamIdAreCarried(): void
    {
        $ai = $this->service();
        $ai->replyBody = ['choices' => [[
            'message' => ['content' => 'Done.', 'tool_calls' => [['id' => 'bad id with spaces', 'function' => ['name' => 'read_file', 'arguments' => 'not json']]]],
            'finish_reason' => 'length',
        ]]];
        $result = $this->chat($ai, ['aiTools' => 1, 'tools' => self::tools(), 'messages' => [['role' => 'user', 'content' => 'Hi']]]);
        $this->assertSame(200, $result['status']);
        $data = $result['body']['data'];
        $this->assertSame('Done.', $data['content']);
        $this->assertSame('length', $data['stopReason']);
        $this->assertSame(['promptTokens' => 0, 'completionTokens' => 0, 'totalTokens' => 0], $data['usage']);
        // The raw (bad) arguments go back for the editor to report; the id is replaced by one a later request can carry.
        $this->assertSame('not json', $data['toolCalls'][0]['arguments']);
        $this->assertMatchesRegularExpression(AIService::CLIENT_TOOL_CALL_ID_PATTERN, $data['toolCalls'][0]['id']);
    }

    public function testARequestWithoutAiToolsStillTakesThePlainChatPath(): void
    {
        $ai = $this->service();
        $ai->plainReply = ['content' => 'Hello back', 'usage' => ['promptTokens' => 1, 'completionTokens' => 2, 'totalTokens' => 3]];
        $result = $this->chat($ai, ['messages' => [['role' => 'user', 'content' => 'Hello']]]);
        $this->assertSame(200, $result['status']);
        $this->assertSame(['content' => 'Hello back', 'usage' => ['promptTokens' => 1, 'completionTokens' => 2, 'totalTokens' => 3]], $result['body']['data']);
        $this->assertSame([], $ai->lastPayload, 'the tools transport was never used');
        // …and the plain path still refuses what it always refused.
        $refused = $this->chat($ai, ['messages' => [['role' => 'tool', 'content' => 'x']]]);
        $this->assertSame(400, $refused['status']);
    }

    /** @return array<string, array{0: array<string, mixed>, 1: string}> */
    public static function invalidRequests(): array
    {
        $user = ['role' => 'user', 'content' => 'Hi'];
        $call = ['id' => 'call_1', 'name' => 'read_file', 'arguments' => ['path' => 'a']];
        $withCall = ['role' => 'assistant', 'content' => '', 'toolCalls' => [$call]];
        $tool = ['name' => 'read_file', 'description' => 'd', 'inputSchema' => ['type' => 'object']];
        return [
            'another aiTools version' => [['aiTools' => 2, 'messages' => [$user]], 'aiTools must be 1'],
            'streaming asked for' => [['aiTools' => 1, 'stream' => true, 'messages' => [$user]], 'stream must be false'],
            'hosted-loop tools flag' => [['aiTools' => 1, 'tools' => true, 'messages' => [$user]], 'tools must be a list'],
            'too many tools' => [['aiTools' => 1, 'tools' => array_map(static fn (int $i) => ['name' => 't' . $i, 'description' => '', 'inputSchema' => ['type' => 'object']], range(1, 65)), 'messages' => [$user]], 'at most 64'],
            'duplicate tool' => [['aiTools' => 1, 'tools' => [$tool, $tool], 'messages' => [$user]], 'declared twice'],
            'bad tool name' => [['aiTools' => 1, 'tools' => [['name' => 'read file', 'description' => '', 'inputSchema' => ['type' => 'object']]], 'messages' => [$user]], 'tool name'],
            'schema not an object schema' => [['aiTools' => 1, 'tools' => [['name' => 'x', 'description' => '', 'inputSchema' => ['type' => 'array']]], 'messages' => [$user]], 'type "object"'],
            'schema too large' => [['aiTools' => 1, 'tools' => [['name' => 'x', 'description' => '', 'inputSchema' => ['type' => 'object', 'description' => str_repeat('x', 17000)]]], 'messages' => [$user]], 'inputSchema over'],
            'description too long' => [['aiTools' => 1, 'tools' => [['name' => 'x', 'description' => str_repeat('d', 4097), 'inputSchema' => ['type' => 'object']]], 'messages' => [$user]], 'description'],
            'unknown role' => [['aiTools' => 1, 'messages' => [['role' => 'developer', 'content' => 'x']]], 'role must be'],
            'non-string content' => [['aiTools' => 1, 'messages' => [['role' => 'user', 'content' => ['type' => 'text', 'text' => 'x']]]], 'must be a string'],
            'tool calls on a user message' => [['aiTools' => 1, 'messages' => [['role' => 'user', 'content' => 'x', 'toolCalls' => [$call]]]], 'only assistant'],
            'bad call id' => [['aiTools' => 1, 'messages' => [$user, ['role' => 'assistant', 'content' => '', 'toolCalls' => [['id' => '<script>', 'name' => 'x', 'arguments' => []]]]]], 'tool call id'],
            'duplicate call id' => [['aiTools' => 1, 'messages' => [$user, ['role' => 'assistant', 'content' => '', 'toolCalls' => [$call, $call]]]], 'used twice'],
            'arguments a list' => [['aiTools' => 1, 'messages' => [$user, ['role' => 'assistant', 'content' => '', 'toolCalls' => [['id' => 'c', 'name' => 'x', 'arguments' => [1, 2]]]]]], 'must be an object'],
            'arguments a string' => [['aiTools' => 1, 'messages' => [$user, ['role' => 'assistant', 'content' => '', 'toolCalls' => [['id' => 'c', 'name' => 'x', 'arguments' => '{}']]]]], 'must be an object'],
            'arguments too large' => [['aiTools' => 1, 'messages' => [$user, ['role' => 'assistant', 'content' => '', 'toolCalls' => [['id' => 'c', 'name' => 'x', 'arguments' => ['v' => str_repeat('x', AIService::EDITOR_MAX_MESSAGE_CHARS + 1)]]]]]], 'exceeds'],
            'too many calls' => [['aiTools' => 1, 'messages' => [$user, ['role' => 'assistant', 'content' => '', 'toolCalls' => array_map(static fn (int $i) => ['id' => 'c' . $i, 'name' => 'x', 'arguments' => []], range(1, 33))]]], 'at most 32'],
            'empty assistant' => [['aiTools' => 1, 'messages' => [$user, ['role' => 'assistant', 'content' => '']]], 'content or toolCalls'],
            'orphan tool result' => [['aiTools' => 1, 'messages' => [$user, ['role' => 'tool', 'toolCallId' => 'call_1', 'name' => 'read_file', 'content' => 'x']]], 'does not answer'],
            'result for another tool' => [['aiTools' => 1, 'messages' => [$user, $withCall, ['role' => 'tool', 'toolCallId' => 'call_1', 'name' => 'list_files', 'content' => 'x']]], 'does not answer'],
            'answered twice' => [['aiTools' => 1, 'messages' => [$user, $withCall, ['role' => 'tool', 'toolCallId' => 'call_1', 'name' => 'read_file', 'content' => 'x'], ['role' => 'tool', 'toolCallId' => 'call_1', 'name' => 'read_file', 'content' => 'y']]], 'does not answer'],
            'result after a user turn' => [['aiTools' => 1, 'messages' => [$user, $withCall, $user, ['role' => 'tool', 'toolCallId' => 'call_1', 'name' => 'read_file', 'content' => 'x']]], 'does not answer'],
            'isError not boolean' => [['aiTools' => 1, 'messages' => [$user, $withCall, ['role' => 'tool', 'toolCallId' => 'call_1', 'name' => 'read_file', 'content' => 'x', 'isError' => 'yes']]], 'isError'],
            'maxOutputTokens zero' => [['aiTools' => 1, 'maxOutputTokens' => 0, 'messages' => [$user]], 'maxOutputTokens'],
            'too many messages' => [['aiTools' => 1, 'messages' => array_fill(0, AIService::EDITOR_MAX_MESSAGES + 1, $user)], '1..' . AIService::EDITOR_MAX_MESSAGES],
        ];
    }

    /**
     * @dataProvider invalidRequests
     * @param array<string, mixed> $body
     */
    public function testInvalidShapesAreRefusedBeforeAnythingIsSent(array $body, string $message): void
    {
        $ai = $this->service();
        $result = $this->chat($ai, $body);
        $this->assertSame(400, $result['status']);
        $this->assertStringContainsString($message, (string) ($result['body']['message'] ?? ''));
        $this->assertSame([], $ai->lastPayload, 'nothing reached the upstream');
    }

    public function testTheEditorOutputBoundIsTheOperatorsAndClamped(): void
    {
        $this->assertSame(AIService::EDITOR_DEFAULT_OUTPUT_TOKENS, AIService::editorMaxOutputTokens());
        $_ENV['AI_EDITOR_MAX_OUTPUT_TOKENS'] = '16000';
        $this->assertSame(16000, AIService::editorMaxOutputTokens());
        $_ENV['AI_EDITOR_MAX_OUTPUT_TOKENS'] = '999999';
        $this->assertSame(AIService::EDITOR_MAX_OUTPUT_TOKENS_CEILING, AIService::editorMaxOutputTokens());
        $_ENV['AI_EDITOR_MAX_OUTPUT_TOKENS'] = '10';
        $this->assertSame(AIService::EDITOR_MIN_OUTPUT_TOKENS, AIService::editorMaxOutputTokens());
        $_ENV['AI_EDITOR_MAX_OUTPUT_TOKENS'] = 'lots';
        $this->assertSame(AIService::EDITOR_DEFAULT_OUTPUT_TOKENS, AIService::editorMaxOutputTokens());

        // A request asks for less and gets it; asks for more and gets the bound.
        $_ENV['AI_EDITOR_MAX_OUTPUT_TOKENS'] = '12000';
        $this->assertSame(4000, AIService::validateClientToolChat([['role' => 'user', 'content' => 'x']], [], 4000)['maxTokens']);
        $this->assertSame(12000, AIService::validateClientToolChat([['role' => 'user', 'content' => 'x']], [], 50000)['maxTokens']);
        $this->assertSame(12000, AIService::validateClientToolChat([['role' => 'user', 'content' => 'x']], [], null)['maxTokens']);
    }

    public function testAnEditorsPlainRequestHasTheEditorBoundsAndAChatKeepsItsOwn(): void
    {
        // The text protocol an editor's agent falls back to carries the SoftN guide as text: past 32,000.
        $messages = [['role' => 'system', 'content' => str_repeat('g', 40000)], ['role' => 'user', 'content' => 'Build it.']];
        $this->assertCount(2, AIService::validateChatMessages($messages, true));
        try {
            AIService::validateChatMessages($messages);
            $this->fail('A chat message past 32,000 characters was accepted.');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('exceeds ' . AIService::CHAT_MAX_MESSAGE_CHARS, $e->getMessage());
        }
        $this->assertCount(60, AIService::validateChatMessages(array_fill(0, 60, ['role' => 'user', 'content' => 'x']), true));
    }

    public function testAnEditorRunLongerAndLargerThanAChatIsAccepted(): void
    {
        // An agent's system prompt carries the SoftN guide, and a build takes dozens of rounds:
        // past the chat's 50 messages and 32,000 characters a message, within the editor bounds.
        $messages = [['role' => 'system', 'content' => str_repeat('g', 40000)], ['role' => 'user', 'content' => 'Build a recipe box.']];
        for ($i = 1; $i <= 60; $i++) {
            $messages[] = ['role' => 'assistant', 'content' => '', 'toolCalls' => [['id' => 'c' . $i, 'name' => 'read_file', 'arguments' => ['path' => 'ui/main.ui']]]];
            $messages[] = ['role' => 'tool', 'toolCallId' => 'c' . $i, 'name' => 'read_file', 'content' => str_repeat('u', 3000)];
        }
        $this->assertCount(122, AIService::validateClientToolChat($messages, [], null)['messages']);

        $tooMany = array_merge([['role' => 'user', 'content' => 'x']], array_fill(0, AIService::EDITOR_MAX_MESSAGES, ['role' => 'user', 'content' => 'y']));
        try {
            AIService::validateClientToolChat($tooMany, [], null);
            $this->fail('A conversation past the editor bound was accepted.');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('1..' . AIService::EDITOR_MAX_MESSAGES, $e->getMessage());
        }
        $tooLarge = array_fill(0, 6, ['role' => 'user', 'content' => str_repeat('z', 90000)]);
        try {
            AIService::validateClientToolChat($tooLarge, [], null);
            $this->fail('A conversation past the editor total was accepted.');
        } catch (\InvalidArgumentException $e) {
            $this->assertStringContainsString('in total', $e->getMessage());
        }
    }

    public function testAnUnconfiguredServerRefusesBeforeCharging(): void
    {
        $_ENV['AI_ENABLED'] = 'false';
        $ai = $this->service();
        $result = $this->chat($ai, ['aiTools' => 1, 'messages' => [['role' => 'user', 'content' => 'Hi']]]);
        $this->assertSame(503, $result['status']);
        $this->assertSame([], $ai->lastPayload);
    }

    public function testAnUpstreamFailureIsA502WithoutDetail(): void
    {
        $ai = $this->service();
        $ai->fail = true;
        $result = $this->chat($ai, ['aiTools' => 1, 'messages' => [['role' => 'user', 'content' => 'Hi']]]);
        $this->assertSame(502, $result['status']);
        $this->assertSame('The AI request failed', $result['body']['message']);
    }
}

/** Fakes both transports: the tools one (recorded in lastPayload) and the plain chat one. */
class FakeClientToolsAiService extends AIService
{
    /** @var array<string, mixed> */
    public array $replyBody = ['choices' => [['message' => ['content' => ''], 'finish_reason' => 'stop']]];
    /** @var array{content: string, usage: array} */
    public array $plainReply = ['content' => '', 'usage' => ['promptTokens' => 0, 'completionTokens' => 0, 'totalTokens' => 0]];
    /** @var array<string, mixed> */
    public array $lastPayload = [];
    public bool $fail = false;

    protected function chatCompletionsToolsRequest(array $payload): array
    {
        $this->lastPayload = $payload;
        if ($this->fail) {
            throw new \Exception('API error (500): upstream secret detail');
        }
        return $this->replyBody;
    }

    protected function chatCompletionsRequest(array $payload, bool $stream, ?callable $onDelta, ?callable $onHeartbeat): array
    {
        return $this->plainReply;
    }
}

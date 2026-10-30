<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\AppController;
use FormLogic\Middleware\ApiKeyMiddleware;
use FormLogic\Services\ApiKeyService;
use FormLogic\Services\AppService;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response as SlimResponse;

/**
 * Two boundaries an account's data rests on, each one line that was missing: a key confined to
 * some forms reaches only those forms, and an app's id is the server's to give.
 */
final class ApiKeyFormConfinementTest extends TestCase
{
    private const KEY = 'flk_' . 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12';

    private function send(string $path, ?array $formIds): ResponseInterface
    {
        $keys = $this->createMock(ApiKeyService::class);
        $keys->method('validateKey')->willReturn(['id' => 'k', 'userId' => 'u', 'scopes' => ['flows:read', 'forms:read'], 'formIds' => $formIds]);
        $request = (new ServerRequestFactory())
            ->createServerRequest('GET', 'http://formlogic.local' . $path, ['REMOTE_ADDR' => '203.0.113.9'])
            ->withHeader('Authorization', 'Bearer ' . self::KEY);
        $ok = new class implements RequestHandlerInterface {
            public function handle(ServerRequestInterface $request): ResponseInterface { return (new SlimResponse())->withStatus(200); }
        };
        return (new ApiKeyMiddleware($keys, [], null))->process($request, $ok);
    }

    /** @return array<string, array{string}> */
    public static function outsideTheFormRoutes(): array
    {
        return [
            'flow runs hold other forms\' answers' => ['/api/v1/flow-runs'],
            'flows' => ['/api/v1/flows'],
            'a route that only starts alike' => ['/api/v1/formsets'],
            'the desktop link' => ['/api/v1/connector-commands/pending'],
        ];
    }

    #[DataProvider('outsideTheFormRoutes')]
    public function testAKeyConfinedToFormsReachesNothingElse(string $path): void
    {
        $refused = $this->send($path, ['form-a']);
        $this->assertSame(403, $refused->getStatusCode());
        $this->assertStringContainsString('specific forms', (string) $refused->getBody());
    }

    public function testAnEmptyListConfinesToo(): void
    {
        $this->assertSame(403, $this->send('/api/v1/flow-runs', [])->getStatusCode());
    }

    public function testItStillReachesTheFormRoutes(): void
    {
        $this->assertSame(200, $this->send('/api/v1/forms', ['form-a'])->getStatusCode());
        $this->assertSame(200, $this->send('/api/v1/forms/form-a/responses', ['form-a'])->getStatusCode());
    }

    public function testAKeyForTheWholeAccountIsUnchanged(): void
    {
        $this->assertSame(200, $this->send('/api/v1/flow-runs', null)->getStatusCode());
    }

    public function testCreatingAnAppIgnoresAnIdInTheBody(): void
    {
        // The id of a deleted app is public (client-manifest), and its storage is still on disk.
        $apps = $this->createMock(AppService::class);
        $apps->expects($this->once())->method('createApp')
            ->with($this->callback(static fn (array $data): bool => !array_key_exists('id', $data) && $data['name'] === 'Mine'), 'attacker')
            ->willReturn(['id' => 'fresh']);
        $request = (new ServerRequestFactory())->createServerRequest('POST', 'http://formlogic.local/api/apps')
            ->withAttribute('userId', 'attacker')
            ->withParsedBody(['name' => 'Mine', 'id' => 'deleted-app-of-someone-else']);

        $response = (new AppController($apps))->create($request, new SlimResponse());

        $this->assertSame(201, $response->getStatusCode());
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\AppController;
use FormLogic\Services\AppService;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response as SlimResponse;

/**
 * An app's publish holds its files for a moment, and on a server with more than one worker a delete
 * can land in that moment. Nothing went wrong and nothing was deleted, so it isn't a server error.
 */
final class AppDeleteWhileUpdatingTest extends TestCase
{
    private function deleteWith(\Throwable $failure): ResponseInterface
    {
        $apps = $this->createMock(AppService::class);
        $apps->method('getApp')->willReturn(['id' => 'a1', 'ownerId' => 'owner']);
        $apps->method('deleteApp')->willThrowException($failure);
        $request = (new ServerRequestFactory())->createServerRequest('DELETE', 'http://formlogic.local/api/apps/a1')
            ->withAttribute('userId', 'owner');

        return (new AppController($apps))->delete($request, new SlimResponse(), ['id' => 'a1']);
    }

    public function testAnAppBeingUpdatedSaysSoAndCanBeDeletedInAMoment(): void
    {
        $response = $this->deleteWith(new \RuntimeException('The app is being updated. Try again shortly.', 409));

        $this->assertSame(409, $response->getStatusCode());
        $this->assertStringContainsString('Try again shortly', (string) $response->getBody());
    }

    public function testAnythingElseStaysAFailureAndKeepsItsDetailsToItself(): void
    {
        $response = $this->deleteWith(new \RuntimeException('SQLSTATE[HY000] table apps is on fire'));

        $this->assertSame(500, $response->getStatusCode());
        $this->assertStringNotContainsString('SQLSTATE', (string) $response->getBody());
    }
}

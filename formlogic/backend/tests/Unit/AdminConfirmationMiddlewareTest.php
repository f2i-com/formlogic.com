<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Middleware\AdminConfirmationMiddleware;
use FormLogic\Services\AuthService;
use FormLogic\Support\HostedActorContext;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response as SlimResponse;

class AdminConfirmationMiddlewareTest extends TestCase
{
    // A page from before this gate has no dialog and doesn't send the header, and neither has a new
    // page on its first request, so the code stays and the words have to serve both. "Confirm your
    // password to continue" alone left an administrator with an update gone wrong and nothing to do.
    public function testARefusalTellsAPageThatNeverAsksThatItIsOutOfDate(): void
    {
        $auth = $this->createStub(AuthService::class);
        $auth->method('adminConfirmed')->willReturn(false);
        $request = (new ServerRequestFactory())->createServerRequest('POST', 'https://formlogic.example/api/admin/upgrade/rollback')
            ->withAttribute(HostedActorContext::SESSION_ATTRIBUTE, 'session')
            ->withAttribute('userId', 'admin');
        $handler = new class implements RequestHandlerInterface {
            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                throw new \LogicException('an unconfirmed write must stop here');
            }
        };

        $response = (new AdminConfirmationMiddleware($auth))->process($request, $handler);

        $this->assertSame(403, $response->getStatusCode());
        $body = json_decode((string) $response->getBody(), true);
        $this->assertSame('admin_confirmation_required', $body['code'], 'a current page opens its dialog on this');
        $this->assertSame('Confirm your password to continue. If nothing asks for it, this page is out of date: reload it.', $body['message']);
    }

    public function testAConfirmedWriteGoesThrough(): void
    {
        $auth = $this->createStub(AuthService::class);
        $auth->method('adminConfirmed')->willReturn(true);
        $request = (new ServerRequestFactory())->createServerRequest('POST', 'https://formlogic.example/api/admin/upgrade/rollback')
            ->withAttribute(HostedActorContext::SESSION_ATTRIBUTE, 'session')
            ->withAttribute('userId', 'admin');
        $handler = new class implements RequestHandlerInterface {
            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                return new SlimResponse(200);
            }
        };

        $this->assertSame(200, (new AdminConfirmationMiddleware($auth))->process($request, $handler)->getStatusCode());
    }
}

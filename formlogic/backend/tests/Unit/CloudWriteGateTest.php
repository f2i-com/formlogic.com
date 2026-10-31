<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Middleware\CloudWriteGateMiddleware;
use FormLogic\Services\PlanService;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Factory\AppFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

/**
 * Verifies the cloud write-gate: when plan enforcement is on, content-creating writes are
 * blocked (402) if the resource OWNER's cloud has lapsed — for standalone public submissions
 * AND app-runtime writes (where the acting member is not the owner). Reads stay open.
 */
class CloudWriteGateTest extends TestCase
{
    /** A PlanService double with no DB: forms F_EXPIRED/F_ACTIVE map to expired/active owners. */
    private function planStub(bool $enforced): PlanService
    {
        return new class($enforced) extends PlanService {
            public function __construct(private bool $on)
            {
                // intentionally skip parent constructor (no DB needed for these tests)
            }
            public function isEnforced(): bool
            {
                return $this->on;
            }
            public function isCloudActive(string $userId): bool
            {
                return $userId === 'owner-active';
            }
            public function ownerOfForm(string $formId): ?string
            {
                return $formId === 'F_ACTIVE' ? 'owner-active' : 'owner-expired';
            }
            public function ownerOfAppSlug(string $slug): ?string
            {
                return ['paid' => 'owner-active', 'lapsed' => 'owner-expired'][$slug] ?? null;
            }
        };
    }

    private function dispatch(PlanService $plan, string $method, string $path, ?string $actingUser = null): ResponseInterface
    {
        $app = AppFactory::create();
        $app->addRoutingMiddleware();
        $gate = new CloudWriteGateMiddleware($plan);

        $ok = fn ($request, $response) => $response->withStatus($method === 'POST' ? 201 : 200);
        // Mirror the real routes that carry the gate.
        $app->post('/api/forms/{formId}/responses', $ok)->add($gate);
        $app->get('/api/forms/{formId}/export', $ok)->add($gate);
        $app->post('/api/app/{slug}/forms/{formId}/responses', $ok)->add($gate);
        $app->post('/api/app/{slug}/sync/batch', $ok)->add($gate);
        $app->post('/api/apps/invitations/accept', $ok)->add($gate);
        $app->post('/api/forms', $ok)->add($gate);

        $request = (new ServerRequestFactory())->createServerRequest($method, 'http://api.test' . $path);
        if ($actingUser !== null) {
            $request = $request->withAttribute('userId', $actingUser);
        }
        return $app->handle($request);
    }

    public function testStandaloneSubmissionBlockedWhenOwnerExpired(): void
    {
        $res = $this->dispatch($this->planStub(true), 'POST', '/api/forms/F_EXPIRED/responses');
        $this->assertSame(402, $res->getStatusCode());
        $this->assertStringContainsString('cloud_expired', (string) $res->getBody());
    }

    public function testStandaloneSubmissionAllowedWhenOwnerActive(): void
    {
        $res = $this->dispatch($this->planStub(true), 'POST', '/api/forms/F_ACTIVE/responses');
        $this->assertSame(201, $res->getStatusCode());
    }

    public function testAppRuntimeWriteGatedByOwnerNotActingMember(): void
    {
        // An active member acting on an EXPIRED owner's app form must still be blocked.
        $res = $this->dispatch($this->planStub(true), 'POST', '/api/app/myapp/forms/F_EXPIRED/responses', 'owner-active');
        $this->assertSame(402, $res->getStatusCode());
    }

    public function testAnAppRouteWithNoFormIsBilledToTheAppsOwner(): void
    {
        $this->assertSame(201, $this->dispatch($this->planStub(true), 'POST', '/api/app/paid/sync/batch', 'owner-expired')->getStatusCode(), 'a lapsed member of a paid app');
        $this->assertSame(402, $this->dispatch($this->planStub(true), 'POST', '/api/app/lapsed/sync/batch', 'owner-active')->getStatusCode(), 'a paying member of a lapsed app');
        $this->assertSame(402, $this->dispatch($this->planStub(true), 'POST', '/api/app/gone/sync/batch', 'owner-expired')->getStatusCode(), 'no such app: the caller answers for it');
    }

    public function testAcceptingAnInvitationIsNotAWriteToPayFor(): void
    {
        $this->assertSame(201, $this->dispatch($this->planStub(true), 'POST', '/api/apps/invitations/accept', 'owner-expired')->getStatusCode());
        $this->assertSame(402, $this->dispatch($this->planStub(true), 'POST', '/api/forms', 'owner-expired')->getStatusCode(), 'and their own writes still are');
    }

    public function testReadsAllowedEvenWhenOwnerExpired(): void
    {
        $res = $this->dispatch($this->planStub(true), 'GET', '/api/forms/F_EXPIRED/export');
        $this->assertSame(200, $res->getStatusCode());
    }

    public function testEnforcementOffNeverBlocks(): void
    {
        $res = $this->dispatch($this->planStub(false), 'POST', '/api/forms/F_EXPIRED/responses');
        $this->assertSame(201, $res->getStatusCode());
    }
}

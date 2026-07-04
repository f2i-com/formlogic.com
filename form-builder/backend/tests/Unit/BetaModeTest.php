<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\BillingController;
use FormLogic\Database\MySQLConnection;
use FormLogic\Services\PayPalService;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ServerRequestInterface;
use Slim\Psr7\Response as SlimResponse;

/**
 * BETA_MODE: payments are turned off. The billing order endpoints reject with a beta_free 403 before
 * touching PayPal/DB, so no one can be charged (and no PayPal config is needed) during the free beta.
 */
class BetaModeTest extends TestCase
{
    private function controller(bool $beta): BillingController
    {
        return new BillingController(
            $this->createMock(PayPalService::class), // isConfigured() defaults to false
            $this->createMock(MySQLConnection::class),
            null,
            null,
            null,
            $beta
        );
    }

    private function request(): ServerRequestInterface
    {
        $r = $this->createMock(ServerRequestInterface::class);
        $r->method('getAttribute')->willReturn('user-1');
        $r->method('getParsedBody')->willReturn(['months' => 1]);
        return $r;
    }

    public function testBetaRejectsCreateOrder(): void
    {
        $out = $this->controller(true)->createOrder($this->request(), new SlimResponse());
        $this->assertSame(403, $out->getStatusCode());
        $body = json_decode((string) $out->getBody(), true);
        $this->assertSame('beta_free', $body['code'] ?? null);
    }

    public function testBetaRejectsCaptureOrder(): void
    {
        $out = $this->controller(true)->captureOrder($this->request(), new SlimResponse(), ['orderId' => 'o1']);
        $this->assertSame(403, $out->getStatusCode());
        $this->assertSame('beta_free', (json_decode((string) $out->getBody(), true)['code'] ?? null));
    }

    public function testNonBetaDoesNotHitTheBetaGate(): void
    {
        // Not beta + PayPal unconfigured → 503 (config error), NOT the 403 beta gate. Proves the gate
        // only fires in beta.
        $out = $this->controller(false)->createOrder($this->request(), new SlimResponse());
        $this->assertSame(503, $out->getStatusCode());
    }
}

<?php
declare(strict_types=1);
namespace FormLogic\Tests\Unit;

use FormLogic\Services\PlatformPlansService;
use FormLogic\Services\AIService;
use FormLogic\Services\PayPalService;
use FormLogic\Database\MySQLConnection;
use FormLogic\Controllers\BillingController;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Response;
use Slim\Psr7\Factory\ServerRequestFactory;

final class PlatformPlansTest extends TestCase
{
    private string $path;
    private PlatformPlansService $plans;
    protected function setUp(): void
    {
        $this->path = sys_get_temp_dir() . '/fl-plans-test-' . bin2hex(random_bytes(8)) . '.json';
        $this->plans = new PlatformPlansService($this->path);
    }
    protected function tearDown(): void
    {
        if (is_file($this->path)) unlink($this->path);
    }
    public function testFreshAndCorruptConfigCannotEnablePaymentsOrSiteAi(): void
    {
        $this->assertFalse($this->plans->status()['paymentsEnabled']);
        $this->assertFalse($this->plans->status()['siteAiEnabled']);
        $this->assertSame(500, $this->plans->status()['pricePerMonthCents']);
        file_put_contents($this->path, '{"paymentsEnabled":true,');
        $this->assertSame(PlatformPlansService::defaults(), $this->plans->status());
    }
    public function testEditsPersistAndInvalidPricesDoNotOverwriteThem(): void
    {
        $data = array_replace(PlatformPlansService::defaults(), ['paymentsEnabled' => true, 'paidName' => 'Community', 'pricePerMonthCents' => 725]);
        $this->plans->save($data);
        $this->assertSame($data, (new PlatformPlansService($this->path))->status());
        foreach ([0, -1, 500.5, '500', 100001] as $price) {
            try { $this->plans->save(array_replace($data, ['pricePerMonthCents' => $price])); $this->fail('invalid price accepted'); }
            catch (\InvalidArgumentException) { $this->assertSame($data, $this->plans->status()); }
        }
        $this->plans->save(array_replace($data, ['paymentsEnabled' => false]));
        $this->assertFalse($this->plans->status()['paymentsEnabled']);
    }
    public function testDisabledCheckoutNeverContactsPaypalOrDatabase(): void
    {
        $paypal = $this->createMock(PayPalService::class);
        $paypal->expects($this->never())->method('createOrder');
        $paypal->expects($this->never())->method('captureOrder');
        $db = $this->createMock(MySQLConnection::class);
        $db->expects($this->never())->method('getConnection');
        $controller = new BillingController($paypal, $db, null, null, null, false, $this->plans);
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/')->withAttribute('userId', 'test')->withParsedBody(['months' => 1]);
        foreach ([$controller->createOrder($request, new Response()), $controller->captureOrder($request, new Response(), ['orderId' => 'pending'])] as $response) {
            $this->assertSame(403, $response->getStatusCode());
            $this->assertSame('payments_disabled', json_decode((string) $response->getBody(), true)['code']);
        }
    }
    public function testEnabledCheckoutUsesServerPriceAndKeepsBetaOverride(): void
    {
        $this->plans->save(array_replace(PlatformPlansService::defaults(), ['paymentsEnabled' => true, 'pricePerMonthCents' => 625]));
        $pdo = new \PDO('sqlite::memory:');
        $pdo->exec('CREATE TABLE payments (id TEXT, user_id TEXT, provider TEXT, order_id TEXT, amount_cents INT, currency TEXT, months INT, status TEXT)');
        $db = $this->createMock(MySQLConnection::class);
        $db->method('getConnection')->willReturn($pdo);
        $paypal = $this->createMock(PayPalService::class);
        $paypal->method('isConfigured')->willReturn(true);
        $paypal->expects($this->once())->method('createOrder')->with(1250, 'USD', '60 days of Supporter', 'test:2')->willReturn('fake-order');
        $request = (new ServerRequestFactory())->createServerRequest('POST', '/')->withAttribute('userId', 'test')->withParsedBody(['months' => 2, 'pricePerMonthCents' => 1]);
        $controller = new BillingController($paypal, $db, null, null, null, false, $this->plans);
        $this->assertSame(200, $controller->createOrder($request, new Response())->getStatusCode());
        $this->assertSame(1250, (int) $pdo->query('SELECT amount_cents FROM payments')->fetchColumn());
        $this->plans->save(array_replace($this->plans->status(), ['pricePerMonthCents' => 900]));
        $this->assertSame(1250, (int) $pdo->query('SELECT amount_cents FROM payments')->fetchColumn());
        $beta = new BillingController($paypal, $db, null, null, null, true, $this->plans);
        $this->assertSame(403, $beta->createOrder($request, new Response())->getStatusCode());
    }
    public function testHostedAiRequiresExplicitOperatorOptIn(): void
    {
        $service = new AIService($this->plans);
        $this->assertFalse($service->isEnabled());
        $this->plans->save(array_replace(PlatformPlansService::defaults(), ['siteAiEnabled' => true]));
        $old = $_ENV['AI_ENABLED'] ?? null;
        try {
            $_ENV['AI_ENABLED'] = 'true';
            $this->assertTrue($service->isEnabled());
            $_ENV['AI_ENABLED'] = 'false';
            $this->assertFalse($service->isEnabled());
        } finally {
            if ($old === null) unset($_ENV['AI_ENABLED']); else $_ENV['AI_ENABLED'] = $old;
        }
    }

    public function testExpiredLegacyBalanceStillHasFreeAccessAndNoCheckout(): void
    {
        $pdo = new \PDO('sqlite::memory:');
        $pdo->exec("CREATE TABLE users (id TEXT, cloud_until TEXT); INSERT INTO users VALUES ('test', '2000-01-01')");
        $db = $this->createMock(MySQLConnection::class);
        $db->method('getConnection')->willReturn($pdo);
        $paypal = $this->createMock(PayPalService::class);
        $paypal->expects($this->never())->method('getClientId');
        $controller = new BillingController($paypal, $db, null, null, null, false, $this->plans);
        $request = (new ServerRequestFactory())->createServerRequest('GET', '/')->withAttribute('userId', 'test');
        $body = json_decode((string) $controller->status($request, new Response())->getBody(), true);
        $this->assertTrue($body['active']);
        $this->assertFalse($body['paypalEnabled']);
        $this->assertNull($body['paypalClientId']);
        $this->assertSame('Free', $body['plans']['freeName']);
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\AppDataExportController;
use FormLogic\Services\AppDataExportService;
use FormLogic\Services\AppService;
use FormLogic\Services\AuditService;
use PHPUnit\Framework\TestCase;
use Slim\Psr7\Factory\ServerRequestFactory;
use Slim\Psr7\Response as SlimResponse;

/**
 * The app data export is audited with the client's address. Behind a proxy that address is the
 * one the proxy forwards, and only a proxy named in TRUSTED_PROXIES is believed. The controller
 * built its resolver with no proxies at all, so every export behind one was recorded as coming
 * from the proxy.
 */
class AppDataExportClientIpTest extends TestCase
{
    /** @var array{0: string|false, 1: string|false} */
    private array $previous;
    private ?string $previousEnv;

    protected function setUp(): void
    {
        $this->previous = [getenv('TRUSTED_PROXIES'), getenv('TRUSTED_PROXY_HEADER')];
        $this->previousEnv = $_ENV['TRUSTED_PROXIES'] ?? null;
        putenv('TRUSTED_PROXIES=10.0.0.0/8');
        putenv('TRUSTED_PROXY_HEADER');
    }

    protected function tearDown(): void
    {
        putenv($this->previous[0] === false ? 'TRUSTED_PROXIES' : 'TRUSTED_PROXIES=' . $this->previous[0]);
        putenv($this->previous[1] === false ? 'TRUSTED_PROXY_HEADER' : 'TRUSTED_PROXY_HEADER=' . $this->previous[1]);
        if ($this->previousEnv === null) {
            unset($_ENV['TRUSTED_PROXIES']);
        } else {
            $_ENV['TRUSTED_PROXIES'] = $this->previousEnv;
        }
    }

    public function testTheExportIsAuditedWithTheAddressATrustedProxyForwards(): void
    {
        $apps = $this->createMock(AppService::class);
        $apps->method('getApp')->willReturn(['id' => 'app-1', 'ownerId' => 'owner-1', 'slug' => 'shop']);
        $file = tempnam(sys_get_temp_dir(), 'fl-export-');
        file_put_contents($file, 'zip');
        $exports = $this->createMock(AppDataExportService::class);
        $exports->method('exportSqliteBundle')->willReturn($file);

        $audit = $this->createMock(AuditService::class);
        $audit->expects($this->once())->method('log')
            ->with('app.data_export', 'app', 'app-1', 'owner-1', '203.0.113.7', ['format' => 'sqlite']);

        $request = (new ServerRequestFactory())->createServerRequest('GET', 'http://api.test/api/apps/app-1/data-export', ['REMOTE_ADDR' => '10.0.0.5', 'HTTP_X_FORWARDED_FOR' => '203.0.113.7'])
            ->withAttribute('userId', 'owner-1');
        $response = (new AppDataExportController($apps, $exports, $audit))->export($request, new SlimResponse(), ['id' => 'app-1']);

        $this->assertSame(200, $response->getStatusCode());
        $response->getBody()->close();
        @unlink($file);
    }
}

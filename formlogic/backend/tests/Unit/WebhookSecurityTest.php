<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\WebhookService;
use PHPUnit\Framework\TestCase;

/**
 * SSRF + URL-validation regression tests for webhook URLs. validateWebhookUrl() is the single
 * authority used at create/update/delivery time, so these lock down the blocked-host /
 * private-IP / scheme rules. Deterministic: uses literal IPs and the reserved `.invalid` TLD,
 * so no real network/DNS is required.
 */
class WebhookSecurityTest extends TestCase
{
    /** @return array<string, array{string}> */
    public static function blockedUrls(): array
    {
        return [
            'localhost' => ['http://localhost/hook'],
            'loopback v4' => ['http://127.0.0.1/hook'],
            'all-zeros' => ['http://0.0.0.0/hook'],
            'loopback v6' => ['http://[::1]/hook'],
            'ipv4-mapped loopback' => ['http://[::ffff:127.0.0.1]/hook'],
            'link-local metadata' => ['http://169.254.169.254/latest/meta-data'],
            'gcp metadata host' => ['http://metadata.google.internal/x'],
            'azure metadata host' => ['http://metadata.azure.internal/x'],
            'private 10/8' => ['https://10.0.0.5/hook'],
            'private 192.168' => ['https://192.168.1.10/hook'],
            'private 172.16' => ['https://172.16.0.1/hook'],
            'link-local 169.254' => ['https://169.254.10.10/hook'],
            'unresolvable host' => ['https://no-such-host.invalid/hook'],
            'ftp scheme' => ['ftp://example.com/hook'],
            'file scheme' => ['file:///etc/passwd'],
            'javascript scheme' => ['javascript:alert(1)'],
            'no scheme' => ['example.com/hook'],
            'empty' => [''],
            'gopher scheme' => ['gopher://127.0.0.1:11211/x'],
        ];
    }

    /**
     * @dataProvider blockedUrls
     */
    public function testRejectsUnsafeUrls(string $url): void
    {
        $this->expectException(\InvalidArgumentException::class);
        WebhookService::validateWebhookUrl($url);
    }

    public function testAcceptsPublicIp(): void
    {
        // Literal public IP — no DNS needed; gethostbynamel echoes the IP back.
        $this->assertSame('8.8.8.8', WebhookService::validateWebhookUrl('https://8.8.8.8/hook'));
    }

    public function testAcceptsMixedCaseHttpsScheme(): void
    {
        // Scheme is matched case-insensitively; a public IP host passes.
        $this->assertSame('1.1.1.1', WebhookService::validateWebhookUrl('HtTpS://1.1.1.1/hook'));
    }
}

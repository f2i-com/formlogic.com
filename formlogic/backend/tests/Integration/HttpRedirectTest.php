<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Services\FormLogicRuntime;
use PHPUnit\Framework\TestCase;

/** ctx.http's redirect hops, against a real server: curl is the thing being tested. */
final class HttpRedirectTest extends TestCase
{
    /** @var resource|null */
    private static $server = null;
    private static string $base = '';
    private static string $router = '';

    public static function setUpBeforeClass(): void
    {
        if (!function_exists('curl_init')) {
            self::markTestSkipped('curl');
        }
        $socket = stream_socket_server('tcp://127.0.0.1:0');
        $port = (int) substr((string) strrchr((string) stream_socket_get_name($socket, false), ':'), 1);
        fclose($socket);
        self::$router = (string) tempnam(sys_get_temp_dir(), 'fl-redirects');
        file_put_contents(self::$router, <<<'PHP'
<?php
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$hops = ['/moved' => [301, '/temporary'], '/temporary' => [307, '/end'], '/kept' => [307, '/end'], '/see-other' => [303, '/end']];
if (isset($hops[$path])) {
    http_response_code($hops[$path][0]);
    header('Location: ' . $hops[$path][1]);
    return;
}
header('Content-Type: application/json');
echo json_encode(['method' => $_SERVER['REQUEST_METHOD'], 'body' => file_get_contents('php://input')]);
PHP);
        self::$server = proc_open([PHP_BINARY, '-S', "127.0.0.1:{$port}", self::$router], [['pipe', 'r'], ['pipe', 'w'], ['pipe', 'w']], $pipes);
        self::$base = "http://127.0.0.1:{$port}";
        for ($i = 0; $i < 100; $i++) {
            $probe = @fsockopen('127.0.0.1', $port, $code, $message, 0.1);
            if ($probe !== false) {
                fclose($probe);
                return;
            }
            usleep(50000);
        }
        self::fail('the server did not start');
    }

    public static function tearDownAfterClass(): void
    {
        if (is_resource(self::$server)) {
            proc_terminate(self::$server);
            proc_close(self::$server);
        }
        @unlink(self::$router);
    }

    /** @return array{method: string, body: string} what the last hop received */
    private function send(string $method, string $path, mixed $body): array
    {
        $runtime = new class extends FormLogicRuntime {
            public function __construct()
            {
            }
            protected function checkHostSecurity(string $host): array
            {
                return ['isPrivate' => false, 'resolvedIp' => null];
            }
        };
        foreach (['httpDeadline' => microtime(true) + 10, 'maxWallTimeMs' => 10000, 'httpRequestCount' => 0] as $name => $value) {
            (new \ReflectionProperty(FormLogicRuntime::class, $name))->setValue($runtime, $value);
        }
        $result = (new \ReflectionMethod(FormLogicRuntime::class, 'executeHttpRequest'))->invoke($runtime, $method, self::$base . $path, $body, []);
        $this->assertIsArray($result);
        $seen = $result['data'] ?? $result['body'] ?? null;
        $seen = is_string($seen) ? json_decode($seen, true) : $seen;
        $this->assertIsArray($seen, (string) json_encode($result));
        return $seen;
    }

    public function testA301ThenA307StaysTheGetThe301MadeIt(): void
    {
        $this->assertSame(['method' => 'GET', 'body' => ''], $this->send('POST', '/moved', ['a' => 1]));
    }

    public function testA307KeepsTheMethodAndTheBody(): void
    {
        $this->assertSame(['method' => 'POST', 'body' => '{"a":1}'], $this->send('POST', '/kept', ['a' => 1]));
    }

    public function testA303DropsTheBody(): void
    {
        $this->assertSame(['method' => 'GET', 'body' => ''], $this->send('PUT', '/see-other', ['a' => 1]));
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use PHPUnit\Framework\TestCase;

/**
 * The import's two steps as the wizard sends them: a real multipart upload of real bytes, through
 * the real front controller. is_uploaded_file() won't take anything else.
 */
final class CsvImportOverHttpTest extends TestCase
{
    private static ?\PDO $pdo = null;
    /** @var resource|null */
    private static $site = null;
    private static string $base = '';
    private static string $storage = '';
    private static string $upload = '';
    private static string $cookie = '';
    private static string $csrf = '';
    private static string $userId = '';
    private static string $formId = '';

    public static function setUpBeforeClass(): void
    {
        $backend = dirname(__DIR__, 2);
        if (is_file($backend . '/.env')) {
            \Dotenv\Dotenv::createImmutable($backend)->safeLoad();
        }
        $config = [
            'host' => $_ENV['DB_HOST'] ?? '127.0.0.1',
            'port' => $_ENV['DB_PORT'] ?? '3306',
            'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
            'username' => $_ENV['DB_USERNAME'] ?? 'root',
            'password' => $_ENV['DB_PASSWORD'] ?? '',
            'charset' => 'utf8mb4',
            'collation' => 'utf8mb4_unicode_ci',
        ];
        try {
            $conn = new MySQLConnection($config);
            $conn->ensureSchemaCurrent();
            self::$pdo = $conn->getConnection();
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
        self::$pdo->exec('DELETE FROM rate_limits');

        $probe = stream_socket_server('tcp://127.0.0.1:0');
        $port = (int) substr(strrchr((string) stream_socket_get_name($probe, false), ':'), 1);
        fclose($probe);
        self::$base = "http://127.0.0.1:{$port}";
        $relative = 'storage/fl-csv-test-' . bin2hex(random_bytes(5));
        self::$storage = $backend . '/' . $relative;
        mkdir(self::$storage, 0777, true);
        self::$upload = tempnam(sys_get_temp_dir(), 'flcsv');

        $pipes = [];
        $nowhere = PHP_OS_FAMILY === 'Windows' ? 'NUL' : '/dev/null';
        self::$site = proc_open(
            [PHP_BINARY, '-d', 'variables_order=EGPCS', '-d', 'xdebug.mode=off', '-S', "127.0.0.1:{$port}", '-t', $backend . '/public', dirname($backend) . '/ci/router.php'],
            [1 => ['file', $nowhere, 'a'], 2 => ['file', $nowhere, 'a']],
            $pipes,
            $backend,
            [
                'DB_HOST' => $config['host'], 'DB_PORT' => $config['port'], 'DB_DATABASE' => $config['database'],
                'DB_USERNAME' => $config['username'], 'DB_PASSWORD' => $config['password'],
                'SystemRoot' => (string) getenv('SystemRoot'), 'PATH' => (string) getenv('PATH'), 'TEMP' => sys_get_temp_dir(), 'TMP' => sys_get_temp_dir(),
                'APP_ENV' => 'development', 'APP_URL' => self::$base, 'CORS_ORIGIN' => self::$base, 'CORS_ALLOWED_ORIGINS' => self::$base,
                'SQLITE_STORAGE_PATH' => $relative, 'PRIVATE_FORMS' => 'false', 'DATA_NODES' => 'false', 'COOKIE_SECURE' => 'false',
            ]
        ) ?: null;
        self::assertIsResource(self::$site, 'the site starts');
        for ($i = 0; $i < 300 && @self::call('GET', '/api/health')['status'] !== 200; $i++) {
            usleep(200_000);
        }

        $registered = self::call('POST', '/api/auth/register', json_encode(['email' => 'csv-' . bin2hex(random_bytes(6)) . '@example.com', 'password' => 'correct-horse-battery-9', 'name' => 'Csv']));
        self::assertSame(201, $registered['status'], $registered['body']);
        preg_match_all('/^Set-Cookie: ([^;\r\n]+)/mi', $registered['headers'], $cookies);
        self::$cookie = implode('; ', $cookies[1]);
        self::$csrf = (string) preg_replace('/^.*formlogic_csrf=([^;]+).*$/', '$1', self::$cookie);
        self::$userId = (string) json_decode($registered['body'], true)['user']['id'];

        $made = self::call('POST', '/api/forms', json_encode(['title' => 'CSV', 'status' => 'published', 'fields' => [
            ['id' => 'a', 'type' => 'short_text', 'label' => 'Name', 'order' => 0, 'properties' => []],
            ['id' => 'b', 'type' => 'short_text', 'label' => 'City', 'order' => 1, 'properties' => []],
        ]]));
        self::assertSame(201, $made['status'], $made['body']);
        self::$formId = (string) json_decode($made['body'], true)['form']['id'];
    }

    public static function tearDownAfterClass(): void
    {
        if (is_resource(self::$site)) {
            proc_terminate(self::$site);
            proc_close(self::$site);
        }
        if (self::$upload !== '') {
            @unlink(self::$upload);
        }
        if (self::$storage !== '') {
            self::removeTree(self::$storage);
        }
        if (self::$pdo !== null && self::$userId !== '') {
            self::$pdo->prepare('DELETE FROM response_metadata WHERE form_id = ?')->execute([self::$formId]);
            self::$pdo->prepare('DELETE FROM forms WHERE id = ?')->execute([self::$formId]);
            self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([self::$userId]);
        }
    }

    private static function removeTree(string $path): void
    {
        foreach (glob($path . '/{,.}*', GLOB_BRACE) ?: [] as $entry) {
            if (in_array(basename($entry), ['.', '..'], true)) {
                continue;
            }
            is_dir($entry) ? self::removeTree($entry) : @unlink($entry);
        }
        @rmdir($path);
    }

    /**
     * @param string|array<string, mixed>|null $body
     * @return array{status:int, headers:string, body:string}
     */
    private static function call(string $method, string $path, string|array|null $body = null): array
    {
        $headers = ['Origin: ' . self::$base, 'Accept: application/json'];
        if (self::$cookie !== '') {
            $headers[] = 'Cookie: ' . self::$cookie;
            $headers[] = 'X-CSRF-Token: ' . self::$csrf;
        }
        if (is_string($body)) {
            $headers[] = 'Content-Type: application/json';
        }
        $curl = curl_init(self::$base . $path);
        curl_setopt_array($curl, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HEADER => true,
            CURLOPT_TIMEOUT => 30,
            CURLOPT_HTTPHEADER => $headers,
        ] + ($body === null ? [] : [CURLOPT_POSTFIELDS => $body]));
        $reply = (string) curl_exec($curl);
        $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
        $size = (int) curl_getinfo($curl, CURLINFO_HEADER_SIZE);
        curl_close($curl);
        return ['status' => $status, 'headers' => substr($reply, 0, $size), 'body' => substr($reply, $size)];
    }

    /**
     * @param array<string, string> $extra
     * @return array{status:int, json:array<string, mixed>}
     */
    private function upload(string $bytes, array $extra = []): array
    {
        file_put_contents(self::$upload, $bytes);
        $answer = self::call('POST', '/api/forms/' . self::$formId . '/responses/import', ['file' => new \CURLFile(self::$upload, 'text/csv', 'people.csv')] + $extra);
        $json = json_decode($answer['body'], true);
        self::assertIsArray($json, $answer['body']);
        return ['status' => $answer['status'], 'json' => $json];
    }

    private function storedRows(): int
    {
        $list = self::call('GET', '/api/forms/' . self::$formId . '/responses?limit=100');
        return count(json_decode($list['body'], true)['responses']);
    }

    public function testTheParseStepSaysWhatTheFileWasReadAs(): void
    {
        $western = $this->upload("Name,City\r\nJos\xE9,Malm\xF6\r\n");
        self::assertSame(200, $western['status']);
        self::assertSame('Windows-1252', $western['json']['encoding']);
        self::assertSame([['José', 'Malmö']], $western['json']['previewCells']);

        $utf8 = $this->upload("Name,City\r\nJosé,Malmö\r\n");
        self::assertSame('UTF-8', $utf8['json']['encoding']);
        self::assertFalse($utf8['json']['endCut']);
    }

    public function testACutFileStaysUtf8AndSaysItWasCut(): void
    {
        $cut = $this->upload("Name,City\r\nJosé,Malmö\r\nAda,Osl\xC3");

        self::assertSame(200, $cut['status']);
        self::assertSame('UTF-8', $cut['json']['encoding']);
        self::assertTrue($cut['json']['endCut']);
        self::assertSame(['José', 'Malmö'], $cut['json']['previewCells'][0]);
    }

    public function testAnotherCodePageIsAFourHundredAtBothStepsAndStoresNothing(): void
    {
        $before = $this->storedRows();
        $shiftJis = "Name,City\r\n" . hex2bin('8e5293632c938c8b9e') . "\r\n";

        foreach ([$this->upload($shiftJis), $this->upload($shiftJis, ['columns' => '["a","b"]']), $this->upload($shiftJis, ['columnMapping' => '{"Name":"a","City":"b"}'])] as $refused) {
            self::assertSame(400, $refused['status']);
            self::assertTrue($refused['json']['error']);
            self::assertStringContainsString('CSV UTF-8', $refused['json']['message']);
        }
        self::assertSame($before, $this->storedRows());
    }

    public function testALineOfSpacesIsNotARecord(): void
    {
        $before = $this->storedRows();

        $imported = $this->upload("Name,City\nAda,Oslo\n   \n", ['columns' => '["a","b"]']);

        self::assertSame(1, $imported['json']['created'], json_encode($imported['json']));
        self::assertSame($before + 1, $this->storedRows());
    }
}

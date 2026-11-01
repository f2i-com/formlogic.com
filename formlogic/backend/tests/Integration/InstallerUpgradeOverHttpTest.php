<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * The wizard's upgrade, as a browser reaches it. bin/upgrade.php gained a guard that ended any web
 * request, and the wizard requires that file, so from v0.1.18 its upgrade steps answered an empty
 * 404. No test saw it: they listed the action names, or required the file from the command line.
 * So this runs a real web server on a site laid out as a release is: install.php beside api/.
 */
final class InstallerUpgradeOverHttpTest extends TestCase
{
    private static ?PDO $pdo = null;
    /** @var array<string, string> */
    private static array $config = [];
    /** @var resource|null */
    private static $site = null;
    private static string $base = '';
    private static string $root = '';
    private static string $cookie = '';
    private static string $token = '';

    public static function setUpBeforeClass(): void
    {
        $backend = dirname(__DIR__, 2);
        if (is_file($backend . '/.env')) {
            \Dotenv\Dotenv::createImmutable($backend)->safeLoad();
        }
        self::$config = [
            'host' => $_ENV['DB_HOST'] ?? '127.0.0.1',
            'port' => $_ENV['DB_PORT'] ?? '3306',
            'database' => $_ENV['DB_TEST_DATABASE'] ?? 'formlogic_test',
            'username' => $_ENV['DB_USERNAME'] ?? 'root',
            'password' => $_ENV['DB_PASSWORD'] ?? '',
            'charset' => 'utf8mb4',
            'collation' => 'utf8mb4_unicode_ci',
        ];
        try {
            $conn = new MySQLConnection(self::$config);
            $conn->ensureSchemaCurrent();
            self::$pdo = $conn->getConnection();
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
        self::layOutSite($backend);
        self::startSite();
    }

    public static function tearDownAfterClass(): void
    {
        if (is_resource(self::$site)) {
            proc_terminate(self::$site);
            proc_close(self::$site);
        }
        if (self::$root !== '') {
            self::removeTree(self::$root);
        }
        self::$pdo?->exec("DELETE FROM schema_meta WHERE meta_key IN ('app_version', 'last_upgrade_at', 'upgrade_source')");
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

    /** The real wizard and upgrade script, with the backend's code reached from the site's api/. */
    private static function layOutSite(string $backend): void
    {
        self::$root = sys_get_temp_dir() . '/fl-wizard-' . bin2hex(random_bytes(6));
        foreach (['/api/bin', '/api/config', '/api/vendor', '/sessions'] as $folder) {
            mkdir(self::$root . $folder, 0777, true);
        }
        copy(dirname($backend) . '/install.php', self::$root . '/install.php');
        copy($backend . '/bin/upgrade.php', self::$root . '/api/bin/upgrade.php');
        file_put_contents(self::$root . '/api/vendor/autoload.php', '<?php return require ' . var_export($backend . '/vendor/autoload.php', true) . ';');
        file_put_contents(self::$root . '/api/config/settings.php', '<?php return require ' . var_export($backend . '/config/settings.php', true) . ';');
        file_put_contents(self::$root . '/api/.env', implode("\n", [
            'APP_ENV=development',
            'JWT_SECRET=' . str_repeat('wizard-over-http-', 3),
            'DB_HOST=' . self::$config['host'],
            'DB_PORT=' . self::$config['port'],
            'DB_DATABASE=' . self::$config['database'],
            'DB_USERNAME=' . self::$config['username'],
            'DB_PASSWORD=' . self::$config['password'],
        ]) . "\n");
    }

    private static function startSite(): void
    {
        $probe = stream_socket_server('tcp://127.0.0.1:0');
        $port = (int) substr(strrchr((string) stream_socket_get_name($probe, false), ':'), 1);
        fclose($probe);
        self::$base = "http://127.0.0.1:{$port}";

        $pipes = [];
        $nowhere = PHP_OS_FAMILY === 'Windows' ? 'NUL' : '/dev/null';
        self::$site = proc_open(
            [PHP_BINARY, '-d', 'variables_order=EGPCS', '-d', 'xdebug.mode=off', '-d', 'session.save_path=' . self::$root . '/sessions', '-S', "127.0.0.1:{$port}", '-t', self::$root],
            [1 => ['file', $nowhere, 'a'], 2 => ['file', $nowhere, 'a']],
            $pipes,
            self::$root,
            [
                'SystemRoot' => (string) getenv('SystemRoot'), 'PATH' => (string) getenv('PATH'), 'TEMP' => sys_get_temp_dir(), 'TMP' => sys_get_temp_dir(),
                // As `SetEnv INSTALL_ENABLE 1` does: the site has a .env, so it's installed.
                'INSTALL_ENABLE' => '1',
            ]
        ) ?: null;
        self::assertIsResource(self::$site, 'the site starts');
        for ($i = 0; $i < 100; $i++) {
            $page = @self::request('/install.php');
            if ($page['status'] === 200) {
                preg_match('/CSRF_TOKEN = "([a-f0-9]{64})"/', $page['body'], $token);
                preg_match('/^Set-Cookie: ([^;\r\n]+)/mi', $page['headers'], $cookie);
                self::$token = $token[1] ?? '';
                self::$cookie = $cookie[1] ?? '';
                return;
            }
            usleep(100_000);
        }
        self::fail('the wizard did not come up');
    }

    /** @return array{status:int, headers:string, body:string} */
    private static function request(string $path, ?string $action = null): array
    {
        $curl = curl_init(self::$base . $path);
        curl_setopt_array($curl, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HEADER => true,
            CURLOPT_TIMEOUT => 120,
        ] + ($action === null ? [] : [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => http_build_query(['action' => $action, 'csrf' => self::$token]),
            CURLOPT_HTTPHEADER => ['Cookie: ' . self::$cookie],
        ]));
        $reply = (string) curl_exec($curl);
        $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
        $headerSize = (int) curl_getinfo($curl, CURLINFO_HEADER_SIZE);
        curl_close($curl);
        return ['status' => $status, 'headers' => substr($reply, 0, $headerSize), 'body' => substr($reply, $headerSize)];
    }

    public function testTheWizardSeesAnExistingInstallation(): void
    {
        self::assertNotSame('', self::$token, 'the page carries its token');

        $answer = self::request('/install.php', 'detect_install');

        self::assertSame(200, $answer['status'], $answer['body'] === '' ? 'an empty answer' : $answer['body']);
        $detected = json_decode($answer['body'], true);
        self::assertIsArray($detected, $answer['body']);
        self::assertTrue($detected['isUpgrade'], $answer['body']);
        self::assertGreaterThan(0, $detected['coreTablesTotal']);
        self::assertSame($detected['coreTablesTotal'], $detected['coreTablesPresent']);
    }

    public function testTheWizardRunsTheUpgrade(): void
    {
        $answer = self::request('/install.php', 'run_upgrade');

        self::assertSame(200, $answer['status'], $answer['body'] === '' ? 'an empty answer' : $answer['body']);
        $result = json_decode($answer['body'], true);
        self::assertIsArray($result, $answer['body']);
        self::assertTrue($result['success'], $answer['body']);
        self::assertSame([], array_values(array_filter($result['steps'], static fn (array $step): bool => $step['status'] === 'error')));
        $stamp = self::$pdo->query("SELECT meta_value FROM schema_meta WHERE meta_key = 'upgrade_source'")->fetchColumn();
        self::assertSame('installer', $stamp);
        self::assertSame(MySQLConnection::schemaCodeStamp(), self::$pdo->query("SELECT meta_value FROM schema_meta WHERE meta_key = '" . MySQLConnection::SCHEMA_STAMP_KEY . "'")->fetchColumn());
    }

    public function testAVisitorStillCannotRunTheScript(): void
    {
        $before = self::$pdo->query('SELECT COUNT(*) FROM schema_meta')->fetchColumn();

        foreach ([self::request('/api/bin/upgrade.php'), self::request('/api/bin/upgrade.php?FORMLOGIC_UPGRADE_NO_RUN=1', 'run_upgrade')] as $answer) {
            self::assertSame(404, $answer['status']);
            self::assertSame('', $answer['body']);
        }
        self::assertSame($before, self::$pdo->query('SELECT COUNT(*) FROM schema_meta')->fetchColumn());
    }
}

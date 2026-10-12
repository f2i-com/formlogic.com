<?php

declare(strict_types=1);
namespace FormLogic\Tests\Unit;
use PHPUnit\Framework\TestCase;

final class InstallerReliabilityTest extends TestCase
{
    /** The installer under test. */
    private const INSTALLER = __DIR__ . '/../../../install.php';

    /** @var string[] scratch directories to remove */
    private array $scratch = [];

    public static function setUpBeforeClass(): void
    {
        if (!defined('FORMLOGIC_INSTALL_NO_RUN')) define('FORMLOGIC_INSTALL_NO_RUN', true);
        require_once dirname(__DIR__, 3) . '/install.php';
    }
    protected function tearDown(): void
    {
        foreach ($this->scratch as $dir) {
            self::removeTree($dir);
        }
        $this->scratch = [];
    }
    private static function removeTree(string $dir): void
    {
        if (!is_dir($dir)) return;
        foreach (scandir($dir) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..') continue;
            $path = $dir . '/' . $entry;
            is_dir($path) && !is_link($path) ? self::removeTree($path) : @unlink($path);
        }
        @rmdir($dir);
    }
    private function scratchDir(): string
    {
        $dir = sys_get_temp_dir() . '/fl-installer-' . bin2hex(random_bytes(6));
        mkdir($dir, 0700, true);
        return $this->scratch[] = $dir;
    }
    /**
     * A copy of the installer beside its own api/ folder, as a release zip lays it out. The real
     * file must never run an install: it would write the checkout's own backend/.env.
     */
    private function installerCopy(): string
    {
        $root = $this->scratchDir();
        mkdir($root . '/api/database', 0700, true);
        copy(self::INSTALLER, $root . '/install.php');
        copy(dirname(__DIR__, 2) . '/.env.example', $root . '/api/.env.example');
        return $root;
    }
    /**
     * Run the copy's runInstall() in its own PHP process (this one already holds the real file's
     * functions) and return what it answered.
     *
     * @param array<string,string> $data the wizard's form fields
     * @return array<string,mixed>
     */
    private function runInstallIn(string $root, array $data): array
    {
        $code = 'define("FORMLOGIC_INSTALL_NO_RUN", true); require $argv[1];'
            . ' echo json_encode(runInstall(json_decode(base64_decode($argv[2]), true)));';
        $result = \flRunInstallerCommand(
            [PHP_BINARY, '-d', 'xdebug.mode=off', '-r', $code, $root . '/install.php', base64_encode((string) json_encode($data))],
            $root,
            60.0
        );
        self::assertSame(0, $result['exitCode'], $result['output']);
        $decoded = json_decode($result['output'], true);
        self::assertIsArray($decoded, $result['output']);
        return $decoded;
    }
    /** @param array<string,mixed> $result @return string[] "status:label" per step */
    private static function steps(array $result): array
    {
        return array_map(static fn (array $s): string => $s['status'] . ':' . $s['label'], $result['steps'] ?? []);
    }

    public function testProvisioningPreservesOutputAndExitCode(): void
    {
        $result = \flRunInstallerCommand([PHP_BINARY, '-r', 'fwrite(STDERR, "catalog failed"); exit(3);'], sys_get_temp_dir());
        self::assertSame(3, $result['exitCode']);
        self::assertSame('catalog failed', $result['output']);
        self::assertFalse($result['timedOut']);
    }
    public function testLongRunningProvisioningIsStoppedBeforeTheWebRequestTimesOut(): void
    {
        $start = microtime(true);
        $result = \flRunInstallerCommand([PHP_BINARY, '-r', 'echo "started"; sleep(10);'], sys_get_temp_dir(), 0.2);
        self::assertTrue($result['timedOut']);
        self::assertSame(-1, $result['exitCode']);
        self::assertLessThan(3, microtime(true) - $start);
    }
    public function testCommandOutputIsBounded(): void
    {
        $result = \flRunInstallerCommand([PHP_BINARY, '-r', 'echo str_repeat("x", 20000);'], sys_get_temp_dir());
        self::assertSame(0, $result['exitCode']);
        self::assertSame(8192, strlen($result['output']));
    }
    public function testUnexpectedActionFailureReturnsAnActionableReference(): void
    {
        $result = \flInstallerAction('test_database', ['db_host' => new \stdClass()]);
        self::assertFalse($result['success']);
        self::assertStringStartsWith('install-', $result['errorId']);
        self::assertStringContainsString('hosting PHP error log', $result['message']);
        self::assertStringNotContainsString('TypeError', $result['message']);
    }

    // ── Who may reach the wizard ────────────────────────────────────────────────────────────

    public function testADirectRequestFromTheMachineItselfIsLocal(): void
    {
        self::assertTrue(\flInstallerIsLocalRequest(['REMOTE_ADDR' => '127.0.0.1', 'HTTP_HOST' => 'localhost']));
        self::assertTrue(\flInstallerIsLocalRequest(['REMOTE_ADDR' => '::1']));
        self::assertFalse(\flInstallerIsLocalRequest(['REMOTE_ADDR' => '203.0.113.9']));
        self::assertFalse(\flInstallerIsLocalRequest([]));
    }
    /**
     * Behind nginx, Caddy, cloudflared or ngrok on the same host, every visitor on the internet
     * has REMOTE_ADDR 127.0.0.1. Counting those as local opened an uninstalled site's wizard to
     * anyone, with no INSTALL_ENABLE opt-in.
     */
    public function testARequestForwardedByAProxyOrTunnelOnTheSameHostIsNotLocal(): void
    {
        foreach ([
            'HTTP_X_FORWARDED_FOR' => '198.51.100.7',
            'HTTP_X_FORWARDED_HOST' => 'forms.example.com',
            'HTTP_X_FORWARDED_PROTO' => 'https',
            'HTTP_FORWARDED' => 'for=198.51.100.7;proto=https',
            'HTTP_X_REAL_IP' => '198.51.100.7',
            'HTTP_VIA' => '1.1 tunnel',
            'HTTP_CF_CONNECTING_IP' => '198.51.100.7',
            'HTTP_TRUE_CLIENT_IP' => '198.51.100.7',
        ] as $header => $value) {
            self::assertFalse(
                \flInstallerIsLocalRequest(['REMOTE_ADDR' => '127.0.0.1', $header => $value]),
                "$header marks a forwarded request"
            );
        }
    }
    /**
     * INSTALL_ENABLE=1 on an installed site is how the upgrade is run over the network, and while
     * it is set the wizard answers anyone. A visitor must not be able to replace the site's .env
     * (and so point it at a database of their own) or probe the network through the connection
     * test in that window.
     */
    public function testOverTheNetworkAnInstalledSiteCanOnlyBeInspectedAndUpgraded(): void
    {
        foreach (['run_install', 'test_database', 'anything_else'] as $action) {
            self::assertFalse(\flInstallerActionAllowed($action, true, false), "$action is refused");
        }
        foreach (['check_requirements', 'detect_install', 'run_upgrade'] as $action) {
            self::assertTrue(\flInstallerActionAllowed($action, true, false), "$action is allowed");
        }
        // On the server itself, and before anything is installed, every step is available.
        self::assertTrue(\flInstallerActionAllowed('run_install', true, true));
        self::assertTrue(\flInstallerActionAllowed('run_install', false, false));
        self::assertTrue(\flInstallerActionAllowed('test_database', false, false));
    }

    // ── What the wizard writes ──────────────────────────────────────────────────────────────

    public function testOnlyAnEnvWithARealJwtSecretCountsAsAnInstall(): void
    {
        $dir = $this->scratchDir();
        self::assertFalse(\flEnvIsConfigured($dir . '/.env'), 'no file');
        file_put_contents($dir . '/.env', "DB_HOST=localhost\nJWT_SECRET=\n");
        self::assertFalse(\flEnvIsConfigured($dir . '/.env'), 'the template, never filled in');
        file_put_contents($dir . '/.env', "DB_HOST=localhost\nJWT_SECRET=" . str_repeat('a', 64) . "\n");
        self::assertTrue(\flEnvIsConfigured($dir . '/.env'));
    }
    public function testTheEnvIsWrittenWholeAndForItsOwnerOnly(): void
    {
        $dir = $this->scratchDir();
        $path = $dir . '/.env';
        file_put_contents($path, 'OLD=1');
        self::assertTrue(\flWriteEnvFile($path, "JWT_SECRET=abc\n"));
        self::assertSame("JWT_SECRET=abc\n", file_get_contents($path));
        self::assertSame(['.env'], array_values(array_diff(scandir($dir) ?: [], ['.', '..'])), 'no temporary file is left');
        if (PHP_OS_FAMILY !== 'Windows') {
            self::assertSame(0600, fileperms($path) & 0777);
        }
        // A directory that cannot take the file reports failure and leaves nothing behind.
        self::assertFalse(\flWriteEnvFile($dir . '/missing/.env', 'X=1'));
    }
    public function testTheEnvBeingReplacedIsKeptBesideIt(): void
    {
        $dir = $this->scratchDir();
        $path = $dir . '/.env';
        file_put_contents($path, "AUDIT_HMAC_KEY=the-old-key\n");
        $first = \flBackupEnvFile($path);
        $second = \flBackupEnvFile($path);
        self::assertNotNull($first);
        self::assertNotNull($second);
        self::assertNotSame($first, $second, 'two backups in the same second do not overwrite each other');
        // The web server rules deny ".env" and ".env.*"; a backup must fall under them.
        self::assertMatchesRegularExpression('/^\.env\.backup-\d{8}-\d{6}(-\d+)?$/', $first);
        self::assertSame("AUDIT_HMAC_KEY=the-old-key\n", file_get_contents($dir . '/' . $first));
        self::assertNull(\flBackupEnvFile($dir . '/absent.env'));
    }

    /**
     * A .env with a JWT secret is what marks the site as installed, and the wizard refuses every
     * later request once one exists. It used to be written before the database was tried, so a
     * mistyped password left the wizard locked beside a configuration that could not reach its
     * database: the operator could not run the step again.
     */
    public function testAFailedDatabaseStepLeavesNoEnvSoTheWizardCanBeRunAgain(): void
    {
        $root = $this->installerCopy();
        // Nothing listens on port 1, so the connection is refused at once.
        $result = $this->runInstallIn($root, [
            'db_host' => '127.0.0.1', 'db_port' => '1', 'db_name' => 'formlogic', 'db_user' => 'formlogic', 'db_pass' => 'mistyped',
        ]);

        self::assertFalse($result['success']);
        self::assertContains('error:Database setup', self::steps($result));
        self::assertFileDoesNotExist($root . '/api/.env', 'nothing marks the site as installed');
        self::assertStringContainsString('run the installation again', $result['message']);
    }
    public function testWithNoDatabasePasswordTheEnvIsStillWrittenWithFreshSecrets(): void
    {
        $root = $this->installerCopy();
        // No password and not root: the database step is skipped, as it always was.
        $result = $this->runInstallIn($root, [
            'db_host' => 'db.internal', 'db_port' => '3306', 'db_name' => 'formlogic', 'db_user' => 'formlogic', 'db_pass' => '',
            'cors_origin' => 'https://forms.example.com',
        ]);

        self::assertTrue($result['success'], json_encode($result));
        self::assertContains('skip:Database setup', self::steps($result));
        self::assertContains('ok:Create backend .env', self::steps($result));
        $env = (string) file_get_contents($root . '/api/.env');
        self::assertMatchesRegularExpression('/^JWT_SECRET=[0-9a-f]{64}$/m', $env);
        self::assertMatchesRegularExpression('/^APP_ENV=production$/m', $env);
        self::assertMatchesRegularExpression('/^DB_HOST=db\.internal$/m', $env);
        self::assertMatchesRegularExpression('/^AUDIT_HMAC_KEY=[0-9a-f]{64}$/m', $env);
    }
    /**
     * A copy of .env.example that nobody filled in has no JWT secret and cannot run the site. The
     * wizard used to leave it alone ("already exists") and report success over a configuration
     * that does not boot, with no way to ask for it to be replaced.
     */
    public function testAnEnvThatWasNeverFilledInIsReplacedAndKept(): void
    {
        $root = $this->installerCopy();
        copy($root . '/api/.env.example', $root . '/api/.env');

        $result = $this->runInstallIn($root, ['db_user' => 'formlogic', 'db_pass' => '']);

        self::assertTrue($result['success'], json_encode($result));
        self::assertMatchesRegularExpression(
            '/^JWT_SECRET=[0-9a-f]{64}$/m',
            (string) file_get_contents($root . '/api/.env'),
            'the site has a configuration it can start with'
        );
        $backups = glob($root . '/api/.env.backup-*') ?: [];
        self::assertCount(1, $backups);
        self::assertFileEquals($root . '/api/.env.example', $backups[0]);
    }
    // ── The .env self-test asks this server only ────────────────────────────────────────────

    /**
     * The self-test URL was built from the request's Host header, so whoever could run install or
     * upgrade (upgrade is open to the network while INSTALL_ENABLE=1) could make the server request
     * any address and port and read back whether it answered, and with which status. It now goes
     * to the server's own address and port, with the Host sent only as a header.
     */
    public function testTheEnvSelfTestGoesToThisServersOwnAddressWhateverHostTheRequestNames(): void
    {
        $target = \flEnvProbeTarget([
            'SERVER_ADDR' => '10.0.0.5', 'SERVER_PORT' => '443', 'HTTPS' => 'on',
            'HTTP_HOST' => '169.254.169.254:6379', 'SCRIPT_NAME' => '/my forms/install.php',
        ], 'api');
        self::assertSame('https://10.0.0.5:443/my%20forms/api/.env', $target['url']);
        self::assertSame('169.254.169.254:6379', $target['host'], 'the Host travels as a header only');
        self::assertSame('169.254.169.254', $target['peer']);

        $v6 = \flEnvProbeTarget(['SERVER_ADDR' => '::', 'SERVER_PORT' => '8443', 'HTTP_HOST' => '[2001:db8::1]', 'SCRIPT_NAME' => '/install.php'], 'backend');
        self::assertSame('http://[::1]:8443/backend/.env', $v6['url'], 'a server on every address is asked on loopback');
        self::assertSame('2001:db8::1', $v6['peer']);
        self::assertSame('http://127.0.0.1:80/api/.env', \flEnvProbeTarget(['SERVER_ADDR' => '0.0.0.0', 'SERVER_PORT' => '80', 'HTTP_HOST' => 'forms.example.com'], 'api')['url']);
    }

    public function testWithoutItsOwnAddressOrWithAHostThatIsNotAHostTheServerDoesNotTestItself(): void
    {
        $ok = ['SERVER_ADDR' => '127.0.0.1', 'SERVER_PORT' => '80', 'HTTP_HOST' => 'forms.example.com', 'SCRIPT_NAME' => '/install.php'];
        self::assertNotNull(\flEnvProbeTarget($ok, 'api'));
        foreach ([
            ['SERVER_ADDR' => null], ['SERVER_ADDR' => 'forms.example.com'], ['SERVER_PORT' => null], ['SERVER_PORT' => '0'],
            ['HTTP_HOST' => ''], ['HTTP_HOST' => "forms.example.com\r\nX-Injected: 1"], ['HTTP_HOST' => 'a b'],
            ['HTTP_HOST' => 'user@forms.example.com'], ['HTTP_HOST' => 'forms.example.com/x'], ['HTTP_HOST' => ['forms.example.com']],
        ] as $change) {
            self::assertNull(\flEnvProbeTarget(array_merge($ok, $change), 'api'), json_encode($change));
        }
    }

    /** The real request, against a PHP built-in server standing in for the site's web server. */
    public function testTheSelfTestRequestReachesThisServerWithTheHostAsAHeader(): void
    {
        $root = $this->installerCopy();
        file_put_contents($root . '/api/.env', "JWT_SECRET=" . str_repeat('a', 64) . "\nDB_PASSWORD=x\n");
        $docroot = $this->scratchDir();
        $log = $docroot . '/requests.log';
        // Answers 403 for .env unless the mode file says to serve it, and logs what it was asked.
        file_put_contents($docroot . '/router.php', '<?php file_put_contents(' . var_export($log, true)
            . ', $_SERVER["REQUEST_URI"] . " " . ($_SERVER["HTTP_HOST"] ?? "") . "\n", FILE_APPEND);'
            . ' if (is_file(__DIR__ . "/serve")) { echo "JWT_SECRET=leaked\n"; return true; }'
            . ' http_response_code(403); return true;');
        $probe = stream_socket_server('tcp://127.0.0.1:0');
        self::assertNotFalse($probe);
        $port = (int) substr((string) strrchr((string) stream_socket_get_name($probe, false), ':'), 1);
        fclose($probe);
        $server = proc_open([PHP_BINARY, '-S', '127.0.0.1:' . $port, $docroot . '/router.php'], [1 => ['file', $docroot . '/server.out', 'w'], 2 => ['file', $docroot . '/server.out', 'a']], $pipes, $docroot);
        self::assertIsResource($server);
        try {
            for ($i = 0; $i < 100 && @fsockopen('127.0.0.1', $port) === false; $i++) {
                usleep(50000);
            }
            $check = function (string $host) use ($root, $port): array {
                $server = ['SERVER_ADDR' => '127.0.0.1', 'SERVER_PORT' => (string) $port, 'HTTP_HOST' => $host, 'SCRIPT_NAME' => '/install.php'];
                $code = 'define("FORMLOGIC_INSTALL_NO_RUN", true); require $argv[1];'
                    . ' echo json_encode(flCheckEnvExposure(json_decode(base64_decode($argv[2]), true)));';
                $out = \flRunInstallerCommand([PHP_BINARY, '-d', 'xdebug.mode=off', '-r', $code, $root . '/install.php', base64_encode((string) json_encode($server))], $root, 30.0);
                self::assertSame(0, $out['exitCode'], $out['output']);
                return json_decode($out['output'], true);
            };

            // A Host naming another machine: the request still comes here, carrying that Host.
            $denied = $check('169.254.169.254:6379');
            self::assertSame('ok', $denied['status'], json_encode($denied));
            self::assertSame("/api/.env 169.254.169.254:6379\n", file_get_contents($log));

            // And it still tells a .env that is served apart from one that is not.
            touch($docroot . '/serve');
            $served = $check('forms.example.com');
            self::assertSame('warn', $served['status'], json_encode($served));
            self::assertStringContainsString('http://forms.example.com/api/.env is publicly readable', $served['message']);
        } finally {
            proc_terminate($server);
            proc_close($server);
        }
    }

    // ── The database host ──────────────────────────────────────────────────────────────────

    /**
     * The host went into "mysql:host=<host>;port=..." as typed: a ';' added DSN settings of the
     * typer's own (unix_socket, dbname). It is now a host name or an address, with an optional port.
     */
    public function testTheDatabaseHostIsAHostNameOrAnAddressWithAnOptionalPort(): void
    {
        self::assertSame(['host' => 'localhost', 'port' => null], \flParseDbHost('localhost'));
        self::assertSame(['host' => 'db.internal', 'port' => null], \flParseDbHost(' db.internal '));
        self::assertSame(['host' => 'mysql_db', 'port' => null], \flParseDbHost('mysql_db'), 'a Docker service name');
        self::assertSame(['host' => '10.0.0.7', 'port' => '3307'], \flParseDbHost('10.0.0.7:3307'));
        self::assertSame(['host' => '::1', 'port' => null], \flParseDbHost('::1'));
        // PDO reads an IPv6 host without brackets ("[::1]" fails to parse there).
        self::assertSame(['host' => '2001:db8::5', 'port' => '3306'], \flParseDbHost('[2001:db8::5]:3306'));
        foreach ([
            'localhost;unix_socket=/tmp/x.sock', 'db;dbname=mysql', 'db host', 'db/x', '', '[db.internal]',
            'db:0', 'db:70000', 'db:', "db\nDB_PASSWORD=x", '-db', 'a..b', 'user@db',
        ] as $bad) {
            self::assertIsString(\flParseDbHost($bad), var_export($bad, true));
        }
    }

    public function testAHostThatIsNotAHostStopsTheConnectionTestAndTheInstall(): void
    {
        $tested = \testDatabase(['db_host' => 'localhost;unix_socket=/tmp/mysql.sock', 'db_port' => '3306', 'db_name' => 'formlogic']);
        self::assertFalse($tested['success']);
        self::assertStringContainsString('The database host must be a host name or an IP address', $tested['message']);

        $root = $this->installerCopy();
        $result = $this->runInstallIn($root, [
            'db_host' => '127.0.0.1;dbname=mysql', 'db_port' => '3306', 'db_name' => 'formlogic', 'db_user' => 'root', 'db_pass' => 'x',
        ]);
        self::assertFalse($result['success']);
        self::assertContains('error:Validate inputs', self::steps($result));
        self::assertFileDoesNotExist($root . '/api/.env');
    }

    public function testAPortWrittenAfterTheHostIsTheOneUsed(): void
    {
        $root = $this->installerCopy();
        $result = $this->runInstallIn($root, [
            'db_host' => 'db.internal:3307', 'db_port' => '3306', 'db_name' => 'formlogic', 'db_user' => 'formlogic', 'db_pass' => '',
        ]);
        self::assertTrue($result['success'], json_encode($result));
        $env = (string) file_get_contents($root . '/api/.env');
        self::assertMatchesRegularExpression('/^DB_HOST=db\.internal$/m', $env);
        self::assertMatchesRegularExpression('/^DB_PORT=3307$/m', $env);
    }

    public function testAConfiguredEnvIsOnlyReplacedWhenAskedAndThenTheOldOneIsKept(): void
    {
        $root = $this->installerCopy();
        $this->runInstallIn($root, ['db_user' => 'formlogic', 'db_pass' => '']);
        $original = (string) file_get_contents($root . '/api/.env');

        // Run again without asking: the configuration and its secrets stay.
        $again = $this->runInstallIn($root, ['db_user' => 'formlogic', 'db_pass' => '']);
        self::assertContains('skip:Backend .env', self::steps($again));
        self::assertSame($original, file_get_contents($root . '/api/.env'));
        self::assertSame([], glob($root . '/api/.env.backup-*') ?: []);

        // Ask for it: new secrets, and the old file (the audit key the log was signed with) is kept.
        $replaced = $this->runInstallIn($root, ['db_user' => 'formlogic', 'db_pass' => '', 'overwrite_env' => '1']);
        self::assertTrue($replaced['success'], json_encode($replaced));
        self::assertNotSame($original, file_get_contents($root . '/api/.env'));
        $backups = glob($root . '/api/.env.backup-*') ?: [];
        self::assertCount(1, $backups);
        self::assertSame($original, file_get_contents($backups[0]));
    }
}

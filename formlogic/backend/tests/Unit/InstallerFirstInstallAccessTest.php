<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use PHPUnit\Framework\TestCase;

/**
 * Whoever finishes the wizard on a site with nothing installed owns that site. It was open to any
 * request that looked local, and a request looked local when it came from 127.0.0.1 with no
 * forwarding header: behind a tunnel or forwarder on the same machine that adds none, that is
 * every visitor. It was also open to everyone once INSTALL_ENABLE=1 was set.
 *
 * Here the real install.php answers real requests on a site with no .env: from the server's own
 * address, a first install needs nothing more; under any other name it takes the INSTALL_TOKEN.
 */
final class InstallerFirstInstallAccessTest extends TestCase
{
    private const TOKEN = 'a-long-random-secret-of-the-operators-own';

    /** @var array<string, array{process: resource, base: string, root: string}> */
    private static array $sites = [];

    public static function setUpBeforeClass(): void
    {
        if (!extension_loaded('curl')) {
            self::markTestSkipped('The curl extension is needed to ask the wizard over HTTP.');
        }
        self::start('plain', []);
        self::start('enabled', ['INSTALL_ENABLE' => '1']);
        self::start('token', ['INSTALL_TOKEN' => self::TOKEN]);
    }

    public static function tearDownAfterClass(): void
    {
        foreach (self::$sites as $site) {
            proc_terminate($site['process']);
            proc_close($site['process']);
            self::removeTree($site['root']);
        }
        self::$sites = [];
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

    /**
     * The wizard beside an empty api/, as a release zip lays it out before anything is installed,
     * served by PHP's own web server on this machine.
     *
     * @param array<string, string> $environment what `SetEnv` would give the wizard
     */
    private static function start(string $name, array $environment): void
    {
        $root = sys_get_temp_dir() . '/fl-first-install-' . bin2hex(random_bytes(6));
        mkdir($root . '/api/database', 0700, true);
        mkdir($root . '/sessions', 0700, true);
        copy(dirname(__DIR__, 3) . '/install.php', $root . '/install.php');
        copy(dirname(__DIR__, 2) . '/.env.example', $root . '/api/.env.example');

        $probe = stream_socket_server('tcp://127.0.0.1:0');
        $port = (int) substr((string) strrchr((string) stream_socket_get_name($probe, false), ':'), 1);
        fclose($probe);

        $pipes = [];
        $nowhere = PHP_OS_FAMILY === 'Windows' ? 'NUL' : '/dev/null';
        $process = proc_open(
            [PHP_BINARY, '-d', 'variables_order=EGPCS', '-d', 'xdebug.mode=off', '-d', 'session.save_path=' . $root . '/sessions', '-S', "127.0.0.1:{$port}", '-t', $root],
            [1 => ['file', $nowhere, 'a'], 2 => ['file', $nowhere, 'a']],
            $pipes,
            $root,
            ['SystemRoot' => (string) getenv('SystemRoot'), 'PATH' => (string) getenv('PATH'), 'TEMP' => sys_get_temp_dir(), 'TMP' => sys_get_temp_dir()] + $environment
        );
        self::assertIsResource($process, 'the site starts');
        self::$sites[$name] = ['process' => $process, 'base' => "http://127.0.0.1:{$port}", 'root' => $root];
        for ($i = 0; $i < 100; $i++) {
            if (self::ask($name, '/install.php')['status'] !== 0) {
                return;
            }
            usleep(100_000);
        }
        self::fail('the wizard did not come up');
    }

    /**
     * One request, which always arrives from 127.0.0.1: what differs is what it asks for.
     *
     * @param list<string> $headers
     * @param array<string, string>|null $post
     * @return array{status: int, body: string, cookie: string}
     */
    private static function ask(string $site, string $path, array $headers = [], ?array $post = null): array
    {
        $curl = curl_init(self::$sites[$site]['base'] . $path);
        curl_setopt_array($curl, [CURLOPT_RETURNTRANSFER => true, CURLOPT_HEADER => true, CURLOPT_TIMEOUT => 30, CURLOPT_HTTPHEADER => $headers]
            + ($post === null ? [] : [CURLOPT_POST => true, CURLOPT_POSTFIELDS => http_build_query($post)]));
        $reply = (string) curl_exec($curl);
        $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
        $headerSize = (int) curl_getinfo($curl, CURLINFO_HEADER_SIZE);
        curl_close($curl);
        preg_match('/^Set-Cookie: ([^;\r\n]+)/mi', substr($reply, 0, $headerSize), $cookie);
        return ['status' => $status, 'body' => substr($reply, $headerSize), 'cookie' => $cookie[1] ?? ''];
    }

    private static function isTheWizard(array $answer): bool
    {
        return $answer['status'] === 200 && preg_match('/CSRF_TOKEN = "[a-f0-9]{64}"/', $answer['body']) === 1;
    }

    public function testFromTheServersOwnAddressTheWizardOpens(): void
    {
        self::assertTrue(self::isTheWizard(self::ask('plain', '/install.php')), 'http://127.0.0.1:<port>/install.php');
        self::assertTrue(self::isTheWizard(self::ask('plain', '/install.php', ['Host: localhost'])));
        self::assertTrue(self::isTheWizard(self::ask('plain', '/install.php', ['Host: localhost:8080'])));
    }

    public function testUnderTheSitesOwnNameAFirstInstallIsRefusedAndSaysWhatItTakes(): void
    {
        // What a forwarder that adds no header hands on: from 127.0.0.1, for the public name.
        $answer = self::ask('plain', '/install.php', ['Host: forms.example.com']);

        self::assertSame(403, $answer['status']);
        self::assertFalse(self::isTheWizard($answer));
        self::assertStringNotContainsString('CSRF_TOKEN', $answer['body'], 'no session to act with');
        self::assertStringContainsString('SetEnv INSTALL_TOKEN', $answer['body']);
        self::assertStringContainsString('install.php?token=', $answer['body']);
        self::assertStringContainsString('http://localhost/', $answer['body']);
        self::assertStringNotContainsString('INSTALL_ENABLE', $answer['body'], 'which does not open a first install');

        // Nor does it act for them: the steps of an install are refused with the same words.
        $posted = self::ask('plain', '/install.php', ['Host: forms.example.com'], ['action' => 'run_install', 'csrf' => str_repeat('0', 64)]);
        self::assertSame(403, $posted['status']);
        $said = json_decode($posted['body'], true);
        self::assertIsArray($said, $posted['body']);
        self::assertFalse($said['success']);
        self::assertStringContainsString('INSTALL_TOKEN', $said['message']);
        self::assertFileDoesNotExist(self::$sites['plain']['root'] . '/api/.env');
    }

    public function testAForwardedRequestIsRefusedWhateverNameItAsksFor(): void
    {
        self::assertSame(403, self::ask('plain', '/install.php', ['Host: localhost', 'X-Forwarded-For: 198.51.100.7'])['status']);
    }

    public function testInstallEnableDoesNotOpenAFirstInstallToTheNetwork(): void
    {
        $answer = self::ask('enabled', '/install.php', ['Host: forms.example.com']);

        self::assertSame(403, $answer['status']);
        self::assertFalse(self::isTheWizard($answer));
        self::assertStringContainsString('SetEnv INSTALL_TOKEN', $answer['body']);
        self::assertStringContainsString('INSTALL_ENABLE=1 is set, and does not open a first install', $answer['body']);
        // From the server itself it is as it would be without it.
        self::assertTrue(self::isTheWizard(self::ask('enabled', '/install.php')));
    }

    public function testWithTheTokenAFirstInstallIsOpenFromAnywhereAndWithoutItFromNowhere(): void
    {
        $remote = ['Host: forms.example.com'];

        $unproven = self::ask('token', '/install.php', $remote);
        self::assertSame(403, $unproven['status']);
        self::assertStringContainsString('Installer token required', $unproven['body']);
        self::assertSame(403, self::ask('token', '/install.php?token=a-guess', $remote)['status']);
        // A token that is set is asked of the server's own browser too.
        self::assertSame(403, self::ask('token', '/install.php')['status']);

        $proven = self::ask('token', '/install.php?token=' . self::TOKEN, $remote);
        self::assertTrue(self::isTheWizard($proven), $proven['body']);
        self::assertTrue(self::isTheWizard(self::ask('token', '/install.php', [...$remote, 'X-Install-Token: ' . self::TOKEN])));

        // The session that proved it carries on without it; another one does not.
        self::assertNotSame('', $proven['cookie']);
        self::assertTrue(self::isTheWizard(self::ask('token', '/install.php', [...$remote, 'Cookie: ' . $proven['cookie']])));
        self::assertSame(403, self::ask('token', '/install.php', $remote)['status']);
    }
}

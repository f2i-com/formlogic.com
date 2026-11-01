<?php

declare(strict_types=1);

namespace FormLogic\Tests\Integration;

use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AuditService;
use FormLogic\Services\EmailService;
use FormLogic\Services\FormService;
use FormLogic\Support\AfterResponse;
use PDO;
use PHPUnit\Framework\TestCase;

/**
 * A mail server that takes the connection and then says nothing. PHP's socket default is a minute, so
 * a visitor's submit took 61 s and a forgot-password request 60 s for an address with an account and
 * 0.1 s for one without, and the mail was gone with one line in a log. Over real HTTP, through the
 * real front controller, on a php -S that has none of FPM's calls for ending an answer.
 */
final class MailDeliveryTest extends TestCase
{
    private static ?MySQLConnection $mysql = null;
    private static ?PDO $pdo = null;
    /** @var array<string, string> */
    private static array $config = [];
    /** @var resource|null */
    private static $deadServer = null;
    private static int $deadPort = 0;
    /** @var resource|null */
    private static $site = null;
    private static string $base = '';
    private static string $storage = '';
    /** @var resource|null */
    private static $mailServer = null;
    /** @var resource|null */
    private static $healthySite = null;
    private static string $healthyBase = '';

    /** Well under the 5 s one step with the mail server may take. */
    private const QUICK_SECONDS = 2.5;

    public static function setUpBeforeClass(): void
    {
        $root = dirname(__DIR__, 2);
        if (is_file($root . '/.env')) {
            \Dotenv\Dotenv::createImmutable($root)->safeLoad();
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
            $conn->getConnection()->query('SELECT 1');
            $conn->ensureSchemaCurrent(true);
        } catch (\Throwable $e) {
            self::markTestSkipped('No test database available: ' . $e->getMessage());
        }
        self::$mysql = $conn;
        self::$pdo = $conn->getConnection();

        // Never accepted: the system takes the connection and no greeting ever comes.
        self::$deadServer = stream_socket_server('tcp://127.0.0.1:0') ?: null;
        self::$deadPort = (int) substr(strrchr((string) stream_socket_get_name(self::$deadServer, false), ':'), 1);
    }

    public static function tearDownAfterClass(): void
    {
        foreach ([self::$site, self::$healthySite, self::$mailServer] as $process) {
            if (is_resource($process)) {
                proc_terminate($process);
                proc_close($process);
            }
        }
        if (is_resource(self::$deadServer)) {
            fclose(self::$deadServer);
        }
        if (self::$storage !== '') {
            self::removeTree(self::$storage);
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

    /** The real site, on its own port, with the dead mail server as its SMTP host. */
    private static function startSite(): void
    {
        if (self::$site !== null) {
            return;
        }
        [self::$site, self::$base] = self::launchSite(self::$deadPort);
    }

    /** The same site with a mail server that answers. */
    private static function startHealthySite(): void
    {
        if (self::$healthySite !== null) {
            return;
        }
        $pipes = [];
        self::$mailServer = proc_open([PHP_BINARY, dirname(__DIR__) . '/Support/fake-smtp.php'], [1 => ['pipe', 'w']], $pipes) ?: null;
        self::assertIsResource(self::$mailServer, 'the mail server starts');
        $port = (int) fgets($pipes[1]);
        self::assertGreaterThan(0, $port);
        [self::$healthySite, self::$healthyBase] = self::launchSite($port);
    }

    /** @return array{0: resource, 1: string} */
    private static function launchSite(int $smtpPort): array
    {
        $probe = stream_socket_server('tcp://127.0.0.1:0');
        $port = (int) substr(strrchr((string) stream_socket_get_name($probe, false), ':'), 1);
        fclose($probe);
        $base = "http://127.0.0.1:{$port}";

        $backend = dirname(__DIR__, 2);
        if (self::$storage === '') {
            self::$storage = $backend . '/storage/fl-mail-test-' . bin2hex(random_bytes(5));
            mkdir(self::$storage, 0777, true);
        }
        $env = [
            'DB_HOST' => self::$config['host'], 'DB_PORT' => self::$config['port'], 'DB_DATABASE' => self::$config['database'],
            'DB_USERNAME' => self::$config['username'], 'DB_PASSWORD' => self::$config['password'],
            'SystemRoot' => (string) getenv('SystemRoot'), 'PATH' => (string) getenv('PATH'), 'TEMP' => sys_get_temp_dir(), 'TMP' => sys_get_temp_dir(),
            'APP_ENV' => 'development', 'APP_URL' => $base, 'CORS_ORIGIN' => $base, 'CORS_ALLOWED_ORIGINS' => $base,
            'SQLITE_STORAGE_PATH' => 'storage/' . basename(self::$storage), 'PRIVATE_FORMS' => 'false', 'DATA_NODES' => 'false',
            'MAIL_FROM_ADDRESS' => 'noreply@example.com', 'SMTP_HOST' => '127.0.0.1', 'SMTP_PORT' => (string) $smtpPort,
        ];
        $pipes = [];
        $nowhere = PHP_OS_FAMILY === 'Windows' ? 'NUL' : '/dev/null';
        $site = proc_open(
            [PHP_BINARY, '-d', 'variables_order=EGPCS', '-d', 'xdebug.mode=off', '-S', "127.0.0.1:{$port}", '-t', $backend . '/public', dirname($backend) . '/ci/router.php'],
            [1 => ['file', $nowhere, 'a'], 2 => ['file', $nowhere, 'a']],
            $pipes,
            $backend,
            $env
        );
        self::assertIsResource($site, 'the site starts');
        for ($i = 0; $i < 300; $i++) {
            if (@self::post('/api/health', null, $base)['status'] === 200) {
                return [$site, $base];
            }
            usleep(200_000);
        }
        self::fail('the site did not come up');
    }

    /**
     * A forgot-password request on a plain socket: when the server closed it, as someone would
     * measure who was sent the answer's bytes at once and wants to know more.
     */
    private static function secondsToClose(string $base, string $email): float
    {
        $body = (string) json_encode(['email' => $email]);
        $host = substr($base, strlen('http://'));
        $socket = stream_socket_client('tcp://' . $host);
        self::assertIsResource($socket);
        $started = microtime(true);
        fwrite($socket, "POST /api/auth/forgot-password HTTP/1.1\r\nHost: {$host}\r\nOrigin: {$base}\r\nContent-Type: application/json\r\nContent-Length: " . strlen($body) . "\r\n\r\n{$body}");
        stream_get_contents($socket);
        $seconds = microtime(true) - $started;
        fclose($socket);
        return $seconds;
    }

    /** @return array{status:int, seconds:float, body:string} */
    private static function post(string $path, ?array $json, ?string $base = null): array
    {
        $base ??= self::$base;
        $curl = curl_init($base . $path);
        curl_setopt_array($curl, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 30,
            CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Origin: ' . $base],
        ] + ($json === null ? [] : [CURLOPT_POST => true, CURLOPT_POSTFIELDS => (string) json_encode($json)]));
        $started = microtime(true);
        $body = curl_exec($curl);
        $seconds = microtime(true) - $started;
        $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
        curl_close($curl);
        return ['status' => $status, 'seconds' => $seconds, 'body' => (string) $body];
    }

    private function user(string $email): string
    {
        $id = 'u' . bin2hex(random_bytes(10));
        self::$pdo->prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, 'x', 'T')")->execute([$id, $email]);
        return $id;
    }

    private function dropUser(string $id): void
    {
        self::$pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$id]);
    }

    private function failedMailsTo(string $email): int
    {
        $stmt = self::$pdo->prepare("SELECT COUNT(*) FROM audit_log WHERE action = 'mail.failed' AND details LIKE ?");
        $stmt->execute(['%' . $email . '%']);
        return (int) $stmt->fetchColumn();
    }

    private function waitForFailedMail(string $email): void
    {
        for ($i = 0; $i < 150 && $this->failedMailsTo($email) === 0; $i++) {
            usleep(100_000);
        }
    }

    public function testANeverAnsweringMailServerGivesUpInSecondsAndTheMailIsRecorded(): void
    {
        $to = 'dead-' . bin2hex(random_bytes(5)) . '@example.com';
        $saved = [];
        foreach (['MAIL_FROM_ADDRESS' => 'noreply@example.com', 'SMTP_HOST' => '127.0.0.1', 'SMTP_PORT' => (string) self::$deadPort, 'SMTP_ENCRYPTION' => ''] as $key => $value) {
            $saved[$key] = $_ENV[$key] ?? null;
            $_ENV[$key] = $value;
        }
        try {
            $mail = new EmailService(null, null, static fn () => new AuditService(self::$mysql));
            $started = microtime(true);
            $sent = $mail->send($to, 'Lost in the post', '<p>Hello</p>');
            $seconds = microtime(true) - $started;
        } finally {
            foreach ($saved as $key => $value) {
                if ($value === null) {
                    unset($_ENV[$key]);
                } else {
                    $_ENV[$key] = $value;
                }
            }
        }

        self::assertFalse($sent);
        self::assertLessThan(EmailService::SMTP_TIMEOUT_SECONDS + 3, $seconds, 'not the minute PHP waits by default');
        self::assertSame(1, $this->failedMailsTo($to));

        $warning = EmailService::recentFailureWarning(self::$pdo);
        self::assertNotNull($warning, 'Doctor shows it');
        self::assertStringContainsString($to, $warning);
        self::assertStringContainsString('timed out', $warning);
    }

    protected function tearDown(): void
    {
        self::$pdo?->exec("DELETE FROM audit_log WHERE action = 'mail.failed' AND details LIKE '%@example.com%'");
    }

    public function testDoctorSaysSoWhereAServerCannotEndAnAnswer(): void
    {
        self::assertSame(AfterResponse::LIMITATION, AfterResponse::limitation('cgi-fcgi'));
        self::assertSame(AfterResponse::LIMITATION_MOD_PHP, AfterResponse::limitation('apache2handler'));
        self::assertNull(AfterResponse::limitation('fpm-fcgi'));
        self::assertNull(AfterResponse::limitation('cli-server'));
    }

    public function testNobodyWaitsForTheFloorOnTheCommandLine(): void
    {
        $ran = false;
        $started = microtime(true);
        AfterResponse::runWithFloor(static function () use (&$ran): void {
            $ran = true;
        });

        self::assertTrue($ran);
        self::assertLessThan(AfterResponse::FLOOR_SECONDS / 2, microtime(true) - $started);
    }

    /**
     * mod_php and php -S share this: every byte of the answer arrives at once, and the connection
     * closes when PHP exits, after the mail. Before the floor the close came at 0.75 s and 0.04 s.
     */
    public function testTheConnectionClosesAtTheSameTimeForAnAddressWithAnAccountAndOneWithout(): void
    {
        self::startHealthySite();
        self::$pdo->exec('DELETE FROM rate_limits');
        $email = 'closes-' . bin2hex(random_bytes(5)) . '@example.com';
        $userId = $this->user($email);
        try {
            $known = self::secondsToClose(self::$healthyBase, $email);
            $unknown = self::secondsToClose(self::$healthyBase, 'nobody-' . bin2hex(random_bytes(5)) . '@example.com');

            self::assertSame(0, $this->failedMailsTo($email), 'the mail went: this is the healthy server');
            $token = self::$pdo->prepare('SELECT COUNT(*) FROM password_resets WHERE user_id = ?');
            $token->execute([$userId]);
            self::assertSame(1, (int) $token->fetchColumn());
            self::assertGreaterThanOrEqual(AfterResponse::FLOOR_SECONDS - 0.05, $unknown, 'an unknown address is held too');
            self::assertLessThan(0.4, abs($known - $unknown), "closed at {$known} s and {$unknown} s");
        } finally {
            $this->dropUser($userId);
        }
    }

    public function testDoctorCountsTheLastWeekAndNamesTheLatest(): void
    {
        $log = new PDO('sqlite::memory:');
        $log->exec('CREATE TABLE audit_log (action TEXT, details TEXT, created_at TEXT, sequence_number INTEGER)');
        $add = $log->prepare('INSERT INTO audit_log VALUES (?, ?, ?, ?)');

        self::assertNull(EmailService::recentFailureWarning($log), 'nothing to say');

        $add->execute(['mail.failed', '{"to":"old@example.com","error":"long ago"}', gmdate('Y-m-d H:i:s', time() - 8 * 86400), 1]);
        $add->execute(['user.invite', '{"to":"other@example.com"}', gmdate('Y-m-d H:i:s'), 2]);
        self::assertNull(EmailService::recentFailureWarning($log), 'an old failure and another action are not news');

        $add->execute(['mail.failed', '{"to":"first@example.com","error":"refused"}', gmdate('Y-m-d H:i:s', time() - 60), 3]);
        $add->execute(['mail.failed', '{"to":"second@example.com","error":"timed out"}', gmdate('Y-m-d H:i:s', time() - 30), 4]);
        $warning = (string) EmailService::recentFailureWarning($log);
        self::assertStringContainsString('2 email(s) could not be sent', $warning);
        self::assertStringContainsString('second@example.com: timed out', $warning);
    }

    public function testForgotPasswordAnswersAtOnceForAnAddressWithAnAccountAndTheMailFollows(): void
    {
        self::startSite();
        self::$pdo->exec('DELETE FROM rate_limits');
        $email = 'has-account-' . bin2hex(random_bytes(5)) . '@example.com';
        $userId = $this->user($email);
        try {
            $known = self::post('/api/auth/forgot-password', ['email' => $email]);
            $this->waitForFailedMail($email);

            self::assertSame(200, $known['status'], $known['body']);
            self::assertLessThan(self::QUICK_SECONDS, $known['seconds'], 'nothing waits for the mail server');
            self::assertSame(1, $this->failedMailsTo($email), 'and the mail that could not go is on record');
            $token = self::$pdo->prepare('SELECT COUNT(*) FROM password_resets WHERE user_id = ?');
            $token->execute([$userId]);
            self::assertSame(1, (int) $token->fetchColumn(), 'the reset itself was made, after the answer');

            $unknown = self::post('/api/auth/forgot-password', ['email' => 'nobody-' . bin2hex(random_bytes(5)) . '@example.com']);
            self::assertSame($known['status'], $unknown['status']);
            self::assertSame($known['body'], $unknown['body']);
            self::assertLessThan(self::QUICK_SECONDS, $unknown['seconds']);
            // php -S has one worker, and the floor keeps it for what follows that answer.
            self::post('/api/health', null);
        } finally {
            $this->dropUser($userId);
        }
    }

    public function testAVisitorsSubmitAnswersAtOnceAndTheNotificationFollows(): void
    {
        self::startSite();
        self::$pdo->exec('DELETE FROM rate_limits');
        $email = 'owner-' . bin2hex(random_bytes(5)) . '@example.com';
        $userId = $this->user($email);
        $forms = new FormService(self::$mysql, new SQLiteConnection(self::$storage));
        $formId = (string) $forms->createForm([
            'user_id' => $userId,
            'title' => 'Notified',
            'status' => 'published',
            'fields' => [['id' => 'name', 'type' => 'short_text', 'label' => 'Name', 'required' => false, 'order' => 0, 'properties' => []]],
            'settings' => ['notifications' => ['emailNotifications' => true, 'notificationEmail' => $email]],
        ])['id'];
        try {
            $sent = self::post("/api/forms/{$formId}/responses", ['answers' => ['name' => 'Ada'], 'idempotencyKey' => 'k' . bin2hex(random_bytes(6))]);
            $this->waitForFailedMail($email);

            self::assertSame(201, $sent['status'], $sent['body']);
            self::assertLessThan(self::QUICK_SECONDS, $sent['seconds'], 'nothing waits for the mail server');
            self::assertSame(1, $this->failedMailsTo($email), 'and the mail that could not go is on record');
        } finally {
            self::$pdo->prepare('DELETE FROM response_metadata WHERE form_id = ?')->execute([$formId]);
            self::$pdo->prepare('DELETE FROM forms WHERE id = ?')->execute([$formId]);
            $this->dropUser($userId);
        }
    }
}

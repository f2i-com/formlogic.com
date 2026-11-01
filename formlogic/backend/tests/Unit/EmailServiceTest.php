<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Services\EmailService;
use PHPUnit\Framework\TestCase;

/**
 * The PHP mail() path is the one an install with no SMTP_HOST uses, and mail() writes the subject
 * it is given straight into the header. Subjects carry
 * an app's name or a form's title, which their owner chooses.
 */
final class EmailServiceTest extends TestCase
{
    private string $dir = '';

    protected function tearDown(): void
    {
        if ($this->dir !== '' && is_dir($this->dir)) {
            foreach (glob($this->dir . '/*') ?: [] as $file) {
                @unlink($file);
            }
            @rmdir($this->dir);
        }
        $this->dir = '';
    }

    /** What a mail client shows for a Subject header value (RFC 2047 decoding). */
    private static function shown(string $header): string
    {
        // RFC 2047 6.2: white space between two encoded-words is not part of the text.
        $joined = (string) preg_replace('/(\?=)\s+(=\?)/', '$1$2', $header);
        return (string) preg_replace_callback(
            '/=\?UTF-8\?B\?([A-Za-z0-9+\/=]*)\?=/',
            static fn (array $m): string => (string) base64_decode($m[1]),
            $joined
        );
    }

    public function testAnAsciiSubjectIsSentAsItIs(): void
    {
        self::assertSame('Reset your FormLogic password', EmailService::encodeSubject('Reset your FormLogic password'));
        self::assertSame("You're invited to Tom & Jerry", EmailService::encodeSubject("You're invited to Tom & Jerry"));
    }

    /**
     * A header may hold only ASCII (RFC 5322); anything else travels as RFC 2047 encoded-words.
     * Sent raw, "Café" reached the reader as mojibake or had the message refused or marked as
     * spam, depending on the servers in between.
     */
    public function testASubjectThatIsNotAsciiIsSentAsEncodedWords(): void
    {
        $subject = "You're invited to Caf\u{00e9} M\u{00fc}nchen \u{2615}";
        $header = EmailService::encodeSubject($subject);

        self::assertMatchesRegularExpression('/^[\x20-\x7E]+$/', $header, 'only ASCII goes into the header');
        self::assertSame($subject, self::shown($header));
        foreach (explode(' ', $header) as $word) {
            self::assertMatchesRegularExpression('/^=\?UTF-8\?B\?[A-Za-z0-9+\/=]+\?=$/', $word);
            self::assertLessThanOrEqual(75, strlen($word), 'an encoded-word is at most 75 characters');
        }
    }

    public function testALongSubjectIsSplitBetweenCharactersNotInsideOne(): void
    {
        $subject = 'New response: ' . str_repeat("\u{65e5}\u{672c}\u{8a9e}", 30);
        $header = EmailService::encodeSubject($subject);

        self::assertGreaterThan(1, count(explode(' ', $header)));
        self::assertSame($subject, self::shown($header));
    }

    public function testLineBreaksAndControlCharactersNeverReachTheHeader(): void
    {
        $header = EmailService::encodeSubject("Invoice\r\nBcc: victim@example.com\0\t!");
        self::assertSame('Invoice Bcc: victim@example.com !', $header);

        $encoded = EmailService::encodeSubject("Caf\u{00e9}\r\nBcc: victim@example.com");
        self::assertMatchesRegularExpression('/^[\x20-\x7E]+$/', $encoded);
        self::assertSame("Caf\u{00e9} Bcc: victim@example.com", self::shown($encoded));
    }

    /** Text that is itself shaped like an encoded-word must be shown as typed, not decoded. */
    public function testASubjectThatLooksEncodedIsNotLeftForTheReaderToDecode(): void
    {
        $subject = '=?UTF-8?B?UGF5IG5vdw==?= from your bank';
        $header = EmailService::encodeSubject($subject);

        self::assertNotSame($subject, $header);
        self::assertSame($subject, self::shown($header));
    }

    public function testBytesThatAreNotUtf8DoNotBreakTheHeader(): void
    {
        $header = EmailService::encodeSubject("Caf\xe9 news");
        self::assertMatchesRegularExpression('/^[\x20-\x7E]+$/', $header);
        self::assertStringContainsString('news', self::shown($header));
    }

    /** End to end: what mail() hands the mail transfer agent, captured in place of sendmail. */
    public function testTheMessageHandedToTheMailServerCarriesAnEncodedSubject(): void
    {
        $this->dir = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'fl-mail-' . bin2hex(random_bytes(6));
        $capture = $this->dir . DIRECTORY_SEPARATOR . 'capture.php';
        $out = $this->dir . DIRECTORY_SEPARATOR . 'message.txt';
        if (preg_match('/\s/', PHP_BINARY . $capture) === 1 || !function_exists('proc_open')) {
            self::markTestSkipped('Needs proc_open and paths without spaces to stand in for sendmail.');
        }
        mkdir($this->dir, 0700, true);
        file_put_contents($capture, '<?php file_put_contents($argv[1], stream_get_contents(STDIN));');
        file_put_contents($this->dir . DIRECTORY_SEPARATOR . 'send.php', <<<'PHP'
<?php
require $argv[1];
$_ENV['MAIL_FROM_ADDRESS'] = 'noreply@forms.example';
$_ENV['MAIL_FROM_NAME'] = 'FormLogic';
unset($_ENV['SMTP_HOST']);
putenv('MAIL_FROM_ADDRESS');
putenv('MAIL_FROM_NAME');
putenv('SMTP_HOST');
$sent = (new FormLogic\Services\EmailService())->send('someone@example.com', base64_decode($argv[2]), '<p>Hello</p>');
exit($sent ? 0 : 1);
PHP);
        $subject = "You're invited to Caf\u{00e9} \u{2615}";

        $process = proc_open(
            [
                PHP_BINARY, '-d', 'xdebug.mode=off', '-d', 'sendmail_path=' . PHP_BINARY . ' ' . $capture . ' ' . $out,
                $this->dir . DIRECTORY_SEPARATOR . 'send.php', dirname(__DIR__, 2) . '/vendor/autoload.php', base64_encode($subject),
            ],
            [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
            $pipes,
            $this->dir,
            null,
            ['bypass_shell' => true]
        );
        self::assertIsResource($process);
        fclose($pipes[0]);
        $output = stream_get_contents($pipes[1]) . stream_get_contents($pipes[2]);
        self::assertSame(0, proc_close($process), $output);
        self::assertFileExists($out, 'mail() ran the stand-in');

        [$head] = explode("\r\n\r\n", str_replace("\n", "\r\n", str_replace("\r\n", "\n", (string) file_get_contents($out))), 2);
        self::assertMatchesRegularExpression('/^[\x09\x0A\x0D\x20-\x7E]+$/', $head, 'every header line is ASCII');
        self::assertSame(1, preg_match('/^Subject: (.+)$/m', $head, $m));
        self::assertSame($subject, self::shown(trim($m[1])));
        self::assertStringContainsString('To: someone@example.com', $head);
    }
}

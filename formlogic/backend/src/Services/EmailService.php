<?php

declare(strict_types=1);

namespace FormLogic\Services;

use Psr\Log\LoggerInterface;
use Psr\Log\NullLogger;

/**
 * Transactional email sender. Degrades gracefully:
 *   1. SMTP via symfony/mailer when SMTP_HOST is configured.
 *   2. PHP mail() when a from-address is configured and mail() is available.
 *   3. Otherwise logs and no-ops (returns false) — callers must treat email as
 *      best-effort (e.g. invitations also surface a copyable link).
 *
 * send() waits for the mail server, so anything a visitor sets off goes through
 * AfterResponse. A mail that can't be sent goes in the audit log, and Doctor reports it
 * (recentFailureWarning): it isn't retried, because a reset or invitation link would have to be
 * kept in the clear to send it again, and those are stored hashed.
 *
 * Configuration is read from the environment:
 *   MAIL_FROM_ADDRESS, MAIL_FROM_NAME,
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_ENCRYPTION (tls|ssl|'')
 */
class EmailService
{
    /**
     * Limits on mail an account sends to an address it chose: an app's invitations, and a form's
     * new-response notifications (which anyone submitting to the form sets off). Both carry text
     * the account wrote (the app's name, the form's title) and go out from this server's own
     * address, so without a limit any account could send mail in the operator's name to anyone,
     * and get the operator's mail domain blocklisted. The numbers are far above what a real
     * account sends.
     *
     * Per kind: what one account may send in an hour and in a day, and what one address may be
     * sent in a day, whichever accounts send it. A notification to the form owner's own sign-in
     * address is held to the account's limits only (a busy form may send its owner more than
     * recipientDay); an address is held by one account at most (users.email is unique).
     *
     * No window is longer than a day: RateLimiter drops counters older than that.
     */
    public const USER_MAIL_LIMITS = [
        'invitation' => ['accountHour' => 50, 'accountDay' => 200, 'recipientDay' => 5],
        'notification' => ['accountHour' => 200, 'accountDay' => 1000, 'recipientDay' => 100],
    ];

    /** How long one step of an SMTP conversation may take. PHP's default is a minute. */
    public const SMTP_TIMEOUT_SECONDS = 5;

    /** How far back Doctor looks for mail that could not be sent. */
    private const FAILURE_REPORT_DAYS = 7;

    private LoggerInterface $logger;
    private string $fromAddress;
    private string $fromName;
    private string $smtpHost;
    private int $smtpPort;
    private string $smtpUser;
    private string $smtpPassword;
    private string $smtpEncryption;
    /** @var array<string, array{accountHour:int, accountDay:int, recipientDay:int}> */
    private array $userMailLimits;
    /** @var (\Closure(): AuditService)|null */
    private ?\Closure $audit;

    /**
     * @param array<string, array{accountHour:int, accountDay:int, recipientDay:int}>|null $userMailLimits
     *        USER_MAIL_LIMITS unless given (tests give smaller ones)
     * @param (\Closure(): AuditService)|null $audit gives the audit log a failed mail is recorded in
     */
    public function __construct(?LoggerInterface $logger = null, ?array $userMailLimits = null, ?\Closure $audit = null)
    {
        $this->logger = $logger ?? new NullLogger();
        $this->userMailLimits = $userMailLimits ?? self::USER_MAIL_LIMITS;
        $this->audit = $audit;
        $this->fromAddress = self::env('MAIL_FROM_ADDRESS', '');
        $this->fromName = self::env('MAIL_FROM_NAME', 'FormLogic');
        $this->smtpHost = self::env('SMTP_HOST', '');
        $this->smtpPort = (int) (self::env('SMTP_PORT', '587'));
        $this->smtpUser = self::env('SMTP_USER', '');
        $this->smtpPassword = self::env('SMTP_PASSWORD', '');
        $this->smtpEncryption = self::env('SMTP_ENCRYPTION', 'tls');
    }

    /**
     * Read an env var via getenv() OR $_ENV. Dotenv's immutable loader populates
     * $_ENV but not always getenv(), so config read only through getenv() would
     * be silently missed — leaving email permanently "unconfigured".
     */
    private static function env(string $key, string $default): string
    {
        $val = getenv($key);
        if ($val === false || $val === '') {
            $val = $_ENV[$key] ?? $default;
        }
        return (string) ($val !== '' ? $val : $default);
    }

    /**
     * True when at least one delivery path can be used.
     */
    public function isConfigured(): bool
    {
        if ($this->fromAddress === '') {
            return false;
        }
        return $this->smtpHost !== '' || function_exists('mail');
    }

    /**
     * Describe the effective delivery path for diagnostics (Doctor) WITHOUT sending. Surfaces the
     * silent-failure traps: no from-address (link-only), and SMTP configured but symfony/mailer not
     * installed (invitations/password-resets would quietly fall back to mail()).
     *
     * @return array{path:'smtp'|'mail'|'none', configured:bool, warning:?string}
     */
    public function deliveryStatus(): array
    {
        if ($this->fromAddress === '') {
            return ['path' => 'none', 'configured' => false,
                'warning' => 'MAIL_FROM_ADDRESS is not set — invitations and password resets can only show a copyable link, not send email.'];
        }
        if ($this->smtpHost !== '') {
            if (class_exists(\Symfony\Component\Mailer\Mailer::class)) {
                return ['path' => 'smtp', 'configured' => true, 'warning' => null];
            }
            return ['path' => 'mail', 'configured' => true,
                'warning' => 'SMTP_HOST is set but symfony/mailer is NOT installed — email silently falls back to PHP mail(). Release packages include it: on a source checkout run `composer install` in formlogic/backend.'];
        }
        if (function_exists('mail')) {
            return ['path' => 'mail', 'configured' => true,
                'warning' => 'Using PHP mail() (no SMTP configured) — deliverability is unreliable. Configure SMTP_HOST for production.'];
        }
        return ['path' => 'none', 'configured' => false,
            'warning' => 'No SMTP configured and PHP mail() is unavailable — email cannot be sent.'];
    }

    /**
     * What Doctor says about mail that could not be sent lately, or null when there was none.
     * Reads the rows recordFailure writes.
     */
    public static function recentFailureWarning(\PDO $pdo): ?string
    {
        $days = self::FAILURE_REPORT_DAYS;
        $since = gmdate('Y-m-d H:i:s', time() - $days * 86400);
        $count = $pdo->prepare("SELECT COUNT(*) FROM audit_log WHERE action = 'mail.failed' AND created_at >= ?");
        $count->execute([$since]);
        $failed = (int) $count->fetchColumn();
        if ($failed === 0) {
            return null;
        }
        $last = $pdo->prepare("SELECT details, created_at FROM audit_log WHERE action = 'mail.failed' AND created_at >= ? ORDER BY created_at DESC, sequence_number DESC LIMIT 1");
        $last->execute([$since]);
        $row = $last->fetch(\PDO::FETCH_ASSOC);
        $details = is_array($row) ? json_decode((string) $row['details'], true) : null;
        return sprintf(
            '%d email(s) could not be sent in the last %d days and were not retried. The last, %s UTC, to %s: %s',
            $failed,
            $days,
            is_array($row) ? (string) $row['created_at'] : 'unknown time',
            is_array($details) ? (string) ($details['to'] ?? 'unknown') : 'unknown',
            is_array($details) ? (string) ($details['error'] ?? 'no reason recorded') : 'no reason recorded'
        );
    }

    /**
     * Count one mail of $kind ('invitation' or 'notification', see USER_MAIL_LIMITS) that the
     * account $accountId is about to send to $to, and say whether it may go. Returns null when
     * it may. Otherwise it returns why not, and logs it:
     *   - limit: 'recipient_day', 'account_hour' or 'account_day'; or 'unavailable' when the
     *     counters could not be read (the mail is not sent then either);
     *   - retryAfter: seconds until that counter starts again (0 for 'unavailable');
     *   - message: a sentence for the person who set the mail off.
     *
     * Call it only when the mail would really be sent (isConfigured()): a site that sends no
     * mail has nothing to count. Throws only for a kind that has no limits.
     *
     * @return array{limit:string, retryAfter:int, message:string}|null
     */
    public function userMailRefusal(RateLimiter $limiter, string $kind, string $accountId, string $to, bool $toIsAccountOwn = false): ?array
    {
        $limits = $this->userMailLimits[$kind] ?? null;
        if ($limits === null) {
            throw new \InvalidArgumentException("Unknown kind of mail: {$kind}");
        }
        $recipient = strtolower(trim($to));
        $noun = $kind === 'invitation' ? 'invitation emails' : 'new-response emails';
        $checks = [];
        if (!$toIsAccountOwn) {
            $checks[] = ['recipient_day', "user-mail:{$kind}:to:" . self::mailboxKey($recipient), 86400, $limits['recipientDay'],
                "This address has been sent as many {$noun} as it can be today. Try again tomorrow."];
        }
        $checks[] = ['account_hour', "user-mail:{$kind}:account:{$accountId}", 3600, $limits['accountHour'],
            "Your account has sent as many {$noun} as it can this hour."];
        $checks[] = ['account_day', "user-mail:{$kind}:account:{$accountId}", 86400, $limits['accountDay'],
            "Your account has sent as many {$noun} as it can today."];

        // Each counter is raised and then compared (as RateLimitMiddleware does), so two requests
        // at once cannot both pass on the last free place. The address is counted first, so an
        // address that has had its share does not use up the account's.
        foreach ($checks as [$name, $key, $window, $max, $message]) {
            $count = $limiter->hit($key . ':' . $window, $window);
            if ($count === RateLimiter::UNAVAILABLE) {
                $this->logger->error('Email not sent: the mail limit counters are unavailable', ['kind' => $kind, 'account' => $accountId]);
                return ['limit' => 'unavailable', 'retryAfter' => 0, 'message' => 'Email cannot be sent right now. Please try again later.'];
            }
            if ($count > $max) {
                $retryAfter = $limiter->secondsUntilReset($window);
                $this->logger->warning('Email not sent: limit reached', [
                    'kind' => $kind, 'limit' => $name, 'max' => $max, 'account' => $accountId, 'to' => $recipient,
                ]);
                if ($name !== 'recipient_day') {
                    $minutes = max(1, (int) ceil($retryAfter / 60));
                    $message .= $minutes < 120
                        ? " Try again in {$minutes} minute(s)."
                        : ' Try again in ' . (int) ceil($minutes / 60) . ' hour(s).';
                }
                return ['limit' => $name, 'retryAfter' => $retryAfter, 'message' => $message];
            }
        }
        return null;
    }

    /**
     * The mailbox an address reaches, for counting what one address is sent: "name+anything@"
     * reaches "name@" at nearly every provider, and Gmail ignores dots before the '@'. Counted
     * apart, those spellings would each have the whole daily allowance.
     */
    private static function mailboxKey(string $address): string
    {
        $at = strrpos($address, '@');
        if ($at === false) {
            return $address;
        }
        $local = substr($address, 0, $at);
        $domain = substr($address, $at + 1);
        $plus = strpos($local, '+');
        if ($plus !== false && $plus > 0) {
            $local = substr($local, 0, $plus);
        }
        if ($domain === 'gmail.com' || $domain === 'googlemail.com') {
            $local = str_replace('.', '', $local);
            $domain = 'gmail.com';
        }
        return $local . '@' . $domain;
    }

    /**
     * Send a form's new-response notification to the address its owner set (the Notifications
     * tab), within the 'notification' limits of USER_MAIL_LIMITS. $pdo is the site database: it
     * holds the limits' counters and the owner's own sign-in address. Without it nothing is
     * counted, so nothing is sent. Returns whether a delivery path accepted the mail. Never throws.
     *
     * @param array<string, mixed> $form the form as FormService gives it (its userId is the owner)
     */
    public function sendResponseNotification(?\PDO $pdo, array $form, string $to, string $subject, string $htmlBody): bool
    {
        if (!$this->isConfigured() || !filter_var($to, FILTER_VALIDATE_EMAIL)) {
            return $this->send($to, $subject, $htmlBody); // logs why, sends nothing
        }
        if ($pdo === null) {
            $this->logger->warning('Email not sent: no database to count it against the mail limits', ['kind' => 'notification']);
            return false;
        }
        $ownerId = (string) ($form['userId'] ?? '');
        $toIsOwn = false;
        try {
            $stmt = $pdo->prepare('SELECT email FROM users WHERE id = ?');
            $stmt->execute([$ownerId]);
            $ownerEmail = $stmt->fetchColumn();
            $toIsOwn = is_string($ownerEmail) && strtolower(trim($ownerEmail)) === strtolower(trim($to));
        } catch (\Throwable $e) {
            // Not known to be the owner's own: held to the address's limit as well.
        }
        if ($this->userMailRefusal(new RateLimiter($pdo), 'notification', $ownerId, $to, $toIsOwn) !== null) {
            return false;
        }
        return $this->send($to, $subject, $htmlBody);
    }

    /**
     * Send an email. Returns true if a delivery path accepted it, false otherwise.
     * Never throws.
     */
    public function send(string $to, string $subject, string $htmlBody, ?string $textBody = null): bool
    {
        if (!filter_var($to, FILTER_VALIDATE_EMAIL)) {
            $this->logger->warning('Email not sent: invalid recipient', ['to' => $to]);
            return false;
        }
        if (!$this->isConfigured()) {
            $this->logger->info('Email not sent: no email service configured', ['to' => $to, 'subject' => $subject]);
            return false;
        }

        // Preferred path: SMTP via symfony/mailer (only if both installed + configured).
        if ($this->smtpHost !== '' && class_exists(\Symfony\Component\Mailer\Mailer::class)) {
            try {
                return $this->sendViaSymfony($to, $subject, $htmlBody, $textBody);
            } catch (\Throwable $e) {
                $this->logger->error('SMTP email send failed', ['error' => $e->getMessage()]);
                $this->recordFailure($to, $subject, $e->getMessage());
                return false;
            }
        }

        // Fallback: PHP mail().
        try {
            // mail() writes the subject into the header as given, so it is made a header value
            // here: no line break (an app name with a newline and "Bcc:" would add a header),
            // and no raw non-ASCII text (see encodeSubject).
            $safeSubject = self::encodeSubject($subject);
            $headers = [
                'MIME-Version: 1.0',
                'Content-Type: text/html; charset=UTF-8',
                'From: ' . $this->encodeFromHeader(),
            ];
            $ok = @mail($to, $safeSubject, $htmlBody, implode("\r\n", $headers));
            if (!$ok) {
                $this->logger->warning('mail() returned false', ['to' => $to]);
                $this->recordFailure($to, $subject, 'The server\'s mail() refused it');
            }
            return $ok;
        } catch (\Throwable $e) {
            $this->logger->error('mail() send failed', ['error' => $e->getMessage()]);
            $this->recordFailure($to, $subject, $e->getMessage());
            return false;
        }
    }

    /** Puts a mail that was not sent where an operator can see it. Never throws. */
    private function recordFailure(string $to, string $subject, string $error): void
    {
        if ($this->audit === null) {
            return;
        }
        try {
            ($this->audit)()->log('mail.failed', 'email', null, null, null, [
                'to' => $to,
                'subject' => mb_strcut($subject, 0, 200, 'UTF-8'),
                'error' => mb_strcut($error, 0, 300, 'UTF-8'),
            ]);
        } catch (\Throwable $e) {
            $this->logger->error('A failed email could not be recorded', ['error' => $e->getMessage()]);
        }
    }

    private function sendViaSymfony(string $to, string $subject, string $htmlBody, ?string $textBody): bool
    {
        $scheme = $this->smtpEncryption === 'ssl' ? 'smtps' : 'smtp';
        $auth = $this->smtpUser !== '' ? rawurlencode($this->smtpUser) . ':' . rawurlencode($this->smtpPassword) . '@' : '';
        $dsn = sprintf('%s://%s%s:%d', $scheme, $auth, $this->smtpHost, $this->smtpPort);

        $transport = \Symfony\Component\Mailer\Transport::fromDsn($dsn);
        if ($transport instanceof \Symfony\Component\Mailer\Transport\Smtp\SmtpTransport) {
            $stream = $transport->getStream();
            if ($stream instanceof \Symfony\Component\Mailer\Transport\Smtp\Stream\SocketStream) {
                $stream->setTimeout(self::SMTP_TIMEOUT_SECONDS);
            }
        }
        $mailer = new \Symfony\Component\Mailer\Mailer($transport);

        $email = (new \Symfony\Component\Mime\Email())
            ->from(sprintf('%s <%s>', $this->fromName, $this->fromAddress))
            ->to($to)
            ->subject($subject)
            ->html($htmlBody);
        if ($textBody !== null) {
            $email->text($textBody);
        }

        $mailer->send($email);
        return true;
    }

    private function encodeFromHeader(): string
    {
        return sprintf('%s <%s>', self::encodedWords(self::singleLine($this->fromName)), $this->fromAddress);
    }

    /**
     * A subject as the value of a Subject header. A header holds ASCII only (RFC 5322), so a
     * subject with anything else in it (an app called "Café", a form title in Japanese) is sent
     * as RFC 2047 encoded-words; written raw it arrives as mojibake, or the message is refused
     * or marked as spam, depending on the servers it passes. Control characters, line breaks
     * among them, become spaces. Text that is itself shaped like an encoded-word is encoded
     * too, so the reader sees what was typed and not what it would decode to.
     */
    public static function encodeSubject(string $subject): string
    {
        $subject = self::singleLine($subject);
        if (preg_match('/^[\x20-\x7E]*$/', $subject) === 1 && !str_contains($subject, '=?')) {
            return $subject;
        }
        return self::encodedWords($subject);
    }

    /** One line of text: runs of control characters become one space. */
    private static function singleLine(string $text): string
    {
        return trim((string) preg_replace('/[\x00-\x1F\x7F]+/', ' ', $text));
    }

    /**
     * RFC 2047 "B" encoded-words for a line of text, separated by a space (which a reader drops
     * between adjacent encoded-words). Each holds whole characters and at most 45 bytes of
     * them, which keeps it within the 75 characters an encoded-word may have.
     */
    private static function encodedWords(string $text): string
    {
        if (!mb_check_encoding($text, 'UTF-8')) {
            $text = mb_convert_encoding($text, 'UTF-8', 'UTF-8'); // bytes that are not UTF-8 become '?'
        }
        $words = [];
        $chunk = '';
        foreach (mb_str_split($text, 1, 'UTF-8') as $char) {
            if ($chunk !== '' && strlen($chunk) + strlen($char) > 45) {
                $words[] = '=?UTF-8?B?' . base64_encode($chunk) . '?=';
                $chunk = '';
            }
            $chunk .= $char;
        }
        if ($chunk !== '' || $words === []) {
            $words[] = '=?UTF-8?B?' . base64_encode($chunk) . '?=';
        }
        return implode(' ', $words);
    }
}

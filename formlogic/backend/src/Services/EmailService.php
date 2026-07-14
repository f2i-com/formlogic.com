<?php

declare(strict_types=1);

namespace FormLogic\Services;

use Psr\Log\LoggerInterface;
use Psr\Log\NullLogger;

/**
 * Transactional email sender. Degrades gracefully:
 *   1. SMTP via symfony/mailer when it's installed AND SMTP_HOST is configured.
 *   2. PHP mail() when a from-address is configured and mail() is available.
 *   3. Otherwise logs and no-ops (returns false) — callers must treat email as
 *      best-effort (e.g. invitations also surface a copyable link).
 *
 * Configuration is read from the environment:
 *   MAIL_FROM_ADDRESS, MAIL_FROM_NAME,
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_ENCRYPTION (tls|ssl|'')
 */
class EmailService
{
    private LoggerInterface $logger;
    private string $fromAddress;
    private string $fromName;
    private string $smtpHost;
    private int $smtpPort;
    private string $smtpUser;
    private string $smtpPassword;
    private string $smtpEncryption;

    public function __construct(?LoggerInterface $logger = null)
    {
        $this->logger = $logger ?? new NullLogger();
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
                'warning' => 'SMTP_HOST is set but symfony/mailer is NOT installed — email silently falls back to PHP mail(). Run `composer require symfony/mailer` in formlogic/backend to actually use SMTP.'];
        }
        if (function_exists('mail')) {
            return ['path' => 'mail', 'configured' => true,
                'warning' => 'Using PHP mail() (no SMTP configured) — deliverability is unreliable. Configure SMTP_HOST + symfony/mailer for production.'];
        }
        return ['path' => 'none', 'configured' => false,
            'warning' => 'No SMTP configured and PHP mail() is unavailable — email cannot be sent.'];
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
                return false;
            }
        }

        // Fallback: PHP mail().
        try {
            // Strip CR/LF from the subject to prevent header injection via the
            // subject (e.g. an app name containing newlines + "Bcc:").
            $safeSubject = str_replace(["\r", "\n"], '', $subject);
            $headers = [
                'MIME-Version: 1.0',
                'Content-Type: text/html; charset=UTF-8',
                'From: ' . $this->encodeFromHeader(),
            ];
            $ok = @mail($to, $safeSubject, $htmlBody, implode("\r\n", $headers));
            if (!$ok) {
                $this->logger->warning('mail() returned false', ['to' => $to]);
            }
            return $ok;
        } catch (\Throwable $e) {
            $this->logger->error('mail() send failed', ['error' => $e->getMessage()]);
            return false;
        }
    }

    private function sendViaSymfony(string $to, string $subject, string $htmlBody, ?string $textBody): bool
    {
        $scheme = $this->smtpEncryption === 'ssl' ? 'smtps' : 'smtp';
        $auth = $this->smtpUser !== '' ? rawurlencode($this->smtpUser) . ':' . rawurlencode($this->smtpPassword) . '@' : '';
        $dsn = sprintf('%s://%s%s:%d', $scheme, $auth, $this->smtpHost, $this->smtpPort);

        $transport = \Symfony\Component\Mailer\Transport::fromDsn($dsn);
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
        return sprintf('=?UTF-8?B?%s?= <%s>', base64_encode($this->fromName), $this->fromAddress);
    }
}

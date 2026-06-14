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
        $this->fromAddress = (string) (getenv('MAIL_FROM_ADDRESS') ?: '');
        $this->fromName = (string) (getenv('MAIL_FROM_NAME') ?: 'FormLogic');
        $this->smtpHost = (string) (getenv('SMTP_HOST') ?: '');
        $this->smtpPort = (int) (getenv('SMTP_PORT') ?: 587);
        $this->smtpUser = (string) (getenv('SMTP_USER') ?: '');
        $this->smtpPassword = (string) (getenv('SMTP_PASSWORD') ?: '');
        $this->smtpEncryption = (string) (getenv('SMTP_ENCRYPTION') ?: 'tls');
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

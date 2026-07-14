<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * The rate-limit store failed while gating a HIGH-RISK action (login, password
 * reset, MFA verify, credential management). These paths fail CLOSED (audit
 * RATE-001): a storage outage must not open an unlimited brute-force window.
 * Controllers map this to a retryable 503 — the caller did nothing wrong.
 */
class RateLimiterUnavailableException extends \RuntimeException
{
    public function __construct(string $message = 'Sign-in protection is temporarily unavailable — please try again shortly.')
    {
        parent::__construct($message);
    }
}

<?php

declare(strict_types=1);

namespace FormLogic\Support;

/**
 * What a request gets when something fails outside Slim's error handling.
 *
 * Routes are wired with live services, so a database that is down is found while the app is being
 * built, before the error middleware exists. PHP's own answer to that is a 200 page of stack trace
 * where display_errors is on, and an empty 500 where it is off, on every route including health.
 */
final class StartupFailure
{
    private const RETRY_AFTER_SECONDS = 30;

    /** Production answers never carry PHP's own text, whatever php.ini says. */
    public static function install(): void
    {
        ini_set('display_errors', '0');
        set_exception_handler([self::class, 'handle']);
    }

    /** The php.ini setting again, for development. */
    public static function showPhpErrors(): void
    {
        ini_restore('display_errors');
    }

    public static function handle(\Throwable $failure): void
    {
        $previous = $failure->getPrevious();
        error_log(sprintf(
            'FormLogic could not answer a request: %s%s in %s:%d',
            $failure->getMessage(),
            $previous === null ? '' : ' (' . $previous->getMessage() . ')',
            $failure->getFile(),
            $failure->getLine()
        ));

        $answer = self::answerTo($failure);
        if (!headers_sent()) {
            http_response_code($answer['status']);
            header('Content-Type: application/json');
            header('Cache-Control: no-store');
            if ($answer['retryAfter'] !== null) {
                header('Retry-After: ' . $answer['retryAfter']);
            }
        }
        echo json_encode($answer['body']);
    }

    /**
     * @return array{status: int, retryAfter: ?int, body: array<string, mixed>}
     */
    public static function answerTo(\Throwable $failure): array
    {
        if ($failure instanceof \PDOException) {
            return [
                'status' => 503,
                'retryAfter' => self::RETRY_AFTER_SECONDS,
                'body' => [
                    'error' => true,
                    'retryable' => true,
                    'message' => "The site can't reach its database right now. Please try again in a moment.",
                ],
            ];
        }
        return [
            'status' => 500,
            'retryAfter' => null,
            'body' => ['error' => true, 'message' => 'An unexpected error occurred'],
        ];
    }
}

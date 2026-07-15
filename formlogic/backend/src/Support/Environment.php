<?php

declare(strict_types=1);

namespace FormLogic\Support;

/** One deterministic environment contract for web, CLI, Docker and systemd. */
final class Environment
{
    public static function get(string $key, ?string $default = null): ?string
    {
        if (array_key_exists($key, $_ENV) && is_scalar($_ENV[$key])) {
            return (string) $_ENV[$key];
        }
        if (array_key_exists($key, $_SERVER) && is_scalar($_SERVER[$key])) {
            return (string) $_SERVER[$key];
        }
        $value = getenv($key);
        return $value !== false ? (string) $value : $default;
    }

    public static function nonEmpty(string $key, ?string $default = null): ?string
    {
        $value = self::get($key);
        return $value !== null && $value !== '' ? $value : $default;
    }

    /**
     * Compatibility bridge for older runtime classes that still read $_ENV.
     * Values are normalized once with the same precedence as get().
     */
    public static function bootstrap(): void
    {
        foreach ($_SERVER as $key => $value) {
            if (!array_key_exists((string) $key, $_ENV) && is_scalar($value)) {
                $_ENV[(string) $key] = (string) $value;
            }
        }
        $process = getenv();
        if (is_array($process)) {
            foreach ($process as $key => $value) {
                if (!array_key_exists((string) $key, $_ENV)) {
                    $_ENV[(string) $key] = (string) $value;
                }
            }
        }
    }
}

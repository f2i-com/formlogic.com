<?php

declare(strict_types=1);

namespace FormLogic\Support;

/**
 * OBS-702: structured, redacted telemetry for the package/compiler/invocation lanes.
 *
 * The problem this solves: when an install refuses, a flow fails to compile, or a service
 * call errors, the operator sees a typed code in one user's UI and nothing durable anywhere
 * else. These emit one JSON line per notable event so a failure can be diagnosed after the
 * fact — which package, which version, which typed code — without trawling per-user state.
 *
 * REDACTION IS BY CONSTRUCTION, not by discipline: only fields on the allow-list below are
 * emitted, and every value is coerced to a bounded scalar. A caller cannot accidentally log
 * an aggregate's contents, an input payload, a credential, or a free-text user string,
 * because there is no field name for those. That property is what makes it safe to enable
 * everywhere, which is the only way telemetry is ever there when you need it.
 */
final class PackageTelemetry
{
    /**
     * Fields any event may carry. Deliberately all identifiers, versions, counts, and typed
     * codes — nothing that can hold user content or a secret.
     */
    private const ALLOWED_FIELDS = [
        'packageId', 'publisherId', 'version', 'previousVersion', 'installationId',
        'kind', 'source', 'trust', 'planId',
        'nodeCount', 'grantCount', 'dependencyCount',
        'slot', 'definitionId', 'actionId', 'connection', 'provider',
        'flowId', 'nodeId', 'nodeType', 'irDigest',
        'code', 'outcome', 'durationMs', 'count',
    ];

    private const MAX_VALUE_LEN = 200;

    /** @var callable(string):void */
    private static $sink = null;

    /** Redirect the sink (tests). Pass null to restore the default error_log destination. */
    public static function setSink(?callable $sink): void
    {
        self::$sink = $sink;
    }

    /**
     * Emit one event. `$event` is a dotted lane name ('package.install', 'flow.compile', …).
     *
     * @param array<string,mixed> $fields
     */
    public static function emit(string $event, array $fields): void
    {
        $safe = ['event' => self::scalar($event)];
        foreach (self::ALLOWED_FIELDS as $name) {
            if (!array_key_exists($name, $fields) || $fields[$name] === null) {
                continue;
            }
            $safe[$name] = self::scalar($fields[$name]);
        }
        $line = 'formlogic.telemetry ' . json_encode($safe, JSON_UNESCAPED_SLASHES);
        $sink = self::$sink;
        if ($sink !== null) {
            $sink($line);
            return;
        }
        error_log($line);
    }

    /** Coerce any value to a bounded scalar — arrays/objects never reach the output. */
    private static function scalar(mixed $value): string|int|float|bool
    {
        if (is_bool($value) || is_int($value) || is_float($value)) {
            return $value;
        }
        if (is_array($value)) {
            return count($value); // a list's SIZE is diagnostic; its contents are not ours to log
        }
        if (!is_string($value)) {
            $value = get_debug_type($value);
        }
        return strlen($value) > self::MAX_VALUE_LEN ? substr($value, 0, self::MAX_VALUE_LEN) . '…' : $value;
    }
}

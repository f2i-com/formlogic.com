<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Lang\FormLogicEngine;
use FormLogic\Lang\ExecutionLimitException;
use FormLogic\Lang\Objects\{
    BaseObject, HashObject, StringObject, IntegerObject, FloatObject,
    BooleanObject, NullObject, ArrayObject, BuiltinObject
};
use function FormLogic\Lang\Objects\{nullObject, trueObject, falseObject, getValue, nativeToObject};

/**
 * Sandboxed runtime for executing FormLogic scripts on form submissions
 *
 * Scripts must define an `onSubmit(ctx)` function that receives:
 * - ctx.answers: Read-only form answers (HashObject)
 * - ctx.meta: Submission metadata { ip, userAgent, timestamp, responseId, formId }
 * - ctx.db: Database operations { setField, setStatus, addTag, getField }
 * - ctx.utils: Utility functions { uuid, now, nowMs, hash, formatDate }
 *
 * Scripts can return:
 * - { reject: true, message: 'reason' } to reject the submission
 * - Any other value as computed result
 */
class FormLogicRuntime
{
    private int $maxInstructions;
    private int $maxWallTimeMs;
    private int $maxCallDepth;

    public function __construct(array $config = [])
    {
        $this->maxInstructions = $config['maxInstructions'] ?? 50000;
        $this->maxWallTimeMs = $config['maxWallTimeMs'] ?? 2000;
        $this->maxCallDepth = $config['maxCallDepth'] ?? 100;
    }

    /**
     * Execute a script with the given context
     *
     * @param string $script User-provided FormLogic script
     * @param array $context Execution context with keys: answers, ipAddress, userAgent, timestamp, responseId, formId
     * @return ScriptResult
     */
    public function execute(string $script, array $context): ScriptResult
    {
        $startTime = microtime(true);

        // Create a fresh engine instance
        $engine = new FormLogicEngine();
        $engine->setLimits($this->maxInstructions, $this->maxWallTimeMs, $this->maxCallDepth);

        // Create the database context capture
        $dbCapture = new DbContextCapture();

        // Register the ctx.db module
        $this->registerDbModule($engine, $dbCapture);

        // Register the ctx.utils module
        $this->registerUtilsModule($engine);

        try {
            // Build the execution wrapper code
            $wrapperCode = $this->buildWrapperCode($script, $context);

            // Execute the script
            $result = $engine->run($wrapperCode);
            $nativeResult = getValue($result);

            $instructionCount = $engine->getInstructionCount();
            $executionTimeMs = (int)((microtime(true) - $startTime) * 1000);

            // Check for rejection
            if (is_array($nativeResult) && ($nativeResult['reject'] ?? false) === true) {
                $message = $nativeResult['message'] ?? 'Submission rejected';
                return ScriptResult::rejection($message, $instructionCount, $executionTimeMs);
            }

            // Build successful result
            return ScriptResult::success(
                computed: $nativeResult,
                fields: $dbCapture->getFields(),
                tags: $dbCapture->getTags(),
                status: $dbCapture->getStatus(),
                instructionCount: $instructionCount,
                executionTimeMs: $executionTimeMs,
            );

        } catch (ExecutionLimitException $e) {
            $executionTimeMs = (int)((microtime(true) - $startTime) * 1000);
            return ScriptResult::error(
                "Script execution limit exceeded: {$e->getMessage()}",
                $engine->getInstructionCount(),
                $executionTimeMs,
            );

        } catch (\Throwable $e) {
            $executionTimeMs = (int)((microtime(true) - $startTime) * 1000);
            return ScriptResult::error(
                "Script execution error: {$e->getMessage()}",
                $engine->getInstructionCount(),
                $executionTimeMs,
            );
        }
    }

    /**
     * Register the ctx.db module for database operations
     */
    private function registerDbModule(FormLogicEngine $engine, DbContextCapture $capture): void
    {
        $engine->registerModule('__db', [
            'setField' => function (array $args) use ($capture): BaseObject {
                if (count($args) < 2) {
                    return falseObject();
                }
                $name = getValue($args[0]);
                $value = getValue($args[1]);
                if (!is_string($name)) {
                    return falseObject();
                }
                return $capture->setField($name, $value) ? trueObject() : falseObject();
            },
            'getField' => function (array $args) use ($capture): BaseObject {
                if (count($args) < 1) {
                    return nullObject();
                }
                $name = getValue($args[0]);
                if (!is_string($name)) {
                    return nullObject();
                }
                $value = $capture->getField($name);
                return $value !== null ? nativeToObject($value) : nullObject();
            },
            'setStatus' => function (array $args) use ($capture): BaseObject {
                if (count($args) < 1) {
                    return falseObject();
                }
                $status = getValue($args[0]);
                if (!is_string($status)) {
                    return falseObject();
                }
                return $capture->setStatus($status) ? trueObject() : falseObject();
            },
            'addTag' => function (array $args) use ($capture): BaseObject {
                if (count($args) < 1) {
                    return falseObject();
                }
                $tag = getValue($args[0]);
                if (!is_string($tag)) {
                    return falseObject();
                }
                return $capture->addTag($tag) ? trueObject() : falseObject();
            },
        ]);
    }

    /**
     * Register the ctx.utils module for utility functions
     */
    private function registerUtilsModule(FormLogicEngine $engine): void
    {
        $engine->registerModule('__utils', [
            'uuid' => function (array $args): BaseObject {
                return new StringObject($this->generateUuid());
            },
            'now' => function (array $args): BaseObject {
                return new IntegerObject(time());
            },
            'nowMs' => function (array $args): BaseObject {
                return new IntegerObject((int)(microtime(true) * 1000));
            },
            'hash' => function (array $args): BaseObject {
                if (count($args) < 1) {
                    return new StringObject('');
                }
                $value = getValue($args[0]);
                $algo = count($args) >= 2 ? getValue($args[1]) : 'sha256';
                if (!is_string($algo) || !in_array($algo, ['md5', 'sha1', 'sha256', 'sha512'], true)) {
                    $algo = 'sha256';
                }
                return new StringObject(hash($algo, (string)$value));
            },
            'formatDate' => function (array $args): BaseObject {
                if (count($args) < 1) {
                    return new StringObject('');
                }
                $timestamp = getValue($args[0]);
                $format = count($args) >= 2 ? getValue($args[1]) : 'Y-m-d H:i:s';
                if (!is_numeric($timestamp)) {
                    return new StringObject('');
                }
                // Handle milliseconds
                if ($timestamp > 10000000000) {
                    $timestamp = (int)($timestamp / 1000);
                }
                return new StringObject(date((string)$format, (int)$timestamp));
            },
        ]);
    }

    /**
     * Build the wrapper code that sets up context and calls onSubmit
     */
    private function buildWrapperCode(string $script, array $context): string
    {
        // Build the answers object
        $answers = $context['answers'] ?? [];
        $answersCode = $this->phpValueToFormLogicCode($answers);

        // Build the meta object
        $meta = [
            'ip' => $context['ipAddress'] ?? null,
            'userAgent' => $context['userAgent'] ?? null,
            'timestamp' => $context['timestamp'] ?? time(),
            'responseId' => $context['responseId'] ?? null,
            'formId' => $context['formId'] ?? null,
        ];
        $metaCode = $this->phpValueToFormLogicCode($meta);

        // Create the wrapper code
        // This creates a ctx object with answers, meta, db, and utils
        // Then it includes the user script and calls onSubmit(ctx)
        // Note: We assign modules directly instead of wrapping them in closures
        // to avoid issues with method call context being prepended to arguments
        return <<<FORMLOGIC
// Create the context object
let ctx = {
    answers: {$answersCode},
    meta: {$metaCode},
    db: __db,
    utils: __utils,
};

// User script starts here
{$script}
// User script ends here

// Call the onSubmit function if it exists
typeof onSubmit === "function" ? onSubmit(ctx) : null
FORMLOGIC;
    }

    /**
     * Convert a PHP value to FormLogic code
     */
    private function phpValueToFormLogicCode(mixed $value): string
    {
        if ($value === null) {
            return 'null';
        }
        if (is_bool($value)) {
            return $value ? 'true' : 'false';
        }
        if (is_int($value) || is_float($value)) {
            return (string)$value;
        }
        if (is_string($value)) {
            // Escape string safely
            $escaped = json_encode($value, JSON_UNESCAPED_UNICODE);
            return $escaped !== false ? $escaped : '""';
        }
        if (is_array($value)) {
            if (array_is_list($value)) {
                // Indexed array
                $items = array_map(fn($v) => $this->phpValueToFormLogicCode($v), $value);
                return '[' . implode(', ', $items) . ']';
            } else {
                // Associative array (object)
                $pairs = [];
                foreach ($value as $k => $v) {
                    $keyStr = json_encode((string)$k, JSON_UNESCAPED_UNICODE);
                    if ($keyStr === false) {
                        $keyStr = '""';
                    }
                    $pairs[] = $keyStr . ': ' . $this->phpValueToFormLogicCode($v);
                }
                return '{' . implode(', ', $pairs) . '}';
            }
        }
        return 'null';
    }

    /**
     * Generate a UUID v4
     */
    private function generateUuid(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}

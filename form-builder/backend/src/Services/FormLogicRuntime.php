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
 * - ctx.http: HTTP requests { get, post, put, delete, request }
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
    private int $httpRequestCount = 0;
    private float $httpDeadline = 0.0;
    private const MAX_HTTP_REQUESTS = 10;
    private const MAX_RESPONSE_SIZE = 1 * 1024 * 1024; // 1MB

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
        $this->httpRequestCount = 0; // Reset per execution
        // Shared wall-clock budget for native ctx.http calls this execution. cURL
        // runs OUTSIDE the VM's time limit, so without this a script pointing at a
        // tarpit could block a PHP worker for minutes (DoS). Clamp to [3s, 10s].
        $this->httpDeadline = $startTime + min(max($this->maxWallTimeMs / 1000, 3.0), 10.0);

        // Create a fresh engine instance
        $engine = new FormLogicEngine();
        $engine->setLimits($this->maxInstructions, $this->maxWallTimeMs, $this->maxCallDepth);

        // Create the database context capture
        $dbCapture = new DbContextCapture();

        // Register the ctx.db module
        $this->registerDbModule($engine, $dbCapture);

        // Register the ctx.utils module
        $this->registerUtilsModule($engine);

        // Register the ctx.http module
        $this->registerHttpModule($engine);

        // Register compliance, finance, and safety modules
        $this->registerComplianceModule($engine);
        $this->registerFinanceModule($engine);
        $this->registerSafetyModule($engine);

        try {
            // Validate script safety before execution
            $this->validateScriptSafety($script);

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
                // Truncate to prevent oversized rejection messages
                if (strlen($message) > 500) {
                    $message = substr($message, 0, 500);
                }
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
            // Sanitize error message: strip file paths and internal details
            $safeMessage = preg_replace('/\s*in\s+\/[^\s]+/', '', $e->getMessage());
            $safeMessage = preg_replace('/\s*in\s+[A-Z]:\\\\[^\s]+/i', '', $safeMessage);
            $safeMessage = preg_replace('/\s*on line \d+/', '', $safeMessage);
            return ScriptResult::error(
                "Script execution error: {$safeMessage}",
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
     * Register the ctx.http module for HTTP requests
     *
     * Provides methods for making HTTP requests to external APIs:
     * - get(url, options?) - GET request
     * - post(url, data?, options?) - POST request
     * - put(url, data?, options?) - PUT request
     * - delete(url, options?) - DELETE request
     * - request(options) - Generic request with full control
     *
     * Options object can include:
     * - headers: object of header key-value pairs
     * - bearerToken: string for Bearer authentication
     * - timeout: request timeout in seconds (default 10, max 30)
     * - body: request body (for request method)
     * - method: HTTP method (for request method)
     * - url: request URL (for request method)
     */
    private function registerHttpModule(FormLogicEngine $engine): void
    {
        $engine->registerModule('__http', [
            'get' => function (array $args): BaseObject {
                if (count($args) < 1) {
                    return $this->httpErrorResponse('URL is required');
                }
                $url = getValue($args[0]);
                $options = count($args) >= 2 ? getValue($args[1]) : [];
                if (!is_string($url)) {
                    return $this->httpErrorResponse('URL must be a string');
                }
                return $this->executeHttpRequest('GET', $url, null, is_array($options) ? $options : []);
            },

            'post' => function (array $args): BaseObject {
                if (count($args) < 1) {
                    return $this->httpErrorResponse('URL is required');
                }
                $url = getValue($args[0]);
                $data = count($args) >= 2 ? getValue($args[1]) : null;
                $options = count($args) >= 3 ? getValue($args[2]) : [];
                if (!is_string($url)) {
                    return $this->httpErrorResponse('URL must be a string');
                }
                return $this->executeHttpRequest('POST', $url, $data, is_array($options) ? $options : []);
            },

            'put' => function (array $args): BaseObject {
                if (count($args) < 1) {
                    return $this->httpErrorResponse('URL is required');
                }
                $url = getValue($args[0]);
                $data = count($args) >= 2 ? getValue($args[1]) : null;
                $options = count($args) >= 3 ? getValue($args[2]) : [];
                if (!is_string($url)) {
                    return $this->httpErrorResponse('URL must be a string');
                }
                return $this->executeHttpRequest('PUT', $url, $data, is_array($options) ? $options : []);
            },

            'delete' => function (array $args): BaseObject {
                if (count($args) < 1) {
                    return $this->httpErrorResponse('URL is required');
                }
                $url = getValue($args[0]);
                $options = count($args) >= 2 ? getValue($args[1]) : [];
                if (!is_string($url)) {
                    return $this->httpErrorResponse('URL must be a string');
                }
                return $this->executeHttpRequest('DELETE', $url, null, is_array($options) ? $options : []);
            },

            'patch' => function (array $args): BaseObject {
                if (count($args) < 1) {
                    return $this->httpErrorResponse('URL is required');
                }
                $url = getValue($args[0]);
                $data = count($args) >= 2 ? getValue($args[1]) : null;
                $options = count($args) >= 3 ? getValue($args[2]) : [];
                if (!is_string($url)) {
                    return $this->httpErrorResponse('URL must be a string');
                }
                return $this->executeHttpRequest('PATCH', $url, $data, is_array($options) ? $options : []);
            },

            'request' => function (array $args): BaseObject {
                if (count($args) < 1) {
                    return $this->httpErrorResponse('Options object is required');
                }
                $options = getValue($args[0]);
                if (!is_array($options)) {
                    return $this->httpErrorResponse('Options must be an object');
                }

                $method = strtoupper($options['method'] ?? 'GET');
                $url = $options['url'] ?? null;
                $body = $options['body'] ?? null;

                if (!is_string($url)) {
                    return $this->httpErrorResponse('URL is required');
                }
                if (!in_array($method, ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'], true)) {
                    return $this->httpErrorResponse('Invalid HTTP method');
                }

                return $this->executeHttpRequest($method, $url, $body, $options);
            },
        ]);
    }

    /**
     * Register the compliance module for regulatory checks
     */
    private function registerComplianceModule(FormLogicEngine $engine): void
    {
        $engine->registerModule('compliance', [
            'regBICheck' => function (array $args): BaseObject {
                if (count($args) < 2) return falseObject();
                $riskScore = getValue($args[0]);
                $portfolioType = getValue($args[1]);
                if (!is_numeric($riskScore) || !is_string($portfolioType)) return falseObject();
                $score = (float) $riskScore;
                $ranges = [
                    'conservative' => [0, 30],
                    'moderate' => [20, 60],
                    'aggressive' => [50, 85],
                    'speculative' => [75, 100],
                ];
                $range = $ranges[strtolower($portfolioType)] ?? null;
                if ($range === null) return falseObject();
                return ($score >= $range[0] && $score <= $range[1]) ? trueObject() : falseObject();
            },

            'suitabilityScore' => function (array $args): BaseObject {
                if (count($args) < 5) return new IntegerObject(0);
                $age = getValue($args[0]);
                $income = getValue($args[1]);
                $netWorth = getValue($args[2]);
                $riskTolerance = getValue($args[3]);
                $timeHorizon = getValue($args[4]);
                if (!is_numeric($age) || !is_numeric($income) || !is_numeric($netWorth)
                    || !is_numeric($riskTolerance) || !is_numeric($timeHorizon)) {
                    return new IntegerObject(0);
                }
                $ageScore = max(0, min(100, 100 - (float) $age));
                $incomeScore = max(0, min(100, ((float) $income / 500000) * 100));
                $nwScore = max(0, min(100, ((float) $netWorth / 5000000) * 100));
                $tolScore = max(0, min(100, (float) $riskTolerance * 10));
                $horizonScore = max(0, min(100, (float) $timeHorizon * 3.33));
                $weighted = $ageScore * 0.20 + $incomeScore * 0.15 + $nwScore * 0.20
                          + $tolScore * 0.25 + $horizonScore * 0.20;
                return new IntegerObject((int) round(max(1, min(100, $weighted))));
            },

            'amlFlag' => function (array $args): BaseObject {
                if (count($args) < 1) return falseObject();
                $amount = getValue($args[0]);
                $frequency = count($args) >= 2 ? getValue($args[1]) : 0;
                if (!is_numeric($amount)) return falseObject();
                $amt = (float) $amount;
                $freq = is_numeric($frequency) ? (float) $frequency : 0;
                if ($amt >= 10000) return trueObject();
                if ($amt >= 8000 && $amt < 10000 && $freq > 3) return trueObject();
                if ($freq > 50) return trueObject();
                if ($amt * $freq > 100000) return trueObject();
                return falseObject();
            },

            'kycComplete' => function (array $args): BaseObject {
                if (empty($args)) return falseObject();
                foreach ($args as $arg) {
                    $val = getValue($arg);
                    if ($val === null || $val === '') return falseObject();
                    if (is_string($val) && trim($val) === '') return falseObject();
                }
                return trueObject();
            },

            'nigoCheck' => function (array $args): BaseObject {
                $missing = [];
                foreach ($args as $i => $arg) {
                    $val = getValue($arg);
                    if ($val === null || $val === '' || (is_string($val) && trim($val) === '')) {
                        $missing[] = $i + 1;
                    }
                }
                return new StringObject(implode(',', $missing));
            },

            'accreditedInvestor' => function (array $args): BaseObject {
                if (count($args) < 2) return falseObject();
                $income = getValue($args[0]);
                $netWorth = getValue($args[1]);
                if (!is_numeric($income) || !is_numeric($netWorth)) return falseObject();
                if ((float) $income > 200000 || (float) $netWorth > 1000000) return trueObject();
                return falseObject();
            },

            // Australian wholesale client — Corporations Act s761G
            // Gross income >= $250,000 OR net assets >= $2,500,000
            'wholesaleClient' => function (array $args): BaseObject {
                if (count($args) < 2) return falseObject();
                $income = getValue($args[0]);
                $netAssets = getValue($args[1]);
                if (!is_numeric($income) || !is_numeric($netAssets)) return falseObject();
                if ((float) $income >= 250000 || (float) $netAssets >= 2500000) return trueObject();
                return falseObject();
            },

            // AUSTRAC Threshold Transaction Report flag
            // Single >= AUD $10,000, structuring ($8k-$10k + freq>3),
            // high volume (>50/month), high aggregate (>$100k)
            'austracFlag' => function (array $args): BaseObject {
                if (count($args) < 1) return falseObject();
                $amount = getValue($args[0]);
                $frequency = count($args) >= 2 ? getValue($args[1]) : 0;
                if (!is_numeric($amount)) return falseObject();
                $amt = (float) $amount;
                $freq = is_numeric($frequency) ? (float) $frequency : 0;
                if ($amt >= 10000) return trueObject();
                if ($amt >= 8000 && $amt < 10000 && $freq > 3) return trueObject();
                if ($freq > 50) return trueObject();
                if ($amt * $freq > 100000) return trueObject();
                return falseObject();
            },

            // Australian TFN validation — 9-digit format
            'tfnValid' => function (array $args): BaseObject {
                if (count($args) < 1) return falseObject();
                $tfn = getValue($args[0]);
                if (!is_string($tfn)) return falseObject();
                return preg_match('/^\d{3}-?\d{3}-?\d{3}$/', trim($tfn)) ? trueObject() : falseObject();
            },
        ]);
    }

    /**
     * Register the finance module for financial calculations
     */
    private function registerFinanceModule(FormLogicEngine $engine): void
    {
        $engine->registerModule('finance', [
            'compoundInterest' => function (array $args): BaseObject {
                if (count($args) < 3) return new FloatObject(0.0);
                $principal = getValue($args[0]);
                $rate = getValue($args[1]);
                $periods = getValue($args[2]);
                if (!is_numeric($principal) || !is_numeric($rate) || !is_numeric($periods)) {
                    return new FloatObject(0.0);
                }
                $result = (float) $principal * pow(1 + (float) $rate, (float) $periods);
                return new FloatObject(round($result, 2));
            },

            'aumFee' => function (array $args): BaseObject {
                if (count($args) < 1) return new FloatObject(0.0);
                $assets = getValue($args[0]);
                if (!is_numeric($assets) || (float) $assets <= 0) return new FloatObject(0.0);
                $amt = (float) $assets;

                $tiers = [
                    [1000000, 0.01],
                    [5000000, 0.0075],
                    [10000000, 0.005],
                    [PHP_FLOAT_MAX, 0.0035],
                ];

                if (count($args) >= 2) {
                    $tiersJson = getValue($args[1]);
                    if (is_string($tiersJson)) {
                        $parsed = json_decode($tiersJson, true);
                        if (is_array($parsed) && !empty($parsed)) {
                            $tiers = $parsed;
                            // Ensure tiers are sorted by ceiling ascending
                            usort($tiers, fn($a, $b) => ($a[0] ?? 0) <=> ($b[0] ?? 0));
                        }
                    }
                }

                $remaining = $amt;
                $totalFee = 0.0;
                $prevCeiling = 0;
                foreach ($tiers as [$ceiling, $rate]) {
                    $tierAmount = min($remaining, $ceiling - $prevCeiling);
                    if ($tierAmount <= 0) break;
                    $totalFee += $tierAmount * $rate;
                    $remaining -= $tierAmount;
                    $prevCeiling = $ceiling;
                    if ($remaining <= 0) break;
                }
                return new FloatObject(round($totalFee, 2));
            },

            'riskScore' => function (array $args): BaseObject {
                if (count($args) < 3) return new IntegerObject(0);
                $age = getValue($args[0]);
                $timeHorizon = getValue($args[1]);
                $riskTolerance = getValue($args[2]);
                if (!is_numeric($age) || !is_numeric($timeHorizon) || !is_numeric($riskTolerance)) {
                    return new IntegerObject(0);
                }
                $ageScore = max(0, min(100, 100 - (float) $age));
                $horizonScore = max(0, min(100, (float) $timeHorizon * 3.33));
                $tolScore = max(0, min(100, (float) $riskTolerance * 10));
                $weighted = $ageScore * 0.30 + $horizonScore * 0.30 + $tolScore * 0.40;
                return new IntegerObject((int) round(max(1, min(100, $weighted))));
            },

            'portfolioAllocation' => function (array $args): BaseObject {
                if (count($args) < 1) return new StringObject('20:50:30');
                $riskScore = getValue($args[0]);
                if (!is_numeric($riskScore)) return new StringObject('20:50:30');
                $score = max(1, min(100, (float) $riskScore));
                $t = ($score - 1) / 99;
                $equity = (int) round(20 + $t * 70);
                $bond = (int) round(50 - $t * 42);
                $cash = 100 - $equity - $bond;
                // Clamp cash to prevent negative values from independent rounding
                if ($cash < 0) {
                    $bond += $cash;
                    $cash = 0;
                }
                return new StringObject("{$equity}:{$bond}:{$cash}");
            },

            // ACAT transfer fee by custodian (US)
            // Schwab=$50, Fidelity=$0, Vanguard=$100, E*TRADE=$75, others=$75
            'transferFee' => function (array $args): BaseObject {
                if (count($args) < 1) return new FloatObject(0.0);
                $amount = getValue($args[0]);
                if (!is_numeric($amount)) return new FloatObject(0.0);
                $amt = (float) $amount;

                // Waive fee for small transfers
                if ($amt < 500) return new FloatObject(0.0);

                $custodian = count($args) >= 2 ? getValue($args[1]) : null;
                $feeSchedule = [
                    'schwab' => 50.0,
                    'fidelity' => 0.0,
                    'vanguard' => 100.0,
                    'etrade' => 75.0,
                    'pershing' => 75.0,
                    'lpl' => 75.0,
                ];
                if (is_string($custodian)) {
                    $key = strtolower($custodian);
                    if (isset($feeSchedule[$key])) {
                        return new FloatObject($feeSchedule[$key]);
                    }
                }
                return new FloatObject(75.0);
            },

            // Australian tiered AUM fee (GST inclusive)
            // 1.1% first $500k, 0.88% $500k-$2M, 0.66% $2M-$5M, 0.44% above $5M
            'auAumFee' => function (array $args): BaseObject {
                if (count($args) < 1) return new FloatObject(0.0);
                $assets = getValue($args[0]);
                if (!is_numeric($assets) || (float) $assets <= 0) return new FloatObject(0.0);
                $amt = (float) $assets;

                $tiers = [
                    [500000, 0.011],
                    [2000000, 0.0088],
                    [5000000, 0.0066],
                    [PHP_FLOAT_MAX, 0.0044],
                ];

                if (count($args) >= 2) {
                    $tiersJson = getValue($args[1]);
                    if (is_string($tiersJson)) {
                        $parsed = json_decode($tiersJson, true);
                        if (is_array($parsed) && !empty($parsed)) {
                            $tiers = $parsed;
                            usort($tiers, fn($a, $b) => ($a[0] ?? 0) <=> ($b[0] ?? 0));
                        }
                    }
                }

                $remaining = $amt;
                $totalFee = 0.0;
                $prevCeiling = 0;
                foreach ($tiers as [$ceiling, $rate]) {
                    $tierAmount = min($remaining, $ceiling - $prevCeiling);
                    if ($tierAmount <= 0) break;
                    $totalFee += $tierAmount * $rate;
                    $remaining -= $tierAmount;
                    $prevCeiling = $ceiling;
                    if ($remaining <= 0) break;
                }
                return new FloatObject(round($totalFee, 2));
            },

            // Australian off-market transfer fee by platform
            // Netwealth/HUB24=$0, BT Panorama=$54, Macquarie=$33, CFS=$0, others=$55
            'auTransferFee' => function (array $args): BaseObject {
                if (count($args) < 2) return new FloatObject(0.0);
                $amount = getValue($args[0]);
                $platform = getValue($args[1]);
                if (!is_numeric($amount) || !is_string($platform)) return new FloatObject(0.0);

                $feeSchedule = [
                    'netwealth' => 0.0,
                    'hub24' => 0.0,
                    'bt panorama' => 54.0,
                    'macquarie' => 33.0,
                    'cfs' => 0.0,
                    'cfs firstchoice' => 0.0,
                ];
                $key = strtolower($platform);
                if (isset($feeSchedule[$key])) {
                    return new FloatObject($feeSchedule[$key]);
                }
                return new FloatObject(55.0);
            },
        ]);
    }

    /**
     * Register the safety module for OHS risk assessments
     */
    private function registerSafetyModule(FormLogicEngine $engine): void
    {
        $engine->registerModule('safety', [
            // Risk matrix: likelihood (1-5) x consequence (1-5) = score 1-25
            'riskMatrix' => function (array $args): BaseObject {
                if (count($args) < 2) return new IntegerObject(0);
                $likelihood = getValue($args[0]);
                $consequence = getValue($args[1]);
                if (!is_numeric($likelihood) || !is_numeric($consequence)) return new IntegerObject(0);
                $l = max(1, min(5, (int) round((float) $likelihood)));
                $c = max(1, min(5, (int) round((float) $consequence)));
                return new IntegerObject($l * $c);
            },

            // Risk level label from score (1-25)
            // Critical: 20-25, High: 12-19, Medium: 5-11, Low: 1-4
            'riskLevel' => function (array $args): BaseObject {
                if (count($args) < 1) return new StringObject('Unknown');
                $score = getValue($args[0]);
                if (!is_numeric($score)) return new StringObject('Unknown');
                $s = (int) $score;
                if ($s >= 20) return new StringObject('Critical');
                if ($s >= 12) return new StringObject('High');
                if ($s >= 5) return new StringObject('Medium');
                if ($s >= 1) return new StringObject('Low');
                return new StringObject('Unknown');
            },

            // Control effectiveness rating (hierarchy of controls)
            // elimination=5, substitution=4, engineering=3, administrative=2, ppe=1
            'controlEffectiveness' => function (array $args): BaseObject {
                if (count($args) < 1) return new IntegerObject(0);
                $controlType = getValue($args[0]);
                if (!is_string($controlType)) return new IntegerObject(0);
                $scores = [
                    'elimination' => 5, 'substitution' => 4, 'engineering' => 3,
                    'administrative' => 2, 'ppe' => 1,
                ];
                return new IntegerObject($scores[strtolower($controlType)] ?? 0);
            },

            // Residual risk after control: riskScore * (1 - controlScore/5)
            'residualRisk' => function (array $args): BaseObject {
                if (count($args) < 2) return new IntegerObject(0);
                $riskScore = getValue($args[0]);
                $controlType = getValue($args[1]);
                if (!is_numeric($riskScore) || !is_string($controlType)) return new IntegerObject(0);
                $scores = [
                    'elimination' => 5, 'substitution' => 4, 'engineering' => 3,
                    'administrative' => 2, 'ppe' => 1,
                ];
                $effectiveness = $scores[strtolower($controlType)] ?? 0;
                $residual = (int) round((float) $riskScore * (1 - $effectiveness / 5));
                return new IntegerObject(max(0, $residual));
            },
        ]);
    }

    /**
     * Execute an HTTP request using cURL
     */
    private function executeHttpRequest(string $method, string $url, mixed $body, array $options): BaseObject
    {
        // Enforce per-execution HTTP request limit
        if ($this->httpRequestCount >= self::MAX_HTTP_REQUESTS) {
            return $this->httpErrorResponse('HTTP request limit exceeded (max ' . self::MAX_HTTP_REQUESTS . ' per execution)');
        }
        $this->httpRequestCount++;

        // Validate URL
        if (!filter_var($url, FILTER_VALIDATE_URL)) {
            return $this->httpErrorResponse('Invalid URL format');
        }

        // Parse URL components
        $parsedUrl = parse_url($url);
        $host = $parsedUrl['host'] ?? null;
        $port = $parsedUrl['port'] ?? (($parsedUrl['scheme'] ?? 'https') === 'https' ? 443 : 80);

        if ($host === null) {
            return $this->httpErrorResponse('Invalid URL');
        }

        // Security: Block private IP ranges, localhost, and perform DNS pinning
        $hostCheck = $this->checkHostSecurity($host);
        if ($hostCheck['isPrivate']) {
            return $this->httpErrorResponse('Requests to private/local addresses are not allowed');
        }

        $resolvedIp = $hostCheck['resolvedIp'];

        // Build headers
        $headers = ['Accept: application/json'];
        $contentType = 'application/json';

        // Add custom headers
        if (isset($options['headers']) && is_array($options['headers'])) {
            foreach ($options['headers'] as $key => $value) {
                if (is_string($key) && (is_string($value) || is_numeric($value))) {
                    $key = (string)$key;
                    $value = (string)$value;
                    // Reject header injection via CRLF characters
                    if (preg_match('/[\r\n\x00]/', $key . $value)) {
                        continue;
                    }
                    // Prevent host header override
                    if (strtolower($key) !== 'host') {
                        $headers[] = "{$key}: {$value}";
                        if (strtolower($key) === 'content-type') {
                            $contentType = $value;
                        }
                    }
                }
            }
        }

        // Add Bearer token if provided (only if no Authorization header already set)
        if (isset($options['bearerToken']) && is_string($options['bearerToken']) && !$this->hasHeader($headers, 'authorization')) {
            $token = $options['bearerToken'];
            // Reject CRLF injection in bearer token
            if (!preg_match('/[\r\n\x00]/', $token)) {
                $headers[] = 'Authorization: Bearer ' . $token;
            }
        }

        // Set content type if not already set and we have a body
        if ($body !== null && !$this->hasHeader($headers, 'content-type')) {
            $headers[] = 'Content-Type: ' . $contentType;
        }

        // Prepare body
        $bodyString = null;
        if ($body !== null) {
            if (is_string($body)) {
                $bodyString = $body;
            } else {
                $bodyString = json_encode($body);
            }
        }

        // Timeout: cap to wall-time limit to prevent blocking the PHP worker
        $maxTimeout = max(1, (int)($this->maxWallTimeMs / 1000));
        $timeout = min($maxTimeout, 10);
        if (isset($options['timeout']) && is_numeric($options['timeout'])) {
            $timeout = min($maxTimeout, max(1, (int)$options['timeout']));
        }

        // Bound every cURL call by the REMAINING shared HTTP budget so connect +
        // transfer time (across all requests AND redirects) can never exceed it.
        $remainingMs = (int) (($this->httpDeadline - microtime(true)) * 1000);
        if ($remainingMs <= 0) {
            return $this->httpErrorResponse('HTTP time budget exceeded');
        }
        $callTimeoutMs = min($remainingMs, $timeout * 1000);
        $connectTimeoutMs = min($remainingMs, 3000);

        // Execute request with cURL
        $ch = curl_init();

        $curlOptions = [
            CURLOPT_URL => $url,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => false, // Disable auto-follow to validate redirects
            CURLOPT_MAXREDIRS => 0,
            CURLOPT_TIMEOUT_MS => $callTimeoutMs,
            CURLOPT_CONNECTTIMEOUT_MS => $connectTimeoutMs,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HEADER => true,
            // Security settings
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            // Restrict to HTTP/HTTPS only (prevent gopher://, dict://, file:// etc.)
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS | CURLPROTO_HTTP,
            CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTPS | CURLPROTO_HTTP,
            // Limit response size to prevent memory exhaustion
            CURLOPT_MAXFILESIZE => self::MAX_RESPONSE_SIZE,
        ];

        // DNS pinning: Force cURL to use our pre-resolved IP to prevent DNS rebinding
        if ($resolvedIp !== null) {
            $curlOptions[CURLOPT_RESOLVE] = ["{$host}:{$port}:{$resolvedIp}"];
        }

        curl_setopt_array($ch, $curlOptions);

        if ($bodyString !== null && in_array($method, ['POST', 'PUT', 'PATCH'], true)) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $bodyString);
        }

        $response = curl_exec($ch);
        $error = curl_error($ch);
        $errno = curl_errno($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $headerSize = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
        $redirectUrl = curl_getinfo($ch, CURLINFO_REDIRECT_URL);

        curl_close($ch);

        // Handle cURL errors
        if ($errno !== 0) {
            return $this->httpErrorResponse("HTTP request failed");
        }

        // Handle redirects securely (validate each redirect URL)
        $redirectCount = 0;
        $maxRedirects = 5;
        while ($httpCode >= 300 && $httpCode < 400 && !empty($redirectUrl) && $redirectCount < $maxRedirects) {
            $redirectCount++;

            // Validate redirect URL
            if (!filter_var($redirectUrl, FILTER_VALIDATE_URL)) {
                return $this->httpErrorResponse('Invalid redirect URL');
            }

            // Check redirect host for SSRF
            $redirectParsed = parse_url($redirectUrl);
            $redirectHost = $redirectParsed['host'] ?? null;
            if ($redirectHost === null) {
                return $this->httpErrorResponse('Invalid redirect URL');
            }

            $redirectCheck = $this->checkHostSecurity($redirectHost);
            if ($redirectCheck['isPrivate']) {
                return $this->httpErrorResponse('Redirect to private/local address blocked');
            }

            // Per RFC 7231: convert POST/PUT/PATCH to GET on 301/302 redirects
            // and strip the request body. 307/308 preserve method.
            $redirectOptions = $curlOptions;
            if (in_array($httpCode, [301, 302], true) && in_array($method, ['POST', 'PUT', 'PATCH'], true)) {
                $redirectOptions[CURLOPT_CUSTOMREQUEST] = 'GET';
                unset($redirectOptions[CURLOPT_POSTFIELDS]);
            }

            // Strip Authorization header when redirecting to a different host
            // to prevent credential leakage
            if (strtolower($redirectHost) !== strtolower($host)) {
                $filteredHeaders = array_filter($redirectOptions[CURLOPT_HTTPHEADER], function ($h) {
                    return stripos($h, 'Authorization:') !== 0;
                });
                $redirectOptions[CURLOPT_HTTPHEADER] = array_values($filteredHeaders);
            }

            // Follow the redirect with DNS pinning
            $redirectPort = $redirectParsed['port'] ?? (($redirectParsed['scheme'] ?? 'https') === 'https' ? 443 : 80);
            $ch = curl_init();
            $redirectOptions[CURLOPT_URL] = $redirectUrl;
            if ($redirectCheck['resolvedIp'] !== null) {
                $redirectOptions[CURLOPT_RESOLVE] = ["{$redirectHost}:{$redirectPort}:{$redirectCheck['resolvedIp']}"];
            }
            // Enforce the remaining shared HTTP budget on each redirect hop too,
            // so a redirect chain can't extend total blocking time past the deadline.
            $remainingMs = (int) (($this->httpDeadline - microtime(true)) * 1000);
            if ($remainingMs <= 0) {
                return $this->httpErrorResponse('HTTP time budget exceeded');
            }
            $redirectOptions[CURLOPT_TIMEOUT_MS] = $remainingMs;
            $redirectOptions[CURLOPT_CONNECTTIMEOUT_MS] = min($remainingMs, 3000);

            curl_setopt_array($ch, $redirectOptions);

            $response = curl_exec($ch);
            $error = curl_error($ch);
            $errno = curl_errno($ch);
            $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            $headerSize = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
            $redirectUrl = curl_getinfo($ch, CURLINFO_REDIRECT_URL);

            curl_close($ch);

            if ($errno !== 0) {
                return $this->httpErrorResponse("HTTP request failed");
            }
        }

        if ($redirectCount >= $maxRedirects) {
            return $this->httpErrorResponse('Too many redirects');
        }

        // Parse response
        $responseHeaders = substr($response, 0, $headerSize);
        $responseBody = substr($response, $headerSize);

        // Try to parse JSON response
        $data = json_decode($responseBody, true);
        $isJson = json_last_error() === JSON_ERROR_NONE;

        // Build response object
        return nativeToObject([
            'ok' => $httpCode >= 200 && $httpCode < 300,
            'status' => $httpCode,
            'statusText' => $this->getHttpStatusText($httpCode),
            'headers' => $this->parseResponseHeaders($responseHeaders),
            'body' => $responseBody,
            'data' => $isJson ? $data : null,
            'json' => $isJson,
        ]);
    }

    /**
     * Create an error response object
     */
    private function httpErrorResponse(string $message): BaseObject
    {
        return nativeToObject([
            'ok' => false,
            'status' => 0,
            'statusText' => 'Error',
            'headers' => [],
            'body' => '',
            'data' => null,
            'json' => false,
            'error' => $message,
        ]);
    }

    /**
     * Check if a host is private/local (SSRF protection)
     * Returns [isPrivate: bool, resolvedIp: string|null]
     */
    private function checkHostSecurity(string $host): array
    {
        $host = strtolower($host);

        // Check for localhost variants and cloud metadata endpoints
        $localhostPatterns = [
            'localhost',
            '127.0.0.1',
            '::1',
            '0.0.0.0',
            '0',
            '[::1]',
            '[::ffff:127.0.0.1]',
            'localhost.localdomain',
            '127.0.0.1.nip.io', // Common DNS rebinding service
            '169.254.169.254',  // AWS/GCP metadata
            'metadata.google.internal', // GCP metadata
            'metadata.internal', // Generic cloud metadata
        ];

        foreach ($localhostPatterns as $pattern) {
            if ($host === $pattern || str_ends_with($host, '.' . $pattern)) {
                return ['isPrivate' => true, 'resolvedIp' => null];
            }
        }

        // Block numeric localhost variants (127.x.x.x in various formats)
        // Decimal: 2130706433 = 127.0.0.1
        // Octal: 0177.0.0.1
        // Hex: 0x7f.0.0.1
        if (preg_match('/^(0x7f|0177|2130\d+)/i', $host)) {
            return ['isPrivate' => true, 'resolvedIp' => null];
        }

        // Resolve hostname to IP addresses (both IPv4 and IPv6)
        $resolvedIp = null;

        // Try to get all IP addresses for the host
        $records = @dns_get_record($host, DNS_A | DNS_AAAA);
        if ($records === false || empty($records)) {
            // Fall back to gethostbyname for IPv4 only
            $ip = gethostbyname($host);
            if ($ip !== $host) {
                $resolvedIp = $ip;
                if ($this->isPrivateIp($ip)) {
                    return ['isPrivate' => true, 'resolvedIp' => null];
                }
            }
            // Could not resolve - block to be safe (prevents DNS rebinding via no-resolve-then-resolve)
            if ($resolvedIp === null) {
                return ['isPrivate' => true, 'resolvedIp' => null];
            }
        } else {
            // Check all returned IP addresses
            foreach ($records as $record) {
                $ip = $record['ip'] ?? $record['ipv6'] ?? null;
                if ($ip !== null) {
                    if ($this->isPrivateIp($ip)) {
                        return ['isPrivate' => true, 'resolvedIp' => null];
                    }
                    // Use the first valid IP for DNS pinning
                    if ($resolvedIp === null) {
                        $resolvedIp = $ip;
                    }
                }
            }
        }

        return ['isPrivate' => false, 'resolvedIp' => $resolvedIp];
    }

    /**
     * Check if an IP address is private/reserved
     */
    private function isPrivateIp(string $ip): bool
    {
        // Check IPv4
        if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
            // Use built-in filter for private and reserved ranges
            $flags = FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE;
            if (filter_var($ip, FILTER_VALIDATE_IP, $flags) === false) {
                return true;
            }
            return false;
        }

        // Check IPv6
        if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6)) {
            // Normalize IPv6 address
            $ip = strtolower($ip);

            // Remove brackets if present
            $ip = trim($ip, '[]');

            // Check for loopback (::1)
            if ($ip === '::1' || $ip === '0000:0000:0000:0000:0000:0000:0000:0001') {
                return true;
            }

            // Check for IPv4-mapped IPv6 addresses (::ffff:x.x.x.x)
            if (preg_match('/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i', $ip, $matches)) {
                return $this->isPrivateIp($matches[1]);
            }

            // Expand IPv6 for checking
            $expanded = @inet_pton($ip);
            if ($expanded === false) {
                return true; // Invalid IP, block it
            }
            $hex = bin2hex($expanded);

            // Link-local (fe80::/10)
            if (str_starts_with($hex, 'fe8') || str_starts_with($hex, 'fe9') ||
                str_starts_with($hex, 'fea') || str_starts_with($hex, 'feb')) {
                return true;
            }

            // Unique local (fc00::/7 - includes fd00::/8)
            if (str_starts_with($hex, 'fc') || str_starts_with($hex, 'fd')) {
                return true;
            }

            // Site-local (deprecated, fec0::/10)
            if (str_starts_with($hex, 'fec') || str_starts_with($hex, 'fed') ||
                str_starts_with($hex, 'fee') || str_starts_with($hex, 'fef')) {
                return true;
            }

            // Unspecified (::)
            if ($hex === '00000000000000000000000000000000') {
                return true;
            }

            return false;
        }

        // Invalid IP format
        return true;
    }

    /**
     * Check if a header already exists in the headers array
     */
    private function hasHeader(array $headers, string $name): bool
    {
        $name = strtolower($name);
        foreach ($headers as $header) {
            if (str_starts_with(strtolower($header), $name . ':')) {
                return true;
            }
        }
        return false;
    }

    /**
     * Parse response headers into an associative array
     */
    private function parseResponseHeaders(string $headerString): array
    {
        $headers = [];
        $lines = explode("\r\n", $headerString);
        foreach ($lines as $line) {
            if (str_contains($line, ':')) {
                [$key, $value] = explode(':', $line, 2);
                $headers[strtolower(trim($key))] = trim($value);
            }
        }
        return $headers;
    }

    /**
     * Get HTTP status text for a status code
     */
    private function getHttpStatusText(int $code): string
    {
        $statusTexts = [
            200 => 'OK',
            201 => 'Created',
            202 => 'Accepted',
            204 => 'No Content',
            301 => 'Moved Permanently',
            302 => 'Found',
            304 => 'Not Modified',
            400 => 'Bad Request',
            401 => 'Unauthorized',
            403 => 'Forbidden',
            404 => 'Not Found',
            405 => 'Method Not Allowed',
            409 => 'Conflict',
            422 => 'Unprocessable Entity',
            429 => 'Too Many Requests',
            500 => 'Internal Server Error',
            502 => 'Bad Gateway',
            503 => 'Service Unavailable',
        ];
        return $statusTexts[$code] ?? 'Unknown';
    }

    /**
     * Validate script doesn't try to override reserved names
     * @throws \Exception if reserved names are used
     */
    private function validateScriptSafety(string $script): void
    {
        // Reserved module/builtin names that scripts cannot override
        $reservedNames = [
            '__db', '__utils', '__http', '__meta', '__answers', '__metaObj',
            'ctx', // The context object itself
        ];

        // Check for attempts to reassign reserved names
        // This catches patterns like: let __db = ..., const __db = ..., var __db = ..., __db = ...
        foreach ($reservedNames as $name) {
            // Check for variable declarations
            $patterns = [
                '/\b(let|const|var)\s+' . preg_quote($name, '/') . '\b/',  // let __db, const __db, var __db
                '/\b' . preg_quote($name, '/') . '\s*=(?!=)/',              // __db = (but not __db ==)
            ];

            foreach ($patterns as $pattern) {
                if (preg_match($pattern, $script)) {
                    throw new \Exception("Cannot override reserved name: {$name}");
                }
            }
        }

        // Also check for dangerous patterns
        $dangerousPatterns = [
            '/\beval\s*\(/' => 'eval() is not allowed',
            '/\bFunction\s*\(/' => 'Function constructor is not allowed',
            '/\bwhile\s*\(\s*true\s*\)/' => 'Infinite while loop detected',
            '/\bfor\s*\(\s*;\s*;\s*\)/' => 'Infinite for loop detected',
        ];

        foreach ($dangerousPatterns as $pattern => $message) {
            if (preg_match($pattern, $script)) {
                throw new \Exception("Unsafe script: {$message}");
            }
        }
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
let __answers = {$answersCode};
let __metaObj = {$metaCode};
Object.freeze(__answers);
Object.freeze(__metaObj);
let ctx = {
    answers: __answers,
    meta: __metaObj,
    db: __db,
    utils: __utils,
    http: __http,
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

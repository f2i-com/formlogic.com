<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * Evaluates FormLogic field expressions (conditional visibility, calculated
 * fields, validation rules) server-side.
 *
 * Expressions run inside the QuickJS sandbox via {@see SandboxRunner} — the exact
 * same engine and standard-library prelude the browser uses — so server results
 * match the client by construction. Each method throws on evaluation error; the
 * callers (ResponseService) decide the failure policy (visibility fails open,
 * calculated fields are skipped).
 */
class FormLogicService
{
    private SandboxRunner $runner;

    public function __construct(?SandboxRunner $runner = null)
    {
        $this->runner = $runner ?? new SandboxRunner();
    }

    /**
     * Evaluate an expression with a context of variables.
     *
     * @param array<string, mixed> $context
     */
    public function evaluate(string $expression, array $context = []): mixed
    {
        return $this->unwrap($this->runner->evaluate($expression, $context));
    }

    /**
     * Evaluate a validation rule against a value.
     *
     * @param array<string, mixed> $formData
     */
    public function validateField(string $rule, mixed $value, array $formData = []): bool
    {
        $context = array_merge($formData, ['value' => $value]);
        return (bool) $this->unwrap($this->runner->evaluate($rule, $context));
    }

    /**
     * Evaluate a conditional-visibility rule.
     *
     * @param array<string, mixed> $formData
     */
    public function evaluateCondition(string $condition, array $formData): bool
    {
        return (bool) $this->unwrap($this->runner->evaluate($condition, $formData));
    }

    /**
     * Calculate a computed-field value.
     *
     * @param array<string, mixed> $formData
     */
    public function calculateField(string $formula, array $formData): mixed
    {
        return $this->unwrap($this->runner->evaluate($formula, $formData));
    }

    /**
     * Evaluate many expressions against ONE shared context in a single qjs
     * round-trip (instead of one process spawn per expression). Returns RAW
     * per-id results so the caller can apply its own failure policy (e.g.
     * fail-open visibility, skip calculated fields).
     *
     * @param array<int, array{id: string, expression: string}> $items
     * @param array<string, mixed> $context
     * @return array<string, array{ok: bool, value?: mixed, error?: string}> keyed by id
     */
    public function evaluateBatch(array $items, array $context): array
    {
        $jobs = [];
        foreach ($items as $item) {
            if (!isset($item['id'], $item['expression'])) {
                continue;
            }
            $jobs[] = [
                'id' => (string) $item['id'],
                'expression' => (string) $item['expression'],
            ];
        }
        if ($jobs === []) {
            return [];
        }
        // Pass the shared context ONCE — duplicating it into every job made a batch
        // of N expressions json_encode N copies of the full context into a single
        // NDJSON line (an unauthenticated host-OOM vector on the public form path).
        return $this->runner->evaluateBatch($jobs, $context);
    }

    /**
     * @param array{ok: bool, value?: mixed, error?: string} $result
     */
    private function unwrap(array $result): mixed
    {
        if (!($result['ok'] ?? false)) {
            throw new \RuntimeException($result['error'] ?? 'FormLogic evaluation failed');
        }
        return $result['value'] ?? null;
    }
}

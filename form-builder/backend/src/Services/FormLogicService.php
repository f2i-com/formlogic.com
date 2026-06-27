<?php

declare(strict_types=1);

namespace FormLogic\Services;

/**
 * Evaluates FormLogic field expressions (conditional visibility, calculated
 * fields, validation rules) server-side.
 *
 * Expressions run inside the QuickJS sandbox via {@see QuickJsRunner} — the exact
 * same engine and standard-library prelude the browser uses — so server results
 * match the client by construction. Each method throws on evaluation error; the
 * callers (ResponseService) decide the failure policy (visibility fails open,
 * calculated fields are skipped).
 */
class FormLogicService
{
    private QuickJsRunner $runner;

    public function __construct(?QuickJsRunner $runner = null)
    {
        $this->runner = $runner ?? new QuickJsRunner();
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

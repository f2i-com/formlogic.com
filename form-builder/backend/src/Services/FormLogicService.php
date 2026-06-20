<?php

declare(strict_types=1);

namespace FormLogic\Services;

use FormLogic\Lang\FormLogicEngine;
use FormLogic\Lang\Objects\BaseObject;
use function FormLogic\Lang\Objects\getValue;

/**
 * Service for evaluating FormLogic expressions in the backend
 */
class FormLogicService
{
    private FormLogicEngine $engine;

    /**
     * FormLogic-source prelude prepended to every user EXPRESSION before eval, so
     * the helper builtins/modules (isEmpty/isNotEmpty/contains/sum/avg/count and
     * validators/format/compliance/finance/safety) resolve server-side exactly as
     * they do client-side. Without it those helpers throw on the server, breaking
     * conditional visibility (fails open) and calculated-field recompute. The
     * engine doesn't persist globals across eval() calls, so it's prepended per
     * eval. Kept in sync with the client prelude (ui/.../formlogic/engine.ts).
     */
    private string $prelude = '';

    public function __construct()
    {
        $this->engine = new FormLogicEngine();
        // Apply execution limits to prevent DoS via user-provided expressions
        $this->engine->setLimits(10000, 1000, 50);

        $preludePath = __DIR__ . '/../../resources/formlogic-prelude.fl';
        if (is_file($preludePath)) {
            $this->prelude = (string) file_get_contents($preludePath);
        }
    }

    /**
     * Prepend the helper prelude to a user expression so its builtins resolve.
     */
    private function withPrelude(string $expression): string
    {
        return $this->prelude === '' ? $expression : $this->prelude . "\n" . $expression;
    }

    /**
     * Evaluate a FormLogic expression with context
     * @param string $expression The FormLogic expression to evaluate
     * @param array<string, mixed> $context Context variables available to the expression
     * @return mixed The result of the expression
     */
    public function evaluate(string $expression, array $context = []): mixed
    {
        return $this->engine->eval($this->withPrelude($expression), $context);
    }

    /**
     * Run FormLogic code and return the raw object result
     * @param string $code The FormLogic code to run
     * @return BaseObject The result object
     */
    public function run(string $code): BaseObject
    {
        return $this->engine->run($code);
    }

    /**
     * Run FormLogic code with context and return the raw object result
     * @param string $code The FormLogic code to run
     * @param array<string, mixed> $context Context variables
     * @return BaseObject The result object
     */
    public function runWithContext(string $code, array $context): BaseObject
    {
        return $this->engine->runWithContext($code, $context);
    }

    /**
     * Evaluate a validation rule
     * @param string $rule The validation rule expression
     * @param mixed $value The value to validate
     * @param array<string, mixed> $formData All form data for complex validations
     * @return bool Whether the validation passes
     */
    public function validateField(string $rule, mixed $value, array $formData = []): bool
    {
        $context = array_merge($formData, ['value' => $value]);
        $result = $this->engine->eval($this->withPrelude($rule), $context);
        return (bool) $result;
    }

    /**
     * Evaluate a conditional visibility rule
     * @param string $condition The visibility condition
     * @param array<string, mixed> $formData Form data for the condition
     * @return bool Whether the field should be visible
     */
    public function evaluateCondition(string $condition, array $formData): bool
    {
        $result = $this->engine->eval($this->withPrelude($condition), $formData);
        return (bool) $result;
    }

    /**
     * Calculate a computed field value
     * @param string $formula The calculation formula
     * @param array<string, mixed> $formData Form data for the calculation
     * @return mixed The calculated value
     */
    public function calculateField(string $formula, array $formData): mixed
    {
        return $this->engine->eval($this->withPrelude($formula), $formData);
    }

    /**
     * Run business logic code
     * @param string $code The business logic code
     * @param array<string, mixed> $data Input data
     * @return array<string, mixed> Output data
     */
    public function runBusinessLogic(string $code, array $data): array
    {
        $result = $this->engine->eval($code, $data);
        if (is_array($result)) {
            return $result;
        }
        return ['result' => $result];
    }

    /**
     * Register a custom PHP function as a builtin in FormLogic
     * @param string $name The function name
     * @param callable $fn The PHP function
     */
    public function registerFunction(string $name, callable $fn): void
    {
        $this->engine->registerNativeFunction($name, function ($args) use ($fn) {
            $nativeArgs = array_map(fn($a) => getValue($a), $args);
            return \FormLogic\Lang\Objects\nativeToObject($fn(...$nativeArgs));
        });
    }

    /**
     * Register a custom module with methods
     * @param string $name Module name
     * @param array<string, callable> $methods Module methods
     */
    public function registerModule(string $name, array $methods): void
    {
        $wrappedMethods = [];
        foreach ($methods as $methodName => $fn) {
            $wrappedMethods[$methodName] = function ($args) use ($fn) {
                $nativeArgs = array_map(fn($a) => getValue($a), $args);
                return \FormLogic\Lang\Objects\nativeToObject($fn(...$nativeArgs));
            };
        }
        $this->engine->registerModule($name, $wrappedMethods);
    }

    /**
     * Get the underlying FormLogicEngine instance
     */
    public function getEngine(): FormLogicEngine
    {
        return $this->engine;
    }
}

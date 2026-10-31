<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use PHPUnit\Framework\TestCase;

/**
 * A route written as [Controller::class, 'method'] gets its values by name, not as `array $args`
 * the way a closure route's controller call does. A method asking for what the route doesn't name
 * can never be called: "forget this browser" failed that way on every request, in every release
 * that had it, and no test noticed because they call the method directly.
 */
final class RouteCallableShapeTest extends TestCase
{
    public function testEveryRouteGivenAsAControllerMethodCanBeCalled(): void
    {
        $root = dirname(__DIR__, 2);
        $index = (string) file_get_contents($root . '/public/index.php');
        preg_match_all("/->(?:get|post|put|patch|delete)\(\s*'([^']*)'\s*,\s*\[\s*\\\\?([A-Za-z\\\\]+)::class\s*,\s*'([a-zA-Z_]+)'\s*\]/", $index, $routes, PREG_SET_ORDER);
        $this->assertGreaterThan(10, count($routes), 'the routes were found');

        $broken = [];
        foreach ($routes as [, $path, $class, $method]) {
            $name = substr((string) strrchr('\\' . $class, '\\'), 1);
            $source = (string) file_get_contents($root . "/src/Controllers/{$name}.php");
            $this->assertSame(1, preg_match('/function\s+' . $method . '\s*\(([^)]*)\)/', $source, $signature), "{$name}::{$method} exists");
            preg_match_all('/\{([a-zA-Z_]+)/', $path, $named);
            foreach (array_map('trim', explode(',', $signature[1])) as $parameter) {
                if (!preg_match('/\$([a-zA-Z_]+)/', $parameter, $variable) || in_array($variable[1], ['request', 'response'], true)) {
                    continue;
                }
                if (!str_contains($parameter, '=') && !in_array($variable[1], $named[1], true)) {
                    $broken[] = "{$path} -> {$name}::{$method} needs \${$variable[1]}";
                }
            }
        }

        $this->assertSame([], $broken);
    }
}

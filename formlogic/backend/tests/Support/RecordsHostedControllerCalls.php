<?php
declare(strict_types=1);

namespace FormLogic\Tests\Support;

/** Count controller-to-service calls while forwarding unchanged to the test's delegate. */
trait RecordsHostedControllerCalls
{
    private array $hostedControllerCalls = [];

    /**
     * @template T of object
     * @param class-string<T> $class
     * @param T $delegate
     * @return T
     */
    private function observeHostedService(string $class, object $delegate): object
    {
        $proxy = $this->createMock($class);
        foreach ((new \ReflectionClass($class))->getMethods(\ReflectionMethod::IS_PUBLIC) as $method) {
            if ($method->isConstructor() || $method->isStatic() || $method->isFinal()) continue;
            $name = $method->getName();
            $proxy->method($name)->willReturnCallback(function (...$args) use ($class, $delegate, $name) {
                $key = $class . '::' . $name;
                $this->hostedControllerCalls[$key] = ($this->hostedControllerCalls[$key] ?? 0) + 1;
                return $delegate->$name(...$args);
            });
        }
        return $proxy;
    }

    private function assertHostedServiceCalls(string $class, string $method, int $expected): void
    {
        $key = $class . '::' . $method;
        $this->assertSame($expected, $this->hostedControllerCalls[$key] ?? 0, $key . ' must reach its intended branch');
    }
}

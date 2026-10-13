<?php

declare(strict_types=1);

// Focused, service-free tests may reuse installed dependencies read-only. The
// selected candidate's namespaces must win over the dependency checkout's map.
$vendorAutoload = getenv('FORMLOGIC_TEST_VENDOR_AUTOLOAD');
if (!is_string($vendorAutoload) || !is_file($vendorAutoload)) {
    throw new RuntimeException('Set FORMLOGIC_TEST_VENDOR_AUTOLOAD to an explicit dependency autoloader');
}
$loader = require $vendorAutoload;
if (!$loader instanceof \Composer\Autoload\ClassLoader) {
    throw new RuntimeException('Expected the Composer dependency autoloader');
}
$backendRoot = dirname(__DIR__, 2);
$loader->addPsr4('FormLogic\\', $backendRoot . '/src', true);
$loader->addPsr4('FormLogic\\Tests\\', $backendRoot . '/tests', true);

foreach ([
    'Middleware/CsrfMiddleware', 'Middleware/CorsMiddleware', 'Support/SessionOriginPolicy',
    'Middleware/AuthMiddleware', 'Support/HostedActorContext', 'Controllers/HostedAppController',
] as $relativeClass) {
    $class = 'FormLogic\\' . str_replace('/', '\\', $relativeClass);
    $actual = (new ReflectionClass($class))->getFileName();
    $expected = realpath($backendRoot . '/src/' . $relativeClass . '.php');
    if ($actual === false || realpath($actual) !== $expected) {
        throw new RuntimeException('Source-only test loaded a different candidate for ' . $class);
    }
}

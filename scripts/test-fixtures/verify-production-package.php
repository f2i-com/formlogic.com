<?php
// Exercise the production verifier without constructing its unrelated MySQL/apply services.
declare(strict_types=1);
require __DIR__ . '/../../formlogic/backend/src/Services/UpgradeService.php';
$class = new ReflectionClass(FormLogic\Services\UpgradeService::class);
$service = $class->newInstanceWithoutConstructor();
foreach (['releasePublicKeyRaw' => base64_decode($argv[2], true), 'allowUnsignedDev' => false, 'production' => true] as $name => $value) {
    $class->getProperty($name)->setValue($service, $value);
}
try {
    $result = $class->getMethod('verifyPackageTree')->invoke($service, $argv[1]);
    echo json_encode($result, JSON_THROW_ON_ERROR), PHP_EOL;
} catch (Throwable $error) {
    fwrite(STDERR, $error->getMessage() . PHP_EOL);
    exit(1);
}

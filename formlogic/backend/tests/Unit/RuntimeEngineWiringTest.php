<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\HostedAppController;
use FormLogic\Controllers\NativeAppController;
use FormLogic\Http\AdminActingAsRoutes;
use FormLogic\Services\RuntimeEngineService;
use PHPUnit\Framework\TestCase;
use ReflectionClass;
use ReflectionNamedType;

/**
 * Pins the wiring of the client-engine surface, which no behavioural test can reach: every test
 * builds the controllers by hand, so a controller that production resolves WITHOUT its engine
 * service would still pass the whole suite.
 *
 * The trap is PHP-DI's reflection autowiring (ReflectionBasedAutowiring::getParametersDefinition):
 * it SKIPS optional parameters, so `?RuntimeEngineService $engines = null` on an autowired
 * controller is silently never injected — the engine object would vanish from every response and
 * the owner endpoint would answer 503 in production only.
 */
class RuntimeEngineWiringTest extends TestCase
{
    private static string $source = '';

    public static function setUpBeforeClass(): void
    {
        $source = file_get_contents(dirname(__DIR__, 2) . '/public/index.php');
        self::assertIsString($source);
        self::$source = $source;
    }

    /** @return array<string, array{0: class-string, 1: string}> */
    public static function autowiredDependencies(): array
    {
        return [
            'hosted controller engine' => [HostedAppController::class, 'engines'],
            'hosted controller audit' => [HostedAppController::class, 'audit'],
            'native controller engine' => [NativeAppController::class, 'engines'],
        ];
    }

    /**
     * @param class-string $class
     * @dataProvider autowiredDependencies
     */
    public function testAutowiredDependenciesAreRequiredSoPhpDiInjectsThem(string $class, string $parameter): void
    {
        $constructor = (new ReflectionClass($class))->getConstructor();
        $this->assertNotNull($constructor);
        foreach ($constructor->getParameters() as $reflected) {
            if ($reflected->getName() !== $parameter) {
                continue;
            }
            $this->assertFalse($reflected->isOptional(), "{$class}::\${$parameter} must not be optional: PHP-DI skips optional parameters when autowiring");
            $type = $reflected->getType();
            $this->assertInstanceOf(ReflectionNamedType::class, $type);
            $this->assertFalse($type->allowsNull(), "{$class}::\${$parameter} must not be nullable");
            return;
        }
        $this->fail("{$class} has no \${$parameter} constructor parameter");
    }

    public function testTheEngineServiceIsRegisteredInTheContainer(): void
    {
        $this->assertMatchesRegularExpression(
            '/\$container->set\(\\\\FormLogic\\\\Services\\\\RuntimeEngineService::class,\s*function \(Container \$c\) \{\s*return new \\\\FormLogic\\\\Services\\\\RuntimeEngineService\(\$c->get\(MySQLConnection::class\)\);/',
            self::$source,
            'the autowired controllers can only receive what the container knows how to build'
        );
    }

    public function testTheAdminControllerIsGivenTheEngineServiceExplicitly(): void
    {
        // AdminController is registered by hand, so its optional parameters are only filled if the
        // registration passes them.
        $this->assertMatchesRegularExpression(
            '/\$c->get\(\\\\FormLogic\\\\Services\\\\RuntimeEngineService::class\)\s*\);\s*\}\);/',
            self::$source
        );
    }

    public function testTheAdminEndpointsRideTheAdminGateAndTheStepUpLimiter(): void
    {
        $s = self::$source;
        $this->assertSame(1, substr_count($s, "'/users/{id}/code-trust'"));
        $this->assertMatchesRegularExpression(
            '/\$group->post\(\'\/users\/\{id\}\/code-trust\'.*?->setCodeTrust\(.*?\);\s*\}\)->add\(\$adminStepUpRateLimiter\);/s',
            $s,
            'the code-trust step-up shares the MFA reset\'s 10/min password-oracle budget'
        );
        $this->assertSame(1, substr_count($s, "\$group->get('/engine-policy'"));
        $this->assertSame(1, substr_count($s, "\$group->put('/engine-policy'"));
    }

    public function testTheOwnerEngineEndpointIsGatedLikeTheOtherHostingWrites(): void
    {
        $this->assertMatchesRegularExpression(
            '/\$app->put\(\'\/api\/apps\/\{id\}\/engine\'.*?->engine\(.*?\);\s*\}\)->add\(\$cloudWriteGate\)->add\(\$hostingLimiter\)->add\(\$authRequired\);/s',
            self::$source
        );
    }

    public function testOwnerProjectReadsHaveTheirOwnBucketAndWritesKeepTheHostingOne(): void
    {
        // Reads (the SoftN app workspace, the hosting panels, the editors) never use up the
        // write bucket that bounds installs and publishes, and the starter is a write.
        $this->assertMatchesRegularExpression("/\\\$hostingReadLimiter = new RateLimitMiddleware\\(\\\$rateLimiter, 120, 60, 'hosted_apps_read'/", self::$source);
        foreach (['hosting' => 'HostedAppController', 'native' => 'NativeAppController'] as $path => $controller) {
            $this->assertMatchesRegularExpression('/\$app->get\(\'\/api\/apps\/\{id\}\/' . $path . '\'.*?' . $controller . '::class\)->manage\(.*?\);\s*\}\)->add\(\$hostingReadLimiter\)->add\(\$authRequired\);/s', self::$source);
            $this->assertMatchesRegularExpression('/\$app->put\(\'\/api\/apps\/\{id\}\/' . $path . '\'.*?' . $controller . '::class\)->manage\(.*?\);\s*\}\)->add\(\$cloudWriteGate\)->add\(\$hostingLimiter\)->add\(\$authRequired\);/s', self::$source);
        }
        $this->assertMatchesRegularExpression('/\$app->post\(\'\/api\/apps\/\{id\}\/native\/\{operation:starter\}\'.*?->manage\(.*?\);\s*\}\)->add\(\$cloudWriteGate\)->add\(\$hostingLimiter\)->add\(\$authRequired\);/s', self::$source);
    }

    public function testAdminsActingAsAnOwnerCannotChangeAnAppsEngine(): void
    {
        // The engine is a transfer of trust the OWNER makes. The acting-as table is default-deny,
        // so this pins that no row ever adds it.
        foreach (AdminActingAsRoutes::ROUTES as $route) {
            $this->assertStringNotContainsString('/engine', (string) $route[1]);
        }
    }

    public function testTheKnownEngineIdsAreTheOnesTheUiAndTheSeamAgreeOn(): void
    {
        $this->assertSame(['zipp-web-python', 'zipp-web', 'host-js'], RuntimeEngineService::ENGINES);
        $this->assertSame(['zipp-web-python', 'zipp-web'], RuntimeEngineService::ZIPP_ENGINES);
        $this->assertSame('zipp-web-python', RuntimeEngineService::REQUIRED_ENGINE);
    }
}

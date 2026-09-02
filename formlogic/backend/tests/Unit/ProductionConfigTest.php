<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Controllers\HealthController;
use PHPUnit\Framework\TestCase;

/**
 * Production-safe generated configuration (audit DEPLOY-001):
 * - the install wizard writes APP_ENV=production / APP_DEBUG=false unless the
 *   operator explicitly selects the development install mode;
 * - the auth-cookie Secure flag is deployment policy (COOKIE_SECURE) with a
 *   safe fallback, not just the development switch;
 * - the deep-health production_mode check classifies request hosts so a
 *   public host running development mode fails loudly.
 */
class ProductionConfigTest extends TestCase
{
    /** @var array<string, string|false> snapshot of the env keys the settings tests mutate */
    private array $envSnapshot = [];

    private const ENV_KEYS = ['APP_ENV', 'APP_DEBUG', 'COOKIE_SECURE', 'JWT_SECRET', 'DB_PASSWORD'];

    protected function setUp(): void
    {
        foreach (self::ENV_KEYS as $key) {
            $this->envSnapshot[$key] = array_key_exists($key, $_ENV) ? $_ENV[$key] : false;
        }
    }

    protected function tearDown(): void
    {
        foreach ($this->envSnapshot as $key => $value) {
            if ($value === false) {
                unset($_ENV[$key]);
            } else {
                $_ENV[$key] = $value;
            }
        }
    }

    // ---------------------------------------------------------------- installer

    private static function loadInstallerFunctions(): void
    {
        if (!defined('FORMLOGIC_INSTALL_NO_RUN')) {
            define('FORMLOGIC_INSTALL_NO_RUN', true);
        }
        require_once dirname(__DIR__, 3) . '/install.php';
    }

    /** @return array{devMode:bool,dbHost:string,dbPort:string,dbName:string,dbUser:string,dbPass:string,corsOrigin:string,jwtSecret:string,auditKey:string} */
    private static function installerValues(bool $devMode, string $dbPass = 'hunter2!'): array
    {
        return [
            'devMode' => $devMode,
            'dbHost' => 'localhost',
            'dbPort' => '3306',
            'dbName' => 'formlogic',
            'dbUser' => 'formlogic',
            'dbPass' => $dbPass,
            'corsOrigin' => 'https://forms.example.com',
            'jwtSecret' => str_repeat('a', 64),
            'auditKey' => str_repeat('b', 64),
        ];
    }

    public function testInstallerWritesProductionModeByDefault(): void
    {
        self::loadInstallerFunctions();
        $template = (string) file_get_contents(dirname(__DIR__, 2) . '/.env.example');
        $this->assertStringContainsString('APP_ENV=development', $template, 'precondition: template ships dev defaults');

        $env = \flRenderEnvContent($template, self::installerValues(false));

        $this->assertMatchesRegularExpression('/^APP_ENV=production$/m', $env);
        $this->assertMatchesRegularExpression('/^APP_DEBUG=false$/m', $env);
        $this->assertStringNotContainsString('APP_ENV=development', $env);
        $this->assertMatchesRegularExpression('/^JWT_SECRET=a{64}$/m', $env);
        $this->assertMatchesRegularExpression('/^AUDIT_HMAC_KEY=b{64}$/m', $env);
    }

    public function testInstallerWritesTheSignupPolicyExplicitly(): void
    {
        self::loadInstallerFunctions();
        $template = (string) file_get_contents(dirname(__DIR__, 2) . '/.env.example');
        $this->assertMatchesRegularExpression('/^# BETA_MODE=/m', $template, 'precondition: template ships the key commented out');

        // Default (no betaMode in the values): written as an explicit false, never left to
        // the commented-out template default.
        $env = \flRenderEnvContent($template, self::installerValues(false));
        $this->assertMatchesRegularExpression('/^BETA_MODE=false$/m', $env);
        $this->assertDoesNotMatchRegularExpression('/^# BETA_MODE=/m', $env);

        // The wizard's "Free public beta" option: sign-ups open + free, billing off.
        $env = \flRenderEnvContent($template, self::installerValues(false) + ['betaMode' => true]);
        $this->assertMatchesRegularExpression('/^BETA_MODE=true$/m', $env);
        $this->assertMatchesRegularExpression('/^APP_ENV=production$/m', $env, 'beta mode never implies development mode');
    }

    public function testInstallerKeepsDevelopmentOnlyWhenExplicitlySelected(): void
    {
        self::loadInstallerFunctions();
        $template = (string) file_get_contents(dirname(__DIR__, 2) . '/.env.example');

        $env = \flRenderEnvContent($template, self::installerValues(true));

        $this->assertMatchesRegularExpression('/^APP_ENV=development$/m', $env);
        $this->assertMatchesRegularExpression('/^APP_DEBUG=true$/m', $env);
    }

    public function testInstallerValueEncodingSurvivesRegexMetacharacters(): void
    {
        self::loadInstallerFunctions();
        $template = "APP_ENV=development\nAPP_DEBUG=true\nDB_HOST=x\nDB_PORT=0\nDB_DATABASE=x\nDB_USERNAME=x\nDB_PASSWORD=x\nJWT_SECRET=\nCORS_ORIGIN=x\n# AUDIT_HMAC_KEY=\n";

        // '$1' in a password must not be eaten as a backreference; the quoted form must escape it.
        $env = \flRenderEnvContent($template, self::installerValues(false, 'pa$1ss word'));

        $this->assertStringContainsString('DB_PASSWORD="pa\\$1ss word"', $env);
    }

    // ---------------------------------------------------------- cookie security

    private function loadSettings(): array
    {
        $config = require dirname(__DIR__, 2) . '/config/settings.php';
        return $config['settings'];
    }

    public function testCookieSecureDefaultsFollowEnvironment(): void
    {
        $_ENV['JWT_SECRET'] = str_repeat('s', 64);
        $_ENV['DB_PASSWORD'] = 'not-the-default';
        unset($_ENV['COOKIE_SECURE']);

        $_ENV['APP_ENV'] = 'development';
        $this->assertFalse($this->loadSettings()['cookie']['secure'], 'dev default: not Secure');

        $_ENV['APP_ENV'] = 'production';
        $this->assertTrue($this->loadSettings()['cookie']['secure'], 'production default: Secure');
    }

    public function testCookieSecureIsExplicitDeploymentPolicy(): void
    {
        $_ENV['JWT_SECRET'] = str_repeat('s', 64);
        $_ENV['DB_PASSWORD'] = 'not-the-default';

        // An HTTPS dev vhost can pin Secure cookies on…
        $_ENV['APP_ENV'] = 'development';
        $_ENV['COOKIE_SECURE'] = 'true';
        $this->assertTrue($this->loadSettings()['cookie']['secure']);

        // …and a deliberate plain-HTTP intranet deploy can pin them off.
        $_ENV['APP_ENV'] = 'production';
        $_ENV['COOKIE_SECURE'] = 'false';
        $this->assertFalse($this->loadSettings()['cookie']['secure']);

        // Garbage values fall back to the safe default instead of being honoured.
        $_ENV['COOKIE_SECURE'] = 'yes-please';
        $this->assertTrue($this->loadSettings()['cookie']['secure']);
    }

    // ------------------------------------------------------- deep-health check

    public function testDevelopmentHostClassification(): void
    {
        foreach (['localhost', '127.0.0.1', '::1', '[::1]', '10.1.2.3', '192.168.0.20', '172.16.4.4',
            'formlogic.local', 'myapp.test', 'ci.internal', 'box.lan', 'router.home.arpa', 'a.localhost'] as $devHost) {
            $this->assertTrue(HealthController::isDevelopmentHost($devHost), "expected dev host: {$devHost}");
        }
        foreach (['formlogic.com', 'app.formlogic.com', 'example.org', '8.8.8.8', '2606:4700:4700::1111',
            'localhost.evil.com', 'mylocal.host'] as $publicHost) {
            $this->assertFalse(HealthController::isDevelopmentHost($publicHost), "expected public host: {$publicHost}");
        }
    }
}

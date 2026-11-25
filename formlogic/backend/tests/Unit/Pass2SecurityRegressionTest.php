<?php

declare(strict_types=1);

namespace FormLogic\Tests\Unit;

use FormLogic\Middleware\SecurityHeadersMiddleware;
use FormLogic\Services\AokieCompanionAdmissionSigner;
use FormLogic\Services\AppReportService;
use FormLogic\Services\DataEncryptionMigrator;
use FormLogic\Services\Flows\DataEdgeAnalysis;
use FormLogic\Services\NativeAppService;
use FormLogic\Services\PayPalService;
use FormLogic\Services\PluginAppSettings;
use FormLogic\Support\AdminActingLimits;
use FormLogic\Support\BackupEnvelope;
use FormLogic\Support\DataCanonicalJson;
use FormLogic\Support\DataEncryption;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Factory\ResponseFactory;
use Slim\Psr7\Factory\ServerRequestFactory;

final class Pass2SecurityRegressionTest extends TestCase
{
    public function testAdminActingLimitsBlocksExternalApiEscalationAndPublicPublishing(): void
    {
        // Enabling externalApi while acting-as is refused.
        $refusal = AdminActingLimits::appSettingsRefusal(
            ['externalApi' => ['enabled' => true, 'authMode' => 'public']],
            []
        );
        $this->assertNotNull($refusal);

        // Switching authMode from api_key to public/both while acting-as is refused.
        $refusalMode = AdminActingLimits::appSettingsRefusal(
            ['externalApi' => ['enabled' => true, 'authMode' => 'both']],
            ['externalApi' => ['enabled' => true, 'authMode' => 'api_key']]
        );
        $this->assertNotNull($refusalMode);

        // Removing a blockedPath entry while acting-as is refused.
        $refusalBlocked = AdminActingLimits::appSettingsRefusal(
            ['externalApi' => ['enabled' => true, 'authMode' => 'api_key', 'blockedPaths' => []]],
            ['externalApi' => ['enabled' => true, 'authMode' => 'api_key', 'blockedPaths' => ['/admin']]]
        );
        $this->assertNotNull($refusalBlocked);

        // Publishing a draft app with public external API enabled is refused.
        $pubRefusal = AdminActingLimits::appPublishRefusal(
            'published',
            ['status' => 'draft', 'settings' => ['externalApi' => ['enabled' => true, 'authMode' => 'public']]]
        );
        $this->assertNotNull($pubRefusal);

        // Leaving externalApi unchanged (disabled) is allowed.
        $this->assertNull(AdminActingLimits::appSettingsRefusal(
            ['externalApi' => ['enabled' => false]],
            ['externalApi' => ['enabled' => false]]
        ));
    }

    public function testSanitizeDashboardCssBlocksEscapesCommentsImageSetFontFaceAndNestedStyle(): void
    {
        $svc = (new \ReflectionClass(AppReportService::class))->newInstanceWithoutConstructor();
        $dirty = implode("\n", [
            '</st</style>yle><script>alert(1)</script>',
            '@font-face { font-family: x; src: url("https://evil.test/f.woff2"); }',
            '.a { background: \75 rl("https://evil.test/a.png"); }',
            '.b { background: url(/*comment*/"https://evil.test/b(1).png"); }',
            '.c { background: image-set("https://evil.test/c.png" 1x); }',
            '.d { background: -webkit-image-set("https://evil.test/d.png" 1x); }',
            '.ok { background: url("data:image/png;base64,iVBORw0KGgo="); color: #111; }',
        ]);
        $clean = $svc->sanitizeDashboardCss($dirty);

        $this->assertStringNotContainsString('evil.test', $clean);
        $this->assertStringNotContainsString('</style', strtolower($clean));
        $this->assertStringNotContainsString('@font-face', strtolower($clean));
        $this->assertStringNotContainsString('image-set', strtolower($clean));
        $this->assertStringContainsString('data:image/png;base64,iVBORw0KGgo=', $clean);
        $this->assertStringContainsString('color: #111', $clean);
    }

    public function testSecurityHeadersMiddlewareBlocksPercentEncodedApiSitePageCsp(): void
    {
        $mw = new SecurityHeadersMiddleware(false);
        $req = (new ServerRequestFactory())->createServerRequest('GET', 'https://example.com/%61pi/public/apps/1/routes/hi');
        $handler = new class implements RequestHandlerInterface {
            public function handle(ServerRequestInterface $request): ResponseInterface
            {
                return (new ResponseFactory())->createResponse(200)
                    ->withHeader('Content-Security-Policy', SecurityHeadersMiddleware::SITE_PAGE);
            }
        };
        $res = $mw->process($req, $handler);
        $this->assertNotSame(SecurityHeadersMiddleware::SITE_PAGE, $res->getHeaderLine('Content-Security-Policy'));
        $this->assertStringContainsString("default-src 'none'", $res->getHeaderLine('Content-Security-Policy'));
    }

    public function testPayPalIsConfiguredRespectsStandInRefused(): void
    {
        $prevEnv = $_ENV['APP_ENV'] ?? null;
        $prevBase = $_ENV['PAYPAL_BASE_URL'] ?? null;
        try {
            $_ENV['APP_ENV'] = 'production';
            $_ENV['PAYPAL_BASE_URL'] = 'http://127.0.0.1:9999';
            $paypal = new PayPalService([
                'clientId' => 'live-id',
                'clientSecret' => 'live-secret',
                'mode' => 'live',
            ]);
            $this->assertTrue($paypal->standInRefused());
            $this->assertFalse($paypal->isConfigured());
        } finally {
            if ($prevEnv === null) {
                unset($_ENV['APP_ENV']);
            } else {
                $_ENV['APP_ENV'] = $prevEnv;
            }
            if ($prevBase === null) {
                unset($_ENV['PAYPAL_BASE_URL']);
            } else {
                $_ENV['PAYPAL_BASE_URL'] = $prevBase;
            }
        }
    }

    public function testCompanionAdmissionSignerAcceptsIpv6LoopbackInDevelopment(): void
    {
        $prevEnv = $_ENV['APP_ENV'] ?? null;
        $method = new \ReflectionMethod(AokieCompanionAdmissionSigner::class, 'validGatewayUrl');
        $method->setAccessible(true);
        try {
            $_ENV['APP_ENV'] = 'development';
            $this->assertTrue($method->invoke(null, 'ws://[::1]:8080/v2/realtime'));
            $_ENV['APP_ENV'] = 'production';
            $this->assertFalse($method->invoke(null, 'ws://[::1]:8080/v2/realtime'));
        } finally {
            if ($prevEnv === null) {
                unset($_ENV['APP_ENV']);
            } else {
                $_ENV['APP_ENV'] = $prevEnv;
            }
        }
    }

    public function testAdminActingLimitsCatchesOmittedExternalApiEnabled(): void
    {
        // Omitting `enabled` defaults to enabled=true inside AppService::sanitizeExternalApi().
        $this->assertNotNull(AdminActingLimits::appSettingsRefusal(
            ['externalApi' => ['authMode' => 'public']],
            []
        ));
        $this->assertNotNull(AdminActingLimits::appPublishRefusal(
            'published',
            ['status' => 'draft'],
            ['externalApi' => ['authMode' => 'public']]
        ));
    }

    public function testSanitizeDashboardCssResistsTokenReassemblyAndNestedImageSet(): void
    {
        $svc = (new \ReflectionClass(AppReportService::class))->newInstanceWithoutConstructor();
        $dirty = implode("\n", [
            '.a { background: u-moz-bindingrl("https://evil.test/reassembled.png"); }',
            '.b { background: image-set(url("https://evil.test/nested.png") 1x, "https://evil.test/alt.png" 2x); }',
            '.c { background: u/*x*/rl("https://evil.test/comment.png"); }',
            '</st-moz-bindingyle><script>alert(1)</script>',
            '@imp-moz-bindingort "https://evil.test/a.css";',
        ]);
        $clean = $svc->sanitizeDashboardCss($dirty);

        $this->assertDoesNotMatchRegularExpression('/\burl\s*\(/i', $clean);
        $this->assertStringNotContainsString('nested.png', $clean);
        $this->assertStringNotContainsString('alt.png', $clean);
        $this->assertStringNotContainsString('comment.png', $clean);
        $this->assertStringNotContainsString('</style', strtolower($clean));
        $this->assertStringNotContainsString('@import', strtolower($clean));
        $this->assertStringNotContainsString('image-set', strtolower($clean));
        $this->assertStringNotContainsString('-moz-binding', strtolower($clean));
    }

    public function testDataEdgeAnalysisFlagsMissingRequiredInputOnDataflowGraph(): void
    {
        $installed = ['com.acme.op' => [
            'definition' => [
                'ports' => [
                    ['id' => 'payload', 'direction' => 'input', 'kind' => 'data', 'required' => true],
                    ['id' => 'context', 'direction' => 'input', 'kind' => 'data', 'required' => false],
                ],
            ],
        ]];
        $graph = [
            'nodes' => [
                ['id' => 'src', 'type' => 'input', 'data' => []],
                ['id' => 'n1', 'type' => 'com.acme.op', 'data' => []],
            ],
            'edges' => [
                ['id' => 'e1', 'kind' => 'data', 'source' => 'src', 'sourceHandle' => 'out', 'target' => 'n1', 'targetHandle' => 'context'],
            ],
        ];
        $diags = DataEdgeAnalysis::analyse($graph, $installed);
        $codes = array_column($diags, 'code');
        $this->assertContains('data_input_unsatisfied', $codes);
    }

    public function testDataCanonicalJsonRejectsInvalidUtf8ObjectKeysBeforeSorting(): void
    {
        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('UTF-8');
        DataCanonicalJson::encode(["\xC3" => 1, 'a' => 2]);
    }

    public function testBackupEnvelopeFallsThroughFromMismatchedServerKeyToPassphrase(): void
    {
        $prevKey = $_ENV[DataEncryption::KEY_ENV] ?? null;
        $prevOld = $_ENV[DataEncryption::PREVIOUS_KEYS_ENV] ?? null;
        unset($_ENV[DataEncryption::PREVIOUS_KEYS_ENV], $_SERVER[DataEncryption::PREVIOUS_KEYS_ENV]);
        putenv(DataEncryption::PREVIOUS_KEYS_ENV);

        $tmpZip = tempnam(sys_get_temp_dir(), 'fl_env_in_');
        $tmpOut = tempnam(sys_get_temp_dir(), 'fl_env_out_');
        $tmpDec = tempnam(sys_get_temp_dir(), 'fl_env_dec_');
        $this->assertIsString($tmpZip);
        $this->assertIsString($tmpOut);
        $this->assertIsString($tmpDec);
        try {
            $_ENV[DataEncryption::KEY_ENV] = str_repeat('11', 32);
            $keyA = DataEncryption::fromEnvironment();
            $_ENV[DataEncryption::KEY_ENV] = str_repeat('22', 32);
            $keyB = DataEncryption::fromEnvironment();

            file_put_contents($tmpZip, 'secret-backup-payload');
            BackupEnvelope::seal($tmpZip, $tmpOut, [
                'server' => $keyA,
                'passphrase' => 'correct-horse-battery-staple',
            ], ['kind' => 'test']);
            // Opening with a rotated/wrong server key + valid passphrase must fall through to passphrase.
            BackupEnvelope::open($tmpOut, $tmpDec, [
                'server' => $keyB,
                'passphrase' => 'correct-horse-battery-staple',
            ]);
            $this->assertSame('secret-backup-payload', file_get_contents($tmpDec));
        } finally {
            if ($prevKey === null) {
                unset($_ENV[DataEncryption::KEY_ENV]);
            } else {
                $_ENV[DataEncryption::KEY_ENV] = $prevKey;
            }
            if ($prevOld === null) {
                unset($_ENV[DataEncryption::PREVIOUS_KEYS_ENV]);
            } else {
                $_ENV[DataEncryption::PREVIOUS_KEYS_ENV] = $prevOld;
            }
            @unlink($tmpZip);
            @unlink($tmpOut);
            @unlink($tmpDec);
        }
    }

    public function testAdminActingLimitsBlocksExternalApiPrefixAndRateLimitWidening(): void
    {
        $base = ['externalApi' => ['enabled' => true, 'authMode' => 'public', 'defaultPrefix' => '/public', 'rateLimitPerMinute' => 30]];
        // Changing defaultPrefix could shift public traffic onto unexposed routes.
        $this->assertNotNull(AdminActingLimits::appSettingsRefusal(
            ['externalApi' => ['enabled' => true, 'authMode' => 'public', 'defaultPrefix' => '', 'rateLimitPerMinute' => 30]],
            $base
        ));
        // Raising rateLimitPerMinute widens public exposure.
        $this->assertNotNull(AdminActingLimits::appSettingsRefusal(
            ['externalApi' => ['enabled' => true, 'authMode' => 'public', 'defaultPrefix' => '/public', 'rateLimitPerMinute' => 60]],
            $base
        ));
        // Identical settings remain allowed.
        $this->assertNull(AdminActingLimits::appSettingsRefusal($base, $base));
        // Creating a brand-new form with publicRecords: true while acting-as is refused.
        $this->assertNotNull(AdminActingLimits::formRefusal(
            ['status' => 'published', 'customScreen' => ['kind' => 'dashboard', 'publicRecords' => true]],
            []
        ));
    }

    public function testSanitizeDashboardCssStripsUnclosedEofUrlAndTrailingModifiers(): void
    {
        $svc = (new \ReflectionClass(AppReportService::class))->newInstanceWithoutConstructor();
        $dirty = implode("\n", [
            '.a { background: url("https://evil.test/mod.png" cross-origin); }',
            '.b { background: url("data:image/png;base64,iVBORw0KGgo="); }',
            '@font-face { font-family: x; src: url("https://evil.test/f.woff2")',
            '.c { background: url("https://evil.test/unclosed-eof',
        ]);
        $clean = $svc->sanitizeDashboardCss($dirty);

        $this->assertStringNotContainsString('evil.test', $clean);
        $this->assertStringNotContainsString('@font-face', strtolower($clean));
        $this->assertStringContainsString('data:image/png;base64,iVBORw0KGgo=', $clean);
    }

    public function testDataEncryptionMigratorResealsPluginAndLegacyVerifySecrets(): void
    {
        $prevKey = $_ENV[DataEncryption::KEY_ENV] ?? null;
        $prevOld = $_ENV[DataEncryption::PREVIOUS_KEYS_ENV] ?? null;
        $tmpDir = sys_get_temp_dir() . '/fl_migrator_p4_' . bin2hex(random_bytes(6));
        mkdir($tmpDir, 0700, true);
        try {
            $pdo = new class ('sqlite::memory:') extends \PDO {
                public function prepare(string $query, array $options = []): \PDOStatement|false
                {
                    if (stripos($query, 'ON DUPLICATE KEY UPDATE') !== false) {
                        $query = 'INSERT OR REPLACE INTO system_meta (meta_key, meta_value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)';
                    }
                    return parent::prepare($query, $options);
                }
            };
            $pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
            $pdo->exec('CREATE TABLE users (id TEXT PRIMARY KEY, mfa_secret TEXT)');
            $pdo->exec('CREATE TABLE webhooks (id TEXT PRIMARY KEY, secret TEXT)');
            $pdo->exec('CREATE TABLE softn_directory_publications (id TEXT PRIMARY KEY, edit_key TEXT)');
            $pdo->exec('CREATE TABLE apps (id TEXT PRIMARY KEY)');
            $pdo->exec('CREATE TABLE system_meta (meta_key TEXT PRIMARY KEY, meta_value TEXT, updated_at TEXT)');
            $pdo->exec("INSERT INTO apps (id) VALUES ('app-1')");

            $key1Hex = str_repeat('aa', 32);
            $key2Hex = str_repeat('bb', 32);
            $_ENV[DataEncryption::KEY_ENV] = $key1Hex;
            unset($_ENV[DataEncryption::PREVIOUS_KEYS_ENV]);
            $key1 = DataEncryption::fromEnvironment();

            $pluginId = 'formlogic.twilio-verify';
            $pluginFile = PluginAppSettings::fileName($pluginId);
            $files = [
                $pluginFile => json_encode([
                    'plugin' => $pluginId,
                    'values' => ['accountSid' => 'AC123'],
                    'secrets' => [
                        'authToken' => ['value' => $key1->seal('tok-sealed', PluginAppSettings::secretContext($pluginId, 'app-1', 'authToken')), 'sealed' => true],
                        'plainToken' => ['value' => 'fle1.looks-sealed-but-plain', 'sealed' => false],
                    ],
                ], JSON_THROW_ON_ERROR),
                'verify.json' => json_encode([
                    'accountSid' => 'AC123',
                    'serviceSid' => 'VA123',
                    'authToken' => $key1->seal('legacy-tok', 'native-app-verify:app-1'),
                    'sealed' => true,
                ], JSON_THROW_ON_ERROR),
            ];

            $native = $this->createMock(NativeAppService::class);
            $native->method('privateFileNames')->willReturn([$pluginFile]);
            $native->method('withPrivateFileLock')->willReturnCallback(fn (string $appId, string $name, callable $fn) => $fn());
            $native->method('readPrivateFile')->willReturnCallback(function (string $appId, string $name) use (&$files): ?string {
                return $files[$name] ?? null;
            });
            $native->method('writePrivateFile')->willReturnCallback(function (string $appId, string $name, string $text) use (&$files): void {
                $files[$name] = $text;
            });

            $_ENV[DataEncryption::KEY_ENV] = $key2Hex;
            $_ENV[DataEncryption::PREVIOUS_KEYS_ENV] = $key1Hex;
            $key2WithPrev = DataEncryption::fromEnvironment();

            $migrator = new DataEncryptionMigrator($pdo, $tmpDir, null, $native);
            $res = $migrator->run($key2WithPrev);
            $this->assertSame([], $res['failed']);
            $this->assertSame(3, $res['secrets']);

            // Drop the old key and verify every resealed secret opens strictly under key2.
            $_ENV[DataEncryption::KEY_ENV] = $key2Hex;
            unset($_ENV[DataEncryption::PREVIOUS_KEYS_ENV]);
            $key2Only = DataEncryption::fromEnvironment();

            $pluginData = json_decode($files[$pluginFile], true);
            $this->assertTrue($pluginData['secrets']['authToken']['sealed']);
            $this->assertSame('tok-sealed', $key2Only->open($pluginData['secrets']['authToken']['value'], PluginAppSettings::secretContext($pluginId, 'app-1', 'authToken')));
            $this->assertTrue($pluginData['secrets']['plainToken']['sealed']);
            $this->assertSame('fle1.looks-sealed-but-plain', $key2Only->open($pluginData['secrets']['plainToken']['value'], PluginAppSettings::secretContext($pluginId, 'app-1', 'plainToken')));

            $verifyData = json_decode($files['verify.json'], true);
            $this->assertTrue($verifyData['sealed']);
            $this->assertSame('legacy-tok', $key2Only->open($verifyData['authToken'], 'native-app-verify:app-1'));
        } finally {
            if ($prevKey === null) {
                unset($_ENV[DataEncryption::KEY_ENV]);
            } else {
                $_ENV[DataEncryption::KEY_ENV] = $prevKey;
            }
            if ($prevOld === null) {
                unset($_ENV[DataEncryption::PREVIOUS_KEYS_ENV]);
            } else {
                $_ENV[DataEncryption::PREVIOUS_KEYS_ENV] = $prevOld;
            }
            @rmdir($tmpDir);
        }
    }
}

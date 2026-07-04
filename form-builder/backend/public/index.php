<?php

declare(strict_types=1);

use DI\Container;
use DI\Bridge\Slim\Bridge as SlimBridge;
use Slim\Routing\RouteCollectorProxy;
use Monolog\Logger;
use Monolog\Handler\RotatingFileHandler;
use Monolog\Handler\StreamHandler;
use Monolog\Formatter\LineFormatter;
use Psr\Log\LoggerInterface;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AuthService;
use FormLogic\Services\FormService;
use FormLogic\Services\ResponseService;
use FormLogic\Services\FormLogicRuntime;
use FormLogic\Controllers\AuthController;
use FormLogic\Controllers\FormController;
use FormLogic\Controllers\ResponseController;
use FormLogic\Controllers\AIController;
use FormLogic\Middleware\CorsMiddleware;
use FormLogic\Middleware\CsrfMiddleware;
use FormLogic\Middleware\AuthMiddleware;
use FormLogic\Middleware\SecurityHeadersMiddleware;
use FormLogic\Middleware\RateLimitMiddleware;
use FormLogic\Middleware\BodySizeLimitMiddleware;
use FormLogic\Services\AIService;
use FormLogic\Services\DocumentConverter;
use FormLogic\Services\AppService;
use FormLogic\Services\AppUserService;
use FormLogic\Services\AppResponseService;
use FormLogic\Services\WebhookService;
use FormLogic\Services\FormVersionService;
use FormLogic\Services\AuditService;
use FormLogic\Controllers\AppController;
use FormLogic\Controllers\AppUserController;
use FormLogic\Controllers\AppPublicController;
use FormLogic\Controllers\WebhookController;
use FormLogic\Services\PackService;
use FormLogic\Services\PackCatalogService;
use FormLogic\Services\PackFileService;
use FormLogic\Services\PackRatingService;
use FormLogic\Controllers\PackController;
use FormLogic\Controllers\PackCatalogController;
use FormLogic\Controllers\PackRatingController;
use FormLogic\Services\ApiKeyService;
use FormLogic\Services\FileStorageService;
use FormLogic\Controllers\ApiKeyController;
use FormLogic\Controllers\ExternalApiController;
use FormLogic\Controllers\FileController;
use FormLogic\Middleware\ApiKeyMiddleware;

require __DIR__ . '/../vendor/autoload.php';

// Pin PHP's timezone to UTC so date()/strtotime() output matches the pinned
// MySQL session (SET time_zone='+00:00') and SQLite's datetime('now'). A non-UTC
// php.ini would otherwise skew PHP-written timestamps against DB-written ones.
date_default_timezone_set('UTC');

// Load environment variables
$dotenv = Dotenv\Dotenv::createImmutable(__DIR__ . '/..');
$dotenv->load();

// Load settings
$settings = require __DIR__ . '/../config/settings.php';

// Create Container
$container = new Container();

// Register settings
$container->set('settings', $settings['settings']);

// Register Monolog logger
$container->set(LoggerInterface::class, function (Container $c) {
    $logSettings = $c->get('settings')['logger'];
    $logger = new Logger($logSettings['name']);

    // Rotating file handler — one file per day, keep 30 days
    $fileHandler = new RotatingFileHandler(
        $logSettings['path'],
        30,
        $logSettings['level']
    );
    $fileHandler->setFormatter(new LineFormatter(
        "[%datetime%] %channel%.%level_name%: %message% %context% %extra%\n",
        'Y-m-d H:i:s'
    ));
    $logger->pushHandler($fileHandler);

    // Also log errors to stderr in development for immediate visibility
    $isProduction = $c->get('settings')['isProduction'] ?? false;
    if (!$isProduction) {
        $stderrHandler = new StreamHandler('php://stderr', Logger::ERROR);
        $logger->pushHandler($stderrHandler);
    }

    return $logger;
});

// Register database connections
$container->set(MySQLConnection::class, function (Container $c) {
    $mysql = new MySQLConnection($c->get('settings')['mysql']);
    // Initialize schema and run migrations only once per process
    static $schemaInitialized = false;
    if (!$schemaInitialized) {
        $mysql->initializeSchema();
        $mysql->runMigrations();
        $schemaInitialized = true;
    }
    return $mysql;
});

$container->set(SQLiteConnection::class, function (Container $c) {
    return new SQLiteConnection($c->get('settings')['sqlite']['storage_path']);
});

// Register services
$container->set(\FormLogic\Services\EmailService::class, function (Container $c) {
    return new \FormLogic\Services\EmailService($c->get(LoggerInterface::class));
});

$container->set(AuthService::class, function (Container $c) {
    $settings = $c->get('settings');
    return new AuthService(
        $c->get(MySQLConnection::class),
        $settings['jwt'],
        $settings['rateLimit']['login'] ?? [],
        $c->get(\FormLogic\Services\EmailService::class)
    );
});

// Register webhook service (early, used by FormService and ResponseService)
$container->set(WebhookService::class, function (Container $c) {
    return new WebhookService(
        $c->get(MySQLConnection::class),
        $c->get(LoggerInterface::class)
    );
});

// Register audit service
$container->set(AuditService::class, function (Container $c) use ($settings) {
    // Use explicit AUDIT_HMAC_KEY if set, otherwise derive from JWT secret
    $auditHmacKey = $_ENV['AUDIT_HMAC_KEY'] ?? null;
    if (empty($auditHmacKey)) {
        $jwtSecret = $settings['settings']['jwt']['secret'] ?? '';
        $auditHmacKey = hash('sha256', 'formlogic-audit:' . $jwtSecret);
    }
    return new AuditService(
        $c->get(MySQLConnection::class),
        $c->get(LoggerInterface::class),
        $auditHmacKey
    );
});

$container->set(FormService::class, function (Container $c) {
    return new FormService(
        $c->get(MySQLConnection::class),
        $c->get(SQLiteConnection::class),
        $c->get(WebhookService::class),
        $c->get(FileStorageService::class)
    );
});

// Register form version service
$container->set(FormVersionService::class, function (Container $c) {
    return new FormVersionService(
        $c->get(MySQLConnection::class),
        $c->get(FormService::class)
    );
});

// Register FormLogic runtime with execution limits
$container->set(FormLogicRuntime::class, function (Container $c) {
    return new FormLogicRuntime([
        'maxInstructions' => 50000,
        'maxWallTimeMs' => 2000,
        'maxCallDepth' => 100,
    ]);
});

$container->set(ResponseService::class, function (Container $c) {
    return new ResponseService(
        $c->get(MySQLConnection::class),
        $c->get(SQLiteConnection::class),
        $c->get(FormLogicRuntime::class),
        $c->get(LoggerInterface::class),
        $c->get(WebhookService::class),
        $c->get(FileStorageService::class)
    );
});

// Register controllers
$container->set(AuthController::class, function (Container $c) {
    $settings = $c->get('settings');
    // Same derivation as the CsrfMiddleware wiring, so issued + validated tokens match.
    $csrfSecret = hash('sha256', 'formlogic-csrf:' . ($settings['jwt']['secret'] ?? ''));
    return new AuthController(
        $c->get(AuthService::class),
        $settings['cookie'] ?? [],
        $settings['jwt']['expiry'] ?? 86400,
        $c->get(LoggerInterface::class),
        $c->get(AuditService::class),
        $csrfSecret,
        $c->get(FormService::class),
        $c->get(AppService::class),
        $c->get(ApiKeyService::class),
        $c->get(MySQLConnection::class)
    );
});

$container->set(FormController::class, function (Container $c) {
    return new FormController(
        $c->get(FormService::class),
        $c->get(LoggerInterface::class),
        $c->get(FormVersionService::class),
        $c->get(AuditService::class),
        $c->get(\FormLogic\Services\PlanService::class),
        $c->get(\FormLogic\Services\AppReportService::class)
    );
});

$container->set(WebhookController::class, function (Container $c) {
    return new WebhookController(
        $c->get(WebhookService::class),
        $c->get(FormService::class)
    );
});

$container->set(ResponseController::class, function (Container $c) {
    return new ResponseController(
        $c->get(ResponseService::class),
        $c->get(FormService::class),
        $c->get(SQLiteConnection::class),
        $c->get(LoggerInterface::class),
        $c->get(AuditService::class),
        $c->get(\FormLogic\Services\EmailService::class),
        $c->get(\FormLogic\Services\AppService::class)
    );
});

// Register AI services
$container->set(AIService::class, function () {
    return new AIService();
});

$container->set(DocumentConverter::class, function () {
    return new DocumentConverter();
});

$container->set(AIController::class, function (Container $c) {
    return new AIController(
        $c->get(AIService::class),
        $c->get(DocumentConverter::class),
        $c->get('settings')['uploads'] ?? [],
        $c->get(LoggerInterface::class)
    );
});

// Register Pack service
$container->set(PackService::class, function (Container $c) {
    return new PackService(
        $c->get(MySQLConnection::class),
        $c->get(FormService::class),
        $c->get(AppService::class),
        $c->get(AppUserService::class)
    );
});

$container->set(PackController::class, function (Container $c) {
    return new PackController(
        $c->get(PackService::class),
        $c->get(AuditService::class),
        $c->get(\FormLogic\Services\PlanService::class)
    );
});

// Pack marketplace services
$container->set(PackCatalogService::class, function (Container $c) {
    return new PackCatalogService($c->get(MySQLConnection::class));
});

$container->set(PackFileService::class, function (Container $c) {
    return new PackFileService($c->get('settings')['packs'] ?? []);
});

$container->set(PackRatingService::class, function (Container $c) {
    return new PackRatingService($c->get(MySQLConnection::class));
});

$container->set(PackCatalogController::class, function (Container $c) {
    return new PackCatalogController(
        $c->get(PackCatalogService::class),
        $c->get(PackFileService::class),
        $c->get(AuditService::class)
    );
});

$container->set(PackRatingController::class, function (Container $c) {
    return new PackRatingController(
        $c->get(PackRatingService::class),
        $c->get(PackCatalogService::class),
        $c->get(AuditService::class)
    );
});

// File storage service
$container->set(FileStorageService::class, function (Container $c) {
    $uploadsConfig = $c->get('settings')['uploads'] ?? [];
    $uploadsConfig['storagePath'] = $uploadsConfig['storagePath'] ?? __DIR__ . '/../storage/uploads';
    return new FileStorageService($uploadsConfig);
});

// Hosted-cloud plan limits (form count + storage) + cloud-access status.
$container->set(\FormLogic\Services\PlanService::class, function (Container $c) {
    return new \FormLogic\Services\PlanService(
        $c->get(MySQLConnection::class),
        $c->get(FileStorageService::class),
        $c->get('settings')['cloud'] ?? []
    );
});

$container->set(FileController::class, function (Container $c) {
    return new FileController(
        $c->get(FileStorageService::class),
        $c->get(FormService::class),
        $c->get(AppService::class),
        $c->get(AppUserService::class),
        $c->get(\FormLogic\Services\PlanService::class),
        $c->get(ResponseService::class)
    );
});

// Register API Key services
$container->set(ApiKeyService::class, function (Container $c) {
    return new ApiKeyService(
        $c->get(MySQLConnection::class)
    );
});

$container->set(ApiKeyController::class, function (Container $c) {
    return new ApiKeyController(
        $c->get(ApiKeyService::class),
        $c->get(FormService::class),
        $c->get(AuditService::class)
    );
});

// MCP: ephemeral tokens + the Model Context Protocol server (external AI drives the API).
$container->set(\FormLogic\Services\McpTokenService::class, function (Container $c) {
    return new \FormLogic\Services\McpTokenService($c->get(MySQLConnection::class));
});
$container->set(\FormLogic\Controllers\McpController::class, function (Container $c) {
    return new \FormLogic\Controllers\McpController(
        $c->get(\FormLogic\Services\McpTokenService::class),
        $c->get(FormService::class),
        $c->get(\FormLogic\Services\AppService::class),
        $c->get(ResponseService::class),
        $c->get(AuditService::class),
        $c->get(LoggerInterface::class),
        $c->get(\FormLogic\Services\AppReportService::class)
    );
});

// Billing: pay-as-you-go cloud months via PayPal (one-time captures, no subscription).
$container->set(\FormLogic\Services\PayPalService::class, function () {
    return new \FormLogic\Services\PayPalService();
});
$container->set(\FormLogic\Controllers\BillingController::class, function (Container $c) {
    return new \FormLogic\Controllers\BillingController(
        $c->get(\FormLogic\Services\PayPalService::class),
        $c->get(MySQLConnection::class),
        $c->get(AuditService::class),
        $c->get(LoggerInterface::class),
        $c->get(\FormLogic\Services\PlanService::class)
    );
});

$container->set(ExternalApiController::class, function (Container $c) {
    return new ExternalApiController(
        $c->get(FormService::class),
        $c->get(ResponseService::class),
        $c->get(WebhookService::class),
        $c->get(\FormLogic\Services\EmailService::class),
        $c->get(AuditService::class),
        $c->get(LoggerInterface::class)
    );
});

// Register App services
$container->set(AppService::class, function (Container $c) {
    return new AppService(
        $c->get(MySQLConnection::class),
        $c->get(FormService::class)
    );
});

$container->set(AppUserService::class, function (Container $c) {
    return new AppUserService(
        $c->get(MySQLConnection::class)
    );
});

// Validates/sanitizes saved report definitions against an app (used on every reports save path).
$container->set(\FormLogic\Services\AppReportService::class, function (Container $c) {
    return new \FormLogic\Services\AppReportService(
        $c->get(AppService::class),
        $c->get(FormService::class)
    );
});

$container->set(AppResponseService::class, function (Container $c) {
    return new AppResponseService(
        $c->get(MySQLConnection::class),
        $c->get(SQLiteConnection::class),
        $c->get(ResponseService::class),
        $c->get(FormLogicRuntime::class),
        $c->get(FormService::class)
    );
});

// Register App controllers
$container->set(AppController::class, function (Container $c) {
    return new AppController(
        $c->get(AppService::class),
        $c->get(LoggerInterface::class),
        $c->get(AuditService::class),
        $c->get(\FormLogic\Services\AppReportService::class)
    );
});

$container->set(AppUserController::class, function (Container $c) {
    return new AppUserController(
        $c->get(AppUserService::class),
        $c->get(AppService::class),
        $c->get(AuditService::class),
        $c->get(\FormLogic\Services\EmailService::class)
    );
});

$container->set(AppPublicController::class, function (Container $c) {
    return new AppPublicController(
        $c->get(AppService::class),
        $c->get(AppUserService::class),
        $c->get(AppResponseService::class),
        $c->get(FormService::class),
        $c->get(ResponseService::class),
        $c->get(MySQLConnection::class),
        $c->get(SQLiteConnection::class)
    );
});

// Form-scoped report execution (section-screen widget dashboards outside the app runtime).
$container->set(\FormLogic\Controllers\FormReportController::class, function (Container $c) {
    return new \FormLogic\Controllers\FormReportController(
        $c->get(FormService::class),
        $c->get(SQLiteConnection::class),
        $c->get(AppService::class),
        $c->get(\FormLogic\Services\AppReportService::class)
    );
});

// Create app
$app = SlimBridge::create($container);

// Add body parsing middleware
$app->addBodyParsingMiddleware();

// Add error middleware with JSON error handler
$errorMiddleware = $app->addErrorMiddleware(
    $settings['settings']['displayErrorDetails'],
    $settings['settings']['logErrors'],
    $settings['settings']['logErrorDetails']
);

// Custom JSON error handler
$errorHandler = $errorMiddleware->getDefaultErrorHandler();
$appLogger = $container->get(LoggerInterface::class);
$errorMiddleware->setDefaultErrorHandler(function (
    \Psr\Http\Message\ServerRequestInterface $request,
    \Throwable $exception,
    bool $displayErrorDetails,
    bool $logErrors,
    bool $logErrorDetails
) use ($app, $appLogger) {
    // Log unhandled exceptions through Monolog. Routine routing errors (404/405
    // and other 4xx HttpExceptions) are logged at info WITHOUT a stack trace, so
    // bot/scanner traffic to nonexistent paths can't flood the error log with
    // multi-KB traces; genuine 5xx faults keep the full trace for debugging.
    if ($logErrors) {
        $httpCode = $exception instanceof \Slim\Exception\HttpException ? (int) $exception->getCode() : 0;
        if ($httpCode >= 400 && $httpCode < 500) {
            $appLogger->info('HTTP client error: ' . $exception->getMessage(), [
                'exception' => get_class($exception),
                'status' => $httpCode,
                'uri' => (string) $request->getUri(),
                'method' => $request->getMethod(),
            ]);
        } else {
            $appLogger->error('Unhandled exception: ' . $exception->getMessage(), [
                'exception' => get_class($exception),
                'file' => $exception->getFile() . ':' . $exception->getLine(),
                'uri' => (string) $request->getUri(),
                'method' => $request->getMethod(),
                // Trace goes to the server log only — never to the HTTP response.
                'trace' => $exception->getTraceAsString(),
            ]);
        }
    }
    $payload = [
        'error' => true,
        'message' => $displayErrorDetails ? $exception->getMessage() : 'Internal Server Error',
    ];

    $response = $app->getResponseFactory()->createResponse();
    $response->getBody()->write(json_encode($payload));

    $statusCode = 500;
    if ($exception instanceof \Slim\Exception\HttpException) {
        $statusCode = $exception->getCode() ?: 500;
        // Slim's HttpException uses getCode() for HTTP status, but it might be 0
        // HttpNotFoundException, HttpMethodNotAllowedException, etc. set the code properly
        // For extra safety, also check if there's a getStatusCode method
        if (method_exists($exception, 'getStatusCode')) {
            $statusCode = $exception->getStatusCode();
        }
    }

    return $response
        ->withStatus($statusCode)
        ->withHeader('Content-Type', 'application/json');
});

// Auth cookie name used by CSRF and Auth middleware
$cookieName = $settings['settings']['cookie']['name'] ?? 'formlogic_auth';

// Secret used to bind CSRF tokens to the auth session (HMAC). Derived from the
// JWT secret so it's stable and needs no extra config. Must match the value the
// AuthController uses when issuing the CSRF cookie.
$csrfSecret = hash('sha256', 'formlogic-csrf:' . ($settings['settings']['jwt']['secret'] ?? ''));

// Add CSRF middleware (validates tokens on state-changing requests)
$app->add(new CsrfMiddleware('formlogic_csrf', 'X-CSRF-Token', $cookieName, $csrfSecret));

// Make the shared public "Demo" account read-only on the server (its visitors' data lives in their
// browser via the client overlay). Self-contained token check, so global placement is fine.
$app->add(new \FormLogic\Middleware\DemoReadOnlyMiddleware(
    $container->get(AuthService::class),
    $_ENV['DEMO_EMAIL'] ?? 'demo@formlogic.local',
    $cookieName
));

// Add CORS middleware with allowlist support
$corsSettings = $settings['settings']['cors'];
$app->add(new CorsMiddleware(
    $corsSettings['origin'],
    $corsSettings['allowedOrigins'] ?? null
));

// Add security headers middleware
$app->add(new SecurityHeadersMiddleware($settings['settings']['isProduction'] ?? false));

// Global body-size safety net. It must accommodate the largest legitimate body —
// pack zip uploads (packs.maxZipSize) are larger than ordinary file uploads —
// plus multipart/base64 envelope overhead. Stricter per-route/per-field limits
// are still enforced in the upload/pack handlers.
$uploadMax = $settings['settings']['uploads']['maxFileSize'] ?? (10 * 1024 * 1024);
$packMax = $settings['settings']['packs']['maxZipSize'] ?? (50 * 1024 * 1024);
$maxBodySize = max($uploadMax, $packMax) + (16 * 1024 * 1024);
$app->add(new BodySizeLimitMiddleware($maxBodySize));

// Create auth middleware instances
$authRequired = new AuthMiddleware($container->get(AuthService::class), false, $cookieName);
$authOptional = new AuthMiddleware($container->get(AuthService::class), true, $cookieName);

// Routes
$app->options('/{routes:.+}', function ($request, $response) {
    return $response;
});

// Health check
$app->get('/api/health', function ($request, $response) {
    $response->getBody()->write(json_encode([
        'status' => 'ok',
        'timestamp' => date('c'),
    ]));
    return $response->withHeader('Content-Type', 'application/json');
});

// Deep diagnostics ("Doctor") — protected; surfaces broken DB / unwritable dirs / missing
// QuickJS / billing misconfig that would otherwise fail silently.
$container->set(\FormLogic\Controllers\HealthController::class, function (Container $c) {
    // DocumentConverter's constructor can throw on a misconfigured temp dir; the Doctor
    // endpoint must degrade gracefully, so pass null on failure (deep() rebuilds defensively).
    $docs = null;
    try { $docs = $c->get(DocumentConverter::class); } catch (\Throwable $e) { $docs = null; }
    return new \FormLogic\Controllers\HealthController(
        $c->get(MySQLConnection::class),
        $c->get('settings'),
        $c->get(\FormLogic\Services\PayPalService::class),
        $docs
    );
});
$app->get('/api/health/deep', function ($request, $response) use ($container) {
    return $container->get(\FormLogic\Controllers\HealthController::class)->deep($request, $response);
})->add($authRequired);

// Auth routes (public, rate limited)
// Shared persistent rate-limit store so every limit below holds across requests
// and worker processes (not just within a single PHP process).
$rateLimiter = new \FormLogic\Services\RateLimiter($container->get(MySQLConnection::class)->getConnection());

$authRateLimiter = new RateLimitMiddleware($rateLimiter, 10, 60, 'auth');
$app->group('/api/auth', function (RouteCollectorProxy $group) {
    $group->post('/register', [AuthController::class, 'register']);
    $group->post('/login', [AuthController::class, 'login']);
    $group->post('/forgot-password', [AuthController::class, 'forgotPassword']);
    $group->post('/reset-password', [AuthController::class, 'resetPassword']);
})->add($authRateLimiter);

// Auth routes (protected)
$app->group('/api/auth', function (RouteCollectorProxy $group) {
    $group->get('/me', [AuthController::class, 'me']);
    $group->put('/me', [AuthController::class, 'updateProfile']);
    $group->get('/me/export', [AuthController::class, 'exportData']);
    $group->delete('/me', [AuthController::class, 'deleteAccount']);
    $group->post('/logout', [AuthController::class, 'logout']);
})->add($authRequired);

// Public no-signup demo: start a shared "Demo" session (mints a cookie, no password)
// and list the demoable apps for the landing page. Rate-limited to deter abuse.
$demoRateLimiter = new RateLimitMiddleware($rateLimiter, 20, 60, 'demo');
$app->post('/api/demo/start', [AuthController::class, 'demoStart'])->add($demoRateLimiter);
$app->get('/api/demo/apps', [AuthController::class, 'demoApps']);

// AI routes - status is public, everything else requires auth
$app->get('/api/ai/status', function ($request, $response) use ($container) {
    return $container->get(AIController::class)->status($request, $response);
});

// AI endpoints are expensive (paid OpenAI calls + document-conversion subprocesses),
// so they get a strict PER-USER rate limit on top of auth. The file-conversion
// route shells out to libreoffice/gs/pdftoppm and is throttled harder.
// keyByUser is safe here because $authRequired runs first and sets userId.
$aiRateLimiter = new RateLimitMiddleware($rateLimiter, 15, 60, 'ai', true);
$aiFileRateLimiter = new RateLimitMiddleware($rateLimiter, 5, 60, 'ai_file', true);

// Protected AI routes (require authentication to prevent abuse)
$app->group('/api/ai', function (RouteCollectorProxy $group) use ($container, $aiFileRateLimiter) {
    // Form generation from text prompt
    $group->post('/generate-form', function ($request, $response) use ($container) {
        return $container->get(AIController::class)->generateForm($request, $response);
    });

    // Form generation from file upload (PDF, Word, image) — extra-throttled (subprocesses)
    $group->post('/generate-form-from-file', function ($request, $response) use ($container) {
        return $container->get(AIController::class)->generateFormFromFile($request, $response);
    })->add($aiFileRateLimiter);

    // Script generation
    $group->post('/generate-script', function ($request, $response) use ($container) {
        return $container->get(AIController::class)->generateScript($request, $response);
    });

    // Script improvement
    $group->post('/improve-script', function ($request, $response) use ($container) {
        return $container->get(AIController::class)->improveScript($request, $response);
    });

    // App plan generation (AI App Builder) — turns a prompt into a multi-form app plan.
    $group->post('/generate-app-plan', function ($request, $response) use ($container) {
        return $container->get(AIController::class)->generateAppPlan($request, $response);
    });

    // Custom screen generation — a sandboxed HTML/CSS/JS UI over a form, targeting the FormLogic SDK.
    $group->post('/generate-screen', function ($request, $response) use ($container) {
        return $container->get(AIController::class)->generateScreen($request, $response);
    });
})->add($aiRateLimiter)->add($authRequired);

// Helper function to get route args
$getArgs = function ($request) {
    $routeContext = \Slim\Routing\RouteContext::fromRequest($request);
    return $routeContext->getRoute()->getArguments();
};

// Rate limiter for form creation/duplication (20 per minute per IP)
$formMutationRateLimiter = new RateLimitMiddleware($rateLimiter, 20, 60, 'form_mutation');

// Blocks content-creating writes when the owning account's cloud access has lapsed
// (no-op unless CLOUD_PLAN_ENFORCED=true). Reads/exports/deletes always pass.
$cloudWriteGate = new \FormLogic\Middleware\CloudWriteGateMiddleware($container->get(\FormLogic\Services\PlanService::class));

// Form routes (protected for management)
$app->group('/api/forms', function (RouteCollectorProxy $group) use ($container, $getArgs, $formMutationRateLimiter) {
    $group->get('', function ($request, $response) use ($container) {
        return $container->get(FormController::class)->index($request, $response);
    });
    $group->post('', function ($request, $response) use ($container) {
        return $container->get(FormController::class)->create($request, $response);
    })->add($formMutationRateLimiter);
    $group->get('/{id}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(FormController::class)->show($request, $response, $getArgs($request));
    });
    $group->put('/{id}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(FormController::class)->update($request, $response, $getArgs($request));
    });
    $group->delete('/{id}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(FormController::class)->delete($request, $response, $getArgs($request));
    });
    $group->post('/{id}/duplicate', function ($request, $response) use ($container, $getArgs) {
        return $container->get(FormController::class)->duplicate($request, $response, $getArgs($request));
    })->add($formMutationRateLimiter);
})->add($cloudWriteGate)->add($authRequired);  // Require authentication for form management; block writes when cloud lapsed

// Webhook routes (protected - require authentication + form ownership)
$app->group('/api/forms/{id}/webhooks', function (RouteCollectorProxy $group) use ($container, $getArgs) {
    $group->get('', function ($request, $response) use ($container, $getArgs) {
        return $container->get(WebhookController::class)->listWebhooks($request, $response, $getArgs($request));
    });
    $group->post('', function ($request, $response) use ($container, $getArgs) {
        return $container->get(WebhookController::class)->createWebhook($request, $response, $getArgs($request));
    });
    $group->put('/{webhookId}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(WebhookController::class)->updateWebhook($request, $response, $getArgs($request));
    });
    $group->delete('/{webhookId}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(WebhookController::class)->deleteWebhook($request, $response, $getArgs($request));
    });
    $group->get('/{webhookId}/deliveries', function ($request, $response) use ($container, $getArgs) {
        return $container->get(WebhookController::class)->getDeliveries($request, $response, $getArgs($request));
    });
})->add($authRequired);

// Form version routes (protected)
$app->group('/api/forms/{id}/versions', function (RouteCollectorProxy $group) use ($container, $getArgs) {
    $group->get('', function ($request, $response) use ($container, $getArgs) {
        return $container->get(FormController::class)->listVersions($request, $response, $getArgs($request));
    });
    $group->get('/{version}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(FormController::class)->getVersion($request, $response, $getArgs($request));
    });
    $group->post('/{version}/restore', function ($request, $response) use ($container, $getArgs) {
        return $container->get(FormController::class)->restoreVersion($request, $response, $getArgs($request));
    });
})->add($authRequired);

// Create rate limiter for public endpoints (30 submissions per minute per IP)
$submissionRateLimiter = new RateLimitMiddleware($rateLimiter, 30, 60, 'submission');

// Running sandboxed user scripts (script test / recompute) spawns a qjs
// subprocess and can make ctx.http calls, so cap it per user like the AI endpoints.
$scriptTestRateLimiter = new RateLimitMiddleware($rateLimiter, 15, 60, 'script_test', true);

// Response routes (protected - require authentication)
$app->group('/api/forms/{formId}/responses', function (RouteCollectorProxy $group) use ($container, $getArgs, $authRequired, $scriptTestRateLimiter) {
    // List responses (requires auth)
    $group->get('', function ($request, $response) use ($container, $getArgs) {
        return $container->get(ResponseController::class)->index($request, $response, $getArgs($request));
    })->add($authRequired);

    // Export responses (requires auth)
    $group->get('/export', function ($request, $response) use ($container, $getArgs) {
        return $container->get(ResponseController::class)->export($request, $response, $getArgs($request));
    })->add($authRequired);

    // Import CSV responses (requires auth)
    $group->post('/import', function ($request, $response) use ($container, $getArgs) {
        return $container->get(ResponseController::class)->importCsv($request, $response, $getArgs($request));
    })->add($authRequired);

    // Single response operations
    $group->get('/{id}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(ResponseController::class)->show($request, $response, $getArgs($request));
    })->add($authRequired);
    $group->put('/{id}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(ResponseController::class)->update($request, $response, $getArgs($request));
    })->add($authRequired);
    $group->delete('/{id}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(ResponseController::class)->delete($request, $response, $getArgs($request));
    })->add($authRequired);

    // Re-run script on a response (requires auth; rate-limited — runs user code)
    $group->post('/{id}/recompute', function ($request, $response) use ($container, $getArgs) {
        return $container->get(ResponseController::class)->recompute($request, $response, $getArgs($request));
    })->add($scriptTestRateLimiter)->add($authRequired);
});

// Public form submission endpoint (rate limited, no auth required). Gated so a form
// whose owner's cloud has lapsed stops accepting responses until they top up.
$app->post('/api/forms/{formId}/responses', function ($request, $response) use ($container, $getArgs) {
    return $container->get(ResponseController::class)->create($request, $response, $getArgs($request));
})->add($cloudWriteGate)->add($submissionRateLimiter);

// Record a form "start" (first interaction) for the analytics funnel. Best-effort,
// fire-and-forget; rate-limited like submissions.
$app->post('/api/forms/{formId}/start', function ($request, $response) use ($container, $getArgs) {
    try {
        $container->get(\FormLogic\Services\ResponseService::class)->recordStart($getArgs($request)['formId']);
    } catch (\Throwable $e) { /* analytics is non-critical */ }
    return $response->withStatus(204);
})->add($submissionRateLimiter);

// File upload for standalone forms (no auth required since forms can be public).
// Gated on the form owner's cloud access (storage is a hosted cost).
$app->post('/api/forms/{formId}/upload', function ($request, $response) use ($container, $getArgs) {
    return $container->get(FileController::class)->upload($request, $response, $getArgs($request));
})->add($cloudWriteGate)->add($submissionRateLimiter);

// File serving. Public for standalone published forms; app-scoped/unpublished
// forms are access-controlled inside serve(). authOptional populates userId when
// a valid token is present without rejecting anonymous requests for public files.
$app->get('/api/files/{formId}/{fileId}/{filename}', function ($request, $response) use ($container, $getArgs) {
    return $container->get(FileController::class)->serve($request, $response, $getArgs($request));
})->add($authOptional);

// Analytics routes (protected)
$app->get('/api/forms/{formId}/analytics', function ($request, $response) use ($container, $getArgs) {
    return $container->get(ResponseController::class)->analytics($request, $response, $getArgs($request));
})->add($authRequired);

// Owner-scoped linked-record lookup (protected) — lets linked_record fields work on standalone /
// pack forms that aren't inside an app. Returns only the caller's own data.
$app->get('/api/forms/{formId}/lookup', function ($request, $response) use ($container, $getArgs) {
    return $container->get(ResponseController::class)->lookupOwnedRecords($request, $response, $getArgs($request));
})->add($authRequired);

// Owner-scoped report execution — powers form section-screen widget dashboards in the builder
// preview / play route / standalone (non-app) forms. Read-only; the owner sees all their responses.
$app->post('/api/forms/{id}/reports/run', function ($request, $response) use ($container, $getArgs) {
    return $container->get(\FormLogic\Controllers\FormReportController::class)->runOwner($request, $response, $getArgs($request));
})->add($authRequired);
$app->post('/api/forms/{id}/reports/run-batch', function ($request, $response) use ($container, $getArgs) {
    return $container->get(\FormLogic\Controllers\FormReportController::class)->runOwnerBatch($request, $response, $getArgs($request));
})->add($authRequired);

// Test an onSubmit script against sample answers without persisting (protected,
// rate-limited per user — runs sandboxed user code + may make ctx.http calls)
$app->post('/api/forms/{formId}/script/test', function ($request, $response) use ($container, $getArgs) {
    return $container->get(ResponseController::class)->testScript($request, $response, $getArgs($request));
})->add($scriptTestRateLimiter)->add($authRequired);

// Export routes (protected)
$app->get('/api/forms/{formId}/export/sqlite', function ($request, $response) use ($container, $getArgs) {
    return $container->get(ResponseController::class)->exportSqlite($request, $response, $getArgs($request));
})->add($authRequired);

$app->get('/api/forms/{formId}/export/json', function ($request, $response) use ($container, $getArgs) {
    return $container->get(ResponseController::class)->exportJson($request, $response, $getArgs($request));
})->add($authRequired);

// Create rate limiter for public form viewing (60 requests per minute per IP)
$publicFormRateLimiter = new RateLimitMiddleware($rateLimiter, 60, 60, 'public_form');

// Public form view (for embedding/sharing) - rate limited to prevent enumeration
$app->get('/api/public/forms/{id}', function ($request, $response) use ($container, $getArgs) {
    $formService = $container->get(FormService::class);
    $args = $getArgs($request);
    $form = $formService->getForm($args['id']);

    if (!$form) {
        $response->getBody()->write(json_encode([
            'error' => true,
            'message' => 'Form not found',
        ]));
        return $response->withStatus(404)->withHeader('Content-Type', 'application/json');
    }

    if ($form['status'] !== 'published') {
        $response->getBody()->write(json_encode([
            'error' => true,
            'message' => 'Form is not available',
        ]));
        return $response->withStatus(403)->withHeader('Content-Type', 'application/json');
    }

    // App-scoped forms are served through the authenticated app runtime
    // (/api/app/{slug}), which enforces membership — don't expose their structure
    // anonymously via this standalone endpoint (mirrors FileController::serve).
    if ($container->get(\FormLogic\Services\AppService::class)->isFormInAnyApp($args['id'])) {
        $response->getBody()->write(json_encode([
            'error' => true,
            'message' => 'Form not found',
        ]));
        return $response->withStatus(404)->withHeader('Content-Type', 'application/json');
    }

    // Record a view for analytics (best-effort; never blocks form serving).
    try {
        $container->get(\FormLogic\Services\ResponseService::class)->recordView($args['id']);
    } catch (\Throwable $e) { /* analytics is non-critical */ }

    // Return form without sensitive data (incl. the owner's private notification
    // settings, e.g. notificationEmail).
    unset($form['userId']);
    unset($form['logicScript']);
    unset($form['logicPrompt']);
    if (isset($form['settings']) && is_array($form['settings'])) {
        unset($form['settings']['notifications']);
    }
    $response->getBody()->write(json_encode(['form' => $form]));
    return $response->withHeader('Content-Type', 'application/json');
})->add($publicFormRateLimiter);

// Public records for a custom screen (e.g. a leaderboard) — ONLY when the form's custom screen has
// opted in via customScreen.publicRecords. Returns answers only (no submitter metadata/status/tags).
$app->get('/api/public/forms/{id}/screen-records', function ($request, $response) use ($container, $getArgs) {
    $args = $getArgs($request);
    $form = $container->get(FormService::class)->getForm($args['id']);
    if (!$form || ($form['status'] ?? '') !== 'published') {
        $response->getBody()->write(json_encode(['error' => true, 'message' => 'Form not found']));
        return $response->withStatus(404)->withHeader('Content-Type', 'application/json');
    }
    if (empty($form['customScreen']['publicRecords'])) {
        $response->getBody()->write(json_encode(['error' => true, 'message' => 'Public records are not enabled for this form']));
        return $response->withStatus(403)->withHeader('Content-Type', 'application/json');
    }
    // App-scoped forms are served through the authenticated app runtime (mirror the public form gate).
    if ($container->get(\FormLogic\Services\AppService::class)->isFormInAnyApp($args['id'])) {
        $response->getBody()->write(json_encode(['error' => true, 'message' => 'Form not found']));
        return $response->withStatus(404)->withHeader('Content-Type', 'application/json');
    }
    // Only expose the whitelisted answer fields — never the whole response (PII/internal/hidden values).
    // No whitelist => no answer data (secure default; the owner must explicitly pick public fields).
    $allowed = array_values(array_filter(
        is_array($form['customScreen']['publicRecordFields'] ?? null) ? $form['customScreen']['publicRecordFields'] : [],
        'is_string'
    ));
    $limit = max(1, min((int) ($request->getQueryParams()['limit'] ?? 100), 200));
    $rows = $container->get(\FormLogic\Services\ResponseService::class)->getFormResponses($args['id'], ['limit' => $limit]);
    $records = array_map(static function ($r) use ($allowed) {
        $answers = is_array($r['answers'] ?? null) ? $r['answers'] : [];
        $safe = [];
        foreach ($allowed as $key) {
            if (array_key_exists($key, $answers)) {
                $safe[$key] = $answers[$key];
            }
        }
        return ['id' => $r['id'] ?? null, 'answers' => $safe, 'submittedAt' => $r['submittedAt'] ?? null];
    }, $rows);
    $response->getBody()->write(json_encode(['records' => $records]));
    return $response->withHeader('Content-Type', 'application/json');
})->add($publicFormRateLimiter);

// Public widget-dashboard report execution — same gate as /screen-records (publicRecords + whitelist,
// no joins, no status). Read-only aggregate over the form's own responses.
$app->post('/api/public/forms/{id}/reports/run', function ($request, $response) use ($container, $getArgs) {
    return $container->get(\FormLogic\Controllers\FormReportController::class)->runPublic($request, $response, $getArgs($request));
})->add($publicFormRateLimiter);
$app->post('/api/public/forms/{id}/reports/run-batch', function ($request, $response) use ($container, $getArgs) {
    return $container->get(\FormLogic\Controllers\FormReportController::class)->runPublicBatch($request, $response, $getArgs($request));
})->add($publicFormRateLimiter);

// Pack management routes (protected)
$app->post('/api/packs/import', function ($request, $response) use ($container) {
    return $container->get(PackController::class)->import($request, $response);
})->add($authRequired);

// Bundled sample apps ("Try a sample app")
$app->get('/api/sample-apps', function ($request, $response) use ($container) {
    return $container->get(PackController::class)->listSampleApps($request, $response);
})->add($authRequired);
$app->post('/api/sample-apps/{id}/install', function ($request, $response) use ($container, $getArgs) {
    return $container->get(PackController::class)->installSampleApp($request, $response, $getArgs($request));
})->add($authRequired);

$app->post('/api/packs/adopt', function ($request, $response) use ($container) {
    return $container->get(PackController::class)->adopt($request, $response);
})->add($authRequired);

$app->get('/api/packs/installed', function ($request, $response) use ($container) {
    return $container->get(PackController::class)->listInstalled($request, $response);
})->add($authRequired);

$app->delete('/api/packs/{installationId}', function ($request, $response) use ($container, $getArgs) {
    return $container->get(PackController::class)->uninstall($request, $response, $getArgs($request));
})->add($authRequired);

// Pack Marketplace routes (must register /mine and /upload before /{slug})
$app->get('/api/packs/catalog/mine', function ($request, $response) use ($container) {
    return $container->get(PackCatalogController::class)->myPacks($request, $response);
})->add($authRequired);

$app->get('/api/packs/catalog', function ($request, $response) use ($container) {
    return $container->get(PackCatalogController::class)->browse($request, $response);
})->add($authOptional);

// Dynamic browse facets (categories + tags in use). Static segment, so FastRoute
// resolves it ahead of /catalog/{slug}; registered here beside the other catalog reads.
$app->get('/api/packs/catalog/facets', function ($request, $response) use ($container) {
    return $container->get(PackCatalogController::class)->facets($request, $response);
})->add($authOptional);

// Serve marketplace pack thumbnails (public). Official packs' shots are committed under
// resources/pack-screenshots; runtime-captured ones land in storage/pack-screenshots and take
// precedence. Filename is sanitised to a flat basename to prevent path traversal.
$app->get('/api/packs/screenshots/{file}', function ($request, $response) use ($getArgs) {
    $file = (string)($getArgs($request)['file'] ?? '');
    $file = basename($file);
    if (!preg_match('/^[A-Za-z0-9._-]+\.(png|jpg|jpeg|webp)$/', $file)) {
        return $response->withStatus(404);
    }
    $dirs = [__DIR__ . '/../storage/pack-screenshots', __DIR__ . '/../resources/pack-screenshots'];
    foreach ($dirs as $dir) {
        $path = $dir . '/' . $file;
        if (is_file($path)) {
            $ext = strtolower(pathinfo($file, PATHINFO_EXTENSION));
            $mime = $ext === 'png' ? 'image/png' : ($ext === 'webp' ? 'image/webp' : 'image/jpeg');
            // Thumbnails are regenerated IN PLACE under stable filenames, so a plain max-age left
            // browsers showing day-old images after a re-capture. Serve with validators and force
            // revalidation: unchanged files still answer with a cheap 304.
            $mtime = (int) filemtime($path);
            $etag = '"' . md5($file . ':' . $mtime . ':' . filesize($path)) . '"';
            $ifNoneMatch = trim($request->getHeaderLine('If-None-Match'));
            $ifModifiedSince = strtotime($request->getHeaderLine('If-Modified-Since')) ?: 0;
            $headers = static fn ($r) => $r
                ->withHeader('Content-Type', $mime)
                ->withHeader('Cache-Control', 'public, no-cache')
                ->withHeader('ETag', $etag)
                ->withHeader('Last-Modified', gmdate('D, d M Y H:i:s', $mtime) . ' GMT');
            if ($ifNoneMatch === $etag || ($ifNoneMatch === '' && $ifModifiedSince >= $mtime)) {
                return $headers($response)->withStatus(304);
            }
            $response->getBody()->write((string)file_get_contents($path));
            return $headers($response);
        }
    }
    return $response->withStatus(404);
});

$app->post('/api/packs/catalog', function ($request, $response) use ($container) {
    return $container->get(PackCatalogController::class)->publish($request, $response);
})->add($authRequired);

$app->post('/api/packs/catalog/upload', function ($request, $response) use ($container) {
    return $container->get(PackCatalogController::class)->uploadZip($request, $response);
})->add($authRequired);

$app->post('/api/packs/catalog/seed', function ($request, $response) use ($container) {
    // Any authenticated user may trigger the one-time bootstrap so a brand-new
    // tenant whose first user happens to be a non-owner doesn't get a
    // permanently empty marketplace. The controller is idempotent (it only seeds
    // when the catalog is empty), and the official packs are attributed to the
    // platform owner (first registered user) regardless of who triggers it, so
    // a non-owner can't end up owning/editing the seeded packs.
    $userId = $request->getAttribute('userId');
    if (!$userId) {
        $response->getBody()->write(json_encode(['error' => true, 'message' => 'Authentication required']));
        return $response->withStatus(401)->withHeader('Content-Type', 'application/json');
    }
    $mysql = $container->get(MySQLConnection::class)->getConnection();
    $stmt = $mysql->prepare("SELECT id FROM users ORDER BY created_at ASC LIMIT 1");
    $stmt->execute();
    $firstUser = $stmt->fetch();
    $ownerId = $firstUser['id'] ?? $userId;
    $request = $request->withAttribute('userId', $ownerId);
    return $container->get(PackCatalogController::class)->seed($request, $response);
})->add($authRequired);

$app->get('/api/packs/catalog/{slug}', function ($request, $response) use ($container, $getArgs) {
    return $container->get(PackCatalogController::class)->detail($request, $response, $getArgs($request));
})->add($authOptional);

$app->get('/api/packs/catalog/{slug}/download', function ($request, $response) use ($container, $getArgs) {
    return $container->get(PackCatalogController::class)->download($request, $response, $getArgs($request));
})->add($authOptional);

$app->post('/api/packs/catalog/{slug}/versions', function ($request, $response) use ($container, $getArgs) {
    return $container->get(PackCatalogController::class)->publishVersion($request, $response, $getArgs($request));
})->add($authRequired);

$app->put('/api/packs/catalog/{slug}', function ($request, $response) use ($container, $getArgs) {
    return $container->get(PackCatalogController::class)->update($request, $response, $getArgs($request));
})->add($authRequired);

$app->delete('/api/packs/catalog/{slug}', function ($request, $response) use ($container, $getArgs) {
    return $container->get(PackCatalogController::class)->archive($request, $response, $getArgs($request));
})->add($authRequired);

// Pack ratings
$app->post('/api/packs/catalog/{slug}/ratings', function ($request, $response) use ($container, $getArgs) {
    return $container->get(PackRatingController::class)->rate($request, $response, $getArgs($request));
})->add($authRequired);

$app->get('/api/packs/catalog/{slug}/ratings', function ($request, $response) use ($container, $getArgs) {
    return $container->get(PackRatingController::class)->listRatings($request, $response, $getArgs($request));
})->add($authOptional);

$app->delete('/api/packs/catalog/{slug}/ratings', function ($request, $response) use ($container, $getArgs) {
    return $container->get(PackRatingController::class)->deleteRating($request, $response, $getArgs($request));
})->add($authRequired);

// API Key management routes (cookie auth, protected, rate limited)
$apiKeyMgmtRateLimiter = new RateLimitMiddleware($rateLimiter, 10, 60, 'api_key_mgmt');
$app->group('/api/api-keys', function (RouteCollectorProxy $group) use ($container, $getArgs) {
    $group->get('', function ($request, $response) use ($container) {
        return $container->get(ApiKeyController::class)->index($request, $response);
    });
    $group->post('', function ($request, $response) use ($container) {
        return $container->get(ApiKeyController::class)->create($request, $response);
    });
    $group->delete('/{id}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(ApiKeyController::class)->revoke($request, $response, $getArgs($request));
    });
})->add($authRequired)->add($apiKeyMgmtRateLimiter);

// MCP server (Model Context Protocol over HTTP). The endpoint self-authenticates via the Bearer MCP
// token — NO session middleware. Token management below is session-authenticated (the app owner).
$mcpRateLimiter = new RateLimitMiddleware($rateLimiter, 120, 60, 'mcp');
$app->post('/api/mcp', function ($request, $response) use ($container) {
    return $container->get(\FormLogic\Controllers\McpController::class)->handle($request, $response);
})->add($mcpRateLimiter);

$app->group('/api/mcp/tokens', function (RouteCollectorProxy $group) use ($container, $getArgs) {
    $group->get('', function ($request, $response) use ($container) {
        return $container->get(\FormLogic\Controllers\McpController::class)->listTokens($request, $response);
    });
    $group->post('', function ($request, $response) use ($container) {
        return $container->get(\FormLogic\Controllers\McpController::class)->createToken($request, $response);
    });
    $group->delete('/{id}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(\FormLogic\Controllers\McpController::class)->revokeToken($request, $response, $getArgs($request));
    });
})->add($authRequired)->add($apiKeyMgmtRateLimiter);

// Billing (pay-as-you-go cloud months via PayPal) — authenticated, own rate-limit bucket.
$billingRateLimiter = new RateLimitMiddleware($rateLimiter, 30, 60, 'billing');
$app->group('/api/billing', function (RouteCollectorProxy $group) use ($container, $getArgs) {
    $group->get('', function ($request, $response) use ($container) {
        return $container->get(\FormLogic\Controllers\BillingController::class)->status($request, $response);
    });
    $group->post('/orders', function ($request, $response) use ($container) {
        return $container->get(\FormLogic\Controllers\BillingController::class)->createOrder($request, $response);
    });
    $group->post('/orders/{orderId}/capture', function ($request, $response) use ($container, $getArgs) {
        return $container->get(\FormLogic\Controllers\BillingController::class)->captureOrder($request, $response, $getArgs($request));
    });
})->add($authRequired)->add($billingRateLimiter);

// PayPal webhook (public — PayPal calls it; authenticated by verifying the event signature
// inside the handler). CSRF is skipped automatically for requests without an auth cookie.
$app->post('/api/billing/webhook/paypal', function ($request, $response) use ($container) {
    return $container->get(\FormLogic\Controllers\BillingController::class)->webhook($request, $response);
})->add(new RateLimitMiddleware($rateLimiter, 120, 60, 'paypal_webhook'));

// External API v1 routes (API key auth)
$apiRateLimiter = new RateLimitMiddleware($rateLimiter, 120, 60, 'api_v1');
$apiKeyService = $container->get(ApiKeyService::class);

$app->group('/api/v1', function (RouteCollectorProxy $group) use ($container, $getArgs, $apiKeyService, $rateLimiter) {
    // Forms (forms:read)
    $formsReadAuth = new ApiKeyMiddleware($apiKeyService, ['forms:read'], $rateLimiter);

    $group->get('/forms', function ($request, $response) use ($container) {
        return $container->get(ExternalApiController::class)->listForms($request, $response);
    })->add($formsReadAuth);

    $group->get('/forms/{formId}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(ExternalApiController::class)->getForm($request, $response, $getArgs($request));
    })->add($formsReadAuth);

    $group->get('/forms/{formId}/fields', function ($request, $response) use ($container, $getArgs) {
        return $container->get(ExternalApiController::class)->getFormFields($request, $response, $getArgs($request));
    })->add($formsReadAuth);

    // Response submission (responses:write)
    $responsesWriteAuth = new ApiKeyMiddleware($apiKeyService, ['responses:write'], $rateLimiter);

    $group->post('/forms/{formId}/responses', function ($request, $response) use ($container, $getArgs) {
        return $container->get(ExternalApiController::class)->submitResponse($request, $response, $getArgs($request));
    })->add($responsesWriteAuth);

    $group->post('/forms/{formId}/responses/batch', function ($request, $response) use ($container, $getArgs) {
        return $container->get(ExternalApiController::class)->batchSubmitResponses($request, $response, $getArgs($request));
    })->add($responsesWriteAuth);

    // Response reading (responses:read)
    $responsesReadAuth = new ApiKeyMiddleware($apiKeyService, ['responses:read'], $rateLimiter);

    $group->get('/forms/{formId}/responses', function ($request, $response) use ($container, $getArgs) {
        return $container->get(ExternalApiController::class)->listResponses($request, $response, $getArgs($request));
    })->add($responsesReadAuth);

    $group->get('/forms/{formId}/responses/{id}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(ExternalApiController::class)->getResponse($request, $response, $getArgs($request));
    })->add($responsesReadAuth);

    // Response management (responses:manage)
    $responsesManageAuth = new ApiKeyMiddleware($apiKeyService, ['responses:manage'], $rateLimiter);

    $group->put('/forms/{formId}/responses/{id}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(ExternalApiController::class)->updateResponse($request, $response, $getArgs($request));
    })->add($responsesManageAuth);

    $group->delete('/forms/{formId}/responses/{id}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(ExternalApiController::class)->deleteResponse($request, $response, $getArgs($request));
    })->add($responsesManageAuth);

    // Analytics (responses:read)
    $group->get('/forms/{formId}/analytics', function ($request, $response) use ($container, $getArgs) {
        return $container->get(ExternalApiController::class)->analytics($request, $response, $getArgs($request));
    })->add($responsesReadAuth);

    // Webhooks read (webhooks:read)
    $webhooksReadAuth = new ApiKeyMiddleware($apiKeyService, ['webhooks:read'], $rateLimiter);

    $group->get('/forms/{formId}/webhooks', function ($request, $response) use ($container, $getArgs) {
        return $container->get(ExternalApiController::class)->listWebhooks($request, $response, $getArgs($request));
    })->add($webhooksReadAuth);

    // Webhooks write (webhooks:write)
    $webhooksWriteAuth = new ApiKeyMiddleware($apiKeyService, ['webhooks:write'], $rateLimiter);

    $group->post('/forms/{formId}/webhooks', function ($request, $response) use ($container, $getArgs) {
        return $container->get(ExternalApiController::class)->createWebhook($request, $response, $getArgs($request));
    })->add($webhooksWriteAuth);

    $group->put('/forms/{formId}/webhooks/{webhookId}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(ExternalApiController::class)->updateWebhook($request, $response, $getArgs($request));
    })->add($webhooksWriteAuth);

    $group->delete('/forms/{formId}/webhooks/{webhookId}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(ExternalApiController::class)->deleteWebhook($request, $response, $getArgs($request));
    })->add($webhooksWriteAuth);
})->add($apiRateLimiter);

// Audit verification route (admin, protected — restricted to platform owner)
$app->get('/api/admin/audit/verify', function ($request, $response) use ($container) {
    $userId = $request->getAttribute('userId');
    if (!$userId) {
        $response->getBody()->write(json_encode(['error' => true, 'message' => 'Authentication required']));
        return $response->withStatus(401)->withHeader('Content-Type', 'application/json');
    }

    // Only the platform owner (first registered user) may verify the audit chain
    $mysql = $container->get(MySQLConnection::class)->getConnection();
    $stmt = $mysql->prepare("SELECT id FROM users ORDER BY created_at ASC LIMIT 1");
    $stmt->execute();
    $firstUser = $stmt->fetch();

    if (!$firstUser || $firstUser['id'] !== $userId) {
        $response->getBody()->write(json_encode(['error' => true, 'message' => 'Admin access required']));
        return $response->withStatus(403)->withHeader('Content-Type', 'application/json');
    }

    $auditService = $container->get(AuditService::class);
    $result = $auditService->verifyChain();
    $response->getBody()->write(json_encode($result));
    return $response->withHeader('Content-Type', 'application/json');
})->add($authRequired);

// App Admin routes (protected - require authentication + ownership)
$app->group('/api/apps', function (RouteCollectorProxy $group) use ($container, $getArgs) {
    $group->get('', function ($request, $response) use ($container) {
        return $container->get(AppController::class)->index($request, $response);
    });
    $group->post('', function ($request, $response) use ($container) {
        return $container->get(AppController::class)->create($request, $response);
    });
    $group->get('/{id}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppController::class)->show($request, $response, $getArgs($request));
    });
    $group->put('/{id}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppController::class)->update($request, $response, $getArgs($request));
    });
    $group->delete('/{id}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppController::class)->delete($request, $response, $getArgs($request));
    });
    // Export the whole app (forms + screens + scripts + roles) as a self-contained pack JSON.
    $group->get('/{id}/export', function ($request, $response) use ($container, $getArgs) {
        return $container->get(PackController::class)->exportApp($request, $response, $getArgs($request));
    });
    // Same, but as a downloadable .formlogic-app.json attachment (for API users).
    $group->get('/{id}/export/download', function ($request, $response) use ($container, $getArgs) {
        return $container->get(PackController::class)->exportAppDownload($request, $response, $getArgs($request));
    });

    // App form management
    $group->get('/{id}/forms', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppController::class)->listForms($request, $response, $getArgs($request));
    });
    $group->post('/{id}/forms', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppController::class)->addForm($request, $response, $getArgs($request));
    });
    $group->put('/{id}/forms/reorder', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppController::class)->reorderForms($request, $response, $getArgs($request));
    });
    $group->put('/{id}/forms/{formId}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppController::class)->updateForm($request, $response, $getArgs($request));
    });
    $group->delete('/{id}/forms/{formId}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppController::class)->removeForm($request, $response, $getArgs($request));
    });

    // Role management
    $group->get('/{appId}/roles', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppUserController::class)->listRoles($request, $response, $getArgs($request));
    });
    $group->post('/{appId}/roles', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppUserController::class)->createRole($request, $response, $getArgs($request));
    });
    $group->put('/{appId}/roles/{roleId}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppUserController::class)->updateRole($request, $response, $getArgs($request));
    });
    $group->delete('/{appId}/roles/{roleId}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppUserController::class)->deleteRole($request, $response, $getArgs($request));
    });

    // Permission management
    $group->get('/{appId}/roles/{roleId}/permissions', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppUserController::class)->getPermissions($request, $response, $getArgs($request));
    });
    $group->put('/{appId}/roles/{roleId}/permissions', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppUserController::class)->setPermissions($request, $response, $getArgs($request));
    });

    // User management
    $group->get('/{appId}/users', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppUserController::class)->listUsers($request, $response, $getArgs($request));
    });
    $group->put('/{appId}/users/{id}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppUserController::class)->updateUser($request, $response, $getArgs($request));
    });
    $group->delete('/{appId}/users/{id}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppUserController::class)->removeUser($request, $response, $getArgs($request));
    });

    // Invitation management
    $group->get('/{appId}/invitations', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppUserController::class)->listInvitations($request, $response, $getArgs($request));
    });
    $group->post('/{appId}/invitations', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppUserController::class)->createInvitation($request, $response, $getArgs($request));
    });
    $group->delete('/{appId}/invitations/{id}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppUserController::class)->revokeInvitation($request, $response, $getArgs($request));
    });

    // Accept invitation (just requires platform auth, no app ownership)
    $group->post('/invitations/accept', function ($request, $response) use ($container) {
        return $container->get(AppUserController::class)->acceptInvitation($request, $response);
    });

    // Group management
    $group->get('/{appId}/groups', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppUserController::class)->listGroups($request, $response, $getArgs($request));
    });
    $group->post('/{appId}/groups', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppUserController::class)->createGroup($request, $response, $getArgs($request));
    });
    $group->put('/{appId}/groups/{id}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppUserController::class)->updateGroup($request, $response, $getArgs($request));
    });
    $group->delete('/{appId}/groups/{id}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppUserController::class)->deleteGroup($request, $response, $getArgs($request));
    });
    $group->get('/{appId}/groups/{id}/members', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppUserController::class)->listGroupMembers($request, $response, $getArgs($request));
    });
    $group->post('/{appId}/groups/{id}/members/{memberId}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppUserController::class)->addGroupMember($request, $response, $getArgs($request));
    });
    $group->delete('/{appId}/groups/{id}/members/{memberId}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppUserController::class)->removeGroupMember($request, $response, $getArgs($request));
    });
})->add($authRequired);

// Rate limiter for app runtime submissions (30 per minute per IP, same as public submission)
$appSubmissionRateLimiter = new RateLimitMiddleware($rateLimiter, 30, 60, 'app_submission');

// App Runtime routes (public-facing, auth required for most)
$app->group('/api/app/{slug}', function (RouteCollectorProxy $group) use ($container, $getArgs, $authRequired, $appSubmissionRateLimiter, $cloudWriteGate) {
    // PWA manifest (public, no auth)
    $group->get('/manifest.json', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppPublicController::class)->manifest($request, $response, $getArgs($request));
    });

    // App config + forms + permissions (auth required)
    $group->get('', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppPublicController::class)->getApp($request, $response, $getArgs($request));
    })->add($authRequired);

    // User permissions
    $group->get('/my-permissions', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppPublicController::class)->getMyPermissions($request, $response, $getArgs($request));
    })->add($authRequired);

    // Membership status + self-registration (does NOT require membership)
    $group->get('/membership', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppPublicController::class)->membership($request, $response, $getArgs($request));
    })->add($authRequired);
    $group->post('/join', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppPublicController::class)->join($request, $response, $getArgs($request));
    })->add($authRequired);

    // Form in app context
    $group->get('/forms/{formId}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppPublicController::class)->getForm($request, $response, $getArgs($request));
    })->add($authRequired);

    // Linked record lookup
    $group->get('/forms/{formId}/lookup', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppPublicController::class)->lookupRecords($request, $response, $getArgs($request));
    })->add($authRequired);

    // Run a no-code report (read-only SELECT; POST carries the report spec). Whitelisted for the demo.
    $group->post('/reports/run', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppPublicController::class)->runReport($request, $response, $getArgs($request));
    })->add($authRequired);

    // Batch: run many specs in one round (a widget dashboard fetches all its charts at once).
    $group->post('/reports/run-batch', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppPublicController::class)->runReportBatch($request, $response, $getArgs($request));
    })->add($authRequired);

    // File upload for app forms — gated on the form owner's cloud access.
    $group->post('/forms/{formId}/upload', function ($request, $response) use ($container, $getArgs) {
        return $container->get(FileController::class)->appUpload($request, $response, $getArgs($request));
    })->add($cloudWriteGate)->add($authRequired);

    // Response CRUD
    $group->post('/forms/{formId}/responses', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppPublicController::class)->createResponse($request, $response, $getArgs($request));
    })->add($cloudWriteGate)->add($appSubmissionRateLimiter)->add($authRequired);

    $group->get('/forms/{formId}/responses', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppPublicController::class)->listResponses($request, $response, $getArgs($request));
    })->add($authRequired);

    // Export responses (CSV) — gated on the export_responses permission.
    $group->get('/forms/{formId}/export', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppPublicController::class)->exportResponses($request, $response, $getArgs($request));
    })->add($authRequired);

    // Aggregate analytics — gated on the view_analytics permission.
    $group->get('/forms/{formId}/analytics', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppPublicController::class)->analytics($request, $response, $getArgs($request));
    })->add($authRequired);

    $group->get('/forms/{formId}/responses/{id}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppPublicController::class)->getResponseById($request, $response, $getArgs($request));
    })->add($authRequired);

    // Related records (inverse relations)
    $group->get('/forms/{formId}/responses/{id}/related', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppPublicController::class)->getRelatedRecords($request, $response, $getArgs($request));
    })->add($authRequired);

    $group->put('/forms/{formId}/responses/{id}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppPublicController::class)->updateResponseById($request, $response, $getArgs($request));
    })->add($cloudWriteGate)->add($authRequired);

    $group->delete('/forms/{formId}/responses/{id}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppPublicController::class)->deleteResponseById($request, $response, $getArgs($request));
    })->add($authRequired);
});

// Run app
$app->run();

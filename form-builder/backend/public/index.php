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

require __DIR__ . '/../vendor/autoload.php';

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
    // Initialize schema on first run
    $mysql->initializeSchema();
    $mysql->runMigrations();
    return $mysql;
});

$container->set(SQLiteConnection::class, function (Container $c) {
    return new SQLiteConnection($c->get('settings')['sqlite']['storage_path']);
});

// Register services
$container->set(AuthService::class, function (Container $c) {
    $settings = $c->get('settings');
    return new AuthService(
        $c->get(MySQLConnection::class),
        $settings['jwt'],
        $settings['rateLimit']['login'] ?? []
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
$container->set(AuditService::class, function (Container $c) {
    return new AuditService(
        $c->get(MySQLConnection::class),
        $c->get(LoggerInterface::class)
    );
});

$container->set(FormService::class, function (Container $c) {
    return new FormService(
        $c->get(MySQLConnection::class),
        $c->get(SQLiteConnection::class),
        $c->get(WebhookService::class)
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
        $c->get(WebhookService::class)
    );
});

// Register controllers
$container->set(AuthController::class, function (Container $c) {
    $settings = $c->get('settings');
    return new AuthController(
        $c->get(AuthService::class),
        $settings['cookie'] ?? [],
        $settings['jwt']['expiry'] ?? 86400,
        $c->get(LoggerInterface::class),
        $c->get(AuditService::class)
    );
});

$container->set(FormController::class, function (Container $c) {
    return new FormController(
        $c->get(FormService::class),
        $c->get(LoggerInterface::class),
        $c->get(FormVersionService::class),
        $c->get(AuditService::class)
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
        $c->get(AuditService::class)
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
        $c->get(AuditService::class)
    );
});

$container->set(AppUserController::class, function (Container $c) {
    return new AppUserController(
        $c->get(AppUserService::class),
        $c->get(AppService::class),
        $c->get(AuditService::class)
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
    // Log unhandled exceptions through Monolog
    if ($logErrors) {
        $appLogger->error('Unhandled exception: ' . $exception->getMessage(), [
            'exception' => get_class($exception),
            'file' => $exception->getFile() . ':' . $exception->getLine(),
            'uri' => (string) $request->getUri(),
            'method' => $request->getMethod(),
        ]);
    }
    $payload = [
        'error' => true,
        'message' => $displayErrorDetails ? $exception->getMessage() : 'Internal Server Error',
    ];

    if ($displayErrorDetails) {
        $payload['trace'] = $exception->getTraceAsString();
    }

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

// Add CSRF middleware (validates tokens on state-changing requests)
$app->add(new CsrfMiddleware('formlogic_csrf', 'X-CSRF-Token', $cookieName));

// Add CORS middleware with allowlist support
$corsSettings = $settings['settings']['cors'];
$app->add(new CorsMiddleware(
    $corsSettings['origin'],
    $corsSettings['allowedOrigins'] ?? null
));

// Add security headers middleware
$app->add(new SecurityHeadersMiddleware($settings['settings']['isProduction'] ?? false));

// Add global body size limit (uses configured upload size as max, since that's the largest we accept)
$maxBodySize = $settings['settings']['uploads']['maxFileSize'] ?? (10 * 1024 * 1024);
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
        'cors_origin' => $_ENV['CORS_ORIGIN'] ?? 'NOT SET',
    ]));
    return $response->withHeader('Content-Type', 'application/json');
});

// Auth routes (public, rate limited)
$authRateLimiter = new RateLimitMiddleware(10, 60, 'auth');
$app->group('/api/auth', function (RouteCollectorProxy $group) {
    $group->post('/register', [AuthController::class, 'register']);
    $group->post('/login', [AuthController::class, 'login']);
    $group->post('/logout', [AuthController::class, 'logout']);
})->add($authRateLimiter);

// Auth routes (protected)
$app->group('/api/auth', function (RouteCollectorProxy $group) {
    $group->get('/me', [AuthController::class, 'me']);
    $group->put('/me', [AuthController::class, 'updateProfile']);
})->add($authRequired);

// AI routes - status is public, everything else requires auth
$app->get('/api/ai/status', function ($request, $response) use ($container) {
    return $container->get(AIController::class)->status($request, $response);
});

// Protected AI routes (require authentication to prevent abuse)
$app->group('/api/ai', function (RouteCollectorProxy $group) use ($container) {
    // Form generation from text prompt
    $group->post('/generate-form', function ($request, $response) use ($container) {
        return $container->get(AIController::class)->generateForm($request, $response);
    });

    // Form generation from file upload (PDF, Word, image)
    $group->post('/generate-form-from-file', function ($request, $response) use ($container) {
        return $container->get(AIController::class)->generateFormFromFile($request, $response);
    });

    // Form generation from base64 images
    $group->post('/generate-form-from-images', function ($request, $response) use ($container) {
        return $container->get(AIController::class)->generateFormFromImages($request, $response);
    });

    // Script generation
    $group->post('/generate-script', function ($request, $response) use ($container) {
        return $container->get(AIController::class)->generateScript($request, $response);
    });

    // Script improvement
    $group->post('/improve-script', function ($request, $response) use ($container) {
        return $container->get(AIController::class)->improveScript($request, $response);
    });
})->add($authRequired);

// Helper function to get route args
$getArgs = function ($request) {
    $routeContext = \Slim\Routing\RouteContext::fromRequest($request);
    return $routeContext->getRoute()->getArguments();
};

// Form routes (protected for management)
$app->group('/api/forms', function (RouteCollectorProxy $group) use ($container, $getArgs) {
    $group->get('', function ($request, $response) use ($container) {
        return $container->get(FormController::class)->index($request, $response);
    });
    $group->post('', function ($request, $response) use ($container) {
        return $container->get(FormController::class)->create($request, $response);
    });
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
    });
})->add($authRequired);  // Require authentication for form management

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
$submissionRateLimiter = new RateLimitMiddleware(30, 60, 'submission');

// Response routes (protected - require authentication)
$app->group('/api/forms/{formId}/responses', function (RouteCollectorProxy $group) use ($container, $getArgs, $authRequired) {
    // List responses (requires auth)
    $group->get('', function ($request, $response) use ($container, $getArgs) {
        return $container->get(ResponseController::class)->index($request, $response, $getArgs($request));
    })->add($authRequired);

    // Export responses (requires auth)
    $group->get('/export', function ($request, $response) use ($container, $getArgs) {
        return $container->get(ResponseController::class)->export($request, $response, $getArgs($request));
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

    // Re-run script on a response (requires auth)
    $group->post('/{id}/recompute', function ($request, $response) use ($container, $getArgs) {
        return $container->get(ResponseController::class)->recompute($request, $response, $getArgs($request));
    })->add($authRequired);
});

// Public form submission endpoint (rate limited, no auth required)
$app->post('/api/forms/{formId}/responses', function ($request, $response) use ($container, $getArgs) {
    return $container->get(ResponseController::class)->create($request, $response, $getArgs($request));
})->add($submissionRateLimiter);

// Analytics routes (protected)
$app->get('/api/forms/{formId}/analytics', function ($request, $response) use ($container, $getArgs) {
    return $container->get(ResponseController::class)->analytics($request, $response, $getArgs($request));
})->add($authRequired);

// Export routes (protected)
$app->get('/api/forms/{formId}/export/sqlite', function ($request, $response) use ($container, $getArgs) {
    return $container->get(ResponseController::class)->exportSqlite($request, $response, $getArgs($request));
})->add($authRequired);

$app->get('/api/forms/{formId}/export/json', function ($request, $response) use ($container, $getArgs) {
    return $container->get(ResponseController::class)->exportJson($request, $response, $getArgs($request));
})->add($authRequired);

// Create rate limiter for public form viewing (60 requests per minute per IP)
$publicFormRateLimiter = new RateLimitMiddleware(60, 60, 'public_form');

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

    // Return form without sensitive data
    unset($form['userId']);
    unset($form['logicScript']);
    unset($form['logicPrompt']);
    $response->getBody()->write(json_encode(['form' => $form]));
    return $response->withHeader('Content-Type', 'application/json');
})->add($publicFormRateLimiter);

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
    $group->post('/{appId}/groups/{id}/members/{memberId}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppUserController::class)->addGroupMember($request, $response, $getArgs($request));
    });
    $group->delete('/{appId}/groups/{id}/members/{memberId}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppUserController::class)->removeGroupMember($request, $response, $getArgs($request));
    });
})->add($authRequired);

// Rate limiter for app runtime submissions (30 per minute per IP, same as public submission)
$appSubmissionRateLimiter = new RateLimitMiddleware(30, 60, 'app_submission');

// App Runtime routes (public-facing, auth required for most)
$app->group('/api/app/{slug}', function (RouteCollectorProxy $group) use ($container, $getArgs, $authRequired, $appSubmissionRateLimiter) {
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

    // Form in app context
    $group->get('/forms/{formId}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppPublicController::class)->getForm($request, $response, $getArgs($request));
    })->add($authRequired);

    // Linked record lookup
    $group->get('/forms/{formId}/lookup', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppPublicController::class)->lookupRecords($request, $response, $getArgs($request));
    })->add($authRequired);

    // Response CRUD
    $group->post('/forms/{formId}/responses', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppPublicController::class)->createResponse($request, $response, $getArgs($request));
    })->add($appSubmissionRateLimiter)->add($authRequired);

    $group->get('/forms/{formId}/responses', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppPublicController::class)->listResponses($request, $response, $getArgs($request));
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
    })->add($authRequired);

    $group->delete('/forms/{formId}/responses/{id}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(AppPublicController::class)->deleteResponseById($request, $response, $getArgs($request));
    })->add($authRequired);
});

// Run app
$app->run();

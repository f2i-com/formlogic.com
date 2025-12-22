<?php

declare(strict_types=1);

use DI\Container;
use DI\Bridge\Slim\Bridge as SlimBridge;
use Slim\Routing\RouteCollectorProxy;
use FormLogic\Database\MySQLConnection;
use FormLogic\Database\SQLiteConnection;
use FormLogic\Services\AuthService;
use FormLogic\Services\FormService;
use FormLogic\Services\ResponseService;
use FormLogic\Services\FormLogicRuntime;
use FormLogic\Controllers\AuthController;
use FormLogic\Controllers\FormController;
use FormLogic\Controllers\ResponseController;
use FormLogic\Middleware\CorsMiddleware;
use FormLogic\Middleware\AuthMiddleware;

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

// Register database connections
$container->set(MySQLConnection::class, function (Container $c) {
    $mysql = new MySQLConnection($c->get('settings')['mysql']);
    // Initialize schema on first run
    $mysql->initializeSchema();
    return $mysql;
});

$container->set(SQLiteConnection::class, function (Container $c) {
    return new SQLiteConnection($c->get('settings')['sqlite']['storage_path']);
});

// Register services
$container->set(AuthService::class, function (Container $c) {
    return new AuthService(
        $c->get(MySQLConnection::class),
        $c->get('settings')['jwt']
    );
});

$container->set(FormService::class, function (Container $c) {
    return new FormService(
        $c->get(MySQLConnection::class),
        $c->get(SQLiteConnection::class)
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
        $c->get(FormLogicRuntime::class)
    );
});

// Register controllers
$container->set(AuthController::class, function (Container $c) {
    return new AuthController($c->get(AuthService::class));
});

$container->set(FormController::class, function (Container $c) {
    return new FormController($c->get(FormService::class));
});

$container->set(ResponseController::class, function (Container $c) {
    return new ResponseController(
        $c->get(ResponseService::class),
        $c->get(FormService::class)
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
$errorMiddleware->setDefaultErrorHandler(function (
    \Psr\Http\Message\ServerRequestInterface $request,
    \Throwable $exception,
    bool $displayErrorDetails,
    bool $logErrors,
    bool $logErrorDetails
) use ($app) {
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
        $statusCode = $exception->getCode();
    }

    return $response
        ->withStatus($statusCode)
        ->withHeader('Content-Type', 'application/json');
});

// Add CORS middleware
$app->add(new CorsMiddleware($settings['settings']['cors']['origin']));

// Create auth middleware instances
$authRequired = new AuthMiddleware($container->get(AuthService::class), false);
$authOptional = new AuthMiddleware($container->get(AuthService::class), true);

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

// Auth routes (public)
$app->group('/api/auth', function (RouteCollectorProxy $group) {
    $group->post('/register', [AuthController::class, 'register']);
    $group->post('/login', [AuthController::class, 'login']);
});

// Auth routes (protected)
$app->group('/api/auth', function (RouteCollectorProxy $group) {
    $group->get('/me', [AuthController::class, 'me']);
    $group->put('/me', [AuthController::class, 'updateProfile']);
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
})->add($authOptional);  // Optional auth - allows anonymous access for now

// Response routes
$app->group('/api/forms/{formId}/responses', function (RouteCollectorProxy $group) use ($container, $getArgs, $authOptional) {
    // List responses (requires auth)
    $group->get('', function ($request, $response) use ($container, $getArgs) {
        return $container->get(ResponseController::class)->index($request, $response, $getArgs($request));
    })->add($authOptional);

    // Export responses (requires auth)
    $group->get('/export', function ($request, $response) use ($container, $getArgs) {
        return $container->get(ResponseController::class)->export($request, $response, $getArgs($request));
    })->add($authOptional);

    // Single response operations
    $group->get('/{id}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(ResponseController::class)->show($request, $response, $getArgs($request));
    })->add($authOptional);
    $group->put('/{id}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(ResponseController::class)->update($request, $response, $getArgs($request));
    })->add($authOptional);
    $group->delete('/{id}', function ($request, $response) use ($container, $getArgs) {
        return $container->get(ResponseController::class)->delete($request, $response, $getArgs($request));
    })->add($authOptional);

    // Re-run script on a response (requires auth)
    $group->post('/{id}/recompute', function ($request, $response) use ($container, $getArgs) {
        return $container->get(ResponseController::class)->recompute($request, $response, $getArgs($request));
    })->add($authOptional);

    // Submit response (public - no auth required)
    $group->post('', function ($request, $response) use ($container, $getArgs) {
        return $container->get(ResponseController::class)->create($request, $response, $getArgs($request));
    });
});

// Analytics routes (protected)
$app->get('/api/forms/{formId}/analytics', function ($request, $response) use ($container, $getArgs) {
    return $container->get(ResponseController::class)->analytics($request, $response, $getArgs($request));
})->add($authOptional);

// Public form view (for embedding/sharing)
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
    $response->getBody()->write(json_encode(['form' => $form]));
    return $response->withHeader('Content-Type', 'application/json');
});

// Run app
$app->run();

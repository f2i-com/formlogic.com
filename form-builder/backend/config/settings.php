<?php

declare(strict_types=1);

use Monolog\Logger;

return [
    'settings' => [
        'displayErrorDetails' => $_ENV['APP_DEBUG'] === 'true',
        'logErrors' => true,
        'logErrorDetails' => true,

        'logger' => [
            'name' => 'formlogic',
            'path' => __DIR__ . '/../logs/app.log',
            'level' => Logger::DEBUG,
        ],

        'mysql' => [
            'host' => $_ENV['DB_HOST'] ?? 'localhost',
            'port' => $_ENV['DB_PORT'] ?? '3306',
            'database' => $_ENV['DB_DATABASE'] ?? 'formlogic',
            'username' => $_ENV['DB_USERNAME'] ?? 'formlogic',
            'password' => $_ENV['DB_PASSWORD'] ?? 'password',
            'charset' => 'utf8mb4',
            'collation' => 'utf8mb4_unicode_ci',
        ],

        'jwt' => [
            'secret' => $_ENV['JWT_SECRET'] ?? 'change-me-in-production',
            'expiry' => (int)($_ENV['JWT_EXPIRY'] ?? 86400),
            'algorithm' => 'HS256',
        ],

        'sqlite' => [
            'storage_path' => __DIR__ . '/../' . ($_ENV['SQLITE_STORAGE_PATH'] ?? 'storage/forms'),
        ],

        'cors' => [
            'origin' => $_ENV['CORS_ORIGIN'] ?? 'http://localhost:5173',
        ],
    ],
];

<?php

declare(strict_types=1);

use Monolog\Logger;

// Determine if we're in production mode
$isProduction = ($_ENV['APP_ENV'] ?? 'development') === 'production';

// Get JWT secret - fail hard in production if using default
$jwtSecret = $_ENV['JWT_SECRET'] ?? 'change-me-in-production';
if ($isProduction && ($jwtSecret === 'change-me-in-production' || strlen($jwtSecret) < 32)) {
    throw new \RuntimeException(
        'SECURITY ERROR: JWT_SECRET must be set to a secure value (minimum 32 characters) in production. ' .
        'Generate one with: openssl rand -base64 32'
    );
}

// Get DB password - fail hard in production if using default
$dbPassword = $_ENV['DB_PASSWORD'] ?? 'password';
if ($isProduction && $dbPassword === 'password') {
    throw new \RuntimeException(
        'SECURITY ERROR: DB_PASSWORD must be set to a secure value in production.'
    );
}

return [
    'settings' => [
        'displayErrorDetails' => ($_ENV['APP_DEBUG'] ?? 'false') === 'true',
        'logErrors' => true,
        'logErrorDetails' => !$isProduction,
        'isProduction' => $isProduction,

        'logger' => [
            'name' => 'formlogic',
            'path' => __DIR__ . '/../logs/app.log',
            'level' => $isProduction ? Logger::WARNING : Logger::DEBUG,
        ],

        'mysql' => [
            'host' => $_ENV['DB_HOST'] ?? 'localhost',
            'port' => $_ENV['DB_PORT'] ?? '3306',
            'database' => $_ENV['DB_DATABASE'] ?? 'formlogic',
            'username' => $_ENV['DB_USERNAME'] ?? 'formlogic',
            'password' => $dbPassword,
            'charset' => 'utf8mb4',
            'collation' => 'utf8mb4_unicode_ci',
        ],

        'jwt' => [
            'secret' => $jwtSecret,
            'expiry' => (int)($_ENV['JWT_EXPIRY'] ?? 86400),
            'algorithm' => 'HS256',
            'issuer' => $_ENV['JWT_ISSUER'] ?? 'formlogic',
            'audience' => $_ENV['JWT_AUDIENCE'] ?? 'formlogic-api',
        ],

        // Cookie settings for secure authentication
        'cookie' => [
            'name' => 'formlogic_auth',
            'httpOnly' => true,
            'secure' => $isProduction, // HTTPS only in production
            'sameSite' => 'Lax', // Provides CSRF protection while allowing normal navigation
            'path' => '/',
            'domain' => $_ENV['COOKIE_DOMAIN'] ?? '', // Empty = current domain only
        ],

        'sqlite' => [
            'storage_path' => __DIR__ . '/../' . ($_ENV['SQLITE_STORAGE_PATH'] ?? 'storage/forms'),
        ],

        'cors' => [
            'origin' => $_ENV['CORS_ORIGIN'] ?? 'http://localhost:5173',
            'allowedOrigins' => array_filter(
                array_map('trim', explode(',', $_ENV['CORS_ALLOWED_ORIGINS'] ?? '')),
                fn($o) => !empty($o)
            ) ?: null, // null means use single origin mode
        ],

        'rateLimit' => [
            'login' => [
                'maxAttempts' => (int)($_ENV['LOGIN_MAX_ATTEMPTS'] ?? 5),
                'decayMinutes' => (int)($_ENV['LOGIN_DECAY_MINUTES'] ?? 15),
            ],
        ],

        'uploads' => [
            'maxFileSize' => (int)($_ENV['UPLOAD_MAX_FILE_SIZE'] ?? 10 * 1024 * 1024), // 10MB default
            'allowedTypes' => [
                'application/pdf',
                'application/msword',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'image/jpeg',
                'image/png',
                'image/gif',
                'image/webp',
            ],
        ],
    ],
];

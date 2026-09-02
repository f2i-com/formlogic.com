# FormLogic API Backend

PHP Slim-based REST API for the FormLogic Form Builder.

## Requirements

- PHP 8.1+ (`pdo_mysql`, `pdo_sqlite`, `mbstring`, `json`, `openssl`, `fileinfo`)
- Composer
- MySQL 8.0+

> Tip: the assisted installers (`formlogic/install.php` wizard or `install.sh`) handle
> the steps below — including generating `JWT_SECRET` and `AUDIT_HMAC_KEY`. The vendored
> The scripting sandbox launcher ships in `bin/runtime/` (no separate install; on Linux it must be executable).

## Setup

### 1. Install Dependencies

```bash
cd backend
composer install
```

### 2. Configure Environment

Copy the environment file and update the values:

```bash
cp .env.example .env
```

Edit `.env` with your database credentials:

```env
DB_HOST=localhost
DB_PORT=3306
DB_DATABASE=formlogic
DB_USERNAME=formlogic
DB_PASSWORD=your_secure_password_here
```

Also set a 32+ character `JWT_SECRET` and `AUDIT_HMAC_KEY` (generate with
`php -r "echo bin2hex(random_bytes(32));"`) — both are **required when `APP_ENV=production`**.

### 3. Create MySQL Database

Use a strong password (the production safety check rejects defaults like `password`):

```sql
CREATE DATABASE formlogic CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'formlogic'@'localhost' IDENTIFIED BY 'your_secure_password_here';
GRANT ALL PRIVILEGES ON formlogic.* TO 'formlogic'@'localhost';
FLUSH PRIVILEGES;
```

### 4. Start the Development Server

```bash
composer start
# or
php -S localhost:8080 -t public
```

The API will be available at `http://localhost:8080/api`

## API Endpoints

### Health Check
- `GET /api/health` - Check API status

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login user
- `GET /api/auth/me` - Get current user (requires auth)
- `PUT /api/auth/me` - Update profile (requires auth)

### Forms
- `GET /api/forms` - List all forms
- `POST /api/forms` - Create new form
- `GET /api/forms/{id}` - Get form by ID
- `PUT /api/forms/{id}` - Update form
- `DELETE /api/forms/{id}` - Delete form
- `POST /api/forms/{id}/duplicate` - Duplicate form

### Responses
- `GET /api/forms/{formId}/responses` - List responses
- `POST /api/forms/{formId}/responses` - Submit response (public)
- `GET /api/forms/{formId}/responses/{id}` - Get response
- `PUT /api/forms/{formId}/responses/{id}` - Update response
- `DELETE /api/forms/{formId}/responses/{id}` - Delete response
- `GET /api/forms/{formId}/responses/export` - Export as CSV

### Analytics
- `GET /api/forms/{formId}/analytics` - Get form analytics

### Public
- `GET /api/public/forms/{id}` - Get published form (for embedding)

## Authentication

The API uses JWT-signed sessions. Browser clients log in and receive an **HttpOnly
session cookie**, and must send the CSRF token (set as a readable cookie) in the
`X-CSRF-Token` header on state-changing requests. Programmatic clients can instead send an
API key as a Bearer token:

```
Authorization: Bearer <api-key>
```

## Storage Architecture

- **MySQL**: Global data (users, forms metadata, analytics)
- **SQLite**: Per-form data (fields, responses) - one database file per form

This hybrid approach provides:
- Fast queries on form-specific data
- Easy form data isolation and backup
- Efficient response storage and querying

## Development

### File Structure

```
backend/
├── public/
│   └── index.php          # Entry point
├── src/
│   ├── Controllers/       # Request handlers
│   ├── Models/           # Data models
│   ├── Middleware/       # Auth, CORS, etc.
│   ├── Services/         # Business logic
│   └── Database/         # DB connections
├── config/
│   └── settings.php      # Configuration
├── storage/
│   └── forms/            # SQLite databases
├── logs/                 # Application logs
└── composer.json
```

### Running Tests

```bash
composer test
```

## Production Deployment

1. Set `APP_ENV=production` and `APP_DEBUG=false` in `.env`
2. Use a strong `JWT_SECRET` and `AUDIT_HMAC_KEY` (32+ chars each)
3. Configure proper CORS origins (`CORS_ORIGIN` / `CORS_ALLOWED_ORIGINS`)
4. Set up proper file permissions for `storage/` directory
5. Use a proper web server (Apache/Nginx) with PHP-FPM

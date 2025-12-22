# FormLogic API Backend

PHP Slim-based REST API for the FormLogic Form Builder.

## Requirements

- PHP 8.1+
- Composer
- MySQL 5.7+ or 8.0+
- SQLite3 extension

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
DB_PASSWORD=password
```

### 3. Create MySQL Database

```sql
CREATE DATABASE formlogic CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'formlogic'@'localhost' IDENTIFIED BY 'password';
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

The API uses JWT (JSON Web Token) for authentication. Include the token in the Authorization header:

```
Authorization: Bearer <token>
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
2. Use a strong `JWT_SECRET`
3. Configure proper CORS origins
4. Set up proper file permissions for `storage/` directory
5. Use a proper web server (Apache/Nginx) with PHP-FPM

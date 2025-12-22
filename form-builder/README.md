# FormLogic - Smart Form Builder

A modern form builder with powerful conditional logic, real-time validation, and analytics. Build dynamic forms with an intuitive drag-and-drop interface.

## Features

- **Drag & Drop Builder** - Create forms visually with an intuitive interface
- **Conditional Logic** - Show/hide fields based on user responses using FormLogic expressions
- **Real-time Validation** - Built-in and custom validation rules
- **Analytics Dashboard** - Track responses, completion rates, and form performance
- **Multi-storage Support** - Works offline with localStorage, syncs to cloud when connected
- **Responsive Design** - Forms work beautifully on all devices

## Project Structure

```
form-builder/
├── ui/                 # Frontend React application
│   ├── src/            # Source code
│   ├── public/         # Static assets
│   ├── dist/           # Production build
│   └── package.json    # Node dependencies
├── backend/            # PHP Slim API
│   ├── src/            # PHP source code
│   ├── public/         # Web root (index.php)
│   ├── config/         # Configuration files
│   ├── storage/        # SQLite databases for forms
│   └── composer.json   # PHP dependencies
└── README.md
```

## Tech Stack

### Frontend
- React 18 with TypeScript
- Zustand for state management
- Tailwind CSS for styling
- React Router for navigation
- Vite for build tooling
- FormLogic expression engine for conditional logic

### Backend
- PHP 8.1+ with Slim 4 Framework
- MySQL for global data (users, form metadata, analytics)
- SQLite for per-form data (fields, responses)
- JWT authentication
- RESTful API

## Getting Started

### Prerequisites

- Node.js 18+
- PHP 8.1+
- MySQL 8.0+
- Composer

### Frontend Setup

```bash
cd ui

# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Start development server
npm run dev
```

The frontend will be available at `http://localhost:5173`

### Backend Setup

```bash
cd backend

# Install dependencies
composer install

# Copy environment file
cp .env.example .env

# Edit .env with your database credentials
# DB_HOST=localhost
# DB_DATABASE=formlogic
# DB_USERNAME=formlogic
# DB_PASSWORD=your_password

# Start PHP development server
php -S localhost:8080 -t public
```

The API will be available at `http://localhost:8080`

### Database Setup

Create a MySQL database and user:

```sql
CREATE DATABASE formlogic CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'formlogic'@'localhost' IDENTIFIED BY 'your_password';
GRANT ALL PRIVILEGES ON formlogic.* TO 'formlogic'@'localhost';
FLUSH PRIVILEGES;
```

The schema is automatically created on first API request.

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login
- `GET /api/auth/me` - Get current user
- `PUT /api/auth/me` - Update profile

### Forms
- `GET /api/forms` - List all forms
- `POST /api/forms` - Create form
- `GET /api/forms/:id` - Get form
- `PUT /api/forms/:id` - Update form
- `DELETE /api/forms/:id` - Delete form
- `POST /api/forms/:id/duplicate` - Duplicate form

### Responses
- `GET /api/forms/:id/responses` - List responses
- `POST /api/forms/:id/responses` - Submit response (public)
- `GET /api/forms/:id/responses/export` - Export as CSV

### Analytics
- `GET /api/forms/:id/analytics` - Get form analytics

## FormLogic Expression Language

FormLogic uses a custom expression language for conditional logic:

```javascript
// Simple comparisons
age >= 18
country === "USA"

// Logical operators
age >= 18 && hasLicense === true
status === "active" || status === "pending"

// String operations
email.contains("@gmail.com")
name.startsWith("Dr.")

// Numeric operations
total > 100 && discount < 50
```

## Development

### Frontend Commands

```bash
npm run dev      # Start dev server
npm run build    # Production build
npm run lint     # Run ESLint
npm run preview  # Preview production build
```

### Backend Commands

```bash
composer install        # Install dependencies
composer dump-autoload  # Regenerate autoloader
php -S localhost:8080 -t public  # Start dev server
```

## Environment Variables

### Frontend (ui/.env)
```
VITE_API_URL=http://localhost:8080/api
```

### Backend (backend/.env)
```
APP_ENV=development
APP_DEBUG=true
DB_HOST=localhost
DB_PORT=3306
DB_DATABASE=formlogic
DB_USERNAME=formlogic
DB_PASSWORD=password
JWT_SECRET=your-secret-key
JWT_EXPIRY=86400
CORS_ORIGIN=http://localhost:5173
```

## License

MIT License

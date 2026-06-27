#!/usr/bin/env bash
# =============================================================================
# FormLogic Installer
# =============================================================================
# Sets up the FormLogic application: backend API, frontend UI, and the QuickJS
# scripting runtime (vendored qjs binary + quickjs-emscripten via npm).
#
# Usage:
#   chmod +x install.sh
#   ./install.sh
#
# Prerequisites:
#   - PHP >= 8.1 with extensions: pdo_mysql, pdo_sqlite, mbstring, json, openssl
#   - Composer (https://getcomposer.org)
#   - Node.js >= 18 and npm
#   - MySQL 8.0+
#   - Git
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
UI_DIR="$SCRIPT_DIR/ui"
QJS_BIN="$SCRIPT_DIR/backend/bin/qjs/qjs-linux-x86_64"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC} $1"; }
ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }

# -----------------------------------------------------------------------------
# 1. Check prerequisites
# -----------------------------------------------------------------------------
info "Checking prerequisites..."

check_command() {
    if ! command -v "$1" &>/dev/null; then
        error "$1 is required but not installed."
        exit 1
    fi
}

check_command php
check_command composer
check_command node
check_command npm
check_command git
check_command mysql

PHP_VERSION=$(php -r 'echo PHP_MAJOR_VERSION . "." . PHP_MINOR_VERSION;')
if [[ "$(echo "$PHP_VERSION >= 8.1" | bc -l 2>/dev/null || php -r "echo version_compare('$PHP_VERSION','8.1','>=') ? '1' : '0';")" != "1" ]]; then
    error "PHP >= 8.1 is required (found $PHP_VERSION)"
    exit 1
fi

NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
if [[ "$NODE_MAJOR" -lt 18 ]]; then
    error "Node.js >= 18 is required (found $(node -v))"
    exit 1
fi

ok "All prerequisites met (PHP $PHP_VERSION, Node $(node -v))"

# -----------------------------------------------------------------------------
# 2. Backend setup
# -----------------------------------------------------------------------------
info "Setting up backend..."

cd "$BACKEND_DIR"

# Create storage directories
mkdir -p storage/forms storage/packs storage/uploads logs

# Install PHP dependencies
info "Installing Composer dependencies..."
composer install --no-interaction --prefer-dist

ok "Backend dependencies installed"

# Create .env if it doesn't exist
if [[ ! -f .env ]]; then
    cp .env.example .env
    # Generate random secrets
    JWT_SECRET=$(php -r 'echo bin2hex(random_bytes(32));')
    AUDIT_KEY=$(php -r 'echo bin2hex(random_bytes(32));')
    if [[ "$(uname -s)" == "Darwin" ]]; then
        sed -i '' "s/^JWT_SECRET=$/JWT_SECRET=$JWT_SECRET/" .env
        sed -i '' "s/^# AUDIT_HMAC_KEY=$/AUDIT_HMAC_KEY=$AUDIT_KEY/" .env
    else
        sed -i "s/^JWT_SECRET=$/JWT_SECRET=$JWT_SECRET/" .env
        sed -i "s/^# AUDIT_HMAC_KEY=$/AUDIT_HMAC_KEY=$AUDIT_KEY/" .env
    fi
    warn "Created .env from .env.example — please update DB_PASSWORD and other settings"
else
    ok ".env already exists"
fi

# -----------------------------------------------------------------------------
# 3. Database setup
# -----------------------------------------------------------------------------
info "Checking database..."

# Read database config from .env
DB_HOST=$(grep -E '^DB_HOST=' .env | cut -d= -f2 | tr -d '[:space:]')
DB_PORT=$(grep -E '^DB_PORT=' .env | cut -d= -f2 | tr -d '[:space:]')
DB_DATABASE=$(grep -E '^DB_DATABASE=' .env | cut -d= -f2 | tr -d '[:space:]')
DB_USERNAME=$(grep -E '^DB_USERNAME=' .env | cut -d= -f2 | tr -d '[:space:]')
DB_PASSWORD=$(grep -E '^DB_PASSWORD=' .env | cut -d= -f2 | tr -d '[:space:]')

DB_HOST=${DB_HOST:-localhost}
DB_PORT=${DB_PORT:-3306}
DB_DATABASE=${DB_DATABASE:-formlogic}
DB_USERNAME=${DB_USERNAME:-formlogic}

if [[ -z "$DB_PASSWORD" ]]; then
    warn "DB_PASSWORD is empty in .env — please set it before running the app"
    warn "Skipping database initialization"
else
    # Check if database exists, create if not
    if mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USERNAME" -p"$DB_PASSWORD" -e "USE $DB_DATABASE;" 2>/dev/null; then
        ok "Database '$DB_DATABASE' exists"
    else
        info "Creating database '$DB_DATABASE'..."
        mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USERNAME" -p"$DB_PASSWORD" -e "CREATE DATABASE IF NOT EXISTS \`$DB_DATABASE\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" 2>/dev/null
        ok "Database created"
    fi

    # Import schema if tables don't exist
    TABLE_COUNT=$(mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USERNAME" -p"$DB_PASSWORD" -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DB_DATABASE';" 2>/dev/null || echo "0")
    if [[ "$TABLE_COUNT" -eq 0 ]] && [[ -f database/schema.sql ]]; then
        info "Importing database schema..."
        mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USERNAME" -p"$DB_PASSWORD" "$DB_DATABASE" < database/schema.sql 2>/dev/null
        ok "Schema imported ($DB_DATABASE)"
    else
        ok "Database already has $TABLE_COUNT tables"
    fi
fi

# -----------------------------------------------------------------------------
# 4. Frontend setup
# -----------------------------------------------------------------------------
info "Setting up frontend..."

cd "$UI_DIR"

# Install Node.js dependencies
info "Installing npm dependencies..."
npm install

# Create .env if it doesn't exist
if [[ ! -f .env ]]; then
    if [[ -f .env.example ]]; then
        cp .env.example .env
        warn "Created .env from .env.example — update VITE_API_URL if needed"
    fi
else
    ok ".env already exists"
fi

# FormLogic runtime: the browser engine (quickjs-emscripten) is installed via the
# npm step above, and the canonical prelude is synced into the backend by the
# `npm run build` prebuild step below. The backend uses the vendored static qjs
# sandbox binary (committed under backend/bin/qjs); just make it executable.
if [[ -f "$QJS_BIN" ]]; then
    chmod +x "$QJS_BIN" 2>/dev/null || true
    ok "FormLogic qjs runtime present"
else
    warn "FormLogic qjs binary missing at $QJS_BIN — form logic & scripts will be disabled server-side"
fi

# Build frontend
info "Building frontend..."
npm run build
ok "Frontend built to ui/dist/"

# -----------------------------------------------------------------------------
# 5. Summary
# -----------------------------------------------------------------------------
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN} FormLogic installation complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Next steps:"
echo "  1. Update backend/.env with your database password and settings"
echo "  2. Start the backend:  cd backend && composer start"
echo "  3. Start the frontend: cd ui && npm run dev"
echo ""
echo "Or for production, configure your web server to serve:"
echo "  - Backend API: backend/public/ (PHP)"
echo "  - Frontend:    ui/dist/ (static files)"
echo ""

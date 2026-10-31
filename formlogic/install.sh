#!/usr/bin/env bash
# =============================================================================
# FormLogic Installer
# =============================================================================
# Sets up the FormLogic application: backend API, frontend UI, and the ZIPP
# scripting runtime (the browser engine and Softn runtime installed from the
# latest Softn release, and the backend/bin/runtime sandbox launcher, built from
# the source of the ZIPP release that Softn release names).
#
# Usage:
#   chmod +x install.sh
#   ./install.sh
#
# Prerequisites:
#   - PHP >= 8.2 with extensions: pdo_mysql, pdo_sqlite, sqlite3, sodium, mbstring, json, openssl
#     (sqlite3 restores a native app's database when an update of it fails)
#   - Composer (https://getcomposer.org)
#   - Node.js 22.22.2+ (22.x), 24.15.0+ (24.x), or 26+, and npm
#   - MySQL 8.0+
#   - Git
#   - Rust via rustup (https://rustup.rs), to build the server sandbox launcher
#     (and to rebuild one already present that is not the installed Softn release's
#     ZIPP build). Without it the launcher comes from a FormLogic release zip or a
#     CI build (see the message this script prints); form logic stays off
#     server-side until then.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
UI_DIR="$SCRIPT_DIR/ui"
# Pick the sandbox launcher that matches the OS the backend will actually run on,
# so the check below doesn't falsely warn (on Windows Git Bash it is the .exe).
case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) RUNTIME_BIN="$SCRIPT_DIR/backend/bin/runtime/formlogic-runtime-windows-x86_64.exe"; RUNTIME_PLATFORM=windows ;;
    *)                    RUNTIME_BIN="$SCRIPT_DIR/backend/bin/runtime/formlogic-runtime-linux-x86_64"; RUNTIME_PLATFORM=linux ;;
esac

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
# The backend's composer.json requires ^8.2. Compared as versions, not as decimals ("8.10" is
# not less than "8.2").
if [[ "$(php -r 'echo version_compare(PHP_VERSION, "8.2.0", ">=") ? "1" : "0";')" != "1" ]]; then
    error "PHP >= 8.2 is required (found $PHP_VERSION)"
    exit 1
fi

NODE_VERSION=$(node -v)
# Share the wizard's exact ui/package.json toolchain range. Loading definitions only
# cannot start the browser installer; native hosting has its own runtime minimum.
if ! php -r 'define("FORMLOGIC_INSTALL_NO_RUN", true); require $argv[1]; exit(flSourceNodeVersionSupported($argv[2]) ? 0 : 1);' "$SCRIPT_DIR/install.php" "$NODE_VERSION"; then
    error "Node.js 22.22.2+ (22.x), 24.15.0+ (24.x), or 26+ is required to build the UI (found $NODE_VERSION)"
    exit 1
fi

ok "All prerequisites met (PHP $PHP_VERSION, Node $NODE_VERSION)"

# -----------------------------------------------------------------------------
# 2. Backend setup
# -----------------------------------------------------------------------------
info "Setting up backend..."

cd "$BACKEND_DIR"

# Create storage directories
mkdir -p storage/forms storage/hosted-apps storage/native-apps storage/packs storage/uploads storage/pack-screenshots logs
# Databases and backups are written at the default mode, so these folders are what keeps other
# accounts on this machine out of them.
chmod -R o-rwx storage logs

# Install PHP dependencies
info "Installing Composer dependencies..."
composer install --no-interaction --prefer-dist

ok "Backend dependencies installed"

# Create .env if it doesn't exist
if [[ ! -f .env ]]; then
    # .env holds the JWT secret, the audit key and the database password, so only its owner may
    # read it (mode 600, as install.php writes it). It is made under umask 077, so it is never
    # readable by others, not even before the secrets are written into it.
    (umask 077 && cp .env.example .env)
    chmod 600 .env
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
    chmod 600 .env # in case this sed did not keep the mode it replaced the file with
    warn "Created .env from .env.example — please update DB_PASSWORD and other settings"
else
    ok ".env already exists"
fi

# -----------------------------------------------------------------------------
# 3. Database setup
# -----------------------------------------------------------------------------
info "Checking database..."

# Read the database settings from .env as the backend reads them: with phpdotenv, which composer
# installed above. Cutting each line at its first '=' kept the quotes of a quoted value and lost
# everything after a second '=' (a password such as "pa=ss" became "pa").
env_value() {
    # shellcheck disable=SC2016 # the $ belongs to the PHP code, not to the shell
    php -r 'require "vendor/autoload.php"; $v = Dotenv\Dotenv::parse((string) file_get_contents(".env")); echo $v[$argv[1]] ?? "";' "$1"
}
DB_HOST=$(env_value DB_HOST)
DB_PORT=$(env_value DB_PORT)
DB_DATABASE=$(env_value DB_DATABASE)
DB_USERNAME=$(env_value DB_USERNAME)
DB_PASSWORD=$(env_value DB_PASSWORD)

DB_HOST=${DB_HOST:-localhost}
DB_PORT=${DB_PORT:-3306}
DB_DATABASE=${DB_DATABASE:-formlogic}
DB_USERNAME=${DB_USERNAME:-formlogic}

if [[ ! "$DB_DATABASE" =~ ^[A-Za-z0-9_-]+$ ]]; then
    # The name is written into the SQL below; install.php allows the same characters.
    error "DB_DATABASE in .env may hold only letters, digits, '_' and '-' (found '$DB_DATABASE')"
    exit 1
fi

if [[ -z "$DB_PASSWORD" ]]; then
    warn "DB_PASSWORD is empty in .env — please set it before running the app"
    warn "Skipping database initialization"
elif [[ "$DB_PASSWORD" == *$'\n'* ]]; then
    warn "DB_PASSWORD in .env holds a line break, which a MySQL option file cannot carry — create the database by hand"
    warn "Skipping database initialization"
else
    # mysql is given the password in an option file only this user can read, never on its
    # command line, where every user of the machine sees it in the process list. (MYSQL_PWD is
    # deprecated in MySQL 8.0.) In the file the value is double-quoted, so '#' does not start a
    # comment, with '\' and '"' escaped.
    MYSQL_DEFAULTS=$(umask 077 && mktemp)
    trap 'rm -f "$MYSQL_DEFAULTS"' EXIT
    printf '[client]\npassword="%s"\n' "$(printf '%s' "$DB_PASSWORD" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')" > "$MYSQL_DEFAULTS"
    # --defaults-extra-file must be the first option.
    db_mysql() { mysql --defaults-extra-file="$MYSQL_DEFAULTS" -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USERNAME" "$@"; }

    # Check if database exists, create if not
    if db_mysql -e "USE \`$DB_DATABASE\`;" 2>/dev/null; then
        ok "Database '$DB_DATABASE' exists"
    else
        info "Creating database '$DB_DATABASE'..."
        db_mysql -e "CREATE DATABASE IF NOT EXISTS \`$DB_DATABASE\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" 2>/dev/null
        ok "Database created"
    fi

    # Import schema if tables don't exist
    TABLE_COUNT=$(db_mysql -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DB_DATABASE';" 2>/dev/null || echo "0")
    if [[ "$TABLE_COUNT" -eq 0 ]] && [[ -f database/schema.sql ]]; then
        info "Importing database schema..."
        db_mysql "$DB_DATABASE" < database/schema.sql 2>/dev/null
        ok "Schema imported ($DB_DATABASE)"
    else
        ok "Database already has $TABLE_COUNT tables"
    fi

    # Set up the demo + marketplace catalog (installable sample app packs + example data).
    # Idempotent — safe to re-run. Skip with SEED_DEMO=0 ./install.sh for a clean/empty instance.
    if [[ "${SEED_DEMO:-1}" != "0" ]]; then
        info "Setting up demo + marketplace (sample app packs + example data)..."
        if php bin/provision-demo.php; then
            ok "Demo + marketplace seeded"
        else
            warn "Demo/marketplace seeding failed — retry later with: cd backend && php bin/provision-demo.php"
        fi
    fi
fi

# -----------------------------------------------------------------------------
# 4. Frontend setup
# -----------------------------------------------------------------------------
info "Setting up frontend..."

cd "$UI_DIR"

# Install the exact frontend dependency tree reviewed in package-lock.json.
info "Installing npm dependencies..."
npm ci

# Create .env if it doesn't exist
if [[ ! -f .env ]]; then
    if [[ -f .env.example ]]; then
        cp .env.example .env
        warn "Created .env from .env.example — update VITE_API_URL if needed"
    fi
else
    ok ".env already exists"
fi

# FormLogic runtime: the browser engine (the ZIPP wasm module at ui/vendor/zipp-wasm)
# and the Softn hosted runtime, editors and native runtime are not in git; the
# fetch below installs them from the Softn release (SOFTN_RELEASE=<tag> pins one),
# and the `npm run build` step bundles the engine, its prebuild step verifying
# them and syncing the canonical prelude into the backend.
# Install the Softn release runtime (browser engine included) before the build needs it.
# The fetcher resolves the repository root from its own path, so the working directory
# does not matter; the repository root is this script's parent.
info "Installing the Softn release runtime..."
node "$SCRIPT_DIR/../scripts/fetch-softn-release.mjs"
ok "Softn release runtime installed"

# The backend's sandbox launcher (backend/bin/runtime, a wasmtime host for the
# zipp engine) is not in git either: it is built from the source of the ZIPP
# release the Softn release just installed names. One already there (an earlier
# build, or copied from a release zip) is kept only if its SOURCE.json records
# it and names that ZIPP release (--deployed: a copied launcher has no guest
# beside it, and runs the same whichever Softn archive named its ZIPP). With
# Rust present, build the one this machine's backend runs; otherwise say where
# a built one comes from.
SANDBOX_STALE=""
if [[ -f "$RUNTIME_BIN" ]]; then
    if node "$SCRIPT_DIR/../scripts/runtime-provenance.mjs" check --deployed --require "$RUNTIME_PLATFORM"; then
        ok "Server sandbox launcher matches the ZIPP release the installed Softn release names"
    else
        SANDBOX_STALE=1
        warn "The server sandbox launcher in backend/bin/runtime is not the installed Softn release's ZIPP build (above): the server would run another engine than the browser"
    fi
fi
if [[ ! -f "$RUNTIME_BIN" || -n "$SANDBOX_STALE" ]]; then
    ZIPP_RELEASE="$(node "$SCRIPT_DIR/../scripts/zipp-source.mjs" --identity 2>/dev/null | sed -n 's/^release=//p' || true)"
    if command -v cargo &>/dev/null; then
        info "Building the server sandbox launcher from ZIPP ${ZIPP_RELEASE:-} source (a few minutes)..."
        if bash "$SCRIPT_DIR/../scripts/build-runtime.sh" zipp-source guest "$RUNTIME_PLATFORM" smoke provenance; then
            ok "Server sandbox launcher built"
        elif [[ -n "$SANDBOX_STALE" ]]; then
            warn "Rebuilding the server sandbox launcher failed (output above) — the stale one stays, and the server runs another engine than the browser until it is rebuilt"
        else
            warn "Building the server sandbox launcher failed (output above) — form logic & scripts will be disabled server-side until it is built"
        fi
    else
        warn "No Rust toolchain: the server sandbox launcher was not built. It must be built from ZIPP ${ZIPP_RELEASE:-(the release the installed Softn release names)}; the check refuses any other. Either install Rust (https://rustup.rs) and run"
        warn "  scripts/build-runtime.sh all"
        warn "from the repository root, or copy api/bin/runtime/ (both launchers and SOURCE.json) into backend/bin/runtime/ from a FormLogic"
        warn "release zip whose engine-identity.json serverSandbox names that ZIPP release (a Package run's formlogic-dist artifact is kept 30 days),"
        warn "or take a Package run's sandbox-guest and sandbox-linux artifacts (kept 7 days; the run must have frozen a Softn release naming that ZIPP):"
        warn "  gh run download <package.yml run id> -R f2i-com/formlogic.com -n <artifact> -D <repository root>"
        warn "then run: node scripts/runtime-provenance.mjs provenance"
    fi
fi
# It only needs to be executable, which git clone and zip extraction cannot be
# relied on to preserve.
if [[ -f "$RUNTIME_BIN" ]]; then
    chmod +x "$RUNTIME_BIN" 2>/dev/null || true
    if [[ -x "$RUNTIME_BIN" ]]; then
        ok "FormLogic script runtime present and executable"
    else
        warn "FormLogic script runtime at $RUNTIME_BIN is not executable and chmod failed — run: chmod +x \"$RUNTIME_BIN\""
    fi
else
    warn "FormLogic script runtime missing at $RUNTIME_BIN — form logic & scripts will be disabled server-side"
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
echo "backend/.env can be read by its owner only (mode 600). If the web server runs PHP as another"
echo "user (www-data, apache, nginx), make that user its owner, for example:"
echo "  sudo chown www-data backend/.env"
echo ""

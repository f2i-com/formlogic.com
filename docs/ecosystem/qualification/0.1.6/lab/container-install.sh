#!/usr/bin/env bash
# Manual install steps from INSTALL.txt, run inside the qualification container.
# Usage: container-install.sh <db-host> <db-name> <db-user> <db-pass> <public-base-url> [node-bin]
set -euo pipefail
DB_HOST="$1"; DB_NAME="$2"; DB_USER="$3"; DB_PASS="$4"; BASE="$5"; NODE_BIN="${6:-/usr/local/bin/node}"
cd /var/www/html
if [[ -f api/.env ]]; then echo "api/.env already present; keeping it"; else
  cp api/.env.example api/.env
  SECRET="$(php -r 'echo bin2hex(random_bytes(32));')"
  HMAC="$(php -r 'echo bin2hex(random_bytes(32));')"
  {
    echo "APP_ENV=production"; echo "APP_DEBUG=false"
    echo "DB_HOST=$DB_HOST"; echo "DB_PORT=3306"; echo "DB_DATABASE=$DB_NAME"; echo "DB_USERNAME=$DB_USER"; echo "DB_PASSWORD=$DB_PASS"
    echo "JWT_SECRET=$SECRET"; echo "AUDIT_HMAC_KEY=$HMAC"
    echo "CORS_ORIGIN=$BASE"
    echo "COOKIE_SECURE=false"   # plain HTTP inside the lab; documented override
    echo "FORMLOGIC_NODE_BIN=$NODE_BIN"
  } >> api/.env
fi
chown -R www-data:www-data api/storage api/logs 2>/dev/null || true
chmod +x api/bin/runtime/formlogic-runtime-linux-x86_64 2>/dev/null || true
rm -f install.php
php api/bin/upgrade.php 2>&1 | tail -5
echo "--- health"
curl -s "$BASE/api/health" | head -c 600; echo

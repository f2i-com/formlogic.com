#!/usr/bin/env bash
# docs/UPGRADING.md steps 1-4, run inside the container: back up, replace files
# except api/.env and api/storage (and this install's logs), run the upgrade CLI, verify.
# Usage: container-upgrade.sh <db-host> <db-user> <db-pass> <new-version> [--interrupt-after <seconds>]
set -euo pipefail
DB_HOST="$1"; DB_USER="$2"; DB_PASS="$3"; NEW_VERSION="$4"; INTERRUPT="${6:-}"
cd /var/www/html
mkdir -p /tmp/pre-upgrade
mysqldump --skip-ssl -h "$DB_HOST" -u"$DB_USER" -p"$DB_PASS" formlogic 2>/dev/null | gzip > /tmp/pre-upgrade/db.sql.gz
cp api/.env /tmp/pre-upgrade/env
tar -C api -czf /tmp/pre-upgrade/storage.tgz storage
echo "backup: $(du -sh /tmp/pre-upgrade | cut -f1) (db dump, .env, storage)"
cat VERSION
for entry in /mnt/new/* /mnt/new/.[!.]*; do
  name="$(basename "$entry")"
  [[ "$name" == "api" || "$name" == "." || "$name" == ".." ]] && continue
  rm -rf "/var/www/html/$name"; cp -a "$entry" "/var/www/html/$name"
done
for entry in /mnt/new/api/* /mnt/new/api/.[!.]*; do
  name="$(basename "$entry")"
  case "$name" in .env|.env.bak|storage|logs|.|..) continue;; esac
  rm -rf "/var/www/html/api/$name"; cp -a "$entry" "/var/www/html/api/$name"
done
rm -f install.php
chmod +x api/bin/runtime/formlogic-runtime-linux-x86_64 || true
chown -R www-data:www-data api/storage api/logs || true
echo "files replaced; VERSION now $(cat VERSION)"
if [[ "${5:-}" == "--interrupt-after" ]]; then
  ( php api/bin/upgrade.php --app-version="$NEW_VERSION" > /tmp/upgrade-interrupted.log 2>&1 ) &
  sleep "$INTERRUPT"; echo "interrupting: killing PHP after ${INTERRUPT}s"; pkill -9 -f "upgrade.php" || true; sleep 1
  echo "--- partial log"; cat /tmp/upgrade-interrupted.log
  exit 0
fi
php api/bin/upgrade.php --app-version="$NEW_VERSION" 2>&1 | tail -8
echo "--- check"; php api/bin/upgrade.php --check 2>&1 | tail -6; echo "check exit ${PIPESTATUS[0]}"

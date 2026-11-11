#!/usr/bin/env bash
# Wekelijkse update van Immich en Nextcloud. Draait als root (cron), na de dagelijkse back-up.
# Slaat over als de back-up van vandaag niet met "klaar" is afgesloten.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
LOG=/var/log/huis-update.log
exec >>"$LOG" 2>&1
echo "=== $(date '+%F %T') start ==="
if ! grep -q "^=== $(date +%F) .* klaar ===" /var/log/huis-backup.log 2>/dev/null; then
  echo "Overgeslagen: er is vandaag geen geslaagde back-up."; exit 0
fi
for d in immich nextcloud; do
  echo "-- $d"
  (cd "$ROOT/$d" && docker compose pull -q && docker compose up -d) || echo "FOUT bij $d"
done
docker image prune -f >/dev/null
echo "=== $(date '+%F %T') klaar ==="

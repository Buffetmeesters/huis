#!/usr/bin/env bash
# Dagelijkse back-up van foto's (Immich), bestanden (Nextcloud) en het dashboard
# naar de gedeelde map op de Windows-computer (gemount op /mnt/backup).
# Draait als root (cron), want Nextcloud-bestanden zijn van www-data.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST=/mnt/backup/huis
DAG=$(date +%F)
LOG=/var/log/huis-backup.log
exec >>"$LOG" 2>&1
echo "=== $(date '+%F %T') start ==="

mountpoint -q /mnt/backup || mount /mnt/backup
mountpoint -q /mnt/backup || { echo "=== $(date '+%F %T') MISLUKT: /mnt/backup is niet gemount ==="; exit 1; }
mkdir -p "$DEST/verwijderd/$DAG"
FOUT=0
# -L: symbolische koppelingen als gewone bestanden kopieren (Windows-share kent ze niet)
R="rsync -rtL --no-perms --no-owner --no-group --delete --backup"
run() { "$@"; rc=$?; if [ $rc -ne 0 ] && [ $rc -ne 24 ]; then echo "FOUT (code $rc): $*"; FOUT=1; fi; }

# Nextcloud: database-dump, daarna alleen wat echt bewaard moet worden (programmacode komt uit de image terug)
if docker exec nextcloud-db-1 pg_dump -U nextcloud nextcloud | gzip > "$DEST/nextcloud-db.sql.gz.tmp"; then
  mv "$DEST/nextcloud-db.sql.gz.tmp" "$DEST/nextcloud-db.sql.gz"
else echo "FOUT: database-dump van Nextcloud mislukt"; FOUT=1; fi
for sub in data config custom_apps themes; do
  [ -d "$ROOT/cloud/nextcloud/html/$sub" ] && run $R --backup-dir="$DEST/verwijderd/$DAG/nextcloud/$sub" "$ROOT/cloud/nextcloud/html/$sub/" "$DEST/nextcloud/$sub/"
done

# Immich: de bibliotheek bevat ook de dagelijkse database-dumps van Immich zelf (map backups)
run $R --backup-dir="$DEST/verwijderd/$DAG/immich" "$ROOT/cloud/immich/library/" "$DEST/immich-library/"

# Dashboard (database met wachtwoorden en instellingen) en de .env-bestanden
run $R --backup-dir="$DEST/verwijderd/$DAG/dashboard" "$ROOT/data/" "$DEST/dashboard-data/"
mkdir -p "$DEST/env"; cp -p "$ROOT"/cloud/immich/.env "$DEST/env/immich.env"; cp -p "$ROOT"/cloud/nextcloud/.env "$DEST/env/nextcloud.env"

# Verwijderde/overschreven versies 30 dagen bewaren
find "$DEST/verwijderd" -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +
rmdir "$DEST/verwijderd/$DAG" 2>/dev/null || true
if [ $FOUT -eq 0 ]; then echo "=== $(date '+%F %T') klaar ==="; else echo "=== $(date '+%F %T') MET FOUTEN ==="; exit 1; fi

#!/usr/bin/env bash
# Dagelijkse back-up van foto's (Immich), bestanden (Nextcloud) en het dashboard
# naar de gedeelde map op de Windows-computer (gemount op /mnt/backup).
# Draait als root (cron), want Nextcloud-bestanden zijn van www-data.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST=/mnt/backup/huis
DAG=$(date +%F)
LOG=/var/log/huis-backup.log
exec >>"$LOG" 2>&1
echo "=== $(date '+%F %T') start ==="

mountpoint -q /mnt/backup || { mount /mnt/backup; }
mountpoint -q /mnt/backup || { echo "FOUT: /mnt/backup is niet gemount"; exit 1; }
mkdir -p "$DEST/verwijderd/$DAG"
R="rsync -rlt --no-perms --no-owner --no-group --delete --backup"

# Nextcloud: eerst een database-dump (consistent), dan de bestanden
docker exec nextcloud-db-1 pg_dump -U nextcloud nextcloud | gzip > "$DEST/nextcloud-db.sql.gz.tmp"
mv "$DEST/nextcloud-db.sql.gz.tmp" "$DEST/nextcloud-db.sql.gz"
$R --backup-dir="$DEST/verwijderd/$DAG/nextcloud" "$ROOT/cloud/nextcloud/html/" "$DEST/nextcloud-html/"

# Immich: de bibliotheek bevat ook de dagelijkse database-dumps van Immich zelf (map backups)
$R --backup-dir="$DEST/verwijderd/$DAG/immich" "$ROOT/cloud/immich/library/" "$DEST/immich-library/"

# Dashboard (database met wachtwoorden en instellingen) en de .env-bestanden
$R --backup-dir="$DEST/verwijderd/$DAG/dashboard" "$ROOT/data/" "$DEST/dashboard-data/"
mkdir -p "$DEST/env"; cp -p "$ROOT"/cloud/immich/.env "$DEST/env/immich.env"; cp -p "$ROOT"/cloud/nextcloud/.env "$DEST/env/nextcloud.env"

# Verwijderde/overschreven versies 30 dagen bewaren
find "$DEST/verwijderd" -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +
rmdir "$DEST/verwijderd/$DAG" 2>/dev/null || true
echo "=== $(date '+%F %T') klaar ==="

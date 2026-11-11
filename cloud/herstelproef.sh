#!/usr/bin/env bash
# Herstelproef: controleert of de back-up op de Windows-schijf echt bruikbaar is.
# Verandert niets aan je echte gegevens: alles wordt in tijdelijke kopieen en een tijdelijke database getest.
# Gebruik:  sudo ~/huis/cloud/herstelproef.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
B=/mnt/backup/huis
FOUT=0
ok()  { echo "  OK    $*"; }
bad() { echo "  FOUT  $*"; FOUT=1; }

mountpoint -q /mnt/backup || mount /mnt/backup 2>/dev/null
mountpoint -q /mnt/backup || { echo "FOUT: /mnt/backup is niet gemount"; exit 1; }
echo "Laatste back-up volgens het logboek: $(grep -E '=== .* (klaar|MET FOUTEN|MISLUKT) ===' /var/log/huis-backup.log 2>/dev/null | tail -1)"

echo; echo "1. Database van het dashboard"
DB=$(ls -t "$B"/dashboard-data/backups/*.db 2>/dev/null | head -1); [ -z "$DB" ] && DB="$B/dashboard-data/huis.db"
if [ -f "$DB" ]; then
  docker cp "$DB" huis-huis-1:/tmp/herstelproef.db 2>/dev/null
  R=$(docker exec huis-huis-1 node --experimental-sqlite -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/tmp/herstelproef.db');const i=d.prepare('pragma integrity_check').get().integrity_check;const t=d.prepare(\"select count(*) n from sqlite_master where type='table'\").get().n;let o='?';try{o=d.prepare('select count(*) n from owners').get().n}catch(e){};console.log(i+' '+t+' '+o)" 2>&1 | tail -1)
  docker exec huis-huis-1 rm -f /tmp/herstelproef.db 2>/dev/null
  case "$R" in ok\ *) ok "$(basename "$DB"): database in orde ($R = controle, tabellen, accounts)";; *) bad "database niet leesbaar: $R";; esac
else bad "geen database van het dashboard in de back-up"; fi

echo; echo "2. Database van Nextcloud (herstel in een tijdelijke database)"
if [ -f "$B/nextcloud-db.sql.gz" ] && gzip -t "$B/nextcloud-db.sql.gz" 2>/dev/null; then
  docker rm -f herstel-pg >/dev/null 2>&1
  docker run -d --rm --name herstel-pg -e POSTGRES_PASSWORD=x -e POSTGRES_USER=nextcloud -e POSTGRES_DB=nextcloud postgres:16-alpine >/dev/null
  for i in $(seq 1 30); do docker exec herstel-pg pg_isready -U nextcloud >/dev/null 2>&1 && break; sleep 1; done
  zcat "$B/nextcloud-db.sql.gz" | docker exec -i herstel-pg psql -U nextcloud nextcloud -q >/dev/null 2>&1
  T=$(docker exec herstel-pg psql -U nextcloud nextcloud -tAc "select count(*) from information_schema.tables where table_schema='public'" 2>/dev/null)
  U=$(docker exec herstel-pg psql -U nextcloud nextcloud -tAc "select count(*) from oc_users" 2>/dev/null)
  docker stop herstel-pg >/dev/null 2>&1
  if [ "${T:-0}" -gt 50 ] && [ "${U:-0}" -ge 1 ]; then ok "teruggezet: $T tabellen, $U gebruikers"; else bad "terugzetten mislukt (tabellen: ${T:-0}, gebruikers: ${U:-0})"; fi
else bad "nextcloud-db.sql.gz ontbreekt of is beschadigd"; fi

echo; echo "3. Bestanden: aantallen en steekproef"
check() { # naam bron doel
  local n="$1" src="$2" dst="$3" a b
  [ -d "$src" ] && [ -d "$dst" ] || { bad "$n: map ontbreekt"; return; }
  a=$(find "$src" -type f | wc -l); b=$(find "$dst" -type f | wc -l)
  if [ "$a" -gt 0 ] && [ "$b" -lt $(( a * 98 / 100 )) ]; then bad "$n: $b van $a bestanden in de back-up"; return; fi
  local bad_n=0
  while IFS= read -r f; do rel="${f#$src/}"; cmp -s "$f" "$dst/$rel" || bad_n=$((bad_n+1)); done < <(find "$src" -type f | shuf -n 20)
  [ "$bad_n" -eq 0 ] && ok "$n: $b van $a bestanden, steekproef van 20 is gelijk" || bad "$n: $bad_n van de 20 steekproefbestanden wijken af"
}
check "Foto's (Immich)" "$ROOT/cloud/immich/library" "$B/immich-library"
check "Nextcloud-bestanden" "$ROOT/cloud/nextcloud/html/data" "$B/nextcloud/data"
D=$(ls -t "$B"/immich-library/backups/*.sql.gz 2>/dev/null | head -1)
[ -n "$D" ] && ok "databasekopie van Immich: $(basename "$D")" || echo "  --    nog geen databasekopie van Immich (die maakt Immich zelf, elke nacht om 02:00)"

echo; [ $FOUT -eq 0 ] && echo "Herstelproef GESLAAGD." || echo "Herstelproef met FOUTEN: stuur deze uitvoer naar Claude."
exit $FOUT

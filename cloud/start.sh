#!/usr/bin/env bash
# Maakt (eenmalig) de wachtwoorden aan en start Immich en Nextcloud.
# Gebruik:  cd ~/huis/cloud && ./start.sh
set -e
cd "$(dirname "$0")"
rnd() { head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }

if [ ! -f immich/.env ]; then
  sed "s/^DB_PASSWORD=.*/DB_PASSWORD=$(rnd 24)/; s/^# TZ=.*/TZ=Europe\/Amsterdam/" immich/.env.example > immich/.env
  chmod 600 immich/.env
  echo "Immich: wachtwoorden aangemaakt (immich/.env)."
fi

if [ ! -f nextcloud/.env ]; then
  PW=$(rnd 20)
  cat > nextcloud/.env <<ENV
DB_PASSWORD=$(rnd 24)
ADMIN_USER=joshua
ADMIN_PASSWORD=$PW
DOMEIN=cloud.huizecpvh.nl
ENV
  chmod 600 nextcloud/.env
  echo
  echo "Nextcloud: gebruiker 'joshua', wachtwoord: $PW"
  echo "Bewaar dit in je wachtwoordmanager en wijzig het na de eerste keer inloggen."
  echo
fi

(cd immich && docker compose up -d)
(cd nextcloud && docker compose up -d)
docker ps --format 'table {{.Names}}\t{{.Status}}'

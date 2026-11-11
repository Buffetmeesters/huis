# Immich (foto's) en Nextcloud (bestanden)

Start: `cd ~/huis/cloud && ./start.sh`  (maakt bij de eerste keer de wachtwoorden aan)

- Immich:    http://192.168.178.69:2283  (buiten: foto.huizecpvh.nl)
- Nextcloud: http://192.168.178.69:8081  (buiten: cloud.huizecpvh.nl)

Buiten het huis: in Cloudflare Zero Trust > Networks > Tunnels > de tunnel > Public Hostname:
- foto.huizecpvh.nl  -> HTTP  192.168.178.69:2283
- cloud.huizecpvh.nl -> HTTP  192.168.178.69:8081

Update: `docker compose pull && docker compose up -d` in beide mappen.
Back-up: maak een kopie van cloud/immich/library, cloud/immich/postgres en cloud/nextcloud (db en html); de .env-bestanden bevatten wachtwoorden.

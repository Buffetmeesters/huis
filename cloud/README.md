# Immich (foto's) en Nextcloud (bestanden)

Start: `cd ~/huis/cloud && ./start.sh`  (maakt bij de eerste keer de wachtwoorden aan)

- Immich:    http://192.168.178.69:2283  (buiten: foto.huizecpvh.nl)
- Nextcloud: http://192.168.178.69:8081  (buiten: cloud.huizecpvh.nl)

Buiten het huis: in Cloudflare Zero Trust > Networks > Tunnels > de tunnel > Public Hostname:
- foto.huizecpvh.nl  -> HTTP  immich-web:2283
- cloud.huizecpvh.nl -> HTTP  nextcloud-web:80

Update: `docker compose pull && docker compose up -d` in beide mappen.
Back-up: maak een kopie van cloud/immich/library, cloud/immich/postgres en cloud/nextcloud (db en html); de .env-bestanden bevatten wachtwoorden.

## Back-up naar de Windows-computer (schijf P:)
Zie `backup.sh`. Eenmalig instellen (op de server):
1. `sudo apt install -y cifs-utils rsync`
2. `sudo mkdir -p /mnt/backup`
3. `sudo nano /root/.smbcreds` met twee regels: `username=backupvm` en `password=...` (het Windows-wachtwoord); daarna `sudo chmod 600 /root/.smbcreds`
4. Regel toevoegen in `/etc/fstab` (vervang IP van de Windows-computer):
   `//WINDOWS-IP/vmbackup /mnt/backup cifs credentials=/root/.smbcreds,uid=0,gid=0,vers=3.0,_netdev,nofail 0 0`
5. `sudo mount -a`
6. Proef: `sudo ~/huis/cloud/backup.sh && tail /var/log/huis-backup.log`
7. Dagelijks om 03:30: `echo '30 3 * * * root /home/joshua/huis/cloud/backup.sh' | sudo tee /etc/cron.d/huis-backup`

Terugzetten: kopieer de mappen terug; daarna `sudo chown -R 33:33 cloud/nextcloud/html` voor Nextcloud.

## Automatisch bijwerken (wekelijks)
`update.sh` haalt nieuwe versies van Immich en Nextcloud binnen, maar alleen als de back-up van vandaag is geslaagd.
Aanzetten (zondag 04:30, na de back-up van 03:30):
`echo '30 4 * * 0 root /home/joshua/huis/cloud/update.sh' | sudo tee /etc/cron.d/huis-update`
Logboek: `/var/log/huis-update.log`. Het dashboard zelf werk je handmatig bij (`git pull` en `docker compose up -d --build`).

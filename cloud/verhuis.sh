#!/usr/bin/env bash
# Na de verhuizing: past de adressen aan die op het netwerk van het nieuwe huis verschillen.
# Gebruik:  sudo ~/huis/cloud/verhuis.sh <IP-van-de-Windows-computer>
# Daarna nog doen: in het dashboard Admin > Adres zoeken (Home Assistant) en vaste IP's in de router.
set -euo pipefail
cd "$(dirname "$0")"
WIN="${1:-}"; FSTAB="${FSTAB:-/etc/fstab}"
[[ "$WIN" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Geef het IP-adres van de Windows-computer op, bijvoorbeeld: sudo $0 192.168.1.20"; exit 1; }
VM="$(hostname -I | awk '{print $1}')"
echo "Dit adres van de server: $VM; Windows-computer: $WIN"

# Back-upkoppeling naar de Windows-computer
if grep -q ' /mnt/backup ' "$FSTAB"; then
  sed -i -E "s#^//[0-9.]+/vmbackup #//$WIN/vmbackup #" "$FSTAB"
  systemctl daemon-reload; umount /mnt/backup 2>/dev/null || true; mount -a && echo "Back-upmap opnieuw gekoppeld."
fi

# Nextcloud: lokaal adres in de lijst met vertrouwde adressen (nummer 2, zoals bij de installatie)
docker exec -u www-data nextcloud-app-1 php occ config:system:set trusted_domains 2 --value="$VM" && echo "Nextcloud bijgewerkt."
echo "Klaar."

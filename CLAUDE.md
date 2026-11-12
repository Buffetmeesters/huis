# Huis-dashboard: overdracht voor een volgende sessie

Joshua (partner Lorenzo; hond Jolo; vogels Coco en Mango; kamerbewoner Dennis betaalt contant) bouwt een eigen smart-home dashboard.
Communiceert in het Nederlands, wil korte commando's en nette indelingen. Hij voert zelf de opdrachten op de server uit.
Verhuizing naar Frans Staelstraat 29, 5281 CW Boxtel op 1 december 2026: alle IP-adressen veranderen.

## Opbouw
- Dashboard: `server/server.js` (Node, node:sqlite, kv-tabel) en een bestand per pagina in `server/public/`: `index.html` (client), `admin.html`, `login.html`, `privacy.html`. Docker compose in de root; data in `data/` (niet in git).
- Draait op de Ubuntu-VM `docker` (Hyper-V op een Windows Server 2022; VM 500 GB schijf, 8 GB geheugen, 2 processors). Home Assistant draait in een tweede VM.
- Internet: Cloudflare-tunnel "Huis" (container `cloudflared`, token in `data/cf-token`). `huis.huizecpvh.nl` wijst naar het dashboard. `foto.` en `cloud.` wijzen naar `http://immich-web:2283` en `http://nextcloud-web:80` (containernamen op het netwerk `huis_default`, dus onafhankelijk van IP-adressen).
- Cloud: map `cloud/` met Immich (foto's) en Nextcloud (bestanden, thema "Huis CPvH", tweestapsverificatie aan), `start.sh`, `backup.sh` (elke nacht 03:30 naar de Windows-schijf P: via /mnt/backup), `update.sh` (zondag 04:30, alleen na geslaagde back-up), `verhuis.sh`, `herstelproef.sh` (test of de back-up echt terug te zetten is, verandert niets aan de echte gegevens). Immich heeft geen tweestapsverificatie; daar zijn lange unieke wachtwoorden de bescherming.
- Dashboard bijwerken: `git pull` en `docker compose up -d --build`. Dit gaat handmatig (niet automatiseren).

## Beveiliging, niet versoepelen
- Nooit sleutels of wachtwoorden in de chat laten typen. De Anthropic-sleutel gaat alleen in Admin, AI-assistent.
- Alleen Joshua logt in als Admin. Gasten kunnen op "alleen thuis" staan (Dennis niet).
- De AI-assistent "Fixie" mag het Huishoudboekje alleen voor Joshua en Lorenzo lezen (niet het Admin-account, niet gasten). Geheugen weigert gevoelige woorden.
- Back-ups bevatten wachtwoorden en sleutels. Bonnetjes staan in `data/huis.db`, niet in Nextcloud.

## Belangrijke onderdelen in server.js
- Helpers: session(), isAdmin(), OWNERS, kvGet/kvPut, haCfg()/haCall(). Nieuwe routes vóór het blok `/api/state/`.
- AI-assistent: kv `ai` (sleutel, model, naam, alias, context, web), kv `aimem` (geheugen), tools server-side via de eigen API met de cookie van de gebruiker, bevestigingsknop alleen bij schrijfacties (boodschappen); lampen en omroepen direct.
- Deurbel: `bellTick` kijkt elke 3 s naar de Hue-deurbelentiteit (automatisch gevonden, Admin, Deurbel), banner op open schermen en omroep via tts.
- Huishoudboekje: kv `boek` met leningen en categorieën, bankkoppeling via Enable Banking (Admin, `/api/bank/...`).

## Na de verhuizing (1 december)
1. Server, Home Assistant en Windows-computer aansluiten. Vaste IP's reserveren in de router.
2. `sudo ~/huis/cloud/verhuis.sh <IP-van-Windows-computer>` (past back-upmap en Nextcloud aan).
3. Dashboard, Admin, "Adres zoeken (na de verhuizing)": zoekt Home Assistant op het nieuwe netwerk, kies het adres, opslaan en testen.
4. Controleren of Hue, Sync Box en speakers weer verbonden zijn; zo niet opnieuw toevoegen in Home Assistant.
   Airco's: een ruimte onthoudt zijn airco (`room.ce`, entiteit in Home Assistant) en blijft zonder temperatuur staan als die verdwijnt. Zet oude ruimtes op "Niet gekoppeld" (Ruimtes, Airco in Home Assistant), verwijder de oude apparaten in Home Assistant, en koppel de nieuwe airco's in dezelfde keuzelijst (`HAC`); niet-gekoppelde staan ook in het klimaatoverzicht. Ander merk betekent andere entiteitnamen, dus alles opnieuw koppelen.
5. `huis.`, `foto.` en `cloud.huizecpvh.nl` werken zonder wijziging (tunnel). Controleer de volgende ochtend de back-up: `tail -n 3 /var/log/huis-backup.log`.

## Voor donderdag 12 november (Joshua is vrij)
1. Eerst: back-up van vannacht controleren (`tail -n 3 /var/log/huis-backup.log`) en `sudo ~/huis/cloud/herstelproef.sh` nog eens draaien (Immich heeft dan zijn databasekopie).
2. Daarna kiezen: (a) bewaking van de back-up in het dashboard (Admin-kaart met laatste back-up/update/schijfruimte; backup.sh schrijft dan een statusbestand naar `data/`, melding bij twee dagen zonder geslaagde back-up); (b) Fixie: timers/herinneringen, goedemorgen-overzicht op de tablet, agenda-afspraken maken met bevestigingsknop; (c) Huishoudboekje: jaaroverzicht per categorie met export inclusief bonnetjes, melding bij overschrijding maandbudget; (d) aanbellijst met tijdstippen en Fixie die kan antwoorden wie er aanbelde.

## Nog open (zie ook het Claude Doc "Huis-platform: wat staat er nog open")
- Tapo-camera's (controleer eerst RTSP/ONVIF), live beeld van de Hue-deurbel.
- Airco's door Fixie laten bedienen na installatie; cv-ketel Tado/slim thermostaat (merk en type nodig).
- Fixie en Immich: eventueel foto's laten zoeken (alleen Joshua en Lorenzo, aparte sleutel).
- Afvalkalender 2027, maandbudget in april, bankkoppeling met de bewindvoerder bespreken, Android-app (PWA), jolofix.nl.
- Overzichtsdocument: Claude Docs, project Gho4Mx2PdCiSQLTL25q5yu, blok 90e3d975-1a49.

## Android-app in de Play Store (nog te bouwen)
- Plan: de PWA als Trusted Web Activity verpakken (PWABuilder), als gesloten test of privé-app, niet openbaar. De app opent `huis.huizecpvh.nl`; dashboardwijzigingen komen zonder nieuwe Play Store-versie door (na `git pull` en `docker compose up -d --build`).
- Server: route `/.well-known/assetlinks.json` toevoegen (anders adresbalk), installatieknop, offline-scherm, snelkoppelingen, melding "Nieuwe versie, tik om te verversen". Sleutel van de app nooit in de chat; Joshua bewaart hem zelf.
- Jaarlijks: de app opnieuw laten bouwen in PWABuilder met dezelfde sleutel en uploaden, omdat Google een recent target API level eist (meestal deadline rond augustus; controleer de datum in de Play Console). Ontwikkelaarsaccount Google is eenmalig; het jaarbedrag dat Joshua kent is waarschijnlijk Apple.
- Jaarlijkse herinnering: juli 2027 (daarna elke juli).

## Afspraken bij wijzigingen
- Commit-bericht in het Nederlands; eindig met de twee attributieregels (Co-Authored-By en Claude-Session).
- Test eerst lokaal met een tijdelijke server (`PORT=8099 DATA_DIR=/tmp/xx node --experimental-sqlite server.js`) en een nagebootste Home Assistant, Anthropic en Open-Meteo.

# huis
Smart Home app (dashboard + server).

## Starten op de server
    docker compose up -d --build

Daarna bereikbaar op http://IP-VAN-DE-SERVER:8080
Gegevens (database en wachtwoorden) staan in de map `data/`.

## Inloggen
- Eerste keer: kies wachtwoorden voor Joshua en Lorenzo.
- Gasten loggen in met de code die een eigenaar aanmaakt (Gasten-tabblad).

## Bijwerken
    git pull
    docker compose up -d --build

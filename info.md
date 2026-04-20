# Home Assistant: HomeBudget Flow

Custom Integration für [Home Assistant](https://www.home-assistant.io/). Sie liest Kontostände und Sync-Status aus deiner HomeBudget-Flow-Instanz über die API (`/api/ha/snapshot`) mit **E-Mail- und Passwort-Login** (JWT), kein separates HA-API-Token.

Diese Datei wird in **HACS** als Beschreibung zur Integration angezeigt (`render_readme: false` in `hacs.json`). Die allgemeine Projektübersicht steht in [`README.md`](README.md).

## Installation mit HACS

1. In HACS: **Integrationen** → **⋮** → **Benutzerdefinierte Repositories**.
2. Repository-URL deines GitHub-Projekts eintragen, Kategorie **Integration**.
3. **HomeBudget Flow** installieren (über die angebotene Version / Release).
4. Home Assistant **neu starten**.
5. **Einstellungen** → **Geräte & Dienste** → **Integration hinzufügen** → **HomeBudget Flow**.

Passe die **Dokumentations-URL** in `manifest.json` an, falls dein GitHub-User oder Repo-Name abweicht.

## Manuelle Installation

1. Ordner `custom_components/homebudget_flow/` aus diesem Repository nach  
   `<HA-Konfigurationsverzeichnis>/custom_components/homebudget_flow/` kopieren  
   (Struktur beibehalten).
2. Home Assistant neu starten.
3. Wie oben: Integration über die UI hinzufügen.

## Einrichtung (Config Flow)

- **API-URL**: Basis-URL deines HomeBudget-Flow-Servers (ohne abschließenden Schrägstrich), z. B. `https://budget.example.com`.
- **E-Mail** und **Passwort**: dieselben Zugangsdaten wie in der Web-App.
- **Aktualisierung (Minuten)**: Abfrageintervall für den Snapshot (nach der ersten Einrichtung unter *Konfigurieren* der Integration änderbar).

### YAML (optional)

Ein Beispielblock für `configuration.yaml` liegt in  
`homebudget-flow/integrations/home-assistant/configuration.yaml`. Beim Start kann ein Eintrag importiert werden; den Block danach optional entfernen.

## Server-Anforderungen

Es wird nur noch das **App-JWT** verwendet (`/api/auth/login` → `/api/ha/snapshot`). Kein separates API-Token für Home Assistant.

## Sensoren

Pro Bankkonto (Namen enthalten den Kontonamen):

| Sensor | Beschreibung |
|--------|----------------|
| **Balance** | Kontostand (Zahl, monetär) |
| **Sync** | Gesamtstatus (`ok`, `error`, …), `last_error` als Attribut |
| **Zuletzt synchronisiert** | Zeitstempel (`device_class: timestamp`): spätester erfolgreicher Saldo- oder Umsatz-Sync; Attribute mit `balance_success_at` / `transactions_success_at` |

Zusätzlich (falls **Tag-Null-Datum** am Konto gesetzt): Sensoren **Konto · ohne Fixkosten** (Start, Ist, Soll, Ist−Soll), **Geld pro Tag**, und eine **Kamera** „… Day Zero · Saldo-Diagramm“ (PNG vom Server; Daten aus `/api/ha/dayzero-meltdown`). Die Kamera steht am selben Gerät wie die Sensoren; im Dashboard z. B. mit einer **Bild**-Karte (`camera.*`) anzeigen.

Daten kommen aus `/api/ha/snapshot` im eingestellten Intervall.

**Automationen:** z. B. wenn **Sync** nicht `ok` ist oder `last_error` gesetzt ist.

## Dokumentation in Home Assistant

Die **documentation**-URL in `manifest.json` verweist auf diese Datei (`info.md`), damit der Link in der HA-UI dieselbe Anleitung öffnet wie in HACS.

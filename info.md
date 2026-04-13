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
| **Saldo-Import** | `ok` / `error` / `unknown`: ob der letzte Saldo-Abruf zum letzten Versuch passt (`balance_success_at` ≥ `balance_attempt_at`). Attribute mit ISO-Zeitstempeln. |
| **Umsätze-Import** | `ok` / `error` / `unknown`: ob der letzte Umsatz-Abruf zum letzten Versuch passt (`transactions_*`). Attribute mit ISO-Zeitstempeln. |
| **Gehalt zuletzt (Datum)** | Buchungsdatum der letzten Buchung mit Standard-Kategorie „Gehalt“ unter „Geldeingang“ (Server-Cache), ISO-Datum `YYYY-MM-DD` oder leer. |
| **Gehalt zuletzt (Betrag)** | Betrag derselben Buchung (monetär); Attribut `last_salary_booking_date`. |

Daten kommen aus `/api/ha/snapshot` im eingestellten Intervall.

**Automationen:** z. B. wenn der Zustand von **Saldo-Import** oder **Umsätze-Import** `error` ist.

## Dokumentation in Home Assistant

Die **documentation**-URL in `manifest.json` verweist auf diese Datei (`info.md`), damit der Link in der HA-UI dieselbe Anleitung öffnet wie in HACS.

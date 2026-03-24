# HomeBudget Flow

**Private Finanz-App** mit Web-Oberfläche: Bankumsätze per **FinTS** einlesen, **Haushalte** und **Konten** verwalten, **Kategorien** und **Regeln** für die Budget-Vorbereitung — optional gekoppelt an **Home Assistant** (Kontostände, Sync-Status, Gehalt-Sensoren).

---

## Was du hier findest

| Bereich | Beschreibung |
|--------|----------------|
| **`homebudget-flow/`** | **FastAPI-Backend**, **React-Frontend** (Vite, MUI), Docker-Compose, SQL-Migrationen |
| **`custom_components/homebudget_flow/`** | **Home-Assistant-Integration** (Sensoren, Config Flow) |
| **`info.md`** | Ausführliche **HA-Anleitung** (HACS, manuelle Installation, Sensoren) — wird u. a. für HACS-Dokumentation genutzt |

Die technische Tiefe (Entwicklung, Docker-Varianten, Comdirect/FinTS) steht in **[`homebudget-flow/README.md`](homebudget-flow/README.md)**.

---

## Funktionen (Kurzüberblick)

- **Mehrbenutzer-Haushalte** — gemeinsame Konten und Buchungen ohne doppelte Konten
- **Bank-Synchronisation** — inkrementeller Abruf pro Konto, Sync-Status in der UI und für HA nutzbar
- **FinTS** — u. a. **Comdirect** über `python-fints` (PIN, Product-ID, optional TAN/Decoupled je nach Setup)
- **Kategorien & Regeln** — Zuordnung und Vorschläge für wiederkehrende Muster
- **Web-App** — Dashboard, Einstellungen (Einrichtung, Bank-Zugänge, Integration), Analysen
- **Home Assistant** — Login mit denselben Zugangsdaten wie in der App; Sensoren z. B. für Kontostand, Sync-Fehler, letztes Gehalt (siehe [`info.md`](info.md))

---

## Technologie-Stack

| Schicht | Technologie |
|--------|-------------|
| Backend | Python, **FastAPI**, async SQLAlchemy, APScheduler |
| Datenbank | **PostgreSQL** (Compose / Produktion) oder **SQLite** (lokal schnell starten) |
| Frontend | **React**, **Vite**, MUI |
| Bank | FinTS (Comdirect-Connector, erweiterbare Registry) |
| Integration | Home Assistant **Custom Component** (lokales Polling) |

---

## Schnellstart

### Web-App & API lokal (ohne Docker)

```bash
cd homebudget-flow/server
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

- UI: nach Build der Client-Dateien unter **`http://localhost:8000/`** (oder Client separat mit `npm run dev` — siehe unten)
- API-Dokumentation: **`http://localhost:8000/docs`**

### Frontend entwickeln

```bash
cd homebudget-flow/client
npm install
npm run dev
```

Vite nutzt **Port 3003** und leitet `/api` an das Backend auf **8000** weiter — `uvicorn` muss parallel laufen.

### Mit Docker

```bash
cd homebudget-flow
docker compose up --build
```

App im Browser: **`http://localhost:3003/`** (Mapping `3003:8000`).

**Weitere Varianten** (Hot-Reload, nur Postgres in Docker, SQLite): alles in **[`homebudget-flow/README.md`](homebudget-flow/README.md)**.

---

## Home Assistant

1. **HACS** oder manuell: Ordner `custom_components/homebudget_flow/` aus diesem Repo nach deine HA-`custom_components/`-Struktur kopieren.
2. Integration in HA hinzufügen: **API-URL**, **E-Mail/Passwort** wie in der Web-App, Intervall wählbar.

Details, Sensoren-Übersicht und YAML-Hinweis: **[`info.md`](info.md)**.

---

## Architektur-Prinzipien

- **Single Source of Truth** für Konten und Buchungen (keine Dubletten für geteilte Gruppen)
- **Inkrementeller Sync** pro Konto mit persistiertem Sync-Status
- **Modulare Bank-Connector-Registry** für weitere Institute

---

## Sicherheit

- **Keine** echten `.env`-Dateien oder Datenbank-Dateien mit Produktionsdaten ins Repository legen.
- In der Praxis: `JWT_SECRET`, DB-URL, FinTS-PIN und Product-ID nur über Umgebungsvariablen / lokale `.env` (siehe `server/.env.example`).

---

## Dokumentation — Einstieg

| Thema | Datei |
|--------|--------|
| Entwicklung, Docker, FinTS/Comdirect | [`homebudget-flow/README.md`](homebudget-flow/README.md) |
| Home Assistant (HACS, Sensoren) | [`info.md`](info.md) |
| HA-Beispiel-`configuration.yaml` | [`homebudget-flow/integrations/home-assistant/`](homebudget-flow/integrations/home-assistant/) |

Willkommen bei einem kleinen Stack, der **Alltag und Automatisierung** zusammenbringt — von der Buchung bis zum Sensor in HA.

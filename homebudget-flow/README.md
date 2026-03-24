# HomeBudget Flow

Private Finanz-App: automatisierter Bankimport, Multi-User-Haushalte, Budget-Vorbereitung und Anbindung an **Home Assistant**.

## Struktur

| Ordner | Inhalt |
|--------|--------|
| `server/` | Backend (FastAPI), Datenbank, Sync-Scheduler, Bank-Connectoren |
| `client/` | React-Oberfläche (Vite, MUI); Build landet in `server/app/static/ui/` |
| `integrations/home-assistant/` | Custom Component für Sensoren (Kontostand, Sync-Status) |

## Voraussetzungen

- Python **3.9+** (empfohlen: 3.10+ oder 3.12 wie im Docker-Image)

## Schnellstart (Entwicklung)

```bash
cd server
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

**Web-UI (React):** Einmal bauen oder separat per Vite starten (siehe unten).  
**Oberfläche (nur uvicorn):** `http://localhost:8000/` — SPA an der Wurzel, API unter `/api`.  
**API-Dokumentation:** `http://localhost:8000/docs` (Docker: App auf Host-Port **3003**).

### Web-Oberfläche entwickeln (`client/`)

```bash
cd client
npm install
npm run dev
```

Vite läuft auf **http://localhost:3003/** und proxyt `/api` auf den Backend-Port (**8000**). Parallel im Ordner `server/` `uvicorn` starten.

Für die Auslieferung durch FastAPI (Produktion / ohne zweiten Dev-Server):

```bash
cd client
npm install
npm run build
```

Die gebauten Dateien liegen unter `server/app/static/ui/`. Anschließend reicht `uvicorn` wie oben; die UI ist unter **`http://localhost:8000/`** erreichbar (alte Pfade **`/ui`** leiten nach **`/`** um).

Navigation: Seitenleiste **Übersicht**; **Einstellungen** (Einrichtung, Bank-Zugänge, Integration) und **Abmelden** über das **Benutzermenü** (Avatar). URLs: `/settings/setup`, `/settings/fints`, `/settings/integration`. Zusätzlich liefert die API **`GET /api/sync/overview`** (JWT) dieselbe Sync-Übersicht wie für die HA-Sensoren; **`GET /api/ha/snapshot`** nutzt ebenfalls das App-JWT.

## Docker

### Mount- und Betriebsvarianten (Überblick)

| Variante | Compose-Dateien | Source-Code im API-Container | Datenbank | Hot-Reload |
|----------|-----------------|------------------------------|-----------|------------|
| **1. Standard / „prod-like“** | nur `docker-compose.yml` | Im Image gebunden (kein Bind-Mount) | Postgres nur im Netzwerk, kein Host-Port | nein |
| **2. Dev: API + DB in Docker** | `docker-compose.yml` + `docker-compose.dev.yml` | Bind-Mount `./server/app` → `/app/app` | Postgres + **127.0.0.1:5432** nach außen | ja (`uvicorn --reload`) |
| **3. Dev: nur Postgres in Docker** | `docker-compose.yml` + `docker-compose.dev.yml`, nur Service `db` | API läuft **auf dem Host** (kein API-Container) | wie Zeile 2 | ja (lokales `uvicorn --reload`) |
| **4. Alles lokal ohne Docker-DB** | — | komplett auf dem Host | SQLite (`server/homebudget.db` per `.env`) | ja |

Details zu **2** und **3**: `docker-compose.dev.yml` ergänzt den **DB-Port** `127.0.0.1:5432:5432` und beim Service `api` das Volume **`./server/app:/app/app`** sowie den Startbefehl mit **`--reload`**.

---

### 1. Standard (ohne Source-Mount)

Code kommt aus dem Image; Änderungen am Host wirken erst nach **Rebuild**.

```bash
cd homebudget-flow
docker compose up --build
```

**Browser:** **http://localhost:3003/** (Compose `3003:8000`; im Container weiter Port 8000). Postgres nur intern im Compose-Netz.

---

### 2. Entwicklung: Postgres + API in Docker (Bind-Mount + Hot-Reload)

Host-Ordner `server/app` ist im Container unter `/app/app` eingehängt; Codeänderungen triggern Neustart durch `uvicorn --reload`.

```bash
cd homebudget-flow
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

Optional: Postgres zusätzlich vom Host ansprechbar (z. B. GUI-Tool) auf **127.0.0.1:5432**.

---

### 3. Entwicklung: nur Datenbank in Docker, API lokal

Kein Volume am API-Service nötig – du entwickelst direkt im Repo. Postgres wie in Variante 2 nach außen.

```bash
cd homebudget-flow
docker compose -f docker-compose.yml -f docker-compose.dev.yml up db
```

In `server/.env`:

```env
DATABASE_URL=postgresql+asyncpg://hb:hb@127.0.0.1:5432/homebudget
```

Dann:

```bash
cd server
source .venv/bin/activate   # falls venv
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

---

### 4. Schnellstart nur mit SQLite (ohne Docker)

Siehe oben unter **Schnellstart (Entwicklung)**: `DATABASE_URL` aus `.env.example` für SQLite lassen, kein Postgres nötig.

## Comdirect / FinTS

Der **Comdirect-Connector** nutzt **FinTS** (`python-fints`) wie dein Skript `fints_test.py`.

1. **`FINTS_PIN`** und **`FINTS_PRODUCT_ID`** in `server/.env` (DK-Registrierung); BLZ, FinTS-User und Endpoint kommen aus dem **Bank-Zugang** in der App (DB), nicht aus der `.env`.
2. Bankkont in der API anlegen mit **`external_id` = IBAN** (ohne Leerzeichen möglich, wird normalisiert).
3. Für Syncs ohne Konsole: bei PhotoTAN **`FINTS_TAN`** setzen; bei decoupled optional **`FINTS_DECOUPLED_WAIT_SEC`** (Sekunden Wartezeit vor Bestätigung in der App, nur in der Server-`.env`). Optional: alles nur per `.env` wie in `fints_test.py` (`FINTS_BLZ`, `FINTS_USER`, `FINTS_ENDPOINT`).

Implementierung: `server/app/services/bank/fints_runner.py`, `comdirect.py`.

## Home Assistant

Komponente nach `config/custom_components/homebudget_flow/` kopieren oder als Git-Submodule einbinden. Konfiguration siehe `integrations/home-assistant/README.md`.

## Architektur-Prinzipien

- **Single Source of Truth** für Konten und Buchungen (keine doppelten Konten bei geteilten Gruppen).
- **Inkrementeller Sync** pro Konto mit gespeichertem Sync-Status.
- **Modulare Connector-Registry** für weitere Banken.

import logging
import os
import mimetypes
from pathlib import Path
from contextlib import asynccontextmanager


def _configure_logging() -> None:
    """Root-Logger auf INFO (oder LOG_LEVEL), damit z. B. app.services.sync_service sichtbar loggt."""
    raw = (os.getenv("LOG_LEVEL") or "INFO").strip().upper()
    level = getattr(logging, raw, None)
    if not isinstance(level, int):
        level = logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        force=True,
    )
    if level > logging.DEBUG:
        logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)


_configure_logging()

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from app.api.routes import (
    accounts,
    auth,
    bank_credentials,
    categories,
    category_rules,
    contracts,
    ha,
    health,
    households,
    sync,
    transfers,
    transactions,
    user_settings,
)
from app.db.session import init_db
from app.scheduler import setup_scheduler


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    setup_scheduler()
    yield


app = FastAPI(title="HomeBudget Flow", version="0.1.0", lifespan=lifespan)

_ui = os.path.join(os.path.dirname(__file__), "static", "ui")
_ui_index = os.path.join(_ui, "index.html")
_ui_assets = os.path.join(_ui, "assets")

# Zuerst Mounts registrieren: sonst kann ``GET /{full_path:path}`` (SPA-Fallback) /assets/*.js
# abfangen und index.html (text/html) ausliefern — Safari meldet dann keinen gültigen JS-MIME-Type.
if os.path.isdir(_ui_assets):
    app.mount("/assets", StaticFiles(directory=_ui_assets), name="ui_assets")
    # Alte index.html mit base /ui/ — gleiche Dateien unter /ui/assets/…
    app.mount("/ui/assets", StaticFiles(directory=_ui_assets), name="ui_assets_legacy")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(auth.router, prefix="/api")
app.include_router(user_settings.router, prefix="/api")
app.include_router(households.router, prefix="/api")
app.include_router(categories.router, prefix="/api")
app.include_router(category_rules.router, prefix="/api")
app.include_router(bank_credentials.router, prefix="/api")
app.include_router(transactions.router, prefix="/api")
app.include_router(transfers.router, prefix="/api")
app.include_router(accounts.router, prefix="/api")
app.include_router(contracts.router, prefix="/api")
app.include_router(sync.router, prefix="/api")
app.include_router(ha.router, prefix="/api")


@app.get("/assets/{asset_path:path}")
async def ui_asset(asset_path: str):
    """
    Robuster Asset-Handler: verhindert, dass SPA-Fallback versehentlich HTML für JS/CSS ausliefert
    (Browser-Fehler: "'text/html' is not a valid JavaScript MIME type").

    Wenn StaticFiles-Mounts aktiv sind, matchen sie typischerweise vorher; dieser Handler ist ein Fallback.
    """
    base = Path(_ui_assets)
    candidate = (base / asset_path).resolve()
    try:
        base_resolved = base.resolve()
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="UI-Assets nicht vorhanden")

    if not str(candidate).startswith(str(base_resolved) + os.sep):
        raise HTTPException(status_code=404, detail="Asset nicht gefunden")
    if not candidate.is_file():
        raise HTTPException(status_code=404, detail="Asset nicht gefunden")

    media_type, _ = mimetypes.guess_type(str(candidate))
    return FileResponse(str(candidate), media_type=media_type or "application/octet-stream")


@app.get("/")
async def root_spa():
    """Gebaute React-App an der Wurzel; API bleibt unter ``/api``."""
    if os.path.isfile(_ui_index):
        return FileResponse(_ui_index)
    return {"title": "HomeBudget Flow", "docs": "/docs", "hint": "UI fehlt: im Ordner client `npm run build` ausführen."}


@app.get("/ui")
@app.get("/ui/")
async def legacy_ui_redirect():
    """Alte URLs ohne doppeltes Laden der SPA."""
    return RedirectResponse(url="/", status_code=307)


@app.get("/{full_path:path}")
async def spa_fallback(full_path: str):
    """Alle übrigen Pfade → SPA (API/Doku/Assets sind spezifischere Routen und zuerst registriert)."""
    _ = full_path
    if os.path.isfile(_ui_index):
        return FileResponse(_ui_index)
    raise HTTPException(status_code=404, detail="UI nicht gebaut")

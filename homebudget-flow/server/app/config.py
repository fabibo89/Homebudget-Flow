from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# server/-Verzeichnis (in Docker: WORKDIR /app, Code unter /app/app → parent.parent = /app)
_SERVER_DIR = Path(__file__).resolve().parent.parent

# In os.environ laden, bevor Settings() gebaut wird — sonst fehlen Werte in Docker, wenn nur Dateien
# existieren und pydantic die Datei nicht findet, oder wenn Compose nur Umgebungsvariablen setzt.
try:
    from dotenv import load_dotenv

    _env_files = [
        _SERVER_DIR / ".env",
        _SERVER_DIR.parent / ".env",
        _SERVER_DIR.parent.parent / ".env",
    ]
    for _env_path in _env_files:
        if _env_path.is_file():
            load_dotenv(_env_path, override=False)
except ImportError:
    pass


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=_SERVER_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: str = "sqlite+aiosqlite:///./homebudget.db"
    jwt_secret: str = "dev-change-me"
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 60 * 24 * 7

    # Fernet-Key (url-safe base64) für verschlüsselte PIN in bank_credentials
    credentials_fernet_key: str = ""

    sync_cron_hour: int = 6
    sync_cron_minute: int = 30

    # FinTS: optionaler Fallback ohne DB-Zugang (z. B. fints_test.py). Normal: BLZ/User/Endpoint in bank_credentials.
    fints_blz: str = ""
    fints_user: str = ""
    fints_pin: str = ""
    fints_endpoint: str = "https://fints.comdirect.de/fints"
    fints_product_id: str = ""
    # Einmalige TAN für automatisierte Syncs (PhotoTAN-Ziffern); leer = Fehler bei TAN-Pflicht
    fints_tan: str = ""
    # Optional: Sekunden vor send_tan("") bei decoupled (App-Bestätigung); nicht in der DB
    fints_decoupled_wait_sec: int = 0


settings = Settings()

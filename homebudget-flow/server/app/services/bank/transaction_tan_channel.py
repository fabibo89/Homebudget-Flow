"""Thread-sichere Brücke: FinTS-Worker wartet auf TAN, FastAPI liefert Challenge an die UI."""

from __future__ import annotations

import asyncio
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Any, Optional


@dataclass
class PendingSyncJob:
    job_id: str
    channel: "TransactionTanChannel"
    task: asyncio.Task
    user_id: int
    created_at: float
    # Nur bei Konten-Sync; bei FinTS-Zugang-Jobs None
    bank_account_id: Optional[int] = None
    # Nach erfolgreichem Job-Ende (FinTS-Test / Credential) für transaction-tan-Antwort
    result_payload: Optional[dict[str, Any]] = None


class TransactionTanChannel:
    """Challenge vom FinTS-Thread publizieren, TAN vom API-Thread liefern."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._mime = "application/octet-stream"
        self._data = b""
        self._hint = ""
        self._challenge_ready = threading.Event()
        self._tan_received = threading.Event()
        self._tan_value = ""

    def publish_challenge(self, mime: str, data: bytes, hint: str = "") -> None:
        with self._lock:
            self._mime = mime.strip() if mime else "application/octet-stream"
            self._data = bytes(data or b"")
            self._hint = (hint or "").strip()
        self._challenge_ready.set()

    def peek_challenge(self) -> tuple[str, bytes, str] | None:
        if not self._challenge_ready.is_set():
            return None
        with self._lock:
            return (self._mime, self._data, self._hint)

    def wait_for_tan(self, timeout: float) -> str:
        if not self._tan_received.wait(timeout):
            raise TimeoutError("Keine TAN innerhalb des Zeitlimits")
        with self._lock:
            return self._tan_value

    def provide_tan(self, tan: str) -> None:
        with self._lock:
            self._tan_value = tan.strip()
        self._tan_received.set()

    def reset_tan_wait(self) -> None:
        self._tan_received.clear()
        with self._lock:
            self._tan_value = ""


_jobs: dict[str, PendingSyncJob] = {}
_jobs_lock = threading.Lock()
_JOB_TTL_SEC = 900.0


def _prune_stale_jobs() -> None:
    now = time.time()
    with _jobs_lock:
        stale = [jid for jid, j in _jobs.items() if now - j.created_at > _JOB_TTL_SEC]
        for jid in stale:
            t = _jobs[jid].task
            if not t.done():
                t.cancel()
            del _jobs[jid]


def register_job(job: PendingSyncJob) -> None:
    _prune_stale_jobs()
    with _jobs_lock:
        _jobs[job.job_id] = job


def take_job(job_id: str, user_id: int) -> PendingSyncJob | None:
    _prune_stale_jobs()
    with _jobs_lock:
        j = _jobs.get(job_id)
        if j is None or j.user_id != user_id:
            return None
        return j


def remove_job(job_id: str) -> None:
    with _jobs_lock:
        _jobs.pop(job_id, None)


def attach_job_result(job_id: str, payload: dict[str, Any]) -> None:
    """Ergebnis eines async Jobs setzen (z. B. FinTS-Test), bevor der Task endet — für ``transaction-tan``-Antwort."""
    with _jobs_lock:
        j = _jobs.get(job_id)
        if j is not None:
            j.result_payload = payload


def new_job_id() -> str:
    return str(uuid.uuid4())


async def poll_until_tan_needed_or_task_done(
    task: asyncio.Task[Any],
    channel: "TransactionTanChannel",
) -> bool:
    """``True`` wenn der Task beendet ist; ``False`` wenn eine TAN-Challenge bereitsteht (Task läuft weiter)."""
    while True:
        if task.done():
            return True
        if channel.peek_challenge() is not None:
            return False
        await asyncio.sleep(0.05)

from __future__ import annotations

import logging
import hashlib
import os
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import delete, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CurrentUser
from app.config import settings
from app.db.models import EarningsDocument, EarningsDocumentLine
from app.db.session import get_session
from app.schemas.earnings_documents import (
    EarningsDocumentOut,
    EarningsDocumentsAnalysisOut,
    EarningsDocumentsImportResult,
    EarningsDocumentLineOut,
    EarningsDocumentsTimelineOut,
    EarningsDocumentsTimelinePoint,
    EarningsDocumentsTimelineMetricOut,
    EarningsDocumentsTimelineBreakdownOut,
    EarningsDocumentsTimelineBreakdownPoint,
    EarningsDocumentsTimelineBreakdownSeries,
)
from app.services.earnings_doc_parser import extract_pdf_text, parse_bmw_verdienstnachweis_from_pdf

router = APIRouter(prefix="/earnings-documents", tags=["earnings-documents"])
log = logging.getLogger(__name__)


def _norm_ws(s: str) -> str:
    return " ".join(str(s or "").replace("\u00a0", " ").strip().split())


def _norm_lower(s: str) -> str:
    return _norm_ws(s).lower()


def _infer_gesetzliche_abzuege_suffix(doc: dict, section_id: int) -> str | None:
    """
    Legacy PDFs nennen einzelne Blöcke teils nur "Gesetzliche Abzüge".
    Wir normalisieren für Anzeige/sectionpath, wenn klar ist ob es Steuer vs. Sozialversicherung ist.
    """

    def _descendants(root_id: int) -> set[int]:
        out: set[int] = set()
        stack = [root_id]
        while stack:
            cur = stack.pop()
            for cid in doc.get("children", {}).get(cur, []):
                if cid in out:
                    continue
                out.add(cid)
                stack.append(cid)
        return out

    desc = _descendants(section_id)
    tokens: list[str] = []
    for nid in desc | {section_id}:
        n = doc.get("nodes", {}).get(int(nid))
        if not n:
            continue
        tokens.append(_norm_lower(n.get("label") or ""))

    blob = " ".join([t for t in tokens if t])
    if not blob:
        return None

    steuer_keys = ["steuer", "lohnsteuer", "soli", "solidar", "kirchensteuer", "lst"]
    sozial_keys = ["sozial", "sozialversicherung", "kranken", "kv", "pflege", "pv", "rente", "rv", "arbeitslos", "av"]
    has_steuer = any(k in blob for k in steuer_keys)
    has_sozial = any(k in blob for k in sozial_keys)

    if has_steuer and not has_sozial:
        return "Steuer"
    if has_sozial and not has_steuer:
        return "Sozialversicherung"
    return None


def _normalized_section_label(doc: dict, section_id: int) -> str:
    n = doc.get("nodes", {}).get(int(section_id))
    raw = _norm_ws(str(n.get("label") if n else "")) or ""
    low = _norm_lower(raw)
    if low in ("gesetzliche abzuege", "gesetzliche abzüge"):
        suf = _infer_gesetzliche_abzuege_suffix(doc, int(section_id))
        if suf:
            return f"Gesetzliche Abzüge {suf}"
    return raw


def _safe_rel_path(p: str) -> str:
    v = (p or "").replace("\\", "/").strip().lstrip("/")
    # Normalisiere .. und doppelte Slashes
    parts: list[str] = []
    for seg in v.split("/"):
        s = seg.strip()
        if not s or s == ".":
            continue
        if s == "..":
            if parts:
                parts.pop()
            continue
        parts.append(s)
    return "/".join(parts)


def _compute_sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _storage_base_dir() -> Path:
    return Path(settings.earnings_docs_dir).expanduser()


def _build_storage_path(*, owner_user_id: int, sha256: str, file_name: str) -> Path:
    ext = Path(file_name).suffix[:16]
    base = _storage_base_dir() / f"user-{owner_user_id}"
    return base / f"{sha256}{ext}"


def _resolve_doc_storage_path(doc: EarningsDocument) -> Path:
    """
    Robust gegen alte DB-Einträge: versucht `doc.storage_path`, sonst rekonstruiert
    den Pfad aus aktuellem `earnings_docs_dir` + household_id + sha256 (+ Dateiendung).
    """
    raw = str(doc.storage_path or "").strip()
    if raw:
        p = Path(raw)
        if p.is_file():
            return p
        # relative Pfade relativ zum aktuellen Base-Dir interpretieren
        if not p.is_absolute():
            p2 = (_storage_base_dir().parent / p).resolve() if str(p).startswith("data/") else (_storage_base_dir() / p).resolve()
            if p2.is_file():
                return p2

    p3 = _build_storage_path(owner_user_id=int(doc.owner_user_id), sha256=str(doc.sha256), file_name=str(doc.file_name))
    return p3

def _to_out(doc: EarningsDocument) -> EarningsDocumentOut:
    return EarningsDocumentOut(
        id=int(doc.id),
        owner_user_id=int(doc.owner_user_id),
        uploaded_by_user_id=int(doc.uploaded_by_user_id) if doc.uploaded_by_user_id is not None else None,
        file_name=str(doc.file_name),
        mime=str(doc.mime or "application/octet-stream"),
        size_bytes=int(doc.size_bytes),
        sha256=str(doc.sha256),
        period_year=int(doc.period_year) if doc.period_year is not None else None,
        period_month=int(doc.period_month) if doc.period_month is not None else None,
        period_label=str(doc.period_label or ""),
        relative_path=str(doc.relative_path or ""),
        created_at=doc.created_at,
    )


async def _parse_and_persist_lines(session: AsyncSession, doc: EarningsDocument) -> int:
    await session.execute(delete(EarningsDocumentLine).where(EarningsDocumentLine.document_id == doc.id))
    try:
        p = _resolve_doc_storage_path(doc)
        pdf_bytes = p.read_bytes()
        parsed, (month, year, label) = parse_bmw_verdienstnachweis_from_pdf(pdf_bytes)
        txt = extract_pdf_text(pdf_bytes)
        # falls wir einen korrigierten Pfad gefunden haben: persistieren
        if str(doc.storage_path or "") != str(p):
            doc.storage_path = str(p)
    except Exception:
        log.exception("earnings-doc parse failed: doc_id=%s storage_path=%s", doc.id, doc.storage_path)
        txt = ""
        parsed = []
        month, year, label = None, None, ""
    doc.period_month = month
    doc.period_year = year
    doc.period_label = label or ""
    log.info(
        "earnings-doc parse: doc_id=%s file=%s text_len=%s parsed_lines=%s period=%s-%s",
        doc.id,
        doc.file_name,
        len(txt or ""),
        len(parsed),
        year,
        month,
    )

    current_section_id: int | None = None
    section_id_by_label: dict[str, int] = {}
    order = 0
    for pl in parsed:
        order += 1
        if pl.kind == "section":
            ln = EarningsDocumentLine(
                document_id=doc.id,
                parent_id=None,
                kind="section",
                label=pl.label,
                amount=None,
                currency="EUR",
                order_index=order,
            )
            session.add(ln)
            await session.flush()
            current_section_id = int(ln.id)
            section_id_by_label[str(pl.label)] = current_section_id
            continue
        ln = EarningsDocumentLine(
            document_id=doc.id,
            parent_id=current_section_id,
            kind=pl.kind,
            label=pl.label,
            amount=pl.amount,
            currency="EUR",
            order_index=order,
        )
        session.add(ln)

    # Sektion-Hierarchie (fachliche Struktur) nachträglich setzen:
    # Bruttoentgelt = Entgelt + Sonstige Bezüge
    # Nettoentgelt = Bruttoentgelt + Gesetzliche Abzüge Steuer + Gesetzliche Abzüge Sozialversicherung
    # Auszahlungsbetrag = Nettoentgelt + Persönliche Be- und Abzüge
    # (Überweisungen hängen wir unter Auszahlungsbetrag)
    section_parent = {
        "Entgelt": "Bruttoentgelt",
        "Sonstige Bezüge": "Bruttoentgelt",
        "Bruttoentgelt": "Nettoentgelt",
        "Gesetzliche Abzüge Steuer": "Nettoentgelt",
        "Gesetzliche Abzüge Sozialversicherung": "Nettoentgelt",
        # Legacy: un-suffixed block
        "Gesetzliche Abzüge": "Nettoentgelt",
        "Gesetzliche Abzuege": "Nettoentgelt",
        "Nettoentgelt": "Auszahlungsbetrag",
        "Persönliche Be- und Abzüge": "Auszahlungsbetrag",
        "Überweisungen": "Auszahlungsbetrag",
    }
    for child_label, parent_label in section_parent.items():
        child_id = section_id_by_label.get(child_label)
        parent_id = section_id_by_label.get(parent_label)
        if child_id is None or parent_id is None:
            continue
        await session.execute(
            update(EarningsDocumentLine)
            .where(EarningsDocumentLine.id == child_id)
            .values(parent_id=parent_id)
        )
    await session.commit()
    return len(parsed)


def _line_to_out(l: EarningsDocumentLine) -> EarningsDocumentLineOut:
    return EarningsDocumentLineOut(
        id=int(l.id),
        document_id=int(l.document_id),
        parent_id=int(l.parent_id) if l.parent_id is not None else None,
        kind=str(l.kind),
        label=str(l.label),
        amount=str(l.amount) if l.amount is not None else None,
        currency=str(l.currency or "EUR"),
        order_index=int(l.order_index),
    )


@router.get("", response_model=list[EarningsDocumentOut])
async def list_earnings_documents(
    user: CurrentUser,
    session: Annotated[AsyncSession, Depends(get_session)],
):
    r = await session.execute(
        select(EarningsDocument)
        .where(EarningsDocument.owner_user_id == user.id)
        .order_by(EarningsDocument.created_at.desc(), EarningsDocument.id.desc())
        .limit(5000)
    )
    return [_to_out(x) for x in r.scalars().all()]


@router.get("/timeline", response_model=EarningsDocumentsTimelineOut)
async def earnings_documents_timeline(
    user: CurrentUser,
    session: Annotated[AsyncSession, Depends(get_session)],
    prefix: list[str] | None = None,
    metric: str = "payout",
    from_ym: str | None = None,
    to_ym: str | None = None,
):
    """
    Zeitlicher Verlauf aus Positionswerten (nicht Dokumentanzahl).
    Derzeit: Auszahlungsbetrag + Gesamtbrutto pro Monat (Summe über Dokumente).
    Optionaler Filter über relative_path Prefix (Ordnerstruktur).
    """
    q_docs = select(EarningsDocument.id, EarningsDocument.period_year, EarningsDocument.period_month).where(
        EarningsDocument.owner_user_id == user.id,
        EarningsDocument.period_year.is_not(None),
        EarningsDocument.period_month.is_not(None),
    )
    if prefix:
        prefs: list[str] = []
        for pr in prefix:
            p = (pr or "").strip().replace("\\", "/").lstrip("/")
            if p:
                prefs.append(p)
        if prefs:
            q_docs = q_docs.where(or_(*[EarningsDocument.relative_path.like(f"{p}%") for p in prefs]))
    r_docs = await session.execute(q_docs)
    docs = [(int(did), int(y), int(m)) for (did, y, m) in r_docs.all()]
    if not docs:
        return EarningsDocumentsTimelineOut(metric=metric, points=[])

    def _parse_ym(s: str) -> tuple[int, int] | None:
        v = (s or "").strip()
        if not v:
            return None
        try:
            y, m = v.split("-", 1)
            yy = int(y)
            mm = int(m)
            if 1 <= mm <= 12:
                return yy, mm
        except Exception:
            return None
        return None

    ym_from = _parse_ym(from_ym) if from_ym else None
    ym_to = _parse_ym(to_ym) if to_ym else None
    if ym_from or ym_to:
        docs = [
            (did, y, m)
            for (did, y, m) in docs
            if (not ym_from or (y, m) >= ym_from) and (not ym_to or (y, m) <= ym_to)
        ]
        if not docs:
            return EarningsDocumentsTimelineOut(metric=metric, points=[])

    doc_ids = [d[0] for d in docs]
    r_lines = await session.execute(
        select(
            EarningsDocumentLine.document_id,
            EarningsDocumentLine.id,
            EarningsDocumentLine.parent_id,
            EarningsDocumentLine.kind,
            EarningsDocumentLine.label,
            EarningsDocumentLine.amount,
        ).where(EarningsDocumentLine.document_id.in_(doc_ids))
    )

    # pro Dokument: komplette Baumstruktur verfügbar machen
    by_doc: dict[int, dict] = {}
    for doc_id, lid, parent_id, kind, label, amount in r_lines.all():
        did = int(doc_id)
        d = by_doc.setdefault(did, {"nodes": {}, "children": {}, "items": []})
        lid_i = int(lid)
        pid_i = int(parent_id) if parent_id is not None else None
        k = str(kind or "")
        lab = str(label or "")
        d["nodes"][lid_i] = {"id": lid_i, "parent_id": pid_i, "kind": k, "label": lab}
        if pid_i is not None:
            d["children"].setdefault(pid_i, []).append(lid_i)
        if k != "section" and amount is not None:
            try:
                val = float(amount)
            except Exception:
                val = None
            if val is not None:
                d["items"].append((lid_i, lab, k, val))

    def _descendants(doc: dict, root_id: int) -> set[int]:
        out: set[int] = set()
        stack = [root_id]
        while stack:
            cur = stack.pop()
            ch = doc["children"].get(cur, [])
            for cid in ch:
                if cid in out:
                    continue
                out.add(cid)
                stack.append(cid)
        return out

    def _section_value(doc: dict, section_id: int, *, _memo: dict[int, float | None], exclude_transfers: bool = False) -> float | None:
        # Memoization
        if section_id in _memo:
            return _memo[section_id]

        # 1) Prefer direct sum-line under this section
        sum_val: float | None = None
        for cid in doc["children"].get(section_id, []):
            n = doc["nodes"].get(int(cid))
            if not n:
                continue
            if n.get("kind") == "sum":
                # find amount for this line id in items list
                for lid_i, _lab, k, val in doc["items"]:
                    if lid_i == int(cid) and k == "sum":
                        sum_val = float(val)
                        break
            if sum_val is not None:
                break
        if sum_val is not None:
            _memo[section_id] = sum_val
            return sum_val

        # 2) Sum direct child sections (recursive), optionally excluding transfers
        child_sections = []
        for cid in doc["children"].get(section_id, []):
            n = doc["nodes"].get(int(cid))
            if not n or n.get("kind") != "section":
                continue
            if exclude_transfers:
                lab = str(n.get("label") or "").strip().lower()
                if lab in ("überweisungen", "ueberweisungen"):
                    continue
            child_sections.append(int(cid))

        if child_sections:
            total = 0.0
            any_val = False
            for csid in child_sections:
                v = _section_value(doc, csid, _memo=_memo, exclude_transfers=False)
                if v is None:
                    continue
                any_val = True
                total += float(v)
            _memo[section_id] = total if any_val else None
            return _memo[section_id]

        # 3) Fallback: sum direct item lines (non-sum) directly under the section
        total = 0.0
        any_val = False
        for lid_i, _lab, k, val in doc["items"]:
            if k == "sum":
                continue
            n = doc["nodes"].get(int(lid_i))
            if not n:
                continue
            if int(n.get("parent_id")) != int(section_id):
                continue
            any_val = True
            total += float(val)
        _memo[section_id] = total if any_val else None
        return _memo[section_id]

    def doc_metric_value(doc_id: int) -> float | None:
        doc = by_doc.get(doc_id)
        if not doc:
            return None
        # convenience: flat label/value view for special metrics
        flat_lines = [(lab, val) for (_lid, lab, _k, val) in doc["items"]]
        m = (metric or "").strip()
        if not m:
            m = "payout"
        if m == "payout":
            for lab, val in flat_lines:
                if lab.lower().strip().startswith("auszahlungsbetrag"):
                    return val
            return None
        if m == "gross":
            for lab, val in flat_lines:
                if "gesamtbrutto" in lab.lower():
                    return val
            return None
        if m.startswith("line:"):
            target = m[5:].strip().lower()
            for lab, val in flat_lines:
                if lab.lower().strip() == target:
                    return val
            return None
        if m.startswith("contains:"):
            target = m[9:].strip().lower()
            for lab, val in flat_lines:
                if target and target in lab.lower():
                    return val
            return None
        if m.startswith("sectionpath:"):
            # eindeutiger Pfad wie "Auszahlungsbetrag/Nettoentgelt/Bruttoentgelt"
            target_path = [p.strip().lower() for p in m[len("sectionpath:") :].split("/") if p.strip()]
            if not target_path:
                return None

            # finde passende Section-ID per Pfad (über parent-chain)
            # baue Map label->ids (sections)
            section_ids = [nid for (nid, n) in doc["nodes"].items() if n["kind"] == "section"]
            # helper to build path for a section
            def _path_for(sid: int) -> list[str]:
                parts: list[str] = []
                cur = sid
                seen = set()
                while True:
                    if cur in seen:
                        break
                    seen.add(cur)
                    n = doc["nodes"].get(cur)
                    if not n:
                        break
                    if n["kind"] == "section":
                        parts.append(_normalized_section_label(doc, int(cur)).strip().lower())
                    pid = n.get("parent_id")
                    if pid is None:
                        break
                    cur = int(pid)
                return list(reversed([p for p in parts if p]))

            target_id: int | None = None
            for sid in section_ids:
                if _path_for(int(sid)) == target_path:
                    target_id = int(sid)
                    break
            if target_id is None:
                return None

            # Für Finanz-Sections NICHT rekursiv Items summieren (führt zu Doppeltzählung),
            # sondern Sum-Linie bevorzugen, sonst Child-Sections (Sum-Linien), sonst direkte Items.
            memo: dict[int, float | None] = {}
            exclude_transfers = bool(target_path and target_path[-1] == "auszahlungsbetrag")
            return _section_value(doc, target_id, _memo=memo, exclude_transfers=exclude_transfers)
        return None

    # pro Monat aggregieren
    by_ym: dict[tuple[int, int], float] = {}
    for did, y, m in docs:
        v = doc_metric_value(did)
        if v is None:
            continue
        by_ym[(y, m)] = by_ym.get((y, m), 0.0) + float(v)

    points = [
        EarningsDocumentsTimelinePoint(year=y, month=m, value=float(v))
        for (y, m), v in sorted(by_ym.items(), key=lambda x: (x[0][0], x[0][1]))
    ]
    return EarningsDocumentsTimelineOut(metric=metric, points=points)


@router.get("/timeline/breakdown", response_model=EarningsDocumentsTimelineBreakdownOut)
async def earnings_documents_timeline_breakdown(
    user: CurrentUser,
    session: Annotated[AsyncSession, Depends(get_session)],
    metric: str,
    from_ym: str | None = None,
    to_ym: str | None = None,
):
    """
    Stacked Breakdown für eine ausgewählte Section: zeigt die nächste Ebene darunter.
    Summe der Series je Monat ergibt den selektierten Wert (ohne 'sum'-Zeilen).
    """

    m = (metric or "").strip()
    if not m.startswith("sectionpath:"):
        raise HTTPException(status_code=400, detail="breakdown nur für sectionpath:* unterstützt")

    # Docs mit Zeitraum
    q_docs = select(EarningsDocument.id, EarningsDocument.period_year, EarningsDocument.period_month).where(
        EarningsDocument.owner_user_id == user.id,
        EarningsDocument.period_year.is_not(None),
        EarningsDocument.period_month.is_not(None),
    )
    r_docs = await session.execute(q_docs)
    docs = [(int(did), int(y), int(mm)) for (did, y, mm) in r_docs.all()]
    if not docs:
        return EarningsDocumentsTimelineBreakdownOut(metric=m, series=[], points=[])

    def _parse_ym(s: str) -> tuple[int, int] | None:
        v = (s or "").strip()
        if not v:
            return None
        try:
            y, mm = v.split("-", 1)
            yy = int(y)
            mmm = int(mm)
            if 1 <= mmm <= 12:
                return yy, mmm
        except Exception:
            return None
        return None

    ym_from = _parse_ym(from_ym) if from_ym else None
    ym_to = _parse_ym(to_ym) if to_ym else None
    if ym_from or ym_to:
        docs = [
            (did, y, mm)
            for (did, y, mm) in docs
            if (not ym_from or (y, mm) >= ym_from) and (not ym_to or (y, mm) <= ym_to)
        ]
        if not docs:
            return EarningsDocumentsTimelineBreakdownOut(metric=m, series=[], points=[])

    doc_ids = [d[0] for d in docs]
    r_lines = await session.execute(
        select(
            EarningsDocumentLine.document_id,
            EarningsDocumentLine.id,
            EarningsDocumentLine.parent_id,
            EarningsDocumentLine.kind,
            EarningsDocumentLine.label,
            EarningsDocumentLine.amount,
        ).where(EarningsDocumentLine.document_id.in_(doc_ids))
    )

    # Build per-doc tree same as timeline
    by_doc: dict[int, dict] = {}
    for doc_id, lid, parent_id, kind, label, amount in r_lines.all():
        did = int(doc_id)
        d = by_doc.setdefault(did, {"nodes": {}, "children": {}, "items": []})
        lid_i = int(lid)
        pid_i = int(parent_id) if parent_id is not None else None
        k = str(kind or "")
        lab = str(label or "")
        d["nodes"][lid_i] = {"id": lid_i, "parent_id": pid_i, "kind": k, "label": lab}
        if pid_i is not None:
            d["children"].setdefault(pid_i, []).append(lid_i)
        if k != "section" and amount is not None:
            try:
                val = float(amount)
            except Exception:
                val = None
            if val is not None:
                d["items"].append((lid_i, k, val))

    target_path = [p.strip().lower() for p in m[len("sectionpath:") :].split("/") if p.strip()]

    def _path_for(doc: dict, sid: int) -> list[str]:
        parts: list[str] = []
        cur = sid
        seen = set()
        while True:
            if cur in seen:
                break
            seen.add(cur)
            n = doc["nodes"].get(cur)
            if not n:
                break
            if n["kind"] == "section":
                parts.append(_normalized_section_label(doc, int(cur)).strip().lower())
            pid = n.get("parent_id")
            if pid is None:
                break
            cur = int(pid)
        return list(reversed([p for p in parts if p]))

    def _descendants(doc: dict, root_id: int) -> set[int]:
        out: set[int] = set()
        stack = [root_id]
        while stack:
            cur = stack.pop()
            for cid in doc["children"].get(cur, []):
                if cid in out:
                    continue
                out.add(cid)
                stack.append(cid)
        return out

    def _section_value(doc: dict, section_id: int, *, _memo: dict[int, float | None], exclude_transfers: bool = False) -> float | None:
        if section_id in _memo:
            return _memo[section_id]

        # direct sum line
        sum_val: float | None = None
        for cid in doc["children"].get(section_id, []):
            n = doc["nodes"].get(int(cid))
            if not n:
                continue
            if n.get("kind") == "sum":
                for lid_i, k, val in doc["items"]:
                    if lid_i == int(cid) and k == "sum":
                        sum_val = float(val)
                        break
            if sum_val is not None:
                break
        if sum_val is not None:
            _memo[section_id] = sum_val
            return sum_val

        # child sections
        child_sections = []
        for cid in doc["children"].get(section_id, []):
            n = doc["nodes"].get(int(cid))
            if not n or n.get("kind") != "section":
                continue
            if exclude_transfers:
                lab = str(n.get("label") or "").strip().lower()
                if lab in ("überweisungen", "ueberweisungen"):
                    continue
            child_sections.append(int(cid))
        if child_sections:
            total = 0.0
            any_val = False
            for csid in child_sections:
                v = _section_value(doc, csid, _memo=_memo, exclude_transfers=False)
                if v is None:
                    continue
                any_val = True
                total += float(v)
            _memo[section_id] = total if any_val else None
            return _memo[section_id]

        # direct items (non-sum)
        total = 0.0
        any_val = False
        for lid_i, k, val in doc["items"]:
            if k == "sum":
                continue
            n = doc["nodes"].get(int(lid_i))
            if not n:
                continue
            if int(n.get("parent_id")) != int(section_id):
                continue
            any_val = True
            total += float(val)
        _memo[section_id] = total if any_val else None
        return _memo[section_id]

    # determine target label + series from first doc that contains target
    series_ids: list[tuple[str, str, int]] = []  # (id,label,depth)
    target_label_norm: str | None = None
    for _did, _y, _mm in docs:
        doc = by_doc.get(_did)
        if not doc:
            continue
        section_ids = [nid for (nid, n) in doc["nodes"].items() if n["kind"] == "section"]
        target_id = None
        for sid in section_ids:
            if _path_for(doc, int(sid)) == target_path:
                target_id = int(sid)
                break
        if target_id is None:
            continue
        target_label_norm = str(doc["nodes"].get(int(target_id), {}).get("label") or "").strip().lower()

        child_sections = [
            int(cid)
            for cid in doc["children"].get(target_id, [])
            if doc["nodes"].get(int(cid), {}).get("kind") == "section"
        ]

        def _add_item_series(item_labels: list[str]) -> None:
            for lab in item_labels:
                clean = (lab or "").strip()
                if not clean:
                    continue
                sid = f"{m}/item:{clean}"
                series_ids.append((sid, clean, 0))

        # Spezialfall: Persönliche Be- und Abzüge -> eine Ebene tiefer (Items)
        if target_label_norm == "persönliche be- und abzüge" or target_label_norm == "persoenliche be- und abzuege":
            desc = _descendants(doc, target_id)
            labels: list[str] = []
            for lid_i, k, _val in doc["items"]:
                if k == "sum":
                    continue
                if lid_i in desc:
                    labels.append(str(doc["nodes"].get(lid_i, {}).get("label") or "").strip())
            # dedupe keeping first appearance
            seen_lab = set()
            dedup = []
            for lab in labels:
                if not lab or lab in seen_lab:
                    continue
                seen_lab.add(lab)
                dedup.append(lab)
            _add_item_series(dedup)
            break

        # Standard: direkte Unter-Sektionen
        for csid in child_sections:
            lab = str(doc["nodes"][csid].get("label") or "").strip() or "(ohne Name)"
            # In "Auszahlungsbetrag" soll Überweisungen nicht als Breakdown-Serie erscheinen.
            if target_label_norm == "auszahlungsbetrag" and (lab.lower() == "überweisungen" or lab.lower() == "ueberweisungen"):
                continue
            sid = f"{m}/child:{lab}"
            series_ids.append((sid, lab, 0))
        break

    if not series_ids:
        return EarningsDocumentsTimelineBreakdownOut(metric=m, series=[], points=[])

    # compute per month aggregates
    by_ym: dict[tuple[int, int], dict[str, float]] = {}
    for did, y, mm in docs:
        doc = by_doc.get(did)
        if not doc:
            continue
        # find target section id in this doc
        section_ids = [nid for (nid, n) in doc["nodes"].items() if n["kind"] == "section"]
        target_id = None
        for sid in section_ids:
            if _path_for(doc, int(sid)) == target_path:
                target_id = int(sid)
                break
        if target_id is None:
            continue

        target_label_norm_doc = str(doc["nodes"].get(int(target_id), {}).get("label") or "").strip().lower()
        is_personal = target_label_norm_doc == "persönliche be- und abzüge" or target_label_norm_doc == "persoenliche be- und abzuege"

        # map label->section id for direct children (standard)
        child_map: dict[str, int] = {}
        if not is_personal:
            for cid in doc["children"].get(target_id, []):
                cn = doc["nodes"].get(int(cid))
                if not cn or cn.get("kind") != "section":
                    continue
                lab = str(cn.get("label") or "").strip() or "(ohne Name)"
                child_map[lab] = int(cid)

        agg = by_ym.setdefault((y, mm), {})
        for _sid, lab, _depth in series_ids:
            if is_personal and _sid.startswith(f"{m}/item:"):
                # Summe je Item-Label im Subtree
                total = 0.0
                any_val = False
                for lid_i, k, val in doc["items"]:
                    if k == "sum":
                        continue
                    lab2 = str(doc["nodes"].get(lid_i, {}).get("label") or "").strip()
                    if lab2 != lab:
                        continue
                    n = doc["nodes"].get(int(lid_i))
                    if not n or int(n.get("parent_id")) != int(target_id):
                        continue
                    any_val = True
                    total += float(val)
                if any_val:
                    agg[_sid] = agg.get(_sid, 0.0) + float(total)
            else:
                csid = child_map.get(lab)
                if csid is None:
                    continue
                memo: dict[int, float | None] = {}
                exclude_transfers = target_label_norm_doc == "auszahlungsbetrag"
                v = _section_value(doc, csid, _memo=memo, exclude_transfers=exclude_transfers)
                if v is not None:
                    agg[_sid] = agg.get(_sid, 0.0) + float(v)

    points = [
        EarningsDocumentsTimelineBreakdownPoint(year=y, month=mm, values=v)
        for (y, mm), v in sorted(by_ym.items(), key=lambda x: (x[0][0], x[0][1]))
    ]
    series = [EarningsDocumentsTimelineBreakdownSeries(id=sid, label=lab, depth=depth) for (sid, lab, depth) in series_ids]
    return EarningsDocumentsTimelineBreakdownOut(metric=m, series=series, points=points)


@router.get("/timeline/metrics", response_model=list[EarningsDocumentsTimelineMetricOut])
async def earnings_documents_timeline_metrics(
    user: CurrentUser,
    session: Annotated[AsyncSession, Depends(get_session)],
    prefix: list[str] | None = None,
) -> list[EarningsDocumentsTimelineMetricOut]:
    # feste "Top"-Metriken (nur die, die nicht bereits als Section vorkommen)
    fixed: list[EarningsDocumentsTimelineMetricOut] = [
        EarningsDocumentsTimelineMetricOut(id="gross", label="Gesamtbrutto", depth=0),
    ]

    q = select(EarningsDocument.id).where(EarningsDocument.owner_user_id == user.id)
    if prefix:
        prefs: list[str] = []
        for pr in prefix:
            p = (pr or "").strip().replace("\\", "/").lstrip("/")
            if p:
                prefs.append(p)
        if prefs:
            q = q.where(or_(*[EarningsDocument.relative_path.like(f"{p}%") for p in prefs]))
    # best-effort: zuletzt importiertes Dokument (Zeitraum kann fehlen)
    q = q.order_by(EarningsDocument.created_at.desc(), EarningsDocument.id.desc()).limit(1)
    r = await session.execute(q)
    doc_id = r.scalar_one_or_none()
    if doc_id is None:
        return fixed

    r_lines = await session.execute(
        select(EarningsDocumentLine.id, EarningsDocumentLine.parent_id, EarningsDocumentLine.kind, EarningsDocumentLine.label)
        .where(EarningsDocumentLine.document_id == int(doc_id))
        .order_by(EarningsDocumentLine.order_index.asc(), EarningsDocumentLine.id.asc())
    )
    nodes = {}
    children: dict[int, list[int]] = {}
    roots: list[int] = []
    for lid, pid, kind, label in r_lines.all():
        lid_i = int(lid)
        pid_i = int(pid) if pid is not None else None
        k = str(kind or "")
        lab = str(label or "")
        nodes[lid_i] = {"id": lid_i, "parent_id": pid_i, "kind": k, "label": lab}
        if pid_i is None and k == "section":
            roots.append(lid_i)
        if pid_i is not None:
            children.setdefault(pid_i, []).append(lid_i)

    out: list[EarningsDocumentsTimelineMetricOut] = []

    def walk(sid: int, depth: int, path: list[str]) -> None:
        n = nodes.get(sid)
        if not n or n["kind"] != "section":
            return
        lab = _normalized_section_label({"nodes": nodes, "children": children}, int(sid)).strip()
        next_path = path + [lab]
        metric_id = "sectionpath:" + "/".join([p for p in next_path if p])
        out.append(EarningsDocumentsTimelineMetricOut(id=metric_id, label=lab or "(ohne Name)", depth=depth))
        for cid in children.get(sid, []):
            cn = nodes.get(cid)
            if not cn:
                continue
            if cn["kind"] == "section":
                walk(int(cid), depth + 1, next_path)

    for rid in roots:
        walk(int(rid), 0, [])

    # dedupe by id, keep first occurrence
    seen = set()
    deduped: list[EarningsDocumentsTimelineMetricOut] = []
    for m in out:
        if m.id in seen:
            continue
        seen.add(m.id)
        deduped.append(m)

    return deduped + fixed


@router.post("/import", response_model=EarningsDocumentsImportResult)
async def import_earnings_documents(
    paths: Annotated[list[str], Form()],
    files: Annotated[list[UploadFile], File()],
    user: CurrentUser,
    session: Annotated[AsyncSession, Depends(get_session)],
):
    if len(files) == 0:
        raise HTTPException(status_code=400, detail="Keine Dateien empfangen")
    if len(paths) != len(files):
        raise HTTPException(status_code=400, detail="paths/files Länge passt nicht")

    log.info(
        "earnings-doc import: owner_user_id=%s files=%s paths=%s names=%s",
        user.id,
        len(files),
        len(paths),
        [f.filename for f in files],
    )

    imported: list[EarningsDocument] = []
    skipped_existing = 0

    for i, uf in enumerate(files):
        raw = await uf.read()
        if not raw:
            continue
        sha = _compute_sha256(raw)
        rel = _safe_rel_path(paths[i] or uf.filename or "")
        fname = (uf.filename or Path(rel).name or "document").strip()
        mime = (uf.content_type or "application/octet-stream").strip()
        size_bytes = len(raw)

        r_existing = await session.execute(
            select(EarningsDocument).where(
                EarningsDocument.owner_user_id == user.id,
                EarningsDocument.sha256 == sha,
            )
        )
        existing = r_existing.scalar_one_or_none()
        if existing is not None:
            skipped_existing += 1
            continue

        storage_path = _build_storage_path(owner_user_id=user.id, sha256=sha, file_name=fname)
        storage_path.parent.mkdir(parents=True, exist_ok=True)
        # Schreibe atomar: erst temp, dann replace
        tmp_path = storage_path.with_suffix(storage_path.suffix + ".tmp")
        tmp_path.write_bytes(raw)
        tmp_path.replace(storage_path)

        doc = EarningsDocument(
            owner_user_id=user.id,
            uploaded_by_user_id=user.id,
            file_name=fname,
            mime=mime,
            size_bytes=size_bytes,
            sha256=sha,
            relative_path=rel,
            storage_path=str(storage_path),
        )
        session.add(doc)
        imported.append(doc)

    await session.commit()

    # refresh IDs / timestamps
    for d in imported:
        await session.refresh(d)
        await _parse_and_persist_lines(session, d)

    return EarningsDocumentsImportResult(
        imported=len(imported),
        skipped_existing=skipped_existing,
        items=[_to_out(x) for x in imported],
    )


@router.get("/{doc_id}/download")
async def download_earnings_document(
    doc_id: int,
    user: CurrentUser,
    session: Annotated[AsyncSession, Depends(get_session)],
):
    r = await session.execute(select(EarningsDocument).where(EarningsDocument.id == doc_id))
    doc = r.scalar_one_or_none()
    if doc is None:
        raise HTTPException(status_code=404, detail="Dokument nicht gefunden")
    if int(doc.owner_user_id) != int(user.id):
        raise HTTPException(status_code=403, detail="Kein Zugriff")

    p = _resolve_doc_storage_path(doc)
    if not p.is_file():
        raise HTTPException(status_code=404, detail="Datei fehlt auf dem Server")
    media_type = doc.mime or "application/octet-stream"
    return FileResponse(str(p), media_type=media_type, filename=doc.file_name)


@router.get("/{doc_id}/lines", response_model=list[EarningsDocumentLineOut])
async def list_earnings_document_lines(
    doc_id: int,
    user: CurrentUser,
    session: Annotated[AsyncSession, Depends(get_session)],
):
    r = await session.execute(select(EarningsDocument).where(EarningsDocument.id == doc_id))
    doc = r.scalar_one_or_none()
    if doc is None:
        raise HTTPException(status_code=404, detail="Dokument nicht gefunden")
    if int(doc.owner_user_id) != int(user.id):
        raise HTTPException(status_code=403, detail="Kein Zugriff")
    r2 = await session.execute(
        select(EarningsDocumentLine)
        .where(EarningsDocumentLine.document_id == doc_id)
        .order_by(EarningsDocumentLine.order_index.asc(), EarningsDocumentLine.id.asc())
    )
    return [_line_to_out(x) for x in r2.scalars().all()]


@router.post("/{doc_id}/rerun")
async def rerun_earnings_document_analysis(
    doc_id: int,
    user: CurrentUser,
    session: Annotated[AsyncSession, Depends(get_session)],
):
    r = await session.execute(select(EarningsDocument).where(EarningsDocument.id == doc_id))
    doc = r.scalar_one_or_none()
    if doc is None:
        raise HTTPException(status_code=404, detail="Dokument nicht gefunden")
    if int(doc.owner_user_id) != int(user.id):
        raise HTTPException(status_code=403, detail="Kein Zugriff")
    parsed_lines = await _parse_and_persist_lines(session, doc)
    return {"ok": True, "parsed_lines": parsed_lines}


@router.delete("/{doc_id}")
async def delete_earnings_document(
    doc_id: int,
    user: CurrentUser,
    session: Annotated[AsyncSession, Depends(get_session)],
):
    r = await session.execute(select(EarningsDocument).where(EarningsDocument.id == doc_id))
    doc = r.scalar_one_or_none()
    if doc is None:
        raise HTTPException(status_code=404, detail="Dokument nicht gefunden")
    if int(doc.owner_user_id) != int(user.id):
        raise HTTPException(status_code=403, detail="Kein Zugriff")
    # Best effort: Datei löschen
    try:
        p = _resolve_doc_storage_path(doc)
        if p.is_file():
            p.unlink()
    except Exception:
        pass
    await session.execute(delete(EarningsDocument).where(EarningsDocument.id == doc_id))
    await session.commit()
    return {"ok": True}


@router.get("/analysis", response_model=EarningsDocumentsAnalysisOut)
async def earnings_documents_analysis(
    user: CurrentUser,
    session: Annotated[AsyncSession, Depends(get_session)],
):
    r = await session.execute(
        select(EarningsDocument.relative_path).where(EarningsDocument.owner_user_id == user.id)
    )
    paths = [str(x[0] or "") for x in r.all()]
    total = len(paths)

    by_top: dict[str, int] = {}
    by_year: dict[str, int] = {}
    for p in paths:
        segs = [s for s in p.replace("\\", "/").split("/") if s]
        if segs:
            by_top[segs[0]] = by_top.get(segs[0], 0) + 1
            if len(segs[0]) == 4 and segs[0].isdigit():
                by_year[segs[0]] = by_year.get(segs[0], 0) + 1

    def _kv(d: dict[str, int]) -> list[dict]:
        return [{"key": k, "count": int(v)} for k, v in sorted(d.items(), key=lambda x: (-x[1], x[0]))]

    return EarningsDocumentsAnalysisOut(total=total, by_top_level=_kv(by_top), by_year=_kv(by_year))


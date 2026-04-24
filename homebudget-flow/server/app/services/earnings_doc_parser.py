from __future__ import annotations

import io
import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Optional

import pdfplumber


@dataclass
class ParsedLine:
    kind: str  # section | item | sum
    level: int
    label: str
    amount: Optional[Decimal]


GERMAN_MONTHS = {
    "januar": 1,
    "februar": 2,
    "märz": 3,
    "maerz": 3,
    "april": 4,
    "mai": 5,
    "juni": 6,
    "juli": 7,
    "august": 8,
    "september": 9,
    "oktober": 10,
    "november": 11,
    "dezember": 12,
}


def extract_period_month_year(text: str) -> tuple[Optional[int], Optional[int], str]:
    """
    Extrahiert (Monat, Jahr) aus BMW-PDF-Header wie "für Januar 2023".
    Rückgabe: (month, year, label) — label z.B. "Januar 2023" oder "" wenn unbekannt.
    """
    if not text:
        return None, None, ""
    m = re.search(r"\bfür\s+([A-Za-zÄÖÜäöüß]+)\s+(\d{4})\b", text)
    if not m:
        return None, None, ""
    mon_raw = (m.group(1) or "").strip()
    year_raw = (m.group(2) or "").strip()
    year = int(year_raw) if year_raw.isdigit() else None
    key = mon_raw.lower().replace("ä", "ae").replace("ö", "oe").replace("ü", "ue")
    # allow both März and Maerz through mapping
    month = GERMAN_MONTHS.get(mon_raw.lower()) or GERMAN_MONTHS.get(key)
    label = f"{mon_raw} {year_raw}" if (mon_raw and year_raw) else ""
    return month, year, label


_RE_AMOUNT = re.compile(r"(?P<raw>\d{1,3}(?:\.\d{3})*,\d{2})(?P<trailing_minus>-?)$")


def extract_pdf_text(pdf_bytes: bytes) -> str:
    # Wir extrahieren *Text* für Zeitraum-Erkennung; Tabellenzeilen werden später
    # per pdfplumber (Layout/Koordinaten) verarbeitet.
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        parts: list[str] = []
        for page in pdf.pages:
            t = page.extract_text() or ""
            if t:
                parts.append(t)
        return "\n".join(parts).strip()


def _extract_bmw_rows_with_columns(pdf_bytes: bytes) -> list[dict]:
    """
    Extrahiert Tabellenzeilen aus BMW-„Verdienstnachweis“ per Layout-Koordinaten.
    Rückgabe pro Zeile:
      { label: str, kind_hint: "sum"|"item", jahreswert, betrag, wert, betrag_pro_einh }
    Werte sind Decimals oder None.
    """

    def group_words_into_rows(words: list[dict]) -> list[list[dict]]:
        # group by 'top' with a small tolerance, then sort by x0
        rows: list[list[dict]] = []
        for w in sorted(words, key=lambda d: (d.get("top", 0.0), d.get("x0", 0.0))):
            top = float(w.get("top", 0.0))
            placed = False
            for r in rows:
                if abs(float(r[0].get("top", 0.0)) - top) <= 2.5:
                    r.append(w)
                    placed = True
                    break
            if not placed:
                rows.append([w])
        for r in rows:
            r.sort(key=lambda d: float(d.get("x0", 0.0)))
        return rows

    def row_text(row: list[dict]) -> str:
        return _normalize_line(" ".join(str(w.get("text", "")).strip() for w in row if str(w.get("text", "")).strip()))

    section_names = {
        "Entgelt",
        "Sonstige Bezüge",
        "Bruttoentgelt",
        # Legacy PDFs sometimes omit the suffix and only show "Gesetzliche Abzüge"
        "Gesetzliche Abzüge",
        "Gesetzliche Abzuege",
        "Gesetzliche Abzüge Steuer",
        "Gesetzliche Abzüge Sozialversicherung",
        "Nettoentgelt",
        "Persönliche Be- und Abzüge",
        "Auszahlungsbetrag",
        "Überweisungen",
        "BMW Betriebliche Altersversorgung",
        "Geldwerte Vorteile",
    }

    out: list[dict] = []

    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for page in pdf.pages:
            words = page.extract_words(keep_blank_chars=False, use_text_flow=True) or []
            if not words:
                continue
            rows = group_words_into_rows(words)

            # Find header positions to derive column x0 thresholds.
            header_row: list[dict] | None = None
            for r in rows:
                t = row_text(r)
                if "Jahreswert" in t and "Betrag" in t and "Wert" in t:
                    header_row = r
                    break
            if header_row is None:
                continue

            def x0_for_token(tok: str) -> float | None:
                tok_l = tok.lower()
                for w in header_row or []:
                    if str(w.get("text", "")).strip().lower() == tok_l:
                        return float(w.get("x0", 0.0))
                return None

            x_j = x0_for_token("Jahreswert")
            x_w = x0_for_token("Wert")

            # "Betrag" kann im Header doppelt vorkommen: einmal in "Betrag / Einh." und einmal als eigene Spalte.
            # Wir wählen den "Betrag"-Header, der zwischen "Wert" und "Jahreswert" liegt (wenn möglich),
            # sonst den am weitesten rechts stehenden "Betrag".
            betrag_xs = [
                float(w.get("x0", 0.0))
                for w in (header_row or [])
                if str(w.get("text", "")).strip().lower() == "betrag"
            ]
            x_b: float | None = None
            if betrag_xs:
                if x_w is not None and x_j is not None:
                    between = [x for x in betrag_xs if x_w < x < x_j]
                    x_b = min(between, key=lambda x: abs(x - ((x_w + x_j) / 2.0))) if between else max(betrag_xs)
                elif x_w is not None:
                    # Betrag ist typischerweise rechts von Wert
                    right_of_w = [x for x in betrag_xs if x > x_w]
                    x_b = min(right_of_w) if right_of_w else max(betrag_xs)
                else:
                    x_b = max(betrag_xs)
            # "Betrag / Einh." can be split into multiple words
            x_be: float | None = None
            for w in header_row:
                if str(w.get("text", "")).strip().lower() == "einh.":
                    x_be = float(w.get("x0", 0.0))
                    break

            # If we can't find the key columns, bail out for this page.
            if x_b is None or x_w is None:
                continue

            # Column boundaries as midpoints between header x positions.
            def mid(a: float, b: float) -> float:
                return (a + b) / 2.0

            # Determine x positions for money columns in the typical BMW order:
            # Betrag/Einh. | Wert | Betrag | Jahreswert
            x_betrag_einh: float | None = None
            if betrag_xs:
                x_betrag_einh = min(betrag_xs)
                # if we detected the dedicated Betrag column x_b, ensure we pick the other one for Betrag/Einh.
                if x_b is not None and abs(x_betrag_einh - x_b) < 1.0 and len(betrag_xs) >= 2:
                    x_betrag_einh = sorted(betrag_xs)[0]

            b1 = mid(x_betrag_einh, x_w) if (x_betrag_einh is not None and x_w is not None) else None
            b2 = mid(x_w, x_b) if (x_w is not None and x_b is not None) else None
            b3 = mid(x_b, x_j) if (x_b is not None and x_j is not None) else None

            # iterate rows after header
            started = False
            for r in rows:
                if r is header_row:
                    started = True
                    continue
                if not started:
                    continue

                t = row_text(r)
                if not t:
                    continue
                if t.startswith("Mitteilungen"):
                    break
                if t.startswith("-- ") and "of" in t:
                    break

                # Section titles appear inside the table without amounts.
                if t in section_names and not any(_parse_de_amount(str(w.get("text", ""))) is not None for w in r):
                    out.append({"type": "section", "label": t})
                    continue

                label_parts: list[str] = []
                jahreswert: Optional[Decimal] = None
                betrag: Optional[Decimal] = None
                wert: Optional[Decimal] = None
                betrag_pro_einh: Optional[Decimal] = None

                for w in r:
                    txt = str(w.get("text", "")).strip()
                    if not txt:
                        continue
                    a = _parse_de_amount(txt)
                    if a is None:
                        # Labels enthalten oft Status-Spalten (St¹/SV²/GB³) mit einzelnen Buchstaben wie "L", "J" oder "-".
                        # Diese sollen nicht Teil des Positionsnamens sein.
                        x0_txt = float(w.get("x0", 0.0))
                        if txt == "-" or (len(txt) == 1 and txt.isalpha() and x0_txt >= 180):
                            continue
                        label_parts.append(txt)
                        continue
                    x0 = float(w.get("x0", 0.0))

                    # Assign to column based on x0 thresholds.
                    # We default to the common layout: Betrag/Einh. (left) -> Wert -> Betrag -> Jahreswert (right).
                    if b1 is not None and x0 < b1:
                        betrag_pro_einh = a
                    elif b2 is not None and x0 < b2:
                        wert = a
                    elif b3 is not None and x0 < b3:
                        betrag = a
                    elif x_j is not None and b3 is not None and x0 >= b3:
                        jahreswert = a
                    else:
                        # Fallbacks: if we don't have enough headers, put the value into betrag.
                        betrag = a

                label = _normalize_line(" ".join(label_parts))
                if not label:
                    continue

                kind_hint = "sum" if label.lower().startswith("summe ") else "item"
                out.append(
                    {
                        "type": "row",
                        "label": label,
                        "kind_hint": kind_hint,
                        "jahreswert": jahreswert,
                        "betrag": betrag,
                        "wert": wert,
                        "betrag_pro_einh": betrag_pro_einh,
                    }
                )

    return out


def _parse_de_amount(token: str) -> Optional[Decimal]:
    v = token.strip()
    if not v:
        return None
    neg = False
    if v.endswith("-"):
        neg = True
        v = v[:-1]
    m = _RE_AMOUNT.match(v)
    if not m:
        return None
    raw = m.group("raw").replace(".", "").replace(",", ".")
    try:
        d = Decimal(raw)
    except (InvalidOperation, ValueError):
        return None
    return -d if neg else d


def _normalize_line(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip())


def parse_bmw_verdienstnachweis(text: str) -> list[ParsedLine]:
    """
    Heuristischer Parser für BMW-„Verdienstnachweis“ (wie in deinen PDFs).

    Ziel: Hierarchie aus Sektionen + Einzelpositionen + Summenpositionen.
    Falls das PDF kein Text enthält (Scan), liefert dieser Parser eine leere Liste.
    """

    if not text or "Verdienstnachweis" not in text:
        return []

    # Hinweis: Der eigentliche Tabellenparser ist layout-basiert (pdfplumber). Dieser
    # Wrapper bleibt für bestehende Aufrufer erhalten und liefert ohne Bytes-Kontext
    # keine Tabellenzeilen.
    return []


def parse_bmw_verdienstnachweis_from_pdf(pdf_bytes: bytes) -> tuple[list[ParsedLine], tuple[Optional[int], Optional[int], str]]:
    """
    Vollständiger BMW-PDF-Parser mit sauberer Spaltenzuordnung via pdfplumber.
    - Überspringt Zeilen, die einen Wert in "Jahreswert" oder "Betrag / Einh." haben.
    - Speichert pro Zeile weiterhin nur einen `amount`:
      - Summe-Zeilen: `betrag`
      - Einzelpositionen: `wert` (Fallback: `betrag`)
    """
    text = extract_pdf_text(pdf_bytes)
    period = extract_period_month_year(text)

    rows = _extract_bmw_rows_with_columns(pdf_bytes)
    out: list[ParsedLine] = []

    # Rows already contain sections in correct table order.
    for r in rows:
        if r.get("type") == "section":
            out.append(ParsedLine(kind="section", level=0, label=str(r.get("label") or ""), amount=None))
            continue
        if r.get("type") != "row":
            continue

        jahreswert = r.get("jahreswert")
        betrag_pro_einh = r.get("betrag_pro_einh")
        # Verfeinerung: nur dann ignorieren, wenn *beide* Zusatzspalten befüllt sind.
        if jahreswert is not None and betrag_pro_einh is not None:
            continue

        kind = "sum" if r.get("kind_hint") == "sum" else "item"
        betrag = r.get("betrag")
        wert = r.get("wert")
        amount = betrag if kind == "sum" else (wert if wert is not None else betrag)
        if amount is None:
            continue
        out.append(ParsedLine(kind=kind, level=1, label=str(r.get("label") or ""), amount=amount))

    return out, period


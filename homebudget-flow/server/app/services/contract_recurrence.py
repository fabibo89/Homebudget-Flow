"""Heuristik: wiederkehrender Rhythmus aus Buchungsdaten (deutsche Kurzbeschriftung)."""

from __future__ import annotations

from datetime import date
from statistics import median


def infer_recurrence_label_de(dates: list[date]) -> str:
    """
    Schätzt aus den Buchungsdaten einen typischen Abstand (Median der aufsteigend sortierten,
    eindeutigen Termine). Kein Kalender-„Monatsende“-Modell — reine Tagesabstände.
    """
    if not dates:
        return "unbekannt"
    uniq = sorted({d for d in dates if d is not None})
    if len(uniq) < 2:
        return "nur eine Buchung"

    deltas = [(uniq[i + 1] - uniq[i]).days for i in range(len(uniq) - 1)]
    if not deltas:
        return "unbekannt"

    med = float(median(deltas))
    mean_d = sum(deltas) / len(deltas)
    variance = sum((d - mean_d) ** 2 for d in deltas) / len(deltas)
    stdev = variance**0.5
    # Etwas Spielraum bei Bank-Abständen; bei wenigen Punkten weniger streng.
    tol = max(5.0, med * 0.22) if med > 0 else 5.0
    irregular = stdev > tol and len(deltas) >= 2

    def _bucket(m: float) -> str | None:
        if 5 <= m <= 9:
            return "wöchentlich"
        if 12 <= m <= 16:
            return "14-tägig"
        if 24 <= m <= 36:
            return "monatlich"
        if 52 <= m <= 72:
            return "ca. 2-monatlich"
        if 80 <= m <= 100:
            return "vierteljährlich"
        if 160 <= m <= 200:
            return "halbjährlich"
        if 330 <= m <= 400:
            return "jährlich"
        return None

    label = _bucket(med)
    if label:
        return f"{label} (ungefähr)" if irregular else label
    if irregular:
        return "unregelmäßig"
    rounded = int(round(med))
    return f"ca. alle {rounded} Tage"

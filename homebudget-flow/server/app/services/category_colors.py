"""Farbvarianten: Unterkategorien heller als die Hauptfarbe, wenn keine eigene Farbe gesetzt ist."""

from __future__ import annotations


def _parse_rgb(hex_color: str) -> tuple[int, int, int]:
    h = hex_color.strip().lstrip("#")
    if len(h) != 6:
        return 107, 114, 128
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def _fmt_rgb(r: int, g: int, b: int) -> str:
    return f"#{max(0, min(255, r)):02x}{max(0, min(255, g)):02x}{max(0, min(255, b)):02x}"


def lighten_hex(hex_color: str, amount: float = 0.26) -> str:
    """Mischt die Farbe mit Weiß (amount 0..1)."""
    r, g, b = _parse_rgb(hex_color)
    a = max(0.0, min(1.0, amount))

    def mix(x: int) -> int:
        return int(x + (255 - x) * a)

    return _fmt_rgb(mix(r), mix(g), mix(b))


def auto_child_lighten_amount(sibling_index: int, sibling_count: int) -> float:
    """Aufhellung für automatische Unterkategorien: jede Schwester hat eine andere Abstufung."""
    if sibling_count <= 0:
        return 0.26
    if sibling_count == 1:
        return 0.2
    lo, hi = 0.08, 0.5
    i = max(0, min(sibling_count - 1, sibling_index))
    t = i / (sibling_count - 1)
    return lo + t * (hi - lo)


def normalize_hex(hex_color: str | None, fallback: str = "#6b7280") -> str:
    if not hex_color or not str(hex_color).strip():
        return fallback
    h = str(hex_color).strip()
    if not h.startswith("#"):
        h = "#" + h
    if len(h) != 7:
        return fallback
    return h.lower()


def effective_color(
    *,
    parent_color_hex: str | None,
    own_color_hex: str | None,
    is_child: bool,
    auto_sibling_index: int | None = None,
    auto_sibling_count: int | None = None,
) -> str:
    """Anzeigefarbe: Kind ohne eigene Farbe → aufgehellte Elternfarbe (pro Geschwister gestaffelt)."""
    parent = normalize_hex(parent_color_hex) if parent_color_hex else "#6b7280"
    if not is_child:
        return normalize_hex(own_color_hex, parent)
    if own_color_hex and str(own_color_hex).strip():
        return normalize_hex(own_color_hex, parent)
    if (
        auto_sibling_index is not None
        and auto_sibling_count is not None
        and auto_sibling_count > 0
    ):
        amt = auto_child_lighten_amount(auto_sibling_index, auto_sibling_count)
        return lighten_hex(parent, amt)
    return lighten_hex(parent)

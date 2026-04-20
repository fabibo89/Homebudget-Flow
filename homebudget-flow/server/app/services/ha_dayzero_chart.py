"""PNG-Saldo-Diagramm für Home Assistant (Serien wie Web Day Zero)."""

from __future__ import annotations

import logging
from io import BytesIO

logger = logging.getLogger(__name__)


def render_dayzero_saldo_png(
    chart_days: list[str],
    chart_konto_ist: list[str],
    chart_meltdown_line: list[str],
    chart_konto_linear_soll: list[str],
    *,
    title: str = "Day Zero · Saldo",
    image_format: str = "png",
) -> bytes:
    """Linien Konto-Ist, Meltdown (o. Fix), Soll linear — als PNG oder JPEG (für HA MJPEG-Großansicht)."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fmt = "jpeg" if str(image_format).lower() in ("jpeg", "jpg") else "png"
    pil_kw = {"quality": 92} if fmt == "jpeg" else {}

    n = len(chart_days)
    if n == 0:
        fig, ax = plt.subplots(figsize=(8, 4), dpi=100)
        ax.text(0.5, 0.5, "Keine Daten", ha="center", va="center")
        ax.set_axis_off()
        buf = BytesIO()
        if pil_kw:
            fig.savefig(buf, format=fmt, bbox_inches="tight", pil_kwargs=pil_kw)
        else:
            fig.savefig(buf, format=fmt, bbox_inches="tight")
        plt.close(fig)
        return buf.getvalue()

    def _nums(xs: list[str]) -> list[float]:
        out: list[float] = []
        for x in xs:
            try:
                out.append(float(str(x).replace(",", ".")))
            except (TypeError, ValueError):
                out.append(0.0)
        return out

    x = list(range(n))
    labels: list[str] = []
    for d in chart_days:
        s = str(d)[:10]
        if len(s) == 10 and s[4] == "-" and s[7] == "-":
            labels.append(f"{s[8:10]}.{s[5:7]}")
        else:
            labels.append(s)

    y_k = _nums(chart_konto_ist[:n])
    y_m = _nums(chart_meltdown_line[:n])
    y_s = _nums(chart_konto_linear_soll[:n])

    try:
        fig, ax = plt.subplots(figsize=(12, 5.5), dpi=110)
        ax.plot(x, y_k, label="Konto Ist", linewidth=2.0)
        ax.plot(x, y_m, label="Meltdown (o. Fix)", linewidth=1.8, linestyle="--")
        ax.plot(x, y_s, label="Soll linear", linewidth=1.5, linestyle=":")
        safe_title = (title or "Day Zero")[:200]
        ax.set_title(safe_title)
        ax.set_xlabel("Kalendertag")
        ax.set_ylabel("EUR")
        step = max(1, n // 12)
        tick_idx = list(x[::step])
        ax.set_xticks(tick_idx)
        ax.set_xticklabels([labels[i] for i in tick_idx], rotation=35, ha="right")
        ax.grid(True, alpha=0.35)
        ax.legend(loc="upper right", fontsize=9)
        fig.tight_layout()
        buf = BytesIO()
        if pil_kw:
            fig.savefig(buf, format=fmt, bbox_inches="tight", pil_kwargs=pil_kw)
        else:
            fig.savefig(buf, format=fmt, bbox_inches="tight")
        plt.close(fig)
        return buf.getvalue()
    except Exception:
        logger.exception("render_dayzero_saldo_png failed (n=%s)", n)
        plt.close("all")
        fig2, ax2 = plt.subplots(figsize=(8, 4), dpi=100)
        ax2.text(0.5, 0.5, "Diagramm-Fehler", ha="center", va="center")
        ax2.set_axis_off()
        buf2 = BytesIO()
        if pil_kw:
            fig2.savefig(buf2, format=fmt, bbox_inches="tight", pil_kwargs=pil_kw)
        else:
            fig2.savefig(buf2, format=fmt, bbox_inches="tight")
        plt.close(fig2)
        return buf2.getvalue()

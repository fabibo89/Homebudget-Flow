"""PNG-Saldo-Diagramm für Home Assistant (Serien wie Web Day Zero)."""

from __future__ import annotations

from io import BytesIO


def render_dayzero_saldo_png(
    chart_days: list[str],
    chart_konto_ist: list[str],
    chart_meltdown_line: list[str],
    chart_konto_linear_soll: list[str],
    *,
    title: str = "Day Zero · Saldo",
) -> bytes:
    """Erzeugt ein PNG mit Linien Konto-Ist, Meltdown-Linie (o. Fix), linearem Soll."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    n = len(chart_days)
    if n == 0:
        fig, ax = plt.subplots(figsize=(8, 4), dpi=100)
        ax.text(0.5, 0.5, "Keine Daten", ha="center", va="center")
        ax.set_axis_off()
        buf = BytesIO()
        fig.savefig(buf, format="png", bbox_inches="tight")
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

    fig, ax = plt.subplots(figsize=(12, 5.5), dpi=110)
    ax.plot(x, y_k, label="Konto Ist", linewidth=2.0)
    ax.plot(x, y_m, label="Meltdown (o. Fix)", linewidth=1.8, linestyle="--")
    ax.plot(x, y_s, label="Soll linear", linewidth=1.5, linestyle=":")
    ax.set_title(title)
    ax.set_xlabel("Kalendertag")
    ax.set_ylabel("EUR")
    ax.set_xticks(x[:: max(1, n // 12)])
    ax.set_xticklabels([labels[i] for i in x[:: max(1, n // 12)]], rotation=35, ha="right")
    ax.grid(True, alpha=0.35)
    ax.legend(loc="upper right", fontsize=9)
    fig.tight_layout()
    buf = BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight")
    plt.close(fig)
    return buf.getvalue()

"""PNG previews: one image per section (its table, with its chart beside it) and one for the checks."""

import io

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import Rectangle  # noqa: E402

from .expr import XlError  # noqa: E402
from .fmt import display  # noqa: E402
from .spec import Built, SectionLayout, chart_rows  # noqa: E402

NAVY = "#1F3A5F"
ZEBRA = "#F6F8FB"
TOTAL = "#E8EEF5"
LINE = "#BFC9D6"
PALETTE = ["#1F3A5F", "#C9A227", "#2E7D4F", "#9FB3C8", "#B5523B", "#6B5B95", "#3E8E9D", "#8C8C8C"]
CHAR_IN = 0.075  # inches per character at 9.5 pt
ROW_IN = 0.3

plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 9.5})


def _texts(lay: SectionLayout) -> list[list[str]]:
    return [[display(v, lay.section.cell_format(r, c)) for c, v in enumerate(row)] for r, row in enumerate(lay.values)]


def _widths(lay: SectionLayout, texts: list[list[str]]) -> list[float]:
    widths = []
    for c, head in enumerate(lay.section.columns):
        longest = max([len(head)] + [len(r[c]) for r in texts])
        cap = 48 if c == 0 else 22
        widths.append(max(0.9, min(longest, cap) * CHAR_IN + 0.3))
    return widths


def _wrap(text: str, width_in: float) -> str:
    limit = max(6, int((width_in - 0.2) / CHAR_IN))
    if len(text) <= limit:
        return text
    words, lines, line = text.split(), [], ""
    for w in words:
        if len(line) + len(w) + 1 > limit and line:
            lines.append(line)
            line = w
        else:
            line = f"{line} {w}".strip()
    lines.append(line)
    return "\n".join(lines[:3])


def _draw_table(ax, lay: SectionLayout, x0: float, y0: float) -> tuple[float, float]:
    """Draws the table with its top-left at (x0, y0) in inches. Returns (width, height)."""
    texts = _texts(lay)
    widths = _widths(lay, texts)
    rows = [lay.section.columns] + texts
    styles = ["header"] + [r.style for r in lay.section.rows]
    y = y0
    for i, (cells, style) in enumerate(zip(rows, styles, strict=True)):
        wrapped = [_wrap(t, w) for t, w in zip(cells, widths, strict=True)]
        lines = max(t.count("\n") + 1 for t in wrapped)
        h = ROW_IN * (1 + 0.55 * (lines - 1))
        x = x0
        for c, (text, w) in enumerate(zip(wrapped, widths, strict=True)):
            if style == "header":
                face, color, weight = NAVY, "white", "bold"
            elif style == "total":
                face, color, weight = TOTAL, "black", "bold"
            elif style == "highlight":
                face, color, weight = NAVY, "white", "bold"
            else:
                face, color, weight = (ZEBRA if i % 2 == 0 else "white"), "black", "normal"
            ax.add_patch(Rectangle((x, y - h), w, h, facecolor=face, edgecolor=LINE, linewidth=0.6))
            value = lay.values[i - 1][c] if i > 0 else None
            if isinstance(value, XlError):
                color = "#B00020"
            numeric = i > 0 and c > 0 and isinstance(value, int | float)
            if c == 0 or not numeric:
                ax.text(x + 0.08, y - h / 2, text, va="center", ha="left", color=color, weight=weight)
            else:
                ax.text(x + w - 0.08, y - h / 2, text, va="center", ha="right", color=color, weight=weight)
            x += w
        y -= h
    if lay.section.note:
        ax.text(x0, y - 0.22, lay.section.note, va="center", ha="left", color="#595959", style="italic", size=8.5)
        y -= 0.35
    return sum(widths), y0 - y


def _chart(ax, lay: SectionLayout) -> None:
    chart = lay.section.chart
    rows = chart_rows(lay.section)
    labels = [display(lay.values[r - 1][chart.label_column - 1], None) for r in rows]

    def num(v):
        return float(v) if isinstance(v, int | float) and not isinstance(v, bool) else 0.0

    series = [[num(lay.values[r - 1][c - 1]) for r in rows] for c in chart.value_columns]
    names = [lay.section.columns[c - 1] for c in chart.value_columns]
    fmts = [lay.section.cell_format(rows[0] - 1, c - 1) for c in chart.value_columns]
    if chart.title and chart.title != lay.section.title:
        ax.set_title(chart.title, loc="left", weight="bold", color=NAVY, size=10.5)
    if chart.type == "pie":
        vals = series[0]
        total = sum(vals) or 1.0
        ax.pie(
            vals,
            labels=[_wrap(label, 1.8) for label in labels],
            colors=PALETTE[: len(vals)],
            autopct=lambda p: f"{p:.1f}%",
            startangle=90,
            counterclock=False,
            wedgeprops={"linewidth": 1, "edgecolor": "white"},
            textprops={"size": 8.5},
        )
        ax.axis("equal")
        _ = total
        return
    import numpy as np

    n = len(series)
    idx = np.arange(len(labels))
    width = 0.8 / n
    for k, (vals, name) in enumerate(zip(series, names, strict=True)):
        offs = idx + (k - (n - 1) / 2) * width
        color = PALETTE[k % len(PALETTE)]
        if chart.type == "line":
            ax.plot(idx, vals, marker="o", color=color, label=name)
            pts = zip(idx, vals, strict=True)
        elif chart.type == "bar":
            bars = ax.barh(offs, vals, height=width, color=color, label=name)
            pts = [(b.get_width(), b.get_y() + b.get_height() / 2) for b in bars]
        else:
            bars = ax.bar(offs, vals, width=width, color=color, label=name)
            pts = [(b.get_x() + b.get_width() / 2, b.get_height()) for b in bars]
        for px, py in pts:
            v = px if chart.type == "bar" else py
            text = display(v, fmts[k])
            if chart.type == "bar":
                ax.annotate(text, (px, py), xytext=(3, 0), textcoords="offset points", va="center", size=8)
            else:
                ax.annotate(text, (px, py), xytext=(0, 3), textcoords="offset points", ha="center", size=8)
    from matplotlib.ticker import FuncFormatter

    (ax.xaxis if chart.type == "bar" else ax.yaxis).set_major_formatter(FuncFormatter(lambda v, _: compact(v, fmts[0])))
    if chart.type == "bar":
        ax.set_yticks(idx, [_wrap(label, 2.4) for label in labels])
        ax.invert_yaxis()
        ax.margins(x=0.18)
    else:
        rotate = 45 if len(labels) > 6 else 0
        ax.set_xticks(idx, [_wrap(label, 1.4) for label in labels], rotation=rotate, ha="right" if rotate else "center")
        ax.margins(y=0.15)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    ax.grid(axis="x" if chart.type == "bar" else "y", color="#E5E7EB", linewidth=0.6)
    ax.set_axisbelow(True)
    if n > 1:
        ax.legend(frameon=False, loc="best", fontsize=8)


def compact(v: float, fmt: str | None = None) -> str:
    """Axis labels: 1.5M, or for rupee columns the Indian 1.5Cr / 25L."""
    rupees = (fmt or "").startswith("inr") or "₹" in (fmt or "")
    scales = ((1e7, "Cr"), (1e5, "L"), (1e3, "K")) if rupees else ((1e9, "B"), (1e6, "M"), (1e3, "K"))
    for size, suffix in scales:
        if abs(v) >= size:
            return f"{v / size:,.1f}".rstrip("0").rstrip(".") + suffix
    return f"{v:,.0f}" if float(v).is_integer() else f"{v:,.2f}"


def section_png(lay: SectionLayout) -> bytes:
    texts = _texts(lay)
    table_w = sum(_widths(lay, texts))
    table_h = ROW_IN * (len(texts) + 1) * 1.25 + (0.35 if lay.section.note else 0)
    chart_w, chart_h = (6.2, max(3.6, min(6.5, 0.32 * len(lay.section.rows) + 2))) if lay.section.chart else (0, 0)
    if lay.section.chart and lay.section.chart.type == "pie":
        chart_w, chart_h = 5.2, 4.0
    width = 0.3 + table_w + (0.5 + chart_w if chart_w else 0) + 0.3
    height = 0.75 + max(table_h, chart_h) + 0.2
    fig = plt.figure(figsize=(width, height), dpi=150)
    canvas = fig.add_axes((0, 0, 1, 1))
    canvas.set_xlim(0, width)
    canvas.set_ylim(0, height)
    canvas.axis("off")
    canvas.text(0.3, height - 0.35, lay.section.title, weight="bold", color=NAVY, size=12, va="center")
    canvas.plot([0.3, width - 0.3], [height - 0.55, height - 0.55], color=NAVY, linewidth=1.2)
    _draw_table(canvas, lay, 0.3, height - 0.75)
    if lay.section.chart:
        left = 0.3 + table_w + 0.5
        pad_left = 1.9 if lay.section.chart.type == "bar" else 0.55
        ax = fig.add_axes(
            (
                (left + pad_left) / width,
                (height - 0.75 - chart_h + 0.75) / height,
                (chart_w - pad_left - 0.2) / width,
                (chart_h - 1.05) / height,
            )
        )
        _chart(ax, lay)
    return _png(fig)


def checks_png(built: Built) -> bytes | None:
    if not built.checks:
        return None
    rows = [(c.check.label, display(c.left, "num2"), display(c.right, "num2"), "OK" if c.ok else "CHECK")
            for c in built.checks]  # fmt: skip
    head = ("Check", "Left", "Right", "Result")
    widths = [max(1.0, min(56, max(len(r[i]) for r in [head, *rows])) * CHAR_IN + 0.3) for i in range(4)]
    width = sum(widths) + 0.6
    height = 0.8 + ROW_IN * (len(rows) + 1) + 0.2
    fig = plt.figure(figsize=(width, height), dpi=150)
    ax = fig.add_axes((0, 0, 1, 1))
    ax.set_xlim(0, width)
    ax.set_ylim(0, height)
    ax.axis("off")
    ax.text(0.3, height - 0.35, "Checks", weight="bold", color=NAVY, size=12, va="center")
    y = height - 0.7
    for i, cells in enumerate([head, *rows]):
        x = 0.3
        for c, (text, w) in enumerate(zip(cells, widths, strict=True)):
            face = NAVY if i == 0 else ("white" if i % 2 else ZEBRA)
            color = "white" if i == 0 else ("#2E7D4F" if text == "OK" else "#B00020" if text == "CHECK" else "black")
            ax.add_patch(Rectangle((x, y - ROW_IN), w, ROW_IN, facecolor=face, edgecolor=LINE, linewidth=0.6))
            right = 0 < c < 3
            weight = "bold" if i == 0 or c == 3 else "normal"
            ax.text(x + (w - 0.08 if right else 0.08), y - ROW_IN / 2, text, va="center",
                    ha="right" if right else "left", color=color, weight=weight)  # fmt: skip
            x += w
        y -= ROW_IN
    return _png(fig)


def _png(fig) -> bytes:
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=150, facecolor="white")
    plt.close(fig)
    return buf.getvalue()
